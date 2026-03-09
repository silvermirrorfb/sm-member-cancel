import crypto from 'crypto';

const queue = new Map();
const QUEUE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function buildQueueKey(payload) {
  return crypto.createHash('sha1').update(stableStringify(payload)).digest('hex');
}

function enqueueOutboundCandidate(payload, options = {}) {
  const nowIso = new Date().toISOString();
  const runAfter = String(options.runAfter || nowIso);
  const basePayload = payload && typeof payload === 'object' ? payload : {};
  const key = buildQueueKey(basePayload);
  const existing = queue.get(key);
  if (existing) {
    if (runAfter < existing.runAfter) existing.runAfter = runAfter;
    existing.updatedAt = nowIso;
    return { ...existing, deduped: true };
  }
  const row = {
    id: `q_${crypto.randomBytes(8).toString('hex')}`,
    key,
    payload: basePayload,
    runAfter,
    queuedAt: nowIso,
    updatedAt: nowIso,
  };
  queue.set(key, row);
  return { ...row, deduped: false };
}

function popDueCandidates({ now = new Date().toISOString(), limit = 100 } = {}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return [];
  const rows = [...queue.values()]
    .filter(row => {
      const dueMs = new Date(row.runAfter || row.queuedAt).getTime();
      return Number.isFinite(dueMs) && dueMs <= nowMs;
    })
    .sort((a, b) => {
      const aMs = new Date(a.runAfter || a.queuedAt).getTime();
      const bMs = new Date(b.runAfter || b.queuedAt).getTime();
      return aMs - bMs;
    })
    .slice(0, Math.max(0, Number(limit) || 0));

  for (const row of rows) queue.delete(row.key);
  return rows;
}

function getOutboundQueueSnapshot() {
  const rows = [...queue.values()];
  return {
    size: rows.length,
    earliestRunAfter: rows.length
      ? rows
          .map(row => row.runAfter)
          .filter(Boolean)
          .sort()[0] || null
      : null,
  };
}

function __resetOutboundQueueForTests() {
  queue.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, row] of queue.entries()) {
    const updated = new Date(row.updatedAt || row.queuedAt || 0).getTime();
    if (!Number.isFinite(updated) || now - updated > QUEUE_TTL_MS) queue.delete(key);
  }
}, 10 * 60 * 1000);

export {
  enqueueOutboundCandidate,
  popDueCandidates,
  getOutboundQueueSnapshot,
  __resetOutboundQueueForTests,
};

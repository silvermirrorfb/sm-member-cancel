// Session storage with Upstash-backed persistence and in-memory fallback.
// Sessions auto-expire after 30 minutes of inactivity.

import { Redis } from '@upstash/redis';
import { v4 as uuidv4 } from 'uuid';

const sessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_TTL_SECONDS = Math.max(
  Number(process.env.SESSION_STORE_TTL_SECONDS || 4 * 60 * 60) || 0,
  60 * 60,
);
const SESSION_KEY_PREFIX = String(process.env.SESSION_STORE_PREFIX || 'sm-cancel-bot:session').trim() || 'sm-cancel-bot:session';
const SESSION_ACTIVE_SET_KEY = `${SESSION_KEY_PREFIX}:active`;

let cachedRedis = null;
let cachedRedisSignature = '';
const loggedWarnings = new Set();

function logSessionStoreWarningOnce(key, message) {
  if (loggedWarnings.has(key)) return;
  loggedWarnings.add(key);
  console.warn(message);
}

function normalizeSessionStoreBackend(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'memory' || normalized === 'upstash') return normalized;
  return 'auto';
}

function getSessionStoreBackendPreference() {
  return normalizeSessionStoreBackend(process.env.SESSION_STORE_BACKEND);
}

function getUpstashRedis() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return null;

  const signature = `${url}|${token}`;
  if (cachedRedis && cachedRedisSignature === signature) return cachedRedis;

  cachedRedis = new Redis({ url, token });
  cachedRedisSignature = signature;
  return cachedRedis;
}

function shouldUseRemoteStore() {
  const preference = getSessionStoreBackendPreference();
  const redis = getUpstashRedis();

  if (preference === 'memory') return false;
  if (redis) return true;

  if (preference === 'upstash') {
    logSessionStoreWarningOnce(
      'missing-upstash-session-store',
      '[sessions] SESSION_STORE_BACKEND=upstash but Upstash credentials are missing. Falling back to in-memory sessions.',
    );
  }

  return false;
}

function toDateOrNow(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function serializeDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function serializeSession(session) {
  return {
    ...session,
    createdAt: serializeDate(session.createdAt),
    lastActivity: serializeDate(session.lastActivity),
    lastProcessedUserAt: session.lastProcessedUserAt ? serializeDate(session.lastProcessedUserAt) : null,
    lastAssistantAt: session.lastAssistantAt ? serializeDate(session.lastAssistantAt) : null,
  };
}

function hydrateSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    ...raw,
    messages: Array.isArray(raw.messages) ? raw.messages.map(message => ({
      role: message?.role,
      content: message?.content,
    })) : [],
    createdAt: toDateOrNow(raw.createdAt),
    lastActivity: toDateOrNow(raw.lastActivity),
    lastProcessedUserAt: raw.lastProcessedUserAt ? toDateOrNow(raw.lastProcessedUserAt) : null,
    lastAssistantAt: raw.lastAssistantAt ? toDateOrNow(raw.lastAssistantAt) : null,
    chatTranscriptStarted: raw.chatTranscriptStarted === true,
  };
}

function sessionKey(sessionId) {
  return `${SESSION_KEY_PREFIX}:${sessionId}`;
}

async function persistSessionRemotely(session) {
  const redis = getUpstashRedis();
  if (!redis || !session?.id) return;

  await redis.set(sessionKey(session.id), JSON.stringify(serializeSession(session)), {
    ex: SESSION_TTL_SECONDS,
  });
  if (session.status === 'active') {
    await redis.sadd(SESSION_ACTIVE_SET_KEY, session.id);
  } else {
    await redis.srem(SESSION_ACTIVE_SET_KEY, session.id);
  }
}

async function removeRemoteSession(sessionId) {
  const redis = getUpstashRedis();
  if (!redis || !sessionId) return;
  await redis.del(sessionKey(sessionId));
  await redis.srem(SESSION_ACTIVE_SET_KEY, sessionId);
}

function isTimedOut(session) {
  return (Date.now() - session.lastActivity.getTime()) > SESSION_TIMEOUT_MS && session.status === 'active';
}

async function saveSession(session) {
  if (!session?.id) return null;
  sessions.set(session.id, session);

  if (!shouldUseRemoteStore()) return session;

  try {
    await persistSessionRemotely(session);
  } catch (err) {
    logSessionStoreWarningOnce(
      'session-store-write-failed',
      `[sessions] Upstash session write failed. Continuing with in-memory fallback. error="${String(err?.message || err).slice(0, 200)}"`,
    );
  }

  return session;
}

async function createSession(memberId, memberProfile, existingId, options = {}) {
  const sessionId = existingId || uuidv4();
  const session = {
    id: sessionId,
    memberId,
    memberProfile,
    messages: [], // Claude conversation history
    chatTranscriptStarted: false,
    lastProcessedUserFingerprint: null,
    lastProcessedUserAt: null,
    lastAssistantVisibleMessage: null,
    lastAssistantAt: null,
    outcome: null,
    summary: null,
    createdAt: new Date(),
    lastActivity: new Date(),
    status: 'active', // active | completed | abandoned | error
    session_mode: options.session_mode || 'general', // general | membership | missed_call
    origin: options.origin || 'widget', // widget | sms_inbound | missed_call_trigger
  };
  await saveSession(session);
  return session;
}

async function getSession(sessionId) {
  if (!sessionId) return null;

  let session = sessions.get(sessionId) || null;

  if (!session && shouldUseRemoteStore()) {
    try {
      const raw = await getUpstashRedis().get(sessionKey(sessionId));
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        session = hydrateSession(parsed);
        if (session) sessions.set(sessionId, session);
      }
    } catch (err) {
      logSessionStoreWarningOnce(
        'session-store-read-failed',
        `[sessions] Upstash session read failed. Continuing with in-memory fallback. error="${String(err?.message || err).slice(0, 200)}"`,
      );
    }
  }

  if (!session) return null;

  if (isTimedOut(session)) {
    session.status = 'abandoned';
    await saveSession(session);
  }

  return session;
}

async function updateActivity(sessionId) {
  const session = await getSession(sessionId);
  if (session) {
    session.lastActivity = new Date();
    await saveSession(session);
  }
  return session;
}

async function addMessage(sessionId, role, content) {
  const session = await getSession(sessionId);
  if (!session) return null;
  session.messages.push({ role, content });
  session.lastActivity = new Date();
  if (role === 'assistant' || role === 'bot') {
    session.lastAssistantVisibleMessage = content;
    session.lastAssistantAt = new Date();
  }
  await saveSession(session);
  return session;
}

async function completeSession(sessionId, outcome, summary) {
  const session = await getSession(sessionId);
  if (!session) return null;
  session.outcome = outcome;
  session.summary = summary;
  session.status = 'completed';
  await saveSession(session);
  return session;
}

async function getAllActiveSessions() {
  if (shouldUseRemoteStore()) {
    try {
      const redis = getUpstashRedis();
      const ids = await redis.smembers(SESSION_ACTIVE_SET_KEY);
      const active = [];
      for (const id of ids || []) {
        const session = await getSession(id);
        if (session?.status === 'active') {
          active.push({
            id: session.id,
            memberId: session.memberId,
            createdAt: session.createdAt,
            lastActivity: session.lastActivity,
          });
        }
      }
      return active;
    } catch (err) {
      logSessionStoreWarningOnce(
        'session-store-list-failed',
        `[sessions] Upstash active-session listing failed. Falling back to in-memory list. error="${String(err?.message || err).slice(0, 200)}"`,
      );
    }
  }

  const active = [];
  for (const [id, session] of sessions) {
    if (session.status === 'active') {
      active.push({ id, memberId: session.memberId, createdAt: session.createdAt, lastActivity: session.lastActivity });
    }
  }
  return active;
}

// Cleanup old in-memory sessions every 10 minutes.
setInterval(() => {
  const cutoff = Date.now() - (2 * 60 * 60 * 1000); // 2 hours
  for (const [id, session] of sessions) {
    if (session.lastActivity.getTime() < cutoff) {
      sessions.delete(id);
      if (shouldUseRemoteStore()) {
        removeRemoteSession(id).catch(() => {});
      }
    }
  }
}, 10 * 60 * 1000);

function __resetSessionStoreForTests() {
  sessions.clear();
  cachedRedis = null;
  cachedRedisSignature = '';
  loggedWarnings.clear();
}

export {
  createSession,
  getSession,
  saveSession,
  updateActivity,
  addMessage,
  completeSession,
  getAllActiveSessions,
  __resetSessionStoreForTests,
};

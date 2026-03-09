const PHONE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_SID_TTL_MS = 24 * 60 * 60 * 1000;

const phoneToSession = new Map();
const sidToReply = new Map();

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.startsWith('1') && digits.length === 11) return `+${digits}`;
  return `+${digits}`;
}

function bindPhoneToSession(phone, sessionId) {
  const key = normalizePhone(phone);
  if (!key || !sessionId) return null;
  const payload = {
    sessionId: String(sessionId),
    updatedAt: Date.now(),
  };
  phoneToSession.set(key, payload);
  return payload;
}

function getSessionIdForPhone(phone) {
  const key = normalizePhone(phone);
  if (!key) return null;
  const row = phoneToSession.get(key);
  if (!row) return null;
  if (Date.now() - row.updatedAt > PHONE_SESSION_TTL_MS) {
    phoneToSession.delete(key);
    return null;
  }
  row.updatedAt = Date.now();
  return row.sessionId;
}

function storeReplyForMessageSid(messageSid, twiml) {
  const sid = String(messageSid || '').trim();
  if (!sid || !twiml) return null;
  sidToReply.set(sid, { twiml: String(twiml), updatedAt: Date.now() });
  return sid;
}

function getReplyForMessageSid(messageSid) {
  const sid = String(messageSid || '').trim();
  if (!sid) return null;
  const row = sidToReply.get(sid);
  if (!row) return null;
  if (Date.now() - row.updatedAt > MESSAGE_SID_TTL_MS) {
    sidToReply.delete(sid);
    return null;
  }
  row.updatedAt = Date.now();
  return row.twiml;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, row] of phoneToSession.entries()) {
    if (now - row.updatedAt > PHONE_SESSION_TTL_MS) phoneToSession.delete(key);
  }
  for (const [sid, row] of sidToReply.entries()) {
    if (now - row.updatedAt > MESSAGE_SID_TTL_MS) sidToReply.delete(sid);
  }
}, 5 * 60 * 1000);

export {
  normalizePhone,
  bindPhoneToSession,
  getSessionIdForPhone,
  storeReplyForMessageSid,
  getReplyForMessageSid,
};

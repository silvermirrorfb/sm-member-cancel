const PHONE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_SID_TTL_MS = 24 * 60 * 60 * 1000;
const UPGRADE_OFFER_STATE_TTL_MS = 48 * 60 * 60 * 1000;
const UPSELL_COOLDOWN_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
const UPSELL_COOLDOWN_TTL_MS = 35 * 24 * 60 * 60 * 1000;

const phoneToSession = new Map();
const sidToReply = new Map();
const offerStateByKey = new Map();
const upsellCooldownByPhone = new Map();

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

function buildOfferStateKey(phone, appointmentId) {
  const normalizedPhone = normalizePhone(phone);
  const appt = String(appointmentId || '').trim();
  if (!normalizedPhone || !appt) return '';
  return `${normalizedPhone}::${appt}`;
}

function getUpgradeOfferState(phone, appointmentId) {
  const key = buildOfferStateKey(phone, appointmentId);
  if (!key) return null;
  const row = offerStateByKey.get(key);
  if (!row) return null;
  if (Date.now() - row.updatedAt > UPGRADE_OFFER_STATE_TTL_MS) {
    offerStateByKey.delete(key);
    return null;
  }
  row.updatedAt = Date.now();
  return { ...row };
}

function markUpgradeOfferEvent(phone, appointmentId, eventName, atIso = null) {
  const key = buildOfferStateKey(phone, appointmentId);
  if (!key) return null;
  const nowIso = atIso || new Date().toISOString();
  const row = offerStateByKey.get(key) || {
    key,
    phone: normalizePhone(phone),
    appointmentId: String(appointmentId),
    createdAt: nowIso,
    updatedAt: Date.now(),
    initialSentAt: null,
    reminderSentAt: null,
    acceptedAt: null,
    upgradedAt: null,
    declinedAt: null,
    unavailableAt: null,
  };

  if (eventName === 'initial_sent') row.initialSentAt = nowIso;
  if (eventName === 'reminder_sent') row.reminderSentAt = nowIso;
  if (eventName === 'accepted') row.acceptedAt = nowIso;
  if (eventName === 'upgraded') row.upgradedAt = nowIso;
  if (eventName === 'declined') row.declinedAt = nowIso;
  if (eventName === 'unavailable') row.unavailableAt = nowIso;
  row.updatedAt = Date.now();
  offerStateByKey.set(key, row);
  return { ...row };
}

function getUpsellCooldown(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;
  const row = upsellCooldownByPhone.get(normalizedPhone);
  if (!row) return null;
  if (Date.now() - row.updatedAt > UPSELL_COOLDOWN_TTL_MS) {
    upsellCooldownByPhone.delete(normalizedPhone);
    return null;
  }
  return {
    ...row,
    cooldownActive: Date.now() - new Date(row.lastInitialSentAt).getTime() < UPSELL_COOLDOWN_WINDOW_MS,
  };
}

function markUpsellInitialSent(phone, appointmentId, atIso = null) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;
  const nowIso = atIso || new Date().toISOString();
  const row = {
    phone: normalizedPhone,
    appointmentId: String(appointmentId || '').trim() || null,
    lastInitialSentAt: nowIso,
    updatedAt: Date.now(),
  };
  upsellCooldownByPhone.set(normalizedPhone, row);
  return { ...row };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, row] of phoneToSession.entries()) {
    if (now - row.updatedAt > PHONE_SESSION_TTL_MS) phoneToSession.delete(key);
  }
  for (const [sid, row] of sidToReply.entries()) {
    if (now - row.updatedAt > MESSAGE_SID_TTL_MS) sidToReply.delete(sid);
  }
  for (const [key, row] of offerStateByKey.entries()) {
    if (now - row.updatedAt > UPGRADE_OFFER_STATE_TTL_MS) offerStateByKey.delete(key);
  }
  for (const [phone, row] of upsellCooldownByPhone.entries()) {
    if (now - row.updatedAt > UPSELL_COOLDOWN_TTL_MS) upsellCooldownByPhone.delete(phone);
  }
}, 5 * 60 * 1000);

export {
  normalizePhone,
  bindPhoneToSession,
  getSessionIdForPhone,
  storeReplyForMessageSid,
  getReplyForMessageSid,
  getUpgradeOfferState,
  markUpgradeOfferEvent,
  getUpsellCooldown,
  markUpsellInitialSent,
};

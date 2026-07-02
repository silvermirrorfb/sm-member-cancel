import { NextResponse, after } from 'next/server';
import {
  createSession,
  getAllActiveSessions,
  getSession,
  saveSession,
} from '../../../../../lib/sessions';
import { buildRateLimitHeaders, buildInternalRateLimitHeaders, checkRateLimit, getClientIP } from '../../../../../lib/rate-limit';
import {
  bindPhoneToSession,
  getSessionIdForPhone,
  getReplyForMessageSid,
  normalizePhone,
  storeReplyForMessageSid,
} from '../../../../../lib/sms-sessions';
import {
  buildTwimlMessage,
  isValidTwilioSignature,
  parseTwilioFormBody,
} from '../../../../../lib/twilio';
import {
  buildSmsUpgradePendingReply,
  isSmsUpgradeLive,
} from '../../../../../lib/sms-upgrade-policy';
import {
  evaluateUpgradeOpportunityForProfile,
  getClientById,
  lookupMember,
  reverifyAndApplyUpgradeForProfile,
  summarizeBoulevardApplyError,
} from '../../../../../lib/boulevard';
import { lookupClientIdByPhoneFromIndex, normalizePhoneForIndex } from '../../../../../lib/sms-member-registry';
import { logSmsChatMessages, logSupportIncident, notifyUpgradeIncidentOnce, SMS_UPGRADE_INCIDENT_ISSUE_TYPE } from '../../../../../lib/notify';
import { POST as postChatMessage } from '../../../chat/message/route';

// The reply returns in milliseconds, but deferWork() (after()) keeps the
// function alive for the background apply, which may run a slow Boulevard scan
// plus the booking-edit apply. Give it headroom well beyond the deferred scan
// deadline so successful background applies are never cut short.
export const maxDuration = 60;

// Cap on the slow O(N) phone-scan fallback. Twilio's webhook timeout is
// 15 seconds; we reserve 3s for the rest of the handler. On deadline we
// log at error level and return null, letting the existing no-profile
// path (lines ~634-661) reply 200 with the manual-confirm TwiML.
const PHONE_SCAN_DEADLINE_MS = 12_000;
// In deferred (post-reply) work the Twilio 15s budget no longer applies, so a
// slow-but-successful Boulevard phone scan must not be cut at 12s and dropped to
// manual. Bounded only so a runaway scan cannot outlive the function.
const DEFERRED_SCAN_DEADLINE_MS = Number(process.env.SMS_DEFERRED_SCAN_DEADLINE_MS || 45_000);

async function lookupProfileWithDeadline(from, scanFn, deadlineMs = PHONE_SCAN_DEADLINE_MS) {
  // O(1) Redis lookup first — avoids the 15-50s Boulevard phone-scan that
  // historically caused Twilio ERR:11200 on cold-cache inbound replies.
  try {
    const indexed = await lookupClientIdByPhoneFromIndex(from);
    if (indexed?.clientId) {
      const profile = await getClientById(indexed.clientId);
      if (profile) {
        // Verify the resolved client still maps to the inbound number's
        // phone-index key before trusting the fast path. A stale or reassigned
        // index entry could otherwise attach the wrong member's profile to
        // this session. On mismatch, fall through to the authoritative scan.
        const fromKey = normalizePhoneForIndex(from);
        const profileKey = normalizePhoneForIndex(profile.phone);
        if (fromKey && profileKey && fromKey === profileKey) {
          return profile;
        }
        console.warn(
          `[sms-webhook] phone-index stale: clientId ${indexed.clientId} phone ${profileKey || '(none)'} does not match inbound ${fromKey}, falling through to scan`,
        );
      }
    }
  } catch (err) {
    console.warn('[sms-webhook] phone-index lookup error:', err?.message || err);
  }
  // Fallback: race the slow O(N) scan against a 12s deadline.
  console.log(`[sms-webhook] phone-index miss, attempting fallback scan with ${Math.round(deadlineMs / 1000)}s deadline`);
  const t0 = Date.now();
  let timeoutHandle = null;
  const deadline = new Promise(resolve => {
    timeoutHandle = setTimeout(() => resolve('__deadline__'), deadlineMs);
  });
  const scanPromise = Promise.resolve()
    .then(() => scanFn('', from))
    .catch(err => {
      console.warn('[sms-webhook] fallback scan threw:', err?.message || err);
      return null;
    });
  const result = await Promise.race([scanPromise, deadline]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  const elapsed = Date.now() - t0;
  if (result === '__deadline__') {
    console.error(`[sms-webhook] phone-scan timeout after ${elapsed}ms, returning empty profile`);
    return null;
  }
  console.log(`[sms-webhook] fallback scan completed in ${elapsed}ms (profile=${result ? 'hit' : 'miss'})`);
  return result;
}

const GENERIC_FAILURE_REPLY = "I'm sorry, something went wrong on our side. Please call (888) 677-0055 for immediate help.";
const SMS_WEB_HANDOFF_LIMIT = Math.max(Number(process.env.SMS_WEB_HANDOFF_MESSAGE_LIMIT || 10), 1);
const SMS_WEB_APP_URL = String(process.env.SMS_WEB_APP_URL || 'https://sm-member-cancel.vercel.app/widget').trim();
const YES_KEYWORDS = /\b(yes|yeah|yep|sure|ok|okay|do it|add it|upgrade|let's do it|sounds good|please|absolutely)\b/i;
const NO_KEYWORDS = /\b(no|nah|no thanks|not today|pass|i'?m good|skip|decline)\b/i;
const STOP_KEYWORDS = /^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i;
const START_KEYWORDS = /^\s*(start|unstop|subscribe|yes\s+resubscribe)\s*$/i;
const YES_NO_PENDING_MANUAL_REPLY = 'Thanks for replying YES. We received your request and our team will confirm it before your appointment.';
const ALLOWED_ADDON_NAME_SET = new Set([
  'antioxidant peel',
  'neck firming',
  'eye puff minimizer',
  'lip plump and scrub',
]);

function buildSmsWebHandoffReply() {
  return `Let's continue in our web chat here: ${SMS_WEB_APP_URL}`;
}

// Run slow post-reply work without blocking the member-facing reply. Twilio
// discards a webhook reply that takes longer than ~15s, so the YES/NO path must
// return TwiML immediately and push Sheets logging, Boulevard apply, incident
// email, and session writes here. The work STARTS now (concurrent with sending
// the reply) and after() keeps the serverless function alive on Vercel until it
// settles. Outside a request scope (unit tests, non-Vercel) after() throws, so
// the detached promise is the fallback; a thrown task is swallowed so it can
// never affect the reply that already went out.
function deferWork(fn) {
  const run = Promise.resolve()
    .then(fn)
    .catch(err => console.error('[sms-webhook] deferred work failed:', err?.message || err));
  try {
    after(() => run);
  } catch {
    // No request scope available (tests / non-Vercel runtime): the detached
    // `run` above still executes; nothing else to do.
  }
}

function isAffirmative(text) {
  return YES_KEYWORDS.test(String(text || '').toLowerCase());
}

function isNegative(text) {
  return NO_KEYWORDS.test(String(text || '').toLowerCase());
}

function isUpgradeMutationEnabled() {
  return process.env.BOULEVARD_ENABLE_UPGRADE_MUTATION === 'true';
}

function isPendingOfferExpired(offer) {
  if (!offer?.expiresAt) return true;
  const expiresMs = new Date(offer.expiresAt).getTime();
  return !Number.isFinite(expiresMs) || Date.now() > expiresMs;
}

function isSmsDurationOfferAllowed(opportunity) {
  const target = Number(opportunity?.targetDurationMinutes || 0) || null;
  return !target || target <= 50;
}

function buildDurationPricingText(opportunity) {
  const target = Number(opportunity?.targetDurationMinutes || 0) || null;
  // Echo the exact pre-tax delta the offer quoted. The offer keys off the
  // persisted deltaDollars (tier-aware), so the confirmation reads the same
  // field and can never contradict the offer. No total and no "20% off" claim:
  // the duration offer quoted neither, and tax settles at in-store checkout.
  const delta = Number(opportunity?.deltaDollars);
  if (!target || !Number.isFinite(delta) || delta <= 0) return '';
  return `That extends your facial to ${target} minutes for $${delta} more.`;
}

function getAllowedAddonDisplayName(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (!ALLOWED_ADDON_NAME_SET.has(normalized)) return null;
  return raw;
}

function pickIndefiniteArticle(phrase) {
  const token = String(phrase || '')
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)[0];
  if (!token) return 'a';
  if (/^(honest|honor|hour|heir)/.test(token)) return 'an';
  if (/^(one|uni|use|euro|user|u[bcfhjkqrstnlg])/i.test(token)) return 'a';
  return /^[aeiou]/.test(token) ? 'an' : 'a';
}

function withIndefiniteArticle(phrase) {
  const value = String(phrase || '').trim();
  if (!value) return 'an add-on';
  return `${pickIndefiniteArticle(value)} ${value}`;
}

function buildPendingOfferFinalizeReply(offer) {
  const offerKind = String(offer?.offerKind || 'duration').toLowerCase();
  if (offerKind === 'addon') {
    const price = Number(offer?.pricing?.walkinPrice || 0);
    const allowedName = getAllowedAddonDisplayName(offer?.addOnName);
    if (Number.isFinite(price)) {
      if (allowedName) {
        return `Thanks, we got your YES. ${withIndefiniteArticle(allowedName)} is $${price} (members get 20% off). Our team will confirm before your appointment.`;
      }
      return `Thanks, we got your YES. The add-on is $${price} (members get 20% off). Our team will confirm before your appointment.`;
    }
    if (allowedName) {
      return `Thanks, we got your YES. We received your request for ${withIndefiniteArticle(allowedName)} and our team will confirm before your appointment.`;
    }
    return 'Thanks, we got your YES. We received your add-on request and our team will confirm before your appointment.';
  }

  const pricingText = buildDurationPricingText(offer);
  if (pricingText) {
    return `Thanks, we got your YES. ${pricingText} Our team will confirm before your appointment.`;
  }
  return 'Thanks for replying YES. We received your upgrade request and our team will confirm it before your appointment.';
}

function buildUpgradeApplyReply(upgradeResult, opportunity, pendingOffer = null) {
  if (upgradeResult?.success) {
    return "You're all set. See you soon.";
  }
  // Keep SMS replies on approved confirmation copy whenever YES cannot be finalized instantly.
  return buildPendingOfferFinalizeReply(pendingOffer || opportunity);
}

function shouldQueueUpgradeFollowupIncident(upgradeResult) {
  if (!upgradeResult) return false;
  if (upgradeResult.success !== true) return true;
  const reason = String(upgradeResult.reason || '').toLowerCase();
  return reason.includes('notes_sync_failed');
}

function queueSupportIncident(incident) {
  // Returns a settled-when-done promise so deferred callers can AWAIT it:
  // after() only keeps the serverless function alive for the promise the
  // deferred task returns, so an un-awaited incident write/email could be
  // killed mid-flight on Vercel (a sheet row alone once left three YES members
  // unworked). Errors are swallowed per-channel so awaiting never rejects and
  // the member-facing reply (already sent) is never affected.
  return Promise.allSettled([
    logSupportIncident(incident).catch(err => {
      console.error('SMS support incident logging failed:', err);
    }),
    notifyUpgradeIncidentOnce(incident).catch(err => {
      console.error('SMS upgrade incident email failed:', err);
    }),
  ]);
}

// Records the outbound upgrade-reply we are about to return as TwiML. Awaited
// on purpose: on Vercel the function can suspend once the response is returned,
// so a fire-and-forget write would risk dropping this row. The try/catch keeps
// a sheet failure from ever breaking the member reply.
async function logUpgradeReplyOutbound({ sessionId, from, activeSession, offer, upgradeResult, content }) {
  try {
    await logSmsChatMessages([{
      sessionId,
      timestamp: new Date().toISOString(),
      direction: 'outbound',
      phone: from,
      memberName: activeSession?.memberProfile?.name || null,
      location: activeSession?.memberProfile?.locationName || null,
      content,
      offerType: offer?.offerKind || null,
      outcome: upgradeResult?.success === true ? 'upgrade_confirmed' : 'manual_followup',
    }]);
  } catch (err) {
    console.error('SMS outbound upgrade reply logging failed:', err);
  }
}

function toIncidentPhone(from, profile) {
  return String(profile?.phone || from || '').trim();
}

function toIncidentSummary({ from, incomingText, pendingOffer, opportunity, upgradeResult }) {
  const offerKind = String(pendingOffer?.offerKind || opportunity?.offerKind || 'duration').toLowerCase();
  const appointmentId = pendingOffer?.appointmentId || opportunity?.appointmentId || null;
  const addOnName = String(pendingOffer?.addOnName || opportunity?.addOnName || '').trim();
  const currentDuration = Number(pendingOffer?.currentDurationMinutes || opportunity?.currentDurationMinutes || 0) || null;
  const targetDuration = Number(pendingOffer?.targetDurationMinutes || opportunity?.targetDurationMinutes || 0) || null;
  const reason = String(upgradeResult?.reason || '').trim() || 'manual_confirmation_required';
  // PR-1 (hardening 2026-06-19): carry the actual Boulevard rejection text into
  // the incident so the team sees WHY the apply failed, not just a reason code.
  const boulevardError = upgradeResult?.error
    ? summarizeBoulevardApplyError(upgradeResult.error)
    : null;
  const parts = [
    `Inbound SMS YES from ${String(from || '').trim() || 'unknown'}.`,
    `reason=${reason}`,
    `offerKind=${offerKind}`,
    appointmentId ? `appointmentId=${appointmentId}` : null,
    addOnName ? `addOn=${addOnName}` : null,
    currentDuration && targetDuration ? `duration=${currentDuration}->${targetDuration}` : null,
    boulevardError ? `boulevardError=${boulevardError}` : null,
    incomingText ? `message="${incomingText}"` : null,
  ].filter(Boolean);
  return parts.join(' | ');
}

function buildUpgradeSupportIncident({
  sessionId,
  from,
  incomingText,
  profile,
  pendingOffer = null,
  opportunity = null,
  upgradeResult = null,
}) {
  const reason = String(upgradeResult?.reason || '').toLowerCase() || 'manual_confirmation_required';
  return {
    date: new Date().toISOString(),
    session_id: sessionId,
    issue_type: SMS_UPGRADE_INCIDENT_ISSUE_TYPE,
    name: String(profile?.fullName || '').trim() || null,
    email: String(profile?.email || '').trim() || null,
    phone: toIncidentPhone(from, profile) || null,
    location: String(profile?.location || opportunity?.locationName || pendingOffer?.locationName || '').trim() || null,
    appointment_id: String(pendingOffer?.appointmentId || opportunity?.appointmentId || '').trim() || null,
    user_message: toIncidentSummary({ from, incomingText, pendingOffer, opportunity, upgradeResult }),
    reason,
  };
}

function collectSessionPhoneCandidates(session) {
  const candidates = [
    session?.memberProfile?.phone,
    session?.memberProfile?.mobilePhone,
    session?.summary?.phone,
  ];
  return candidates
    .map(value => normalizePhone(value))
    .filter(Boolean);
}

function getSessionLastActivityMs(session) {
  const timestamp = new Date(session?.lastActivity || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function recoverActiveSessionIdForPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const activeSessions = await getAllActiveSessions();
  const matches = [];

  for (const row of activeSessions || []) {
    const sessionId = String(row?.id || '').trim();
    if (!sessionId) continue;
    const session = await getSession(sessionId);
    if (!session || session.status !== 'active') continue;
    const phoneCandidates = collectSessionPhoneCandidates(session);
    if (!phoneCandidates.includes(normalizedPhone)) continue;
    matches.push(session);
  }

  if (matches.length === 0) return null;

  matches.sort((left, right) => {
    const pendingDiff = Number(Boolean(right?.pendingUpgradeOffer)) - Number(Boolean(left?.pendingUpgradeOffer));
    if (pendingDiff !== 0) return pendingDiff;
    return getSessionLastActivityMs(right) - getSessionLastActivityMs(left);
  });

  const recovered = matches[0];
  bindPhoneToSession(phone, recovered.id);
  return recovered.id;
}

async function resolveSessionIdForPhone(phone) {
  const existing = getSessionIdForPhone(phone);
  if (existing) {
    const session = await getSession(existing);
    if (session && session.status === 'active') return existing;
  }
  const recovered = await recoverActiveSessionIdForPhone(phone);
  if (recovered) return recovered;
  const created = await createSession(null, null);
  bindPhoneToSession(phone, created.id);
  return created.id;
}

function buildTwimlHeaders(rateLimit, extraHeaders = {}) {
  return {
    'Content-Type': 'text/xml; charset=utf-8',
    ...(rateLimit ? buildRateLimitHeaders(rateLimit) : {}),
    ...extraHeaders,
  };
}

async function runChatMessageForSms(sessionId, body, from) {
  // Rate-limit the in-process chat/message call per sender. Carry the phone as a
  // trusted internal identifier (authenticated by the per-process token) instead
  // of smuggling it through x-forwarded-for, where an E.164 phone fails IP parsing
  // and collapses every sender into one shared bucket.
  const phoneKey = normalizePhone(from) || String(from || '').trim() || 'unknown';
  const internalReq = new Request('http://internal/api/chat/message', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...buildInternalRateLimitHeaders(`sms:${phoneKey}`),
    },
    body: JSON.stringify({
      sessionId,
      message: String(body || '').trim(),
      channel: 'sms',
    }),
  });

  const response = await postChatMessage(internalReq);
  const payload = await response.json().catch(() => null);
  if (!response.ok) return null;
  return payload?.message || null;
}

// Slow YES post-reply work. Runs in deferWork() AFTER the reply has been sent and
// AFTER the pending offer has already been cleared + persisted synchronously on
// the reply path (idempotency: a rapid second YES must not see the same offer and
// enqueue a second apply for the same appointment). Resolves the member, attempts
// the Boulevard apply, queues a support incident on failure, caches the resolved
// profile, and logs the outbound row. Never blocks the reply; never calls chat.
// Only invoked for affirmative (YES) replies.
async function runDeferredIntentWork({
  sessionId,
  from,
  activeSession,
  pendingOffer,
  hasPendingOffer,
  intentText,
  smsUpgradeLive,
  sentReplyText,
}) {
  // YES while SMS upgrades are on hold: nothing to apply.
  if (hasPendingOffer && !smsUpgradeLive) {
    return;
  }

  // YES while the apply mutation is disabled: queue the manual-follow-up incident.
  if (!isUpgradeMutationEnabled()) {
    const disabledReason = (hasPendingOffer && String(pendingOffer?.offerKind || '').toLowerCase() === 'addon')
      ? 'manual_addon_confirmation'
      : 'upgrade_mutation_disabled';
    await queueSupportIncident(buildUpgradeSupportIncident({
      sessionId,
      from,
      incomingText: intentText,
      profile: activeSession?.memberProfile || null,
      pendingOffer,
      upgradeResult: { success: false, reason: disabledReason },
    }));
    return;
  }

  // Resolve the member (Boulevard). Background, so no Twilio deadline pressure.
  // Do NOT persist the resolved profile back to the session here: this deferred
  // task holds a session object captured at request time, and a concurrent
  // inbound can write newer state (counters, handoff, pending offer) before this
  // background scan resolves. Saving the captured object would clobber it
  // (Codex P2). The resolved profile is used in-run below for the apply; caching
  // it on the session is a non-essential optimization not worth the stale write.
  let profile = activeSession?.memberProfile || null;
  if (!profile) {
    profile = await lookupProfileWithDeadline(from, lookupMember, DEFERRED_SCAN_DEADLINE_MS);
  }
  if (!profile) {
    await queueSupportIncident(buildUpgradeSupportIncident({
      sessionId,
      from,
      incomingText: intentText,
      profile: null,
      pendingOffer,
      upgradeResult: {
        success: false,
        reason: hasPendingOffer ? 'pending_offer_context_unrecoverable' : 'member_lookup_failed_after_yes',
      },
    }));
    return;
  }

  // Apply against the exact pending offer when we have one; otherwise re-derive.
  let upgradeResult;
  let offerForLog;
  if (hasPendingOffer) {
    upgradeResult = await reverifyAndApplyUpgradeForProfile(profile, pendingOffer);
    offerForLog = pendingOffer;
  } else {
    const opportunity = await evaluateUpgradeOpportunityForProfile(profile);
    if (!opportunity?.eligible || !isSmsDurationOfferAllowed(opportunity)) {
      await queueSupportIncident(buildUpgradeSupportIncident({
        sessionId,
        from,
        incomingText: intentText,
        profile,
        opportunity,
        upgradeResult: {
          success: false,
          reason: opportunity?.eligible ? 'duration_offer_not_allowed' : (opportunity?.reason || 'no_opportunity_after_yes'),
        },
      }));
      return;
    }
    upgradeResult = await reverifyAndApplyUpgradeForProfile(profile, {
      appointmentId: opportunity.appointmentId || null,
      targetDurationMinutes: opportunity.targetDurationMinutes || null,
    });
    offerForLog = opportunity;
  }

  if (shouldQueueUpgradeFollowupIncident(upgradeResult)) {
    await queueSupportIncident(buildUpgradeSupportIncident({
      sessionId,
      from,
      incomingText: intentText,
      profile,
      pendingOffer,
      opportunity: upgradeResult?.opportunity || null,
      upgradeResult,
    }));
  }
  await logUpgradeReplyOutbound({
    sessionId,
    from,
    activeSession,
    offer: offerForLog,
    upgradeResult,
    content: sentReplyText,
  });
}

export async function POST(request) {
  let rateLimit = null;
  try {
    const smsUpgradeLive = isSmsUpgradeLive();
    const ip = getClientIP(request);
    rateLimit = await checkRateLimit(ip, 'twilio-webhook', 120, 10 * 60 * 1000);
    if (!rateLimit.allowed) {
      return new NextResponse(buildTwimlMessage('Please try again in a moment.'), {
        status: 429,
        headers: buildTwimlHeaders(rateLimit),
      });
    }

    const rawBody = await request.text();
    const form = parseTwilioFormBody(rawBody);
    const from = String(form.From || '').trim();
    const body = String(form.Body || '').trim();
    const messageSid = String(form.MessageSid || '').trim();

    if (!from || !body) {
      return new NextResponse(buildTwimlMessage('Missing From/Body in Twilio webhook payload.'), {
        status: 400,
        headers: buildTwimlHeaders(rateLimit),
      });
    }

    const providedSignature = request.headers.get('x-twilio-signature');
    const validSignature = isValidTwilioSignature({
      url: request.url,
      params: form,
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      providedSignature,
    });
    if (!validSignature) {
      return NextResponse.json(
        { error: 'Invalid Twilio signature.' },
        { status: 403, headers: buildRateLimitHeaders(rateLimit) },
      );
    }

    if (STOP_KEYWORDS.test(body)) {
      console.log(`[sms-webhook] STOP received from ${from} — opting out`);

      // Remove from Redis registry so pre-appointment scan won't re-queue them
      // AND add to the authoritative STOP set so outbound sends are blocked
      // immediately regardless of Klaviyo propagation timing.
      try {
        const registry = await import('../../../../../lib/sms-member-registry');
        if (typeof registry.removeMemberByPhone === 'function') {
          await registry.removeMemberByPhone(from);
        }
        if (typeof registry.addToStopSet === 'function') {
          await registry.addToStopSet(from);
        }
      } catch (e) {
        console.warn('[sms-webhook] Could not update registry/stop-set:', e.message);
      }

      // Propagate unsubscribe to Klaviyo so pre-appointment Klaviyo gate
      // will also block future outbound sends. Without this, a STOP only
      // protects inbound replies, not outbound marketing.
      // TCPA compliance: unsubscribe must be honored across all channels.
      try {
        const { unsubscribeKlaviyoSms } = await import('../../../../../lib/klaviyo');
        if (typeof unsubscribeKlaviyoSms === 'function') {
          const result = await unsubscribeKlaviyoSms({ phone: from });
          if (!result.ok) {
            console.warn(`[sms-webhook] Klaviyo unsubscribe returned ${result.reason}`);
          }
        }
      } catch (e) {
        console.warn('[sms-webhook] Could not propagate unsubscribe to Klaviyo:', e.message);
      }

      try {
        await logSmsChatMessages([{
          sessionId: `stop-${Date.now()}`,
          direction: 'inbound',
          phone: from,
          content: body,
          offerType: 'opt_out',
          outcome: 'stop_received',
        }]);
      } catch (e) {}

      const twiml = buildTwimlMessage('You have been unsubscribed and will not receive further messages from Silver Mirror. Reply START to resubscribe.');
      return new NextResponse(twiml, {
        status: 200,
        headers: buildTwimlHeaders(rateLimit),
      });
    }

    if (START_KEYWORDS.test(body)) {
      console.log(`[sms-webhook] START received from ${from}, removing from stop set`);
      try {
        const { removeFromStopSet } = await import('../../../../../lib/sms-member-registry');
        if (typeof removeFromStopSet === 'function') {
          await removeFromStopSet(from);
        }
      } catch (e) {
        console.warn('[sms-webhook] Could not remove from stop set:', e.message);
      }
      try {
        await logSmsChatMessages([{
          sessionId: `start-${Date.now()}`,
          direction: 'inbound',
          phone: from,
          content: body,
          offerType: 'resubscribe',
          outcome: 'start_received',
        }]);
      } catch (e) {}
      const twiml = buildTwimlMessage('You have been resubscribed to Silver Mirror messages. Reply STOP to unsubscribe at any time.');
      return new NextResponse(twiml, {
        status: 200,
        headers: buildTwimlHeaders(rateLimit),
      });
    }

    if (messageSid) {
      const replay = getReplyForMessageSid(messageSid);
      if (replay) {
        return new NextResponse(replay, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
      }
    }

    // Missed-call session routing. If this phone has an active missed-call
    // session, route this reply through the missed-call prompt instead of
    // the general flow. The chat/message route reads session.session_mode
    // and selects system-prompt-missed-call.txt automatically.
    try {
      const { getSessionByPhone } = await import('../../../../../lib/sms-sessions');
      const missedCallSession = await getSessionByPhone(from);
      if (missedCallSession?.session_mode === 'missed_call') {
        // Hard kill switch: if reply handling is disabled, send a static
        // fallback and do NOT invoke Claude. Session is preserved for
        // observability per spec §1.10.
        if (process.env.MISSED_CALL_REPLY_HANDLING_ENABLED === 'false') {
          const fallbackTwiml = buildTwimlMessage('Thanks, a teammate will follow up soon.');
          if (messageSid) storeReplyForMessageSid(messageSid, fallbackTwiml);
          return new NextResponse(fallbackTwiml, {
            status: 200,
            headers: buildTwimlHeaders(rateLimit),
          });
        }

        // Detect CALLBACK keyword: confirm in one message, log to
        // CallbackQueue Sheet, do NOT invoke Claude.
        if (/^\s*callback\s*\.?\s*$/i.test(body)) {
          const locationName = missedCallSession.location_called || 'the location';
          const callbackReply = `Got it, I've flagged this for a teammate at ${locationName}. Someone will call you back shortly during business hours.`;
          try {
            const notify = await import('../../../../../lib/notify');
            if (typeof notify.logCallbackQueueEntry === 'function') {
              await notify.logCallbackQueueEntry({
                callerPhone: from,
                location: missedCallSession.location_called || null,
                originalAutotextTime: missedCallSession.missed_call_triggered_at || null,
                status: 'pending',
              });
            }
          } catch (err) {
            console.warn('[sms-webhook] callback queue logging failed:', err?.message || err);
          }
          try {
            const { fireGa4Event } = await import('../../../../../lib/ga4');
            await fireGa4Event('auto_text_reply', {
              location: missedCallSession.location_called || null,
              reply_kind: 'callback_request',
            });
          } catch {}
          await logSmsChatMessages([{
            sessionId: missedCallSession.id,
            timestamp: new Date().toISOString(),
            direction: 'inbound',
            phone: from,
            content: body,
            offerType: 'missed_call_callback',
            outcome: 'callback_requested',
            location: missedCallSession.location_called || null,
          }]).catch(() => {});
          const callbackTwiml = buildTwimlMessage(callbackReply);
          if (messageSid) storeReplyForMessageSid(messageSid, callbackTwiml);
          return new NextResponse(callbackTwiml, {
            status: 200,
            headers: buildTwimlHeaders(rateLimit),
          });
        }

        // Log inbound for observability, then route to Claude with the
        // missed-call prompt. The chat route reads session.session_mode
        // and selects the right prompt automatically.
        await logSmsChatMessages([{
          sessionId: missedCallSession.id,
          timestamp: new Date().toISOString(),
          direction: 'inbound',
          phone: from,
          content: body,
          offerType: 'missed_call_reply',
          outcome: 'message_received',
          location: missedCallSession.location_called || null,
        }]).catch(() => {});

        try {
          const { fireGa4Event } = await import('../../../../../lib/ga4');
          await fireGa4Event('auto_text_reply', {
            location: missedCallSession.location_called || null,
            reply_kind: 'general',
          });
        } catch {}

        const reply = await runChatMessageForSms(missedCallSession.id, body, from);
        const twiml = buildTwimlMessage(reply || GENERIC_FAILURE_REPLY);
        if (messageSid) storeReplyForMessageSid(messageSid, twiml);
        return new NextResponse(twiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
      }
    } catch (err) {
      console.warn('[sms-webhook] missed-call routing failed, falling through to general:', err?.message || err);
    }

    const sessionId = await resolveSessionIdForPhone(from);
    const activeSession = await getSession(sessionId);
    // Inbound logging is Sheets I/O; never block the reply on it.
    deferWork(() => logSmsChatMessages([{
      sessionId,
      timestamp: new Date().toISOString(),
      direction: 'inbound',
      phone: from,
      memberName: activeSession?.memberProfile?.name || null,
      location: activeSession?.memberProfile?.locationName || null,
      content: body,
      offerType: activeSession?.pendingUpgradeOffer?.offerKind || null,
      outcome: (isAffirmative(body) || isNegative(body)) ? 'intent_response' : 'message_received',
    }]));
    if (activeSession) {
      const currentCount = Number(activeSession.smsInboundCount || 0);
      activeSession.smsInboundCount = currentCount + 1;
      if (activeSession.smsHandoffToWeb === true || activeSession.smsInboundCount >= SMS_WEB_HANDOFF_LIMIT) {
        activeSession.smsHandoffToWeb = true;
        await saveSession(activeSession);
        const handoffTwiml = buildTwimlMessage(buildSmsWebHandoffReply());
        if (messageSid) storeReplyForMessageSid(messageSid, handoffTwiml);
        return new NextResponse(handoffTwiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
      }
    }

    const intentText = String(body || '').trim();
    if (isAffirmative(intentText) || isNegative(intentText)) {
      const affirmative = isAffirmative(intentText);
      const pendingOffer = activeSession?.pendingUpgradeOffer || null;
      const pendingOfferBlocked =
        pendingOffer?.offerKind === 'duration' &&
        !isSmsDurationOfferAllowed(pendingOffer);
      const hasPendingOffer = pendingOffer && !pendingOfferBlocked && !isPendingOfferExpired(pendingOffer);

      // Deterministic, instant reply. It NEVER awaits Sheets or Boulevard and
      // never calls the chat route, so Twilio always gets TwiML well inside its
      // ~15s window (the silent-YES cause). Copy matches what production sends
      // today: NO declines; a live pending-offer YES echoes the persisted
      // (tier-aware) price as a manual-confirm; any other YES uses the approved
      // generic confirmation. When the booking-edit apply (outbound-sms #13) is
      // enabled, a result-specific follow-up SMS is the next enhancement; the
      // immediate reply stays instant and deterministic.
      let replyText;
      if (!affirmative) {
        replyText = 'No problem - we will keep your appointment as-is.';
      } else if (hasPendingOffer && !smsUpgradeLive) {
        replyText = buildSmsUpgradePendingReply();
      } else if (hasPendingOffer) {
        replyText = buildPendingOfferFinalizeReply(pendingOffer);
      } else {
        replyText = YES_NO_PENDING_MANUAL_REPLY;
      }
      const intentTwiml = buildTwimlMessage(replyText);
      if (messageSid) storeReplyForMessageSid(messageSid, intentTwiml);

      // Clear + persist the pending offer SYNCHRONOUSLY before replying. This is a
      // fast Redis session write (not Sheets/Boulevard), and it must happen on the
      // reply path so a rapid second YES/NO cannot read the same offer and enqueue
      // a duplicate apply for the same appointment. The captured offer below still
      // drives the deferred apply.
      if (activeSession?.pendingUpgradeOffer) {
        activeSession.lastUpgradeOfferAppointmentId = pendingOffer?.appointmentId
          || activeSession.lastUpgradeOfferAppointmentId || null;
        activeSession.pendingUpgradeOffer = null;
        await saveSession(activeSession);
      }

      // Slow work (member lookup, Boulevard apply, incident, outbound log) runs
      // off the reply path. Only a YES has apply work; a NO is fully handled by
      // the synchronous clear above.
      if (affirmative) {
        deferWork(() => runDeferredIntentWork({
          sessionId,
          from,
          activeSession,
          pendingOffer,
          hasPendingOffer,
          intentText,
          smsUpgradeLive,
          sentReplyText: replyText,
        }));
      }

      return new NextResponse(intentTwiml, {
        status: 200,
        headers: buildTwimlHeaders(rateLimit),
      });
    }

    const reply = await runChatMessageForSms(sessionId, body, from);
    const twiml = buildTwimlMessage(reply || GENERIC_FAILURE_REPLY);

    if (messageSid) storeReplyForMessageSid(messageSid, twiml);

    return new NextResponse(twiml, {
      status: 200,
      headers: buildTwimlHeaders(rateLimit),
    });
  } catch (err) {
    console.error('Twilio webhook error:', err);
    return new NextResponse(buildTwimlMessage(GENERIC_FAILURE_REPLY), {
      status: 200,
      headers: buildTwimlHeaders(rateLimit),
    });
  }
}

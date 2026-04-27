import { NextResponse } from 'next/server';
import {
  completeSession,
  createSession,
  getAllActiveSessions,
  getSession,
  saveSession,
} from '../../../../../lib/sessions';
import { buildRateLimitHeaders, checkRateLimit, getClientIP } from '../../../../../lib/rate-limit';
import {
  bindPhoneToSession,
  getSessionByPhone,
  getSessionIdForPhone,
  getReplyForMessageSid,
  normalizePhone,
  storeReplyForMessageSid,
} from '../../../../../lib/sms-sessions';
import {
  buildTwimlMessage,
  isValidTwilioSignature,
  parseTwilioFormBody,
  sendTwilioSms,
} from '../../../../../lib/twilio';
import { detectCallbackIntent, getCallbackRequestedVia } from '../../../../../lib/callback-detection';
import { fireGa4Event } from '../../../../../lib/ga4';
import {
  buildSmsUpgradePendingReply,
  isSmsUpgradeLive,
} from '../../../../../lib/sms-upgrade-policy';
import {
  evaluateUpgradeOpportunityForProfile,
  lookupMember,
  reverifyAndApplyUpgradeForProfile,
} from '../../../../../lib/boulevard';
import {
  logCallbackRequest,
  logSmsChatMessages,
  logSupportIncident,
} from '../../../../../lib/notify';
import { POST as postChatMessage } from '../../../chat/message/route';

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

const LOCATION_DISPLAY_NAMES = {
  brickell: 'Brickell',
};

function formatLocationName(slug) {
  const key = String(slug || '').trim().toLowerCase();
  if (!key) return 'the salon';
  return LOCATION_DISPLAY_NAMES[key] || key.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function buildCallbackConfirmation(locationSlug) {
  return `Got it, I've flagged this for a teammate at ${formatLocationName(locationSlug)}. Someone will call you back shortly during business hours.`;
}

async function handleMissedCallCallback({ session, from, body, rateLimit, messageSid }) {
  const requestedVia = getCallbackRequestedVia(body);
  const callerPhone = session.caller_phone || normalizePhone(from);
  const location = session.location_called || null;

  try {
    await logCallbackRequest({
      callerPhone,
      location,
      originalAutotextSid: session.outbound_autotext_sid || null,
      requestedVia,
      messageBody: body,
    });
  } catch (err) {
    console.error('[missed-call-callback] Sheet write failed:', err?.message || err);
  }

  fireGa4Event('callback_requested', {
    location_name: location,
    callerPhone,
    requested_via: requestedVia,
  }).catch(err => {
    console.warn('[missed-call-callback] GA4 emit failed:', err?.message || err);
  });

  const confirmationBody = buildCallbackConfirmation(location);
  try {
    await sendTwilioSms({ to: callerPhone, body: confirmationBody });
  } catch (err) {
    console.error('[missed-call-callback] confirmation SMS send failed:', err?.message || err);
  }

  try {
    await completeSession(session.id, 'callback_requested', {
      caller_phone: callerPhone,
      location_called: location,
      callback_requested_via: requestedVia,
      closed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[missed-call-callback] completeSession failed:', err?.message || err);
  }

  const twiml = buildTwimlMessage(confirmationBody);
  if (messageSid) storeReplyForMessageSid(messageSid, twiml);
  return new NextResponse(twiml, {
    status: 200,
    headers: buildTwimlHeaders(rateLimit),
  });
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
  const pricing = opportunity?.pricing || null;
  if (!pricing) return '';
  const current = Number(opportunity?.currentDurationMinutes || 0) || null;
  const target = Number(opportunity?.targetDurationMinutes || 0) || null;
  const delta = Number(pricing.walkinDelta || 0);
  const total = Number(pricing.walkinTotal || 0);
  if (!current || !target || !Number.isFinite(delta) || !Number.isFinite(total)) return '';
  return `${current}->${target} is +$${delta} ($${total} total; members get 20% off).`;
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
  logSupportIncident(incident).catch(err => {
    console.error('SMS support incident logging failed:', err);
  });
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
  const parts = [
    `Inbound SMS YES from ${String(from || '').trim() || 'unknown'}.`,
    `reason=${reason}`,
    `offerKind=${offerKind}`,
    appointmentId ? `appointmentId=${appointmentId}` : null,
    addOnName ? `addOn=${addOnName}` : null,
    currentDuration && targetDuration ? `duration=${currentDuration}->${targetDuration}` : null,
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
    issue_type: 'sms_upgrade_manual_followup',
    name: String(profile?.fullName || '').trim() || null,
    email: String(profile?.email || '').trim() || null,
    phone: toIncidentPhone(from, profile) || null,
    location: String(profile?.location || opportunity?.locationName || pendingOffer?.locationName || '').trim() || null,
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
  const ipKey = normalizePhone(from) || `sms:${String(from || '').trim()}`;
  const internalReq = new Request('http://internal/api/chat/message', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ipKey,
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

    // Missed-call pilot: if the caller's last session is a missed_call session
    // and their reply is a clear callback request, handle it inline (log to
    // CallbackQueue, fire GA4, send confirmation, close session) before we
    // pay for a Claude turn. Non-callback replies on a missed_call session
    // fall through to the general handler — full conversation routing is VC-7.
    try {
      const phoneSession = await getSessionByPhone(from);
      if (phoneSession?.session_mode === 'missed_call'
          && phoneSession.status === 'active'
          && detectCallbackIntent(body)) {
        return await handleMissedCallCallback({
          session: phoneSession,
          from,
          body,
          rateLimit,
          messageSid,
        });
      }
    } catch (err) {
      console.warn('[sms-webhook] missed-call preamble failed, falling through:', err?.message || err);
    }

    const sessionId = await resolveSessionIdForPhone(from);
    const activeSession = await getSession(sessionId);
    await logSmsChatMessages([{
      sessionId,
      timestamp: new Date().toISOString(),
      direction: 'inbound',
      phone: from,
      memberName: activeSession?.memberProfile?.name || null,
      location: activeSession?.memberProfile?.locationName || null,
      content: body,
      offerType: activeSession?.pendingUpgradeOffer?.offerKind || null,
      outcome: (isAffirmative(body) || isNegative(body)) ? 'intent_response' : 'message_received',
    }]);
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
      const pendingOffer = activeSession?.pendingUpgradeOffer || null;
      const pendingOfferBlocked =
        pendingOffer?.offerKind === 'duration' &&
        !isSmsDurationOfferAllowed(pendingOffer);
      const hasPendingOffer = pendingOffer && !pendingOfferBlocked && !isPendingOfferExpired(pendingOffer);
      if (activeSession?.pendingUpgradeOffer && !hasPendingOffer) {
        activeSession.pendingUpgradeOffer = null;
        await saveSession(activeSession);
      }

      if (hasPendingOffer && isNegative(intentText)) {
        activeSession.lastUpgradeOfferAppointmentId = pendingOffer.appointmentId || null;
        activeSession.pendingUpgradeOffer = null;
        await saveSession(activeSession);
        const declineTwiml = buildTwimlMessage('No problem - we will keep your appointment as-is.');
        if (messageSid) storeReplyForMessageSid(messageSid, declineTwiml);
        return new NextResponse(declineTwiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
      }

      const pendingOfferKind = String(pendingOffer?.offerKind || 'duration').toLowerCase();
      const canFinalizeWithoutMutation = hasPendingOffer && !isUpgradeMutationEnabled();
      if (isAffirmative(intentText) && hasPendingOffer && !smsUpgradeLive) {
        activeSession.lastUpgradeOfferAppointmentId = pendingOffer.appointmentId || null;
        activeSession.pendingUpgradeOffer = null;
        await saveSession(activeSession);
        const pendingTwiml = buildTwimlMessage(buildSmsUpgradePendingReply());
        if (messageSid) storeReplyForMessageSid(messageSid, pendingTwiml);
        return new NextResponse(pendingTwiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
      }
      if (isAffirmative(intentText) && canFinalizeWithoutMutation) {
        const incident = buildUpgradeSupportIncident({
          sessionId,
          from,
          incomingText: intentText,
          profile: activeSession?.memberProfile || null,
          pendingOffer,
          upgradeResult: {
            success: false,
            reason: pendingOfferKind === 'addon' ? 'manual_addon_confirmation' : 'upgrade_mutation_disabled',
          },
        });
        queueSupportIncident(incident);
        activeSession.lastUpgradeOfferAppointmentId = pendingOffer.appointmentId || null;
        activeSession.pendingUpgradeOffer = null;
        await saveSession(activeSession);
        const teamFinalizeTwiml = buildTwimlMessage(buildPendingOfferFinalizeReply(pendingOffer));
        if (messageSid) storeReplyForMessageSid(messageSid, teamFinalizeTwiml);
        return new NextResponse(teamFinalizeTwiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
      }

      if (isAffirmative(intentText) && !isUpgradeMutationEnabled()) {
        const incident = buildUpgradeSupportIncident({
          sessionId,
          from,
          incomingText: intentText,
          profile: activeSession?.memberProfile || null,
          upgradeResult: { success: false, reason: 'upgrade_mutation_disabled' },
        });
        queueSupportIncident(incident);
        const fallbackTwiml = buildTwimlMessage(
          'Thanks for replying YES. We received your request and our team will confirm it before your appointment.',
        );
        if (messageSid) storeReplyForMessageSid(messageSid, fallbackTwiml);
        return new NextResponse(fallbackTwiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
      }

      let profile = activeSession?.memberProfile || null;
      if (!profile) {
        profile = await lookupMember('', from);
        if (activeSession && profile) {
          activeSession.memberId = profile.clientId || null;
          activeSession.memberProfile = profile;
          await saveSession(activeSession);
        }
      }

      if (!profile && isNegative(intentText)) {
        const declineTwiml = buildTwimlMessage('No problem - we will keep your appointment as-is.');
        if (messageSid) storeReplyForMessageSid(messageSid, declineTwiml);
        return new NextResponse(declineTwiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
      }

      if (!profile && isAffirmative(intentText)) {
        const incident = buildUpgradeSupportIncident({
          sessionId,
          from,
          incomingText: intentText,
          profile: activeSession?.memberProfile || null,
          pendingOffer,
          upgradeResult: {
            success: false,
            reason: hasPendingOffer ? 'pending_offer_context_unrecoverable' : 'member_lookup_failed_after_yes',
          },
        });
        queueSupportIncident(incident);
        const fallbackTwiml = buildTwimlMessage(YES_NO_PENDING_MANUAL_REPLY);
        if (messageSid) storeReplyForMessageSid(messageSid, fallbackTwiml);
        return new NextResponse(fallbackTwiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
      }

      if (profile) {
        if (isNegative(intentText)) {
          const declineTwiml = buildTwimlMessage('No problem - we will keep your appointment as-is.');
          if (messageSid) storeReplyForMessageSid(messageSid, declineTwiml);
          return new NextResponse(declineTwiml, {
            status: 200,
            headers: buildTwimlHeaders(rateLimit),
          });
        }

        // Deterministic YES handling: if we have a live pending offer, reverify against
        // that exact appointment/target instead of doing a fresh generic opportunity pick.
        if (isAffirmative(intentText) && hasPendingOffer) {
          const upgradeResult = await reverifyAndApplyUpgradeForProfile(profile, pendingOffer);
          if (shouldQueueUpgradeFollowupIncident(upgradeResult)) {
            const incident = buildUpgradeSupportIncident({
              sessionId,
              from,
              incomingText: intentText,
              profile,
              pendingOffer,
              opportunity: upgradeResult?.opportunity || null,
              upgradeResult,
            });
            queueSupportIncident(incident);
          }
          if (activeSession) {
            activeSession.lastUpgradeOfferAppointmentId = pendingOffer.appointmentId || null;
            activeSession.pendingUpgradeOffer = null;
            await saveSession(activeSession);
          }
          const upgradeText = buildUpgradeApplyReply(upgradeResult, upgradeResult?.opportunity || null, pendingOffer);
          const upgradeTwiml = buildTwimlMessage(upgradeText);
          if (messageSid) storeReplyForMessageSid(messageSid, upgradeTwiml);
          return new NextResponse(upgradeTwiml, {
            status: 200,
            headers: buildTwimlHeaders(rateLimit),
          });
        }

        const opportunity = await evaluateUpgradeOpportunityForProfile(profile);
        if (opportunity?.eligible && !isSmsDurationOfferAllowed(opportunity)) {
          const reply = await runChatMessageForSms(sessionId, body, from);
          const twiml = buildTwimlMessage(reply || GENERIC_FAILURE_REPLY);
          if (messageSid) storeReplyForMessageSid(messageSid, twiml);
          return new NextResponse(twiml, {
            status: 200,
            headers: buildTwimlHeaders(rateLimit),
          });
        }
        if (!opportunity?.eligible) {
          // If YES arrives without recoverable pending context, fail safe to approved manual confirmation copy.
          const incident = buildUpgradeSupportIncident({
            sessionId,
            from,
            incomingText: intentText,
            profile,
            opportunity,
            upgradeResult: { success: false, reason: opportunity?.reason || 'no_opportunity_after_yes' },
          });
          queueSupportIncident(incident);
          const fallbackTwiml = buildTwimlMessage(YES_NO_PENDING_MANUAL_REPLY);
          if (messageSid) storeReplyForMessageSid(messageSid, fallbackTwiml);
          return new NextResponse(fallbackTwiml, {
            status: 200,
            headers: buildTwimlHeaders(rateLimit),
          });
        }

        const upgradeResult = await reverifyAndApplyUpgradeForProfile(profile, {
          appointmentId: opportunity.appointmentId || null,
          targetDurationMinutes: opportunity.targetDurationMinutes || null,
        });
        if (shouldQueueUpgradeFollowupIncident(upgradeResult)) {
          const incident = buildUpgradeSupportIncident({
            sessionId,
            from,
            incomingText: intentText,
            profile,
            opportunity,
            upgradeResult,
          });
          queueSupportIncident(incident);
        }
        if (activeSession) {
          activeSession.lastUpgradeOfferAppointmentId = pendingOffer?.appointmentId || opportunity?.appointmentId || null;
          activeSession.pendingUpgradeOffer = null;
          await saveSession(activeSession);
        }
        const upgradeText = buildUpgradeApplyReply(upgradeResult, opportunity, pendingOffer);
        const upgradeTwiml = buildTwimlMessage(upgradeText);
        if (messageSid) storeReplyForMessageSid(messageSid, upgradeTwiml);
        return new NextResponse(upgradeTwiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
      }
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

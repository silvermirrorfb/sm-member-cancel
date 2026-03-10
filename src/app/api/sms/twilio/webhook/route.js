import { NextResponse } from 'next/server';
import { createSession, getSession } from '../../../../../lib/sessions';
import { checkRateLimit, getClientIP } from '../../../../../lib/rate-limit';
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
  evaluateUpgradeOpportunityForProfile,
  lookupMember,
  reverifyAndApplyUpgradeForProfile,
} from '../../../../../lib/boulevard';
import { POST as postChatMessage } from '../../../chat/message/route';

const GENERIC_FAILURE_REPLY = "I'm sorry, something went wrong on our side. Please call (888) 677-0055 for immediate help.";
const SMS_WEB_HANDOFF_LIMIT = Math.max(Number(process.env.SMS_WEB_HANDOFF_MESSAGE_LIMIT || 10), 1);
const SMS_WEB_APP_URL = String(process.env.SMS_WEB_APP_URL || 'https://sm-member-cancel.vercel.app/widget').trim();
const YES_KEYWORDS = /\b(yes|yeah|yep|sure|ok|okay|do it|add it|upgrade|let's do it|sounds good|please|absolutely)\b/i;
const NO_KEYWORDS = /\b(no|nah|no thanks|not today|pass|i'?m good|skip|decline)\b/i;

function buildSmsWebHandoffReply() {
  return `Let's continue in our web chat here: ${SMS_WEB_APP_URL}`;
}

function isAffirmative(text) {
  return YES_KEYWORDS.test(String(text || '').toLowerCase());
}

function isNegative(text) {
  return NO_KEYWORDS.test(String(text || '').toLowerCase());
}

function buildUpgradeApplyReply(upgradeResult, opportunity) {
  if (upgradeResult?.success) {
    return `Confirmed. You are upgraded to ${opportunity?.targetDurationMinutes} minutes for your upcoming appointment.`;
  }
  const reason = String(upgradeResult?.reason || '').toLowerCase();
  if (['upgrade_mutation_disabled', 'service_id_not_configured', 'upgrade_mutation_failed'].includes(reason)) {
    return 'Thanks for replying YES. We received your upgrade request and our team will finalize it in Boulevard before your appointment.';
  }
  return 'Thanks for the quick reply. I re-checked and the upgrade slot is no longer available.';
}

function resolveSessionIdForPhone(phone) {
  const existing = getSessionIdForPhone(phone);
  if (existing) {
    const session = getSession(existing);
    if (session && session.status === 'active') return existing;
  }
  const created = createSession(null, null);
  bindPhoneToSession(phone, created.id);
  return created.id;
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
    }),
  });

  const response = await postChatMessage(internalReq);
  const payload = await response.json().catch(() => null);
  if (!response.ok) return null;
  return payload?.message || null;
}

export async function POST(request) {
  try {
    const ip = getClientIP(request);
    const { allowed, retryAfterMs } = checkRateLimit(ip, 'twilio-webhook', 120, 10 * 60 * 1000);
    if (!allowed) {
      return new NextResponse(buildTwimlMessage('Please try again in a moment.'), {
        status: 429,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
        },
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
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
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
      return NextResponse.json({ error: 'Invalid Twilio signature.' }, { status: 403 });
    }

    if (messageSid) {
      const replay = getReplyForMessageSid(messageSid);
      if (replay) {
        return new NextResponse(replay, {
          status: 200,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        });
      }
    }

    const sessionId = resolveSessionIdForPhone(from);
    const session = getSession(sessionId);
    if (session) {
      const currentCount = Number(session.smsInboundCount || 0);
      session.smsInboundCount = currentCount + 1;
      if (session.smsHandoffToWeb === true || session.smsInboundCount >= SMS_WEB_HANDOFF_LIMIT) {
        session.smsHandoffToWeb = true;
        const handoffTwiml = buildTwimlMessage(buildSmsWebHandoffReply());
        if (messageSid) storeReplyForMessageSid(messageSid, handoffTwiml);
        return new NextResponse(handoffTwiml, {
          status: 200,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        });
      }
    }

    const intentText = String(body || '').trim();
    if (isAffirmative(intentText) || isNegative(intentText)) {
      const session = getSession(sessionId);
      let profile = session?.memberProfile || null;
      if (!profile) {
        profile = await lookupMember('', from);
        if (session && profile) {
          session.memberId = profile.clientId || null;
          session.memberProfile = profile;
        }
      }

      if (profile) {
        if (isNegative(intentText)) {
          const declineTwiml = buildTwimlMessage('No problem - we will keep your appointment as-is.');
          if (messageSid) storeReplyForMessageSid(messageSid, declineTwiml);
          return new NextResponse(declineTwiml, {
            status: 200,
            headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          });
        }

        const opportunity = await evaluateUpgradeOpportunityForProfile(profile);
        if (!opportunity?.eligible) {
          const noSlotTwiml = buildTwimlMessage('Thanks for replying. I checked and there is no upgrade slot available right now.');
          if (messageSid) storeReplyForMessageSid(messageSid, noSlotTwiml);
          return new NextResponse(noSlotTwiml, {
            status: 200,
            headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          });
        }

        const upgradeResult = await reverifyAndApplyUpgradeForProfile(profile, {
          appointmentId: opportunity.appointmentId || null,
          targetDurationMinutes: opportunity.targetDurationMinutes || null,
        });
        const upgradeText = buildUpgradeApplyReply(upgradeResult, opportunity);
        const upgradeTwiml = buildTwimlMessage(upgradeText);
        if (messageSid) storeReplyForMessageSid(messageSid, upgradeTwiml);
        return new NextResponse(upgradeTwiml, {
          status: 200,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        });
      }
    }

    const reply = await runChatMessageForSms(sessionId, body, from);
    const twiml = buildTwimlMessage(reply || GENERIC_FAILURE_REPLY);

    if (messageSid) storeReplyForMessageSid(messageSid, twiml);

    return new NextResponse(twiml, {
      status: 200,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    });
  } catch (err) {
    console.error('Twilio webhook error:', err);
    return new NextResponse(buildTwimlMessage(GENERIC_FAILURE_REPLY), {
      status: 200,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    });
  }
}

import { NextResponse } from 'next/server';
import { createSession, getSession } from '../../../../../lib/sessions';
import { buildSystemPromptWithProfile } from '../../../../../lib/claude';
import {
  evaluateUpgradeOpportunityForProfile,
  formatProfileForPrompt,
  lookupMember,
} from '../../../../../lib/boulevard';
import { bindPhoneToSession, getSessionIdForPhone } from '../../../../../lib/sms-sessions';
import { sendTwilioSms } from '../../../../../lib/twilio';
import { isWithinSendWindow, parseHour } from '../../../../../lib/sms-window';

const OFFER_WINDOW_MINUTES = Number(process.env.YES_RESPONSE_WINDOW_MIN || 10);

function isAuthorized(request) {
  const configured = String(process.env.SMS_AUTOMATION_TOKEN || '').trim();
  if (!configured) return process.env.NODE_ENV !== 'production';
  const provided = String(request.headers.get('x-automation-token') || '').trim();
  return provided === configured;
}

function asText(value) {
  return String(value || '').trim();
}

function asInt(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isPendingOfferExpired(offer) {
  if (!offer?.expiresAt) return true;
  const expires = new Date(offer.expiresAt).getTime();
  return !Number.isFinite(expires) || Date.now() > expires;
}

function formatTimeForGuest(iso) {
  if (!iso) return 'your upcoming appointment';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'your upcoming appointment';
  return d.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}

function buildOutboundOfferMessage(opportunity) {
  if (!opportunity?.pricing) return null;
  const isMember = opportunity.isMember === true;
  const pricing = opportunity.pricing;
  const total = isMember ? pricing.memberTotal : pricing.walkinTotal;
  const delta = isMember ? pricing.memberDelta : pricing.walkinDelta;
  const currentDuration = opportunity.currentDurationMinutes;
  const targetDuration = opportunity.targetDurationMinutes;
  const timeText = formatTimeForGuest(opportunity.startOn);
  const priceLine = isMember
    ? `Upgrading from ${currentDuration} to ${targetDuration} minutes would be $${total} total (+$${delta}).`
    : `Upgrading from ${currentDuration} to ${targetDuration} minutes would be +$${delta} (new total $${total}).`;
  return `Silver Mirror: we have room after your ${timeText} appointment. ${priceLine} Reply YES within ${OFFER_WINDOW_MINUTES} minutes to confirm, or NO to keep your current booking.`;
}

function resolveCandidates(body) {
  if (Array.isArray(body.candidates) && body.candidates.length > 0) return body.candidates;
  const firstName = asText(body.firstName);
  const lastName = asText(body.lastName);
  const email = asText(body.email).toLowerCase();
  const phone = asText(body.phone);
  if (firstName && lastName && (email || phone)) {
    return [{ firstName, lastName, email, phone }];
  }
  return [];
}

function getOrCreateSmsSession(profile) {
  const phone = asText(profile?.phone);
  let session = null;
  const existingId = phone ? getSessionIdForPhone(phone) : null;
  if (existingId) {
    const existing = getSession(existingId);
    if (existing && existing.status === 'active') session = existing;
  }
  if (!session) {
    session = createSession(profile?.clientId || null, profile || null);
  }

  session.memberId = profile?.clientId || session.memberId || null;
  session.memberProfile = profile || null;
  session.mode = 'membership';
  session.systemPrompt = buildSystemPromptWithProfile(formatProfileForPrompt(profile));
  session.status = 'active';
  session.lastActivity = new Date();
  if (phone) bindPhoneToSession(phone, session.id);
  return session;
}

export async function POST(request) {
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json({ error: 'Unauthorized automation request.' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const dryRun = body.dryRun !== false;
    const now = asText(body.now) || null;
    const runNow = now || new Date().toISOString();
    const windowHours = asInt(body.windowHours, null);
    const fallbackLocationId = asText(body.locationId) || null;
    const targetDurationMinutes = asInt(body.targetDurationMinutes, null);
    const maxSends = Math.max(1, asInt(body.maxSends, 50));
    const fromNumber = asText(body.fromNumber) || null;
    const statusCallback = asText(body.statusCallback) || null;
    const sendTimezone = asText(body.sendTimezone) || process.env.SMS_OUTBOUND_TIMEZONE || 'America/New_York';
    const sendStartHour = parseHour(body.sendStartHour, parseHour(process.env.SMS_OUTBOUND_START_HOUR, 9));
    const sendEndHour = parseHour(body.sendEndHour, parseHour(process.env.SMS_OUTBOUND_END_HOUR, 17));
    const enforceSendWindow = body.enforceSendWindow !== false;
    const candidates = resolveCandidates(body);

    if (candidates.length === 0) {
      return NextResponse.json(
        { error: 'Provide candidates[] or one candidate with firstName, lastName, and email/phone.' },
        { status: 400 },
      );
    }

    const results = [];
    let sentCount = 0;
    const sendWindow = isWithinSendWindow(runNow, {
      timeZone: sendTimezone,
      startHour: sendStartHour,
      endHour: sendEndHour,
    });

    if (enforceSendWindow && !sendWindow.allowed) {
      for (const candidate of candidates) {
        results.push({
          candidate: {
            firstName: asText(candidate.firstName) || null,
            lastName: asText(candidate.lastName) || null,
            email: asText(candidate.email).toLowerCase() || null,
            phone: asText(candidate.phone) || null,
          },
          status: 'skipped',
          reason: 'outside_send_window',
        });
      }
      return NextResponse.json({
        ok: true,
        dryRun,
        sendWindow: {
          enforced: true,
          allowed: false,
          timeZone: sendWindow.timeZone,
          hour: sendWindow.hour,
          startHour: sendWindow.startHour,
          endHour: sendWindow.endHour,
        },
        summary: { total: results.length, skipped: results.length },
        results,
      });
    }

    for (const candidate of candidates) {
      const firstName = asText(candidate.firstName);
      const lastName = asText(candidate.lastName);
      const email = asText(candidate.email).toLowerCase();
      const phone = asText(candidate.phone);
      const fullName = `${firstName} ${lastName}`.trim();
      const contacts = [];
      if (email) contacts.push(email);
      if (phone) contacts.push(phone);

      if (!firstName || !lastName || contacts.length === 0) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          status: 'skipped',
          reason: 'missing_candidate_fields',
        });
        continue;
      }

      let profile = null;
      let matchedContact = null;
      for (const contact of contacts) {
        profile = await lookupMember(fullName, contact);
        if (profile) {
          matchedContact = contact;
          break;
        }
      }
      if (!profile) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          status: 'skipped',
          reason: 'member_not_found',
        });
        continue;
      }

      const opportunity = await evaluateUpgradeOpportunityForProfile(profile, {
        appointmentId: asText(candidate.appointmentId) || undefined,
        targetDurationMinutes: asInt(candidate.targetDurationMinutes, targetDurationMinutes) || undefined,
        locationId: asText(candidate.locationId) || fallbackLocationId || undefined,
        now: now || undefined,
        windowHours: windowHours || undefined,
      });

      if (!opportunity?.eligible) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profile.phone || null, tier: profile.tier || null },
          status: 'skipped',
          reason: opportunity?.reason || 'not_eligible',
          matchedContact,
        });
        continue;
      }

      const profilePhone = asText(profile.phone);
      if (!profilePhone) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: null, tier: profile.tier || null },
          status: 'skipped',
          reason: 'missing_profile_phone',
          matchedContact,
        });
        continue;
      }

      const session = getOrCreateSmsSession(profile);
      const pending = session.pendingUpgradeOffer;
      if (
        pending &&
        !isPendingOfferExpired(pending) &&
        pending.appointmentId &&
        pending.appointmentId === opportunity.appointmentId
      ) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'offer_already_pending',
          sessionId: session.id,
          appointmentId: opportunity.appointmentId || null,
          matchedContact,
        });
        continue;
      }

      const offerMessage = buildOutboundOfferMessage(opportunity);
      if (!offerMessage) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'offer_message_unavailable',
          sessionId: session.id,
          matchedContact,
        });
        continue;
      }

      session.pendingUpgradeOffer = {
        appointmentId: opportunity.appointmentId || null,
        targetDurationMinutes: opportunity.targetDurationMinutes || null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + OFFER_WINDOW_MINUTES * 60 * 1000).toISOString(),
      };

      if (sentCount >= maxSends) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'max_sends_reached',
          sessionId: session.id,
          appointmentId: opportunity.appointmentId || null,
          matchedContact,
        });
        continue;
      }

      if (dryRun) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'dry_run',
          sessionId: session.id,
          appointmentId: opportunity.appointmentId || null,
          targetDurationMinutes: opportunity.targetDurationMinutes || null,
          message: offerMessage,
          matchedContact,
        });
        continue;
      }

      try {
        const sms = await sendTwilioSms({
          to: profilePhone,
          body: offerMessage,
          from: fromNumber || undefined,
          statusCallback: statusCallback || undefined,
        });
        sentCount += 1;
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'sent',
          sessionId: session.id,
          appointmentId: opportunity.appointmentId || null,
          targetDurationMinutes: opportunity.targetDurationMinutes || null,
          twilioSid: sms?.sid || null,
          matchedContact,
        });
      } catch (err) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'error',
          sessionId: session.id,
          appointmentId: opportunity.appointmentId || null,
          reason: err?.message || 'twilio_send_failed',
          matchedContact,
        });
      }
    }

    const summary = results.reduce((acc, row) => {
      acc.total += 1;
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, { total: 0 });

    return NextResponse.json({
      ok: true,
      dryRun,
      sendWindow: {
        enforced: enforceSendWindow,
        allowed: sendWindow.allowed,
        timeZone: sendWindow.timeZone,
        hour: sendWindow.hour,
        startHour: sendWindow.startHour,
        endHour: sendWindow.endHour,
      },
      summary,
      results,
    });
  } catch (err) {
    console.error('Pre-appointment automation error:', err);
    return NextResponse.json(
      { error: 'Internal error while running pre-appointment automation.' },
      { status: 500 },
    );
  }
}

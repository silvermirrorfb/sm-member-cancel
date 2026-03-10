import { NextResponse } from 'next/server';
import { createSession, getSession } from '../../../../../lib/sessions';
import { buildSystemPromptWithProfile } from '../../../../../lib/claude';
import {
  evaluateUpgradeOpportunityForProfile,
  formatProfileForPrompt,
  lookupMember,
  resolveBoulevardLocationInput,
} from '../../../../../lib/boulevard';
import {
  bindPhoneToSession,
  getSessionIdForPhone,
  getUpgradeOfferState,
  markUpgradeOfferEvent,
} from '../../../../../lib/sms-sessions';
import { sendTwilioSms } from '../../../../../lib/twilio';
import {
  getNextWindowStartIso,
  getTimePartsInZone,
  isWithinSendWindow,
  parseHour,
} from '../../../../../lib/sms-window';
import {
  enqueueOutboundCandidate,
  getOutboundQueueSnapshot,
  popDueCandidates,
} from '../../../../../lib/sms-outbound-queue';
import { checkKlaviyoSmsOptIn } from '../../../../../lib/klaviyo';

const OFFER_WINDOW_MINUTES = Number(process.env.YES_RESPONSE_WINDOW_MIN || 10);
const ADDON_CATALOG = {
  hydradermabrasion: { code: 'hydradermabrasion', name: 'Hydradermabrasion', memberPrice: 76, walkinPrice: 95 },
  dermaplaning: { code: 'dermaplaning', name: 'Dermaplaning', memberPrice: 76, walkinPrice: 95 },
  custom_jelly_mask: { code: 'custom_jelly_mask', name: 'Custom Jelly Mask', memberPrice: 40, walkinPrice: 50 },
  eye_puff_minimizer: { code: 'eye_puff_minimizer', name: 'Eye Puff Minimizer', memberPrice: 40, walkinPrice: 50 },
  extra_extractions: { code: 'extra_extractions', name: 'Extra Extractions', memberPrice: 20, walkinPrice: 25 },
};
const ADDON_CODE_ALIASES = {
  hydradermabrasion: 'hydradermabrasion',
  hydra: 'hydradermabrasion',
  dermaplaning: 'dermaplaning',
  jellymask: 'custom_jelly_mask',
  customjellymask: 'custom_jelly_mask',
  custom_jelly_mask: 'custom_jelly_mask',
  eyepuff: 'eye_puff_minimizer',
  eyepuffminimizer: 'eye_puff_minimizer',
  eye_puff_minimizer: 'eye_puff_minimizer',
  extractions: 'extra_extractions',
  extra_extractions: 'extra_extractions',
};

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

function asBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function normalizeOfferType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'addon') return 'addon';
  if (raw === 'auto') return 'auto';
  return 'duration';
}

function normalizeAddonCode(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!raw) return '';
  return ADDON_CODE_ALIASES[raw] || raw;
}

function isAddonFallbackReason(opportunity) {
  if (!opportunity || opportunity.eligible) return false;
  const reason = String(opportunity.reason || '').toLowerCase();
  if (!opportunity.appointmentId || !opportunity.startOn) return false;
  return [
    'insufficient_gap',
    'already_at_or_above_target_duration',
    'no_upgrade_target_for_duration',
  ].includes(reason);
}

function pickDefaultAddonCode(opportunity) {
  const currentDuration = Number(opportunity?.currentDurationMinutes || 0);
  if (currentDuration > 30) return 'custom_jelly_mask';
  return 'hydradermabrasion';
}

function buildAddonOffer(profile, opportunity, options = {}) {
  const requestedCode = normalizeAddonCode(options.addOnCode || '');
  const selectedCode = requestedCode || pickDefaultAddonCode(opportunity);
  const addon = ADDON_CATALOG[selectedCode];
  if (!addon) return null;
  if (!opportunity?.appointmentId || !opportunity?.startOn) return null;

  const isMember = typeof opportunity?.isMember === 'boolean'
    ? opportunity.isMember
    : Boolean(profile?.tier) && !/inactive|cancel/i.test(String(profile?.accountStatus || '').toLowerCase());
  return {
    offerKind: 'addon',
    appointmentId: opportunity.appointmentId || null,
    startOn: opportunity.startOn || null,
    currentDurationMinutes: Number(opportunity?.currentDurationMinutes || 0) || null,
    isMember,
    addOnCode: addon.code,
    addOnName: addon.name,
    pricing: {
      memberPrice: addon.memberPrice,
      walkinPrice: addon.walkinPrice,
      offeredPrice: isMember ? addon.memberPrice : addon.walkinPrice,
    },
  };
}

function isPendingOfferExpired(offer) {
  if (!offer?.expiresAt) return true;
  const expires = new Date(offer.expiresAt).getTime();
  return !Number.isFinite(expires) || Date.now() > expires;
}

function formatTimeForGuest(iso, timeZone = 'America/New_York') {
  if (!iso) return 'your upcoming appointment';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'your upcoming appointment';
  return d.toLocaleString('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}

function buildDurationOfferMessage(opportunity, options = {}) {
  if (!opportunity?.pricing) return null;
  const reminder = options.reminder === true;
  const isMember = opportunity.isMember === true;
  const pricing = opportunity.pricing;
  const total = isMember ? pricing.memberTotal : pricing.walkinTotal;
  const delta = isMember ? pricing.memberDelta : pricing.walkinDelta;
  const currentDuration = opportunity.currentDurationMinutes;
  const targetDuration = opportunity.targetDurationMinutes;
  const timeText = formatTimeForGuest(opportunity.startOn, options.timeZone || 'America/New_York');
  const opener = reminder
    ? `Silver Mirror reminder: room is still open after your ${timeText} appointment.`
    : `Silver Mirror: room is open after your ${timeText} appointment.`;
  const priceLine = isMember
    ? `Member upgrade ${currentDuration}->${targetDuration} is +$${delta} ($${total} total).`
    : `Non-member upgrade ${currentDuration}->${targetDuration} is +$${delta} ($${total} total).`;
  return `${opener} ${priceLine} Reply YES in ${OFFER_WINDOW_MINUTES} min or NO.`;
}

function buildAddonOfferMessage(offer, options = {}) {
  if (!offer?.pricing || !offer?.addOnName) return null;
  const reminder = options.reminder === true;
  const isMember = offer.isMember === true;
  const timeText = formatTimeForGuest(offer.startOn, options.timeZone || 'America/New_York');
  const opener = reminder
    ? `Silver Mirror reminder: add-on opening for your ${timeText} facial.`
    : `Silver Mirror: add-on opening for your ${timeText} facial.`;
  const priceLine = isMember
    ? `${offer.addOnName} is $${offer.pricing.memberPrice} member.`
    : `${offer.addOnName} is $${offer.pricing.walkinPrice} non-member.`;
  return `${opener} ${priceLine} Reply YES in ${OFFER_WINDOW_MINUTES} min or NO.`;
}

function buildOutboundOfferMessage(offer, options = {}) {
  if (!offer) return null;
  if (offer.offerKind === 'addon') return buildAddonOfferMessage(offer, options);
  return buildDurationOfferMessage(offer, options);
}

function isSameLocalDay(aIso, bIso, timeZone) {
  const a = getTimePartsInZone(aIso, timeZone);
  const b = getTimePartsInZone(bIso, timeZone);
  if (!a || !b) return false;
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function resolveOfferTiming({
  startOn,
  runNow,
  sendTimezone,
  sendStartHour,
  sendEndHour,
  reminderLeadMinutes,
  reminderToleranceMinutes,
}) {
  const startMs = new Date(startOn || '').getTime();
  const nowMs = new Date(runNow || Date.now()).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) {
    return { isReminderWindow: false, reminderMode: null, minutesUntilStart: null };
  }

  const minutesUntilStart = Math.round((startMs - nowMs) / (60 * 1000));
  const minLead = Math.max(1, reminderLeadMinutes - reminderToleranceMinutes);
  const maxLead = reminderLeadMinutes + reminderToleranceMinutes;
  const scheduledReminderWindow = minutesUntilStart >= minLead && minutesUntilStart <= maxLead;
  if (scheduledReminderWindow) {
    return { isReminderWindow: true, reminderMode: 'scheduled', minutesUntilStart };
  }

  const oneHourMark = new Date(startMs - reminderLeadMinutes * 60 * 1000).toISOString();
  const oneHourMarkInWindow = isWithinSendWindow(oneHourMark, {
    timeZone: sendTimezone,
    startHour: sendStartHour,
    endHour: sendEndHour,
  }).allowed;
  const nowParts = getTimePartsInZone(runNow, sendTimezone);
  const finalSendHour = (sendEndHour + 23) % 24;
  const lastCallWindow =
    !oneHourMarkInWindow &&
    isSameLocalDay(startOn, runNow, sendTimezone) &&
    nowParts?.hour === finalSendHour &&
    minutesUntilStart > reminderLeadMinutes;
  if (lastCallWindow) {
    return { isReminderWindow: true, reminderMode: 'last_call_before_close', minutesUntilStart };
  }

  return { isReminderWindow: false, reminderMode: null, minutesUntilStart };
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
    const fallbackLocationInput = asText(body.locationId) || null;
    const fallbackLocationId = resolveBoulevardLocationInput(fallbackLocationInput).locationId || null;
    const targetDurationMinutes = asInt(body.targetDurationMinutes, null);
    const defaultOfferType = normalizeOfferType(body.offerType);
    const defaultAddOnCode = normalizeAddonCode(body.addOnCode);
    const maxSends = Math.max(1, asInt(body.maxSends, 50));
    const fromNumber = asText(body.fromNumber) || null;
    const statusCallback = asText(body.statusCallback) || null;
    const sendTimezone = asText(body.sendTimezone) || process.env.SMS_OUTBOUND_TIMEZONE || 'America/New_York';
    const sendStartHour = parseHour(body.sendStartHour, parseHour(process.env.SMS_OUTBOUND_START_HOUR, 9));
    const sendEndHour = parseHour(body.sendEndHour, parseHour(process.env.SMS_OUTBOUND_END_HOUR, 17));
    const enforceSendWindow = body.enforceSendWindow !== false;
    const queueWhenOutsideWindow = asBool(body.queueWhenOutsideWindow, true);
    const processQueued = asBool(body.processQueued, true);
    const useQueuedOnly = asBool(body.useQueuedOnly, false);
    const maxQueueDrain = Math.max(0, asInt(body.maxQueueDrain, maxSends));
    const requireManualLiveApproval = asBool(
      process.env.SMS_REQUIRE_MANUAL_LIVE_APPROVAL,
      true,
    );
    const liveApproval = asBool(body.liveApproval, false);
    const enforceKlaviyoOptIn = asBool(
      body.enforceKlaviyoOptIn,
      asBool(process.env.SMS_REQUIRE_KLAVIYO_OPT_IN, true),
    );
    const enableOneHourReminder = asBool(
      body.enableOneHourReminder,
      asBool(process.env.SMS_ENABLE_ONE_HOUR_REMINDER, true),
    );
    const reminderLeadMinutes = Math.max(
      15,
      asInt(body.reminderLeadMinutes, asInt(process.env.SMS_REMINDER_LEAD_MINUTES, 60)),
    );
    const reminderToleranceMinutes = Math.max(
      0,
      asInt(body.reminderToleranceMinutes, asInt(process.env.SMS_REMINDER_TOLERANCE_MINUTES, 15)),
    );
    const enableAddonFallback = asBool(
      body.enableAddonFallback,
      asBool(process.env.SMS_ENABLE_ADDON_FALLBACK, true),
    );
    const directCandidates = useQueuedOnly ? [] : resolveCandidates(body);

    const results = [];
    let sentCount = 0;
    const sendWindow = isWithinSendWindow(runNow, {
      timeZone: sendTimezone,
      startHour: sendStartHour,
      endHour: sendEndHour,
    });

    if (!dryRun && requireManualLiveApproval && !liveApproval) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Live outbound SMS is locked pending manual approval.',
          hint: 'Use dryRun=true, or set liveApproval=true after explicit approval.',
        },
        { status: 403 },
      );
    }

    if (enforceSendWindow && !sendWindow.allowed) {
      const runAfter = getNextWindowStartIso(runNow, {
        timeZone: sendTimezone,
        startHour: sendStartHour,
        endHour: sendEndHour,
      }) || new Date().toISOString();

      for (const candidate of directCandidates) {
        const queuedCandidate = {
          firstName: asText(candidate.firstName),
          lastName: asText(candidate.lastName),
          email: asText(candidate.email).toLowerCase(),
          phone: asText(candidate.phone),
          appointmentId: asText(candidate.appointmentId),
          targetDurationMinutes: asInt(candidate.targetDurationMinutes, null),
          offerType: normalizeOfferType(candidate.offerType || defaultOfferType),
          addOnCode: normalizeAddonCode(candidate.addOnCode || defaultAddOnCode),
          enableAddonFallback: asBool(candidate.enableAddonFallback, enableAddonFallback),
          locationId: asText(candidate.locationId),
        };
        if (!queuedCandidate.firstName || !queuedCandidate.lastName || (!queuedCandidate.email && !queuedCandidate.phone)) {
          results.push({
            candidate: {
              firstName: queuedCandidate.firstName || null,
              lastName: queuedCandidate.lastName || null,
              email: queuedCandidate.email || null,
              phone: queuedCandidate.phone || null,
            },
            status: 'skipped',
            reason: 'missing_candidate_fields',
          });
          continue;
        }

        if (queueWhenOutsideWindow) {
          const queued = enqueueOutboundCandidate(
            {
              candidate: queuedCandidate,
              options: {
                windowHours,
                fallbackLocationId,
                targetDurationMinutes,
                offerType: defaultOfferType,
                addOnCode: defaultAddOnCode || null,
                enableAddonFallback,
                fromNumber,
                statusCallback,
              },
            },
            { runAfter },
          );
          results.push({
            candidate: {
              firstName: queuedCandidate.firstName,
              lastName: queuedCandidate.lastName,
              email: queuedCandidate.email || null,
              phone: queuedCandidate.phone || null,
            },
            status: 'queued',
            reason: 'queued_outside_send_window',
            queueId: queued.id,
            runAfter: queued.runAfter,
            deduped: queued.deduped === true,
          });
        } else {
          results.push({
            candidate: {
              firstName: queuedCandidate.firstName,
              lastName: queuedCandidate.lastName,
              email: queuedCandidate.email || null,
              phone: queuedCandidate.phone || null,
            },
            status: 'skipped',
            reason: 'outside_send_window',
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
          enforced: true,
          allowed: false,
          timeZone: sendWindow.timeZone,
          hour: sendWindow.hour,
          startHour: sendWindow.startHour,
          endHour: sendWindow.endHour,
        },
        queue: getOutboundQueueSnapshot(),
        summary,
        results,
      });
    }

    const queuedItems = processQueued
      ? popDueCandidates({ now: runNow, limit: maxQueueDrain > 0 ? maxQueueDrain : maxSends })
      : [];
    const queuedCandidates = queuedItems.map(row => ({
      source: 'queued',
      queueId: row.id,
      candidate: row.payload?.candidate || {},
      queuedOptions: row.payload?.options || {},
    }));
    const directWorkItems = directCandidates.map(candidate => ({
      source: 'direct',
      queueId: null,
      candidate,
      queuedOptions: {},
    }));
    const workItems = useQueuedOnly
      ? queuedCandidates
      : [...directWorkItems, ...queuedCandidates];

    if (workItems.length === 0) {
      if (directCandidates.length === 0 && queuedCandidates.length === 0) {
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
          queue: getOutboundQueueSnapshot(),
          summary: { total: 0 },
          results: [],
        });
      }
      return NextResponse.json(
        { error: 'Provide candidates[] or use useQueuedOnly/processQueued with queued work available.' },
        { status: 400 },
      );
    }

    for (const work of workItems) {
      const candidate = work.candidate || {};
      const queuedOptions = work.queuedOptions || {};
      const firstName = asText(candidate.firstName);
      const lastName = asText(candidate.lastName);
      const email = asText(candidate.email).toLowerCase();
      const phone = asText(candidate.phone);
      const fullName = `${firstName} ${lastName}`.trim();
      const effectiveWindowHours = asInt(candidate.windowHours, asInt(queuedOptions.windowHours, windowHours));
      const effectiveFallbackLocationInput =
        asText(candidate.locationId) ||
        asText(queuedOptions.fallbackLocationId) ||
        fallbackLocationInput ||
        '';
      const effectiveFallbackLocationId = resolveBoulevardLocationInput(effectiveFallbackLocationInput).locationId
        || fallbackLocationId
        || null;
      const effectiveTargetDurationMinutes = asInt(
        candidate.targetDurationMinutes,
        asInt(queuedOptions.targetDurationMinutes, targetDurationMinutes),
      );
      const effectiveOfferType = normalizeOfferType(
        asText(candidate.offerType) || asText(queuedOptions.offerType) || defaultOfferType,
      );
      const effectiveAddOnCode = normalizeAddonCode(
        asText(candidate.addOnCode) || asText(queuedOptions.addOnCode) || defaultAddOnCode,
      );
      const effectiveEnableAddonFallback = asBool(
        candidate.enableAddonFallback,
        asBool(queuedOptions.enableAddonFallback, enableAddonFallback),
      );
      const effectiveFromNumber = asText(candidate.fromNumber) || asText(queuedOptions.fromNumber) || fromNumber || null;
      const effectiveStatusCallback =
        asText(candidate.statusCallback) || asText(queuedOptions.statusCallback) || statusCallback || null;
      const contacts = [];
      if (email) contacts.push(email);
      if (phone) contacts.push(phone);

      if (!firstName || !lastName || contacts.length === 0) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          status: 'skipped',
          reason: 'missing_candidate_fields',
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }

      let profile = null;
      let matchedContact = null;
      for (const contact of contacts) {
        profile = await lookupMember(fullName, contact, {
          preferLocationId: effectiveFallbackLocationId || undefined,
        });
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
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }

      const opportunity = await evaluateUpgradeOpportunityForProfile(profile, {
        appointmentId: asText(candidate.appointmentId) || undefined,
        targetDurationMinutes: effectiveTargetDurationMinutes || undefined,
        locationId: effectiveFallbackLocationId || undefined,
        now: now || undefined,
        windowHours: effectiveWindowHours || undefined,
      });

      let selectedOffer = null;
      if (effectiveOfferType === 'addon') {
        selectedOffer = buildAddonOffer(profile, opportunity, { addOnCode: effectiveAddOnCode });
      } else if (effectiveOfferType === 'auto') {
        if (opportunity?.eligible) {
          selectedOffer = { offerKind: 'duration', ...opportunity };
        } else if (effectiveEnableAddonFallback && isAddonFallbackReason(opportunity)) {
          selectedOffer = buildAddonOffer(profile, opportunity, { addOnCode: effectiveAddOnCode });
        }
      } else if (opportunity?.eligible) {
        selectedOffer = { offerKind: 'duration', ...opportunity };
      } else if (effectiveEnableAddonFallback && isAddonFallbackReason(opportunity)) {
        selectedOffer = buildAddonOffer(profile, opportunity, { addOnCode: effectiveAddOnCode });
      }

      if (!selectedOffer) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profile.phone || null, tier: profile.tier || null },
          status: 'skipped',
          reason: effectiveOfferType === 'addon'
            ? 'addon_offer_unavailable'
            : (opportunity?.reason || 'not_eligible'),
          matchedContact,
          source: work.source,
          queueId: work.queueId,
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
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }

      const session = getOrCreateSmsSession(profile);
      const appointmentId = selectedOffer.appointmentId || null;
      const offerState = appointmentId ? getUpgradeOfferState(profilePhone, appointmentId) : null;
      if (offerState?.upgradedAt || offerState?.acceptedAt) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'already_upgraded',
          appointmentId,
          matchedContact,
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }
      if (offerState?.declinedAt) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'offer_declined',
          appointmentId,
          matchedContact,
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }

      let klaviyoGate = {
        allowed: true,
        reason: null,
      };
      if (enforceKlaviyoOptIn) {
        klaviyoGate = await checkKlaviyoSmsOptIn({
          phone: profilePhone,
          email: profile.email || email || null,
        });
      }
      if (!klaviyoGate.allowed) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: klaviyoGate.reason || 'klaviyo_sms_not_subscribed',
          matchedContact,
          source: work.source,
          queueId: work.queueId,
          klaviyo: {
            matchedBy: klaviyoGate.matchedBy || null,
            profileId: klaviyoGate.profileId || null,
            consent: klaviyoGate.consent || null,
            canReceiveSmsMarketing: klaviyoGate.canReceiveSmsMarketing ?? null,
            method: klaviyoGate.method || null,
            consentTimestamp: klaviyoGate.consentTimestamp || null,
            lastUpdated: klaviyoGate.lastUpdated || null,
          },
        });
        continue;
      }

      const pending = session.pendingUpgradeOffer;
      const hasPendingForAppointment =
        pending &&
        !isPendingOfferExpired(pending) &&
        pending.appointmentId &&
        pending.appointmentId === appointmentId;
      const timing = resolveOfferTiming({
        startOn: selectedOffer.startOn,
        runNow,
        sendTimezone,
        sendStartHour,
        sendEndHour,
        reminderLeadMinutes,
        reminderToleranceMinutes,
      });
      const hasPriorOffer = Boolean(offerState?.initialSentAt || hasPendingForAppointment);
      const shouldUseReminder = enableOneHourReminder && timing.isReminderWindow && hasPriorOffer;
      const offerType = shouldUseReminder ? 'reminder' : 'initial';

      if (offerType === 'initial' && hasPendingForAppointment) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'offer_already_pending',
          sessionId: session.id,
          appointmentId,
          matchedContact,
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }
      if (offerType === 'initial' && offerState?.initialSentAt) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'offer_already_sent',
          sessionId: session.id,
          appointmentId,
          matchedContact,
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }
      if (offerType === 'reminder' && offerState?.reminderSentAt) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'reminder_already_sent',
          sessionId: session.id,
          appointmentId,
          matchedContact,
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }

      const offerMessage = buildOutboundOfferMessage(selectedOffer, {
        reminder: offerType === 'reminder',
        timeZone: sendTimezone,
      });
      if (!offerMessage) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'offer_message_unavailable',
          sessionId: session.id,
          matchedContact,
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }

      if (sentCount >= maxSends) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'max_sends_reached',
          sessionId: session.id,
          appointmentId,
          matchedContact,
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }

      if (dryRun) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'dry_run',
          sessionId: session.id,
          appointmentId,
          offerKind: selectedOffer.offerKind || 'duration',
          targetDurationMinutes: selectedOffer.targetDurationMinutes || null,
          addOnCode: selectedOffer.addOnCode || null,
          addOnName: selectedOffer.addOnName || null,
          offerType,
          reminderMode: offerType === 'reminder' ? timing.reminderMode : null,
          minutesUntilStart: timing.minutesUntilStart,
          message: offerMessage,
          matchedContact,
          source: work.source,
          queueId: work.queueId,
          klaviyo: {
            matchedBy: klaviyoGate.matchedBy || null,
            profileId: klaviyoGate.profileId || null,
            consent: klaviyoGate.consent || null,
            canReceiveSmsMarketing: klaviyoGate.canReceiveSmsMarketing ?? null,
          },
        });
        continue;
      }

      try {
        const sms = await sendTwilioSms({
          to: profilePhone,
          body: offerMessage,
          from: effectiveFromNumber || undefined,
          statusCallback: effectiveStatusCallback || undefined,
        });
        if (appointmentId) {
          markUpgradeOfferEvent(profilePhone, appointmentId, offerType === 'reminder' ? 'reminder_sent' : 'initial_sent');
        }
        const nowIso = new Date().toISOString();
        session.pendingUpgradeOffer = {
          offerKind: selectedOffer.offerKind || 'duration',
          appointmentId,
          currentDurationMinutes: selectedOffer.currentDurationMinutes || null,
          targetDurationMinutes: selectedOffer.targetDurationMinutes || null,
          addOnCode: selectedOffer.addOnCode || null,
          addOnName: selectedOffer.addOnName || null,
          isMember: selectedOffer.isMember === true,
          pricing: selectedOffer.pricing || null,
          createdAt: pending?.createdAt || nowIso,
          expiresAt: new Date(Date.now() + OFFER_WINDOW_MINUTES * 60 * 1000).toISOString(),
          reminderSentAt: offerType === 'reminder' ? nowIso : pending?.reminderSentAt || null,
        };
        sentCount += 1;
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'sent',
          sessionId: session.id,
          appointmentId,
          offerKind: selectedOffer.offerKind || 'duration',
          targetDurationMinutes: selectedOffer.targetDurationMinutes || null,
          addOnCode: selectedOffer.addOnCode || null,
          addOnName: selectedOffer.addOnName || null,
          offerType,
          reminderMode: offerType === 'reminder' ? timing.reminderMode : null,
          minutesUntilStart: timing.minutesUntilStart,
          twilioSid: sms?.sid || null,
          matchedContact,
          source: work.source,
          queueId: work.queueId,
          klaviyo: {
            matchedBy: klaviyoGate.matchedBy || null,
            profileId: klaviyoGate.profileId || null,
            consent: klaviyoGate.consent || null,
            canReceiveSmsMarketing: klaviyoGate.canReceiveSmsMarketing ?? null,
          },
        });
      } catch (err) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'error',
          sessionId: session.id,
          appointmentId,
          reason: err?.message || 'twilio_send_failed',
          matchedContact,
          source: work.source,
          queueId: work.queueId,
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
      queue: getOutboundQueueSnapshot(),
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

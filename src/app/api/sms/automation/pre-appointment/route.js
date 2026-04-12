export const maxDuration = 300;
import { NextResponse } from 'next/server';
import { createSession, getSession, saveSession } from '../../../../../lib/sessions';
import { buildSystemPromptWithProfile } from '../../../../../lib/claude';
import {
  evaluateUpgradeOpportunityForProfile,
  formatProfileForPrompt,
  getBoulevardAuthContext,
  lookupMember,
  resolveBoulevardLocationInput,
  scanAppointments,
} from '../../../../../lib/boulevard';
import { logSmsChatMessages } from '../../../../../lib/notify';
import {
  bindPhoneToSession,
  getSessionIdForPhone,
  getUpgradeOfferState,
  getUpsellCooldown,
  markUpsellInitialSent,
  markUpgradeOfferEvent,
} from '../../../../../lib/sms-sessions';
import { sendTwilioSms, trimSmsBodyShort } from '../../../../../lib/twilio';
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
import {
  SMS_UPGRADE_PENDING_REASON,
  buildSmsUpgradePendingReply,
  isSmsUpgradeLive,
} from '../../../../../lib/sms-upgrade-policy';

const OFFER_WINDOW_MINUTES = Number(process.env.YES_RESPONSE_WINDOW_MIN || 15);
const REMINDER_YES_WINDOW_MINUTES = Number(process.env.YES_RESPONSE_WINDOW_REMINDER_MIN || 10);
const ADDON_MIN_GAP_MINUTES = Number(process.env.SMS_ADDON_MIN_GAP_MINUTES || 5);
const DEFAULT_DISCOVERY_WINDOW_HOURS = Number(process.env.SMS_DISCOVERY_WINDOW_HOURS || 6);
const ADDON_CATALOG = {
  antioxidant_peel: { code: 'antioxidant_peel', name: 'Antioxidant Peel', memberPrice: 40, walkinPrice: 50 },
  neck_firming: { code: 'neck_firming', name: 'Neck Firming', memberPrice: 20, walkinPrice: 25 },
  eye_puff_minimizer: { code: 'eye_puff_minimizer', name: 'Eye Puff Minimizer', memberPrice: 40, walkinPrice: 50 },
  lip_plump_and_scrub: { code: 'lip_plump_and_scrub', name: 'Lip Plump and Scrub', memberPrice: 28, walkinPrice: 35 },
};
const ADDON_PRIORITY_50_MIN = [
  'antioxidant_peel',
  'neck_firming',
  'eye_puff_minimizer',
  'lip_plump_and_scrub',
];
const ADDON_CODE_ALIASES = {
  antioxidant: 'antioxidant_peel',
  antioxidant_peel: 'antioxidant_peel',
  peel: 'antioxidant_peel',
  neck: 'neck_firming',
  neck_firming: 'neck_firming',
  eyepuff: 'eye_puff_minimizer',
  eyepuffminimizer: 'eye_puff_minimizer',
  eye_puff_minimizer: 'eye_puff_minimizer',
  lip: 'lip_plump_and_scrub',
  lip_plump: 'lip_plump_and_scrub',
  lip_plump_and_scrub: 'lip_plump_and_scrub',
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
  return 'auto';
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

function isSmsDurationOfferAllowed(opportunity) {
  const target = Number(opportunity?.targetDurationMinutes || 0) || null;
  return !target || target <= 50;
}

function buildAddonOffer(profile, opportunity, options = {}) {
  const currentDuration = Number(opportunity?.currentDurationMinutes || 0) || null;
  const availableGapMinutes = Number(opportunity?.availableGapMinutes);
  const gapUnlimited = opportunity?.gapUnlimited === true;
  const hasAddonOnBooking = opportunity?.hasAddonOnBooking === true;
  if (currentDuration !== 50) return null;
  if (hasAddonOnBooking) return null;
  if (!gapUnlimited && (!Number.isFinite(availableGapMinutes) || availableGapMinutes < ADDON_MIN_GAP_MINUTES)) return null;

  const requestedCode = normalizeAddonCode(options.addOnCode || '');
  const fallbackCode = requestedCode || ADDON_PRIORITY_50_MIN.find(code => Boolean(ADDON_CATALOG[code]));
  const addon = fallbackCode ? ADDON_CATALOG[fallbackCode] : null;
  if (!addon) return null;
  if (!opportunity?.appointmentId || !opportunity?.startOn) return null;

  const isMember = typeof opportunity?.isMember === 'boolean'
    ? opportunity.isMember
    : Boolean(profile?.tier) && !/inactive|cancel/i.test(String(profile?.accountStatus || '').toLowerCase());
  return {
    offerKind: 'addon',
    appointmentId: opportunity.appointmentId || null,
    startOn: opportunity.startOn || null,
    currentDurationMinutes: currentDuration,
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

function buildDurationOfferMessage(opportunity, options = {}) {
  if (!opportunity?.pricing) return null;
  const reminder = options.reminder === true;
  const firstName = asText(options.firstName);
  const pricing = opportunity.pricing;
  const delta = Number(pricing.walkinDelta || 50);
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  if (reminder) {
    return `${greeting} just a reminder - the upgrade to 50 minutes is still available for your appointment today. Reply YES or NO.`;
  }
  return `${greeting} good news - there's room to extend your facial today to 50 minutes for just $${delta} more. Reply YES to upgrade or NO to keep your current booking.`;
}

function buildAddonOfferMessage(offer, options = {}) {
  if (!offer?.pricing || !offer?.addOnName) return null;
  const reminder = options.reminder === true;
  const firstName = asText(options.firstName);
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const price = Number(offer?.pricing?.walkinPrice || 0);
  if (reminder) {
    return `${greeting} still time to add ${offer.addOnName} to today's facial. Reply YES or NO.`;
  }
  return `${greeting} we can add ${offer.addOnName} to your facial today for $${price} (members save 20%). Reply YES to add it or NO to skip.`;
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

function normalizeCandidateDedupKey(candidate) {
  const clientId = asText(candidate?.clientId);
  const phone = asText(candidate?.phone).replace(/\D/g, '');
  const email = asText(candidate?.email).toLowerCase();
  if (clientId) return `client:${clientId}`;
  if (phone) return `phone:${phone}`;
  if (email) return `email:${email}`;
  const fallbackName = `${asText(candidate?.firstName).toLowerCase()}|${asText(candidate?.lastName).toLowerCase()}`;
  return fallbackName ? `name:${fallbackName}` : '';
}

function toLocationCandidate(locationName, appointment) {
  return {
    firstName: asText(appointment?.clientFirstName),
    lastName: asText(appointment?.clientLastName),
    email: asText(appointment?.clientEmail).toLowerCase(),
    phone: asText(appointment?.clientPhone),
    clientId: asText(appointment?.clientId),
    appointmentId: asText(appointment?.id),
    locationId: asText(appointment?.locationId),
    locationName: asText(locationName) || asText(appointment?.locationName),
  };
}

async function getOrCreateSmsSession(profile) {
  const phone = asText(profile?.phone);
  let session = null;
  const existingId = phone ? getSessionIdForPhone(phone) : null;
  if (existingId) {
    const existing = await getSession(existingId);
    if (existing && existing.status === 'active') session = existing;
  }
  if (!session) {
    session = await createSession(profile?.clientId || null, profile || null);
  }

  session.memberId = profile?.clientId || session.memberId || null;
  session.memberProfile = profile || null;
  session.mode = 'membership';
  session.systemPrompt = buildSystemPromptWithProfile(formatProfileForPrompt(profile));
  session.status = 'active';
  session.lastActivity = new Date();
  if (phone) bindPhoneToSession(phone, session.id);
  await saveSession(session);
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
    const sendEndHour = parseHour(body.sendEndHour, parseHour(process.env.SMS_OUTBOUND_END_HOUR, 19));
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
    const locations = Array.isArray(body.locations)
      ? body.locations.map(item => asText(item)).filter(Boolean)
      : [];
    const discoveryWindowHours = Math.max(
      1,
      asInt(body.discoveryWindowHours, asInt(body.windowHours, DEFAULT_DISCOVERY_WINDOW_HOURS)),
    );
    const discoveredCandidates = [];
    if (!useQueuedOnly && locations.length > 0) {
      const auth = getBoulevardAuthContext();
      if (!auth) {
        return NextResponse.json(
          { error: 'Boulevard API credentials are not configured for location discovery.' },
          { status: 500 },
        );
      }
      const nowMs = new Date(runNow).getTime();
      const cutoffMs = nowMs + discoveryWindowHours * 60 * 60 * 1000;
      const dedup = new Set();
      for (const rawLocation of locations) {
        const location = resolveBoulevardLocationInput(rawLocation);
        const scan = await scanAppointments(auth.apiUrl, auth.headers, {
          locationId: location.locationId || rawLocation,
        });
        const appointments = Array.isArray(scan?.appointments) ? scan.appointments : [];
        for (const appointment of appointments) {
          const startMs = new Date(appointment?.startOn || '').getTime();
          if (!Number.isFinite(startMs) || startMs < nowMs || startMs > cutoffMs) continue;
          const candidate = toLocationCandidate(location.locationName || rawLocation, appointment);
          if (!candidate.firstName || !candidate.lastName || (!candidate.email && !candidate.phone)) continue;
          const dedupKey = normalizeCandidateDedupKey(candidate);
          if (!dedupKey || dedup.has(dedupKey)) continue;
          dedup.add(dedupKey);
          discoveredCandidates.push(candidate);
        }
      }
    }
    const allDirectCandidates = useQueuedOnly
      ? []
      : [...directCandidates, ...discoveredCandidates];

    const results = [];
    let sentCount = 0;
    const sendWindow = isWithinSendWindow(runNow, {
      timeZone: sendTimezone,
      startHour: sendStartHour,
      endHour: sendEndHour,
    });
    const smsUpgradeLive = isSmsUpgradeLive();

    if (!smsUpgradeLive) {
      const heldQueuedItems = processQueued
        ? popDueCandidates({ now: runNow, limit: maxQueueDrain > 0 ? maxQueueDrain : maxSends })
        : [];
      const heldQueuedCandidates = heldQueuedItems.map(row => ({
        source: 'queued',
        queueId: row.id,
        candidate: row.payload?.candidate || {},
      }));
      const heldDirectWorkItems = allDirectCandidates.map(candidate => ({
        source: 'direct',
        queueId: null,
        candidate,
      }));
      const heldWorkItems = useQueuedOnly
        ? heldQueuedCandidates
        : [...heldDirectWorkItems, ...heldQueuedCandidates];

      const upgradePendingReply = buildSmsUpgradePendingReply();
      for (const work of heldWorkItems) {
        const candidate = work.candidate || {};
        results.push({
          candidate: {
            firstName: asText(candidate.firstName) || null,
            lastName: asText(candidate.lastName) || null,
            email: asText(candidate.email).toLowerCase() || null,
            phone: asText(candidate.phone) || null,
          },
          status: 'skipped',
          reason: SMS_UPGRADE_PENDING_REASON,
          message: upgradePendingReply,
          source: work.source,
          queueId: work.queueId,
        });
      }

      const summary = results.reduce((acc, row) => {
        acc.total += 1;
        acc[row.status] = (acc[row.status] || 0) + 1;
        return acc;
      }, { total: 0 });

      return NextResponse.json({
        ok: true,
        dryRun,
        upgradeStatus: 'pending',
        upgradeMessage: upgradePendingReply,
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
    }

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

      for (const candidate of allDirectCandidates) {
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
    const directWorkItems = allDirectCandidates.map(candidate => ({
      source: 'direct',
      queueId: null,
      candidate,
      queuedOptions: {},
    }));
    const workItems = useQueuedOnly
      ? queuedCandidates
      : [...directWorkItems, ...queuedCandidates];

    if (workItems.length === 0) {
      if (allDirectCandidates.length === 0 && queuedCandidates.length === 0) {
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
        if (opportunity?.eligible && isSmsDurationOfferAllowed(opportunity)) {
          selectedOffer = { offerKind: 'duration', ...opportunity };
        } else if (
          effectiveEnableAddonFallback &&
          (isAddonFallbackReason(opportunity) || (opportunity?.eligible && !isSmsDurationOfferAllowed(opportunity)))
        ) {
          selectedOffer = buildAddonOffer(profile, opportunity, { addOnCode: effectiveAddOnCode });
        }
      } else if (opportunity?.eligible && isSmsDurationOfferAllowed(opportunity)) {
        selectedOffer = { offerKind: 'duration', ...opportunity };
      } else if (effectiveEnableAddonFallback && isAddonFallbackReason(opportunity)) {
        selectedOffer = buildAddonOffer(profile, opportunity, { addOnCode: effectiveAddOnCode });
      }

      if (!selectedOffer) {
        const currentDuration = Number(opportunity?.currentDurationMinutes || 0) || null;
        const addonGap = Number(opportunity?.availableGapMinutes);
        const targetDurationBlocked = opportunity?.eligible && !isSmsDurationOfferAllowed(opportunity);
        const addonUnavailableReason = opportunity?.hasAddonOnBooking
          ? 'addon_already_on_booking'
          : (!opportunity?.gapUnlimited && Number.isFinite(addonGap) && addonGap < ADDON_MIN_GAP_MINUTES)
            ? 'insufficient_addon_gap'
            : 'addon_offer_unavailable';
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profile.phone || null, tier: profile.tier || null },
          status: 'skipped',
          reason: targetDurationBlocked
            ? 'sms_target_duration_blocked'
            : (effectiveOfferType === 'addon' || currentDuration === 50)
            ? addonUnavailableReason
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

      const session = await getOrCreateSmsSession(profile);
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
      const cooldown = getUpsellCooldown(profilePhone);
      const cooldownActive = cooldown?.cooldownActive === true;
      const sameAppointmentAsCooldown = Boolean(
        cooldown?.appointmentId &&
        appointmentId &&
        String(cooldown.appointmentId) === String(appointmentId),
      );
      if (offerType === 'initial' && !hasPriorOffer && cooldownActive && !sameAppointmentAsCooldown) {
        results.push({
          candidate: { firstName, lastName, email: email || null, phone: phone || null },
          profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
          status: 'skipped',
          reason: 'upsell_cooldown_4w',
          sessionId: session.id,
          appointmentId,
          matchedContact,
          source: work.source,
          queueId: work.queueId,
        });
        continue;
      }

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
        firstName,
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
          trimBody: trimSmsBodyShort,
          from: effectiveFromNumber || undefined,
          statusCallback: effectiveStatusCallback || undefined,
        });
        if (appointmentId) {
          markUpgradeOfferEvent(profilePhone, appointmentId, offerType === 'reminder' ? 'reminder_sent' : 'initial_sent');
          if (offerType === 'initial') markUpsellInitialSent(profilePhone, appointmentId);
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
        await saveSession(session);
        await logSmsChatMessages([{
          sessionId: session.id,
          timestamp: nowIso,
          direction: 'outbound',
          phone: profilePhone,
          memberName: fullName || profile?.name || null,
          location: profile?.locationName || candidate?.locationName || null,
          content: offerMessage,
          offerType: selectedOffer.offerKind || 'duration',
          outcome: offerType === 'reminder' ? 'reminder_sent' : 'initial_sent',
        }]);
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

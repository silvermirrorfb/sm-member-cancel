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
  sendTwilioSms,
  trimSmsBodyShort,
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
import { checkStopSetStrict, claimAppliedFollowupSend, lookupClientIdByPhoneFromIndex, maskPhoneDigits, normalizePhoneForIndex } from '../../../../../lib/sms-member-registry';
import { logSmsChatMessages, logSupportIncident, notifyUpgradeIncidentOnce, SMS_UPGRADE_INCIDENT_ISSUE_TYPE } from '../../../../../lib/notify';
import { POST as postChatMessage } from '../../../chat/message/route';

// The reply returns in milliseconds, but deferWork() (after()) keeps the
// function alive for the background apply, which may run a slow Boulevard scan
// plus the booking-edit apply. Give it headroom well beyond the deferred scan
// deadline so successful background applies are never cut short.
// 300, not 60: the TwiML reply returns in milliseconds, but deferWork()/after()
// only keeps the function alive until maxDuration, and the deferred YES apply
// (reverify + close/shift bound + collision gate + staff timeblock pagination +
// four Boulevard mutations) was killed at 60s in the 2026-07-21 live activation
// (Vercel Runtime Timeout, POST 504, Boulevard verified untouched). 300 matches
// the pre-appointment automation route's declared budget on this project.
export const maxDuration = 300;

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
          `[sms-webhook] phone-index stale: clientId ${indexed.clientId} phone ${profileKey ? `***${profileKey.slice(-4)}` : '(none)'} does not match inbound ***${fromKey.slice(-4)}, falling through to scan`,
        );
      }
    }
  } catch (err) {
    console.warn('[sms-webhook] phone-index lookup error:', maskPhoneDigits(err?.message || err));
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
// "please" is deliberately NOT a YES keyword (red team 2026-07-22): a bare
// courtesy word is not consent, and it made refusals like "please stop
// texting me" read affirmative. "yes please" still matches via "yes".
const YES_KEYWORDS = /\b(yes|yeah|yep|sure|ok|okay|do it|add it|upgrade|let's do it|sounds good|absolutely)\b/i;
// "no problem" / "no worries" are affirmative idioms, not refusals: without
// the lookahead, "No problem, do it" would classify as a decline now that
// negative wins ties (codex round-8).
const NO_KEYWORDS = /\b(no(?!\s+(?:problem|worries))|nah|no thanks|not today|pass|i'?m good(?!\s+with)|skip|decline)\b/i;
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
    .catch(err => console.error('[sms-webhook] deferred work failed:', maskPhoneDigits(err?.message || err)));
  try {
    after(() => run);
  } catch {
    // No request scope available (tests / non-Vercel runtime): the detached
    // `run` above still executes; nothing else to do.
  }
}

// UNAMBIGUOUS phrase-level opt-out REQUESTS get the full STOP treatment
// (suppression set + Klaviyo + unsubscribe confirmation), not just a decline
// (codex round-5 P1: an explicit revocation must be honored in any reasonable
// phrasing). Deliberately tighter than OPT_OUT_PHRASES: a bare "stop" inside
// a sentence ("stop by the front desk") must never unsubscribe anyone, so a
// stop verb only counts with a messaging object, and take-off/remove
// phrasings only count with a list or text object ("take me off the
// waitlist" and "remove me from tomorrow's appointment" are service
// requests, codex round-6). Negated consent statements ("I don't want to
// unsubscribe") are excluded by OPT_OUT_NEGATED below.
// Stop verbs need a messaging target: "stop texting/messaging" is
// intrinsically about texts, but "stop sending" and "stop contacting" only
// count with an SMS object or "me", so "stop sending receipts to my old
// email" stays a service request (codex round-9).
const OPT_OUT_REQUEST = /\b(?:stop|quit)\s+(?:texting|messaging)(?:\s+me)?\b|\b(?:stop|quit)\s+sending\s+(?:me\s+)?(?:texts?|messages?|sms)\b|\b(?:stop|quit)\s+contacting\s+me\b|\bdo\s*n[o']?t\s+(?:text|message)\s+me\b|\bunsubscribe\b|\bopt\s+(?:me\s+)?out\b|\btake me off\s+(?:your\s+|the\s+|this\s+)?(?:list|texts?|messages?|messaging)\b|\bremove me from\s+(?:your\s+|the\s+|this\s+)?(?:list|texts?|messages?|messaging)\b/i;
// Negation must be verb-attached ("don't/not/never" plus an optional intent
// verb directly before the opt-out phrase, optionally bridging "you to" so
// "I don't want you to stop texting me" negates, codex round-11). A leading
// standalone "No" is an answer, not negation: "No I want to unsubscribe" is
// an explicit opt-out (codex round-9), while "I'm not trying to
// unsubscribe" negates.
const OPT_OUT_NEGATED = /\b(?:do\s*n[o']?t|not|never)\s+(?:(?:want|wanna|trying|asking|looking|going)\s+(?:you\s+to\s+|to\s+)?)?(?:unsubscribe|opt\s+(?:me\s+)?out|(?:stop|quit)\s+(?:texting|messaging|sending|contacting))\b/i;
// Third-party mentions discuss another PERSON's consent ("unsubscribe my
// daughter", "my husband wants to unsubscribe") and must never mutate the
// SENDER's consent state; they go to chat (codex round-10). Bounded to
// person words: sender-owned objects like "my number" or "my phone" are the
// sender opting out (codex round-11), so the default stays opt-out.
const OPT_OUT_THIRD_PARTY = /\b(?:unsubscribe|opt\s+out)\s+(?:my|our|his|her|their)\s+(?:husband|wife|spouse|partner|boyfriend|girlfriend|daughter|son|kids?|child|children|mom|mother|dad|father|sister|brother|friend|grand\w+)\b|\b(?:unsubscribe|opt\s+out)\s+(?:him|her|them)\b|\b(?:my|our|his|her|their)\s+\w+\s+(?:wants?|needs?|would like|is trying)\s+to\s+(?:unsubscribe|opt\s+out)\b/i;
// Other-target requests ("unsubscribe me from email updates", "unsubscribe
// me from my membership") are not an SMS consent revocation; the chat bot
// handles them (codex rounds 11 and 12). Membership and appointment targets
// matter doubly here: cancellations are this bot's core job.
const OPT_OUT_OTHER_TARGET = /\b(?:unsubscribe|opt\s+(?:me\s+)?out)\b[^.!?,;]{0,40}\b(?:e-?mails?|newsletters?|mailing|memberships?|accounts?|appointments?|waitlist)\b/i;

// Phrase-level opt-outs are evaluated PER CLAUSE so an unrelated clause can
// never veto an explicit SMS opt-out clause ("Unsubscribe me from email,
// and stop texting me" opts out; codex round-12), and an SMS clause can
// never bless a non-SMS one.
function isPhraseLevelOptOut(text) {
  return normalizeApostrophes(text)
    .split(/[,.;!?]+/)
    .some(clause => OPT_OUT_REQUEST.test(clause)
      && !OPT_OUT_NEGATED.test(clause)
      && !OPT_OUT_THIRD_PARTY.test(clause)
      && !OPT_OUT_OTHER_TARGET.test(clause));
}

// iPhone keyboards send typographic apostrophes (U+2018/U+2019): normalize
// them to ASCII before any consent or intent matching so "Don't text me"
// with a smart apostrophe still opts out (codex round-8).
function normalizeApostrophes(text) {
  return String(text || '').replace(/[‘’]/g, "'");
}

function isAffirmative(text) {
  return YES_KEYWORDS.test(normalizeApostrophes(text).toLowerCase());
}

function isNegative(text) {
  const value = normalizeApostrophes(text).toLowerCase();
  // Refusal keywords are tested with negated verb chains stripped so "Yes,
  // don't skip it" and "Yes, I don't want to skip it" cannot read the raw
  // "skip" as a refusal (codex rounds 11 and 12). The chain strip runs
  // first (negator through a refusal word within 3 words), then bare
  // negator plus one verb. The "not" negator is deliberately NOT stripped:
  // "not today" is itself a refusal keyword.
  const refusalScope = value
    .replace(/\b(?:do\s*n[o']?t|never)\s+(?:\w+\s+){0,3}?(?:skip|pass|decline)\b/g, ' ')
    .replace(/\b(?:do\s*n[o']?t|never)\s+\w+\b/g, ' ');
  // Beyond the explicit refusal keywords, only an UNAMBIGUOUS, non-negated,
  // sender-directed, SMS-targeted opt-out clause counts as negative (codex
  // rounds 7, 10, 11, 12): a stray "stop" or "unsubscribe" in ordinary
  // conversation ("Can I stop by the front desk?", "I don't want to
  // unsubscribe", "my husband wants to unsubscribe") must reach the chat
  // bot, not consume the pending offer as a decline.
  return NO_KEYWORDS.test(refusalScope) || isPhraseLevelOptOut(value);
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

function withIndefiniteArticle(phrase, { capitalize = false } = {}) {
  const value = String(phrase || '').trim();
  if (!value) return capitalize ? 'An add-on' : 'an add-on';
  const article = pickIndefiniteArticle(value);
  const cased = capitalize ? article.charAt(0).toUpperCase() + article.slice(1) : article;
  return `${cased} ${value}`;
}

// Membership-aware price sentence tail for the add-on YES ack. A KNOWN member is
// quoted the member price; a KNOWN non-member is quoted the walk-in price with NO
// member-discount tease (owner call 2026-07-22 after the live test read wrong);
// only UNKNOWN membership keeps the generic note.
function buildAddonPriceTail(offer, walkinPrice) {
  const memberPrice = Number(offer?.pricing?.memberPrice);
  if (offer?.isMember === true && Number.isFinite(memberPrice) && memberPrice > 0) {
    return `is $${memberPrice} with your membership.`;
  }
  if (offer?.isMember === false) {
    return `is $${walkinPrice}.`;
  }
  return `is $${walkinPrice} (members get 20% off).`;
}

function buildPendingOfferFinalizeReply(offer) {
  const offerKind = String(offer?.offerKind || 'duration').toLowerCase();
  if (offerKind === 'addon') {
    const price = Number(offer?.pricing?.walkinPrice || 0);
    const allowedName = getAllowedAddonDisplayName(offer?.addOnName);
    if (Number.isFinite(price)) {
      const priceTail = buildAddonPriceTail(offer, price);
      if (allowedName) {
        return `Thanks, we got your YES. ${withIndefiniteArticle(allowedName, { capitalize: true })} ${priceTail} Our team will confirm before your appointment.`;
      }
      return `Thanks, we got your YES. The add-on ${priceTail} Our team will confirm before your appointment.`;
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

// Result-specific follow-up for a COMPLETED apply (reverifyAndApplyUpgradeForProfile
// returns success only after bookingComplete plus verification). Sent from the
// deferred worker because the instant TwiML reply goes out before the outcome
// exists (Twilio's reply window is seconds, the apply can take minutes). Price is
// pulled from the SAME offer context the apply used, honoring the member rules:
// a KNOWN member gets the member figure, a KNOWN non-member the walk-in figure,
// unknown membership the figure that was quoted at offer time. When no figure is
// resolvable the price clause is omitted, never guessed.
function buildAppliedFollowupSms(offer, { priceDisclosed = true } = {}) {
  const offerKind = String(offer?.offerKind || 'duration').toLowerCase();
  // A figure appears in the follow-up ONLY when it was disclosed to the member
  // in this thread (a pending offer they said YES to) AND it resolves within its
  // own membership lane. No cross-lane fallbacks, no guessing: a KNOWN member
  // whose member figure is unresolvable gets outcome-only copy, never the
  // walk-in number (owner call 2026-07-22 round 2). The no-pending re-derive
  // path always gets outcome-only copy: never state a total the member never
  // saw quoted (NY ARL posture).
  if (offerKind === 'addon') {
    const addOnName = getAllowedAddonDisplayName(offer?.addOnName) || 'your add-on';
    let price = null;
    if (priceDisclosed) {
      const memberPrice = Number(offer?.pricing?.memberPrice);
      const walkinPrice = Number(offer?.pricing?.walkinPrice);
      const offeredPrice = Number(offer?.pricing?.offeredPrice);
      if (offer?.isMember === true) {
        price = Number.isFinite(memberPrice) && memberPrice > 0 ? memberPrice : null;
      } else if (offer?.isMember === false) {
        price = Number.isFinite(walkinPrice) && walkinPrice > 0 ? walkinPrice : null;
      } else {
        price = Number.isFinite(offeredPrice) && offeredPrice > 0 ? offeredPrice : null;
      }
    }
    if (price != null) {
      return `You're all set, ${addOnName} is added to today's facial for $${price}. See you soon.`;
    }
    return `You're all set, ${addOnName} is added to today's facial. See you soon.`;
  }
  const minutes = Number(offer?.targetDurationMinutes) > 0 ? Number(offer.targetDurationMinutes) : 50;
  // Echo the figure the thread actually disclosed: the duration offer and its
  // YES ack both quote deltaDollars ("for $50 more") and NEVER a total (see
  // buildDurationPricingText above, same discipline). Stating a derived total
  // here would assert a number the member never saw.
  const delta = priceDisclosed ? Number(offer?.deltaDollars) : NaN;
  if (Number.isFinite(delta) && delta > 0) {
    return `You're all set, your facial is now ${minutes} minutes for $${delta} more. See you soon.`;
  }
  return `You're all set, your facial is now ${minutes} minutes. See you soon.`;
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

  // Audit row FIRST (round-2 fix): the ack row is written before any Twilio
  // call so a hung or failed follow-up send can never eat the audit trail.
  await logUpgradeReplyOutbound({
    sessionId,
    from,
    activeSession,
    offer: offerForLog,
    upgradeResult,
    content: sentReplyText,
  });

  // Outcome truth (owner call 2026-07-22): a COMPLETED apply is announced with a
  // result-specific follow-up SMS so the member is not left believing a human
  // still has to finish it. STRICTLY success-gated: every non-applied path
  // (mutation disabled, member unresolvable, reverify refusal, warning block,
  // mutation failure) returns earlier or lands here with success false and sends
  // nothing, leaving the manual-confirm ack as the last word. Price appears only
  // when a pending offer disclosed it (see buildAppliedFollowupSms). A failed
  // follow-up send is swallowed: the member still holds the safe manual-confirm,
  // and the booking itself is already correct.
  let followupText = null;
  if (upgradeResult?.success === true) {
    followupText = buildAppliedFollowupSms(offerForLog, { priceDisclosed: hasPendingOffer === true });
    // STOP gate at SEND TIME, not YES time: the deferred apply can run minutes
    // (webhook maxDuration 300) and the member can text STOP inside that window.
    // Same authoritative suppression SET every other outbound send consults, but
    // via the STRICT tri-state check: the send happens ONLY on an affirmative
    // 'off' from Redis. 'on', 'unknown' (no Redis answer, lookup error), or an
    // unexpected throw all withhold the courtesy follow-up; the apply itself
    // already stands. (The boolean isOnStopSet stays fail-open for OFFER sends
    // by design; a courtesy confirmation is the reverse trade.)
    try {
      const stopVerdict = await checkStopSetStrict(from);
      if (stopVerdict !== 'off') {
        console.log(`[sms-webhook] applied follow-up suppressed: stop-set verdict '${stopVerdict}' at send time`);
        followupText = null;
      }
    } catch (err) {
      console.error('[sms-webhook] stop-set check threw, follow-up suppressed:', maskPhoneDigits(err?.message || err));
      followupText = null;
    }
    // Durable once-only send claim (Redis SET NX), taken AFTER the first STOP
    // gate so a pass suppressed there never consumes it (the post-claim STOP
    // re-check below CAN consume it, an accepted cost), and BEFORE the send so a double
    // YES or a Twilio webhook redelivery (possibly on another instance, where
    // the in-memory MessageSid replay cache is empty) can never send this
    // follow-up twice. Keyed to the appointment the apply targeted; falls back
    // to the phone when no appointment id survived. Fail closed: anything but
    // a fresh claim withholds the send, and a claim consumed by a send that
    // then fails stays consumed (at-most-once is the contract; the member
    // still holds the manual-confirm ack).
    if (followupText) {
      // Key includes the offer kind (gauntlet 2026-07-22): the same
      // appointment can legitimately receive a duration upgrade AND an
      // add-on inside the 24h TTL, and each real change gets its own
      // confirmation; only a same-kind repeat is a duplicate.
      const appointmentKey = String(offerForLog?.appointmentId || '').trim();
      const offerKindForClaim = String(offerForLog?.offerKind || 'duration').toLowerCase();
      const claimKey = appointmentKey
        ? `appt:${appointmentKey}:${offerKindForClaim}`
        : `phone:${normalizePhoneForIndex(from) || String(from || '').trim()}:${offerKindForClaim}`;
      let claimed = false;
      try {
        claimed = (await claimAppliedFollowupSend(claimKey)) === true;
      } catch (err) {
        console.error('[sms-webhook] follow-up send claim threw, follow-up suppressed:', maskPhoneDigits(err?.message || err));
      }
      if (!claimed) {
        console.log('[sms-webhook] applied follow-up suppressed: send claim not acquired (duplicate delivery or claim unavailable)');
        followupText = null;
      }
    }
    // STOP re-check AFTER the claim (Codex P1, 2026-07-22 gauntlet): the claim
    // above is itself a network await sitting between the first STOP check and
    // the send, and a STOP recorded in exactly that window must still win.
    // Same strict tri-state gate: only a second affirmative 'off' sends.
    if (followupText) {
      try {
        const stopVerdictAtSend = await checkStopSetStrict(from);
        if (stopVerdictAtSend !== 'off') {
          console.log(`[sms-webhook] applied follow-up suppressed: stop-set verdict '${stopVerdictAtSend}' after send claim`);
          followupText = null;
        }
      } catch (err) {
        console.error('[sms-webhook] stop-set recheck threw, follow-up suppressed:', maskPhoneDigits(err?.message || err));
        followupText = null;
      }
    }
    if (followupText) {
      try {
        await sendTwilioSms({ to: from, body: followupText, trimBody: trimSmsBodyShort });
      } catch (err) {
        console.error('[sms-webhook] applied follow-up send failed:', maskPhoneDigits(err?.message || err));
        followupText = null;
      }
    }
  }

  if (followupText) {
    await logUpgradeReplyOutbound({
      sessionId,
      from,
      activeSession,
      offer: offerForLog,
      upgradeResult,
      content: followupText,
    });
  }
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

    // Trailing punctuation tolerance: "STOP." or "Stop!" is an opt-out
    // attempt and must never fall through to the chat bot with no
    // suppression record anywhere (security review 2026-07-22). Leading
    // words stay excluded so ordinary sentences containing "cancel" do not
    // trigger the opt-out branch.
    const consentBody = normalizeApostrophes(body);
    // Strip ALL trailing punctuation and symbols, not just [.!?]: "STOP," and
    // "STOP;" are opt-outs too (codex round-11).
    const optOutBody = consentBody.replace(/[\s\p{P}\p{S}]+$/u, '');
    if (STOP_KEYWORDS.test(optOutBody) || isPhraseLevelOptOut(consentBody)) {
      console.log(`[sms-webhook] STOP received from ${maskPhoneDigits(from)}, opting out`);

      // STOP set FIRST, in its own try/catch: this is the authoritative
      // suppression write that blocks outbound sends immediately regardless
      // of Klaviyo propagation timing, and it must land even if the slow O(N)
      // registry scan below throws or hangs. The write is confirmation
      // checked: addToStopSet swallows Redis errors internally and returns
      // false, and the member is about to be told they are unsubscribed, so
      // an unconfirmed write queues a support incident instead of dying as a
      // warn line (no silent unrecorded opt-out).
      let stopRecorded = false;
      try {
        const registry = await import('../../../../../lib/sms-member-registry');
        if (typeof registry.addToStopSet === 'function') {
          stopRecorded = (await registry.addToStopSet(from)) === true;
        }
      } catch (e) {
        console.warn('[sms-webhook] Could not add to stop-set:', maskPhoneDigits(e.message));
      }
      if (!stopRecorded) {
        console.error('[sms-webhook] STOP write could not be confirmed, queueing incident for manual suppression');
        // DEFERRED (codex round-3 P1): the incident write does SMTP + Sheets
        // I/O with no route-level deadline, and in exactly this failure mode
        // (Redis down) the Klaviyo unsubscribe below is the remaining
        // suppression fallback, so nothing may block it or the TwiML reply.
        deferWork(() => logSupportIncident({
          date: new Date().toISOString(),
          session_id: `stop-${Date.now()}`,
          issue_type: 'sms_stop_record_failed',
          phone: from,
          user_message: 'Inbound STOP could not be recorded in the Redis stop-set. Manually verify suppression for this member in Klaviyo and Twilio before any further sends.',
          reason: 'stop_set_write_unconfirmed',
        }));
      }

      // Registry cleanup DEFERRED and off the reply path: removing the member
      // keeps the pre-appointment scan from re-queueing them, but it is
      // best-effort hygiene over an O(N) Redis scan, and a slow or hung scan
      // must never hold the unsubscribe confirmation past Twilio's reply
      // window (gauntlet 2026-07-22: codex adversarial and performance review
      // both flagged the inline await).
      deferWork(async () => {
        const registry = await import('../../../../../lib/sms-member-registry');
        if (typeof registry.removeMemberByPhone === 'function') {
          await registry.removeMemberByPhone(from);
        }
      });

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
        console.warn('[sms-webhook] Could not propagate unsubscribe to Klaviyo:', maskPhoneDigits(e.message));
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

    if (START_KEYWORDS.test(optOutBody)) {
      console.log(`[sms-webhook] START received from ${maskPhoneDigits(from)}, removing from stop set`);
      try {
        const { removeFromStopSet } = await import('../../../../../lib/sms-member-registry');
        if (typeof removeFromStopSet === 'function') {
          await removeFromStopSet(from);
        }
      } catch (e) {
        console.warn('[sms-webhook] Could not remove from stop set:', maskPhoneDigits(e.message));
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
      // Negative and opt-out language WINS a mixed message: "No thanks,
      // please stop texting me" is a refusal even though it contains a YES
      // keyword, and a wrong YES here mutates a real booking.
      const affirmative = isAffirmative(intentText) && !isNegative(intentText);
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
    console.error('Twilio webhook error:', maskPhoneDigits(err?.stack || err?.message || err));
    return new NextResponse(buildTwimlMessage(GENERIC_FAILURE_REPLY), {
      status: 200,
      headers: buildTwimlHeaders(rateLimit),
    });
  }
}

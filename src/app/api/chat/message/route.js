import { NextResponse } from 'next/server';
import { getSession, addMessage, createSession } from '../../../../lib/sessions';
import {
    getSystemPrompt,
    buildSystemPromptWithProfile,
    sendMessage,
    parseMemberLookup,
    parseSessionSummary,
    stripAllSystemTags,
} from '../../../../lib/claude';
import {
    lookupMember,
    formatProfileForPrompt,
    verifyMemberIdentity,
    evaluateUpgradeOpportunityForProfile,
    reverifyAndApplyUpgradeForProfile,
} from '../../../../lib/boulevard';
import { logChatMessage, logSupportIncident } from '../../../../lib/notify';
import { checkRateLimit, getClientIP } from '../../../../lib/rate-limit';
import { markUpgradeOfferEvent } from '../../../../lib/sms-sessions';

// Friendly message shown when Claude API is rate-limited
const RATE_LIMIT_USER_MESSAGE =
    "I'm sorry, I'm experiencing high demand right now. Please try again in a minute, or call (888) 677-0055 for immediate help.";

const MAX_MESSAGE_CHARS = 4000;
const MAX_RECOVERY_MESSAGES = 40;
const MAX_RECOVERY_MESSAGE_CHARS = 2000;
const MAX_RECOVERY_TOTAL_CHARS = 30000;
const MEMBERSHIP_EMAIL = 'memberships@silvermirror.com';
const HELLO_EMAIL = 'hello@silvermirror.com';
const SUPPORT_PHONE = '(888) 677-0055';
const SMS_REBOOK_URL = String(process.env.SMS_REBOOK_URL || 'https://booking.silvermirror.com/booking/location').trim();
const CANCELLATION_KEYWORDS = /\b(cancel|cancellation|terminate|end membership|stop membership)\b/i;
const SENSITIVE_CONTEXT_KEYWORDS = /\b(lost job|laid off|medical|surgery|hospital|hardship|can'?t afford|cannot afford|stressed|overwhelmed|frustrated|angry|upset|anxious)\b/i;
const PAUSE_CREDIT_KEYWORDS = /\b(credit|credits)\b/i;
const PAUSE_HOLD_KEYWORDS = /\b(pause|paused|hold|on hold)\b/i;
const UNRESOLVED_KEYWORDS = /\b(not resolved|still not resolved|this (isn't|is not|wasn't|was not) resolved|didn't resolve|did not resolve|not fixed|still broken)\b/i;
const BOOKING_CONTEXT_KEYWORDS = /\b(book|booking|appointment|calendar|checkout|payment|credit card|billing|cvv|cvc|zip(?:\s*code)?|widget)\b/i;
const ISSUE_CONTEXT_KEYWORDS = /\b(error|issue|problem|fail(?:ed|s|ing)?|freez(?:e[sd]?|ing)|frozen|not loading|cannot|can't|wont|won't|stuck|broken|crash(?:e[sd]?|ing)?|glitch(?:e[sd]?|ing)?)\b/i;
const LOCATION_CANDIDATES = [
  'Upper East Side', 'Flatiron', 'Bryant Park', 'Manhattan West', 'Upper West Side',
  'Dupont Circle', 'Navy Yard', 'Penn Quarter', 'Brickell', 'Coral Gables',
];
const YES_KEYWORDS = /\b(yes|yeah|yep|sure|ok|okay|do it|add it|upgrade|let's do it|sounds good|please|absolutely)\b/i;
const NO_KEYWORDS = /\b(no|nah|no thanks|not today|pass|i'?m good|skip|decline)\b/i;
const UPGRADE_INTEREST_KEYWORDS = /\b(upgrade|extend|longer|50[-\s]?min|50[-\s]?minute|90[-\s]?min|90[-\s]?minute|add[-\s]?on|add on|add[-\s]?it)\b/i;
const LOGISTICS_CONTEXT_KEYWORDS = /\b(direction|directions|address|where (is|are)|location|parking|how do i get|closest|map)\b/i;
const OFFER_WINDOW_MINUTES = Number(process.env.YES_RESPONSE_WINDOW_MIN || 15);

function formatMoney(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return `$${Math.round(value)}`;
}

function pluralizeMonths(months) {
    return `${months} month${months === 1 ? '' : 's'}`;
}

function hashText(text) {
    const source = String(text || '');
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
          hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
    }
    return hash;
}

function pickVariant(options, seed) {
    if (!Array.isArray(options) || options.length === 0) return '';
    const index = hashText(seed) % options.length;
    return options[index];
}

function hasSensitiveContext(text) {
    return SENSITIVE_CONTEXT_KEYWORDS.test(String(text || '').toLowerCase());
}

function formatMonthYear(isoDate) {
    if (!isoDate) return null;
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function isBookingPaymentIncident(text) {
    const input = String(text || '').toLowerCase();
    return BOOKING_CONTEXT_KEYWORDS.test(input) && ISSUE_CONTEXT_KEYWORDS.test(input);
}

function extractEmail(text) {
    const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0].toLowerCase() : null;
}

function extractPhone(text) {
    const match = String(text || '').match(/\+?\d[\d\s().-]{8,}\d/);
    if (!match) return null;
    const digits = match[0].replace(/\D/g, '');
    return digits.length >= 10 ? digits : null;
}

function extractName(text) {
    const input = String(text || '');
    const explicit = input.match(/\bmy name is\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})/i);
    if (explicit) return explicit[1].trim();
    const pair = input.match(/\b([A-Z][a-zA-Z'-]{1,})\s+([A-Z][a-zA-Z'-]{1,})\b/);
    return pair ? `${pair[1]} ${pair[2]}` : null;
}

function extractLocation(text) {
    const input = String(text || '').toLowerCase();
    const hit = LOCATION_CANDIDATES.find(loc => input.includes(loc.toLowerCase()));
    return hit || null;
}

function buildSupportIncidentResponse() {
    return [
      "Thanks for flagging this. I've alerted our QA team and logged this issue for follow-up.",
      `We aim to respond within 48 hours. The fastest way to get help is to call ${SUPPORT_PHONE}.`,
      `For non-urgent follow-up, email ${HELLO_EMAIL}.`,
      'If you can, please share your location, device/browser, and a screenshot so we can troubleshoot faster.',
    ].join(' ');
}

function isInactiveAccountStatus(status) {
    const normalized = String(status || '').toLowerCase();
    if (!normalized) return false;
    return /(inactive|canceled|cancelled|terminated|ended|closed|lapsed)/i.test(normalized);
}

function collectRecentUserText(messages, limit = 6) {
    if (!Array.isArray(messages)) return '';
    const recent = messages
      .filter(m => m && m.role === 'user' && typeof m.content === 'string')
      .slice(-limit)
      .map(m => m.content.trim())
      .filter(Boolean);
    return recent.join(' ');
}

function hasCancellationIntent(text) {
    return CANCELLATION_KEYWORDS.test(String(text || '').toLowerCase());
}

function isPauseCreditsQuestion(text) {
    const input = String(text || '').toLowerCase();
    return PAUSE_CREDIT_KEYWORDS.test(input) && PAUSE_HOLD_KEYWORDS.test(input);
}

function buildPauseCreditsAnswer(profile) {
    const credits = Number.isFinite(profile?.unusedCredits) ? profile.unusedCredits : null;
    const base = "Yes — if your membership is on an approved pause, your existing unused credits can still be used while they are valid.";
    const expiry = 'Credits expire 90 days from their initial bill date.';

    if (credits !== null) {
      const noun = credits === 1 ? 'credit' : 'credits';
      return `${base} You currently have ${credits} unused ${noun}. ${expiry}`;
    }

    return `${base} ${expiry}`;
}

function isUnresolvedIssueMessage(text) {
    return UNRESOLVED_KEYWORDS.test(String(text || '').toLowerCase());
}

function isAffirmativeUpgradeReply(text) {
    return YES_KEYWORDS.test(String(text || '').toLowerCase());
}

function isNegativeUpgradeReply(text) {
    return NO_KEYWORDS.test(String(text || '').toLowerCase());
}

function mentionsUpgradeInterest(text) {
    return UPGRADE_INTEREST_KEYWORDS.test(String(text || '').toLowerCase());
}

function isLogisticsContext(text) {
    return LOGISTICS_CONTEXT_KEYWORDS.test(String(text || '').toLowerCase());
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

function buildUpgradeOfferMessage(opportunity, options = {}) {
    if (!opportunity?.pricing) return null;
    const proactive = options.proactive === true;
    const pricing = opportunity.pricing;
    const delta = Number(pricing.walkinDelta || 50);
    const timeText = formatTimeForGuest(opportunity.startOn);
    const opener = proactive
      ? `I also see room after your ${timeText} session.`
      : `I checked your ${timeText} appointment.`;
    const priceLine = `Upgrade to 50-Min Esthetician's Choice is +$${delta} (members get 20% off).`;

    return `${opener} ${priceLine} Reply YES in ${OFFER_WINDOW_MINUTES} min or NO.`;
}

function buildUpgradeSuccessMessage(result, pendingOffer = null) {
    return "You're all set. See you soon.";
}

function buildUpgradeUnavailableMessage(result = null, pendingOffer = null) {
    const reason = String(result?.reason || '').toLowerCase();
    if (['upgrade_mutation_disabled', 'service_id_not_configured', 'upgrade_mutation_failed'].includes(reason)) {
      if (reason === 'upgrade_mutation_failed') {
        return `I couldn't complete that change instantly. Please use ${SMS_REBOOK_URL} and we'll alert the front desk to assist.`;
      }
      return 'Thanks for replying YES. We received your request and our team will confirm before your appointment.';
    }
    return 'Thanks for the quick reply. I re-checked availability and that upgrade slot is no longer open right now.';
}

function isPendingOfferExpired(offer) {
    if (!offer?.expiresAt) return true;
    const expiresMs = new Date(offer.expiresAt).getTime();
    return !Number.isFinite(expiresMs) || Date.now() > expiresMs;
}

function buildUnresolvedEscalationResponse() {
    return [
      "Understood — this issue is still not resolved, so I'm escalating it to our team now.",
      `For the fastest help, call ${SUPPORT_PHONE}.`,
      `For non-urgent follow-up, email ${HELLO_EMAIL}.`,
    ].join(' ');
}

function stripEndFollowUpQuestions(text) {
    if (typeof text !== 'string') return '';
    const patterns = [
      /\s*is there anything else i can help you with today\??\s*$/i,
      /\s*is there anything else i can help with today\??\s*$/i,
      /\s*anything else i can help with\??\s*$/i,
    ];
    let cleaned = text;
    for (const pattern of patterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    return cleaned.trim();
}

function buildPostLookupGreeting(profile, rawUserMessage, options = {}) {
    const firstName = String(profile?.firstName || profile?.name?.split(' ')[0] || 'there').trim();
    const rawText = String(rawUserMessage || '');
    const recentUserText = String(options.recentUserText || '');
    const contextText = `${recentUserText} ${rawText}`.trim();
    const cancelIntent = hasCancellationIntent(contextText);
    const sensitiveContext = hasSensitiveContext(contextText);
    const inactiveAccount = isInactiveAccountStatus(profile?.accountStatus);
    const seed = `${firstName}|${profile?.email || ''}|${profile?.phone || ''}|${profile?.memberSince || ''}|${contextText.toLowerCase()}`;
    const sentences = [];

    const tierLabel = profile?.tier ? `${profile.tier}-Minute Membership` : null;
    const rateLabel = typeof profile?.monthlyRate === 'number' ? `${formatMoney(profile.monthlyRate)}/month` : null;
    const location = profile?.location && profile.location !== 'Unknown' ? profile.location : null;
    const intro = pickVariant([
          `Thanks, ${firstName}. I found your membership.`,
          `Thanks, ${firstName}. I pulled up your membership details.`,
          `Great, ${firstName}. I found your membership.`,
    ], `${seed}|intro`);
    const detailLead = pickVariant([
          'Quick snapshot:',
          'Here is what I am seeing:',
          'Current details:',
    ], `${seed}|detail`);
    const membershipVerb = pickVariant([
          'You are on',
          'You are currently on',
          'Right now you are on',
    ], `${seed}|membership_verb`);

    if (tierLabel && rateLabel && location) {
          sentences.push(intro);
          sentences.push(`${detailLead} ${membershipVerb} the ${tierLabel} at ${location} for ${rateLabel}.`);
    } else if (tierLabel && rateLabel) {
          sentences.push(intro);
          sentences.push(`${detailLead} ${membershipVerb} the ${tierLabel} for ${rateLabel}.`);
    } else if (tierLabel && location) {
          sentences.push(intro);
          sentences.push(`${detailLead} ${membershipVerb} the ${tierLabel} at ${location}.`);
    } else if (tierLabel) {
          sentences.push(intro);
          sentences.push(`${detailLead} ${membershipVerb} the ${tierLabel}.`);
    } else if (location) {
          sentences.push(pickVariant([
                `Thanks, ${firstName}. I found your account at ${location}.`,
                `Thanks, ${firstName}. I located your account at ${location}.`,
                `Great, ${firstName}. I found your account at ${location}.`,
          ], `${seed}|location_only`));
    } else {
          sentences.push(pickVariant([
                `Thanks, ${firstName}. I found your account.`,
                `Great, ${firstName}. I located your account.`,
                `Thanks, ${firstName}. I pulled up your account.`,
          ], `${seed}|account_only`));
    }

    const memberSince = formatMonthYear(profile?.memberSince);
    if (memberSince && typeof profile?.tenureMonths === 'number' && Number.isFinite(profile.tenureMonths)) {
          sentences.push(`You joined in ${memberSince}, so you've been with us about ${pluralizeMonths(profile.tenureMonths)}.`);
    } else if (memberSince) {
          sentences.push(`You joined in ${memberSince}.`);
    } else if (typeof profile?.tenureMonths === 'number' && Number.isFinite(profile.tenureMonths)) {
          sentences.push(`You've been with us about ${pluralizeMonths(profile.tenureMonths)}.`);
    }

    const computed = profile?.computed || {};
    let highlightedValue = false;
    if (typeof computed.rateLockAnnual === 'number' && computed.rateLockAnnual > 0) {
          sentences.push(`Your current rate is about ${formatMoney(computed.rateLockAnnual)}/year lower than today's new-member pricing.`);
          highlightedValue = true;
    }
    if (typeof computed.memberDiscountSavingsTotal === 'number' && computed.memberDiscountSavingsTotal > 0) {
          const estimateSuffix = computed.discountSavingsConfidence === 'high'
            ? ''
            : computed.discountSavingsConfidence === 'estimated_simple_20pct'
            ? ' (estimated from total spend)'
            : ' (estimated)';
          sentences.push(`You've also saved about ${formatMoney(computed.memberDiscountSavingsTotal)} through member discounts on services and products${estimateSuffix}.`);
          highlightedValue = true;
    } else if (typeof computed.walkinSavings === 'number' && computed.walkinSavings > 0) {
          sentences.push(`You've saved about ${formatMoney(computed.walkinSavings)} versus walk-in pricing so far.`);
          highlightedValue = true;
    }
    if (!highlightedValue && profile?.loyaltyEnrolled === true && typeof profile?.loyaltyPoints === 'number' && Number.isFinite(profile.loyaltyPoints)) {
          sentences.push(`You currently have ${profile.loyaltyPoints} loyalty points.`);
    }

    if (computed.nextPerk && typeof profile?.tenureMonths === 'number' && Number.isFinite(profile.tenureMonths)) {
          const monthsUntilPerk = computed.nextPerk.month - profile.tenureMonths;
          if (monthsUntilPerk === 0) {
                sentences.push(`You're right at your Month ${computed.nextPerk.month} perk milestone: ${computed.nextPerk.name}.`);
          } else if (monthsUntilPerk > 0 && monthsUntilPerk <= 6) {
                sentences.push(`You're about ${pluralizeMonths(monthsUntilPerk)} away from your Month ${computed.nextPerk.month} perk: ${computed.nextPerk.name}.`);
          }
    }

    if (cancelIntent && inactiveAccount) {
          sentences.push(`It looks like your account is currently inactive and has an outstanding balance.`);
          sentences.push(`The memberships team can help with either path once the balance is settled: reactivate your membership if you want to keep benefits active, or finalize cancellation if you want to close it out.`);
          sentences.push(`Please email ${MEMBERSHIP_EMAIL} with your full name and best callback number, and they will follow up within 24-48 hours.`);
          return sentences.join(' ');
    }

    if (cancelIntent) {
          if (sensitiveContext) {
                sentences.push(pickVariant([
                      'Thanks for sharing that. If you are comfortable sharing more, what is the biggest reason you are considering cancellation right now?',
                      'I hear you. If you are open to it, what is the main thing pushing you toward cancellation?',
                ], `${seed}|cancel_sensitive`));
          } else {
                sentences.push(pickVariant([
                      "If you're open to sharing, what's making you think about canceling?",
                      'If you are open to sharing, what is the main reason you are considering cancellation?',
                      'When you are ready, what is driving the cancellation decision for you?',
                ], `${seed}|cancel`));
          }
    } else {
          sentences.push(pickVariant([
                'What can I help with on your membership today?',
                'What would you like to handle on your membership today?',
                'What can I support you with on your membership today?',
          ], `${seed}|general`));
    }

    return sentences.join(' ');
}

function buildLookupFailureMessage(firstName, attempt) {
    const namePrefix = firstName ? `${firstName}, ` : '';
    const seed = `${firstName}|${attempt}`;

    if (attempt <= 1) {
          return pickVariant([
                `${namePrefix}I could not find your account just yet. Sometimes a different email or phone format does the trick.\n\nCould you send one of these so I can re-check quickly?\n- A different email you may have used at signup\n- Your mobile number only (digits are fine)\n\nIf it is easier, you can also email ${MEMBERSHIP_EMAIL} with your full name and phone number.`,
                `${namePrefix}I am not seeing a match yet, but this usually resolves with one more try.\n\nPlease send one of these:\n- Another email you may have used\n- Your mobile number only (digits are fine)\n\nIf you prefer, email ${MEMBERSHIP_EMAIL} with your full name and phone number and the team can help.`,
          ], `${seed}|fail_first`);
    }

    return pickVariant([
          `${namePrefix}I still cannot locate the account in chatbot search.\n\nPlease email ${MEMBERSHIP_EMAIL} and include:\n- Full name\n- Phone number\n- Any possible signup email\n\nThe memberships team replies within 24-48 hours and can complete the cancellation process for you.`,
          `${namePrefix}I still do not see a reliable account match here.\n\nPlease email ${MEMBERSHIP_EMAIL} with:\n- Full name\n- Phone number\n- Any possible signup email\n\nThe memberships team can locate the account and handle cancellation within 24-48 hours.`,
    ], `${seed}|fail_second`);
}

function buildLookupCandidates(lookupRequest, rawUserMessage) {
    const values = [lookupRequest?.email, lookupRequest?.phone, rawUserMessage]
        .filter(v => typeof v === 'string')
        .map(v => v.trim())
        .filter(Boolean);

    const emailSet = new Set();
    const phoneSet = new Set();

    for (const value of values) {
          const emails = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
          for (const email of emails) emailSet.add(email.toLowerCase());

          const phones = value.match(/\+?\d[\d\s().-]{8,}\d/g) || [];
          for (const phone of phones) {
                const digits = phone.replace(/\D/g, '');
                if (digits.length >= 10) phoneSet.add(phone.trim());
          }

          if (emails.length === 0 && phones.length === 0) {
                if (value.includes('@')) emailSet.add(value.toLowerCase());
                else phoneSet.add(value);
          }
    }

    return [...emailSet, ...phoneSet];
}

function buildLookupNameCandidates(lookupRequest, rawUserMessage) {
    const names = [];

    const structuredFirst = String(lookupRequest?.firstName || '').trim();
    const structuredLast = String(lookupRequest?.lastName || '').trim();
    if (structuredFirst && structuredLast) {
          names.push(`${structuredFirst} ${structuredLast}`);
    }

    if (typeof rawUserMessage === 'string' && rawUserMessage.trim()) {
          let scrubbed = rawUserMessage;
          scrubbed = scrubbed.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ');
          scrubbed = scrubbed.replace(/\+?\d[\d\s().-]{8,}\d/g, ' ');
          const rawParts = scrubbed.match(/[A-Za-z][A-Za-z'-]*/g) || [];
          const noise = new Set(['email', 'text', 'phone', 'cell', 'number', 'mobile']);
          const parts = rawParts.filter(p => !noise.has(String(p).toLowerCase()));

          if (parts.length >= 2) {
                names.push(`${parts[0]} ${parts[1]}`);
                if (parts.length > 2) {
                      names.push(`${parts[0]} ${parts[parts.length - 1]}`);
                      names.push(parts.join(' '));
                }
          }
    }

    const seen = new Set();
    const unique = [];
    for (const name of names) {
          const key = name.trim().toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          unique.push(name.trim());
    }
    return unique;
}

function sanitizeRecoveredHistory(history) {
    if (!Array.isArray(history)) return [];

    const cleaned = [];
    let totalChars = 0;

    for (const item of history.slice(-MAX_RECOVERY_MESSAGES)) {
          if (!item || typeof item !== 'object') continue;

          const roleRaw = String(item.role || '').toLowerCase();
          const role =
              roleRaw === 'bot' || roleRaw === 'assistant'
              ? 'assistant'
              : roleRaw === 'user'
              ? 'user'
              : null;
          if (!role) continue;

          if (typeof item.content !== 'string') continue;
          const content = item.content.trim().slice(0, MAX_RECOVERY_MESSAGE_CHARS);
          if (!content) continue;

          if (role === 'user' && content.startsWith('[SYSTEM]')) continue;

          if (totalChars + content.length > MAX_RECOVERY_TOTAL_CHARS) break;
          totalChars += content.length;

          cleaned.push({ role, content });
    }

    return cleaned;
}

/**
 * Safely call sendMessage with graceful handling for Anthropic 429 rate limits.
 * Returns the response text, or null if rate-limited.
 */
async function safeSendMessage(systemPrompt, messages) {
    try {
          return await sendMessage(systemPrompt, messages);
    } catch (err) {
          if (err.status === 429) {
                  console.warn('Anthropic rate limit hit (429):', err.message?.substring(0, 200) || err);
                  return null;
          }
          throw err; // Re-throw non-429 errors
    }
}

export async function POST(request) {
    try {
          // Rate limit: max 30 messages per 10 minutes per IP
      const ip = getClientIP(request);
          const { allowed, retryAfterMs } = checkRateLimit(ip, 'message', 30, 10 * 60 * 1000);

      if (!allowed) {
              return NextResponse.json(
                { error: 'Too many messages. Please wait a few minutes and try again.' },
                { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } }
                      );
      }

      const body = await request.json();
          const { sessionId } = body;
      const message = typeof body.message === 'string' ? body.message.trim() : '';

      if (!sessionId || !message) {
              return NextResponse.json(
                { error: 'sessionId and message required.' },
                { status: 400 }
                      );
      }
      if (message.length > MAX_MESSAGE_CHARS) {
              return NextResponse.json(
                { error: `Message is too long. Please keep messages under ${MAX_MESSAGE_CHARS} characters.` },
                { status: 400 }
                      );
      }

      let session = getSession(sessionId);
          if (!session) {
                  // Serverless instance rotation — recover session from client history
                  console.warn(`Session ${sessionId} not found — attempting recovery from client history`);
                  const recoveredHistory = sanitizeRecoveredHistory(body.history);
                  if (recoveredHistory.length === 0) {
                          return NextResponse.json(
                            { error: 'Session expired. Please start a new chat.' },
                            { status: 409 }
                                      );
                  }
                  session = createSession(null, null, sessionId);
                  for (const msg of recoveredHistory) {
                          addMessage(session.id, msg.role, msg.content);
                  }
          }

      if (session.status !== 'active') {
              return NextResponse.json(
                { error: 'This conversation has already ended.' },
                { status: 400 }
                      );
      }

      // Sanitize user input \u2014 strip system tags to prevent injection
      const sanitizedMessage = stripAllSystemTags(message);

      // Add user message to history
      addMessage(sessionId, 'user', sanitizedMessage);

      // Log user message to chatbot log (fire-and-forget)
      const sessionCreated = new Date(session.createdAt).toISOString();
          logChatMessage(sessionId, sessionCreated, 'user', sanitizedMessage).catch(err =>
                  console.warn('Chatlog failed for user message:', err)
                                                                               );

      // Direct FAQ answer for a common question: credits during pause/hold.
      if (isPauseCreditsQuestion(sanitizedMessage)) {
            const pauseCreditsResponse = buildPauseCreditsAnswer(session.memberProfile || null);
            addMessage(sessionId, 'assistant', pauseCreditsResponse);
            logChatMessage(sessionId, sessionCreated, 'assistant', pauseCreditsResponse).catch(err =>
                console.warn('Chatlog failed for pause-credit response:', err)
            );
            return NextResponse.json({
                message: pauseCreditsResponse,
                sessionId,
            });
      }

      // For unresolved general support issues, escalate and end chat immediately.
      if (session.mode !== 'membership' && isUnresolvedIssueMessage(sanitizedMessage)) {
            const unresolvedResponse = buildUnresolvedEscalationResponse();
            addMessage(sessionId, 'assistant', unresolvedResponse);
            logChatMessage(sessionId, sessionCreated, 'assistant', unresolvedResponse).catch(err =>
                console.warn('Chatlog failed for unresolved escalation response:', err)
            );
            return NextResponse.json({
                message: unresolvedResponse,
                sessionId,
                conversationEnding: true,
                unresolvedEscalation: true,
            });
      }

      // Booking/payment incident fast-path: auto-alert QA + write to support sheet
      if (!session.memberProfile && session.mode !== 'membership' && isBookingPaymentIncident(sanitizedMessage)) {
            const incident = {
                  date: new Date().toISOString(),
                  session_id: sessionId,
                  issue_type: 'booking_payment_issue',
                  name: extractName(sanitizedMessage),
                  email: extractEmail(sanitizedMessage),
                  phone: extractPhone(sanitizedMessage),
                  location: extractLocation(sanitizedMessage),
                  user_message: sanitizedMessage,
            };

            let supportNotifications = null;
            try {
                  supportNotifications = await logSupportIncident(incident);
            } catch (err) {
                  console.error('Support incident logging failed:', err);
            }

            const supportResponse = buildSupportIncidentResponse();
            addMessage(sessionId, 'assistant', supportResponse);
            logChatMessage(sessionId, sessionCreated, 'assistant', supportResponse).catch(err =>
                console.warn('Chatlog failed for support incident response:', err)
            );

            return NextResponse.json({
                  message: supportResponse,
                  sessionId,
                  supportIncident: true,
                  supportNotifications,
            });
      }

      // Expire stale pending upgrade offers
      if (session.pendingUpgradeOffer && isPendingOfferExpired(session.pendingUpgradeOffer)) {
            session.pendingUpgradeOffer = null;
      }

      // YES/NO handling for an active pending upgrade offer
      if (session.pendingUpgradeOffer && session.memberProfile) {
            if (isAffirmativeUpgradeReply(sanitizedMessage)) {
                  const appointmentId = session.pendingUpgradeOffer?.appointmentId || null;
                  const profilePhone = session.memberProfile?.phone || null;
                  const upgradeResult = await reverifyAndApplyUpgradeForProfile(
                    session.memberProfile,
                    session.pendingUpgradeOffer,
                  );
                  const pendingOffer = session.pendingUpgradeOffer || null;
                  if (profilePhone && appointmentId) {
                        markUpgradeOfferEvent(
                          profilePhone,
                          appointmentId,
                          upgradeResult.success ? 'upgraded' : 'unavailable',
                        );
                  }
                  const upgradeMessage = upgradeResult.success
                    ? buildUpgradeSuccessMessage(upgradeResult, pendingOffer)
                    : buildUpgradeUnavailableMessage(upgradeResult, pendingOffer);
                  addMessage(sessionId, 'assistant', upgradeMessage);
                  logChatMessage(sessionId, sessionCreated, 'assistant', upgradeMessage).catch(err =>
                      console.warn('Chatlog failed for upgrade response:', err)
                  );
                  session.lastUpgradeOfferAppointmentId = session.pendingUpgradeOffer.appointmentId || null;
                  session.pendingUpgradeOffer = null;
                  return NextResponse.json({
                        message: upgradeMessage,
                        sessionId,
                        upgradeHandled: true,
                        upgradeResult: {
                              success: upgradeResult.success,
                              reason: upgradeResult.reason || null,
                              appointmentId: upgradeResult?.opportunity?.appointmentId || null,
                              mutationRoot: upgradeResult?.mutationRoot || null,
                        },
                  });
            }

            if (isNegativeUpgradeReply(sanitizedMessage)) {
                  const appointmentId = session.pendingUpgradeOffer?.appointmentId || null;
                  const profilePhone = session.memberProfile?.phone || null;
                  if (profilePhone && appointmentId) {
                        markUpgradeOfferEvent(profilePhone, appointmentId, 'declined');
                  }
                  const declineMessage = 'No problem at all — we will keep your appointment as-is.';
                  addMessage(sessionId, 'assistant', declineMessage);
                  logChatMessage(sessionId, sessionCreated, 'assistant', declineMessage).catch(err =>
                      console.warn('Chatlog failed for upgrade decline response:', err)
                  );
                  session.lastUpgradeOfferAppointmentId = session.pendingUpgradeOffer.appointmentId || null;
                  session.pendingUpgradeOffer = null;
                  return NextResponse.json({
                        message: declineMessage,
                        sessionId,
                        upgradeHandled: true,
                        upgradeResult: { success: false, reason: 'declined' },
                  });
            }
      }

      // Explicit upgrade request: run deterministic eligibility check before LLM response.
      if (session.memberProfile && mentionsUpgradeInterest(sanitizedMessage)) {
            const opportunity = await evaluateUpgradeOpportunityForProfile(session.memberProfile);
            if (opportunity?.eligible) {
                  if (session.lastUpgradeOfferAppointmentId !== opportunity.appointmentId) {
                        const offerMessage = buildUpgradeOfferMessage(opportunity, { proactive: false });
                        if (offerMessage) {
                              session.pendingUpgradeOffer = {
                                    appointmentId: opportunity.appointmentId,
                                    offerKind: 'duration',
                                    currentDurationMinutes: opportunity.currentDurationMinutes || null,
                                    targetDurationMinutes: opportunity.targetDurationMinutes,
                                    isMember: opportunity.isMember === true,
                                    pricing: opportunity.pricing || null,
                                    createdAt: new Date().toISOString(),
                                    expiresAt: new Date(Date.now() + OFFER_WINDOW_MINUTES * 60 * 1000).toISOString(),
                              };
                              addMessage(sessionId, 'assistant', offerMessage);
                              logChatMessage(sessionId, sessionCreated, 'assistant', offerMessage).catch(err =>
                                  console.warn('Chatlog failed for direct upgrade offer:', err)
                              );
                              return NextResponse.json({
                                    message: offerMessage,
                                    sessionId,
                                    pendingUpgradeOffer: true,
                                    upgradeOpportunity: {
                                          appointmentId: opportunity.appointmentId,
                                          currentDurationMinutes: opportunity.currentDurationMinutes,
                                          targetDurationMinutes: opportunity.targetDurationMinutes,
                                          requiredExtraMinutes: opportunity.requiredExtraMinutes,
                                          availableGapMinutes: opportunity.availableGapMinutes,
                                          gapUnlimited: opportunity.gapUnlimited === true,
                                    },
                              });
                        }
                  }
            }
      }

      // Determine which system prompt to use
      const systemPrompt = session.systemPrompt || getSystemPrompt();

      // Send to Claude with full history (with 429 protection)
      let response = await safeSendMessage(systemPrompt, session.messages);

      if (response === null) {
              // Claude is rate-limited \u2014 return friendly message without crashing
            addMessage(sessionId, 'assistant', RATE_LIMIT_USER_MESSAGE);
              return NextResponse.json({
                        message: RATE_LIMIT_USER_MESSAGE,
                        sessionId,
                        rateLimited: true,
              });
      }

      // \u2500\u2500 Check for member_lookup request \u2500\u2500
      const lookupRequest = parseMemberLookup(response);

      // Validate that the lookup has real data \u2014 Claude sometimes emits the tag
      // while still asking for info, with empty/placeholder values.
      const hasName = lookupRequest &&
        (lookupRequest.firstName || '').trim().length > 0 &&
        (lookupRequest.lastName || '').trim().length > 0;
      const hasContact = lookupRequest &&
        ((lookupRequest.email || '').trim().length > 0 ||
         (lookupRequest.phone || '').trim().length > 0);
      const lookupIsValid = hasName && hasContact;

      if (lookupRequest && lookupIsValid && !session.memberProfile) {
            // Attempt Boulevard lookup
              const contacts = buildLookupCandidates(lookupRequest, sanitizedMessage);
              const nameCandidates = buildLookupNameCandidates(lookupRequest, sanitizedMessage);

            let profile = null;
              let matchedName = null;
              let matchedContact = null;
              try {
                        for (const nameCandidate of nameCandidates) {
                                      for (const contact of contacts) {
                                                    profile = await lookupMember(nameCandidate, contact);
                                                    if (profile) {
                                                              matchedName = nameCandidate;
                                                              matchedContact = contact;
                                                              break;
                                                    }
                                      }
                                      if (profile) break;
                        }
              } catch (err) {
                        console.error('Boulevard lookup error:', err);
              }

            // Verify identity before exposing profile data
              const verificationLookup = (() => {
                        if (!matchedName && !matchedContact) return lookupRequest;

                        const parts = String(matchedName || '').trim().split(/\s+/).filter(Boolean);
                        const firstName = parts[0] || lookupRequest.firstName || '';
                        const lastName = parts.slice(1).join(' ') || lookupRequest.lastName || '';
                        const isEmailContact = typeof matchedContact === 'string' && matchedContact.includes('@');

                        return {
                                      ...lookupRequest,
                                      firstName,
                                      lastName,
                                      email: isEmailContact ? matchedContact : (lookupRequest.email || ''),
                                      phone: isEmailContact ? (lookupRequest.phone || '') : (matchedContact || lookupRequest.phone || ''),
                        };
              })();
            if (profile && !verifyMemberIdentity(verificationLookup, profile)) {
                      console.warn('Identity verification failed \u2014 treating as lookup miss');
                      profile = null;
            }

            if (profile) {
                      // Success \u2014 switch to Membership Mode
                const profileText = formatProfileForPrompt(profile);
                      const memberSystemPrompt = buildSystemPromptWithProfile(profileText);

                // Store on session
                session.systemPrompt = memberSystemPrompt;
                      session.memberProfile = profile;
                      session.mode = 'membership';
                      session.lookupFailureCount = 0;

                // Use deterministic post-lookup greeting so we always show known
                // tier/rate/tenure data and avoid contradictory pre-lookup text.
                const recentUserText = collectRecentUserText(session.messages);
                const greeting = buildPostLookupGreeting(profile, sanitizedMessage, { recentUserText });
                addMessage(sessionId, 'assistant', greeting);

                // Log bot response to chatbot log
                logChatMessage(sessionId, sessionCreated, 'assistant', greeting).catch(err =>
                            console.warn('Chatlog failed for member greeting:', err)
                                                                                                       );

                return NextResponse.json({
                            message: greeting,
                            sessionId,
                            memberIdentified: true,
                            memberProfile: profile,
                });

            } else {
                      // Lookup failed \u2014 deterministic copy avoids repetitive loops
                      session.lookupFailureCount = Number(session.lookupFailureCount || 0) + 1;
                      const firstName = String(verificationLookup?.firstName || lookupRequest.firstName || '').trim();
                      const failureMessage = buildLookupFailureMessage(firstName, session.lookupFailureCount);
                      addMessage(sessionId, 'assistant', failureMessage);

                // Log bot response to chatbot log
                logChatMessage(sessionId, sessionCreated, 'assistant', failureMessage).catch(err =>
                            console.warn('Chatlog failed for lookup fail response:', err)
                                                                                                   );

                return NextResponse.json({
                            message: failureMessage,
                            sessionId,
                            memberIdentified: false,
                });
            }
      }

      // \u2500\u2500 Normal response (no lookup) \u2500\u2500
      // Only accept session_summary in membership mode to prevent stray tags
      const summary = session.mode === 'membership' ? parseSessionSummary(response) : null;
      let visibleResponse = stripAllSystemTags(response);
      if (summary) {
            visibleResponse = stripEndFollowUpQuestions(visibleResponse);
            if (!visibleResponse) {
                  visibleResponse = 'Thanks again. We have documented this conversation and our team will follow up.';
            }
      }

      // Proactive upgrade suggestion on logistics questions (e.g., directions) for identified members.
      if (!summary && session.memberProfile && !session.pendingUpgradeOffer && isLogisticsContext(sanitizedMessage)) {
            const opportunity = await evaluateUpgradeOpportunityForProfile(session.memberProfile);
            if (opportunity?.eligible && session.lastUpgradeOfferAppointmentId !== opportunity.appointmentId) {
                  const proactiveOffer = buildUpgradeOfferMessage(opportunity, { proactive: true });
                  if (proactiveOffer) {
                        session.pendingUpgradeOffer = {
                              appointmentId: opportunity.appointmentId,
                              offerKind: 'duration',
                              currentDurationMinutes: opportunity.currentDurationMinutes || null,
                              targetDurationMinutes: opportunity.targetDurationMinutes,
                              isMember: opportunity.isMember === true,
                              pricing: opportunity.pricing || null,
                              createdAt: new Date().toISOString(),
                              expiresAt: new Date(Date.now() + OFFER_WINDOW_MINUTES * 60 * 1000).toISOString(),
                        };
                        visibleResponse = `${visibleResponse}\n\n${proactiveOffer}`.trim();
                  }
            }
      }

      // Store CLEANED response in history (not raw with tags)
      addMessage(sessionId, 'assistant', visibleResponse);

      // Log bot response to chatbot log
      logChatMessage(sessionId, sessionCreated, 'assistant', visibleResponse).catch(err =>
              console.warn('Chatlog failed for bot response:', err)
                                                                                        );

      const result = {
              message: visibleResponse,
              sessionId,
      };
      if (session.memberProfile) {
              result.memberProfile = session.memberProfile;
      }

      // If a session summary was generated, the membership conversation is ending
      if (summary) {
              result.conversationEnding = true;
              result.summary = summary;
              session.summary = summary;
              session.outcome = summary.outcome;
      }

      return NextResponse.json(result);

    } catch (err) {
          console.error('Chat message error:', err);

      // Provide a more specific message for rate limit errors that weren't caught above
      if (err.status === 429) {
              return NextResponse.json(
                { error: RATE_LIMIT_USER_MESSAGE },
                { status: 429 }
                      );
      }

      return NextResponse.json(
        { error: 'Something went wrong. Please try again or call (888) 677-0055.' },
        { status: 500 }
            );
    }
}

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
import { lookupMember, formatProfileForPrompt, verifyMemberIdentity } from '../../../../lib/boulevard';
import { logChatMessage } from '../../../../lib/notify';
import { checkRateLimit, getClientIP } from '../../../../lib/rate-limit';

// Friendly message shown when Claude API is rate-limited
const RATE_LIMIT_USER_MESSAGE =
    "I'm sorry, I'm experiencing high demand right now. Please try again in a minute, or call (888) 677-0055 for immediate help.";

const MAX_MESSAGE_CHARS = 4000;
const MAX_RECOVERY_MESSAGES = 40;
const MAX_RECOVERY_MESSAGE_CHARS = 2000;
const MAX_RECOVERY_TOTAL_CHARS = 30000;
const MEMBERSHIP_EMAIL = 'memberships@silvermirror.com';
const CANCELLATION_KEYWORDS = /\b(cancel|cancellation|terminate|end membership|stop membership)\b/i;

function formatMoney(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return `$${Math.round(value)}`;
}

function pluralizeMonths(months) {
    return `${months} month${months === 1 ? '' : 's'}`;
}

function formatMonthYear(isoDate) {
    if (!isoDate) return null;
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function buildPostLookupGreeting(profile, rawUserMessage) {
    const firstName = String(profile?.firstName || profile?.name?.split(' ')[0] || 'there').trim();
    const sentences = [];

    const tierLabel = profile?.tier ? `${profile.tier}-Minute Membership` : null;
    const rateLabel = typeof profile?.monthlyRate === 'number' ? `${formatMoney(profile.monthlyRate)}/month` : null;
    const location = profile?.location && profile.location !== 'Unknown' ? profile.location : null;

    if (tierLabel && rateLabel && location) {
          sentences.push(`Thanks, ${firstName}. I found your membership.`);
          sentences.push(`You're on the ${tierLabel} at ${location} for ${rateLabel}.`);
    } else if (tierLabel && rateLabel) {
          sentences.push(`Thanks, ${firstName}. I found your membership.`);
          sentences.push(`You're on the ${tierLabel} for ${rateLabel}.`);
    } else if (tierLabel && location) {
          sentences.push(`Thanks, ${firstName}. I found your membership.`);
          sentences.push(`You're on the ${tierLabel} at ${location}.`);
    } else if (tierLabel) {
          sentences.push(`Thanks, ${firstName}. I found your membership.`);
          sentences.push(`You're on the ${tierLabel}.`);
    } else if (location) {
          sentences.push(`Thanks, ${firstName}. I found your account at ${location}.`);
    } else {
          sentences.push(`Thanks, ${firstName}. I found your account.`);
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
    if (typeof computed.rateLockAnnual === 'number' && computed.rateLockAnnual > 0) {
          sentences.push(`Your current rate is about ${formatMoney(computed.rateLockAnnual)}/year lower than today's new-member pricing.`);
    } else if (typeof computed.walkinSavings === 'number' && computed.walkinSavings > 0) {
          sentences.push(`You've saved about ${formatMoney(computed.walkinSavings)} versus walk-in pricing so far.`);
    } else if (profile?.loyaltyEnrolled === true && typeof profile?.loyaltyPoints === 'number' && Number.isFinite(profile.loyaltyPoints)) {
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

    if (CANCELLATION_KEYWORDS.test(String(rawUserMessage || '').toLowerCase())) {
          sentences.push("If you're open to sharing, what's making you think about canceling?");
    } else {
          sentences.push('What can I help with on your membership today?');
    }

    return sentences.join(' ');
}

function buildLookupFailureMessage(firstName, attempt) {
    const namePrefix = firstName ? `${firstName}, ` : '';

    if (attempt <= 1) {
          return `${namePrefix}I couldn't find your account just yet. Sometimes a different email or phone format does the trick.\n\nCould you send one of these so I can re-check quickly?\n- A different email you may have used at signup\n- Your mobile number only (digits are fine)\n\nIf it's easier, you can also email ${MEMBERSHIP_EMAIL} with your full name and phone number.`;
    }

    return `${namePrefix}I still can't locate the account from chatbot search.\n\nPlease email ${MEMBERSHIP_EMAIL} and include:\n- Full name\n- Phone number\n- Any possible signup email\n\nThe memberships team replies within 24-48 hours and can complete the cancellation process for you.`;
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
                const greeting = buildPostLookupGreeting(profile, sanitizedMessage);
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
          const visibleResponse = stripAllSystemTags(response);

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

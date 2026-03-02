import { NextResponse } from 'next/server';
import { getSession, addMessage } from '../../../../lib/sessions';
import {
    getSystemPrompt,
    buildSystemPromptWithProfile,
    sendMessage,
    parseMemberLookup,
    stripMemberLookup,
    parseSessionSummary,
    stripSummaryFromResponse,
    stripAllSystemTags,
} from '../../../../lib/claude';
import { lookupMember, formatProfileForPrompt } from '../../../../lib/boulevard';
import { logChatMessage } from '../../../../lib/notify';
import { checkRateLimit, getClientIP } from '../../../../lib/rate-limit';

// Friendly message shown when Claude API is rate-limited
const RATE_LIMIT_USER_MESSAGE =
    "I'm sorry, I'm experiencing high demand right now. Please try again in a minute, or call (888) 677-0055 for immediate help.";

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
          const { sessionId, message } = body;

      if (!sessionId || !message) {
              return NextResponse.json(
                { error: 'sessionId and message required.' },
                { status: 400 }
                      );
      }

      const session = getSession(sessionId);
          if (!session) {
                  return NextResponse.json(
                    { error: 'Session not found or expired. Please refresh and start a new conversation.' },
                    { status: 404 }
                          );
          }

      if (session.status !== 'active') {
              return NextResponse.json(
                { error: 'This conversation has already ended.' },
                { status: 400 }
                      );
      }

      // Add user message to history
      addMessage(sessionId, 'user', message);

      // Log user message to chatbot log (fire-and-forget)
      const sessionCreated = new Date(session.createdAt).toISOString();
          logChatMessage(sessionId, sessionCreated, 'user', message).catch(err =>
                  console.warn('Chatlog failed for user message:', err)
                                                                               );

      // Determine which system prompt to use
      const systemPrompt = session.systemPrompt || getSystemPrompt();

      // Send to Claude with full history (with 429 protection)
      let response = await safeSendMessage(systemPrompt, session.messages);

      if (response === null) {
              // Claude is rate-limited — return friendly message without crashing
            addMessage(sessionId, 'assistant', RATE_LIMIT_USER_MESSAGE);
              return NextResponse.json({
                        message: RATE_LIMIT_USER_MESSAGE,
                        sessionId,
                        rateLimited: true,
              });
      }

      // ── Check for member_lookup request ──
      const lookupRequest = parseMemberLookup(response);

      if (lookupRequest && !session.memberProfile) {
              // Claude wants to look up a member — strip the lookup tag for visible response
            const visibleAck = stripAllSystemTags(response);

            // Store CLEANED response in history (not raw with tags)
            addMessage(sessionId, 'assistant', visibleAck);

            // Attempt Boulevard lookup
            const contactValue = lookupRequest.email || lookupRequest.phone || '';
              const fullName = `${lookupRequest.firstName || ''} ${lookupRequest.lastName || ''}`.trim();

            let profile = null;
              try {
                        profile = await lookupMember(fullName, contactValue);
              } catch (err) {
                        console.error('Boulevard lookup error:', err);
              }

            if (profile) {
                      // Success — switch to Membership Mode
                const profileText = formatProfileForPrompt(profile);
                      const memberSystemPrompt = buildSystemPromptWithProfile(profileText);

                // Store on session
                session.systemPrompt = memberSystemPrompt;
                      session.memberProfile = profile;
                      session.mode = 'membership';

                // Send a system-level message to Claude so it knows the profile is loaded
                addMessage(sessionId, 'user',
                                     '[SYSTEM] Member profile has been loaded. You are now in Membership Mode. Greet the member by first name, confirm their details, and ask how you can help with their membership.'
                                   );

                const memberResponse = await safeSendMessage(memberSystemPrompt, session.messages);

                if (memberResponse === null) {
                            // Claude rate-limited after profile load — still return the ack + a helpful message
                        const fallbackMsg = visibleAck + '\n\n' + RATE_LIMIT_USER_MESSAGE;
                            addMessage(sessionId, 'assistant', RATE_LIMIT_USER_MESSAGE);
                            return NextResponse.json({
                                          message: fallbackMsg,
                                          sessionId,
                                          memberIdentified: true,
                                          rateLimited: true,
                            });
                }

                const cleanMemberResponse = stripAllSystemTags(memberResponse);
                      addMessage(sessionId, 'assistant', cleanMemberResponse);

                const combinedResponse = visibleAck + '\n\n' + cleanMemberResponse;

                // Log bot response to chatbot log
                logChatMessage(sessionId, sessionCreated, 'assistant', combinedResponse).catch(err =>
                            console.warn('Chatlog failed for member greeting:', err)
                                                                                                       );

                return NextResponse.json({
                            message: combinedResponse,
                            sessionId,
                            memberIdentified: true,
                });

            } else {
                      // Lookup failed — tell Claude via a system message
                addMessage(sessionId, 'user',
                                     '[SYSTEM] Member lookup failed — no matching account found. Let the customer know we could not find their account and suggest they try a different email/phone or contact memberships@silvermirror.com directly.'
                                   );

                const failResponse = await safeSendMessage(systemPrompt, session.messages);

                if (failResponse === null) {
                            // Claude rate-limited after lookup failure
                        const fallbackMsg = visibleAck + '\n\n' + "I'm sorry, something went wrong on my end. Please call (888) 677-0055 for immediate help, or email hello@silvermirror.com.";
                            addMessage(sessionId, 'assistant', fallbackMsg);
                            return NextResponse.json({
                                          message: fallbackMsg,
                                          sessionId,
                                          memberIdentified: false,
                                          rateLimited: true,
                            });
                }

                const cleanFailResponse = stripAllSystemTags(failResponse);
                      addMessage(sessionId, 'assistant', cleanFailResponse);

                const combinedFail = visibleAck + '\n\n' + cleanFailResponse;

                // Log bot response to chatbot log
                logChatMessage(sessionId, sessionCreated, 'assistant', combinedFail).catch(err =>
                            console.warn('Chatlog failed for lookup fail response:', err)
                                                                                                   );

                return NextResponse.json({
                            message: combinedFail,
                            sessionId,
                            memberIdentified: false,
                });
            }
      }

      // ── Normal response (no lookup) ──
      const summary = parseSessionSummary(response);
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

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { WALKIN_PRICES, CURRENT_RATES } from './boulevard.js';

const SYSTEM_PROMPT_PATH = path.join(process.cwd(), 'src', 'lib', 'system-prompt.txt');
const MISSED_CALL_PROMPT_PATH = path.join(process.cwd(), 'src', 'lib', 'system-prompt-missed-call.txt');
const MEMBER_LOOKUP_TAG_RE = /<member_lookup>\s*([\s\S]*?)\s*<\/member_lookup>/;
const MEMBER_LOOKUP_TAG_RE_GLOBAL = /<member_lookup>[\s\S]*?<\/member_lookup>/g;
const SESSION_SUMMARY_TAG_RE = /<session_summary>\s*([\s\S]*?)\s*<\/session_summary>/;
const SESSION_SUMMARY_TAG_RE_GLOBAL = /<session_summary>[\s\S]*?<\/session_summary>/g;

let cachedSystemPrompt = null;
let cachedMissedCallPrompt = null;

function applyPricingTokens(promptText) {
  const tokenValues = {
    '{{WALKIN_30}}': `$${WALKIN_PRICES['30']}`,
    '{{WALKIN_50}}': `$${WALKIN_PRICES['50']}`,
    '{{WALKIN_90}}': `$${WALKIN_PRICES['90']}`,
    '{{MEMBER_30}}': `$${CURRENT_RATES['30']}`,
    '{{MEMBER_50}}': `$${CURRENT_RATES['50']}`,
    '{{MEMBER_90}}': `$${CURRENT_RATES['90']}`,
  };

  let out = promptText;
  for (const [token, value] of Object.entries(tokenValues)) {
    out = out.replaceAll(token, value);
  }
  return out;
}

function loadSystemPrompt() {
  if (!cachedSystemPrompt) {
    const raw = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
    cachedSystemPrompt = applyPricingTokens(raw);
  }
  return cachedSystemPrompt;
}

/**
 * Get the base system prompt (General Mode — no member profile).
 */
function getSystemPrompt() {
  return loadSystemPrompt();
}

/**
 * Build the system prompt with a member profile injected (Membership Mode).
 */
function buildSystemPromptWithProfile(profileText) {
  const base = loadSystemPrompt();
  // Append the member profile block so Claude enters Membership Mode
  return base + '\n\n<member_profile>\n' + profileText + '\n</member_profile>';
}

/**
 * Load the missed-call mode system prompt with pricing tokens applied.
 * The location-specific tokens ({{LOCATION_NAME}}, {{CALLER_PHONE_MASKED}},
 * {{CALL_TIME_LOCAL}}) are NOT applied here; they need session context and
 * are interpolated by buildMissedCallSystemPrompt below.
 */
function loadMissedCallPrompt() {
  if (!cachedMissedCallPrompt) {
    const raw = fs.readFileSync(MISSED_CALL_PROMPT_PATH, 'utf-8');
    cachedMissedCallPrompt = applyPricingTokens(raw);
  }
  return cachedMissedCallPrompt;
}

const MISSED_CALL_LOCATION_LABELS = {
  brickell: 'Brickell',
  coral_gables: 'Coral Gables',
  upper_east_side: 'Upper East Side',
  flatiron: 'Flatiron',
  bryant_park: 'Bryant Park',
  manhattan_west: 'Manhattan West',
  upper_west_side: 'Upper West Side',
  dupont_circle: 'Dupont Circle',
  navy_yard: 'Navy Yard',
  penn_quarter: 'Penn Quarter',
};

const MISSED_CALL_LOCATION_TZ = {
  brickell: 'America/New_York',
  coral_gables: 'America/New_York',
  upper_east_side: 'America/New_York',
  flatiron: 'America/New_York',
  bryant_park: 'America/New_York',
  manhattan_west: 'America/New_York',
  upper_west_side: 'America/New_York',
  dupont_circle: 'America/New_York',
  navy_yard: 'America/New_York',
  penn_quarter: 'America/New_York',
};

function formatMissedCallLocationName(slug) {
  const key = String(slug || '').trim().toLowerCase();
  return MISSED_CALL_LOCATION_LABELS[key] || (key
    ? key.split(/[_\s-]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
    : 'Silver Mirror');
}

function maskMissedCallPhone(e164) {
  const digits = String(e164 || '').replace(/\D+/g, '');
  if (digits.length < 4) return '****';
  const last4 = digits.slice(-4);
  return `(***) ***-${last4}`;
}

function formatMissedCallTime(timestamp, locationSlug) {
  if (!timestamp) return 'just now';
  const dt = new Date(timestamp);
  if (Number.isNaN(dt.getTime())) return 'just now';
  const tz = MISSED_CALL_LOCATION_TZ[String(locationSlug || '').trim().toLowerCase()] || 'America/New_York';
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz,
    }).format(dt);
  } catch {
    return dt.toISOString();
  }
}

/**
 * Build the missed-call system prompt for a given session, interpolating
 * {{LOCATION_NAME}}, {{CALLER_PHONE_MASKED}}, {{CALL_TIME_LOCAL}}.
 */
function buildMissedCallSystemPrompt(session) {
  const base = loadMissedCallPrompt();
  const locationSlug = session?.location_called || '';
  const locationName = formatMissedCallLocationName(locationSlug);
  const callerPhoneMasked = maskMissedCallPhone(session?.caller_phone);
  const callTimeLocal = formatMissedCallTime(
    session?.missed_call_triggered_at || session?.lastActivity || session?.createdAt,
    locationSlug,
  );
  return base
    .replaceAll('{{LOCATION_NAME}}', locationName)
    .replaceAll('{{CALLER_PHONE_MASKED}}', callerPhoneMasked)
    .replaceAll('{{CALL_TIME_LOCAL}}', callTimeLocal);
}

/**
 * Pick the right system prompt for a session.
 *   - missed_call sessions → missed-call prompt with placeholders interpolated
 *   - sessions with a saved systemPrompt (membership mode etc.) → that
 *   - everything else → the general system prompt
 */
function getSystemPromptForSession(session) {
  if (session?.session_mode === 'missed_call') {
    return buildMissedCallSystemPrompt(session);
  }
  if (session?.systemPrompt) {
    return session.systemPrompt;
  }
  return loadSystemPrompt();
}

let cachedClient = null;
let cachedClientKey = '';

function getAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  if (cachedClient && cachedClientKey === apiKey) return cachedClient;
  cachedClient = new Anthropic({ apiKey, timeout: 30000 });
  cachedClientKey = apiKey;
  return cachedClient;
}

/**
 * Send a message to Claude and get a response.
 */
async function sendMessage(systemPrompt, messages) {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
    })),
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  return text;
}

/**
 * Detect if Claude's response contains a member_lookup request.
 * Returns parsed lookup data or null.
 */
function parseMemberLookup(text) {
  const match = String(text || '').match(MEMBER_LOOKUP_TAG_RE);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (err) {
    console.error('Failed to parse member_lookup JSON:', err);
    return null;
  }
}

/**
 * Strip the member_lookup tags from the response so the user
 * only sees the conversational message.
 */
function stripMemberLookup(text) {
  return String(text || '').replace(MEMBER_LOOKUP_TAG_RE_GLOBAL, '').trim();
}

/**
 * Parse the session summary JSON from Claude's final response.
 * Validates required fields to prevent stray/injected tags from ending conversations.
 */
function parseSessionSummary(text) {
  const match = String(text || '').match(SESSION_SUMMARY_TAG_RE);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    // Validate required fields — reject malformed summaries
    if (!parsed.outcome || !parsed.client_name || !parsed.reason_primary) {
      console.warn('Session summary missing required fields — ignoring');
      return null;
    }
    return parsed;
  } catch (err) {
    console.error('Failed to parse session summary JSON:', err);
    return null;
  }
}

/**
 * Strip session summary tags from response.
 */
function stripSummaryFromResponse(text) {
  return String(text || '').replace(SESSION_SUMMARY_TAG_RE_GLOBAL, '').trim();
}

/**
 * Strip ALL system tags from response (lookup + summary).
 */
function stripAllSystemTags(text) {
  let cleaned = stripMemberLookup(text);
  cleaned = stripSummaryFromResponse(cleaned);
  return cleaned;
}


export {
  loadSystemPrompt,
  getSystemPrompt,
  buildSystemPromptWithProfile,
  loadMissedCallPrompt,
  buildMissedCallSystemPrompt,
  getSystemPromptForSession,
  formatMissedCallLocationName,
  maskMissedCallPhone,
  formatMissedCallTime,
  sendMessage,
  parseMemberLookup,
  stripMemberLookup,
  parseSessionSummary,
  stripSummaryFromResponse,
  stripAllSystemTags,
};

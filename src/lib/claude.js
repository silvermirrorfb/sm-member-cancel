import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { WALKIN_PRICES, CURRENT_RATES } from './boulevard.js';

const SYSTEM_PROMPT_PATH = path.join(process.cwd(), 'src', 'lib', 'system-prompt.txt');
const MEMBER_LOOKUP_TAG_RE = /<member_lookup>\s*([\s\S]*?)\s*<\/member_lookup>/;
const MEMBER_LOOKUP_TAG_RE_GLOBAL = /<member_lookup>[\s\S]*?<\/member_lookup>/g;
const SESSION_SUMMARY_TAG_RE = /<session_summary>\s*([\s\S]*?)\s*<\/session_summary>/;
const SESSION_SUMMARY_TAG_RE_GLOBAL = /<session_summary>[\s\S]*?<\/session_summary>/g;

let cachedSystemPrompt = null;

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
  sendMessage,
  parseMemberLookup,
  stripMemberLookup,
  parseSessionSummary,
  stripSummaryFromResponse,
  stripAllSystemTags,
};

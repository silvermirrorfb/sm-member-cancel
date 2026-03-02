import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { WALKIN_PRICES, CURRENT_RATES } from './boulevard.js';

const SYSTEM_PROMPT_PATH = path.join(process.cwd(), 'src', 'lib', 'system-prompt.txt');

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

/**
 * Send a message to Claude and get a response.
 */
async function sendMessage(systemPrompt, messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const client = new Anthropic({ apiKey });

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
  const match = text.match(/<member_lookup>\s*([\s\S]*?)\s*<\/member_lookup>/);
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
  return text.replace(/<member_lookup>[\s\S]*?<\/member_lookup>/, '').trim();
}

/**
 * Parse the session summary JSON from Claude's final response.
 * Validates required fields to prevent stray/injected tags from ending conversations.
 */
function parseSessionSummary(text) {
  const match = text.match(/<session_summary>\s*([\s\S]*?)\s*<\/session_summary>/);
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
  return text.replace(/<session_summary>[\s\S]*?<\/session_summary>/, '').trim();
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

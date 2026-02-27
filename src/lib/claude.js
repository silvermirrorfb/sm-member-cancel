import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const SYSTEM_PROMPT_PATH = path.join(process.cwd(), 'src', 'lib', 'system-prompt.txt');

let cachedSystemPrompt = null;

function loadSystemPrompt() {
  if (!cachedSystemPrompt) {
    cachedSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
  }
  return cachedSystemPrompt;
}

/**
 * Build the full system prompt with member profile data injected.
 */
function buildSystemPromptWithProfile(profileText) {
  const template = loadSystemPrompt();
  return template.replace('{{MEMBER_PROFILE}}', profileText);
}

/**
 * Send a message to Claude and get a response.
 * @param {string} systemPrompt - The full system prompt with profile injected
 * @param {Array} messages - Conversation history [{role, content}, ...]
 * @returns {string} Claude's response text
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

  // Extract text from response
  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  return text;
}

/**
 * Parse the session summary JSON from Claude's final response.
 * Claude outputs it wrapped in <session_summary> tags.
 */
function parseSessionSummary(text) {
  const match = text.match(/<session_summary>\s*([\s\S]*?)\s*<\/session_summary>/);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (err) {
    console.error('Failed to parse session summary JSON:', err);
    console.error('Raw text:', match[1]);
    return null;
  }
}

/**
 * Strip the session summary tags from the response so the user
 * only sees the conversational message.
 */
function stripSummaryFromResponse(text) {
  return text.replace(/<session_summary>[\s\S]*?<\/session_summary>/, '').trim();
}


export {
  loadSystemPrompt,
  buildSystemPromptWithProfile,
  sendMessage,
  parseSessionSummary,
  stripSummaryFromResponse,
};

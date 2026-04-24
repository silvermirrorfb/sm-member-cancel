// Detects explicit callback-request intent in an inbound SMS body.
// Only matches clear, unambiguous signals — broad words like "call" or
// "back" alone produce too many false positives, so anything ambiguous
// falls through to the AI (system-prompt-missed-call.txt handles those).

const CALLBACK_PATTERNS = [
  /\bcallback\b/i,
  /\bcall\s*back\b/i,
  /\bcall\s+me\s+back\b/i,
  /\bplease\s+call\s+me\b/i,
  /\bcall\s+me\s+please\b/i,
  /\bcan\s+you\s+call\s+me\b/i,
  /\byes\s+please\s+call\b/i,
  /\byes\s+call\s+me\b/i,
  /\b(i|we)\s+want\s+a\s+callback\b/i,
  /\b(i|we)\s+(would|want|need)\s+(a\s+)?callback\b/i,
];

const NEGATION_CONTEXTS = [
  /\b(was|were|gonna|going\s+to|planning\s+to|tried\s+to|meant\s+to)\s+call\b/i,
  /\bcall(ed|ing)?\s+(the|a|their|my)\s+(salon|spa|store|office|front\s*desk|location|place|clinic)\b/i,
  /\b(don'?t|do\s+not|no\s+need\s+to|not)\s+call\s+me\b/i,
];

function detectCallbackIntent(messageBody) {
  if (!messageBody || typeof messageBody !== 'string') return false;
  const normalized = messageBody.trim();
  if (!normalized) return false;
  for (const negation of NEGATION_CONTEXTS) {
    if (negation.test(normalized)) return false;
  }
  for (const pattern of CALLBACK_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}

function getCallbackRequestedVia(messageBody) {
  const normalized = String(messageBody || '').trim();
  if (!normalized) return 'natural_language';
  if (/\bcallback\b/i.test(normalized)) return 'CALLBACK_keyword';
  return 'natural_language';
}

export { detectCallbackIntent, getCallbackRequestedVia };

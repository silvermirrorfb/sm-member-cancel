import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system prompt: promotions policy', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/lib/system-prompt.txt'),
    'utf8',
  );

  it('contains the polite-limitation response for specific-promo questions', () => {
    // Per CHATBOT_FOLLOWUPS_2026-05-26.md item 2 and Matt's 2026-05-26 decision:
    // bot must admit limitation politely instead of redirecting to a generic
    // membership pitch (sessions 150625ca, 69fd282f, a2f989c9 hit the old path
    // and read as dismissive).
    expect(prompt).toMatch(/I'?m sorry, I don'?t have information related to possible promotions/i);
    expect(prompt).toMatch(/check (our|the) website/i);
    expect(prompt).toMatch(/silvermirror\.com/);
    expect(prompt).toMatch(/hello@silvermirror\.com/);
  });

  it('contains the HARD RULE forbidding fabricated promo codes', () => {
    expect(prompt).toMatch(/HARD RULE[\s\S]{0,80}NO FABRICATED PROMO CODES/);
    // Rule must name the failure mode: inventing codes, percentages, or terms.
    expect(prompt.toLowerCase()).toMatch(/must not invent|must not (invent a code|quote a percentage|guess at terms)/);
  });

  it('does NOT instruct the bot to guess promo codes or quote discount percentages', () => {
    // Negative assertions: the prompt must not contain language that would
    // license fabrication. These patterns catch wording like "if you're not
    // sure of the exact promo, estimate" or "use a 10% discount as a default".
    const lower = prompt.toLowerCase();
    const offenders = [
      /(estimate|approximate|default|guess|approximately) (the )?promo/,
      /(estimate|approximate|default|guess|approximately) (the )?discount (code|amount|percent|percentage)/,
      /if (you|the bot) (don'?t|do not) know (the )?(exact )?(promo|discount|code)/,
      /use a \d+%? (off|discount) as a (default|placeholder|fallback)/,
    ];
    for (const pat of offenders) {
      expect(lower, `pattern matched: ${pat}`).not.toMatch(pat);
    }
  });

  it('does NOT redirect a specific-promo question to a membership pitch', () => {
    // The full sequence "ask about specific promo -> membership pitch" was the
    // dismissive behavior we are fixing. The HARD RULE explicitly bans this.
    expect(prompt).toMatch(
      /MUST NOT redirect a specific-promo question to a generic membership pitch/i,
    );
  });
});

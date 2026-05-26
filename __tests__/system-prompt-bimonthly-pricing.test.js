import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system prompt: bi-monthly pricing is fixed at current rates, not member rate', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/lib/system-prompt.txt'),
    'utf8',
  );

  it('explicitly quotes $99 for 30-min bi-monthly and $169 for 50-min bi-monthly', () => {
    expect(prompt).toMatch(/bi.?monthly[\s\S]{0,200}\$99[\s\S]{0,200}\$169/i);
  });

  it('contains a HARD RULE that bi-monthly uses current $99/$169 pricing, never the member rate', () => {
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(
      /hard rule[\s\S]{0,200}bi.?monthly|bi.?monthly[\s\S]{0,400}hard rule/,
    );
    expect(lower).toMatch(/never (use|quote) (the )?member.{0,40}(rate|price|pricing)/);
  });

  it('does NOT tie bi-monthly pricing to the member\'s existing/grandfathered/locked rate', () => {
    const lower = prompt.toLowerCase();
    const offenders = [
      /bi.?monthly.{0,80}your (current|locked|existing|grandfathered) (rate|price|pricing)/,
      /your (current|locked|existing|grandfathered) (rate|price|pricing).{0,80}bi.?monthly/,
      /bi.?monthly.{0,80}at (your|the member.?s) (rate|price|pricing)/,
    ];
    for (const pat of offenders) {
      expect(lower, `pattern matched: ${pat}`).not.toMatch(pat);
    }
  });
});

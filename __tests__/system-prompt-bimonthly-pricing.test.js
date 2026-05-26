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

  it('does NOT tie bi-monthly pricing to the member\'s existing/grandfathered/locked rate (outside the HARD RULE itself)', () => {
    // Per /codex review 2026-05-26: tighten to catch "monthly" between
    // qualifier and rate/price (e.g. "bi-monthly at your current monthly rate"
    // or "grandfathered monthly price"). Donna Sommer (2026-05-20) failure
    // mode is exactly this wording class.
    //
    // The HARD RULE itself recites the forbidden phrases ("never use the
    // member's current monthly rate, their grandfathered rate, ...") so we
    // carve that block out before scanning. We want to catch the bot being
    // INSTRUCTED to use these phrases, not the rule that bans them.
    const hardRuleStart = prompt.indexOf('HARD RULE - BI-MONTHLY PRICING IS FIXED');
    expect(hardRuleStart, 'HARD RULE block must exist for this test to scope correctly').toBeGreaterThan(-1);
    // HARD RULE block runs to the next numbered list item or blank-line separator.
    // Use the next blank-line-followed-by-digit-and-period as the end marker
    // (e.g. `\n\n18. FALLBACK`).
    const hardRuleEnd = prompt.slice(hardRuleStart).search(/\n\n\d+\. /);
    expect(hardRuleEnd, 'HARD RULE block must have a clean end boundary').toBeGreaterThan(-1);
    const scanRegion = (
      prompt.slice(0, hardRuleStart) +
      prompt.slice(hardRuleStart + hardRuleEnd)
    ).toLowerCase();

    const possessive = '(your|the member.?s|their|members.?)';
    const personalAdj = '(current|locked|existing|grandfathered|personal|personalized|promo)';
    const rateNoun = '(rate|price|pricing)';
    const offenders = [
      new RegExp(`bi.?monthly.{0,80}${possessive} ${personalAdj} (monthly )?${rateNoun}`),
      new RegExp(`${possessive} ${personalAdj} (monthly )?${rateNoun}.{0,80}bi.?monthly`),
      new RegExp(`bi.?monthly.{0,80}at ${possessive} (monthly )?${rateNoun}`),
      new RegExp(`bi.?monthly.{0,80}${possessive} monthly ${rateNoun}`),
      new RegExp(`${possessive} monthly ${rateNoun}.{0,80}bi.?monthly`),
      new RegExp(`bi.?monthly.{0,80}grandfathered monthly ${rateNoun}`),
      new RegExp(`grandfathered monthly ${rateNoun}.{0,80}bi.?monthly`),
    ];
    for (const pat of offenders) {
      expect(scanRegion, `pattern matched outside HARD RULE: ${pat}`).not.toMatch(pat);
    }
  });
});

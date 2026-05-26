import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system prompt: HydraFacial framing is upgrade-focused, not competitor-bashing', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/lib/system-prompt.txt'),
    'utf8',
  );

  it('does not say HydraFacial "had quality issues" or similar', () => {
    expect(prompt).not.toMatch(/quality issues/i);
    expect(prompt).not.toMatch(/had quality/i);
    expect(prompt).not.toMatch(/quality decline/i);
    expect(prompt).not.toMatch(/product line had/i);
  });

  it('still describes Hydradermabrasion as the current offering', () => {
    expect(prompt).toMatch(/Hydradermabrasion/);
  });

  it('still tells the bot how to respond when asked about HydraFacial', () => {
    expect(prompt.toLowerCase()).toContain('hydrafacial');
    expect(prompt.toLowerCase()).toMatch(/upgraded|upgrade/);
  });

  it('contains an explicit do-not-proactively-mention HydraFacial rule', () => {
    expect(prompt.toLowerCase()).toMatch(
      /only mention hydrafacial if the user mentions it first|do not proactively (mention|bring up) hydrafacial|never volunteer hydrafacial/,
    );
  });

  it('HydraFacial appears ONLY inside the dedicated HYDRAFACIAL section, nowhere else', () => {
    // Per /codex review 2026-05-26: the do-not-proactively-mention rule alone
    // doesn't catch a future edit that re-adds "Hydradermabrasion is our
    // upgrade replacement for HydraFacial" to the add-on/service descriptions.
    // Fix is structural: HydraFacial may only appear inside its dedicated
    // KNOWLEDGE BASE: HYDRAFACIAL section (bounded by `---` separator).
    const sectionHeader = 'KNOWLEDGE BASE: HYDRAFACIAL';
    const start = prompt.indexOf(sectionHeader);
    expect(start, 'HYDRAFACIAL section header must exist').toBeGreaterThan(-1);
    const nextSeparator = prompt.indexOf('\n---', start);
    expect(nextSeparator, 'HYDRAFACIAL section must end with `---`').toBeGreaterThan(start);
    const outsideSection = prompt.slice(0, start) + prompt.slice(nextSeparator);
    const offending = outsideSection
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /hydrafacial/i.test(text));
    expect(
      offending,
      `HydraFacial mentioned outside its dedicated section:\n` +
        offending.map((o) => `  ${o.text.trim().slice(0, 120)}`).join('\n'),
    ).toEqual([]);
  });
});

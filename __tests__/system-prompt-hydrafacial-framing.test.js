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
});

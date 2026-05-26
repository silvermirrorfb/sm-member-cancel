import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system prompt: HARD RULE forbidding Experience/Support Ambassador titles in member-facing output is present', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/lib/system-prompt.txt'),
    'utf8',
  );

  it('contains the explicit forbid-titles instruction', () => {
    expect(prompt).toMatch(
      /(do NOT use|must not use|never use|do not surface)[\s\S]{0,200}"?Experience Ambassador"?[\s\S]{0,200}"?Support Ambassador"?/i,
    );
  });

  it('contains the HARD RULE block governing fabricated staff names, roles, and connection programs', () => {
    expect(prompt).toMatch(/HARD RULE[\s\S]{0,80}NO FABRICATED STAFF NAMES/i);
  });
});

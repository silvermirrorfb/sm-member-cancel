import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system prompt: zero em dashes or en dashes anywhere in the file', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/lib/system-prompt.txt'),
    'utf8',
  );

  it('contains no em dash characters (U+2014)', () => {
    const offending = prompt
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => text.includes('—'));
    expect(
      offending,
      `Found em dashes on lines: ${offending.map((o) => o.line).join(', ')}.\n` +
        `First offender (line ${offending[0]?.line}): ${offending[0]?.text}`,
    ).toEqual([]);
  });

  it('contains no en dash characters (U+2013)', () => {
    const offending = prompt
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => text.includes('–'));
    expect(
      offending,
      `Found en dashes on lines: ${offending.map((o) => o.line).join(', ')}.`,
    ).toEqual([]);
  });
});

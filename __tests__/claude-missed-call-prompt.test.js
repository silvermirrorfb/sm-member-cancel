import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_TZ = process.env.TZ;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

describe('claude.js missed-call prompt selection', () => {
  it('returns the general prompt for non-missed-call sessions', async () => {
    const { getSystemPromptForSession, loadSystemPrompt } = await import('../src/lib/claude.js');
    const general = loadSystemPrompt();
    const result = getSystemPromptForSession({ session_mode: 'general' });
    expect(result).toBe(general);
  });

  it('returns the saved systemPrompt when present and not missed_call', async () => {
    const { getSystemPromptForSession } = await import('../src/lib/claude.js');
    const result = getSystemPromptForSession({
      session_mode: 'membership',
      systemPrompt: 'CUSTOM MEMBER PROMPT',
    });
    expect(result).toBe('CUSTOM MEMBER PROMPT');
  });

  it('returns the missed-call prompt with location interpolated', async () => {
    const { getSystemPromptForSession } = await import('../src/lib/claude.js');
    const result = getSystemPromptForSession({
      session_mode: 'missed_call',
      location_called: 'brickell',
      caller_phone: '+19175551234',
      missed_call_triggered_at: '2026-04-24T18:30:00Z',
    });
    expect(result).toContain('Silver Mirror Brickell');
    expect(result).toContain('(***) ***-1234');
    // 18:30 UTC = 14:30 ET
    expect(result).toMatch(/2:30/);
    expect(result).toContain('STYLE RULES');
    expect(result).toContain('CALLBACK');
  });

  it('handles unknown location slugs by title-casing the slug', async () => {
    const { getSystemPromptForSession } = await import('../src/lib/claude.js');
    const result = getSystemPromptForSession({
      session_mode: 'missed_call',
      location_called: 'south_beach',
      caller_phone: '+13055559999',
      missed_call_triggered_at: '2026-04-24T18:30:00Z',
    });
    expect(result).toContain('South Beach');
  });

  it('masks short / missing phones safely', async () => {
    const { maskMissedCallPhone } = await import('../src/lib/claude.js');
    expect(maskMissedCallPhone('+19175551234')).toBe('(***) ***-1234');
    expect(maskMissedCallPhone('1234')).toBe('(***) ***-1234');
    expect(maskMissedCallPhone('')).toBe('****');
    expect(maskMissedCallPhone(null)).toBe('****');
    expect(maskMissedCallPhone('abc')).toBe('****');
  });

  it('formats location names from snake_case slugs', async () => {
    const { formatMissedCallLocationName } = await import('../src/lib/claude.js');
    expect(formatMissedCallLocationName('brickell')).toBe('Brickell');
    expect(formatMissedCallLocationName('upper_east_side')).toBe('Upper East Side');
    expect(formatMissedCallLocationName('')).toBe('Silver Mirror');
    expect(formatMissedCallLocationName(null)).toBe('Silver Mirror');
  });

  it('formats call time in the location timezone', async () => {
    const { formatMissedCallTime } = await import('../src/lib/claude.js');
    // 2026-04-24T18:30:00Z = 14:30 ET
    const formatted = formatMissedCallTime('2026-04-24T18:30:00Z', 'brickell');
    expect(formatted).toMatch(/2:30/);
    expect(formatted.toLowerCase()).toMatch(/pm|p\.?m/i);
  });

  it('falls back gracefully when timestamp is invalid', async () => {
    const { formatMissedCallTime } = await import('../src/lib/claude.js');
    expect(formatMissedCallTime('', 'brickell')).toBe('just now');
    expect(formatMissedCallTime(null, 'brickell')).toBe('just now');
    expect(formatMissedCallTime('not-a-date', 'brickell')).toBe('just now');
  });
});

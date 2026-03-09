import { describe, expect, it } from 'vitest';
import {
  getHourInTimeZone,
  isHourInsideWindow,
  isWithinSendWindow,
  parseHour,
} from '../src/lib/sms-window.js';

describe('sms send window helpers', () => {
  it('parses hour with fallback', () => {
    expect(parseHour('9', 1)).toBe(9);
    expect(parseHour(17, 1)).toBe(17);
    expect(parseHour('99', 1)).toBe(1);
    expect(parseHour('x', 1)).toBe(1);
  });

  it('handles inside-window checks for same-day windows', () => {
    expect(isHourInsideWindow(9, 9, 17)).toBe(true);
    expect(isHourInsideWindow(16, 9, 17)).toBe(true);
    expect(isHourInsideWindow(17, 9, 17)).toBe(false);
    expect(isHourInsideWindow(8, 9, 17)).toBe(false);
  });

  it('handles overnight windows', () => {
    expect(isHourInsideWindow(23, 22, 6)).toBe(true);
    expect(isHourInsideWindow(2, 22, 6)).toBe(true);
    expect(isHourInsideWindow(12, 22, 6)).toBe(false);
  });

  it('computes ET hour and send-window decision', () => {
    const hour = getHourInTimeZone('2026-03-09T14:00:00Z', 'America/New_York');
    expect(hour).toBe(10);
    const result = isWithinSendWindow('2026-03-09T14:00:00Z', {
      timeZone: 'America/New_York',
      startHour: 9,
      endHour: 17,
    });
    expect(result.allowed).toBe(true);
    expect(result.hour).toBe(10);
  });
});

import { describe, it, expect } from 'vitest';
import { buildAppointmentWindowQuery } from '../src/lib/boulevard.js';

describe('buildAppointmentWindowQuery', () => {
  it('returns null when no window bounds are provided', () => {
    expect(buildAppointmentWindowQuery({})).toBeNull();
    expect(buildAppointmentWindowQuery({ windowStart: null, windowEnd: null })).toBeNull();
    expect(buildAppointmentWindowQuery()).toBeNull();
  });

  it('builds a >= filter when only windowStart is given', () => {
    const q = buildAppointmentWindowQuery({ windowStart: '2026-04-27T00:00:00.000Z' });
    expect(q).toBe("startAt >= '2026-04-27'");
  });

  it('builds a < filter when only windowEnd is given', () => {
    const q = buildAppointmentWindowQuery({ windowEnd: '2026-04-29T00:00:00.000Z' });
    expect(q).toBe("startAt < '2026-04-29'");
  });

  it('builds an AND range when both bounds are given', () => {
    const q = buildAppointmentWindowQuery({
      windowStart: '2026-04-27T15:00:00.000Z',
      windowEnd: '2026-04-29T15:00:00.000Z',
    });
    expect(q).toBe("startAt >= '2026-04-27' AND startAt < '2026-04-29'");
  });

  it('accepts Date objects', () => {
    const q = buildAppointmentWindowQuery({
      windowStart: new Date('2026-04-27T15:00:00.000Z'),
      windowEnd: new Date('2026-04-29T15:00:00.000Z'),
    });
    expect(q).toBe("startAt >= '2026-04-27' AND startAt < '2026-04-29'");
  });

  it('returns null on invalid inputs', () => {
    expect(buildAppointmentWindowQuery({ windowStart: 'not-a-date' })).toBeNull();
    expect(buildAppointmentWindowQuery({ windowStart: '' })).toBeNull();
  });
});

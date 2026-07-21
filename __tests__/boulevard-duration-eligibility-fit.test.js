import { describe, expect, it } from 'vitest';
import { evaluateUpgradeEligibilityFromAppointments } from '../src/lib/boulevard.js';

// Eligibility requires the FULL resulting block growth. The in-place upgrade keeps the SAME
// service, and Boulevard keeps that service's own cleanup buffer on the line (live-proven
// 2026-07-16 on a real Flatiron booking: a 30-min service with a 45-min block, buffer 15,
// upgraded in place to 50 min -> a 65-min block, buffer still 15). With the buffer invariant,
// the block grows by exactly the service delta: 50 - 30 = 20 more minutes, NOT the old
// tier-buffer model (50+10) - (30+15) = 15, which under-counted by 5 and let a shift-end
// bounded upgrade overrun the provider's shift (live-confirmed 8:00-9:05 vs a 9:00 shift end).
// It must also never assume infinite room when there is no next commitment to bound against.

const member30 = { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' };

describe('duration upgrade eligibility must prove the extension fits', () => {
  it('rejects exactly 15 free minutes: 30->50 grows the block by the 20-min service delta (buffer carries over), so 15 overruns', () => {
    const appointments = [
      { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', startOn: '2026-03-08T10:00:00.000Z', endOn: '2026-03-08T10:30:00.000Z', status: 'BOOKED' },
      // next client starts exactly 15 minutes after this block ends -> 15 free, 5 short of the 20 needed
      { id: 'appt-2', clientId: 'other', providerId: 'prov-1', startOn: '2026-03-08T10:45:00.000Z', endOn: '2026-03-08T11:15:00.000Z', status: 'BOOKED' },
    ];
    const result = evaluateUpgradeEligibilityFromAppointments(appointments, member30, { now: '2026-03-08T08:00:00.000Z', windowHours: 6 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('insufficient_gap');
    expect(result.requiredExtraMinutes).toBe(20);
    expect(result.availableGapMinutes).toBe(15);
  });

  it('rejects 19 free minutes: one minute short of the 20-min block growth', () => {
    const appointments = [
      { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', startOn: '2026-03-08T10:00:00.000Z', endOn: '2026-03-08T10:30:00.000Z', status: 'BOOKED' },
      // next client starts 19 minutes after this block ends -> 19 free, one short
      { id: 'appt-2', clientId: 'other', providerId: 'prov-1', startOn: '2026-03-08T10:49:00.000Z', endOn: '2026-03-08T11:19:00.000Z', status: 'BOOKED' },
    ];
    const result = evaluateUpgradeEligibilityFromAppointments(appointments, member30, { now: '2026-03-08T08:00:00.000Z', windowHours: 6 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('insufficient_gap');
    expect(result.requiredExtraMinutes).toBe(20);
    expect(result.availableGapMinutes).toBe(19);
  });

  it('allows exactly 20 free minutes: the full block growth fits', () => {
    const appointments = [
      { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', startOn: '2026-03-08T10:00:00.000Z', endOn: '2026-03-08T10:30:00.000Z', status: 'BOOKED' },
      // next client starts exactly 20 minutes after the block ends -> exactly enough
      { id: 'appt-2', clientId: 'other', providerId: 'prov-1', startOn: '2026-03-08T10:50:00.000Z', endOn: '2026-03-08T11:20:00.000Z', status: 'BOOKED' },
    ];
    const result = evaluateUpgradeEligibilityFromAppointments(appointments, member30, { now: '2026-03-08T08:00:00.000Z', windowHours: 6 });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.requiredExtraMinutes).toBe(20);
    expect(result.availableGapMinutes).toBe(20);
  });

  it('allows ample room (25 free, more than the 20 needed) for a 30->50 upgrade', () => {
    const appointments = [
      { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', startOn: '2026-03-08T10:00:00.000Z', endOn: '2026-03-08T10:30:00.000Z', status: 'BOOKED' },
      { id: 'appt-2', clientId: 'other', providerId: 'prov-1', startOn: '2026-03-08T10:55:00.000Z', endOn: '2026-03-08T11:25:00.000Z', status: 'BOOKED' },
    ];
    const result = evaluateUpgradeEligibilityFromAppointments(appointments, member30, { now: '2026-03-08T08:00:00.000Z', windowHours: 6 });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.requiredExtraMinutes).toBe(20);
    expect(result.availableGapMinutes).toBe(25);
  });

  it('skips (does not offer) when there is no next commitment and no close data to bound the gap', () => {
    const appointments = [
      { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', startOn: '2026-03-08T10:00:00.000Z', endOn: '2026-03-08T10:30:00.000Z', status: 'BOOKED' },
    ];
    const result = evaluateUpgradeEligibilityFromAppointments(appointments, member30, { now: '2026-03-08T08:00:00.000Z', windowHours: 6 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('gap_unprovable');
  });
});

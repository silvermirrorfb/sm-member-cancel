import { describe, expect, it } from 'vitest';
import { evaluateUpgradeEligibilityFromAppointments } from '../src/lib/boulevard.js';

// Eligibility requires the BLOCK extension: a 30-min facial occupies a 45-min block
// (30 + PREP_BUFFER_30MIN=15) and a 50-min facial a 60-min block (50 + PREP_BUFFER_50MIN=10),
// so 30->50 needs 60-45 = 15 more minutes (derived from the prep buffers), NOT the 20-minute
// service delta. It must also never assume infinite room when there is no next commitment to
// bound against (we cannot prove the extension fits without location-hours/shift data).

const member30 = { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' };

describe('duration upgrade eligibility must prove the extension fits', () => {
  it('allows exactly 15 free minutes: 30->50 needs the 15-min BLOCK extension, not the 20-min service delta', () => {
    const appointments = [
      { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', startOn: '2026-03-08T10:00:00.000Z', endOn: '2026-03-08T10:30:00.000Z', status: 'BOOKED' },
      // next client starts exactly 15 minutes after this block ends -> 15 free, which now fits
      { id: 'appt-2', clientId: 'other', providerId: 'prov-1', startOn: '2026-03-08T10:45:00.000Z', endOn: '2026-03-08T11:15:00.000Z', status: 'BOOKED' },
    ];
    const result = evaluateUpgradeEligibilityFromAppointments(appointments, member30, { now: '2026-03-08T08:00:00.000Z', windowHours: 6 });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.requiredExtraMinutes).toBe(15);
    expect(result.availableGapMinutes).toBe(15);
  });

  it('rejects 14 free minutes: one minute short of the 15-min block extension', () => {
    const appointments = [
      { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', startOn: '2026-03-08T10:00:00.000Z', endOn: '2026-03-08T10:30:00.000Z', status: 'BOOKED' },
      // next client starts 14 minutes after this block ends -> 14 free, one short
      { id: 'appt-2', clientId: 'other', providerId: 'prov-1', startOn: '2026-03-08T10:44:00.000Z', endOn: '2026-03-08T11:14:00.000Z', status: 'BOOKED' },
    ];
    const result = evaluateUpgradeEligibilityFromAppointments(appointments, member30, { now: '2026-03-08T08:00:00.000Z', windowHours: 6 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('insufficient_gap');
    expect(result.requiredExtraMinutes).toBe(15);
    expect(result.availableGapMinutes).toBe(14);
  });

  it('allows ample room (20 free, more than the 15 needed) for a 30->50 upgrade', () => {
    const appointments = [
      { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', startOn: '2026-03-08T10:00:00.000Z', endOn: '2026-03-08T10:30:00.000Z', status: 'BOOKED' },
      // next client starts 20 minutes after the block ends -> exactly enough
      { id: 'appt-2', clientId: 'other', providerId: 'prov-1', startOn: '2026-03-08T10:50:00.000Z', endOn: '2026-03-08T11:20:00.000Z', status: 'BOOKED' },
    ];
    const result = evaluateUpgradeEligibilityFromAppointments(appointments, member30, { now: '2026-03-08T08:00:00.000Z', windowHours: 6 });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.requiredExtraMinutes).toBe(15);
    expect(result.availableGapMinutes).toBe(20);
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

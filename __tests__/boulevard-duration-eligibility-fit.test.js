import { describe, expect, it } from 'vitest';
import { evaluateUpgradeEligibilityFromAppointments } from '../src/lib/boulevard.js';

// Eligibility requires the BLOCK extension: a 30-min facial occupies a 45-min block
// (30 + PREP_BUFFER_30MIN=15) and a 50-min facial a 60-min block (50 + PREP_BUFFER_50MIN=10),
// so 30->50 needs 60-45 = 15 more minutes (derived from the prep buffers), NOT the 20-minute
// service delta. It must also never assume infinite room when there is no next commitment to
// bound against (we cannot prove the extension fits without location-hours/shift data).

const member30 = { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' };

describe('duration upgrade eligibility must prove the extension fits', () => {
  it('rejects a 45-minute room (30 booked + 15 free) because 30->50 needs 20 added minutes', () => {
    const appointments = [
      { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', startOn: '2026-03-08T10:00:00.000Z', endOn: '2026-03-08T10:30:00.000Z', status: 'BOOKED' },
      // next client starts 15 minutes after the 30-min block ends -> only 15 free
      { id: 'appt-2', clientId: 'other', providerId: 'prov-1', startOn: '2026-03-08T10:45:00.000Z', endOn: '2026-03-08T11:15:00.000Z', status: 'BOOKED' },
    ];
    const result = evaluateUpgradeEligibilityFromAppointments(appointments, member30, { now: '2026-03-08T08:00:00.000Z', windowHours: 6 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('insufficient_gap');
    expect(result.requiredExtraMinutes).toBe(20);
    expect(result.availableGapMinutes).toBe(15);
  });

  it('allows a 50-minute room (30 booked + exactly 20 free) for a 30->50 upgrade', () => {
    const appointments = [
      { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', startOn: '2026-03-08T10:00:00.000Z', endOn: '2026-03-08T10:30:00.000Z', status: 'BOOKED' },
      // next client starts 20 minutes after the block ends -> exactly enough
      { id: 'appt-2', clientId: 'other', providerId: 'prov-1', startOn: '2026-03-08T10:50:00.000Z', endOn: '2026-03-08T11:20:00.000Z', status: 'BOOKED' },
    ];
    const result = evaluateUpgradeEligibilityFromAppointments(appointments, member30, { now: '2026-03-08T08:00:00.000Z', windowHours: 6 });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.requiredExtraMinutes).toBe(20);
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

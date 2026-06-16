// __tests__/upgrade-pricing.test.js
import { describe, it, expect, vi } from 'vitest';
import { resolveUpgradePrice, MEMBER_50_MIN_TOTAL } from '../src/lib/upgrade-pricing.js';
import { CURRENT_RATES } from '../src/lib/boulevard.js';

describe('resolveUpgradePrice', () => {
  // Active member with a confirmed 30-minute tier.
  const member30 = (monthlyRate) => ({
    clientId: 'client-1', hasMembership: true, accountStatus: 'ACTIVE', tier: '30', monthlyRate,
  });

  it('prices a $99 30-min member at +$40, total $139', () => {
    expect(resolveUpgradePrice(member30(99))).toEqual({ deltaDollars: 40, totalDollars: 139, isMember: true });
  });

  it('prices a grandfathered $79 30-min member at +$60', () => {
    expect(resolveUpgradePrice(member30(79))).toEqual({ deltaDollars: 60, totalDollars: 139, isMember: true });
  });

  it('SKIPS a $129 50-min member (the Taylor case; must never price a non-30-min member)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const taylor = { clientId: 'taylor', hasMembership: true, accountStatus: 'ACTIVE', tier: '50', monthlyRate: 129 };
    expect(resolveUpgradePrice(taylor)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('SKIPS an active member whose tier cannot be resolved', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noTier = { clientId: 'c', hasMembership: true, accountStatus: 'ACTIVE', tier: null, monthlyRate: 99 };
    expect(resolveUpgradePrice(noTier)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('FAILS CLOSED (returns null) when a 30-min member rate is unresolvable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUpgradePrice(member30(null))).toBeNull();
    expect(resolveUpgradePrice(member30(undefined))).toBeNull();
    expect(resolveUpgradePrice(member30(0))).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips (returns null) when the 30-min member delta is <= 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUpgradePrice(member30(139))).toBeNull(); // delta 0
    expect(resolveUpgradePrice(member30(150))).toBeNull(); // floored to 0
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('prices a non-member at a flat +$50, total $169', () => {
    const nonMember = { clientId: 'c2', hasMembership: false, accountStatus: null, tier: null };
    expect(resolveUpgradePrice(nonMember)).toEqual({ deltaDollars: 50, totalDollars: 169, isMember: false });
  });

  it('ignores any stray rate on a non-member (flat $50/$169)', () => {
    const repeatNonMember = { clientId: 'c3', hasMembership: false, tier: null, monthlyRate: 119 };
    expect(resolveUpgradePrice(repeatNonMember)).toEqual({ deltaDollars: 50, totalDollars: 169, isMember: false });
  });

  it('treats a cancelled member as a non-member (flat $50/$169)', () => {
    const cancelled = { clientId: 'c4', hasMembership: true, accountStatus: 'CANCELLED', tier: '30', monthlyRate: 99 };
    expect(resolveUpgradePrice(cancelled)).toEqual({ deltaDollars: 50, totalDollars: 169, isMember: false });
  });

  it('keeps the member total in sync with the canonical rate table (drift guard)', () => {
    expect(MEMBER_50_MIN_TOTAL).toBe(CURRENT_RATES['50']);
  });
});

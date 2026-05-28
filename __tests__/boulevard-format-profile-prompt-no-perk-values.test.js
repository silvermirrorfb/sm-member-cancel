import { describe, it, expect } from 'vitest';
import { formatProfileForPrompt } from '../src/lib/boulevard.js';

// These tests cover the runtime member-profile injection path. Codex's review of
// the decision-audit branch (commit ac3769e) flagged that the prompt-only HARD RULE
// - NO PERK DOLLAR VALUES (added in Phase 4, commit 5980dbc) doesn't reach the
// runtime-injected profile data. formatProfileForPrompt was emitting "Next Perk
// Milestone: ... ($XX value)" and "Loyalty Redeemable: ... = $XX value" annotations,
// and HARD RULE #22 tells the bot to use those injected fields, so members were
// still seeing the unverified dollar amounts the static-table strip was supposed
// to remove.

function baseProfile(overrides = {}) {
  return {
    name: 'Sample Member',
    email: 'sample@test.com',
    phone: '555-1234',
    location: 'Flatiron',
    clientSince: '2023-09-01',
    tier: '50',
    monthlyRate: 99,
    memberSince: 'September 2023',
    tenureMonths: 8,
    nextChargeDate: '2026-06-01',
    accountStatus: 'active',
    appointmentCount: 12,
    totalDuesPaid: 792,
    totalRetailPurchases: 240,
    totalAddonPurchases: 80,
    facialsRedeemed: 10,
    avgVisitsPerMonth: 1.2,
    lastVisitDate: '2026-05-20',
    mostPurchasedAddon: 'Custom Jelly Mask',
    upcomingAppointments: [],
    loyaltyEnrolled: true,
    loyaltyPoints: 1200,
    unusedCredits: 1,
    lastBillDate: '2026-05-01',
    perksClaimed: ['Month 2: Moisturizer'],
    computed: {
      currentNewMemberRate: 99,
      rateDiff: 0,
      rateLockAnnual: 0,
      memberDiscountSavingsTotal: 158,
      discountSavingsConfidence: 'estimated_simple_20pct',
      serviceDiscountSavings: 80,
      retailDiscountSavings: 48,
      addonDiscountSavings: 16,
      simpleTwentyPctSavingsEstimate: 158,
      excludedFirstTimePromoDiscounts: 0,
      walkinSavings: 200,
      walkinPrice: 139,
      ...overrides.computed,
    },
    ...overrides,
  };
}

describe('formatProfileForPrompt: HARD RULE - NO PERK DOLLAR VALUES enforcement at runtime', () => {
  describe('Loyalty Redeemable line', () => {
    it('does not emit "= $XX value" retail-equivalent annotation', () => {
      const profile = baseProfile({
        computed: {
          loyaltyRedeemable: { service: 'Custom Jelly Mask', points: 1000, value: 50 },
        },
      });
      const output = formatProfileForPrompt(profile);
      expect(output).toMatch(/Loyalty Redeemable: Custom Jelly Mask \(1000 points\)/);
      expect(output).not.toMatch(/\$50 value/);
      expect(output).not.toMatch(/= \$\d+ value/);
    });

    it('keeps point cost and service name (operational truth)', () => {
      const profile = baseProfile({
        computed: {
          loyaltyRedeemable: { service: 'Dermaplaning', points: 3000, value: 95 },
        },
      });
      const output = formatProfileForPrompt(profile);
      expect(output).toMatch(/Loyalty Redeemable: Dermaplaning \(3000 points\)/);
      expect(output).not.toMatch(/\$95 value/);
    });

    it('emits no Loyalty Redeemable line when loyaltyRedeemable is missing', () => {
      const profile = baseProfile({ computed: { loyaltyRedeemable: null } });
      const output = formatProfileForPrompt(profile);
      expect(output).not.toMatch(/Loyalty Redeemable:/);
    });
  });

  describe('Next Perk Milestone line', () => {
    it('does not emit "($XX value)" annotation for a retail-style perk', () => {
      const profile = baseProfile({
        computed: {
          nextPerk: { month: 9, name: 'Cleanser', value: 41, type: 'retail' },
        },
      });
      const output = formatProfileForPrompt(profile);
      expect(output).toMatch(/Next Perk Milestone: Month 9, Cleanser/);
      expect(output).not.toMatch(/\$41 value/);
      expect(output).not.toMatch(/\(\$\d+ value\)/);
    });

    it('does not emit "($XX value)" for any value of XX', () => {
      const samples = [
        { month: 2, name: 'Moisturizer', value: 65 },
        { month: 4, name: 'Hyaluronic Acid Serum', value: 77 },
        { month: 5, name: 'Silver Mirror Hat', value: 30 },
        { month: 12, name: 'Foundational Formulas Bundle', value: 183 },
        { month: 18, name: 'Signature Mask', value: 69 },
        { month: 24, name: 'Dermaplaning + retail bundle', value: 125 },
      ];
      for (const nextPerk of samples) {
        const output = formatProfileForPrompt(baseProfile({ computed: { nextPerk } }));
        expect(output).not.toMatch(new RegExp(`\\$${nextPerk.value} value`));
        expect(output).not.toMatch(/\(\$\d+ value\)/);
        expect(output).toMatch(new RegExp(`Next Perk Milestone: Month ${nextPerk.month}, ${nextPerk.name.replace(/[.+*?^$()|[\]\\]/g, '\\$&')}`));
      }
    });

    it('preserves Enhancement Credit dollar amount as part of perk identity (not a value annotation)', () => {
      const profile = baseProfile({
        computed: {
          nextPerk: { month: 22, name: '$50 Enhancement Credit', value: 50, type: 'credit' },
        },
      });
      const output = formatProfileForPrompt(profile);
      expect(output).toMatch(/Next Perk Milestone: Month 22, \$50 Enhancement Credit/);
      // No "($50 value)" suffix
      expect(output).not.toMatch(/\(\$50 value\)/);
    });

    it('preserves mid-year Enhancement Credit dollar in name and converts em dashes to commas', () => {
      const profile = baseProfile({
        computed: {
          nextPerk: { month: 42, name: 'Year 3.5 Mid-Year — $50 Enhancement Credit', value: 50, type: 'credit' },
        },
      });
      const output = formatProfileForPrompt(profile);
      // Em dash inside the perk name gets defensively replaced with comma
      expect(output).toMatch(/Next Perk Milestone: Month 42, Year 3\.5 Mid-Year, \$50 Enhancement Credit/);
      expect(output).not.toMatch(/[–—]/);
    });

    it('formats Months Until Next Perk correctly', () => {
      const profile = baseProfile({
        tenureMonths: 5,
        computed: {
          nextPerk: { month: 9, name: 'Cleanser', value: 41, type: 'retail' },
        },
      });
      const output = formatProfileForPrompt(profile);
      expect(output).toMatch(/Months Until Next Perk: 4/);
    });

    it('emits no Next Perk Milestone line when nextPerk is missing', () => {
      const profile = baseProfile({ computed: { nextPerk: null } });
      const output = formatProfileForPrompt(profile);
      expect(output).not.toMatch(/Next Perk Milestone:/);
    });
  });

  describe('em-dash defense across the runtime-injected profile', () => {
    it('replaces em dashes in any perk name with commas (defensive)', () => {
      const profile = baseProfile({
        computed: {
          nextPerk: { month: 60, name: 'Year 5 Anniversary — 90-Min Upgrade or Hydradermabrasion', value: 279, type: 'service_upgrade' },
        },
      });
      const output = formatProfileForPrompt(profile);
      expect(output).toMatch(/Year 5 Anniversary, 90-Min Upgrade or Hydradermabrasion/);
      expect(output).not.toMatch(/[–—]/);
    });

    it('replaces en dashes the same way', () => {
      const profile = baseProfile({
        computed: {
          nextPerk: { month: 84, name: 'Year 7 Anniversary – Pick add-on + Foundational Bundle', value: 233 },
        },
      });
      const output = formatProfileForPrompt(profile);
      expect(output).toMatch(/Year 7 Anniversary, Pick add-on \+ Foundational Bundle/);
      expect(output).not.toMatch(/[–—]/);
    });
  });

  describe('end-to-end: no banned $XX value pattern in any field of the rendered profile', () => {
    it('scans the full output for $XX value patterns', () => {
      const profile = baseProfile({
        computed: {
          loyaltyRedeemable: { service: 'Custom Jelly Mask', points: 1000, value: 50 },
          loyaltyNextTier: { pointsNeeded: 800, service: 'Gua Sha Massage' },
          nextPerk: { month: 9, name: 'Cleanser', value: 41, type: 'retail' },
        },
      });
      const output = formatProfileForPrompt(profile);
      // No "$XX value" or "= $XX value" pattern in any line of the output
      expect(output).not.toMatch(/\$\d+ value/);
      expect(output).not.toMatch(/= \$\d+ value/);
    });
  });
});

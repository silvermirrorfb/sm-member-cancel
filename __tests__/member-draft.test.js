import { describe, it, expect } from 'vitest';
import { buildMemberDraft } from '../src/lib/member-draft.js';

const baseSummary = {
  client_name: 'Kayla Ponturo',
  email: 'kponturo@gmail.com',
  phone: '+19084725214',
  location: 'Upper East Side',
  membership_tier: '50-Minute',
  monthly_rate: '139',
  tenure_months: 0,
  loyalty_points: 'unknown',
  unused_credits: 'unknown',
  next_perk: 'Month 2: Moisturizer ($65)',
};

describe('buildMemberDraft — outcome routing', () => {
  it('routes CANCELLED + Cost reason + no offer accepted to a cancellation template (regression: Kayla Ponturo, 2026-04-25)', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: 'Cost Overwhelming',
      offer_accepted: 'None',
    });

    expect(draft.templateId).not.toBe('29-cost-pause');
    expect(draft.subject).toMatch(/cancellation/i);
    expect(draft.body).not.toMatch(/paused/i);
  });

  it('routes CANCELLED + Voucher reason + no offer accepted to a cancellation template', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: 'Voucher Build-Up',
      offer_accepted: 'None',
    });

    expect(draft.templateId).not.toBe('27-voucher-pause');
    expect(draft.subject).toMatch(/cancellation/i);
  });

  it('routes CANCELLED + Travel reason + no offer accepted to a cancellation template (no travel-cancel template exists)', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: 'Travel',
      offer_accepted: 'None',
    });

    expect(draft.templateId).not.toBe('01-travel-pause');
    expect(draft.subject).toMatch(/cancellation/i);
  });

  it('still routes RETAINED + Cost + Downgrade accepted to the downgrade template', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Cost Overwhelming',
      offer_accepted: 'Downgrade to 30-Minute',
    });

    expect(draft.templateId).toBe('28-cost-downgrade');
  });

  it('still routes RETAINED + Cost + Pause accepted to the pause template', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Cost Overwhelming',
      offer_accepted: 'Pause for 2 months',
    });

    expect(draft.templateId).toBe('29-cost-pause');
  });

  it('still routes RETAINED + Travel + Pause accepted to the travel-pause template', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Travel',
      offer_accepted: 'Pause for trip',
    });

    expect(draft.templateId).toBe('01-travel-pause');
  });
});

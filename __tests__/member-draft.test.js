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

  it('routes RETAINED + Inconsistent Usage + Pause accepted to the pause template, Emily case', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      client_name: 'Emily Merghart',
      outcome: 'RETAINED',
      reason_primary: 'Inconsistent Usage',
      offer_accepted: 'Pause for 1 month',
    });

    expect(draft.templateId).toBe('29-cost-pause');
  });

  it('routes RETAINED + Inconsistent Usage + no offer accepted to the inconsistent lead template', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Inconsistent Usage',
      offer_accepted: 'None',
    });

    expect(draft.templateId).toBe('35-inconsistent-lead');
  });

  it('routes RETAINED + Cost + Bi-monthly accepted to the bi-monthly template', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Cost Overwhelming',
      offer_accepted: 'Bi-monthly billing',
    });

    expect(draft.templateId).toBe('30-cost-bimonthly');
  });

  it('routes REFERRED + milestone inquiry to manual review without cancellation copy, Zoe Dickinson case', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      client_name: 'Zoe Dickinson',
      outcome: 'REFERRED',
      reason_primary: 'Missing milestone rewards due to multiple account transitions',
      offers_presented: 'None',
      offer_accepted: 'None',
    });

    expect(draft.templateId).toBe('43-referred-manual-review');
    expect(draft.subject).toBe('Your Silver Mirror membership inquiry');
    expect(draft.templateId).not.toBe('39-location-cancel');
    expect(draft.subject).not.toMatch(/cancellation is confirmed|Your Silver Mirror membership cancellation/i);
  });

  it('offers a 30-minute member bi-monthly at $99, not their grandfathered monthly price', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      membership_tier: '30-Minute',
      monthly_rate: '79',
      outcome: 'RETAINED',
      reason_primary: 'Cost Overwhelming',
      offer_accepted: 'Bi-monthly billing',
    });

    expect(draft.body).toContain('$99');
    expect(draft.body).not.toContain('$79');
  });

  it('offers a 50-minute member bi-monthly at $169, not their grandfathered monthly price', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      membership_tier: '50-Minute',
      monthly_rate: '139',
      outcome: 'RETAINED',
      reason_primary: 'Cost Overwhelming',
      offer_accepted: 'Bi-monthly billing',
    });

    expect(draft.body).toContain('$169');
    expect(draft.body).not.toContain('$139');
  });

  it('shows both current bi-monthly prices when membership duration is unknown', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      membership_tier: 'Unknown',
      monthly_rate: '79',
      outcome: 'RETAINED',
      reason_primary: 'Cost Overwhelming',
      offer_accepted: 'Bi-monthly billing',
    });

    expect(draft.body).toContain('$99 for 30-minute facials');
    expect(draft.body).toContain('$169 for 50-minute facials');
    expect(draft.body).not.toContain('$79');
  });

  it('does not describe the generated bi-monthly offer as grandfathered or current rate', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      membership_tier: '30-Minute',
      monthly_rate: '79',
      outcome: 'RETAINED',
      reason_primary: 'Cost Overwhelming',
      offer_accepted: 'Bi-monthly billing',
    });

    expect(draft.body).not.toMatch(/grandfathered|current rate/i);
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

describe('pickTemplate: reason matching does not catch substrings', () => {
  it('a CANCELLED milestone-rewards reason ("...account TRANSITIONS") does not pick the location/transit template', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: 'Missing milestone rewards due to multiple account TRANSITIONS',
      offer_accepted: 'None',
    });
    expect(draft.templateId).not.toBe('39-location-cancel');
    expect(draft.templateId).not.toBe('38-parking-transit');
    expect(draft.templateId).toBe('42-generic-cancelled');
  });

  it('a RETAINED milestone-rewards reason with no offer falls through to the generic template, not transit', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Missing milestone rewards due to multiple account transitions',
      offer_accepted: 'None',
    });
    expect(draft.templateId).not.toBe('39-location-cancel');
    expect(draft.templateId).not.toBe('38-parking-transit');
    expect(draft.templateId).toBe('42-generic-cancelled');
  });

  it('a real transit reason still picks the location-cancel template (positive regression)', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: 'public transit to this location is unreliable',
      offer_accepted: 'None',
    });
    expect(draft.templateId).toBe('39-location-cancel');
  });

  it('a real "moving" reason still picks the relocation-cancel template', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: "I'm moving to Denver",
      offer_accepted: 'None',
    });
    expect(draft.templateId).toBe('02-relocation-cancel');
  });

  it('"removing" does not false-match the relocation regex', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: 'removing myself from the program',
      offer_accepted: 'None',
    });
    expect(draft.templateId).not.toBe('02-relocation-cancel');
    expect(draft.templateId).toBe('42-generic-cancelled');
  });
});

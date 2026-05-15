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

  it('routes RETAINED + Travel + Bi-monthly accepted to the bi-monthly template, NOT travel-pause (regression: Rose Williamson, 2026-05-06)', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      client_name: 'Rose Williamson',
      outcome: 'RETAINED',
      reason_primary: 'Travel',
      offer_accepted: 'Bi-monthly billing',
    });

    expect(draft.templateId).toBe('30-cost-bimonthly');
    expect(draft.templateId).not.toBe('01-travel-pause');
    expect(draft.subject).toMatch(/bi-monthly/i);
    expect(draft.subject).not.toMatch(/pause/i);
    expect(draft.body).not.toMatch(/paused/i);
  });

  it('routes RETAINED + Travel + Bi-monthly with pause mentioned in offer_accepted string to bi-monthly (Rose Williamson full-text variant)', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      client_name: 'Rose Williamson',
      outcome: 'RETAINED',
      reason_primary: 'Travel',
      offer_accepted: 'Bi-monthly billing (instead of 2-month pause)',
    });

    expect(draft.templateId).toBe('30-cost-bimonthly');
    expect(draft.templateId).not.toBe('01-travel-pause');
    expect(draft.subject).toMatch(/bi-monthly/i);
    expect(draft.subject).not.toMatch(/pause/i);
  });

  it('routes RETAINED + Travel + Downgrade accepted to the downgrade template, NOT travel-pause', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Travel',
      offer_accepted: 'Downgrade to 30-Minute',
    });

    expect(draft.templateId).toBe('28-cost-downgrade');
    expect(draft.templateId).not.toBe('01-travel-pause');
  });

  it('routes RETAINED + Travel + Transfer accepted to the relocation-any-location template', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Travel',
      offer_accepted: 'Use any Silver Mirror location',
    });

    expect(draft.templateId).toBe('relocation-any-location');
    expect(draft.templateId).not.toBe('01-travel-pause');
  });

  it('routes RETAINED + Travel + no offer accepted to travel-pause as reason fallback', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Travel',
      offer_accepted: 'None',
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

describe('buildMemberDraft — placeholder string sanitization', () => {
  // Regression: Sindhura Polepalli, 2026-05-10. The session summary's
  // unused_credits field arrived as the literal string "5 (missing from
  // display)" because the bot could not verify the count. That string
  // interpolated raw into the member-facing email body as
  // "Your existing credits (5 (missing from display)) are usable for 90
  // days from your last charge date." (QA_ISSUES cancel-bot #19 part 2.)

  it('strips the "missing from display" placeholder from a CANCELLED relocation draft', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      client_name: 'Sindhura Polepalli',
      outcome: 'CANCELLED',
      reason_primary: 'moving to Austin',
      offer_accepted: 'None',
      unused_credits: '5 (missing from display)',
    });

    expect(draft.body).not.toMatch(/missing from display/i);
    expect(draft.body).not.toContain('(5 (');
    expect(draft.body).not.toMatch(/\([^()]*\([^()]*\)[^()]*\)/);
    expect(draft.body).toMatch(/existing credits are usable for 90 days/i);
  });

  it('strips the "missing from display" placeholder from every credits-bearing template', () => {
    const cases = [
      { outcome: 'RETAINED', reason_primary: 'Travel', offer_accepted: 'Pause for trip' },
      { outcome: 'RETAINED', reason_primary: 'moving cities', offer_accepted: 'Use any Silver Mirror location' },
      { outcome: 'CANCELLED', reason_primary: 'moving to Austin', offer_accepted: 'None' },
      { outcome: 'RETAINED', reason_primary: 'medical issue', offer_accepted: 'Pause for surgery' },
      { outcome: 'RETAINED', reason_primary: 'lost my job', offer_accepted: 'Pause' },
      { outcome: 'CANCELLED', reason_primary: 'lost my job', offer_accepted: 'None' },
      { outcome: 'RETAINED', reason_primary: 'Cost Overwhelming', offer_accepted: 'Downgrade to 30-Minute' },
      { outcome: 'RETAINED', reason_primary: 'Cost Overwhelming', offer_accepted: 'Pause for 2 months' },
      { outcome: 'RETAINED', reason_primary: 'forgot about it', offer_accepted: 'Pause' },
      { outcome: 'RETAINED', reason_primary: 'forgot about it', offer_accepted: 'Downgrade' },
      { outcome: 'RETAINED', reason_primary: 'voucher build-up', offer_accepted: 'Convert credits to product' },
      { outcome: 'RETAINED', reason_primary: 'voucher build-up', offer_accepted: 'Pause' },
      { outcome: 'CANCELLED', reason_primary: 'seeing a dermatologist', offer_accepted: 'None' },
      { outcome: 'CANCELLED', reason_primary: 'found a new spa', offer_accepted: 'None' },
      { outcome: 'CANCELLED', reason_primary: 'parking is terrible', offer_accepted: 'None' },
      { outcome: 'CANCELLED', reason_primary: 'just done', offer_accepted: 'None' },
    ];

    for (const c of cases) {
      const draft = buildMemberDraft({
        ...baseSummary,
        ...c,
        unused_credits: '5 (missing from display)',
      });
      expect(draft.body, `template ${draft.templateId} leaked placeholder`).not.toMatch(/missing from display/i);
      expect(draft.body, `template ${draft.templateId} has nested parens`).not.toMatch(/\([^()]*\([^()]*\)[^()]*\)/);
      expect(draft.body, `template ${draft.templateId} has stray "(5 ("`).not.toContain('(5 (');
    }
  });

  it('strips "unknown" from the unused_credits field in a RETAINED draft', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Travel',
      offer_accepted: 'Pause for trip',
      unused_credits: 'unknown',
    });

    expect(draft.body).not.toMatch(/\(unknown\)/i);
    expect(draft.body).not.toMatch(/credits \(unknown/i);
    expect(draft.body).toMatch(/any existing credits will expire or roll over/i);
  });

  it('strips "TBD" from the unused_credits field', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: 'moving',
      offer_accepted: 'None',
      unused_credits: 'TBD',
    });

    expect(draft.body).not.toMatch(/\(TBD\)/i);
    expect(draft.body).toMatch(/existing credits are usable for 90 days/i);
  });

  it('omits the credits parenthetical when the value is an empty string', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: 'moving',
      offer_accepted: 'None',
      unused_credits: '',
    });

    expect(draft.body).toMatch(/existing credits are usable for 90 days/i);
    expect(draft.body).not.toMatch(/credits \(\)/);
  });

  it('omits the credits parenthetical when the value is undefined', () => {
    const summary = { ...baseSummary };
    delete summary.unused_credits;
    const draft = buildMemberDraft({
      ...summary,
      outcome: 'CANCELLED',
      reason_primary: 'moving',
      offer_accepted: 'None',
    });

    expect(draft.body).toMatch(/existing credits are usable for 90 days/i);
    expect(draft.body).not.toMatch(/credits \(\)/);
    expect(draft.body).not.toMatch(/\(undefined\)/i);
  });

  it('renders a clean credits parenthetical when the value is "0"', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: 'moving',
      offer_accepted: 'None',
      unused_credits: '0',
    });

    expect(draft.body).toMatch(/existing credits \(0\) are usable for 90 days/i);
    expect(draft.body).not.toMatch(/missing from display/i);
  });

  it('renders a clean credits parenthetical when the value is "3"', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'CANCELLED',
      reason_primary: 'moving',
      offer_accepted: 'None',
      unused_credits: '3',
    });

    expect(draft.body).toMatch(/existing credits \(3\) are usable for 90 days/i);
    expect(draft.body).not.toMatch(/missing from display/i);
  });

  it('renders "3 credits" cleanly in the voucher-credit conversion template', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'voucher build-up',
      offer_accepted: 'Convert credits to product credit',
      unused_credits: '3',
    });

    expect(draft.templateId).toBe('26-voucher-credit');
    expect(draft.body).toMatch(/converted your 3 credits to product credit/i);
  });

  it('falls back to "remaining credits" wording when voucher-credit value is a placeholder', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'voucher build-up',
      offer_accepted: 'Convert credits to product credit',
      unused_credits: '5 (missing from display)',
    });

    expect(draft.templateId).toBe('26-voucher-credit');
    expect(draft.body).toMatch(/converted your remaining credits to product credit/i);
    expect(draft.body).not.toMatch(/missing from display/i);
    expect(draft.body).not.toContain('(5 (');
  });

  it('preserves a legitimate Loyalty Points value when "unknown" appears in unused_credits (loyalty_points is not interpolated)', () => {
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Travel',
      offer_accepted: 'Pause for trip',
      loyalty_points: '1360',
      unused_credits: 'unknown',
    });

    expect(draft.body).not.toMatch(/\(unknown points\)/i);
    expect(draft.body).not.toMatch(/\(unknown\)/i);
  });

  it('legitimate "Matches current" string in a non-credits field never reaches the body unsanitized', () => {
    // Sanity check: even though "Matches current" is not a placeholder, the
    // sanitization layer keys off the unused_credits field specifically and
    // does not strip values from fields we do not interpolate.
    const draft = buildMemberDraft({
      ...baseSummary,
      outcome: 'RETAINED',
      reason_primary: 'Cost Overwhelming',
      offer_accepted: 'Bi-monthly billing',
      rate_lock_savings: 'Matches current',
    });

    expect(draft.templateId).toBe('30-cost-bimonthly');
    expect(draft.body).not.toMatch(/missing from display/i);
  });

  it('Sindhura full-case regression: REFERRED + Technical Issue with placeholder credits produces a coherent body', () => {
    // REFERRED routes to 43-referred-manual-review which does not interpolate
    // credits at all, so the placeholder cannot leak through this template
    // path post-PR #8. This test pins the contract.
    const draft = buildMemberDraft({
      ...baseSummary,
      client_name: 'Sindhura Polepalli',
      outcome: 'REFERRED',
      reason_primary: 'Technical Issue with credits',
      offer_accepted: 'None',
      unused_credits: '5 (missing from display)',
    });

    expect(draft.templateId).toBe('43-referred-manual-review');
    expect(draft.body).not.toMatch(/missing from display/i);
    expect(draft.body).not.toContain('(5 (');
  });
});

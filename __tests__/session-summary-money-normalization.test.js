import { describe, it, expect } from 'vitest';
import { parseSessionSummary } from '../src/lib/claude.js';

// Regression: the model sometimes emits monthly_rate / next_perk_value already
// "$"-prefixed. The email + draft templates also prepend "$", which rendered
// "$$139" / "$$30" in the Donna Sommer summary (2026-05-20). parseSessionSummary
// must strip a leading "$" so a single template-level "$" renders correctly.

function wrap(obj) {
  return `<session_summary>${JSON.stringify(obj)}</session_summary>`;
}

const base = {
  outcome: 'REFERRED',
  client_name: 'Donna Sommer',
  reason_primary: 'Travel',
};

describe('parseSessionSummary money-field normalization', () => {
  it('strips a leading $ from monthly_rate', () => {
    const summary = parseSessionSummary(wrap({ ...base, monthly_rate: '$139' }));
    expect(summary.monthly_rate).toBe('139');
  });

  it('strips a leading $ from next_perk_value', () => {
    const summary = parseSessionSummary(wrap({ ...base, next_perk_value: '$30' }));
    expect(summary.next_perk_value).toBe('30');
  });

  it('collapses an accidental double $ ($$139 -> 139)', () => {
    const summary = parseSessionSummary(wrap({ ...base, monthly_rate: '$$139' }));
    expect(summary.monthly_rate).toBe('139');
  });

  it('leaves a bare numeric string untouched', () => {
    const summary = parseSessionSummary(wrap({ ...base, monthly_rate: '139', next_perk_value: '30' }));
    expect(summary.monthly_rate).toBe('139');
    expect(summary.next_perk_value).toBe('30');
  });

  it('leaves a numeric (non-string) value untouched', () => {
    const summary = parseSessionSummary(wrap({ ...base, monthly_rate: 139 }));
    expect(summary.monthly_rate).toBe(139);
  });
});

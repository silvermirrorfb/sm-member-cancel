import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  isAccountDeletionRequest,
  hasCancellationIntent,
  wantsToStopMembershipOrBilling,
  buildAccountDeletionResponse,
} from '../src/app/api/chat/message/route.js';

// Follow-up to the Douglas Lee case: an explicit "delete my account" request
// must route to hello@ (the team that handles deletions), for members and
// non-members alike, and must never run the membership cancellation flow.

describe('isAccountDeletionRequest', () => {
  it('matches explicit account-deletion phrasing, including the Douglas case', () => {
    expect(isAccountDeletionRequest('How do I delete my account?')).toBe(true);
    expect(isAccountDeletionRequest('I want my account deleted')).toBe(true);
    expect(isAccountDeletionRequest('please delete my account')).toBe(true);
    expect(isAccountDeletionRequest('can you remove my profile')).toBe(true);
    expect(isAccountDeletionRequest('erase my personal data')).toBe(true);
    expect(isAccountDeletionRequest('delete my info')).toBe(true);
    expect(isAccountDeletionRequest('I want to exercise my right to be forgotten')).toBe(true);
  });

  it('defers to cancellation on dual intent so cancellation is never blocked (FTC)', () => {
    // The POST intercept fires only when isAccountDeletionRequest && !wantsToStopMembershipOrBilling.
    // Any message that ALSO signals stopping membership/billing must fall through
    // to the cancellation flow, including phrasings hasCancellationIntent misses.
    const dualIntents = [
      'delete my account and cancel my membership',
      'delete my account and stop my billing',
      'delete my account and end my subscription',
      'delete my account and close my membership',
      'erase my account and stop charging me',
      "delete my account and don't bill me anymore",
      'delete my account and no longer charge me',
    ];
    for (const msg of dualIntents) {
      expect(isAccountDeletionRequest(msg)).toBe(true);
      expect(wantsToStopMembershipOrBilling(msg)).toBe(true);
      // Guard is false => intercept does NOT fire => cancellation flow proceeds.
      expect(isAccountDeletionRequest(msg) && !wantsToStopMembershipOrBilling(msg)).toBe(false);
    }

    // Pure deletion (no stop-membership/billing intent) still routes to hello@.
    const pure = 'how do I delete my account';
    expect(wantsToStopMembershipOrBilling(pure)).toBe(false);
    expect(isAccountDeletionRequest(pure) && !wantsToStopMembershipOrBilling(pure)).toBe(true);
  });

  it('does NOT match membership cancellation or unrelated remove/delete phrasing', () => {
    // These must stay in the normal cancellation / support flows.
    expect(isAccountDeletionRequest('I want to cancel my membership')).toBe(false);
    expect(isAccountDeletionRequest('cancel my membership please')).toBe(false);
    expect(isAccountDeletionRequest('can you remove the late fee')).toBe(false);
    expect(isAccountDeletionRequest('delete the last message')).toBe(false);
    expect(isAccountDeletionRequest('pause my membership')).toBe(false);
    expect(isAccountDeletionRequest('')).toBe(false);
  });
});

describe('buildAccountDeletionResponse', () => {
  it('routes to hello@ and mentions memberships@ for billing, with no false claims', () => {
    const msg = buildAccountDeletionResponse('Douglas');
    expect(msg).toContain('hello@silvermirror.com');
    expect(msg).toContain('memberships@silvermirror.com');
    expect(msg).toContain('Douglas');
    expect(msg.toLowerCase()).toContain('deleting an account');
  });

  it('handles a missing first name and contains no em dashes', () => {
    const msg = buildAccountDeletionResponse('');
    expect(msg).not.toMatch(/^,/);
    expect(msg).not.toContain('—');
  });
});

describe('addon SMS copy (no em dash regression)', () => {
  it('contains no em dash in the pre-appointment route source', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/sms/automation/pre-appointment/route.js'),
      'utf8',
    );
    expect(src).not.toContain('—');
  });
});

import { describe, it, expect } from 'vitest';

import { buildProfile } from '../src/lib/boulevard.js';
import { buildNoMembershipMessage } from '../src/app/api/chat/message/route.js';

// Regression: the "Douglas Lee" false-positive. A person with a Boulevard CLIENT
// record but no membership (walk-in, retail buyer, lead) was matched, flagged as a
// member, and pushed through the full cancellation flow with every field UNKNOWN.
//
// Root cause: lookupMember/getClientById always returned a built profile for any
// matched client, even when findMembershipForClient returned null, and the chat
// route gated Membership Mode on `if (profile)` alone. The fix adds an explicit
// `profile.hasMembership` signal and gates the cancellation flow on it.

describe('buildProfile.hasMembership (membership presence signal)', () => {
  it('is false for a matched client with NO membership record (the Douglas Lee case)', () => {
    // This is the exact shape lookupMember builds when findMembershipForClient
    // returns null: client node fields only, no membership* keys.
    const profile = buildProfile({
      id: 'urn:blvd:Client:abc',
      firstName: 'Douglas',
      lastName: 'Lee',
      email: 'l33jinkyu@gmail.com',
      mobilePhone: '+85050851620',
      createdAt: '2025-06-01T00:00:00Z',
      active: true,
      primaryLocation: { id: 'urn:blvd:Location:pq', name: 'Penn Quarter' },
      lookupStrategy: 'email_exact',
    });

    expect(profile.hasMembership).toBe(false);
    // And the fields that came back UNKNOWN in the bad email are indeed null,
    // confirming there was no membership to build from.
    expect(profile.tier).toBeNull();
    expect(profile.monthlyRate).toBeNull();
    expect(profile.memberSince).toBeNull();
  });

  it('is true for a matched client WITH an active membership', () => {
    const profile = buildProfile({
      id: 'urn:blvd:Client:def',
      firstName: 'Real',
      lastName: 'Member',
      email: 'real@example.com',
      active: true,
      primaryLocation: { id: 'urn:blvd:Location:fl', name: 'Flatiron' },
      membershipName: '50-Minute Membership',
      membershipStartDate: '2025-01-15',
      membershipStatus: 'ACTIVE',
      unitPrice: 12900,
      lookupStrategy: 'email_exact',
    });

    expect(profile.hasMembership).toBe(true);
  });

  it('honors the authoritative boundary flag so a real member with sparse data is NOT blocked', () => {
    // lookupMember/getClientById pass hasMembership: Boolean(membership) from the
    // lookup boundary. A real membership node with empty status/startOn/name must
    // still count as a member (the false-negative Codex flagged).
    const profile = buildProfile({
      id: 'urn:blvd:Client:jkl',
      firstName: 'Sparse',
      lastName: 'Member',
      email: 'sparse@example.com',
      active: true,
      hasMembership: true,
      lookupStrategy: 'email_exact',
    });

    expect(profile.hasMembership).toBe(true);
  });

  it('is false when the boundary explicitly reports no membership', () => {
    const profile = buildProfile({
      id: 'urn:blvd:Client:mno',
      firstName: 'Non',
      lastName: 'Member',
      email: 'non@example.com',
      active: true,
      hasMembership: false,
      lookupStrategy: 'email_exact',
    });

    expect(profile.hasMembership).toBe(false);
  });

  it('is true for a client whose membership is inactive/cancelled (still a member record)', () => {
    // Already-cancelled members must still enter Membership Mode so the existing
    // inactive-account handling applies. The new gate only blocks zero-membership clients.
    const profile = buildProfile({
      id: 'urn:blvd:Client:ghi',
      firstName: 'Former',
      lastName: 'Member',
      email: 'former@example.com',
      active: true,
      membershipStatus: 'CANCELLED',
      membershipStartDate: '2024-01-15',
      lookupStrategy: 'email_exact',
    });

    expect(profile.hasMembership).toBe(true);
  });
});

describe('buildNoMembershipMessage (non-member routing copy)', () => {
  it('routes account deletion to hello@ and membership questions to memberships@', () => {
    const msg = buildNoMembershipMessage('Douglas');
    expect(msg).toContain('hello@silvermirror.com');
    expect(msg).toContain('memberships@silvermirror.com');
    expect(msg).toContain('Douglas');
    // Does not falsely claim to have cancelled anything.
    expect(msg.toLowerCase()).toContain('nothing for me to cancel');
  });

  it('handles a missing first name without a dangling comma', () => {
    const msg = buildNoMembershipMessage('');
    expect(msg).not.toMatch(/^,/);
    expect(msg).toContain('hello@silvermirror.com');
  });

  it('contains no em dashes (global copy rule)', () => {
    expect(buildNoMembershipMessage('Douglas')).not.toContain('—');
  });
});

// src/lib/upgrade-pricing.js
//
// Tier-aware duration-upgrade pricing. Single source of truth for the 30->50
// upgrade price quoted in the outbound offer, echoed at confirmation, and
// (in a later PR) written to the Boulevard booking line at apply time.
// All amounts are PRE-TAX US dollars; tax settles at in-store checkout.

import { isInactiveMembershipStatus } from './boulevard.js';

// Member 50-minute total. Mirrors CURRENT_RATES['50'] in boulevard.js (the
// canonical member rate table); the drift-guard test keeps them equal.
const MEMBER_50_MIN_TOTAL = 139;

// Non-member 30->50 upgrade. SINGLE named constant so the open "168 vs 169"
// question (and a matching 49 delta) is a one-line change here and nowhere else.
const NONMEMBER_UPGRADE = { deltaDollars: 50, totalDollars: 169 };

// Returns { deltaDollars, totalDollars, isMember } for a sendable offer, or null
// to signal "skip this candidate" (logged). Never guesses, never prices a
// non-30-minute member.
function resolveUpgradePrice(profile) {
  const tier = String(profile?.tier || '').trim();
  const believedMember = (profile?.hasMembership === true || Boolean(tier)) && !isInactiveMembershipStatus(profile?.accountStatus);

  // Non-member / walk-in / repeat non-member / cancelled member -> flat price.
  if (!believedMember) {
    return { deltaDollars: NONMEMBER_UPGRADE.deltaDollars, totalDollars: NONMEMBER_UPGRADE.totalDollars, isMember: false };
  }

  // Active member: REQUIRE a confirmed 30-minute tier. Never price a 50/90-min
  // member: a grandfathered $129/mo 50-min member computes a positive sub-$139
  // delta and would otherwise be offered a bogus "upgrade" to the tier they hold.
  if (tier !== '30') {
    console.warn('[upgrade-pricing] skip: member tier not confirmed 30-min', { clientId: profile?.clientId || null, tier: tier || null });
    return null;
  }

  const monthlyRate = Number(profile?.monthlyRate);
  if (!Number.isFinite(monthlyRate) || monthlyRate <= 0) {
    // Fail closed: we believe they are a 30-min member but cannot read their
    // rate, so we cannot honor "never charge more than quoted." Skip, never guess.
    console.warn('[upgrade-pricing] skip: member monthly rate unresolved', { clientId: profile?.clientId || null });
    return null;
  }

  const deltaDollars = Math.max(0, MEMBER_50_MIN_TOTAL - monthlyRate);
  if (deltaDollars <= 0) {
    console.warn('[upgrade-pricing] skip: non-positive member upgrade delta', { clientId: profile?.clientId || null, monthlyRate });
    return null;
  }

  return { deltaDollars, totalDollars: MEMBER_50_MIN_TOTAL, isMember: true };
}

export { resolveUpgradePrice, MEMBER_50_MIN_TOTAL, NONMEMBER_UPGRADE };

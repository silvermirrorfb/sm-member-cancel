// Boulevard Enterprise API Client
// This module handles member lookup and profile data computation.
//
// SETUP: Set BOULEVARD_API_KEY and BOULEVARD_BUSINESS_ID in your .env
//
// The Boulevard GraphQL Admin API docs are at:
// https://developer.joinboulevard.com/

const BOULEVARD_API_URL = 'https://dashboard.boulevard.io/api/2020-01/admin.json';

// Walk-in prices for savings computation
const WALKIN_PRICES = {
  '30': 119,
  '50': 169,
  '90': 279,
};

// Current new-member rates
const CURRENT_RATES = {
  '30': 99,
  '50': 139,
  '90': 199,
};

// Perk milestones
const PERKS = [
  { month: 2, name: 'Moisturizer', value: 65 },
  { month: 4, name: 'Hyaluronic Acid Serum', value: 77 },
  { month: 5, name: 'Silver Mirror Hat', value: 30 },
  { month: 6, name: 'Choose one add-on (Neck Firming, Eye Puff, or Microcurrent)', value: 50 },
  { month: 9, name: 'Cleanser', value: 41 },
  { month: 12, name: 'Foundational Formulas Bundle', value: 183 },
  { month: 18, name: 'Signature Mask', value: 69 },
  { month: 22, name: 'Free enhancement up to $50', value: 50 },
  { month: 24, name: 'Dermaplaning + retail bundle', value: 95 },
  { month: 36, name: 'Foundational Formulas Bundle (Year 3)', value: 183 },
  { month: 48, name: 'Foundational Bundle + SM Hat (Year 4)', value: 213 },
  { month: 60, name: '90-Min Upgrade or HydraFacial (Year 5)', value: 279 },
];

// Loyalty point redemption tiers
const LOYALTY_TIERS = [
  { points: 500, service: 'Extra Extractions', value: 25 },
  { points: 1000, service: 'Custom Jelly Mask', value: 50 },
  { points: 2000, service: 'Gua Sha Massage', value: 50 },
  { points: 3000, service: 'Dermaplaning', value: 95 },
  { points: 5000, service: 'BioRePeel Chemical Peel', value: 225 },
];

/**
 * Look up a member by name + email or name + phone.
 * Returns the member profile or null if not found.
 */
async function lookupMember(name, emailOrPhone) {
  const apiKey = process.env.BOULEVARD_API_KEY;
  if (!apiKey) {
    console.warn('BOULEVARD_API_KEY not set — using mock data');
    return mockLookup(name, emailOrPhone);
  }

  try {
    // Boulevard GraphQL query to find client
    const query = `
      query FindClient($email: String, $phone: String) {
        clients(
          first: 5,
          filter: {
            email: $email,
            mobilePhone: $phone
          }
        ) {
          edges {
            node {
              id
              firstName
              lastName
              email
              mobilePhone
              # Membership and visit data would be fetched here
              # Exact schema depends on Boulevard API version
            }
          }
        }
      }
    `;

    const isEmail = emailOrPhone.includes('@');
    const variables = isEmail
      ? { email: emailOrPhone }
      : { phone: emailOrPhone };

    const response = await fetch(BOULEVARD_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    const data = await response.json();
    const clients = data?.data?.clients?.edges || [];

    if (clients.length === 0) return null;

    // Find best match by name similarity
    const nameLower = name.toLowerCase().trim();
    const match = clients.find(c => {
      const fullName = `${c.node.firstName} ${c.node.lastName}`.toLowerCase();
      return fullName === nameLower || levenshtein(fullName, nameLower) <= 3;
    });

    if (!match) return null;

    // TODO: Fetch full membership details, visit history, loyalty points
    // from Boulevard's membership and appointment endpoints.
    // For now, return the basic client data and fill in the rest
    // as you wire up more Boulevard endpoints.

    return buildProfile(match.node);
  } catch (err) {
    console.error('Boulevard API error:', err);
    return null;
  }
}

/**
 * Build the full member profile object from Boulevard data.
 * This is the shape that gets injected into the system prompt.
 */
function buildProfile(boulevardData) {
  // TODO: Replace with actual Boulevard data mapping
  // This shows the exact shape the system prompt expects
  const profile = {
    name: `${boulevardData.firstName} ${boulevardData.lastName}`,
    firstName: boulevardData.firstName,
    email: boulevardData.email,
    phone: boulevardData.mobilePhone || null,
    location: boulevardData.location || 'Unknown',
    tier: boulevardData.membershipTier || '50', // '30', '50', or '90'
    monthlyRate: boulevardData.monthlyRate || 139,
    memberSince: boulevardData.membershipStartDate || null,
    tenureMonths: boulevardData.tenureMonths || 0,
    accountStatus: boulevardData.accountStatus || 'active',
    paymentsProcessed: boulevardData.paymentsProcessed || 0,

    // Financial
    totalDuesPaid: boulevardData.totalDuesPaid || 0,
    totalRetailPurchases: boulevardData.totalRetailPurchases || 0,
    totalAddonPurchases: boulevardData.totalAddonPurchases || 0,

    // Usage
    facialsRedeemed: boulevardData.facialsRedeemed || 0,
    avgVisitsPerMonth: boulevardData.avgVisitsPerMonth || 0,
    lastVisitDate: boulevardData.lastVisitDate || null,
    mostPurchasedAddon: boulevardData.mostPurchasedAddon || null,
    upcomingAppointments: boulevardData.upcomingAppointments || [],

    // Loyalty
    loyaltyPoints: boulevardData.loyaltyPoints || 0,
    loyaltyEnrolled: boulevardData.loyaltyEnrolled || false,

    // Perk history
    perksClaimed: boulevardData.perksClaimed || [],

    // Credits
    unusedCredits: boulevardData.unusedCredits || 0,
    lastBillDate: boulevardData.lastBillDate || null,
  };

  // Compute derived values
  profile.computed = computeValues(profile);

  return profile;
}

/**
 * Compute walk-in savings, rate lock savings, next perk, and loyalty redemption.
 */
function computeValues(profile) {
  const tier = profile.tier;

  // Walk-in savings
  const walkinPrice = WALKIN_PRICES[tier] || 169;
  const totalWalkinValue = profile.facialsRedeemed * walkinPrice;
  const walkinSavings = totalWalkinValue - profile.totalDuesPaid;

  // Rate lock savings
  const currentRate = CURRENT_RATES[tier] || 139;
  const rateDiff = currentRate - profile.monthlyRate;
  const rateLockAnnual = rateDiff > 0 ? rateDiff * 12 : 0;

  // Next perk milestone
  let nextPerk = null;
  for (const perk of PERKS) {
    if (perk.month > profile.tenureMonths) {
      nextPerk = perk;
      break;
    }
  }

  // Loyalty point redemption
  let loyaltyRedeemable = null;
  let loyaltyNextTier = null;
  if (profile.loyaltyEnrolled && profile.loyaltyPoints > 0) {
    // Find highest redeemable
    for (const tier of LOYALTY_TIERS) {
      if (profile.loyaltyPoints >= tier.points) {
        loyaltyRedeemable = tier;
      }
    }
    // Find next tier they could reach
    for (const tier of LOYALTY_TIERS) {
      if (profile.loyaltyPoints < tier.points) {
        loyaltyNextTier = {
          ...tier,
          pointsNeeded: tier.points - profile.loyaltyPoints,
        };
        break;
      }
    }
  }

  return {
    walkinSavings: walkinSavings > 0 ? walkinSavings : null,
    walkinPrice,
    currentNewMemberRate: currentRate,
    rateDiff,
    rateLockAnnual: rateLockAnnual > 0 ? rateLockAnnual : null,
    nextPerk,
    loyaltyRedeemable,
    loyaltyNextTier,
    creditExpiryNote: profile.unusedCredits > 0
      ? `${profile.unusedCredits} unused credits — expire 90 days from last bill date`
      : null,
  };
}

/**
 * Format the member profile as a string for injection into the system prompt.
 */
function formatProfileForPrompt(profile) {
  const c = profile.computed;
  const lines = [
    `Name: ${profile.name}`,
    `Email: ${profile.email}`,
    `Phone: ${profile.phone || 'Not provided'}`,
    `Location: ${profile.location}`,
    `Membership Tier: ${profile.tier}-Minute`,
    `Monthly Rate: $${profile.monthlyRate}/month`,
    `Current New-Member Rate: $${c.currentNewMemberRate}/month`,
    `Rate Difference: ${c.rateDiff > 0 ? `$${c.rateDiff}/month ($${c.rateLockAnnual}/year) in grandfathered savings` : 'Rate matches current pricing'}`,
    `Member Since: ${profile.memberSince || 'Unknown'}`,
    `Tenure: ${profile.tenureMonths} months`,
    `Account Status: ${profile.accountStatus}`,
    `Payments Processed: ${profile.paymentsProcessed}`,
    ``,
    `Total Membership Dues Paid: $${profile.totalDuesPaid}`,
    `Total Retail Purchases: $${profile.totalRetailPurchases}`,
    `Total Add-on Purchases: $${profile.totalAddonPurchases}`,
    ``,
    `Facials Redeemed: ${profile.facialsRedeemed}`,
    `Average Visits/Month: ${profile.avgVisitsPerMonth}`,
    `Last Visit: ${profile.lastVisitDate || 'Unknown'}`,
    `Most Purchased Add-on: ${profile.mostPurchasedAddon || 'None'}`,
    `Upcoming Appointments: ${profile.upcomingAppointments.length > 0 ? profile.upcomingAppointments.join(', ') : 'None'}`,
    ``,
    `Walk-in Savings: ${c.walkinSavings ? `$${c.walkinSavings} saved vs. walk-in pricing` : 'NEGATIVE OR ZERO — do NOT mention savings'}`,
    `Walk-in Price for Tier: $${c.walkinPrice}/facial`,
    ``,
    `Loyalty Points: ${profile.loyaltyEnrolled ? `${profile.loyaltyPoints} points` : 'Not enrolled — do not mention loyalty program'}`,
  ];

  if (c.loyaltyRedeemable) {
    lines.push(`Loyalty Redeemable: ${c.loyaltyRedeemable.service} (${c.loyaltyRedeemable.points} points = $${c.loyaltyRedeemable.value} value)`);
  }
  if (c.loyaltyNextTier) {
    lines.push(`Next Loyalty Tier: ${c.loyaltyNextTier.pointsNeeded} more points for ${c.loyaltyNextTier.service}`);
  }

  lines.push(``);
  lines.push(`Unused Credits: ${profile.unusedCredits}`);
  if (profile.lastBillDate) {
    lines.push(`Last Bill Date: ${profile.lastBillDate} (credits expire 90 days after this)`);
  }

  lines.push(``);
  lines.push(`Perks Already Claimed: ${profile.perksClaimed.length > 0 ? profile.perksClaimed.join(', ') : 'None'}`);
  if (c.nextPerk) {
    lines.push(`Next Perk Milestone: Month ${c.nextPerk.month} — ${c.nextPerk.name} ($${c.nextPerk.value} value)`);
    lines.push(`Months Until Next Perk: ${c.nextPerk.month - profile.tenureMonths}`);
  }

  return lines.join('\n');
}

/**
 * Simple Levenshtein distance for fuzzy name matching.
 */
function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Mock lookup for development/testing without Boulevard API.
 * Returns a realistic test profile.
 */
function mockLookup(name, emailOrPhone) {
  // Return a test profile for development
  return buildProfile({
    firstName: name.split(' ')[0] || 'Test',
    lastName: name.split(' ').slice(1).join(' ') || 'Member',
    email: emailOrPhone.includes('@') ? emailOrPhone : 'test@example.com',
    mobilePhone: emailOrPhone.includes('@') ? null : emailOrPhone,
    location: 'Flatiron',
    membershipTier: '50',
    monthlyRate: 129,
    membershipStartDate: '2025-01-15',
    tenureMonths: 13,
    accountStatus: 'active',
    paymentsProcessed: 13,
    totalDuesPaid: 1677,
    totalRetailPurchases: 340,
    totalAddonPurchases: 285,
    facialsRedeemed: 11,
    avgVisitsPerMonth: 0.85,
    lastVisitDate: '2026-02-10',
    mostPurchasedAddon: 'Dermaplaning',
    upcomingAppointments: ['2026-03-05 at 2pm'],
    loyaltyPoints: 1360,
    loyaltyEnrolled: true,
    perksClaimed: ['Month 2: Moisturizer', 'Month 4: HA Serum', 'Month 5: Hat', 'Month 6: Microcurrent', 'Month 9: Cleanser', 'Month 12: Formulas Bundle'],
    unusedCredits: 2,
    lastBillDate: '2026-02-15',
  });
}


export {
  lookupMember,
  buildProfile,
  computeValues,
  formatProfileForPrompt,
  WALKIN_PRICES,
  CURRENT_RATES,
  PERKS,
  LOYALTY_TIERS,
};

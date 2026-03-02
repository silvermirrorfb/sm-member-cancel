import crypto from 'crypto';

// Boulevard Enterprise API Client
// SETUP: Set env vars: BOULEVARD_API_URL, BOULEVARD_API_KEY, BOULEVARD_API_SECRET, BOULEVARD_BUSINESS_ID
// Auth: HMAC-based Basic auth (blvd-admin-v1 scheme)
// Docs: https://developers.joinblvd.com/

const DEFAULT_API_URL = 'https://dashboard.boulevard.io/api/2020-01/admin';
const BOULEVARD_TIMEOUT_MS = 15000;
const PHONE_SCAN_PAGE_SIZE = 100;
const PHONE_SCAN_MAX_PAGES = 20;

const WALKIN_PRICES = { '30': 119, '50': 169, '90': 279 };
const CURRENT_RATES = { '30': 99, '50': 139, '90': 199 };

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

const LOYALTY_TIERS = [
  { points: 500, service: 'Extra Extractions', value: 25 },
  { points: 1000, service: 'Custom Jelly Mask', value: 50 },
  { points: 2000, service: 'Gua Sha Massage', value: 50 },
  { points: 3000, service: 'Dermaplaning', value: 95 },
  { points: 5000, service: 'BioRePeel Chemical Peel', value: 225 },
];

function getSafeApiTarget(apiUrl) {
  try {
    const parsed = new URL(apiUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

function buildFetchErrorDiagnostics(err, apiUrl) {
  const cause = err && typeof err === 'object' ? err.cause : null;
  return {
    target: getSafeApiTarget(apiUrl),
    name: err?.name || null,
    message: err?.message || null,
    causeName: cause?.name || null,
    causeCode: cause?.code || null,
    causeMessage: cause?.message || null,
    errno: cause?.errno || null,
    syscall: cause?.syscall || null,
    address: cause?.address || null,
    port: cause?.port || null,
  };
}

function normalizeBoulevardApiUrl(rawUrl) {
  let apiUrl = String(rawUrl || DEFAULT_API_URL).trim();
  if (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);
  if (apiUrl.endsWith('/admin.json')) apiUrl = apiUrl.slice(0, -5); // strip ".json"
  return apiUrl;
}

function generateAuthHeader(apiKey, apiSecret, businessId) {
  const prefix = 'blvd-admin-v1';
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${prefix}${businessId}${timestamp}`;
  const rawKey = Buffer.from(apiSecret, 'base64');
  const signature = crypto.createHmac('sha256', rawKey).update(payload, 'utf8').digest('base64');
  const token = `${signature}${payload}`;
  return Buffer.from(`${apiKey}:${token}`, 'utf8').toString('base64');
}

function normalizePhone(phone) {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  return digits;
}

function verifyMemberIdentity(lookupRequest, profile) {
  if (!lookupRequest || !profile) return false;

  const reqFirst = (lookupRequest.firstName || '').trim().toLowerCase();
  const reqLast = (lookupRequest.lastName || '').trim().toLowerCase();
  const profileFirst = (profile.firstName || '').trim().toLowerCase();
  const profileLast = ((profile.name || '').split(' ').slice(1).join(' ') || '').trim().toLowerCase();

  const nameMatches = reqFirst === profileFirst && reqLast.length > 0 && profileLast.includes(reqLast);
  if (!nameMatches) return false;

  const reqEmail = (lookupRequest.email || '').trim().toLowerCase();
  const reqPhone = normalizePhone(lookupRequest.phone || '');
  const profileEmail = (profile.email || '').trim().toLowerCase();
  const profilePhone = normalizePhone(profile.phone || '');

  const emailMatches = reqEmail && profileEmail && reqEmail === profileEmail;
  const phoneMatches = reqPhone && profilePhone && reqPhone === profilePhone;
  return Boolean(emailMatches || phoneMatches);
}

async function fetchBoulevardGraphQL(apiUrl, headers, query, variables) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BOULEVARD_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') console.error(`Boulevard API timed out after ${BOULEVARD_TIMEOUT_MS}ms`);
    else console.error('Boulevard API fetch error:', buildFetchErrorDiagnostics(fetchErr, apiUrl));
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const t = await response.text().catch(() => '');
    console.error(`Boulevard API HTTP ${response.status}: ${t.substring(0,500)}`);
    return null;
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    console.error('Boulevard API non-JSON:', e.message);
    return null;
  }

  if (data.errors) {
    console.error('Boulevard GraphQL errors:', JSON.stringify(data.errors));
    return null;
  }

  return data;
}

function findNameMatch(name, clients) {
  const nameLower = name.toLowerCase().trim();
  return clients.find(c => {
    const fn = `${c.node.firstName} ${c.node.lastName}`.toLowerCase();
    return fn === nameLower || levenshtein(fn, nameLower) <= 3;
  }) || null;
}

async function findClientsByPhoneScan(apiUrl, headers, cleanPhone) {
  const found = [];
  let after = null;

  for (let page = 0; page < PHONE_SCAN_MAX_PAGES; page++) {
    const query = `
      query FindClientsByPhoneScan($after: String) {
        clients(first: ${PHONE_SCAN_PAGE_SIZE}, after: $after) {
          edges { node { id firstName lastName email mobilePhone } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await fetchBoulevardGraphQL(apiUrl, headers, query, { after });
    if (!data) return null;

    const connection = data?.data?.clients;
    const edges = connection?.edges || [];
    if (edges.length === 0) return found;

    for (const edge of edges) {
      if (normalizePhone(edge?.node?.mobilePhone || '') === cleanPhone) {
        found.push(edge);
      }
    }

    if (found.length > 0) return found;
    if (!connection?.pageInfo?.hasNextPage) break;

    after = connection?.pageInfo?.endCursor || null;
    if (!after) break;
  }

  return found;
}

async function lookupMember(name, emailOrPhone) {
  const apiKey = process.env.BOULEVARD_API_KEY;
  const apiSecret = process.env.BOULEVARD_API_SECRET;
  const businessId = process.env.BOULEVARD_BUSINESS_ID;
  if (!apiKey) { console.warn('BOULEVARD_API_KEY not set — using mock data'); return mockLookup(name, emailOrPhone); }
  if (!apiSecret || !businessId) { console.error('Boulevard auth requires BOULEVARD_API_SECRET and BOULEVARD_BUSINESS_ID when BOULEVARD_API_KEY is set'); return null; }
  const apiUrl = normalizeBoulevardApiUrl(process.env.BOULEVARD_API_URL || DEFAULT_API_URL);
  try {
    const rawContact = String(emailOrPhone || '').trim();
    const isEmail = rawContact.includes('@');

    const authCredentials = generateAuthHeader(apiKey, apiSecret, businessId);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${authCredentials}`,
      'X-Boulevard-Business-ID': businessId,
    };

    let clients = [];
    if (isEmail) {
      const query = `
        query FindClientByEmail($emails: [String!]) {
          clients(first: 5, emails: $emails) {
            edges { node { id firstName lastName email mobilePhone } }
          }
        }
      `;
      const email = rawContact.toLowerCase();
      console.log(`Boulevard lookup: email = ${email} at ${apiUrl}`);
      const data = await fetchBoulevardGraphQL(apiUrl, headers, query, { emails: [email] });
      if (!data) return null;
      clients = data?.data?.clients?.edges || [];
    } else {
      const cleanPhone = normalizePhone(rawContact);
      if (!cleanPhone) {
        console.log('Boulevard lookup: invalid phone input');
        return null;
      }
      console.log(`Boulevard lookup: phone = ${cleanPhone} at ${apiUrl}`);
      const scanned = await findClientsByPhoneScan(apiUrl, headers, cleanPhone);
      if (!scanned) return null;
      clients = scanned;
    }

    if (clients.length === 0) {
      console.log('Boulevard lookup: no clients found');
      return null;
    }

    const match = findNameMatch(name, clients);
    if (!match) { console.log(`Boulevard lookup: ${clients.length} clients found but none match "${name}"`); return null; }
    console.log(`Boulevard lookup: matched ${match.node.firstName} ${match.node.lastName}`);
    return buildProfile(match.node);
  } catch (err) { console.error('Boulevard API error:', err.message || err); return null; }
}

function buildProfile(d) {
  const profile = {
    name: `${d.firstName} ${d.lastName}`, firstName: d.firstName, email: d.email,
    phone: d.mobilePhone || null, location: d.location || 'Unknown',
    tier: d.membershipTier || '50', monthlyRate: d.monthlyRate || 139,
    memberSince: d.membershipStartDate || null, tenureMonths: d.tenureMonths || 0,
    accountStatus: d.accountStatus || 'active', paymentsProcessed: d.paymentsProcessed || 0,
    totalDuesPaid: d.totalDuesPaid || 0, totalRetailPurchases: d.totalRetailPurchases || 0,
    totalAddonPurchases: d.totalAddonPurchases || 0, facialsRedeemed: d.facialsRedeemed || 0,
    avgVisitsPerMonth: d.avgVisitsPerMonth || 0, lastVisitDate: d.lastVisitDate || null,
    mostPurchasedAddon: d.mostPurchasedAddon || null, upcomingAppointments: d.upcomingAppointments || [],
    loyaltyPoints: d.loyaltyPoints || 0, loyaltyEnrolled: d.loyaltyEnrolled || false,
    perksClaimed: d.perksClaimed || [], unusedCredits: d.unusedCredits || 0,
    lastBillDate: d.lastBillDate || null,
  };
  profile.computed = computeValues(profile);
  return profile;
}

function computeValues(p) {
  const wp = WALKIN_PRICES[p.tier] || 169;
  const ws = p.facialsRedeemed * wp - p.totalDuesPaid;
  const cr = CURRENT_RATES[p.tier] || 139;
  const rd = cr - p.monthlyRate;
  let nextPerk = null;
  for (const pk of PERKS) { if (pk.month > p.tenureMonths) { nextPerk = pk; break; } }
  let loyaltyRedeemable = null, loyaltyNextTier = null;
  if (p.loyaltyEnrolled && p.loyaltyPoints > 0) {
    for (const lt of LOYALTY_TIERS) { if (p.loyaltyPoints >= lt.points) loyaltyRedeemable = lt; }
    for (const lt of LOYALTY_TIERS) { if (p.loyaltyPoints < lt.points) { loyaltyNextTier = { ...lt, pointsNeeded: lt.points - p.loyaltyPoints }; break; } }
  }
  return {
    walkinSavings: ws > 0 ? ws : null, walkinPrice: wp, currentNewMemberRate: cr, rateDiff: rd,
    rateLockAnnual: rd > 0 ? rd * 12 : null, nextPerk, loyaltyRedeemable, loyaltyNextTier,
    creditExpiryNote: p.unusedCredits > 0 ? `${p.unusedCredits} unused credits — expire 90 days from last bill date` : null,
  };
}

function formatProfileForPrompt(profile) {
  const c = profile.computed;
  const lines = [
    `Name: ${profile.name}`, `Email: ${profile.email}`, `Phone: ${profile.phone || 'Not provided'}`,
    `Location: ${profile.location}`, `Membership Tier: ${profile.tier}-Minute`,
    `Monthly Rate: $${profile.monthlyRate}/month`, `Current New-Member Rate: $${c.currentNewMemberRate}/month`,
    `Rate Difference: ${c.rateDiff > 0 ? `$${c.rateDiff}/month ($${c.rateLockAnnual}/year) in grandfathered savings` : 'Rate matches current pricing'}`,
    `Member Since: ${profile.memberSince || 'Unknown'}`, `Tenure: ${profile.tenureMonths} months`,
    `Account Status: ${profile.accountStatus}`, `Payments Processed: ${profile.paymentsProcessed}`,
    '', `Total Membership Dues Paid: $${profile.totalDuesPaid}`,
    `Total Retail Purchases: $${profile.totalRetailPurchases}`, `Total Add-on Purchases: $${profile.totalAddonPurchases}`,
    '', `Facials Redeemed: ${profile.facialsRedeemed}`, `Average Visits/Month: ${profile.avgVisitsPerMonth}`,
    `Last Visit: ${profile.lastVisitDate || 'Unknown'}`, `Most Purchased Add-on: ${profile.mostPurchasedAddon || 'None'}`,
    `Upcoming Appointments: ${profile.upcomingAppointments.length > 0 ? profile.upcomingAppointments.join(', ') : 'None'}`,
    '', `Walk-in Savings: ${c.walkinSavings ? `$${c.walkinSavings} saved vs. walk-in pricing` : 'NEGATIVE OR ZERO — do NOT mention savings'}`,
    `Walk-in Price for Tier: $${c.walkinPrice}/facial`,
    '', `Loyalty Points: ${profile.loyaltyEnrolled ? `${profile.loyaltyPoints} points` : 'Not enrolled — do not mention loyalty program'}`,
  ];
  if (c.loyaltyRedeemable) lines.push(`Loyalty Redeemable: ${c.loyaltyRedeemable.service} (${c.loyaltyRedeemable.points} points = $${c.loyaltyRedeemable.value} value)`);
  if (c.loyaltyNextTier) lines.push(`Next Loyalty Tier: ${c.loyaltyNextTier.pointsNeeded} more points for ${c.loyaltyNextTier.service}`);
  lines.push('', `Unused Credits: ${profile.unusedCredits}`);
  if (profile.lastBillDate) lines.push(`Last Bill Date: ${profile.lastBillDate} (credits expire 90 days after this)`);
  lines.push('', `Perks Already Claimed: ${profile.perksClaimed.length > 0 ? profile.perksClaimed.join(', ') : 'None'}`);
  if (c.nextPerk) { lines.push(`Next Perk Milestone: Month ${c.nextPerk.month} — ${c.nextPerk.name} ($${c.nextPerk.value} value)`); lines.push(`Months Until Next Perk: ${c.nextPerk.month - profile.tenureMonths}`); }
  return lines.join('\n');
}

function levenshtein(a, b) {
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++)
    for (let j = 1; j <= a.length; j++)
      m[i][j] = b[i-1] === a[j-1] ? m[i-1][j-1] : Math.min(m[i-1][j-1]+1, m[i][j-1]+1, m[i-1][j]+1);
  return m[b.length][a.length];
}

function mockLookup(name, emailOrPhone) {
  return buildProfile({
    firstName: name.split(' ')[0] || 'Test', lastName: name.split(' ').slice(1).join(' ') || 'Member',
    email: emailOrPhone.includes('@') ? emailOrPhone : 'test@example.com',
    mobilePhone: emailOrPhone.includes('@') ? null : emailOrPhone,
    location: 'Flatiron', membershipTier: '50', monthlyRate: 129, membershipStartDate: '2025-01-15',
    tenureMonths: 13, accountStatus: 'active', paymentsProcessed: 13, totalDuesPaid: 1677,
    totalRetailPurchases: 340, totalAddonPurchases: 285, facialsRedeemed: 11, avgVisitsPerMonth: 0.85,
    lastVisitDate: '2026-02-10', mostPurchasedAddon: 'Dermaplaning', upcomingAppointments: ['2026-03-05 at 2pm'],
    loyaltyPoints: 1360, loyaltyEnrolled: true,
    perksClaimed: ['Month 2: Moisturizer', 'Month 4: HA Serum', 'Month 5: Hat', 'Month 6: Microcurrent', 'Month 9: Cleanser', 'Month 12: Formulas Bundle'],
    unusedCredits: 2, lastBillDate: '2026-02-15',
  });
}

export {
  lookupMember,
  verifyMemberIdentity,
  buildProfile,
  computeValues,
  formatProfileForPrompt,
  normalizePhone,
  WALKIN_PRICES,
  CURRENT_RATES,
  PERKS,
  LOYALTY_TIERS,
};

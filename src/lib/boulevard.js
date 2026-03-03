import crypto from 'crypto';

// Boulevard Enterprise API Client
// SETUP: Set env vars: BOULEVARD_API_URL, BOULEVARD_API_KEY, BOULEVARD_API_SECRET, BOULEVARD_BUSINESS_ID
// Auth: HMAC-based Basic auth (blvd-admin-v1 scheme)
// Docs: https://developers.joinblvd.com/

const DEFAULT_API_URL = 'https://dashboard.boulevard.io/api/2020-01/admin';
const BOULEVARD_TIMEOUT_MS = 15000;
const PHONE_SCAN_PAGE_SIZE = Number(process.env.BOULEVARD_PHONE_SCAN_PAGE_SIZE || 100);
const PHONE_SCAN_MAX_PAGES = Number(process.env.BOULEVARD_PHONE_SCAN_MAX_PAGES || 300);
const MEMBERSHIP_SCAN_PAGE_SIZE = 200;
const MEMBERSHIP_SCAN_MAX_PAGES = 120;
const MEMBERSHIP_CACHE_TTL_MS = 30 * 60 * 1000;
const MEMBERSHIP_NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const CLIENT_FIELD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const membershipCache = new Map();
const clientFieldCache = new Map();

const WALKIN_PRICES = { '30': 119, '50': 169, '90': 279 };
const CURRENT_RATES = { '30': 99, '50': 139, '90': 199 };

const PERKS = [
  { month: 2, name: 'Moisturizer', value: 65, type: 'retail' },
  { month: 4, name: 'Hyaluronic Acid Serum', value: 77, type: 'retail' },
  { month: 5, name: 'Silver Mirror Hat', value: 30, type: 'retail' },
  { month: 6, name: 'Choose one add-on (Neck Firming, Eye Puff, or Microcurrent)', value: 50, type: 'service_choice' },
  { month: 9, name: 'Cleanser', value: 41, type: 'retail' },
  { month: 12, name: 'Foundational Formulas Bundle', value: 183, type: 'retail' },
  { month: 18, name: 'Signature Mask', value: 69, type: 'retail' },
  { month: 22, name: '$50 Enhancement Credit', value: 50, type: 'credit' },
  { month: 24, name: 'Dermaplaning + retail bundle', value: 125, type: 'service_bundle' },
  { month: 36, name: 'Year 3 Anniversary — Foundational Formulas Bundle', value: 183, type: 'retail' },
  { month: 42, name: 'Year 3.5 Mid-Year — $50 Enhancement Credit', value: 50, type: 'credit' },
  { month: 48, name: 'Year 4 Anniversary — Foundational Bundle + SM Hat', value: 213, type: 'retail' },
  { month: 54, name: 'Year 4.5 Mid-Year — $50 Enhancement Credit', value: 50, type: 'credit' },
  { month: 60, name: 'Year 5 Anniversary — 90-Min Upgrade or HydraFacial', value: 279, type: 'service_upgrade' },
  { month: 66, name: 'Year 5.5 Recognition Email (no perk)', value: 0, type: 'recognition' },
  { month: 72, name: 'Year 6 Anniversary — Pick add-on + Signature Mask', value: 119, type: 'service_choice_with_retail' },
  { month: 78, name: 'Year 6.5 Mid-Year — $50 Enhancement Credit', value: 50, type: 'credit' },
  { month: 84, name: 'Year 7 Anniversary — Pick add-on + Foundational Bundle', value: 233, type: 'service_choice_with_retail' },
  { month: 90, name: 'Year 7.5 Mid-Year — $50 Enhancement Credit', value: 50, type: 'credit' },
  { month: 96, name: 'Year 8 Anniversary — Pick add-on + HA Serum', value: 127, type: 'service_choice_with_retail' },
  { month: 102, name: 'Year 8.5 Mid-Year — $50 Enhancement Credit', value: 50, type: 'credit' },
  { month: 108, name: 'Year 9 Anniversary — Pick add-on + Signature Mask + HA Serum', value: 196, type: 'service_choice_with_retail' },
  { month: 114, name: 'Year 9.5 Mid-Year — $50 Enhancement Credit', value: 50, type: 'credit' },
  { month: 120, name: 'Year 10 Anniversary — Diamond package (basket + 3 guest passes + 10% add-on discount)', value: 400, type: 'diamond' },
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

function toIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundCurrency(value) {
  if (!isFiniteNumber(value)) return null;
  return Math.round(value * 100) / 100;
}

function readFirstFinite(source, keys) {
  for (const key of keys) {
    const raw = source?.[key];
    const num = typeof raw === 'string' ? Number(raw) : raw;
    if (isFiniteNumber(num)) return num;
  }
  return null;
}

function sumPositive(values) {
  let total = 0;
  let found = false;
  for (const value of values) {
    if (isFiniteNumber(value) && value > 0) {
      total += value;
      found = true;
    }
  }
  return found ? roundCurrency(total) : null;
}

function parseTierFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\b(30|50|90)\s*[- ]?minute\b/i);
  return match ? match[1] : null;
}

function normalizeNameText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeName(text) {
  return normalizeNameText(text)
    .split(' ')
    .filter(Boolean);
}

function namesLikelyMatch(requestedName, candidateFirstName, candidateLastName) {
  const reqTokens = tokenizeName(requestedName);
  const candFull = `${candidateFirstName || ''} ${candidateLastName || ''}`.trim();
  const candTokens = tokenizeName(candFull);
  if (reqTokens.length === 0 || candTokens.length === 0) return false;

  const reqFirst = reqTokens[0];
  const reqLast = reqTokens[reqTokens.length - 1];
  const candFirst = candTokens[0];
  const candLast = candTokens[candTokens.length - 1];

  // Strong signal: first + last token align.
  if (reqFirst === candFirst && reqLast === candLast) return true;

  // Allow middle-name variants where both sides still contain first + last.
  if (reqFirst === candFirst && candTokens.includes(reqLast)) return true;
  if (candFirst === reqFirst && reqTokens.includes(candLast)) return true;

  const reqNorm = normalizeNameText(requestedName);
  const candNorm = normalizeNameText(candFull);
  if (!reqNorm || !candNorm) return false;

  // Substring allows "sophia dowd" vs "sophia isabel dowd".
  if (reqNorm.includes(candNorm) || candNorm.includes(reqNorm)) return true;

  // Final fuzzy check for minor typos.
  return levenshtein(candNorm, reqNorm) <= 3;
}

function getCachedMembership(clientId) {
  const cached = membershipCache.get(clientId);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    membershipCache.delete(clientId);
    return undefined;
  }
  return cached.value;
}

function setCachedMembership(clientId, value) {
  const ttl = value ? MEMBERSHIP_CACHE_TTL_MS : MEMBERSHIP_NEGATIVE_CACHE_TTL_MS;
  membershipCache.set(clientId, { value, expiresAt: Date.now() + ttl });
}

function membershipStatusScore(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'ACTIVE') return 4;
  if (s === 'PAUSED') return 3;
  if (s === 'PENDING') return 2;
  if (s === 'CANCELED' || s === 'CANCELLED') return 1;
  return 0;
}

function pickBetterMembership(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;

  const cs = membershipStatusScore(current.status);
  const ns = membershipStatusScore(candidate.status);
  if (ns > cs) return candidate;
  if (ns < cs) return current;

  const currentStart = new Date(current.startOn || 0).getTime() || 0;
  const nextStart = new Date(candidate.startOn || 0).getTime() || 0;
  if (nextStart > currentStart) return candidate;
  if (nextStart < currentStart) return current;

  const currentTerm = isFiniteNumber(current.termNumber) ? current.termNumber : -1;
  const nextTerm = isFiniteNumber(candidate.termNumber) ? candidate.termNumber : -1;
  if (nextTerm > currentTerm) return candidate;

  return current;
}

function monthsBetween(startIsoDate, endDate = new Date()) {
  if (!startIsoDate) return null;
  const start = new Date(startIsoDate);
  if (Number.isNaN(start.getTime())) return null;

  let months = (endDate.getUTCFullYear() - start.getUTCFullYear()) * 12;
  months += endDate.getUTCMonth() - start.getUTCMonth();
  if (endDate.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function getNextPerkMilestone(tenureMonths) {
  if (!isFiniteNumber(tenureMonths)) return null;

  for (const pk of PERKS) {
    if (pk.month > tenureMonths) return pk;
  }

  // Post-Year-10 cadence: annual anniversary + mid-year credit.
  for (let month = tenureMonths + 1; month <= tenureMonths + 24; month++) {
    if (month % 12 === 0) {
      const year = Math.floor(month / 12);
      return {
        month,
        name: `Year ${year} Anniversary — Foundational Bundle + pick one add-on (up to $50)`,
        value: 233,
        type: 'post_year10_anniversary',
      };
    }
    if (month % 12 === 6) {
      const year = Math.floor(month / 12);
      return {
        month,
        name: `Year ${year}.5 Mid-Year — $50 Enhancement Credit`,
        value: 50,
        type: 'post_year10_credit',
      };
    }
  }

  return null;
}

function verifyMemberIdentity(lookupRequest, profile) {
  if (!lookupRequest || !profile) return false;

  const reqFirst = String(lookupRequest.firstName || '').trim();
  const reqLast = String(lookupRequest.lastName || '').trim();
  const profileName = String(profile.name || '').trim();
  const profileTokens = profileName.split(/\s+/).filter(Boolean);
  const profileFirst = String(profile.firstName || profileTokens[0] || '').trim();
  const profileLast = String(
    (profile.lastName || '') ||
    (profileTokens.length > 1 ? profileTokens.slice(1).join(' ') : '')
  ).trim();

  if (!reqFirst || !reqLast || !profileFirst || !profileLast) return false;
  const requestedName = `${reqFirst} ${reqLast}`;
  const nameMatches = namesLikelyMatch(requestedName, profileFirst, profileLast);
  if (!nameMatches) return false;

  const reqEmail = (lookupRequest.email || '').trim().toLowerCase();
  const reqPhone = normalizePhone(lookupRequest.phone || '');
  const profileEmail = (profile.email || '').trim().toLowerCase();
  const profilePhone = normalizePhone(profile.phone || '');

  const emailMatches = reqEmail && profileEmail && reqEmail === profileEmail;
  const phoneMatches = reqPhone && profilePhone && reqPhone === profilePhone;
  return Boolean(emailMatches || phoneMatches);
}

async function fetchBoulevardGraphQL(apiUrl, headers, query, variables, options = {}) {
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
    if (!options.silentErrors) {
      console.error('Boulevard GraphQL errors:', JSON.stringify(data.errors));
    }
    return null;
  }

  return data;
}

function findNameMatch(name, clients) {
  return clients.find(c =>
    namesLikelyMatch(name, c?.node?.firstName || '', c?.node?.lastName || '')
  ) || null;
}

async function findClientsByPhoneScan(apiUrl, headers, cleanPhone) {
  const found = [];
  let after = null;

  for (let page = 0; page < PHONE_SCAN_MAX_PAGES; page++) {
    const query = `
      query FindClientsByPhoneScan($after: String) {
        clients(first: ${PHONE_SCAN_PAGE_SIZE}, after: $after) {
          edges {
            node {
              id
              firstName
              lastName
              email
              mobilePhone
              createdAt
              appointmentCount
              active
              primaryLocation { name }
            }
          }
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
async function findMembershipForClient(apiUrl, headers, clientId) {
  if (!clientId) return null;

  const cached = getCachedMembership(clientId);
  if (cached !== undefined) return cached;

  let after = null;
  let best = null;

  for (let page = 0; page < MEMBERSHIP_SCAN_MAX_PAGES; page++) {
    const query = `
      query FindMembershipForClient($after: String) {
        memberships(first: ${MEMBERSHIP_SCAN_PAGE_SIZE}, after: $after) {
          edges {
            node {
              id
              clientId
              name
              startOn
              status
              termNumber
              unitPrice
              nextChargeDate
              location { name }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    const data = await fetchBoulevardGraphQL(apiUrl, headers, query, { after });
    if (!data) return null;

    const connection = data?.data?.memberships;
    const edges = connection?.edges || [];

    for (const edge of edges) {
      const membership = edge?.node;
      if (!membership || membership.clientId !== clientId) continue;
      best = pickBetterMembership(best, membership);

      if (String(membership.status || '').toUpperCase() === 'ACTIVE') {
        setCachedMembership(clientId, membership);
        return membership;
      }
    }

    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection?.pageInfo?.endCursor || null;
    if (!after) break;
  }

  setCachedMembership(clientId, best || null);
  return best || null;
}

async function getClientTypeFieldSet(apiUrl, headers) {
  const cached = clientFieldCache.get(apiUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.fields;

  const query = `
    query IntrospectClientType {
      __type(name: "Client") {
        fields {
          name
        }
      }
    }
  `;
  const data = await fetchBoulevardGraphQL(apiUrl, headers, query, {}, { silentErrors: true });
  const fields = data?.data?.__type?.fields;

  if (!Array.isArray(fields) || fields.length === 0) {
    clientFieldCache.set(apiUrl, { fields: null, expiresAt: Date.now() + CLIENT_FIELD_CACHE_TTL_MS });
    return null;
  }

  const fieldSet = new Set(fields.map(f => String(f?.name || '').trim()).filter(Boolean));
  clientFieldCache.set(apiUrl, { fields: fieldSet, expiresAt: Date.now() + CLIENT_FIELD_CACHE_TTL_MS });
  return fieldSet;
}

async function fetchClientCommerceMetrics(apiUrl, headers, clientNode) {
  const clientEmail = String(clientNode?.email || '').trim().toLowerCase();
  if (!clientEmail) return null;

  const fieldSet = await getClientTypeFieldSet(apiUrl, headers);
  if (!fieldSet) return null;

  const preferredFields = [
    'totalDuesPaid',
    'totalRetailPurchases',
    'totalAddonPurchases',
    'facialsRedeemed',
    'paymentsProcessed',
    'loyaltyPoints',
    'loyaltyEnrolled',
    'avgVisitsPerMonth',
    'lastVisitDate',
    'mostPurchasedAddon',
    'unusedCredits',
  ];
  const discountFields = [...fieldSet].filter(name => /(discount|saving)/i.test(name));
  const selected = [...new Set([...preferredFields, ...discountFields])].filter(name => fieldSet.has(name));
  if (selected.length === 0) return null;

  const query = `
    query FetchClientCommerceByEmail($emails: [String!]) {
      clients(first: 5, emails: $emails) {
        edges {
          node {
            id
            ${selected.join('\n            ')}
          }
        }
      }
    }
  `;
  const data = await fetchBoulevardGraphQL(
    apiUrl,
    headers,
    query,
    { emails: [clientEmail] },
    { silentErrors: true },
  );
  if (!data) return null;

  const edges = data?.data?.clients?.edges || [];
  const matched =
    edges.find(edge => String(edge?.node?.id || '') === String(clientNode?.id || '')) ||
    edges[0];
  return matched?.node || null;
}

async function lookupMember(name, emailOrPhone) {
  const apiKey = process.env.BOULEVARD_API_KEY;
  const apiSecret = process.env.BOULEVARD_API_SECRET;
  const businessId = process.env.BOULEVARD_BUSINESS_ID;
  const allowMock = process.env.BOULEVARD_ALLOW_MOCK === 'true' && process.env.NODE_ENV !== 'production';
  if (!apiKey) {
    if (allowMock) {
      console.warn('BOULEVARD_API_KEY not set — using mock data (BOULEVARD_ALLOW_MOCK=true)');
      return mockLookup(name, emailOrPhone);
    }
    console.error('BOULEVARD_API_KEY not set — member lookup disabled');
    return null;
  }
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
            edges {
              node {
                id
                firstName
                lastName
                email
                mobilePhone
                createdAt
                appointmentCount
                active
                primaryLocation { name }
              }
            }
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
    const membership = await findMembershipForClient(apiUrl, headers, match.node.id);
    const commerce = await fetchClientCommerceMetrics(apiUrl, headers, match.node);
    const source = membership ? {
      ...match.node,
      ...(commerce || {}),
      membershipName: membership.name,
      membershipStartDate: membership.startOn,
      membershipStatus: membership.status,
      membershipTermNumber: membership.termNumber,
      nextChargeDate: membership.nextChargeDate,
      unitPrice: membership.unitPrice,
      location: membership?.location?.name || match.node?.primaryLocation?.name || match.node.location,
    } : {
      ...match.node,
      ...(commerce || {}),
    };
    return buildProfile(source);
  } catch (err) { console.error('Boulevard API error:', err.message || err); return null; }
}

function buildProfile(d) {
  const clientSince = toIsoDate(d.createdAt);
  const memberSince = toIsoDate(d.membershipStartDate || d.startOn);
  const tier =
    (d.membershipTier && String(d.membershipTier).trim()) ||
    parseTierFromText(d.membershipName || d.membershipPlanName || null);
  const monthlyRate = isFiniteNumber(d.monthlyRate)
    ? d.monthlyRate
    : isFiniteNumber(d.unitPrice)
    ? Math.round(d.unitPrice) / 100
    : null;
  const tenureMonths = isFiniteNumber(d.tenureMonths) ? d.tenureMonths : monthsBetween(memberSince);

  const profile = {
    name: `${d.firstName} ${d.lastName}`, firstName: d.firstName, email: d.email,
    phone: d.mobilePhone || null, location: d.location || d.primaryLocation?.name || 'Unknown',
    tier: tier || null, monthlyRate,
    clientSince, memberSince, tenureMonths,
    accountStatus: d.accountStatus || d.membershipStatus || (d.active === false ? 'inactive' : d.active === true ? 'active' : null),
    paymentsProcessed: isFiniteNumber(d.paymentsProcessed) ? d.paymentsProcessed : null,
    totalDuesPaid: isFiniteNumber(d.totalDuesPaid) ? d.totalDuesPaid : null,
    totalRetailPurchases: isFiniteNumber(d.totalRetailPurchases) ? d.totalRetailPurchases : null,
    totalAddonPurchases: isFiniteNumber(d.totalAddonPurchases) ? d.totalAddonPurchases : null,
    totalDiscounts: readFirstFinite(d, ['totalDiscounts', 'totalDiscountAmount', 'discountTotal', 'lifetimeDiscountTotal', 'totalSavings']) || null,
    totalServiceDiscounts: readFirstFinite(d, ['totalServiceDiscounts', 'serviceDiscountTotal']) || null,
    totalRetailDiscounts: readFirstFinite(d, ['totalRetailDiscounts', 'retailDiscountTotal', 'productDiscountTotal']) || null,
    totalAddonDiscounts: readFirstFinite(d, ['totalAddonDiscounts', 'addOnDiscountTotal', 'addonDiscountTotal']) || null,
    firstTimePromoDiscounts: readFirstFinite(d, [
      'firstTimePromoDiscounts',
      'firstTimeUserPromoDiscounts',
      'totalFirstTimePromoDiscounts',
      'firstTimeDiscountTotal',
      'firstVisitPromoDiscount',
    ]) || null,
    facialsRedeemed: isFiniteNumber(d.facialsRedeemed) ? d.facialsRedeemed : null,
    appointmentCount: isFiniteNumber(d.appointmentCount) ? d.appointmentCount : null,
    avgVisitsPerMonth: isFiniteNumber(d.avgVisitsPerMonth) ? d.avgVisitsPerMonth : null,
    lastVisitDate: toIsoDate(d.lastVisitDate) || null,
    mostPurchasedAddon: d.mostPurchasedAddon || null, upcomingAppointments: d.upcomingAppointments || [],
    loyaltyPoints: isFiniteNumber(d.loyaltyPoints) ? d.loyaltyPoints : null,
    loyaltyEnrolled: typeof d.loyaltyEnrolled === 'boolean' ? d.loyaltyEnrolled : null,
    perksClaimed: d.perksClaimed || [], unusedCredits: isFiniteNumber(d.unusedCredits) ? d.unusedCredits : null,
    nextChargeDate: toIsoDate(d.nextChargeDate) || null,
    lastBillDate: toIsoDate(d.lastBillDate) || null,
  };
  profile.computed = computeValues(profile);
  return profile;
}

function computeValues(p) {
  const wp = p.tier && WALKIN_PRICES[p.tier] ? WALKIN_PRICES[p.tier] : null;
  const ws = wp !== null && isFiniteNumber(p.facialsRedeemed) && isFiniteNumber(p.totalDuesPaid)
    ? p.facialsRedeemed * wp - p.totalDuesPaid
    : null;
  const cr = p.tier && CURRENT_RATES[p.tier] ? CURRENT_RATES[p.tier] : null;
  const rd = cr !== null && isFiniteNumber(p.monthlyRate) ? cr - p.monthlyRate : null;
  const nextPerk = getNextPerkMilestone(p.tenureMonths);
  let loyaltyRedeemable = null, loyaltyNextTier = null;
  if (p.loyaltyEnrolled === true && isFiniteNumber(p.loyaltyPoints) && p.loyaltyPoints > 0) {
    for (const lt of LOYALTY_TIERS) { if (p.loyaltyPoints >= lt.points) loyaltyRedeemable = lt; }
    for (const lt of LOYALTY_TIERS) { if (p.loyaltyPoints < lt.points) { loyaltyNextTier = { ...lt, pointsNeeded: lt.points - p.loyaltyPoints }; break; } }
  }

  // Conservative purchase-based discount estimates when explicit totals are unavailable.
  // retail: assume 10% effective discount baseline
  // add-ons: member discount baseline is 20%
  const retailDiscountEstimate = isFiniteNumber(p.totalRetailPurchases)
    ? roundCurrency(p.totalRetailPurchases * (0.10 / 0.90))
    : null;
  const addonDiscountEstimate = isFiniteNumber(p.totalAddonPurchases)
    ? roundCurrency(p.totalAddonPurchases * (0.20 / 0.80))
    : null;
  const perFacialServiceDiscount = wp !== null && isFiniteNumber(p.monthlyRate)
    ? Math.max(wp - p.monthlyRate, 0)
    : null;
  const serviceDiscountEstimate = isFiniteNumber(perFacialServiceDiscount) && isFiniteNumber(p.facialsRedeemed)
    ? roundCurrency(perFacialServiceDiscount * p.facialsRedeemed)
    : null;

  const retailDiscountSavings = isFiniteNumber(p.totalRetailDiscounts) ? roundCurrency(p.totalRetailDiscounts) : retailDiscountEstimate;
  const addonDiscountSavings = isFiniteNumber(p.totalAddonDiscounts) ? roundCurrency(p.totalAddonDiscounts) : addonDiscountEstimate;
  const serviceDiscountSavings = isFiniteNumber(p.totalServiceDiscounts) ? roundCurrency(p.totalServiceDiscounts) : serviceDiscountEstimate;
  const firstTimePromoDiscounts = isFiniteNumber(p.firstTimePromoDiscounts) ? roundCurrency(p.firstTimePromoDiscounts) : 0;
  const explicitDiscountTotalRaw = isFiniteNumber(p.totalDiscounts) ? roundCurrency(p.totalDiscounts) : null;
  const explicitDiscountTotal = explicitDiscountTotalRaw !== null
    ? Math.max(roundCurrency(explicitDiscountTotalRaw - firstTimePromoDiscounts) || 0, 0)
    : null;
  const memberDiscountSavingsTotal = explicitDiscountTotal !== null
    ? explicitDiscountTotal
    : sumPositive([serviceDiscountSavings, retailDiscountSavings, addonDiscountSavings]);

  return {
    walkinSavings: ws !== null && ws > 0 ? ws : null,
    walkinPrice: wp,
    currentNewMemberRate: cr,
    rateDiff: rd,
    rateLockAnnual: rd !== null && rd > 0 ? rd * 12 : null,
    memberDiscountSavingsTotal: memberDiscountSavingsTotal !== null && memberDiscountSavingsTotal > 0 ? memberDiscountSavingsTotal : null,
    serviceDiscountSavings: serviceDiscountSavings !== null && serviceDiscountSavings > 0 ? serviceDiscountSavings : null,
    retailDiscountSavings: retailDiscountSavings !== null && retailDiscountSavings > 0 ? retailDiscountSavings : null,
    addonDiscountSavings: addonDiscountSavings !== null && addonDiscountSavings > 0 ? addonDiscountSavings : null,
    excludedFirstTimePromoDiscounts: firstTimePromoDiscounts > 0 ? firstTimePromoDiscounts : null,
    discountSavingsConfidence: explicitDiscountTotal !== null ? 'high' : (memberDiscountSavingsTotal !== null ? 'estimated' : 'unknown'),
    nextPerk,
    loyaltyRedeemable,
    loyaltyNextTier,
    creditExpiryNote: isFiniteNumber(p.unusedCredits) && p.unusedCredits > 0
      ? `${p.unusedCredits} unused credits — expire 90 days from last bill date`
      : null,
  };
}

function formatProfileForPrompt(profile) {
  const c = profile.computed;
  const lines = [
    'IMPORTANT DATA RULES: Only use fields marked as known. If a field is UNKNOWN, do not infer or state a value.',
    'Never claim someone "just started" unless Member Since is known and recent.',
    '',
    `Name: ${profile.name}`, `Email: ${profile.email}`, `Phone: ${profile.phone || 'Not provided'}`,
    `Location: ${profile.location || 'UNKNOWN'}`,
    `Client Record Created: ${profile.clientSince || 'UNKNOWN'}`,
    `Membership Tier: ${profile.tier ? `${profile.tier}-Minute (known)` : 'UNKNOWN — do not state tier'}`,
    `Monthly Rate: ${isFiniteNumber(profile.monthlyRate) ? `$${profile.monthlyRate}/month` : 'UNKNOWN — do not state monthly rate'}`,
    `Member Since: ${profile.memberSince || 'UNKNOWN — do not state join date/tenure'}`,
    `Tenure: ${isFiniteNumber(profile.tenureMonths) ? `${profile.tenureMonths} months` : 'UNKNOWN — do not state tenure'}`,
    `Next Charge Date: ${profile.nextChargeDate || 'UNKNOWN'}`,
    `Account Status: ${profile.accountStatus || 'UNKNOWN'}`,
    `Appointment Count: ${isFiniteNumber(profile.appointmentCount) ? profile.appointmentCount : 'UNKNOWN'}`,
    '',
    `Current New-Member Rate: ${isFiniteNumber(c.currentNewMemberRate) ? `$${c.currentNewMemberRate}/month` : 'UNKNOWN'}`,
    `Rate Difference: ${isFiniteNumber(c.rateDiff) ? (c.rateDiff > 0 ? `$${c.rateDiff}/month ($${c.rateLockAnnual}/year) in grandfathered savings` : 'Rate matches current pricing') : 'UNKNOWN — do not mention rate lock savings'}`,
    `Total Membership Dues Paid: ${isFiniteNumber(profile.totalDuesPaid) ? `$${profile.totalDuesPaid}` : 'UNKNOWN'}`,
    `Total Retail Purchases: ${isFiniteNumber(profile.totalRetailPurchases) ? `$${profile.totalRetailPurchases}` : 'UNKNOWN'}`,
    `Total Add-on Purchases: ${isFiniteNumber(profile.totalAddonPurchases) ? `$${profile.totalAddonPurchases}` : 'UNKNOWN'}`,
    `Member Discount Savings: ${isFiniteNumber(c.memberDiscountSavingsTotal) ? `$${c.memberDiscountSavingsTotal}${c.discountSavingsConfidence === 'estimated' ? ' (estimated from known purchase totals)' : ''}` : 'UNKNOWN — do not mention total discount savings'}`,
    `Service Discount Savings: ${isFiniteNumber(c.serviceDiscountSavings) ? `$${c.serviceDiscountSavings}` : 'UNKNOWN'}`,
    `Retail Discount Savings: ${isFiniteNumber(c.retailDiscountSavings) ? `$${c.retailDiscountSavings}` : 'UNKNOWN'}`,
    `Add-on Discount Savings: ${isFiniteNumber(c.addonDiscountSavings) ? `$${c.addonDiscountSavings}` : 'UNKNOWN'}`,
    `Excluded First-Time Promo Discounts: ${isFiniteNumber(c.excludedFirstTimePromoDiscounts) ? `$${c.excludedFirstTimePromoDiscounts}` : 'None or unknown'}`,
    '',
    `Facials Redeemed: ${isFiniteNumber(profile.facialsRedeemed) ? profile.facialsRedeemed : 'UNKNOWN'}`,
    `Average Visits/Month: ${isFiniteNumber(profile.avgVisitsPerMonth) ? profile.avgVisitsPerMonth : 'UNKNOWN'}`,
    `Last Visit: ${profile.lastVisitDate || 'Unknown'}`, `Most Purchased Add-on: ${profile.mostPurchasedAddon || 'None'}`,
    `Upcoming Appointments: ${profile.upcomingAppointments.length > 0 ? profile.upcomingAppointments.join(', ') : 'None'}`,
    '', `Walk-in Savings: ${isFiniteNumber(c.walkinSavings) ? `$${c.walkinSavings} saved vs. walk-in pricing` : 'UNKNOWN — do not mention walk-in savings'}`,
    `Walk-in Price for Tier: ${isFiniteNumber(c.walkinPrice) ? `$${c.walkinPrice}/facial` : 'UNKNOWN'}`,
    '', `Loyalty Points: ${profile.loyaltyEnrolled === true && isFiniteNumber(profile.loyaltyPoints) ? `${profile.loyaltyPoints} points` : 'UNKNOWN — do not mention loyalty points'}`,
  ];
  if (c.loyaltyRedeemable) lines.push(`Loyalty Redeemable: ${c.loyaltyRedeemable.service} (${c.loyaltyRedeemable.points} points = $${c.loyaltyRedeemable.value} value)`);
  if (c.loyaltyNextTier) lines.push(`Next Loyalty Tier: ${c.loyaltyNextTier.pointsNeeded} more points for ${c.loyaltyNextTier.service}`);
  lines.push('', `Unused Credits: ${isFiniteNumber(profile.unusedCredits) ? profile.unusedCredits : 'UNKNOWN'}`);
  if (profile.lastBillDate) lines.push(`Last Bill Date: ${profile.lastBillDate} (credits expire 90 days after this)`);
  lines.push('', `Perks Already Claimed: ${profile.perksClaimed.length > 0 ? profile.perksClaimed.join(', ') : 'None'}`);
  if (c.nextPerk && isFiniteNumber(profile.tenureMonths)) {
    if (isFiniteNumber(c.nextPerk.value) && c.nextPerk.value > 0) {
      lines.push(`Next Perk Milestone: Month ${c.nextPerk.month} — ${c.nextPerk.name} ($${c.nextPerk.value} value)`);
    } else {
      lines.push(`Next Perk Milestone: Month ${c.nextPerk.month} — ${c.nextPerk.name}`);
    }
    lines.push(`Months Until Next Perk: ${c.nextPerk.month - profile.tenureMonths}`);
  }
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
    totalRetailDiscounts: 37.78, totalAddonDiscounts: 71.25,
    lastVisitDate: '2026-02-10', mostPurchasedAddon: 'Dermaplaning', upcomingAppointments: ['2026-03-05 at 2pm'],
    loyaltyPoints: 1360, loyaltyEnrolled: true,
    perksClaimed: ['Month 2: Moisturizer', 'Month 4: HA Serum', 'Month 5: Hat', 'Month 6: Microcurrent', 'Month 9: Cleanser', 'Month 12: Formulas Bundle'],
    unusedCredits: 2, lastBillDate: '2026-02-15',
  });
}

export {
  lookupMember,
  verifyMemberIdentity,
  levenshtein,
  buildProfile,
  computeValues,
  formatProfileForPrompt,
  normalizePhone,
  WALKIN_PRICES,
  CURRENT_RATES,
  PERKS,
  LOYALTY_TIERS,
};

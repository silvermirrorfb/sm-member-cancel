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
const APPOINTMENT_SCAN_PAGE_SIZE = Number(process.env.BOULEVARD_APPOINTMENT_SCAN_PAGE_SIZE || 100);
const APPOINTMENT_SCAN_MAX_PAGES = Number(process.env.BOULEVARD_APPOINTMENT_SCAN_MAX_PAGES || 80);
const UPGRADE_WINDOW_HOURS = Number(process.env.BOULEVARD_UPGRADE_WINDOW_HOURS || 6);
const PREP_BUFFER_30MIN = Number(process.env.PREP_BUFFER_30MIN || 15);
const PREP_BUFFER_50MIN = Number(process.env.PREP_BUFFER_50MIN || 10);
const PREP_BUFFER_90MIN = Number(process.env.PREP_BUFFER_90MIN || 10);
const ENABLE_UPGRADE_MUTATION = process.env.BOULEVARD_ENABLE_UPGRADE_MUTATION === 'true';
const ENABLE_CANCEL_REBOOK_FALLBACK = process.env.BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK !== 'false';
const UUID_V4_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFICIAL_LOCATION_REGISTRY = Object.freeze([
  { slug: 'brickell', name: 'Brickell', id: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65' },
  { slug: 'bryant-park', name: 'Bryant Park', id: 'urn:blvd:Location:c80e43fc-22f5-4adf-b406-f50f59a85b80' },
  { slug: 'coral-gables', name: 'Coral Gables', id: 'urn:blvd:Location:01b80da8-0b5e-440a-b18b-03afbf5686bd' },
  { slug: 'dupont-circle', name: 'Dupont Circle', id: 'urn:blvd:Location:b11142af-3d1a-4d11-8194-0c50d023fd75' },
  { slug: 'flatiron', name: 'Flatiron', id: 'urn:blvd:Location:9482e4e3-e33a-4e31-baa1-9d14acb6c1c8' },
  { slug: 'manhattan-west', name: 'Manhattan West', id: 'urn:blvd:Location:bee8d08c-1a4b-4d7d-bf59-94b9dcd1523f' },
  { slug: 'navy-yard', name: 'Navy Yard', id: 'urn:blvd:Location:ce941e99-975b-4d98-9343-3139260821bb' },
  { slug: 'penn-quarter', name: 'Penn Quarter', id: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa' },
  { slug: 'upper-east-side', name: 'Upper East Side', id: 'urn:blvd:Location:5feecb61-9bcb-458a-ab42-09478386adbb' },
  { slug: 'upper-west-side', name: 'Upper West Side', id: 'urn:blvd:Location:6eab61bf-d215-4f4f-a464-6211fa802beb' },
]);
const OFFICIAL_LOCATION_NAME_ALIASES = Object.freeze({
  uws: 'urn:blvd:Location:6eab61bf-d215-4f4f-a464-6211fa802beb',
  'upper west': 'urn:blvd:Location:6eab61bf-d215-4f4f-a464-6211fa802beb',
  'upper west side nyc': 'urn:blvd:Location:6eab61bf-d215-4f4f-a464-6211fa802beb',
  ues: 'urn:blvd:Location:5feecb61-9bcb-458a-ab42-09478386adbb',
  'upper east': 'urn:blvd:Location:5feecb61-9bcb-458a-ab42-09478386adbb',
  'upper east side nyc': 'urn:blvd:Location:5feecb61-9bcb-458a-ab42-09478386adbb',
  dupont: 'urn:blvd:Location:b11142af-3d1a-4d11-8194-0c50d023fd75',
  'dupont dc': 'urn:blvd:Location:b11142af-3d1a-4d11-8194-0c50d023fd75',
  'penn quarter dc': 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
  'navy yard dc': 'urn:blvd:Location:ce941e99-975b-4d98-9343-3139260821bb',
  'manhattan west plaza': 'urn:blvd:Location:bee8d08c-1a4b-4d7d-bf59-94b9dcd1523f',
  'brickell miami': 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65',
  'coral gables miami': 'urn:blvd:Location:01b80da8-0b5e-440a-b18b-03afbf5686bd',
  'flatiron nyc': 'urn:blvd:Location:9482e4e3-e33a-4e31-baa1-9d14acb6c1c8',
  'bryant park nyc': 'urn:blvd:Location:c80e43fc-22f5-4adf-b406-f50f59a85b80',
});
const DEFAULT_LEGACY_LOCATION_ID_REMAP = Object.freeze({
  'urn:blvd:Location:79afa932-6e84-49c7-9f0f-605c680599cc': 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
});
const DEFAULT_LOCATION_ALIAS_GROUPS = Object.freeze([]);

const membershipCache = new Map();
const clientFieldCache = new Map();
const typeFieldCache = new Map();
const typeFieldDetailCache = new Map();

function normalizeLocationNameKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocationUrnLike(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const urnMatch = raw.match(/^urn:blvd:location:([0-9a-f-]{36})$/i);
  if (urnMatch) return `urn:blvd:Location:${urnMatch[1].toLowerCase()}`;
  if (UUID_V4_LIKE_RE.test(raw)) return `urn:blvd:Location:${raw.toLowerCase()}`;
  return '';
}

function parseLegacyLocationRemap(rawValue) {
  const map = new Map();
  for (const [from, to] of Object.entries(DEFAULT_LEGACY_LOCATION_ID_REMAP)) {
    const fromId = normalizeLocationUrnLike(from);
    const toId = normalizeLocationUrnLike(to);
    if (fromId && toId) map.set(fromId, toId);
  }
  if (!rawValue) return map;
  try {
    const parsed = JSON.parse(rawValue);
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
      ? Object.entries(parsed)
      : [];
    for (const entry of entries) {
      let from = '';
      let to = '';
      if (Array.isArray(entry)) {
        from = String(entry[0] || '').trim();
        to = String(entry[1] || '').trim();
      } else if (entry && typeof entry === 'object') {
        from = String(entry.from || entry.source || entry.old || '').trim();
        to = String(entry.to || entry.target || entry.new || '').trim();
      }
      const fromId = normalizeLocationUrnLike(from);
      const toId = normalizeLocationUrnLike(to);
      if (fromId && toId) map.set(fromId, toId);
    }
    return map;
  } catch {
    return map;
  }
}

const LEGACY_LOCATION_ID_REMAP = parseLegacyLocationRemap(process.env.BOULEVARD_LOCATION_REMAP_JSON || '');

function remapLegacyBoulevardLocationId(locationId) {
  const normalized = normalizeLocationUrnLike(locationId);
  if (!normalized) return '';
  return LEGACY_LOCATION_ID_REMAP.get(normalized) || normalized;
}

const OFFICIAL_LOCATION_BY_ID = new Map(
  OFFICIAL_LOCATION_REGISTRY.map(entry => [normalizeLocationUrnLike(entry.id), {
    slug: String(entry.slug || '').trim(),
    name: String(entry.name || '').trim(),
    id: normalizeLocationUrnLike(entry.id),
  }]),
);

const OFFICIAL_LOCATION_ID_BY_NAME_KEY = (() => {
  const map = new Map();
  for (const entry of OFFICIAL_LOCATION_REGISTRY) {
    const id = normalizeLocationUrnLike(entry.id);
    if (!id) continue;
    const nameKey = normalizeLocationNameKey(entry.name);
    const slugKey = normalizeLocationNameKey(entry.slug);
    if (nameKey) map.set(nameKey, id);
    if (slugKey) map.set(slugKey, id);
  }
  for (const [alias, idValue] of Object.entries(OFFICIAL_LOCATION_NAME_ALIASES)) {
    const key = normalizeLocationNameKey(alias);
    const id = normalizeLocationUrnLike(idValue);
    if (key && id) map.set(key, id);
  }
  return map;
})();

function parseLocationAliasGroups(rawValue) {
  if (!rawValue) return DEFAULT_LOCATION_ALIAS_GROUPS;
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return DEFAULT_LOCATION_ALIAS_GROUPS;
    const groups = [];
    for (const group of parsed) {
      if (!Array.isArray(group)) continue;
      const normalizedGroup = [...new Set(group
        .map(item => remapLegacyBoulevardLocationId(item))
        .filter(Boolean))];
      if (normalizedGroup.length < 2) continue;
      const officialNames = new Set(
        normalizedGroup
          .map(id => OFFICIAL_LOCATION_BY_ID.get(id)?.name || '')
          .filter(Boolean),
      );
      // Safety guard: never alias two known, different storefronts.
      if (officialNames.size > 1) continue;
      groups.push(normalizedGroup);
    }
    return groups.length > 0 ? groups : DEFAULT_LOCATION_ALIAS_GROUPS;
  } catch {
    return DEFAULT_LOCATION_ALIAS_GROUPS;
  }
}

const LOCATION_ALIAS_GROUPS = parseLocationAliasGroups(process.env.BOULEVARD_LOCATION_ALIAS_GROUPS_JSON || '');
const LOCATION_ALIAS_CANONICAL_MAP = (() => {
  const map = new Map();
  for (const group of LOCATION_ALIAS_GROUPS) {
    const canonical = group[0];
    for (const member of group) map.set(member, canonical);
  }
  return map;
})();

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

function isInactiveMembershipStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  if (!normalized) return false;
  return ['INACTIVE', 'CANCELED', 'CANCELLED', 'PAST_DUE', 'EXPIRED', 'TERMINATED'].includes(normalized);
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

function getBoulevardAuthContext() {
  const apiKey = process.env.BOULEVARD_API_KEY;
  const apiSecret = process.env.BOULEVARD_API_SECRET;
  const businessId = process.env.BOULEVARD_BUSINESS_ID;
  if (!apiKey || !apiSecret || !businessId) return null;

  const apiUrl = normalizeBoulevardApiUrl(process.env.BOULEVARD_API_URL || DEFAULT_API_URL);
  const authCredentials = generateAuthHeader(apiKey, apiSecret, businessId);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${authCredentials}`,
    'X-Boulevard-Business-ID': businessId,
  };

  return { apiUrl, headers, businessId };
}

function normalizePhone(phone) {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  return digits;
}

function normalizeBoulevardLocationId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const urnLike = normalizeLocationUrnLike(raw);
  if (urnLike) return remapLegacyBoulevardLocationId(urnLike);
  const nameKey = normalizeLocationNameKey(raw);
  const idByName = OFFICIAL_LOCATION_ID_BY_NAME_KEY.get(nameKey);
  if (idByName) return idByName;
  return raw;
}

function canonicalizeBoulevardLocationId(value) {
  const normalized = normalizeBoulevardLocationId(value);
  if (!normalized) return '';
  return LOCATION_ALIAS_CANONICAL_MAP.get(normalized) || normalized;
}

function resolveBoulevardLocationInput(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return {
      input: '',
      locationId: '',
      canonicalId: '',
      locationName: null,
      official: false,
      source: 'empty',
    };
  }

  const normalized = normalizeBoulevardLocationId(raw);
  const canonical = canonicalizeBoulevardLocationId(normalized);
  const officialEntry = OFFICIAL_LOCATION_BY_ID.get(canonical) || OFFICIAL_LOCATION_BY_ID.get(normalized) || null;
  const isLocationUrn = Boolean(normalizeLocationUrnLike(normalized));
  const resolvedLocationId = officialEntry
    ? officialEntry.id
    : isLocationUrn
    ? canonical || normalized
    : '';

  let source = 'unknown';
  if (isLocationUrn) source = 'id';
  else if (officialEntry) source = 'name';

  return {
    input: raw,
    locationId: resolvedLocationId,
    canonicalId: officialEntry?.id || (isLocationUrn ? (canonical || normalized) : ''),
    locationName: officialEntry?.name || null,
    official: Boolean(officialEntry),
    source,
  };
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

function isExactFirstLastNameMatch(requestedName, candidateFirstName, candidateLastName) {
  const reqTokens = tokenizeName(requestedName);
  const candTokens = tokenizeName(`${candidateFirstName || ''} ${candidateLastName || ''}`);
  if (reqTokens.length < 2 || candTokens.length < 2) return false;
  return reqTokens[0] === candTokens[0] && reqTokens[reqTokens.length - 1] === candTokens[candTokens.length - 1];
}

function normalizeEmailLocalPart(email) {
  const raw = String(email || '').trim().toLowerCase();
  const at = raw.indexOf('@');
  if (at <= 0) return '';
  const local = raw.slice(0, at).split('+')[0];
  return local.replace(/\./g, '');
}

function emailsLikelyReferToSameMailbox(leftEmail, rightEmail) {
  const left = normalizeEmailLocalPart(leftEmail);
  const right = normalizeEmailLocalPart(rightEmail);
  if (!left || !right) return false;
  return left === right;
}

function resolveNameScanFallbackCandidate(requestedName, requestedEmail, candidates = []) {
  const prepared = candidates
    .map(item => ({ raw: item, node: item?.node || item }))
    .filter(item => item?.node && typeof item.node === 'object');

  const exactMatches = prepared.filter(item =>
    isExactFirstLastNameMatch(requestedName, item.node?.firstName || '', item.node?.lastName || '')
  );
  if (exactMatches.length === 1) {
    return { candidate: exactMatches[0].raw, strategy: 'name_scan_exact', reason: null };
  }
  if (exactMatches.length > 1) {
    const mailboxMatches = exactMatches.filter(item =>
      emailsLikelyReferToSameMailbox(requestedEmail, item.node?.email || '')
    );
    if (mailboxMatches.length === 1) {
      return { candidate: mailboxMatches[0].raw, strategy: 'name_scan_exact_mailbox', reason: null };
    }
    return { candidate: null, strategy: null, reason: 'ambiguous_exact_name' };
  }

  const likelyMailboxMatches = prepared.filter(item =>
    emailsLikelyReferToSameMailbox(requestedEmail, item.node?.email || '')
  );
  if (likelyMailboxMatches.length === 1) {
    return { candidate: likelyMailboxMatches[0].raw, strategy: 'name_scan_mailbox', reason: null };
  }

  const fuzzyMatches = prepared.filter(item =>
    namesLikelyMatch(requestedName, item.node?.firstName || '', item.node?.lastName || '')
  );
  if (fuzzyMatches.length === 1) {
    return { candidate: fuzzyMatches[0].raw, strategy: 'name_scan_fuzzy_unique', reason: null };
  }
  if (fuzzyMatches.length > 1) {
    return { candidate: null, strategy: null, reason: 'ambiguous_fuzzy_name' };
  }

  return { candidate: null, strategy: null, reason: 'no_match' };
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
    if (options.returnErrors) {
      return {
        __error: {
          stage: 'fetch',
          diagnostics: buildFetchErrorDiagnostics(fetchErr, apiUrl),
        },
      };
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const t = await response.text().catch(() => '');
    console.error(`Boulevard API HTTP ${response.status}: ${t.substring(0,500)}`);
    if (options.returnErrors) {
      return {
        __error: {
          stage: 'http',
          status: response.status,
          bodyPreview: t.substring(0, 500),
        },
      };
    }
    return null;
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    console.error('Boulevard API non-JSON:', e.message);
    if (options.returnErrors) {
      return {
        __error: {
          stage: 'non_json',
          message: e.message,
        },
      };
    }
    return null;
  }

  if (data.errors) {
    if (!options.silentErrors) {
      console.error('Boulevard GraphQL errors:', JSON.stringify(data.errors));
    }
    if (options.returnErrors) {
      return {
        __error: {
          stage: 'graphql',
          errors: data.errors,
        },
        data: data.data || null,
      };
    }
    return null;
  }

  return data;
}

function findNameMatch(name, clients, options = {}) {
  const normalizedRequestedName = String(name || '').trim();
  const allowAnyName = normalizedRequestedName.length === 0;
  const preferredLocationCanonicalId = canonicalizeBoulevardLocationId(options.preferLocationId || '') || null;
  const excludedClientIds = new Set(
    Array.isArray(options.excludeClientIds)
      ? options.excludeClientIds.map(id => String(id || '').trim()).filter(Boolean)
      : [],
  );

  const candidates = (Array.isArray(clients) ? clients : [])
    .filter(c => allowAnyName || namesLikelyMatch(normalizedRequestedName, c?.node?.firstName || '', c?.node?.lastName || ''))
    .filter(c => {
      const id = String(c?.node?.id || '').trim();
      return !excludedClientIds.has(id);
    });
  if (candidates.length === 0) return null;

  const withScore = candidates.map(candidate => {
    const node = candidate?.node || {};
    const candidateLocationCanonicalId = canonicalizeBoulevardLocationId(node?.primaryLocation?.id || '') || null;
    const appointmentCount = Number(node?.appointmentCount);
    const createdAtMs = new Date(node?.createdAt || 0).getTime();

    let score = 0;
    if (preferredLocationCanonicalId && candidateLocationCanonicalId === preferredLocationCanonicalId) score += 100;
    if (node?.active === true) score += 20;
    if (node?.active === false) score -= 20;
    if (Number.isFinite(appointmentCount)) score += Math.max(0, Math.min(appointmentCount, 30));

    return {
      candidate,
      score,
      appointmentCount: Number.isFinite(appointmentCount) ? appointmentCount : -1,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : -1,
    };
  });

  withScore.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.appointmentCount !== a.appointmentCount) return b.appointmentCount - a.appointmentCount;
    return b.createdAtMs - a.createdAtMs;
  });

  return withScore[0]?.candidate || null;
}

async function findClientsByNameScan(apiUrl, headers, requestedName) {
  const found = [];
  let after = null;

  for (let page = 0; page < PHONE_SCAN_MAX_PAGES; page++) {
    const query = `
      query FindClientsByNameScan($after: String) {
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
              primaryLocation { id name }
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
      if (namesLikelyMatch(requestedName, edge?.node?.firstName || '', edge?.node?.lastName || '')) {
        found.push(edge);
      }
    }

    // Keep scan bounded once we have several plausible candidates.
    if (found.length >= 8) return found;
    if (!connection?.pageInfo?.hasNextPage) break;

    after = connection?.pageInfo?.endCursor || null;
    if (!after) break;
  }

  return found;
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
              primaryLocation { id name }
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
              location { id name }
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

async function getTypeFieldSet(apiUrl, headers, typeName) {
  const key = `${apiUrl}::${typeName}`;
  const cached = typeFieldCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.fields;

  const query = `
    query IntrospectType($typeName: String!) {
      __type(name: $typeName) {
        fields {
          name
        }
      }
    }
  `;
  const data = await fetchBoulevardGraphQL(apiUrl, headers, query, { typeName }, { silentErrors: true });
  const fields = data?.data?.__type?.fields;

  if (!Array.isArray(fields) || fields.length === 0) {
    typeFieldCache.set(key, { fields: null, expiresAt: Date.now() + CLIENT_FIELD_CACHE_TTL_MS });
    return null;
  }

  const fieldSet = new Set(fields.map(f => String(f?.name || '').trim()).filter(Boolean));
  typeFieldCache.set(key, { fields: fieldSet, expiresAt: Date.now() + CLIENT_FIELD_CACHE_TTL_MS });
  return fieldSet;
}

function unwrapNamedType(typeNode) {
  let current = typeNode || null;
  while (current && current.kind === 'NON_NULL') current = current.ofType || null;
  while (current && current.kind === 'LIST') current = current.ofType || null;
  if (!current) return null;
  return {
    kind: current.kind || null,
    name: current.name || null,
  };
}

function formatGraphQLType(typeNode) {
  if (!typeNode || typeof typeNode !== 'object') return 'String';
  if (typeNode.kind === 'NON_NULL') return `${formatGraphQLType(typeNode.ofType)}!`;
  if (typeNode.kind === 'LIST') return `[${formatGraphQLType(typeNode.ofType)}]`;
  return typeNode.name || 'String';
}

async function getTypeFieldDetailMap(apiUrl, headers, typeName) {
  const key = `${apiUrl}::detail::${typeName}`;
  const cached = typeFieldDetailCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.fields;

  const query = `
    query IntrospectTypeDetailed($typeName: String!) {
      __type(name: $typeName) {
        fields {
          name
          args {
            name
            type {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
          }
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await fetchBoulevardGraphQL(apiUrl, headers, query, { typeName }, { silentErrors: true });
  const fields = data?.data?.__type?.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    typeFieldDetailCache.set(key, { fields: null, expiresAt: Date.now() + CLIENT_FIELD_CACHE_TTL_MS });
    return null;
  }

  const map = new Map();
  for (const field of fields) {
    const fieldName = String(field?.name || '').trim();
    if (!fieldName) continue;
    const namedType = unwrapNamedType(field?.type || null);
    const args = Array.isArray(field?.args)
      ? field.args.map(arg => {
          const argType = unwrapNamedType(arg?.type || null);
          return {
            name: String(arg?.name || '').trim(),
            kind: argType?.kind || null,
            namedType: argType?.name || null,
            required: arg?.type?.kind === 'NON_NULL',
          };
        }).filter(arg => arg.name)
      : null;
    map.set(fieldName, {
      fieldName,
      kind: namedType?.kind || null,
      namedType: namedType?.name || null,
      args: args?.map(arg => ({
        ...arg,
        typeText: formatGraphQLType(field?.args?.find(a => String(a?.name || '').trim() === arg.name)?.type || null),
      })) || null,
    });
  }
  typeFieldDetailCache.set(key, { fields: map, expiresAt: Date.now() + CLIENT_FIELD_CACHE_TTL_MS });
  return map;
}

async function resolveNestedNodeTypeName(apiUrl, headers, parentTypeName, parentFieldName) {
  const parentDetails = await getTypeFieldDetailMap(apiUrl, headers, parentTypeName);
  const parentField = parentDetails?.get(parentFieldName) || null;
  const parentNamedType = parentField?.namedType || null;
  if (!parentNamedType) return null;

  const childDetails = await getTypeFieldDetailMap(apiUrl, headers, parentNamedType);
  if (!childDetails) return null;

  if (childDetails.has('edges')) {
    const edgeType = childDetails.get('edges')?.namedType || null;
    if (!edgeType) return null;
    const edgeDetails = await getTypeFieldDetailMap(apiUrl, headers, edgeType);
    const nodeType = edgeDetails?.get('node')?.namedType || null;
    if (!nodeType) return null;
    return { shape: 'connection', nodeType };
  }

  return { shape: 'list_or_object', nodeType: parentNamedType };
}

async function buildProviderNestedPlan(apiUrl, headers, parentFieldName) {
  const resolved = await resolveNestedNodeTypeName(apiUrl, headers, 'Appointment', parentFieldName);
  if (!resolved?.nodeType) return null;

  const nodeFieldSet = await getTypeFieldSet(apiUrl, headers, resolved.nodeType);
  if (!nodeFieldSet) return null;

  const scalarCandidates = ['providerId', 'staffId', 'employeeId', 'serviceProviderId']
    .filter(name => nodeFieldSet.has(name));
  const objectCandidates = ['provider', 'staff', 'employee', 'serviceProvider', 'resource']
    .filter(name => nodeFieldSet.has(name));
  if (scalarCandidates.length === 0 && objectCandidates.length === 0) return null;

  const scalarPart = scalarCandidates.join('\n                  ');
  const objectPart = objectCandidates.map(name => `${name} { id }`).join('\n                  ');
  const combined = [scalarPart, objectPart].filter(Boolean).join('\n                  ');
  if (!combined) return null;

  const selection = resolved.shape === 'connection'
    ? `${parentFieldName} {\n                edges {\n                  node {\n                  ${combined}\n                  }\n                }\n              }`
    : `${parentFieldName} {\n                ${combined}\n              }`;

  return {
    parentFieldName,
    shape: resolved.shape,
    scalarCandidates,
    objectCandidates,
    selection,
  };
}

function readProviderFromNestedPlan(node, plan) {
  if (!node || !plan) return '';
  const container = node?.[plan.parentFieldName];
  if (!container) return '';

  const entries = [];
  if (plan.shape === 'connection') {
    for (const edge of container?.edges || []) {
      if (edge?.node) entries.push(edge.node);
    }
  } else if (Array.isArray(container)) {
    for (const item of container) {
      if (item && typeof item === 'object') entries.push(item);
    }
  } else if (container && typeof container === 'object') {
    entries.push(container);
  }

  for (const entry of entries) {
    for (const scalarField of plan.scalarCandidates) {
      const raw = entry?.[scalarField];
      if (raw !== null && raw !== undefined && String(raw).trim()) return String(raw).trim();
    }
    for (const objectField of plan.objectCandidates) {
      const nested = entry?.[objectField];
      const nestedId = nested?.id;
      if (nestedId !== null && nestedId !== undefined && String(nestedId).trim()) return String(nestedId).trim();
    }
  }

  return '';
}

function extractProviderIdHeuristic(node) {
  if (!node || typeof node !== 'object') return '';
  const queue = [{ value: node, providerContext: false }];
  const seen = new Set();

  while (queue.length > 0) {
    const item = queue.shift();
    const value = item?.value;
    const providerContext = item?.providerContext === true;
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const child of value) queue.push({ value: child, providerContext });
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      const keyLower = String(key || '').toLowerCase();
      const nextProviderContext = providerContext || /(provider|staff|employee|resource)/i.test(keyLower);

      if (nextProviderContext && keyLower === 'id' && (typeof child === 'string' || typeof child === 'number')) {
        const raw = String(child).trim();
        if (raw) return raw;
      }

      if (child && typeof child === 'object') {
        if (nextProviderContext) {
          const directId = child.id;
          if (directId !== null && directId !== undefined) {
            const raw = String(directId).trim();
            if (raw) return raw;
          }
        }
        queue.push({ value: child, providerContext: nextProviderContext });
      }
    }
  }

  return '';
}

async function getClientTypeFieldSet(apiUrl, headers) {
  const cached = clientFieldCache.get(apiUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.fields;
  const fields = await getTypeFieldSet(apiUrl, headers, 'Client');
  clientFieldCache.set(apiUrl, { fields, expiresAt: Date.now() + CLIENT_FIELD_CACHE_TTL_MS });
  return fields;
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

function pickFirstAvailableField(fieldSet, candidates) {
  for (const field of candidates) {
    if (fieldSet.has(field)) return field;
  }
  return null;
}

function minutesBetweenIso(startIso, endIso) {
  const startMs = new Date(startIso || 0).getTime();
  const endMs = new Date(endIso || 0).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return Math.round((endMs - startMs) / 60000);
}

function bucketDurationMinutes(durationMinutes) {
  if (!isFiniteNumber(durationMinutes)) return null;
  const raw = Number(durationMinutes);

  // Treat "service + transition" windows as their base service tier first.
  // This prevents 30-min appointments with built-in transition time from
  // being misclassified as 50-min when membership tier is unknown.
  const thirtyWithPrep = 30 + Math.max(PREP_BUFFER_30MIN, 0);
  if (raw <= thirtyWithPrep) return 30;

  const candidates = [50, 90];
  let bestTier = 50;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tier of candidates) {
    const withPrep = tier + prepBufferMinutesForDuration(tier);
    const distance = Math.min(Math.abs(raw - tier), Math.abs(raw - withPrep));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestTier = tier;
    }
  }
  return bestTier;
}

function tierFromDurationMinutes(durationMinutes) {
  if (durationMinutes === 30) return '30';
  if (durationMinutes === 50) return '50';
  if (durationMinutes === 90) return '90';
  return null;
}

function durationMinutesFromTier(tier) {
  const normalizedTier = String(tier || '').trim();
  if (normalizedTier === '30') return 30;
  if (normalizedTier === '50') return 50;
  if (normalizedTier === '90') return 90;
  return null;
}

function prepBufferMinutesForDuration(durationMinutes) {
  if (durationMinutes <= 30) return PREP_BUFFER_30MIN;
  if (durationMinutes <= 50) return PREP_BUFFER_50MIN;
  return PREP_BUFFER_90MIN;
}

function isCanceledAppointment(appt) {
  const status = String(appt?.status || '').toUpperCase();
  if (appt?.canceledAt) return true;
  return ['CANCELED', 'CANCELLED', 'NO_SHOW', 'DELETED', 'VOID'].includes(status);
}

function pickUpgradeTargetDuration(currentDurationMinutes) {
  if (!isFiniteNumber(currentDurationMinutes)) return null;
  if (currentDurationMinutes <= 30) return 50;
  return null;
}

function computeUpgradePricing(currentDurationMinutes, targetDurationMinutes, isMember) {
  const currentTier = tierFromDurationMinutes(currentDurationMinutes);
  const targetTier = tierFromDurationMinutes(targetDurationMinutes);
  if (!currentTier || !targetTier) return null;

  const walkinTotal = WALKIN_PRICES[targetTier];
  const walkinCurrent = WALKIN_PRICES[currentTier];
  const memberTotal = CURRENT_RATES[targetTier];
  const memberCurrent = CURRENT_RATES[currentTier];
  if (!isFiniteNumber(walkinTotal) || !isFiniteNumber(walkinCurrent) || !isFiniteNumber(memberTotal) || !isFiniteNumber(memberCurrent)) return null;

  return {
    walkinTotal,
    walkinDelta: Math.max(walkinTotal - walkinCurrent, 0),
    memberTotal,
    memberDelta: Math.max(memberTotal - memberCurrent, 0),
    offeredTotal: isMember ? memberTotal : walkinTotal,
    offeredDelta: isMember ? Math.max(memberTotal - memberCurrent, 0) : Math.max(walkinTotal - walkinCurrent, 0),
  };
}

function compactGraphQLErrorPayload(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.errors)) {
    return payload.errors.map(err => ({
      message: err?.message || null,
      path: err?.path || null,
      code: err?.extensions?.code || null,
    }));
  }
  return payload;
}

function readNodeFieldAsString(node, scalarField, objectField) {
  if (!node || typeof node !== 'object') return '';
  if (scalarField) {
    const raw = node[scalarField];
    if (raw !== null && raw !== undefined && String(raw).trim()) return String(raw).trim();
  }
  if (objectField) {
    const nested = node[objectField];
    if (nested && typeof nested === 'object') {
      const nestedId = nested.id;
      if (nestedId !== null && nestedId !== undefined && String(nestedId).trim()) return String(nestedId).trim();
    }
  }
  return '';
}

function isScalarOrEnumGraphqlKind(kind) {
  const normalized = String(kind || '').trim().toUpperCase();
  return normalized === 'SCALAR' || normalized === 'ENUM';
}

function readFirstPopulatedStringField(node, fieldNames = []) {
  if (!node || typeof node !== 'object') return '';
  for (const fieldName of fieldNames) {
    const key = String(fieldName || '').trim();
    if (!key) continue;
    const raw = node?.[key];
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim();
    if (text) return text;
  }
  return '';
}

async function getSchemaQueryTypeName(apiUrl, headers) {
  const query = `
    query IntrospectSchemaQueryType {
      __schema {
        queryType {
          name
        }
      }
    }
  `;
  const data = await fetchBoulevardGraphQL(apiUrl, headers, query, {}, { silentErrors: true, returnErrors: true });
  if (data?.__error) {
    return { name: null, error: data.__error };
  }
  return {
    name: String(data?.data?.__schema?.queryType?.name || '').trim() || null,
    error: null,
  };
}

async function getSchemaMutationTypeName(apiUrl, headers) {
  const query = `
    query IntrospectSchemaMutationType {
      __schema {
        mutationType {
          name
        }
      }
    }
  `;
  const data = await fetchBoulevardGraphQL(apiUrl, headers, query, {}, { silentErrors: true, returnErrors: true });
  if (data?.__error) {
    return { name: null, error: data.__error };
  }
  return {
    name: String(data?.data?.__schema?.mutationType?.name || '').trim() || null,
    error: null,
  };
}

function summarizeMutationField(detail) {
  if (!detail) return null;
  return {
    exists: true,
    namedType: detail.namedType || null,
    args: Array.isArray(detail.args)
      ? detail.args.map(arg => ({
          name: arg.name || null,
          required: arg.required === true,
          typeText: arg.typeText || null,
          namedType: arg.namedType || null,
        }))
      : [],
  };
}

async function probeCancelRebookCapabilities() {
  const auth = getBoulevardAuthContext();
  if (!auth) return { ok: false, reason: 'boulevard_not_configured' };

  let mutationTypeName = 'Mutation';
  let mutationFieldSet = await getTypeFieldSet(auth.apiUrl, auth.headers, mutationTypeName);
  let mutationRootSource = mutationFieldSet ? 'mutation_type_default' : null;
  let mutationIntrospectionError = null;

  if (!mutationFieldSet) {
    const schemaRoot = await getSchemaMutationTypeName(auth.apiUrl, auth.headers);
    if (schemaRoot?.name) {
      mutationTypeName = schemaRoot.name;
      mutationFieldSet = await getTypeFieldSet(auth.apiUrl, auth.headers, mutationTypeName);
      mutationRootSource = mutationFieldSet ? 'mutation_type_schema' : null;
    } else {
      mutationTypeName = 'RootMutationType';
      mutationFieldSet = await getTypeFieldSet(auth.apiUrl, auth.headers, mutationTypeName);
      mutationRootSource = mutationFieldSet ? 'mutation_type_fallback' : null;
      if (schemaRoot?.error) {
        mutationIntrospectionError = {
          stage: schemaRoot.error?.stage || null,
          status: schemaRoot.error?.status || null,
          errors: compactGraphQLErrorPayload(schemaRoot.error),
          bodyPreview: schemaRoot.error?.bodyPreview || null,
        };
      }
    }
  }

  if (!mutationFieldSet) {
    return {
      ok: false,
      reason: 'mutation_type_introspection_failed',
      mutationTypeName,
      mutationRootSource,
      mutationIntrospectionError,
    };
  }

  const mutationFieldDetailMap = await getTypeFieldDetailMap(auth.apiUrl, auth.headers, mutationTypeName);
  const fieldNames = [
    'appointmentCancel',
    'cancelAppointment',
    'appointmentUpdate',
    'updateAppointment',
    'appointmentCreate',
    'createAppointment',
    'bookingCreate',
    'bookingCreateFromAppointment',
    'bookingAddService',
  ];

  const fieldSummary = {};
  for (const fieldName of fieldNames) {
    const detail = mutationFieldDetailMap?.get(fieldName) || null;
    fieldSummary[fieldName] = summarizeMutationField(detail);
  }

  const hasCancelMutation = Boolean(fieldSummary.appointmentCancel || fieldSummary.cancelAppointment);
  const hasCreateMutation = Boolean(
    fieldSummary.appointmentCreate ||
    fieldSummary.createAppointment ||
    fieldSummary.bookingCreate ||
    fieldSummary.bookingCreateFromAppointment,
  );
  const hasServiceMutation = Boolean(fieldSummary.bookingAddService);
  const canAttemptCancelRebook = hasCancelMutation && (hasCreateMutation || hasServiceMutation);

  return {
    ok: true,
    mutationTypeName,
    mutationRootSource,
    hasCancelMutation,
    hasCreateMutation,
    hasServiceMutation,
    canAttemptCancelRebook,
    fields: fieldSummary,
  };
}

function buildQueryRootStrategies(rootFieldDetail, rootLooksLikeConnection) {
  const strategies = [];
  const seen = new Set();
  const add = (strategy) => {
    if (!strategy || seen.has(strategy.id)) return;
    seen.add(strategy.id);
    strategies.push(strategy);
  };

  const args = Array.isArray(rootFieldDetail?.args) ? rootFieldDetail.args : null;
  const argNames = new Set((args || []).map(arg => arg.name));
  const hasArgMetadata = Array.isArray(args);
  const supportsFirst = argNames.has('first');
  const supportsAfter = argNames.has('after');
  const supportsLast = argNames.has('last');
  const supportsBefore = argNames.has('before');

  const treatAsConnection = rootLooksLikeConnection !== false;
  if (treatAsConnection) {
    if (!hasArgMetadata || (supportsLast && supportsBefore)) {
      add({ id: 'connection_last_before', mode: 'connection', supportsPaging: true, argMode: 'last_before' });
    }
    if (!hasArgMetadata || supportsLast) {
      add({ id: 'connection_last_only', mode: 'connection', supportsPaging: false, argMode: 'last_only' });
    }
    if (!hasArgMetadata || (supportsFirst && supportsAfter)) {
      add({ id: 'connection_first_after', mode: 'connection', supportsPaging: true, argMode: 'first_after' });
    }
    if (!hasArgMetadata || supportsFirst) {
      add({ id: 'connection_first_only', mode: 'connection', supportsPaging: false, argMode: 'first_only' });
    }
    add({ id: 'connection_no_args', mode: 'connection', supportsPaging: false, argMode: 'no_args' });
  }

  add({ id: 'list_no_args', mode: 'list', supportsPaging: false, argMode: 'no_args' });
  if (!hasArgMetadata || supportsFirst) add({ id: 'list_first_only', mode: 'list', supportsPaging: false, argMode: 'first_only' });
  add({ id: 'list_nodes_no_args', mode: 'nodes_list', supportsPaging: false, argMode: 'no_args' });
  if (!hasArgMetadata || supportsFirst) add({ id: 'list_nodes_first_only', mode: 'nodes_list', supportsPaging: false, argMode: 'first_only' });

  if (strategies.length === 0) {
    add({ id: 'connection_no_args', mode: 'connection', supportsPaging: false, argMode: 'no_args' });
    add({ id: 'list_no_args', mode: 'list', supportsPaging: false, argMode: 'no_args' });
  }
  return strategies;
}

function pickQueryContextArgValue(argName, context) {
  if (!argName) return null;
  if (argName === 'locationId') return normalizeBoulevardLocationId(context?.locationId || '') || null;
  if (argName === 'clientId') return String(context?.clientId || '').trim() || null;
  return null;
}

function buildRootQueryArgBindings(rootFieldDetail, context = {}) {
  const argDefs = Array.isArray(rootFieldDetail?.args) ? rootFieldDetail.args : [];
  const argBindings = [];
  const variableDefs = [];
  const variables = {};
  const missingRequiredArgs = [];

  for (const arg of argDefs) {
    const argName = String(arg?.name || '').trim();
    if (!argName || argName === 'first' || argName === 'after' || argName === 'last' || argName === 'before') continue;

    const value = pickQueryContextArgValue(argName, context);
    const hasValue = value !== null && value !== undefined && String(value).trim() !== '';
    if (!hasValue) {
      if (arg?.required) missingRequiredArgs.push(argName);
      continue;
    }

    argBindings.push(`${argName}: $${argName}`);
    variableDefs.push(`$${argName}: ${arg?.typeText || (arg?.required ? 'String!' : 'String')}`);
    variables[argName] = typeof value === 'string' ? value.trim() : value;
  }

  return {
    argBindings,
    variableDefs,
    variables,
    missingRequiredArgs,
  };
}

function buildScanAppointmentsQuery(queryRoot, selectedFields, strategy, rootBindings = null) {
  const fields = selectedFields.join('\n                ');
  const rootArgBindings = Array.isArray(rootBindings?.argBindings) ? rootBindings.argBindings : [];
  const rootVariableDefs = Array.isArray(rootBindings?.variableDefs) ? rootBindings.variableDefs : [];

  if (strategy.mode === 'connection') {
    const strategyArgs = strategy.argMode === 'last_before'
      ? [`last: ${APPOINTMENT_SCAN_PAGE_SIZE}`, 'before: $before']
      : strategy.argMode === 'last_only'
      ? [`last: ${APPOINTMENT_SCAN_PAGE_SIZE}`]
      : strategy.argMode === 'first_after'
      ? [`first: ${APPOINTMENT_SCAN_PAGE_SIZE}`, 'after: $after']
      : strategy.argMode === 'first_only'
      ? [`first: ${APPOINTMENT_SCAN_PAGE_SIZE}`]
      : [];
    const allArgs = [...strategyArgs, ...rootArgBindings];
    const argFragment = allArgs.length > 0 ? `(${allArgs.join(', ')})` : '';
    const strategyVariableDefs = strategy.argMode === 'last_before'
      ? ['$before: String']
      : strategy.argMode === 'first_after'
      ? ['$after: String']
      : [];
    const allVariableDefs = [...strategyVariableDefs, ...rootVariableDefs];
    const variableDef = allVariableDefs.length > 0 ? `(${allVariableDefs.join(', ')})` : '';
    return `
      query ScanAppointments${variableDef} {
        ${queryRoot}${argFragment} {
          edges {
            node {
              ${fields}
            }
          }
          pageInfo { hasNextPage endCursor hasPreviousPage startCursor }
        }
      }
    `;
  }
  if (strategy.mode === 'nodes_list') {
    const strategyArgs = strategy.argMode === 'first_only'
      ? [`first: ${APPOINTMENT_SCAN_PAGE_SIZE}`]
      : [];
    const allArgs = [...strategyArgs, ...rootArgBindings];
    const argFragment = allArgs.length > 0 ? `(${allArgs.join(', ')})` : '';
    const strategyVariableDefs = [];
    const allVariableDefs = [...strategyVariableDefs, ...rootVariableDefs];
    const variableDef = allVariableDefs.length > 0 ? `(${allVariableDefs.join(', ')})` : '';
    return `
      query ScanAppointments${variableDef} {
        ${queryRoot}${argFragment} {
          nodes {
            ${fields}
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
  }

  const strategyArgs = strategy.argMode === 'first_only'
    ? [`first: ${APPOINTMENT_SCAN_PAGE_SIZE}`]
    : [];
  const allArgs = [...strategyArgs, ...rootArgBindings];
  const argFragment = allArgs.length > 0 ? `(${allArgs.join(', ')})` : '';
  const allVariableDefs = [...rootVariableDefs];
  const variableDef = allVariableDefs.length > 0 ? `(${allVariableDefs.join(', ')})` : '';
  return `
    query ScanAppointments${variableDef} {
      ${queryRoot}${argFragment} {
        ${fields}
      }
    }
  `;
}

function extractStrategyNodes(payload, strategy) {
  if (!payload) return { nodes: [], pageInfo: null };

  if (strategy.mode === 'connection') {
    const edges = Array.isArray(payload?.edges) ? payload.edges : [];
    const nodes = edges.map(edge => edge?.node).filter(Boolean);
    return { nodes, pageInfo: payload?.pageInfo || null };
  }

  if (strategy.mode === 'nodes_list') {
    const nodes = Array.isArray(payload?.nodes) ? payload.nodes.filter(Boolean) : [];
    return { nodes, pageInfo: payload?.pageInfo || null };
  }

  if (Array.isArray(payload)) return { nodes: payload.filter(Boolean), pageInfo: null };
  if (Array.isArray(payload?.nodes)) return { nodes: payload.nodes.filter(Boolean), pageInfo: payload?.pageInfo || null };
  if (Array.isArray(payload?.edges)) {
    const nodes = payload.edges.map(edge => edge?.node).filter(Boolean);
    return { nodes, pageInfo: payload?.pageInfo || null };
  }
  if (payload && typeof payload === 'object') return { nodes: [payload], pageInfo: payload?.pageInfo || null };
  return { nodes: [], pageInfo: null };
}

async function scanAppointments(apiUrl, headers, context = {}) {
  const locationIdForScan = normalizeBoulevardLocationId(context?.locationId || '') || null;
  const locationCanonicalIdForScan = canonicalizeBoulevardLocationId(locationIdForScan || '') || null;
  const clientIdForScan = String(context?.clientId || '').trim() || null;
  const diagnostics = {
    typeIntrospection: null,
    queryIntrospection: null,
    queryTypeName: null,
    locationId: locationIdForScan,
    locationCanonicalId: locationCanonicalIdForScan,
    clientId: clientIdForScan,
    queryRootTried: [],
    queryAttempts: [],
    queryErrors: [],
    failure: null,
  };

  const fieldSet = await getTypeFieldSet(apiUrl, headers, 'Appointment');
  diagnostics.typeIntrospection = fieldSet ? 'ok' : 'missing_type_or_fields';
  if (!fieldSet) {
    diagnostics.failure = 'appointment_type_introspection_failed';
    return { appointments: null, diagnostics };
  }

  const defaultQueryRootCandidates = ['appointments', 'bookings', 'calendarAppointments'];
  let queryTypeName = 'Query';
  let queryFieldSet = await getTypeFieldSet(apiUrl, headers, queryTypeName);
  if (queryFieldSet) {
    diagnostics.queryIntrospection = 'ok';
  } else {
    const schemaRoot = await getSchemaQueryTypeName(apiUrl, headers);
    if (schemaRoot?.name) {
      queryTypeName = schemaRoot.name;
      queryFieldSet = await getTypeFieldSet(apiUrl, headers, queryTypeName);
      diagnostics.queryIntrospection = queryFieldSet ? 'ok_via_schema_query_type' : 'schema_query_type_missing_fields';
    } else {
      queryTypeName = 'RootQueryType';
      queryFieldSet = await getTypeFieldSet(apiUrl, headers, queryTypeName);
      diagnostics.queryIntrospection = queryFieldSet ? 'ok_via_root_query_type_fallback' : 'missing_query_type';
      if (schemaRoot?.error) {
        diagnostics.queryTypeIntrospectionError = {
          stage: schemaRoot.error?.stage || null,
          status: schemaRoot.error?.status || null,
          errors: compactGraphQLErrorPayload(schemaRoot.error),
          bodyPreview: schemaRoot.error?.bodyPreview || null,
        };
      }
    }
  }
  diagnostics.queryTypeName = queryTypeName;

  const introspectedRoots = queryFieldSet
    ? defaultQueryRootCandidates.filter(root => queryFieldSet.has(root))
    : [];
  const queryRootCandidates = introspectedRoots.length > 0 ? introspectedRoots : defaultQueryRootCandidates;
  if (queryRootCandidates.length === 0) {
    diagnostics.failure = 'appointments_query_field_not_found';
    return { appointments: null, diagnostics };
  }

  const clientIdField = pickFirstAvailableField(fieldSet, ['clientId', 'customerId']);
  const clientObjectField = pickFirstAvailableField(fieldSet, ['client', 'customer']);
  const providerIdField = pickFirstAvailableField(fieldSet, ['providerId', 'staffId', 'employeeId', 'serviceProviderId']);
  const providerObjectField = pickFirstAvailableField(fieldSet, ['provider', 'staff', 'employee', 'serviceProvider']);
  const providerNestedPlans = [];
  if (!providerIdField && !providerObjectField) {
    const nestedProviderParentCandidates = ['appointmentServices', 'appointmentServiceResources'];
    for (const parentField of nestedProviderParentCandidates) {
      if (!fieldSet.has(parentField)) continue;
      const plan = await buildProviderNestedPlan(apiUrl, headers, parentField);
      if (plan) providerNestedPlans.push(plan);
    }
  }
  const locationIdField = pickFirstAvailableField(fieldSet, ['locationId']);
  const locationObjectField = pickFirstAvailableField(fieldSet, ['location']);
  const statusField = pickFirstAvailableField(fieldSet, ['status', 'state', 'appointmentStatus']);
  const canceledAtField = pickFirstAvailableField(fieldSet, ['canceledAt', 'cancelledAt']);
  const startField = pickFirstAvailableField(fieldSet, ['startOn', 'startAt', 'startsAt', 'startTime', 'startDateTime', 'start']);
  const endField = pickFirstAvailableField(fieldSet, ['endOn', 'endAt', 'endsAt', 'endTime', 'endDateTime', 'end']);

  const hasClientIdentity = Boolean(clientIdField || clientObjectField);
  const hasProviderIdentity = Boolean(providerIdField || providerObjectField || providerNestedPlans.length > 0);
  if (!fieldSet.has('id') || !startField || !endField || !hasClientIdentity) {
    diagnostics.failure = 'appointment_missing_required_fields';
    diagnostics.requiredFields = {
      hasId: fieldSet.has('id'),
      hasStartField: Boolean(startField),
      hasEndField: Boolean(endField),
      hasStartOn: fieldSet.has('startOn'),
      hasEndOn: fieldSet.has('endOn'),
      startField: startField || null,
      endField: endField || null,
      clientIdField,
      clientObjectField,
      providerIdField,
      providerObjectField,
      hasProviderIdentity,
      providerNestedParents: providerNestedPlans.map(plan => plan.parentFieldName),
      availableFields: Array.from(fieldSet).sort(),
    };
    return { appointments: null, diagnostics };
  }

  const selectedFields = ['id', startField, endField];
  if (clientIdField) selectedFields.push(clientIdField);
  else if (clientObjectField) selectedFields.push(`${clientObjectField} { id }`);
  if (providerIdField) selectedFields.push(providerIdField);
  else if (providerObjectField) selectedFields.push(`${providerObjectField} { id }`);
  else {
    for (const plan of providerNestedPlans) selectedFields.push(plan.selection);
  }
  if (locationIdField) selectedFields.push(locationIdField);
  else if (locationObjectField) selectedFields.push(`${locationObjectField} { id }`);
  if (statusField) selectedFields.push(statusField);
  if (canceledAtField) selectedFields.push(canceledAtField);

  const queryFieldDetailMap = await getTypeFieldDetailMap(apiUrl, headers, queryTypeName);
  let successfulEmptyStrategy = null;

  for (const queryRoot of queryRootCandidates) {
    diagnostics.queryRootTried.push(queryRoot);
    const rootFieldDetail = queryFieldDetailMap?.get(queryRoot) || null;
    const rootReturnTypeName = rootFieldDetail?.namedType || null;
    const rootReturnTypeFieldSet = rootReturnTypeName
      ? await getTypeFieldSet(apiUrl, headers, rootReturnTypeName)
      : null;
    const rootLooksLikeConnection = rootReturnTypeFieldSet
      ? rootReturnTypeFieldSet.has('edges') || rootReturnTypeFieldSet.has('nodes')
      : null;
    const rootBindings = buildRootQueryArgBindings(rootFieldDetail, {
      locationId: locationIdForScan,
      clientId: clientIdForScan,
    });
    if (rootBindings.missingRequiredArgs.length > 0) {
      const missingArgsError = {
        root: queryRoot,
        strategy: null,
        stage: 'preflight',
        status: null,
        errors: rootBindings.missingRequiredArgs.map(argName => ({
          message: `Missing required query argument value: ${argName}`,
          path: [queryRoot, argName],
          code: 'MISSING_REQUIRED_QUERY_ARG',
        })),
        bodyPreview: null,
      };
      diagnostics.queryErrors.push(missingArgsError);
      diagnostics.lastQueryError = missingArgsError;
      continue;
    }
    const strategies = buildQueryRootStrategies(rootFieldDetail, rootLooksLikeConnection);

    for (const strategy of strategies) {
      const appointments = [];
      let after = null;
      let before = null;
      let queryFailed = false;
      let queryError = null;

      for (let page = 0; page < APPOINTMENT_SCAN_MAX_PAGES; page++) {
        const query = buildScanAppointmentsQuery(queryRoot, selectedFields, strategy, rootBindings);
        const variables = {
          ...rootBindings.variables,
          ...(strategy.argMode === 'last_before' ? { before } : {}),
          ...(strategy.argMode === 'first_after' ? { after } : {}),
        };
        const data = await fetchBoulevardGraphQL(
          apiUrl,
          headers,
          query,
          variables,
          { silentErrors: true, returnErrors: true },
        );
        if (data?.__error) {
          queryFailed = true;
          queryError = data.__error;
          diagnostics.queryAttempts.push({
            root: queryRoot,
            strategy: strategy.id,
            page,
            ok: false,
          });
          break;
        }

        diagnostics.queryAttempts.push({
          root: queryRoot,
          strategy: strategy.id,
          page,
          ok: true,
        });
        const payload = data?.data?.[queryRoot];
        const { nodes, pageInfo } = extractStrategyNodes(payload, strategy);
        if (nodes.length === 0) break;

        for (const rawNode of nodes) {
          const node = rawNode || {};
          const normalized = {
            id: String(node.id || ''),
            startOn: node[startField] || null,
            endOn: node[endField] || null,
            clientId: readNodeFieldAsString(node, clientIdField, clientObjectField),
            providerId:
              readNodeFieldAsString(node, providerIdField, providerObjectField) ||
              providerNestedPlans.map(plan => readProviderFromNestedPlan(node, plan)).find(Boolean) ||
              extractProviderIdHeuristic(node) ||
              '',
            locationId: locationIdField
              ? String(node[locationIdField] || '')
              : readNodeFieldAsString(node, null, locationObjectField) || null,
            status: statusField ? String(node[statusField] || '') : null,
            canceledAt: canceledAtField ? node[canceledAtField] : null,
          };
          if (!normalized.id || !normalized.startOn || !normalized.endOn || !normalized.clientId) continue;
          appointments.push(normalized);
        }

        if (!strategy.supportsPaging) break;
        if (strategy.argMode === 'last_before') {
          if (!pageInfo?.hasPreviousPage) break;
          before = pageInfo?.startCursor || null;
          if (!before) break;
        } else {
          if (!pageInfo?.hasNextPage) break;
          after = pageInfo?.endCursor || null;
          if (!after) break;
        }
      }

      if (!queryFailed) {
        if (appointments.length > 0) {
          diagnostics.failure = null;
          diagnostics.querySuccess = {
            root: queryRoot,
            strategy: strategy.id,
            totalAppointments: appointments.length,
          };
          return { appointments, diagnostics };
        }
        successfulEmptyStrategy = {
          root: queryRoot,
          strategy: strategy.id,
          totalAppointments: 0,
        };
        continue;
      }

      const formattedError = {
        root: queryRoot,
        strategy: strategy.id,
        stage: queryError?.stage || null,
        status: queryError?.status || null,
        errors: compactGraphQLErrorPayload(queryError),
        bodyPreview: queryError?.bodyPreview || null,
      };
      diagnostics.queryErrors.push(formattedError);
      diagnostics.lastQueryError = formattedError;
    }
  }

  if (successfulEmptyStrategy) {
    diagnostics.failure = null;
    diagnostics.querySuccess = successfulEmptyStrategy;
    return { appointments: [], diagnostics };
  }

  diagnostics.failure = 'appointments_query_failed';
  return { appointments: null, diagnostics };
}

function evaluateUpgradeEligibilityFromAppointments(appointments, profile, options = {}) {
  if (!Array.isArray(appointments) || appointments.length === 0) {
    return { eligible: false, reason: 'no_appointments_available' };
  }
  const clientId = String(profile?.clientId || '');
  if (!clientId) return { eligible: false, reason: 'missing_client_id' };

  const now = new Date(options.now || new Date());
  if (Number.isNaN(now.getTime())) return { eligible: false, reason: 'invalid_now' };
  const nowMs = now.getTime();
  const windowHours = Number(options.windowHours || UPGRADE_WINDOW_HOURS);
  const windowMs = Math.max(windowHours, 0) * 60 * 60 * 1000;

  const upcoming = appointments
    .filter(appt => appt.clientId === clientId)
    .filter(appt => !isCanceledAppointment(appt))
    .filter(appt => {
      const startMs = new Date(appt.startOn).getTime();
      return Number.isFinite(startMs) && startMs > nowMs && startMs - nowMs <= windowMs;
    })
    .sort((a, b) => new Date(a.startOn).getTime() - new Date(b.startOn).getTime());

  if (upcoming.length === 0) return { eligible: false, reason: 'no_upcoming_appointment_in_window' };

  const targetAppointmentId = String(options.appointmentId || '').trim();
  if (!targetAppointmentId && upcoming.length > 1) {
    return { eligible: false, reason: 'multiple_upcoming_appointments_require_appointment_id' };
  }
  const current = targetAppointmentId
    ? upcoming.find(appt => appt.id === targetAppointmentId) || null
    : upcoming[0];
  if (!current) return { eligible: false, reason: 'target_appointment_not_found' };

  const rawDuration = minutesBetweenIso(current.startOn, current.endOn);
  let currentDurationMinutes = bucketDurationMinutes(rawDuration);
  const profileTierDuration = durationMinutesFromTier(profile?.tier);
  if (
    isFiniteNumber(profileTierDuration) &&
    isFiniteNumber(rawDuration) &&
    rawDuration >= profileTierDuration &&
    rawDuration <= profileTierDuration + prepBufferMinutesForDuration(profileTierDuration)
  ) {
    // Boulevard endOn can include transition time; clamp to base service duration when it matches tier + prep.
    currentDurationMinutes = profileTierDuration;
  }
  if (!isFiniteNumber(currentDurationMinutes)) return { eligible: false, reason: 'invalid_current_duration' };
  const hasAddonOnBooking = Boolean(
    currentDurationMinutes === 50 &&
    isFiniteNumber(rawDuration) &&
    rawDuration > 60,
  );

  const currentEndMs = new Date(current.endOn).getTime();
  if (!Number.isFinite(currentEndMs)) return { eligible: false, reason: 'invalid_current_end_time' };

  const hasProviderIdentity = Boolean(String(current.providerId || '').trim());
  const currentLocationCanonicalId = canonicalizeBoulevardLocationId(current.locationId || '') || null;
  const providerCommitments = appointments
    .filter(appt => appt.id !== current.id)
    .filter(appt => !isCanceledAppointment(appt))
    .filter(appt => {
      const startMs = new Date(appt.startOn).getTime();
      return Number.isFinite(startMs) && startMs > new Date(current.startOn).getTime();
    })
    .filter(appt => {
      if (hasProviderIdentity) return appt.providerId === current.providerId;
      if (currentLocationCanonicalId && appt.locationId) {
        return canonicalizeBoulevardLocationId(appt.locationId) === currentLocationCanonicalId;
      }
      return true;
    })
    .sort((a, b) => new Date(a.startOn).getTime() - new Date(b.startOn).getTime());

  const nextCommitment = providerCommitments[0] || null;
  const nextStartMs = nextCommitment ? new Date(nextCommitment.startOn).getTime() : null;
  const hasFiniteGap = Number.isFinite(nextStartMs);
  const availableGapMinutes = hasFiniteGap
    ? Math.floor((nextStartMs - currentEndMs) / 60000)
    : Number.POSITIVE_INFINITY;

  const targetDurationMinutes = isFiniteNumber(options.targetDurationMinutes)
    ? options.targetDurationMinutes
    : pickUpgradeTargetDuration(currentDurationMinutes);
  const isMember = Boolean(profile?.tier) && !/inactive|cancel/.test(String(profile?.accountStatus || '').toLowerCase());
  if (!isFiniteNumber(targetDurationMinutes)) {
    return {
      eligible: false,
      reason: 'no_upgrade_target_for_duration',
      appointmentId: current.id,
      clientId: current.clientId,
      providerId: current.providerId || null,
      providerIdentityMode: hasProviderIdentity ? 'exact_provider' : 'fallback_no_provider_id',
      locationId: current.locationId || null,
      locationCanonicalId: currentLocationCanonicalId,
      startOn: current.startOn,
      endOn: current.endOn,
      nextCommitmentStartOn: nextCommitment?.startOn || null,
      currentDurationMinutes,
      targetDurationMinutes: null,
      requiredExtraMinutes: null,
      requiredGapMinutes: null,
      prepBufferMinutes: 0,
      availableGapMinutes: Number.isFinite(availableGapMinutes) ? availableGapMinutes : null,
      gapUnlimited: !hasFiniteGap,
      hasAddonOnBooking,
      isMember,
      pricing: null,
    };
  }
  if (Number(targetDurationMinutes) !== 50) {
    return { eligible: false, reason: 'unsupported_upgrade_target' };
  }
  if (currentDurationMinutes >= 50) {
    return { eligible: false, reason: 'already_at_or_above_target_duration' };
  }

  // V1 SMS spec: 30->50 is eligible when there are at least 15 free minutes
  // after the current appointment block ends.
  const requiredExtraMinutes = 15;
  const prepBufferMinutes = 0;
  const pricing = computeUpgradePricing(currentDurationMinutes, targetDurationMinutes, isMember);
  if (!pricing) return { eligible: false, reason: 'pricing_unavailable' };

  return {
    eligible: availableGapMinutes >= requiredExtraMinutes,
    reason: availableGapMinutes >= requiredExtraMinutes ? 'eligible' : 'insufficient_gap',
    appointmentId: current.id,
    clientId: current.clientId,
    providerId: current.providerId || null,
    providerIdentityMode: hasProviderIdentity ? 'exact_provider' : 'fallback_no_provider_id',
    locationId: current.locationId || null,
    locationCanonicalId: currentLocationCanonicalId,
    startOn: current.startOn,
    endOn: current.endOn,
    nextCommitmentStartOn: nextCommitment?.startOn || null,
    currentDurationMinutes,
    targetDurationMinutes,
    requiredExtraMinutes,
    requiredGapMinutes: requiredExtraMinutes,
    prepBufferMinutes,
    availableGapMinutes: Number.isFinite(availableGapMinutes) ? availableGapMinutes : null,
    gapUnlimited: !hasFiniteGap,
    hasAddonOnBooking,
    isMember,
    pricing,
  };
}

async function evaluateUpgradeOpportunityForProfile(profile, options = {}) {
  const auth = getBoulevardAuthContext();
  if (!auth) return { eligible: false, reason: 'boulevard_not_configured' };

  const locationInput = (
    options?.locationId ||
    profile?.locationId ||
    profile?.primaryLocationId ||
    profile?.location?.id ||
    ''
  );
  const profileLocationId = resolveBoulevardLocationInput(locationInput).locationId || null;

  const scan = await scanAppointments(auth.apiUrl, auth.headers, {
    locationId: profileLocationId,
    clientId: profile?.clientId || null,
  });
  let appointments = scan?.appointments || null;
  let fallbackScanUsed = false;

  // Guests can have appointments at locations other than their primary profile location.
  // If a location-scoped scan returns no rows, retry once without location scoping.
  if (Array.isArray(appointments) && appointments.length === 0 && profileLocationId) {
    const fallbackScan = await scanAppointments(auth.apiUrl, auth.headers, {
      locationId: null,
      clientId: profile?.clientId || null,
    });
    if (Array.isArray(fallbackScan?.appointments)) {
      appointments = fallbackScan.appointments;
      fallbackScanUsed = true;
    }
  }

  if (!appointments) {
    return {
      eligible: false,
      reason: 'appointment_scan_failed',
      diagnostics: scan?.diagnostics || null,
    };
  }

  const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, options);
  if (fallbackScanUsed) {
    result.locationFallbackUsed = true;
  }
  return result;
}

async function tryApplyAppointmentUpgradeMutation(apiUrl, headers, appointmentId, serviceId) {
  const mutationCandidates = [
    {
      root: 'updateAppointment',
      query: `
        mutation UpgradeAppointment($appointmentId: ID!, $serviceId: ID!) {
          updateAppointment(input: { id: $appointmentId, serviceId: $serviceId }) {
            appointment { id }
          }
        }
      `,
    },
    {
      root: 'appointmentUpdate',
      query: `
        mutation UpgradeAppointmentAlt($appointmentId: ID!, $serviceId: ID!) {
          appointmentUpdate(input: { id: $appointmentId, serviceId: $serviceId }) {
            appointment { id }
          }
        }
      `,
    },
  ];

  for (const candidate of mutationCandidates) {
    const data = await fetchBoulevardGraphQL(
      apiUrl,
      headers,
      candidate.query,
      { appointmentId, serviceId },
      { silentErrors: true },
    );
    if (!data) continue;
    const node = data?.data?.[candidate.root];
    const updatedId = node?.appointment?.id || node?.id || null;
    if (updatedId) return { applied: true, mutationRoot: candidate.root, updatedId: String(updatedId) };
  }

  return { applied: false, reason: 'upgrade_mutation_failed' };
}

async function fetchAppointmentContextById(apiUrl, headers, appointmentId) {
  const id = String(appointmentId || '').trim();
  if (!id) return null;
  const appointmentFieldDetailMap = await getTypeFieldDetailMap(apiUrl, headers, 'Appointment');
  const noteFieldCandidates = ['notes', 'note', 'internalNotes', 'internalNote']
    .filter(fieldName => {
      const detail = appointmentFieldDetailMap?.get(fieldName) || null;
      return detail && isScalarOrEnumGraphqlKind(detail.kind);
    });
  const noteSelection = noteFieldCandidates.join('\n        ');
  const query = `
    query FetchAppointmentContext($id: ID!) {
      appointment(id: $id) {
        id
        clientId
        locationId
        startAt
        endAt
        ${noteSelection}
        appointmentServices {
          id
          serviceId
          staffId
        }
      }
    }
  `;
  const data = await fetchBoulevardGraphQL(
    apiUrl,
    headers,
    query,
    { id },
    { silentErrors: true, returnErrors: true },
  );
  if (!data || data.__error) return null;
  const appointment = data?.data?.appointment || null;
  if (!appointment?.id) return null;
  const services = Array.isArray(appointment.appointmentServices) ? appointment.appointmentServices : [];
  const primaryService = services.find(service => String(service?.staffId || '').trim()) || services[0] || null;
  return {
    appointmentId: String(appointment.id || '').trim() || null,
    clientId: String(appointment.clientId || '').trim() || null,
    locationId: String(appointment.locationId || '').trim() || null,
    startOn: String(appointment.startAt || '').trim() || null,
    endOn: String(appointment.endAt || '').trim() || null,
    notes: readFirstPopulatedStringField(appointment, noteFieldCandidates) || null,
    providerId: String(primaryService?.staffId || '').trim() || null,
    serviceId: String(primaryService?.serviceId || '').trim() || null,
  };
}

function toBoulevardNaiveDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?/);
  if (direct) {
    const seconds = direct[2] || '00';
    return `${direct[1]}:${seconds}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  const yyyy = parsed.getUTCFullYear();
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getUTCDate()).padStart(2, '0');
  const hh = String(parsed.getUTCHours()).padStart(2, '0');
  const mi = String(parsed.getUTCMinutes()).padStart(2, '0');
  const ss = String(parsed.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

function toBookingWarningList(rawWarnings) {
  if (!Array.isArray(rawWarnings)) return [];
  return rawWarnings.map(warning => ({
    code: String(warning?.code || '').trim() || null,
    message: String(warning?.message || '').trim() || null,
    staffId: String(warning?.staffId || '').trim() || null,
    serviceId: String(warning?.serviceId || '').trim() || null,
  }));
}

function hasBlockingBookingWarnings(warnings = []) {
  if (!Array.isArray(warnings) || warnings.length === 0) return false;
  const blockingCodes = new Set([
    'RESOURCE_DOUBLE_BOOKED',
    'STAFF_DOUBLE_BOOKED',
    'STAFF_DOES_NOT_PERFORM_SERVICE',
  ]);
  return warnings.some(warning => blockingCodes.has(String(warning?.code || '').trim().toUpperCase()));
}

async function runMutationRoot(apiUrl, headers, query, variables, root) {
  const data = await fetchBoulevardGraphQL(
    apiUrl,
    headers,
    query,
    variables,
    { silentErrors: true, returnErrors: true },
  );
  if (data?.__error) return { ok: false, error: data.__error, payload: null };
  const payload = data?.data?.[root] || null;
  if (!payload) return { ok: false, error: { stage: 'empty_payload' }, payload: null };
  return { ok: true, payload, error: null };
}

async function trySyncAppointmentNotes(apiUrl, headers, appointmentId, notes) {
  const targetAppointmentId = String(appointmentId || '').trim();
  const noteText = String(notes || '').trim();
  if (!targetAppointmentId) {
    return {
      applied: false,
      reason: 'notes_sync_missing_appointment_id',
      skipped: false,
    };
  }
  if (!noteText) {
    return {
      applied: true,
      reason: 'notes_sync_not_required',
      skipped: true,
    };
  }

  const mutationCandidates = [
    {
      root: 'updateAppointment',
      query: `
        mutation SyncAppointmentNotes($appointmentId: ID!, $notes: String!) {
          updateAppointment(input: { id: $appointmentId, notes: $notes }) {
            appointment {
              id
            }
          }
        }
      `,
    },
    {
      root: 'appointmentUpdate',
      query: `
        mutation SyncAppointmentNotesAlt($appointmentId: ID!, $notes: String!) {
          appointmentUpdate(input: { id: $appointmentId, notes: $notes }) {
            appointment {
              id
            }
          }
        }
      `,
    },
  ];

  let lastError = null;
  for (const candidate of mutationCandidates) {
    const data = await fetchBoulevardGraphQL(
      apiUrl,
      headers,
      candidate.query,
      { appointmentId: targetAppointmentId, notes: noteText },
      { silentErrors: true, returnErrors: true },
    );
    if (!data || data.__error) {
      lastError = data?.__error || { stage: 'notes_sync_failed' };
      continue;
    }
    const node = data?.data?.[candidate.root] || null;
    const updatedId = String(node?.appointment?.id || node?.id || '').trim();
    if (updatedId) {
      return {
        applied: true,
        reason: 'notes_sync_applied',
        skipped: false,
        mutationRoot: candidate.root,
      };
    }
  }

  return {
    applied: false,
    reason: 'notes_sync_failed',
    skipped: false,
    error: lastError,
  };
}

async function tryApplyUpgradeViaCancelRebook(apiUrl, headers, opportunity, serviceId) {
  const appointmentId = String(opportunity?.appointmentId || '').trim();
  const clientId = String(opportunity?.clientId || '').trim();
  const locationId = normalizeBoulevardLocationId(opportunity?.locationId || '');
  const providerId = String(opportunity?.providerId || '').trim();
  const startTime = toBoulevardNaiveDateTime(opportunity?.startOn);
  const sourceNotes = String(opportunity?.notes || '').trim();

  const missing = [];
  if (!appointmentId) missing.push('appointmentId');
  if (!clientId) missing.push('clientId');
  if (!locationId) missing.push('locationId');
  if (!providerId) missing.push('providerId');
  if (!startTime) missing.push('startTime');
  if (missing.length > 0) {
    return {
      applied: false,
      reason: 'cancel_rebook_missing_fields',
      missing,
    };
  }

  const cancelQuery = `
    mutation CancelAppointmentForUpgrade($input: CancelAppointmentInput!) {
      cancelAppointment(input: $input) {
        appointment {
          id
          cancelled
          state
        }
      }
    }
  `;
  const cancelAttempt = await runMutationRoot(
    apiUrl,
    headers,
    cancelQuery,
    {
      input: {
        id: appointmentId,
        reason: 'STAFF_CANCEL',
        notifyClient: false,
        notes: sourceNotes || 'Automated upgrade flow: cancel + rebook to longer duration.',
      },
    },
    'cancelAppointment',
  );
  const canceledAppointmentId = cancelAttempt.payload?.appointment?.id
    ? String(cancelAttempt.payload.appointment.id)
    : '';
  if (!cancelAttempt.ok || !canceledAppointmentId) {
    return {
      applied: false,
      reason: 'cancel_rebook_cancel_failed',
      error: cancelAttempt.error || null,
    };
  }

  const bookingCreateQuery = `
    mutation BookingCreateForUpgrade($input: BookingCreateInput!) {
      bookingCreate(input: $input) {
        booking {
          id
          bookingClients {
            id
            clientId
          }
        }
        bookingWarnings {
          code
          message
          staffId
          serviceId
        }
      }
    }
  `;
  const bookingCreateAttempt = await runMutationRoot(
    apiUrl,
    headers,
    bookingCreateQuery,
    {
      input: {
        clientId,
        locationId,
        startTime,
      },
    },
    'bookingCreate',
  );
  const bookingId = String(bookingCreateAttempt.payload?.booking?.id || '').trim();
  const createWarnings = toBookingWarningList(bookingCreateAttempt.payload?.bookingWarnings);
  if (!bookingCreateAttempt.ok || !bookingId) {
    return {
      applied: false,
      reason: 'cancel_rebook_booking_create_failed',
      error: bookingCreateAttempt.error || null,
      warnings: createWarnings,
    };
  }
  if (hasBlockingBookingWarnings(createWarnings)) {
    return {
      applied: false,
      reason: 'cancel_rebook_booking_create_warning_block',
      warnings: createWarnings,
    };
  }

  let bookingClientId = String(
    (bookingCreateAttempt.payload?.booking?.bookingClients || [])
      .find(client => String(client?.clientId || '') === clientId)?.id ||
    bookingCreateAttempt.payload?.booking?.bookingClients?.[0]?.id ||
    '',
  ).trim();
  if (!bookingClientId) {
    const bookingSetClientQuery = `
      mutation BookingSetClientForUpgrade($input: BookingSetClientInput!) {
        bookingSetClient(input: $input) {
          booking {
            id
            bookingClients {
              id
              clientId
            }
          }
          bookingWarnings {
            code
            message
            staffId
            serviceId
          }
        }
      }
    `;
    const bookingSetClientAttempt = await runMutationRoot(
      apiUrl,
      headers,
      bookingSetClientQuery,
      {
        input: {
          bookingId,
          clientId,
        },
      },
      'bookingSetClient',
    );
    const setClientWarnings = toBookingWarningList(bookingSetClientAttempt.payload?.bookingWarnings);
    if (!bookingSetClientAttempt.ok) {
      return {
        applied: false,
        reason: 'cancel_rebook_set_client_failed',
        error: bookingSetClientAttempt.error || null,
        warnings: setClientWarnings,
      };
    }
    if (hasBlockingBookingWarnings(setClientWarnings)) {
      return {
        applied: false,
        reason: 'cancel_rebook_set_client_warning_block',
        warnings: setClientWarnings,
      };
    }
    bookingClientId = String(
      (bookingSetClientAttempt.payload?.booking?.bookingClients || [])
        .find(client => String(client?.clientId || '') === clientId)?.id ||
      bookingSetClientAttempt.payload?.booking?.bookingClients?.[0]?.id ||
      '',
    ).trim();
  }

  if (!bookingClientId) {
    return {
      applied: false,
      reason: 'cancel_rebook_missing_booking_client',
      bookingId,
    };
  }

  const bookingAddServiceQuery = `
    mutation BookingAddServiceForUpgrade($input: BookingAddServiceInput!) {
      bookingAddService(input: $input) {
        booking {
          id
        }
        bookingService {
          id
          serviceId
          staffId
        }
        bookingWarnings {
          code
          message
          staffId
          serviceId
        }
      }
    }
  `;
  const bookingAddServiceAttempt = await runMutationRoot(
    apiUrl,
    headers,
    bookingAddServiceQuery,
    {
      input: {
        bookingId,
        bookingClientId,
        serviceId,
        staffId: providerId,
      },
    },
    'bookingAddService',
  );
  const addServiceWarnings = toBookingWarningList(bookingAddServiceAttempt.payload?.bookingWarnings);
  if (!bookingAddServiceAttempt.ok) {
    return {
      applied: false,
      reason: 'cancel_rebook_add_service_failed',
      error: bookingAddServiceAttempt.error || null,
      warnings: addServiceWarnings,
    };
  }
  if (hasBlockingBookingWarnings(addServiceWarnings)) {
    return {
      applied: false,
      reason: 'cancel_rebook_add_service_warning_block',
      warnings: addServiceWarnings,
    };
  }

  const bookingCompleteQuery = `
    mutation BookingCompleteForUpgrade($input: BookingCompleteInput!) {
      bookingComplete(input: $input) {
        booking {
          id
        }
        bookingAppointments {
          appointmentId
          clientId
        }
        bookingWarnings {
          code
          message
          staffId
          serviceId
        }
      }
    }
  `;
  const bookingCompleteAttempt = await runMutationRoot(
    apiUrl,
    headers,
    bookingCompleteQuery,
    {
      input: {
        bookingId,
        bookWithStaffId: providerId,
        notifyClient: false,
      },
    },
    'bookingComplete',
  );
  const completeWarnings = toBookingWarningList(bookingCompleteAttempt.payload?.bookingWarnings);
  if (!bookingCompleteAttempt.ok) {
    return {
      applied: false,
      reason: 'cancel_rebook_complete_failed',
      error: bookingCompleteAttempt.error || null,
      warnings: completeWarnings,
    };
  }
  if (hasBlockingBookingWarnings(completeWarnings)) {
    return {
      applied: false,
      reason: 'cancel_rebook_complete_warning_block',
      warnings: completeWarnings,
    };
  }

  const newAppointmentId = String(
    (bookingCompleteAttempt.payload?.bookingAppointments || [])
      .find(item => String(item?.clientId || '') === clientId)?.appointmentId ||
    bookingCompleteAttempt.payload?.bookingAppointments?.[0]?.appointmentId ||
    '',
  ).trim();
  if (!newAppointmentId) {
    return {
      applied: false,
      reason: 'cancel_rebook_missing_new_appointment',
      bookingId,
    };
  }

  const notesSync = await trySyncAppointmentNotes(apiUrl, headers, newAppointmentId, sourceNotes);

  return {
    applied: true,
    mutationRoot: 'cancelAppointment+bookingCreate+bookingAddService+bookingComplete',
    updatedId: newAppointmentId,
    canceledAppointmentId,
    bookingId,
    notesSync,
  };
}

async function reverifyAndApplyUpgradeForProfile(profile, pendingOffer, options = {}) {
  if (!pendingOffer || !pendingOffer.appointmentId) return { success: false, reason: 'missing_pending_offer' };

  const fresh = await evaluateUpgradeOpportunityForProfile(profile, {
    now: options.now,
    windowHours: options.windowHours,
    appointmentId: pendingOffer.appointmentId,
    targetDurationMinutes: pendingOffer.targetDurationMinutes,
  });
  if (!fresh?.eligible) {
    return {
      success: false,
      reason: fresh?.reason || 'reverify_failed',
      reverified: false,
      opportunity: fresh || null,
    };
  }

  if (!ENABLE_UPGRADE_MUTATION) {
    return {
      success: false,
      reason: 'upgrade_mutation_disabled',
      reverified: true,
      opportunity: fresh,
    };
  }

  const auth = getBoulevardAuthContext();
  if (!auth) {
    return {
      success: false,
      reason: 'boulevard_not_configured',
      reverified: true,
      opportunity: fresh,
    };
  }

  const targetDuration = Number(fresh.targetDurationMinutes);
  const serviceId =
    targetDuration === 50
      ? process.env.BOULEVARD_SERVICE_ID_50MIN
      : targetDuration === 90
      ? process.env.BOULEVARD_SERVICE_ID_90MIN
      : null;
  if (!serviceId) {
    return {
      success: false,
      reason: 'service_id_not_configured',
      reverified: true,
      opportunity: fresh,
    };
  }

  const applied = await tryApplyAppointmentUpgradeMutation(auth.apiUrl, auth.headers, fresh.appointmentId, serviceId);
  if (!applied.applied && ENABLE_CANCEL_REBOOK_FALLBACK) {
    const appointmentContext = await fetchAppointmentContextById(auth.apiUrl, auth.headers, fresh.appointmentId);
    const fallbackOpportunity = {
      ...fresh,
      clientId: fresh.clientId || appointmentContext?.clientId || null,
      locationId: fresh.locationId || appointmentContext?.locationId || null,
      providerId: fresh.providerId || appointmentContext?.providerId || null,
      startOn: fresh.startOn || appointmentContext?.startOn || null,
      endOn: fresh.endOn || appointmentContext?.endOn || null,
      notes: appointmentContext?.notes || null,
    };
    const cancelRebookApplied = await tryApplyUpgradeViaCancelRebook(
      auth.apiUrl,
      auth.headers,
      fallbackOpportunity,
      serviceId,
    );
    if (cancelRebookApplied.applied) {
      const notesSyncFailed = Boolean(
        cancelRebookApplied?.notesSync &&
        cancelRebookApplied.notesSync.skipped !== true &&
        cancelRebookApplied.notesSync.applied !== true,
      );
      return {
        success: true,
        reason: notesSyncFailed ? 'applied_cancel_rebook_notes_sync_failed' : 'applied_cancel_rebook',
        reverified: true,
        opportunity: fresh,
        mutationRoot: cancelRebookApplied.mutationRoot,
        updatedAppointmentId: cancelRebookApplied.updatedId,
        canceledAppointmentId: cancelRebookApplied.canceledAppointmentId || fresh.appointmentId || null,
        bookingId: cancelRebookApplied.bookingId || null,
        notesSync: cancelRebookApplied.notesSync || null,
      };
    }
    return {
      success: false,
      reason: cancelRebookApplied.reason || applied.reason || 'upgrade_mutation_failed',
      reverified: true,
      opportunity: fresh,
    };
  }
  if (!applied.applied) {
    return {
      success: false,
      reason: applied.reason || 'upgrade_mutation_failed',
      reverified: true,
      opportunity: fresh,
    };
  }

  return {
    success: true,
    reason: 'applied',
    reverified: true,
    opportunity: fresh,
    mutationRoot: applied.mutationRoot,
    updatedAppointmentId: applied.updatedId,
  };
}

async function lookupMember(name, emailOrPhone, options = {}) {
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
    const normalizedEmail = isEmail ? rawContact.toLowerCase() : '';

    const authCredentials = generateAuthHeader(apiKey, apiSecret, businessId);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${authCredentials}`,
      'X-Boulevard-Business-ID': businessId,
    };

    let clients = [];
    let lookupStrategy = isEmail ? 'email_exact' : 'phone_scan';
    const preferredLocationCanonicalId = canonicalizeBoulevardLocationId(options.preferLocationId || '') || null;
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
                primaryLocation { id name }
              }
            }
          }
        }
      `;
      console.log(`Boulevard lookup: email = ${normalizedEmail} at ${apiUrl}`);
      const data = await fetchBoulevardGraphQL(apiUrl, headers, query, { emails: [normalizedEmail] });
      if (!data) return null;
      clients = data?.data?.clients?.edges || [];
      if (clients.length === 0) {
        const nameScanMatches = await findClientsByNameScan(apiUrl, headers, name);
        if (!nameScanMatches) return null;
        const fallback = resolveNameScanFallbackCandidate(name, normalizedEmail, nameScanMatches);
        if (fallback?.candidate) {
          clients = [fallback.candidate];
          lookupStrategy = fallback.strategy;
        } else if (fallback?.reason?.startsWith('ambiguous')) {
          console.log(`Boulevard lookup: ${fallback.reason} fallback matches for "${name}"`);
        }
      }
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

    let match = findNameMatch(name, clients, options);
    let usedNameScanLocationFallback = false;
    const toNode = (candidate) => candidate?.node || candidate || null;
    if (
      isEmail &&
      preferredLocationCanonicalId &&
      match?.node?.primaryLocation?.id &&
      canonicalizeBoulevardLocationId(match.node.primaryLocation.id) !== preferredLocationCanonicalId
    ) {
      const nameScanMatches = await findClientsByNameScan(apiUrl, headers, name);
      if (Array.isArray(nameScanMatches) && nameScanMatches.length > 0) {
        const fallback = resolveNameScanFallbackCandidate(name, normalizedEmail, nameScanMatches);
        const fallbackNode = toNode(fallback?.candidate);
        const fallbackLocationCanonicalId = canonicalizeBoulevardLocationId(fallbackNode?.primaryLocation?.id || '') || null;
        const fallbackMailboxMatch = emailsLikelyReferToSameMailbox(normalizedEmail, fallbackNode?.email || '');
        if (
          fallbackNode?.id &&
          fallbackMailboxMatch &&
          fallbackLocationCanonicalId &&
          fallbackLocationCanonicalId === preferredLocationCanonicalId &&
          fallbackNode.id !== match.node.id
        ) {
          match = { node: fallbackNode };
          lookupStrategy = fallback?.strategy || 'name_scan_location_preferred';
          usedNameScanLocationFallback = true;
        }
      }
    }
    if (!match && isEmail) {
      const nameScanMatches = await findClientsByNameScan(apiUrl, headers, name);
      if (Array.isArray(nameScanMatches) && nameScanMatches.length > 0) {
        const fallback = resolveNameScanFallbackCandidate(name, normalizedEmail, nameScanMatches);
        const fallbackNode = toNode(fallback?.candidate);
        const fallbackMailboxMatch = emailsLikelyReferToSameMailbox(normalizedEmail, fallbackNode?.email || '');
        if (fallbackNode && fallbackMailboxMatch) {
          match = { node: fallbackNode };
          lookupStrategy = fallback?.strategy || 'name_scan_mailbox';
          usedNameScanLocationFallback = true;
        }
      }
    }
    if (!match) { console.log(`Boulevard lookup: ${clients.length} clients found but none match "${name}"`); return null; }
    if (usedNameScanLocationFallback) lookupStrategy = 'name_scan_location_preferred';
    console.log(`Boulevard lookup: matched ${match.node.firstName} ${match.node.lastName} via ${lookupStrategy}`);
    const membership = await findMembershipForClient(apiUrl, headers, match.node.id);
    const commerce = await fetchClientCommerceMetrics(apiUrl, headers, match.node);
    const preferMembershipLocation = membership && !isInactiveMembershipStatus(membership.status);
    const resolvedLocationName = preferMembershipLocation
      ? (membership?.location?.name || match.node?.primaryLocation?.name || match.node.location)
      : (match.node?.primaryLocation?.name || membership?.location?.name || match.node.location);
    const resolvedLocationId = preferMembershipLocation
      ? (membership?.location?.id || match.node?.primaryLocation?.id || null)
      : (match.node?.primaryLocation?.id || membership?.location?.id || null);

    const source = membership ? {
      ...match.node,
      ...(commerce || {}),
      membershipName: membership.name,
      membershipStartDate: membership.startOn,
      membershipStatus: membership.status,
      membershipTermNumber: membership.termNumber,
      nextChargeDate: membership.nextChargeDate,
      unitPrice: membership.unitPrice,
      location: resolvedLocationName,
      locationId: resolvedLocationId,
      lookupStrategy,
    } : {
      ...match.node,
      ...(commerce || {}),
      lookupStrategy,
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
    clientId: d.id || null,
    name: `${d.firstName} ${d.lastName}`, firstName: d.firstName, email: d.email,
    phone: d.mobilePhone || null, location: d.location || d.primaryLocation?.name || 'Unknown',
    locationId: normalizeBoulevardLocationId(d.locationId || d.primaryLocation?.id || '') || null,
    locationCanonicalId: canonicalizeBoulevardLocationId(d.locationId || d.primaryLocation?.id || '') || null,
    lookupStrategy: d.lookupStrategy || null,
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
  const detailedEstimateTotal = sumPositive([serviceDiscountSavings, retailDiscountSavings, addonDiscountSavings]);
  const simpleSpendBasis = sumPositive([p.totalDuesPaid, p.totalRetailPurchases, p.totalAddonPurchases]);
  const simpleTwentyPctSavingsEstimate = simpleSpendBasis !== null ? roundCurrency(simpleSpendBasis * 0.2) : null;
  const memberDiscountSavingsTotal = explicitDiscountTotal !== null
    ? explicitDiscountTotal
    : (detailedEstimateTotal !== null ? detailedEstimateTotal : simpleTwentyPctSavingsEstimate);

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
    simpleTwentyPctSavingsEstimate: simpleTwentyPctSavingsEstimate !== null && simpleTwentyPctSavingsEstimate > 0 ? simpleTwentyPctSavingsEstimate : null,
    discountSavingsConfidence: explicitDiscountTotal !== null
      ? 'high'
      : (detailedEstimateTotal !== null ? 'estimated' : (simpleTwentyPctSavingsEstimate !== null ? 'estimated_simple_20pct' : 'unknown')),
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
    `Member Discount Savings: ${isFiniteNumber(c.memberDiscountSavingsTotal) ? `$${c.memberDiscountSavingsTotal}${c.discountSavingsConfidence === 'estimated_simple_20pct' ? ' (estimated as 20% of known spend)' : (c.discountSavingsConfidence === 'estimated' ? ' (estimated from known purchase totals)' : '')}` : 'UNKNOWN — do not mention total discount savings'}`,
    `Service Discount Savings: ${isFiniteNumber(c.serviceDiscountSavings) ? `$${c.serviceDiscountSavings}` : 'UNKNOWN'}`,
    `Retail Discount Savings: ${isFiniteNumber(c.retailDiscountSavings) ? `$${c.retailDiscountSavings}` : 'UNKNOWN'}`,
    `Add-on Discount Savings: ${isFiniteNumber(c.addonDiscountSavings) ? `$${c.addonDiscountSavings}` : 'UNKNOWN'}`,
    `Simple 20% Savings Estimate: ${isFiniteNumber(c.simpleTwentyPctSavingsEstimate) ? `$${c.simpleTwentyPctSavingsEstimate}` : 'UNKNOWN'}`,
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
    id: 'mock-client-id',
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

function __resetBoulevardCachesForTests() {
  membershipCache.clear();
  clientFieldCache.clear();
  typeFieldCache.clear();
  typeFieldDetailCache.clear();
}

export {
  lookupMember,
  evaluateUpgradeOpportunityForProfile,
  evaluateUpgradeEligibilityFromAppointments,
  probeCancelRebookCapabilities,
  resolveNameScanFallbackCandidate,
  reverifyAndApplyUpgradeForProfile,
  verifyMemberIdentity,
  levenshtein,
  buildProfile,
  computeValues,
  formatProfileForPrompt,
  normalizePhone,
  normalizeBoulevardLocationId,
  canonicalizeBoulevardLocationId,
  resolveBoulevardLocationInput,
  OFFICIAL_LOCATION_REGISTRY,
  WALKIN_PRICES,
  CURRENT_RATES,
  PERKS,
  LOYALTY_TIERS,
  __resetBoulevardCachesForTests,
};

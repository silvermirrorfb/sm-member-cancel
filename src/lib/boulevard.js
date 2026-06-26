import crypto from 'crypto';
import { incrementUpgradeApplyFailureCount } from './sms-metrics.js';

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
const SERVICE_SCAN_PAGE_SIZE = Number(process.env.BOULEVARD_SERVICE_SCAN_PAGE_SIZE || 100);
const SERVICE_SCAN_MAX_PAGES = Number(process.env.BOULEVARD_SERVICE_SCAN_MAX_PAGES || 80);
const UPGRADE_WINDOW_HOURS = Number(process.env.BOULEVARD_UPGRADE_WINDOW_HOURS || 6);
const PREP_BUFFER_30MIN = Number(process.env.PREP_BUFFER_30MIN || 15);
const PREP_BUFFER_50MIN = Number(process.env.PREP_BUFFER_50MIN || 10);
const PREP_BUFFER_90MIN = Number(process.env.PREP_BUFFER_90MIN || 10);
const SMS_ADDON_MIN_GAP_MINUTES = Number(process.env.SMS_ADDON_MIN_GAP_MINUTES || 5);
const ENABLE_UPGRADE_MUTATION = process.env.BOULEVARD_ENABLE_UPGRADE_MUTATION === 'true';
// Separate, default-OFF gate for the non-destructive booking-edit duration apply
// (outbound-sms #13). It stays OFF until the real-appointment dry-run proves the
// swap edits the booking in place (same appointment id) without a cancel-rebook.
// While OFF, a duration YES falls through to the legacy path (which fails closed
// to the approved manual-confirm reply), i.e. today's behavior is unchanged.
const ENABLE_BOOKING_UPGRADE = process.env.BOULEVARD_ENABLE_BOOKING_UPGRADE === 'true';
// Production SMS must never cancel an existing booking as an automatic fallback.
const ENABLE_CANCEL_REBOOK_FALLBACK =
  process.env.NODE_ENV !== 'production' &&
  process.env.BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK === 'true';
const UUID_V4_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDON_SERVICE_ID_ENV_BY_CODE = Object.freeze({
  antioxidant_peel: 'BOULEVARD_ADDON_SERVICE_ID_ANTIOXIDANT_PEEL',
  neck_firming: 'BOULEVARD_ADDON_SERVICE_ID_NECK_FIRMING',
  eye_puff_minimizer: 'BOULEVARD_ADDON_SERVICE_ID_EYE_PUFF_MINIMIZER',
  lip_plump_and_scrub: 'BOULEVARD_ADDON_SERVICE_ID_LIP_PLUMP_AND_SCRUB',
});
const ADDON_DISPLAY_NAME_BY_CODE = Object.freeze({
  antioxidant_peel: 'Antioxidant Peel',
  neck_firming: 'Neck Firming',
  eye_puff_minimizer: 'Eye Puff Minimizer',
  lip_plump_and_scrub: 'Lip Plump and Scrub',
});
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
const serviceContextCache = new Map();
const serviceLookupCache = new Map();

function normalizeLocationNameKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeServiceNameKey(value) {
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
  { month: 60, name: 'Year 5 Anniversary — 90-Min Upgrade or Hydradermabrasion', value: 279, type: 'service_upgrade' },
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

// Explicit base-letter folds for Latin-extension characters that don't
// decompose via NFD (these are atomic letters, not precomposed accents).
// Without this, names like "Łukasz" lose the Ł entirely.
const LATIN_EXTENSION_FOLDS = {
  'Ł': 'L', 'ł': 'l',
  'Ø': 'O', 'ø': 'o',
  'Æ': 'AE', 'æ': 'ae',
  'Œ': 'OE', 'œ': 'oe',
  'ß': 'ss',
  'Þ': 'Th', 'þ': 'th',
  'Ð': 'D', 'ð': 'd',
};

function normalizeNameText(text) {
  if (!text) return '';
  // 1) NFD decomposes precomposed accented characters into base + combining
  //    mark: "José" -> "Jose", "Müller" -> "Muller", "François" -> "Francois".
  // 2) Strip the combining-mark range.
  // 3) Apply explicit folds for atomic Latin-extension letters that NFD does
  //    NOT decompose (Polish Ł, Norwegian Ø, German ß, etc.).
  // 4) Lowercase, strip non-letter punctuation, collapse whitespace.
  let s = String(text).normalize('NFD').replace(/[̀-ͯ]/g, '');
  let folded = '';
  for (const ch of s) folded += (LATIN_EXTENSION_FOLDS[ch] || ch);
  return folded
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

// 2026-05-28 Bug 3 hardening:
// - Reject single-token requests (a first-name-only search must NOT match;
//   wrong-member match is worst-case, so we route those to safer paths).
// - Tighten the fuzzy fallback: was lev<=3 on the whole-name string, which
//   matched "Sam Smith" vs "Pat Smith" (lev=3) and "Maureen Golga" vs
//   "Maureen Gomez" (lev=2). Now require first-name exact AND last-name lev<=2,
//   OR last-name exact AND first-name lev<=2.
// - Handle hyphenated last names symmetrically: "Hamrick-Down" should match
//   "Hamrick Down" and "Hamrick" (the informal short-form).
function hyphenSplit(token) {
  return String(token || '').split('-').filter(Boolean);
}

function namesLikelyMatch(requestedName, candidateFirstName, candidateLastName) {
  const reqTokens = tokenizeName(requestedName);
  const candFull = `${candidateFirstName || ''} ${candidateLastName || ''}`.trim();
  const candTokens = tokenizeName(candFull);
  // Safety: a first-name-only search is too ambiguous to auto-match. The
  // caller should fall back to phone/email or a disambiguation prompt.
  if (reqTokens.length < 2 || candTokens.length === 0) return false;

  const reqFirst = reqTokens[0];
  const reqLast = reqTokens[reqTokens.length - 1];
  const candFirst = candTokens[0];
  const candLast = candTokens[candTokens.length - 1];

  // Strong signal: first + last token align.
  if (reqFirst === candFirst && reqLast === candLast) return true;

  // Allow middle-name variants: search "Sophia Dowd" vs candidate "Sophia
  // Isabel Dowd".
  if (reqFirst === candFirst && candTokens.includes(reqLast)) return true;
  if (candFirst === reqFirst && reqTokens.includes(candLast)) return true;

  // Hyphenated last names. Only match when:
  //   a) Both sides hyphenated and any part overlaps (hyphen-on-hyphen drift)
  //   b) Both sides effectively have the same multi-part last name, just one
  //      side uses hyphen and the other uses space ("Hamrick-Down" vs
  //      "Hamrick Down"): require all parts overlap.
  //   c) Bare-side last name equals the FIRST PART of the hyphenated side
  //      (the informal short-form convention: "Hamrick-Down" -> "Hamrick").
  //      Codex flagged that the previous "any-part overlap" rule matched
  //      "Smith" against "O'Brien-Smith", which is a different surname.
  //      First-part-only is the safer cultural convention.
  if (reqFirst === candFirst) {
    const reqLastParts = hyphenSplit(reqLast);
    const candLastParts = hyphenSplit(candLast);
    const reqLastTokens = reqTokens.slice(1);
    const candLastTokens = candTokens.slice(1);
    if (reqLastParts.length > 1 && candLastParts.length > 1) {
      // Codex P1 fix (2026-05-28): hyphenated-vs-hyphenated requires ALL parts
      // to match as sets (order-independent). The prior `some(...)` rule false-
      // positive-matched "John Smith-Jones" to "John Smith-Brown" because they
      // share "Smith". For distinct members with the same first name and one
      // shared surname component, picking the wrong client is the worst
      // possible outcome of this matcher (the route would then process a
      // different member's account). Strict same-set matching is safer.
      const reqSet = new Set(reqLastParts);
      const candSet = new Set(candLastParts);
      if (reqSet.size === candSet.size && [...reqSet].every(p => candSet.has(p))) {
        return true;
      }
    }
    if (reqLastParts.length > 1 && candLastTokens.length >= 2) {
      const reqSet = new Set(reqLastParts);
      if (candLastTokens.every(t => reqSet.has(t))) return true;
    }
    if (candLastParts.length > 1 && reqLastTokens.length >= 2) {
      const candSet = new Set(candLastParts);
      if (reqLastTokens.every(t => candSet.has(t))) return true;
    }
    // Bare-side match against the FIRST part of the hyphenated side.
    if (reqLastParts.length > 1 && candLast === reqLastParts[0]) return true;
    if (candLastParts.length > 1 && reqLast === candLastParts[0]) return true;
  }

  // Strict fuzzy. Both rules now length-aware (per codex P1):
  //   1) Same FIRST exact + close LAST. lev<=1 always; lev=2 only when the
  //      longer last name is >=5 chars. Catches "Maureen Golga"/"Maureen
  //      Golgs" (lev=1) and "Catherine Hamrik"/"Catherine Hamrick" (lev=1,
  //      len 7), while rejecting "Amy Li"/"Amy Wu" (lev=2, len 2).
  //   2) Same LAST exact + close FIRST, with the same length-aware threshold.
  //      Lets "Sofia"/"Sophia" (lev=2, len 5/6) match while rejecting
  //      "Sam"/"Pat" (lev=2, len 3/3).
  if (reqFirst === candFirst) {
    const lastLev = levenshtein(reqLast, candLast);
    if (lastLev <= 1) return true;
    if (lastLev <= 2 && Math.max(reqLast.length, candLast.length) >= 5) return true;
  }
  if (reqLast === candLast) {
    const firstLev = levenshtein(reqFirst, candFirst);
    if (firstLev <= 1) return true;
    if (firstLev <= 2 && Math.max(reqFirst.length, candFirst.length) >= 5) return true;
  }

  return false;
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

// Transient-failure classification for retry. Boulevard rate-limits bursts
// (HTTP 429) and occasionally returns 5xx under load; both clear within a few
// hundred ms. Network throws (ECONNRESET, ETIMEDOUT, socket hang up) on the
// shared HTTPS pool also resolve on retry. Deterministic errors (auth, GraphQL
// validation, AbortError from local timeout) get no retry because they cannot.
//
// Diagnosed in the 2026-05-28 Bug 4 investigation: a single 429 during a
// scanAppointments burst was enough to cascade every strategy and every root
// into appointments_query_failed (~14 percent of production scans).
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isTransientFetchError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  // node-fetch / undici surface network errors as TypeError with .cause,
  // ECONNRESET / ETIMEDOUT etc. on err.code, or a 'fetch failed' message.
  if (err.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNREFUSED'].includes(err.code)) return true;
  if (err.cause && err.cause.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNREFUSED'].includes(err.cause.code)) return true;
  if (typeof err.message === 'string' && /socket hang up|fetch failed|network|reset/i.test(err.message)) return true;
  return false;
}

// Hard caps applied to env knobs so a misconfigured value (e.g.
// BOULEVARD_FETCH_MAX_RETRIES=Infinity) cannot turn the retry loop into a
// runaway. maxRetries clamps to [0, 5]; baseMs clamps to [0, 5000].
const FETCH_RETRY_MAX_RETRIES_CAP = 5;
const FETCH_RETRY_BASE_MS_CAP = 5000;

function getFetchRetryConfig() {
  const rawRetries = Number(process.env.BOULEVARD_FETCH_MAX_RETRIES ?? 2);
  const rawBase = Number(process.env.BOULEVARD_FETCH_RETRY_BASE_MS ?? 250);
  const maxRetries = Number.isFinite(rawRetries)
    ? Math.max(0, Math.min(FETCH_RETRY_MAX_RETRIES_CAP, Math.floor(rawRetries)))
    : 2;
  const baseMs = Number.isFinite(rawBase)
    ? Math.max(0, Math.min(FETCH_RETRY_BASE_MS_CAP, rawBase))
    : 250;
  return { maxRetries, baseMs };
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded jitter so N parallel scans that all hit a single 429 don't all
// retry at exactly the same instant (which would recreate the burst we just
// got rate-limited for). Range: 0..baseMs additive on top of the exponential.
function jitterMs(baseMs) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  return Math.floor(Math.random() * baseMs);
}

async function fetchBoulevardGraphQL(apiUrl, headers, query, variables, options = {}) {
  // Retries are OPT-IN. Mutations (cancelAppointment, bookingCreate, addOn
  // upsert and friends routed through runMutationRoot at boulevard.js ~2633)
  // MUST NOT enable retryTransient because Boulevard's response is not
  // guaranteed reliable: a transient failure mid-mutation could mean
  // "applied but response dropped" and a retry would duplicate the booking
  // or cancel something already canceled. Only callers whose operation is
  // naturally idempotent (read-only scans, introspection probes the caller
  // cross-checks) should opt in. scanAppointments and the introspection
  // helpers opt in; runMutationRoot deliberately does not.
  const retryEnabled = options.retryTransient === true;
  const cfg = getFetchRetryConfig();
  const maxRetries = retryEnabled ? cfg.maxRetries : 0;
  const baseMs = cfg.baseMs;

  // attempt 0 is the initial call; attempts 1..maxRetries are retries.
  let lastTransientError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: base * 2^(attempt-1) plus 0..base jitter.
      // attempt=1 -> base*1 + jitter, attempt=2 -> base*2 + jitter.
      // Keeps the worst-case latency bounded.
      await sleepMs(baseMs * Math.pow(2, attempt - 1) + jitterMs(baseMs));
    }

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
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') console.error(`Boulevard API timed out after ${BOULEVARD_TIMEOUT_MS}ms`);
      else console.error('Boulevard API fetch error:', buildFetchErrorDiagnostics(fetchErr, apiUrl));
      if (isTransientFetchError(fetchErr) && attempt < maxRetries) {
        lastTransientError = fetchErr;
        continue;
      }
      if (options.returnErrors) {
        return {
          __error: {
            stage: 'fetch',
            diagnostics: buildFetchErrorDiagnostics(fetchErr, apiUrl),
          },
        };
      }
      return null;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const t = await response.text().catch(() => '');
      console.error(`Boulevard API HTTP ${response.status}: ${t.substring(0,500)}`);
      if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt < maxRetries) {
        lastTransientError = { status: response.status };
        continue;
      }
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
      // Non-JSON 200 is usually a transient gateway issue (HTML error page
      // from a reverse proxy under load). Retry the same way as 5xx.
      if (attempt < maxRetries) {
        lastTransientError = { stage: 'non_json', message: e.message };
        continue;
      }
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
      // GraphQL errors are NOT retried by default. They are deterministic
      // (validation, missing field, type mismatch) and would just repeat.
      // The one defensible exception is Boulevard returning a rate-limit
      // signal in errors[] with HTTP 200, but the codes vary and false
      // positives would mask real bugs. Leave deterministic and revisit
      // once Boulevard's rate-limit-as-graphql shape is observed.
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

  // Exhausted retries on a transient error. Surface it in the standard shape.
  if (options.returnErrors) {
    if (lastTransientError?.status) {
      return {
        __error: {
          stage: 'http',
          status: lastTransientError.status,
          bodyPreview: `transient retry exhausted (max ${maxRetries})`,
        },
      };
    }
    return {
      __error: {
        stage: 'fetch',
        diagnostics: buildFetchErrorDiagnostics(lastTransientError || new Error('retry exhausted'), apiUrl),
      },
    };
  }
  return null;
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

function maskEmailForLogs(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '<empty>';
  const atIndex = raw.indexOf('@');
  if (atIndex <= 0 || atIndex === raw.length - 1) return '<invalid-email>';
  const local = raw.slice(0, atIndex);
  const domain = raw.slice(atIndex + 1);
  return `${local.charAt(0)}***@${domain}`;
}

function maskPhoneForLogs(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '<empty>';
  return `***${digits.slice(-4)}`;
}

function maskNameForLogs(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '<empty>';
  return parts.map(part => `${part.charAt(0)}***`).join(' ');
}

function describeLookupContactForLogs(value) {
  const raw = String(value || '').trim();
  if (!raw) return '<empty>';
  return raw.includes('@') ? maskEmailForLogs(raw) : maskPhoneForLogs(raw);
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

      if (
        (nextProviderContext || /(provider|staff|employee|resource)/i.test(keyLower)) &&
        /(providerid|staffid|employeeid|serviceproviderid|resourceid)$/.test(keyLower) &&
        (typeof child === 'string' || typeof child === 'number')
      ) {
        const raw = String(child).trim();
        if (raw) return raw;
      }

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
  // Boulevard's Appointment type exposes a `cancelled` boolean but has no
  // canceledAt/cancelledAt field, so the timestamp branch below is permanently
  // dead on the live schema and cancellation detection rode entirely on the
  // state string. Honor the boolean first so detection no longer depends on the
  // state enum staying in the list.
  if (appt?.cancelled === true) return true;
  if (appt?.canceledAt) return true;
  const status = String(appt?.status || '').toUpperCase();
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
  if (argName === 'query') return context?.query ? String(context.query).trim() || null : null;
  return null;
}

// Boulevard's QueryString grammar is SQL-like with single-quoted string literals
// (e.g. `startAt >= '2026-04-27' AND startAt < '2026-04-29'`). Without this filter,
// the appointments query paginates oldest-first and the MAX_PAGES cap (8000 rows)
// is reached long before today's appointments — so callers wanting upcoming
// appointments must narrow the result set at the API.
function buildAppointmentWindowQuery(context = {}) {
  const toDateString = (raw) => {
    if (raw === null || raw === undefined || raw === '') return null;
    const d = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  };
  const start = toDateString(context?.windowStart);
  const end = toDateString(context?.windowEnd);
  if (!start && !end) return null;
  const clauses = [];
  if (start) clauses.push(`startAt >= '${start}'`);
  if (end) clauses.push(`startAt < '${end}'`);
  return clauses.join(' AND ');
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
  const windowQueryString = buildAppointmentWindowQuery(context);
  const diagnostics = {
    typeIntrospection: null,
    queryIntrospection: null,
    queryTypeName: null,
    locationId: locationIdForScan,
    locationCanonicalId: locationCanonicalIdForScan,
    clientId: clientIdForScan,
    windowQuery: windowQueryString,
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
  const cancelledBooleanField = pickFirstAvailableField(fieldSet, ['cancelled', 'canceled']);
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
  // Select BOTH the scalar clientId AND the nested client object when both exist on
  // Boulevard's Appointment type. Selecting only the scalar leaves clientFirstName/
  // Email/Phone null on every returned appointment, which makes the discovery code
  // path (locations[] mode in pre-appointment) drop every candidate at the
  // "missing firstName/email/phone" filter and silently produce zero outbound texts.
  if (clientIdField) selectedFields.push(clientIdField);
  if (clientObjectField) {
    // Boulevard's Client type exposes mobilePhone (not phone or phoneNumber).
    selectedFields.push(`${clientObjectField} { id firstName lastName email mobilePhone }`);
  }
  if (providerIdField) selectedFields.push(providerIdField);
  else if (providerObjectField) selectedFields.push(`${providerObjectField} { id }`);
  else {
    for (const plan of providerNestedPlans) selectedFields.push(plan.selection);
  }
  if (locationIdField) selectedFields.push(locationIdField);
  else if (locationObjectField) selectedFields.push(`${locationObjectField} { id }`);
  if (statusField) selectedFields.push(statusField);
  if (canceledAtField) selectedFields.push(canceledAtField);
  if (cancelledBooleanField) selectedFields.push(cancelledBooleanField);

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
      query: windowQueryString,
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
        // Opt in to transient-failure retry. scanAppointments is read-only
        // and idempotent; the Bug 4 (2026-05-28) fix scoped retry here so
        // Boulevard burst-limit 429s and transient 5xx no longer cascade
        // every strategy into appointments_query_failed. Mutations are
        // explicitly NOT given this option (see fetchBoulevardGraphQL).
        const data = await fetchBoulevardGraphQL(
          apiUrl,
          headers,
          query,
          variables,
          { silentErrors: true, returnErrors: true, retryTransient: true },
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
          const clientNode = clientObjectField ? node?.[clientObjectField] || null : null;
          const normalized = {
            id: String(node.id || ''),
            startOn: node[startField] || null,
            endOn: node[endField] || null,
            clientId: readNodeFieldAsString(node, clientIdField, clientObjectField),
            clientFirstName: String(clientNode?.firstName || '').trim() || null,
            clientLastName: String(clientNode?.lastName || '').trim() || null,
            clientEmail: String(clientNode?.email || '').trim().toLowerCase() || null,
            clientPhone:
              String(clientNode?.phoneNumber || '').trim() ||
              String(clientNode?.mobilePhone || '').trim() ||
              String(clientNode?.phone || '').trim() ||
              null,
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
            cancelled:
              cancelledBooleanField &&
              node[cancelledBooleanField] !== undefined &&
              node[cancelledBooleanField] !== null
                ? Boolean(node[cancelledBooleanField])
                : null,
          };
          if (!normalized.id || !normalized.startOn || !normalized.endOn || !normalized.clientId) continue;
          // Drop cancelled rows at the scan source so no consumer (cron discovery,
          // pre-appointment discovery, eligibility, reverify) can turn a cancelled
          // appointment into an outbound-SMS candidate.
          if (isCanceledAppointment(normalized)) continue;
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
  const providerIdentityMode = hasProviderIdentity ? 'exact_provider' : 'fallback_no_provider_id';
  const providerCommitmentsForMetadata = hasProviderIdentity
    ? appointments
      .filter(appt => appt.id !== current.id)
      .filter(appt => !isCanceledAppointment(appt))
      .filter(appt => {
        const startMs = new Date(appt.startOn).getTime();
        return Number.isFinite(startMs) && startMs > new Date(current.startOn).getTime();
      })
      .filter(appt => appt.providerId === current.providerId)
      .sort((a, b) => new Date(a.startOn).getTime() - new Date(b.startOn).getTime())
    : [];
  const nextCommitmentForMetadata = hasProviderIdentity ? (providerCommitmentsForMetadata[0] || null) : null;
  const nextStartMsForMetadata = nextCommitmentForMetadata ? new Date(nextCommitmentForMetadata.startOn).getTime() : null;
  const hasFiniteGapForMetadata = hasProviderIdentity ? Number.isFinite(nextStartMsForMetadata) : null;
  const availableGapMinutesForMetadata = hasProviderIdentity
    ? (hasFiniteGapForMetadata ? Math.floor((nextStartMsForMetadata - currentEndMs) / 60000) : Number.POSITIVE_INFINITY)
    : null;

  const targetDurationMinutes = isFiniteNumber(options.targetDurationMinutes)
    ? options.targetDurationMinutes
    : pickUpgradeTargetDuration(currentDurationMinutes);
  const isMember = (profile?.hasMembership === true || Boolean(profile?.tier)) && !/inactive|cancel/.test(String(profile?.accountStatus || '').toLowerCase());
  if (!isFiniteNumber(targetDurationMinutes)) {
    return {
      eligible: false,
      reason: 'no_upgrade_target_for_duration',
      appointmentId: current.id,
      clientId: current.clientId,
      providerId: current.providerId || null,
      providerIdentityMode,
      locationId: current.locationId || null,
      locationCanonicalId: currentLocationCanonicalId,
      startOn: current.startOn,
      endOn: current.endOn,
      nextCommitmentStartOn: nextCommitmentForMetadata?.startOn || null,
      currentDurationMinutes,
      targetDurationMinutes: null,
      requiredExtraMinutes: null,
      requiredGapMinutes: null,
      prepBufferMinutes: 0,
      availableGapMinutes: Number.isFinite(availableGapMinutesForMetadata) ? availableGapMinutesForMetadata : null,
      gapUnlimited: hasFiniteGapForMetadata === null ? null : !hasFiniteGapForMetadata,
      hasAddonOnBooking,
      isMember,
      pricing: null,
    };
  }
  if (Number(targetDurationMinutes) !== 50) {
    return { eligible: false, reason: 'unsupported_upgrade_target' };
  }
  // Already-at-or-above-target exclusion. Gate on the GREATER of the booked-block
  // bucket and the member's membership tier so a 50 or 90 minute member whose
  // current booking block happens to bucket to 30 (tier and booked-block
  // disagree, e.g. a 50-minute member booked into a short or non-ladder service)
  // is never selected as a 30-to-50 candidate. profileTierDuration is derived
  // above from profile.tier. Only apply the tier signal when the membership is
  // genuinely active: buildProfile sets profile.tier from the membership name
  // even for dead memberships (inactive, canceled, expired, terminated, past
  // due), so without the status gate a former 50 or 90 minute member who books a
  // genuine 30-minute service would be wrongly excluded from the non-member
  // 30-to-50 offer. isInactiveMembershipStatus is the canonical dead-status check
  // used elsewhere in this file. When tier is unresolved (null) or the membership
  // is dead, this falls back to the block bucket alone, preserving prior behavior.
  const tierSignalIsCurrent =
    isFiniteNumber(profileTierDuration) && !isInactiveMembershipStatus(profile?.accountStatus);
  const effectiveCurrentDuration = tierSignalIsCurrent
    ? Math.max(currentDurationMinutes, profileTierDuration)
    : currentDurationMinutes;
  if (effectiveCurrentDuration >= targetDurationMinutes) {
    return { eligible: false, reason: 'already_at_or_above_target_duration' };
  }

  // 30->50 requires the REAL added service minutes (target minus current), not a
  // flat 15. A 45-minute room (30 booked + 15 free) does NOT fit a 50-minute
  // service, which needs 20 more minutes. Computed, never hardcoded.
  const requiredExtraMinutes = Math.max(0, targetDurationMinutes - currentDurationMinutes);
  const prepBufferMinutes = 0;
  const pricing = computeUpgradePricing(currentDurationMinutes, targetDurationMinutes, isMember);
  if (!pricing) return { eligible: false, reason: 'pricing_unavailable' };
  if (!hasProviderIdentity) {
    return {
      eligible: false,
      reason: 'provider_identity_unavailable',
      appointmentId: current.id,
      clientId: current.clientId,
      providerId: null,
      providerIdentityMode,
      locationId: current.locationId || null,
      locationCanonicalId: currentLocationCanonicalId,
      startOn: current.startOn,
      endOn: current.endOn,
      nextCommitmentStartOn: null,
      currentDurationMinutes,
      targetDurationMinutes,
      requiredExtraMinutes,
      requiredGapMinutes: requiredExtraMinutes,
      prepBufferMinutes,
      availableGapMinutes: null,
      gapUnlimited: null,
      hasAddonOnBooking,
      isMember,
      pricing,
    };
  }

  const providerCommitments = providerCommitmentsForMetadata;

  const nextCommitment = providerCommitments[0] || null;
  const nextStartMs = nextCommitment ? new Date(nextCommitment.startOn).getTime() : null;
  const hasFiniteGap = Number.isFinite(nextStartMs);
  const availableGapMinutes = hasFiniteGap
    ? Math.floor((nextStartMs - currentEndMs) / 60000)
    : Number.POSITIVE_INFINITY;
  // Never offer an extension we cannot prove fits. With no next commitment to
  // bound against, and no location-hours/shift data wired into eligibility yet,
  // the remaining room is unprovable, so skip rather than assume infinite room.
  // (Boulevard does expose Location.hours and a Shift type; bounding the gap by
  // location close / provider shift end to recover last-of-day offers is a
  // documented follow-up, not this fix.)
  const fits = hasFiniteGap && availableGapMinutes >= requiredExtraMinutes;

  return {
    eligible: fits,
    reason: fits ? 'eligible' : (hasFiniteGap ? 'insufficient_gap' : 'gap_unprovable'),
    appointmentId: current.id,
    clientId: current.clientId,
    providerId: current.providerId || null,
    providerIdentityMode,
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

// --- Duration-upgrade gap bounding by location close + provider shift end ---
// Boulevard exposes Location.hours (per-day open + start/finish wall-clock,
// Sunday-indexed array) plus the location tz, and a shifts(...) root query
// returning the provider's clockOut for a date. We use these to bound the gap
// after a booking when there is no next same-provider appointment, so a
// provider's last booking of the day is not falsely skipped as gap_unprovable
// when the salon is open long enough afterward for the added minutes to fit.

function bareBoulevardId(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const idx = s.lastIndexOf(':');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

// Boulevard's shifts() staffIds filter requires the full Staff URN (a bare uuid
// errors with "Could not decode global ID value ..."). Verified read-only against
// production 2026-06-19. Coerce a bare uuid to the Staff URN; leave an existing
// Staff URN as-is; leave any other urn untouched (it will not match a staff shift,
// which fails closed). The shifts() RESPONSE staffId is bare, so matching is done
// separately via bareBoulevardId on both sides.
function toBoulevardStaffUrn(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.startsWith('urn:blvd:Staff:')) return s;
  if (s.includes(':')) return s;
  return `urn:blvd:Staff:${s}`;
}

// The tz offset (ms) that `timeZone` is at the instant `ms`, via round-tripping
// the formatted wall-clock back through Date.UTC.
function tzOffsetMsAt(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  let hh = Number(parts.hour);
  if (hh === 24) hh = 0; // some ICU builds render midnight as 24
  const asTzMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hh, Number(parts.minute), Number(parts.second));
  if (!Number.isFinite(asTzMs)) return NaN;
  return asTzMs - ms;
}

// Convert a wall-clock time (year, month, day, hour, minute) in `timeZone` to a
// UTC epoch ms. Two-pass offset correction: take the offset at the UTC guess,
// then re-evaluate the offset at the corrected instant. The second pass fixes
// wall times that land in a DST spring-forward hour, where the first-pass offset
// (read off the pre-jump UTC guess) would otherwise be an hour stale. Evening
// close/shift times never fall in that hour, but the two-pass form is correct
// for all inputs.
function zonedWallClockToUtcMs(year, month, day, hour, minute, timeZone) {
  if (!timeZone) return NaN;
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  if (!Number.isFinite(guess)) return NaN;
  const off1 = tzOffsetMsAt(guess, timeZone);
  if (!Number.isFinite(off1)) return NaN;
  const off2 = tzOffsetMsAt(guess - off1, timeZone);
  if (!Number.isFinite(off2)) return NaN;
  return guess - off2;
}

// Calendar date of `dateMs` in `timeZone`, so an 8:30 PM ET booking that is past
// midnight UTC still resolves to its local day for the hours-array index.
function getZonedYmd(dateMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(dateMs)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

// Reject wall-clock values Boulevard should never send (hour 0-24, minute 0-59)
// so a malformed value like 99:99 cannot roll over through Date.UTC into a huge
// fake-positive gap and over-offer.
// Strict integer parse: accept a real integer or an all-digits string only. Rejects
// JS Number() coercions of malformed input ("2e1" -> 20, "0x15" -> 21, "21.0" -> 21).
function strictInt(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
  return NaN;
}

function isValidWallClock(hour, minute) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  if (minute < 0 || minute > 59) return false;
  if (hour < 0 || hour > 24) return false;
  if (hour === 24 && minute !== 0) return false; // 24:00 is midnight; 24:30 is not a real time
  return true;
}

// Strictly parse a 24h wall-clock string ("HH:MM" or "HH:MM:SS") to { h, mi }, or
// null if anything is malformed. Rejects garbage tails ("21:00:BAD", "21:00:00Z"),
// out-of-range parts ("99:99"), and hour 24 with any non-zero minute/second
// ("24:00:30") so no bad value can resolve to a fake shift bound. Seconds are
// validated then dropped (the gap is computed at minute granularity).
function parseWallClockTime(value) {
  if (typeof value !== 'string') return null; // no coercion of arrays/objects/numbers
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const sec = m[3] === undefined ? 0 : Number(m[3]);
  if (!isValidWallClock(h, mi) || sec < 0 || sec > 59) return null;
  if (h === 24 && sec !== 0) return null; // only 24:00:00 is the valid midnight form
  return { h, mi };
}

// Pure: minutes from the appointment end to the location close and to the provider
// shift end (in the location tz). Hours array is Sunday-indexed (0 = Sun). The
// individual bounds are reported for observability, but availableGapMinutes (the
// PROVEN gap the caller offers on) is set ONLY when BOTH bounds resolve. A resolved
// close with an unresolved shift is NOT enough: closing time alone is not proof an
// esthetician is present to perform the longer service, so it FAILS CLOSED (null).
function computeCloseShiftGapMinutes({ endOn, locationTz, hours, shiftClockOut }) {
  const out = { availableGapMinutes: null, locationCloseMinutes: null, shiftEndMinutes: null, gapBoundedBy: null };
  const endMs = Date.parse(endOn);
  if (!Number.isFinite(endMs) || !locationTz) return out;
  const { year, month, day } = getZonedYmd(endMs, locationTz);
  if (!isFiniteNumber(year)) return out;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday

  if (Array.isArray(hours) && hours.length >= 7) {
    const dayHours = hours[weekday];
    if (dayHours && dayHours.open === true && dayHours.finish) {
      // Both hour and minute must be well-formed integers; no defaulting, so a
      // missing/empty/garbage minute fails closed rather than resolving a bound.
      const ch = strictInt(dayHours.finish.hour);
      const cm = strictInt(dayHours.finish.minute);
      if (isValidWallClock(ch, cm)) {
        const closeMs = zonedWallClockToUtcMs(year, month, day, ch, cm, locationTz);
        if (Number.isFinite(closeMs)) out.locationCloseMinutes = Math.floor((closeMs - endMs) / 60000);
      }
    }
  }
  const shiftTime = shiftClockOut ? parseWallClockTime(shiftClockOut) : null;
  if (shiftTime) {
    const shiftMs = zonedWallClockToUtcMs(year, month, day, shiftTime.h, shiftTime.mi, locationTz);
    if (Number.isFinite(shiftMs)) out.shiftEndMinutes = Math.floor((shiftMs - endMs) / 60000);
  }
  // FAIL CLOSED: the gap is proven only when BOTH the close and the shift bound
  // resolve. One bound alone never produces an offerable gap.
  if (Number.isFinite(out.locationCloseMinutes) && Number.isFinite(out.shiftEndMinutes)) {
    out.availableGapMinutes = Math.min(out.locationCloseMinutes, out.shiftEndMinutes);
    out.gapBoundedBy = out.shiftEndMinutes <= out.locationCloseMinutes ? 'shift_end' : 'location_close';
  }
  return out;
}

async function fetchLocationHoursContext(auth, locationId) {
  const id = String(locationId || '').trim();
  if (!auth || !id) return null;
  try {
    const query = `
      query FetchLocationHours($id: ID!) {
        location(id: $id) {
          tz
          hours { open start { hour minute } finish { hour minute } }
        }
      }
    `;
    const data = await fetchBoulevardGraphQL(auth.apiUrl, auth.headers, query, { id }, { silentErrors: true, returnErrors: true });
    if (!data || data.__error) return null;
    const loc = data?.data?.location;
    if (!loc || !loc.tz) return null;
    return { tz: String(loc.tz), hours: Array.isArray(loc.hours) ? loc.hours : null };
  } catch {
    return null;
  }
}

async function fetchProviderShiftClockOut(auth, locationId, providerId, localDateStr) {
  const loc = String(locationId || '').trim();
  const prov = String(providerId || '').trim();
  if (!auth || !loc || !prov || !localDateStr) return null;
  try {
    const query = `
      query FetchStaffShifts($start: Date!, $end: Date!, $loc: ID!, $ids: [ID!]) {
        shifts(startIso8601: $start, endIso8601: $end, locationId: $loc, staffIds: $ids) {
          shifts { staffId clockOut available }
        }
      }
    `;
    // Filter takes the Staff URN; response staffId is bare (verified live, see toBoulevardStaffUrn).
    const data = await fetchBoulevardGraphQL(auth.apiUrl, auth.headers, query, { start: localDateStr, end: localDateStr, loc, ids: [toBoulevardStaffUrn(prov)] }, { silentErrors: true, returnErrors: true });
    if (!data || data.__error) return null;
    const rows = data?.data?.shifts?.shifts;
    if (!Array.isArray(rows)) return null;
    const wantBare = bareBoulevardId(prov); // response staffId is BARE; match bare-to-bare
    const matches = rows.filter(r => r && r.available !== false && typeof r.clockOut === 'string' && bareBoulevardId(r.staffId) === wantBare);
    // Fail closed on a split shift: more than one matching block means we cannot
    // prove which one covers the appointment without clockIn, and binding the wrong
    // (later) block would overstate the gap and produce a false offer. Require
    // exactly one block; otherwise no shift bound resolves and the upgrade stays
    // gap_unprovable. (Finding 4 / codex P1.)
    if (matches.length !== 1) return null;
    return matches[0].clockOut; // require a real string clockOut; no coercion
  } catch {
    return null;
  }
}

async function resolveCloseShiftBoundedGap(auth, result) {
  const endOn = result?.endOn;
  const locationId = result?.locationId;
  const providerId = result?.providerId;
  const empty = { availableGapMinutes: null, locationCloseMinutes: null, shiftEndMinutes: null, gapBoundedBy: null };
  if (!auth || !endOn || !locationId) return empty;
  const locCtx = await fetchLocationHoursContext(auth, locationId);
  if (!locCtx || !locCtx.tz) return empty;
  const endMs = Date.parse(endOn);
  if (!Number.isFinite(endMs)) return empty;
  const { year, month, day } = getZonedYmd(endMs, locCtx.tz);
  const localDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  let shiftClockOut = null;
  if (providerId) shiftClockOut = await fetchProviderShiftClockOut(auth, locationId, providerId, localDateStr);
  return computeCloseShiftGapMinutes({ endOn, locationTz: locCtx.tz, hours: locCtx.hours, shiftClockOut });
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

  // Narrow Boulevard's appointments query to the window we actually evaluate.
  // Without this, the global query paginates oldest-first and our MAX_PAGES cap
  // prevents reaching today's appointments at high-volume locations.
  const windowHours = Math.max(1, Number(options?.windowHours) || 24);
  const windowStart = new Date(Date.now() - 30 * 60 * 1000); // 30min slack for in-progress lookups
  const windowEnd = new Date(Date.now() + (windowHours + 24) * 60 * 60 * 1000); // pad past evaluation window

  const scan = await scanAppointments(auth.apiUrl, auth.headers, {
    locationId: profileLocationId,
    clientId: profile?.clientId || null,
    windowStart,
    windowEnd,
  });
  let appointments = scan?.appointments || null;
  let fallbackScanUsed = false;

  // Guests can have appointments at locations other than their primary profile location.
  // If a location-scoped scan returns no rows, retry once without location scoping.
  if (Array.isArray(appointments) && appointments.length === 0 && profileLocationId) {
    const fallbackScan = await scanAppointments(auth.apiUrl, auth.headers, {
      locationId: null,
      clientId: profile?.clientId || null,
      windowStart,
      windowEnd,
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

  let result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, options);
  const shouldRecoverProviderContext = Boolean(
    result?.appointmentId &&
    !String(result?.providerId || '').trim() &&
    (
      result?.reason === 'provider_identity_unavailable' ||
      (
        result?.reason === 'no_upgrade_target_for_duration' &&
        Number(result?.currentDurationMinutes) >= 50 &&
        result?.gapUnlimited == null
      )
    )
  );
  if (shouldRecoverProviderContext) {
    const appointmentContext = await fetchAppointmentContextById(
      auth.apiUrl,
      auth.headers,
      result.appointmentId,
    );
    const recoveredProviderId = String(appointmentContext?.providerId || '').trim();
    if (recoveredProviderId) {
      const targetAppointmentId = String(result.appointmentId).trim();
      const recoveredAppointments = appointments.map(appointment => {
        if (String(appointment?.id || '').trim() !== targetAppointmentId) return appointment;
        return {
          ...appointment,
          providerId: String(appointment?.providerId || '').trim() || recoveredProviderId,
          locationId: appointment?.locationId || appointmentContext?.locationId || null,
          startOn: appointment?.startOn || appointmentContext?.startOn || null,
          endOn: appointment?.endOn || appointmentContext?.endOn || null,
        };
      });
      result = evaluateUpgradeEligibilityFromAppointments(recoveredAppointments, profile, options);
      if (result && typeof result === 'object') {
        result.providerContextRecovered = true;
      }
    }
  }
  // Last-of-day recovery: when no next same-provider commitment bounds the gap
  // (gap_unprovable), try to bound it by BOTH the location close AND the provider
  // shift end. Only runs in the gap_unprovable case; when a next commitment exists
  // it is already the tightest bound, so this adds no fetches on the common path.
  // FAIL CLOSED: computeCloseShiftGapMinutes returns availableGapMinutes only when
  // BOTH bounds resolve, so any hours OR shift fetch failure (timeout, GraphQL
  // error, empty rows, no matching staff row) leaves it null and the result stays
  // gap_unprovable. Closing time alone never makes an upgrade eligible: it is not
  // proof the provider is present to perform the longer service.
  if (result?.reason === 'gap_unprovable' && result.endOn && isFiniteNumber(result.requiredExtraMinutes)) {
    try {
      const bounded = await resolveCloseShiftBoundedGap(auth, result);
      if (bounded) {
        result.locationCloseMinutes = Number.isFinite(bounded.locationCloseMinutes) ? bounded.locationCloseMinutes : null;
        result.shiftEndMinutes = Number.isFinite(bounded.shiftEndMinutes) ? bounded.shiftEndMinutes : null;
        if (bounded.availableGapMinutes != null) {
          result.availableGapMinutes = bounded.availableGapMinutes;
          result.gapBoundedBy = bounded.gapBoundedBy;
          result.gapUnlimited = false;
          const fits = bounded.availableGapMinutes >= result.requiredExtraMinutes;
          result.eligible = fits;
          result.reason = fits ? 'eligible' : 'insufficient_gap';
        }
      }
    } catch (err) {
      // Conservative: leave gap_unprovable untouched on any failure.
    }
  }
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

  // De-silenced (PR-1, hardening 2026-06-19): returnErrors so a Boulevard
  // rejection of the mutation is captured and surfaced instead of swallowed.
  // fetchBoulevardGraphQL also logs the GraphQL error at error level now that
  // silentErrors is gone. Mutation candidates and success detection are unchanged.
  let lastError = null;
  for (const candidate of mutationCandidates) {
    const data = await fetchBoulevardGraphQL(
      apiUrl,
      headers,
      candidate.query,
      { appointmentId, serviceId },
      { returnErrors: true },
    );
    if (data?.__error) {
      lastError = data.__error;
      continue;
    }
    if (!data) continue;
    const node = data?.data?.[candidate.root];
    const updatedId = node?.appointment?.id || node?.id || null;
    if (updatedId) return { applied: true, mutationRoot: candidate.root, updatedId: String(updatedId) };
  }

  return { applied: false, reason: 'upgrade_mutation_failed', error: lastError };
}

// Read-back guard: the upgrade mutation only echoes back appointment { id },
// so a Boulevard no-op can still look "applied". Re-fetch the appointment and
// confirm its service now equals the configured target service id before we
// treat the upgrade as real. Any fetch failure returns false (fail closed).
async function verifyAppointmentServiceApplied(apiUrl, headers, appointmentId, expectedServiceId) {
  const expected = String(expectedServiceId || '').trim();
  if (!expected) return false;
  const context = await fetchAppointmentContextById(apiUrl, headers, appointmentId);
  if (!context) return false;
  if (String(context.serviceId || '').trim() === expected) return true;
  return (context.appointmentServices || []).some(
    service => String(service?.serviceId || '').trim() === expected,
  );
}

// Fix A verification: confirm the in-place edit landed by reading the appointment
// back and checking its (edited) service line now reports the target duration. The
// service id is intentionally unchanged (no swap), so we verify duration, not id.
async function verifyAppointmentDurationApplied(apiUrl, headers, appointmentId, expectedDuration, expectedServiceId) {
  const expected = Math.round(Number(expectedDuration));
  if (!Number.isFinite(expected) || expected <= 0) return false;
  const id = String(appointmentId || '').trim();
  if (!id) return false;
  const query = `
    query VerifyApptDuration($id: ID!) {
      appointment(id: $id) {
        id
        appointmentServices { id serviceId duration totalDuration }
      }
    }
  `;
  const data = await fetchBoulevardGraphQL(apiUrl, headers, query, { id }, { silentErrors: true, returnErrors: true });
  if (!data || data.__error) return false;
  const appt = data?.data?.appointment;
  if (!appt?.id) return false;
  const services = Array.isArray(appt.appointmentServices) ? appt.appointmentServices : [];
  const lineMatches = (s) => Number(s?.duration) === expected || Number(s?.totalDuration) === expected;
  // Prefer the SPECIFIC edited line: an in-place duration edit leaves the service
  // id unchanged, so match the line by service id and check that line's duration.
  // Only fall back to any line if the edited line is not identifiable. No
  // appointment-level aggregate fallback (a different line or the total could
  // match the target and falsely pass).
  const wantSvc = String(expectedServiceId || '').trim();
  if (wantSvc) {
    const line = services.find(s => String(s?.serviceId || '').trim() === wantSvc);
    if (line) return lineMatches(line);
  }
  return services.some(lineMatches);
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
  // This separate-fetch path bypasses scanAppointments, so the scan-source
  // cancelled-row filter does not cover it. Introspection-gate the cancelled
  // boolean (so the query never breaks on a schema lacking it) and fail closed
  // below, mirroring the scan guard. Without this, the add-on reverify path and
  // the provider-context recovery path could still act on a cancelled target.
  const cancelledFieldCandidates = ['cancelled', 'canceled']
    .filter(fieldName => {
      const detail = appointmentFieldDetailMap?.get(fieldName) || null;
      return detail && isScalarOrEnumGraphqlKind(detail.kind);
    });
  const cancelledField = cancelledFieldCandidates[0] || null;
  const cancelledSelection = cancelledField || '';
  const query = `
    query FetchAppointmentContext($id: ID!) {
      appointment(id: $id) {
        id
        clientId
        locationId
        startAt
        endAt
        ${noteSelection}
        ${cancelledSelection}
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
  // Fail closed on a cancelled target so no downstream apply path acts on it.
  if (cancelledField && appointment[cancelledField] === true) return null;
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
    appointmentServices: services
      .map(service => ({
        id: String(service?.id || '').trim() || null,
        serviceId: String(service?.serviceId || '').trim() || null,
        staffId: String(service?.staffId || '').trim() || null,
      }))
      .filter(service => service.id || service.serviceId || service.staffId),
  };
}

async function fetchServiceContextById(apiUrl, headers, serviceId) {
  const id = String(serviceId || '').trim();
  if (!id) return null;
  if (serviceContextCache.has(id)) return serviceContextCache.get(id) || null;

  const query = `
    query FetchServiceContext($id: ID!) {
      service(id: $id) {
        id
        name
        addon
        active
        defaultDuration
        defaultPrice
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
  if (!data || data.__error) {
    serviceContextCache.set(id, null);
    return null;
  }
  const service = data?.data?.service || null;
  if (!service?.id) {
    serviceContextCache.set(id, null);
    return null;
  }

  const context = {
    id: String(service.id || '').trim() || null,
    name: String(service.name || '').trim() || null,
    addon: service.addon === true,
    active: service.active !== false,
    defaultDuration: Number(service.defaultDuration || 0) || 0,
    defaultPrice: Number(service.defaultPrice || 0) || 0,
  };
  serviceContextCache.set(id, context);
  return context;
}

async function findServiceContextByName(apiUrl, headers, serviceName, options = {}) {
  const normalizedName = normalizeServiceNameKey(serviceName);
  if (!normalizedName) return null;

  const addonOnly = options.addonOnly === true;
  const activeOnly = options.activeOnly !== false;
  const cacheKey = `${normalizedName}::addon=${addonOnly ? '1' : '0'}::active=${activeOnly ? '1' : '0'}`;
  if (serviceLookupCache.has(cacheKey)) return serviceLookupCache.get(cacheKey) || null;

  const query = `
    query ScanServices($after: String) {
      services(first: ${SERVICE_SCAN_PAGE_SIZE}, after: $after) {
        edges {
          node {
            id
            name
            addon
            active
            defaultDuration
            defaultPrice
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const matches = [];
  let after = null;
  for (let page = 0; page < SERVICE_SCAN_MAX_PAGES; page += 1) {
    const data = await fetchBoulevardGraphQL(
      apiUrl,
      headers,
      query,
      { after },
      { silentErrors: true, returnErrors: true },
    );
    if (!data || data.__error) break;
    const connection = data?.data?.services;
    const edges = connection?.edges || [];
    if (edges.length === 0) break;

    for (const edge of edges) {
      const node = edge?.node || null;
      const candidateNameKey = normalizeServiceNameKey(node?.name);
      if (candidateNameKey !== normalizedName) continue;
      if (addonOnly && node?.addon !== true) continue;
      if (activeOnly && node?.active === false) continue;
      const context = {
        id: String(node?.id || '').trim() || null,
        name: String(node?.name || '').trim() || null,
        addon: node?.addon === true,
        active: node?.active !== false,
        defaultDuration: Number(node?.defaultDuration || 0) || 0,
        defaultPrice: Number(node?.defaultPrice || 0) || 0,
      };
      if (context.id) {
        matches.push(context);
        serviceContextCache.set(context.id, context);
      }
    }

    if (!connection?.pageInfo?.hasNextPage) break;
    after = String(connection?.pageInfo?.endCursor || '').trim() || null;
    if (!after) break;
  }

  matches.sort((left, right) => {
    const addonDiff = Number(Boolean(right?.addon)) - Number(Boolean(left?.addon));
    if (addonDiff !== 0) return addonDiff;
    const activeDiff = Number(Boolean(right?.active)) - Number(Boolean(left?.active));
    if (activeDiff !== 0) return activeDiff;
    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });

  const resolved = matches[0] || null;
  serviceLookupCache.set(cacheKey, resolved);
  return resolved;
}

async function resolveAddonServiceContext(apiUrl, headers, pendingOffer) {
  const addOnCode = String(pendingOffer?.addOnCode || '').trim();
  const configuredEnvName = ADDON_SERVICE_ID_ENV_BY_CODE[addOnCode] || '';
  const configuredServiceId = configuredEnvName ? String(process.env[configuredEnvName] || '').trim() : '';
  if (configuredServiceId) {
    const configuredContext = await fetchServiceContextById(apiUrl, headers, configuredServiceId);
    if (configuredContext) return configuredContext;
  }

  const addOnName = String(
    pendingOffer?.addOnName || ADDON_DISPLAY_NAME_BY_CODE[addOnCode] || '',
  ).trim();
  if (!addOnName) return null;
  return findServiceContextByName(apiUrl, headers, addOnName, {
    addonOnly: true,
    activeOnly: true,
  });
}

async function appointmentAlreadyHasAddon(apiUrl, headers, appointmentContext, targetAddonServiceId = '') {
  const targetServiceId = String(targetAddonServiceId || '').trim();
  const appointmentServices = Array.isArray(appointmentContext?.appointmentServices)
    ? appointmentContext.appointmentServices
    : [];
  for (const appointmentService of appointmentServices) {
    const serviceId = String(appointmentService?.serviceId || '').trim();
    if (!serviceId) continue;
    if (targetServiceId && serviceId === targetServiceId) return true;
    const serviceContext = await fetchServiceContextById(apiUrl, headers, serviceId);
    if (serviceContext?.addon === true) return true;
  }
  return false;
}

function toBookingWarningList(rawWarnings) {
  if (!Array.isArray(rawWarnings)) return [];
  return rawWarnings.map(warning => ({
    code: String(warning?.code || '').trim() || null,
    message: String(warning?.message || '').trim() || null,
    staffId: String(warning?.staffId || '').trim() || null,
    serviceId: String(warning?.serviceId || '').trim() || null,
    // bookingServiceId is the most precise self-overlap signal: it names the exact
    // draft line being edited. Boulevard returns it as a bare uuid (see below).
    bookingServiceId: String(warning?.bookingServiceId || '').trim() || null,
  }));
}

// A STAFF_DOUBLE_BOOKED warning is the benign SELF-OVERLAP of an in-place duration
// edit when it names the exact line being edited AND an independent schedule read has
// proven no OTHER real appointment occupies that staff/time window. Boulevard returns
// warning ids as BARE uuids while the code carries full urn:blvd: ids, so every
// comparison normalizes to the bare uuid tail via bareBoulevardId. (This bare-vs-urn
// mismatch is exactly what falsely aborted the first dry-run harness.)
function isSelfOverlapStaffDoubleBooked(warning, selfOverlapContext) {
  if (!selfOverlapContext || selfOverlapContext.staffWindowClear !== true) return false;
  if (String(warning?.code || '').trim().toUpperCase() !== 'STAFF_DOUBLE_BOOKED') return false;
  const warnBookingServiceId = bareBoulevardId(warning?.bookingServiceId);
  const warnServiceId = bareBoulevardId(warning?.serviceId);
  const warnStaffId = bareBoulevardId(warning?.staffId);
  const matchesByBookingServiceId =
    Boolean(warnBookingServiceId) && warnBookingServiceId === bareBoulevardId(selfOverlapContext.baseBookingServiceId);
  const matchesByServiceAndStaff =
    Boolean(warnServiceId) && warnServiceId === bareBoulevardId(selfOverlapContext.sourceServiceId) &&
    Boolean(warnStaffId) && warnStaffId === bareBoulevardId(selfOverlapContext.providerId);
  return matchesByBookingServiceId || matchesByServiceAndStaff;
}

// Discriminating warning policy. RESOURCE_DOUBLE_BOOKED and STAFF_DOES_NOT_PERFORM_SERVICE
// are always blocking. STAFF_DOUBLE_BOOKED is blocking UNLESS it is the proven benign
// self-overlap of an in-place edit (selfOverlapContext supplied AND staffWindowClear AND
// the warning names the edited line). The self-overlap context is supplied ONLY by the
// in-place duration apply path; every other caller (e.g. the add-on path) passes no
// context, so STAFF_DOUBLE_BOOKED stays a hard block for them, unchanged.
function hasBlockingBookingWarnings(warnings = [], selfOverlapContext = null) {
  if (!Array.isArray(warnings) || warnings.length === 0) return false;
  const blockingCodes = new Set([
    'RESOURCE_DOUBLE_BOOKED',
    'STAFF_DOUBLE_BOOKED',
    'STAFF_DOES_NOT_PERFORM_SERVICE',
  ]);
  return warnings.some(warning => {
    const code = String(warning?.code || '').trim().toUpperCase();
    if (!blockingCodes.has(code)) return false;
    if (code === 'STAFF_DOUBLE_BOOKED' && isSelfOverlapStaffDoubleBooked(warning, selfOverlapContext)) return false;
    return true;
  });
}

// Reads the target location's staff TIMEBLOCKS (breaks, time-off, holds) over a window.
// Boulevard surfaces an upgrade that extends an appointment into a staff block as a
// STAFF_DOUBLE_BOOKED *warning* (not a hard error), so the appointment-only scan cannot
// see it; this is the read primitive that lets the provider-window-clear check fail
// closed on a block. Returns { timeblocks: [...] } on success, { timeblocks: null } on
// ANY transport/GraphQL failure, a null list, OR a truncated (multi-page) read, so the
// caller treats the window as NOT clear rather than trusting an incomplete block read.
async function scanTimeblocks(apiUrl, headers, context = {}) {
  const locationId = String(context?.locationId || '').trim();
  if (!locationId) return { timeblocks: null };
  // Reuse the appointment window clause builder: Timeblock filters on startAt exactly as
  // the appointment scan does, so the SAME window bounds (including the caller's ±1-day
  // midnight pad) drive both reads. No second, uncoordinated window.
  const windowQueryString = buildAppointmentWindowQuery(context);
  const query = `
    query ScanTimeblocks($locationId: ID!, $query: QueryString) {
      timeblocks(locationId: $locationId, query: $query, first: ${APPOINTMENT_SCAN_PAGE_SIZE}) {
        edges { node { staffId startAt endAt reason cancelled } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  // Read-only and idempotent, so transient retry is safe (mirrors scanAppointments).
  const data = await fetchBoulevardGraphQL(
    apiUrl,
    headers,
    query,
    { locationId, query: windowQueryString },
    { silentErrors: true, returnErrors: true, retryTransient: true },
  );
  if (!data || data.__error) return { timeblocks: null }; // transport / GraphQL error -> fail closed
  const payload = data?.data?.timeblocks;
  if (payload === null || payload === undefined) return { timeblocks: null }; // null list -> fail closed
  // A truncated read cannot prove the window clear: the overlapping block could be on a
  // page we did not fetch. Fail closed rather than read a partial block set as "none". Any
  // truthy hasNextPage (not just boolean true) counts as truncated.
  if (payload?.pageInfo?.hasNextPage) return { timeblocks: null };
  let nodes = [];
  if (Array.isArray(payload?.edges)) nodes = payload.edges.map(edge => edge?.node).filter(Boolean);
  else if (Array.isArray(payload?.nodes)) nodes = payload.nodes.filter(Boolean);
  else if (Array.isArray(payload)) nodes = payload.filter(Boolean);
  else if (payload && typeof payload === 'object') nodes = [payload];
  return { timeblocks: nodes };
}

// Reuses scanAppointments (the same appointment-read primitive the eligibility path
// uses) to prove the edited appointment's extended window holds NO OTHER real
// appointment on the same provider. This is the safety core of the in-place upgrade:
// the eligibility gap read is client-scoped and cannot see other clients' bookings on
// the staff, so a genuine cross-client collision is detectable only here. FAILS CLOSED:
// any scan failure, or any in-window appointment on the same provider OR with an
// unresolvable provider, returns false so a real collision can never be mistaken for
// the benign self-overlap. The source appointment is excluded by id (it is the line
// being edited); cancelled rows are already dropped at the scan source.
async function isStaffWindowClearOfOtherAppointments(apiUrl, headers, context) {
  const appointmentBareId = bareBoulevardId(context?.appointmentId);
  const providerBareId = bareBoulevardId(context?.providerId);
  const locationId = String(context?.locationId || '').trim();
  const startMs = Date.parse(context?.startOn);
  const windowEndMs = Date.parse(context?.windowEndOn);
  if (!appointmentBareId || !providerBareId || !locationId || !Number.isFinite(startMs) || !Number.isFinite(windowEndMs)) {
    return false; // missing inputs -> cannot prove clear -> fail closed
  }
  // buildAppointmentWindowQuery filters by START date at day granularity. Pull the
  // lower bound back one day so an appointment that STARTS before the source's UTC
  // midnight but RUNS INTO the window (e.g. an evening ET booking that straddles UTC
  // midnight) is still returned and time-overlap-filtered below; without this the
  // date filter (startAt >= source-date) would silently exclude it. The window stays
  // a few days at one location, far under the scan page cap, and the source-present
  // sanity gate below independently fails closed on any truncation.
  const scanWindowStart = new Date(startMs - 24 * 60 * 60 * 1000);
  const scanWindowEnd = new Date(windowEndMs + 24 * 60 * 60 * 1000);
  const scan = await scanAppointments(apiUrl, headers, {
    locationId,
    windowStart: scanWindowStart,
    windowEnd: scanWindowEnd,
  });
  if (!scan || !Array.isArray(scan.appointments)) return false; // scan failed -> fail closed
  // Sanity gate: the appointment being edited MUST appear in its own window scan. If
  // it does not, the scan did not actually cover this window (date-filter mismatch,
  // pagination truncation, a dropped row), so it cannot be trusted to prove the
  // window is clear. Fail closed rather than read an incomplete scan as "no others".
  const sawSourceAppointment = scan.appointments.some(appt => bareBoulevardId(appt?.id) === appointmentBareId);
  if (!sawSourceAppointment) return false;

  // Appointments overlapping the extended window (excluding the source being edited).
  const overlapping = scan.appointments.filter(appt => {
    if (bareBoulevardId(appt?.id) === appointmentBareId) return false;
    const otherStart = Date.parse(appt?.startOn);
    const otherEnd = Date.parse(appt?.endOn);
    if (!Number.isFinite(otherStart) || !Number.isFinite(otherEnd)) return false;
    return otherStart < windowEndMs && otherEnd > startMs;
  });

  // Decide same-staff at SERVICE level, not just by the appointment-level provider:
  // a multi-staff appointment can carry a line on the target staff while its
  // appointment-level provider resolves to someone else. For each overlapping
  // appointment, an appointment-level provider that already matches (or is
  // unresolvable) blocks immediately; otherwise resolve its service-line staff and
  // block if any line is on the target staff. Any resolution failure fails closed.
  const needsServiceCheck = [];
  for (const appt of overlapping) {
    const otherProviderBareId = bareBoulevardId(appt?.providerId);
    if (!otherProviderBareId || otherProviderBareId === providerBareId) return false;
    needsServiceCheck.push(appt);
  }
  if (needsServiceCheck.length > 0) {
    const contexts = await Promise.all(
      needsServiceCheck.map(appt =>
        fetchAppointmentContextById(apiUrl, headers, appt.id).catch(() => null),
      ),
    );
    for (const ctx of contexts) {
      if (!ctx) return false; // could not resolve service staff -> fail closed
      const hasTargetStaffLine = (Array.isArray(ctx.appointmentServices) ? ctx.appointmentServices : [])
        .some(service => bareBoulevardId(service?.staffId) === providerBareId);
      if (hasTargetStaffLine) return false; // a service line is on the target staff -> collision
    }
  }

  // Staff TIMEBLOCKS (breaks, time-off, holds) are invisible to the appointment scan, but
  // a duration extension into one is a real collision Boulevard only WARNS (not errors) on
  // - the probe-confirmed P1-A gap (2026-06-25): a draft on a "no appointments" staff block
  // raised STAFF_DOUBLE_BOOKED on a window with zero real appointments. Scan the SAME padded
  // window for the target staff and FAIL CLOSED: any block-read failure, or a non-cancelled
  // block overlapping [start, windowEnd), means the window is NOT clear and the apply aborts
  // before bookingComplete. Without this, such a block reads as the benign self-overlap.
  // Timeblocks can run for DAYS (PTO, leave, holds), unlike appointments. The startAt filter
  // would miss a multi-day block that STARTED before the appointment's day yet overlaps the
  // window, so the timeblock fetch uses a wide lookback on its lower bound (default 30 days,
  // BOULEVARD_TIMEBLOCK_LOOKBACK_DAYS) instead of the appointment scan's +/-1-day pad. The upper
  // bound is unchanged: a block starting after the window cannot overlap it. (A still-running
  // block that started before the lookback horizon is the documented residual the pre-flag-flip
  // supervised probe must assess.)
  const timeblockLookbackDays = Math.max(1, Number(process.env.BOULEVARD_TIMEBLOCK_LOOKBACK_DAYS) || 30);
  const timeblockWindowStart = new Date(startMs - timeblockLookbackDays * 24 * 60 * 60 * 1000);
  const blockScan = await scanTimeblocks(apiUrl, headers, {
    locationId,
    windowStart: timeblockWindowStart,
    windowEnd: scanWindowEnd,
  });
  if (!blockScan || !Array.isArray(blockScan.timeblocks)) return false; // block scan failed -> fail closed
  const blockedByTimeblock = blockScan.timeblocks.some(block => {
    if (block?.cancelled === true) return false; // cancelled blocks do not occupy the staff
    const blockStaff = bareBoulevardId(block?.staffId);
    // Only the target staff's blocks matter, EXCEPT a null/empty staffId may be an all-staff or
    // location-wide closure that cannot be attributed away -> treat as target-staff (fail closed).
    if (blockStaff && blockStaff !== providerBareId) return false;
    const blockStart = Date.parse(block?.startAt);
    const blockEnd = Date.parse(block?.endAt);
    // A target-staff (or unattributable) non-cancelled block whose bounds will not parse cannot
    // be proven NOT to overlap -> fail closed rather than ignore it.
    if (!Number.isFinite(blockStart) || !Number.isFinite(blockEnd)) return true;
    return blockStart < windowEndMs && blockEnd > startMs; // [startAt, endAt) overlaps the extended window
  });
  if (blockedByTimeblock) return false;

  return true;
}

// Formats a Boulevard __error object (the shape returned by fetchBoulevardGraphQL
// with returnErrors) into a compact one-line string. Used to surface an apply
// rejection with its actual Boulevard text instead of a bare reason code. The
// text is Boulevard's own validation/operation message plus an HTTP body preview
// (already truncated to 500 chars); it lands only in the error log and the
// internal support incident, which is already scoped to this one member.
function summarizeBoulevardApplyError(error) {
  if (!error) return 'unknown_error';
  const stage = String(error.stage || 'error');
  if (Array.isArray(error.errors) && error.errors.length) {
    const msgs = error.errors
      .map(e => String(e?.message || e?.code || '').trim())
      .filter(Boolean)
      .join('; ');
    return `${stage}: ${msgs || 'graphql_error'}`;
  }
  if (error.status || error.bodyPreview) {
    return `${stage} ${error.status || ''}: ${String(error.bodyPreview || '').trim()}`.trim();
  }
  if (error.message) return `${stage}: ${String(error.message).trim()}`;
  if (error.diagnostics) {
    let detail = error.diagnostics;
    try { detail = typeof detail === 'string' ? detail : JSON.stringify(detail); } catch { detail = String(detail); }
    return `${stage}: ${detail}`;
  }
  return stage;
}

// Surfaces a Boulevard apply rejection loudly: an error-level log carrying the
// Boulevard text and a daily failure counter. Only fires when Boulevard actually
// gave feedback (an error or a blocking warning), so pre-flight gating failures
// that never reached Boulevard are not counted as rejections. Never throws.
async function recordUpgradeApplyRejection(pathLabel, appointmentId, error, warnings) {
  const blockingWarnings = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
  if (!error && blockingWarnings.length === 0) return;
  let detail;
  if (error) {
    detail = summarizeBoulevardApplyError(error);
  } else {
    try { detail = `warning: ${JSON.stringify(blockingWarnings)}`; } catch { detail = 'warning'; }
  }
  console.error(`[upgrade-apply] Boulevard rejected ${pathLabel} apply for appointment ${appointmentId || 'unknown'}: ${detail}`);
  try {
    await incrementUpgradeApplyFailureCount();
  } catch (err) {
    console.warn('[upgrade-apply] failure counter increment failed:', err?.message || err);
  }
}

async function runMutationRoot(apiUrl, headers, query, variables, root) {
  // De-silenced (PR-1, hardening 2026-06-19): drop silentErrors so a Boulevard
  // rejection of a booking-edit mutation is logged at error level by
  // fetchBoulevardGraphQL. returnErrors is kept so the error object still flows
  // back to the caller. Return shape is unchanged.
  const data = await fetchBoulevardGraphQL(
    apiUrl,
    headers,
    query,
    variables,
    { returnErrors: true },
  );
  if (data?.__error) return { ok: false, error: data.__error, payload: null };
  const payload = data?.data?.[root] || null;
  if (!payload) return { ok: false, error: { stage: 'empty_payload' }, payload: null };
  return { ok: true, payload, error: null };
}

function buildAddonReverifyResult(reason, opportunity = null, extra = {}) {
  return {
    success: false,
    reason,
    reverified: false,
    opportunity: opportunity || null,
    ...extra,
  };
}

function isAddonGapEligible(opportunity) {
  if (!opportunity) return false;
  if (opportunity.gapUnlimited === true) return true;
  const gapMinutes = Number(opportunity.availableGapMinutes);
  return Number.isFinite(gapMinutes) && gapMinutes >= SMS_ADDON_MIN_GAP_MINUTES;
}

function getPrimaryAppointmentService(appointmentContext) {
  const appointmentServices = Array.isArray(appointmentContext?.appointmentServices)
    ? appointmentContext.appointmentServices
    : [];
  return appointmentServices.find(service => String(service?.staffId || '').trim()) || appointmentServices[0] || null;
}

async function tryApplyAddonViaBookingFromAppointment(apiUrl, headers, appointmentContext, addOnServiceId) {
  const appointmentId = String(appointmentContext?.appointmentId || '').trim();
  const targetAddonServiceId = String(addOnServiceId || '').trim();
  const providerId = String(appointmentContext?.providerId || '').trim();
  if (!appointmentId || !targetAddonServiceId || !providerId) {
    return {
      applied: false,
      reason: 'addon_booking_from_appointment_missing_fields',
    };
  }

  const bookingCreateQuery = `
    mutation BookingCreateFromAppointmentForAddon($input: BookingCreateFromAppointmentInput!) {
      bookingCreateFromAppointment(input: $input) {
        booking {
          id
          bookingClients {
            id
            clientId
          }
          bookingServices {
            id
            baseBookingServiceId
            editingAppointmentServiceId
            serviceId
            staffId
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
        appointmentId,
      },
    },
    'bookingCreateFromAppointment',
  );
  const createWarnings = toBookingWarningList(bookingCreateAttempt.payload?.bookingWarnings);
  const booking = bookingCreateAttempt.payload?.booking || null;
  const bookingId = String(booking?.id || '').trim();
  if (!bookingCreateAttempt.ok || !bookingId) {
    return {
      applied: false,
      reason: 'addon_booking_from_appointment_failed',
      error: bookingCreateAttempt.error || null,
      warnings: createWarnings,
    };
  }
  if (hasBlockingBookingWarnings(createWarnings)) {
    return {
      applied: false,
      reason: 'addon_booking_from_appointment_warning_block',
      warnings: createWarnings,
    };
  }

  const bookingClientId = String(
    booking?.bookingClients?.[0]?.id || '',
  ).trim();
  const sourcePrimaryAppointmentService = getPrimaryAppointmentService(appointmentContext);
  const sourceAppointmentServiceId = String(sourcePrimaryAppointmentService?.id || '').trim();
  const bookingServices = Array.isArray(booking?.bookingServices) ? booking.bookingServices : [];
  const baseBookingService = bookingServices.find(service =>
    !String(service?.baseBookingServiceId || '').trim() &&
    String(service?.editingAppointmentServiceId || '').trim() === sourceAppointmentServiceId,
  ) || bookingServices.find(service => !String(service?.baseBookingServiceId || '').trim()) || null;
  const baseBookingServiceId = String(baseBookingService?.id || '').trim();
  if (!bookingClientId || !baseBookingServiceId) {
    return {
      applied: false,
      reason: 'addon_booking_from_appointment_missing_booking_context',
      bookingId,
    };
  }

  const bookingAddServiceAddonQuery = `
    mutation BookingAddServiceAddonForSms($input: BookingAddServiceAddonInput!) {
      bookingAddServiceAddon(input: $input) {
        booking {
          id
        }
        bookingService {
          id
          baseBookingServiceId
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
  const addOnAttempt = await runMutationRoot(
    apiUrl,
    headers,
    bookingAddServiceAddonQuery,
    {
      input: {
        bookingId,
        bookingClientId,
        baseBookingServiceId,
        serviceId: targetAddonServiceId,
      },
    },
    'bookingAddServiceAddon',
  );
  const addOnWarnings = toBookingWarningList(addOnAttempt.payload?.bookingWarnings);
  if (!addOnAttempt.ok) {
    return {
      applied: false,
      reason: 'addon_booking_add_service_addon_failed',
      error: addOnAttempt.error || null,
      warnings: addOnWarnings,
      bookingId,
    };
  }
  if (hasBlockingBookingWarnings(addOnWarnings)) {
    return {
      applied: false,
      reason: 'addon_booking_add_service_addon_warning_block',
      warnings: addOnWarnings,
      bookingId,
    };
  }

  const bookingCompleteQuery = `
    mutation BookingCompleteForAddon($input: BookingCompleteInput!) {
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
      reason: 'addon_booking_complete_failed',
      error: bookingCompleteAttempt.error || null,
      warnings: completeWarnings,
      bookingId,
    };
  }
  if (hasBlockingBookingWarnings(completeWarnings)) {
    return {
      applied: false,
      reason: 'addon_booking_complete_warning_block',
      warnings: completeWarnings,
      bookingId,
    };
  }

  const updatedAppointmentId = String(
    (bookingCompleteAttempt.payload?.bookingAppointments || [])
      .find(item => String(item?.appointmentId || '').trim() === appointmentId)?.appointmentId ||
    bookingCompleteAttempt.payload?.bookingAppointments?.[0]?.appointmentId ||
    appointmentId,
  ).trim();

  return {
    applied: true,
    mutationRoot: 'bookingCreateFromAppointment+bookingAddServiceAddon+bookingComplete',
    updatedId: updatedAppointmentId || appointmentId,
    bookingId,
  };
}

// Non-destructive IN-PLACE duration upgrade via Boulevard's booking-edit flow
// (Fix A). Opens an editing booking over the existing appointment, edits the
// existing editing-linked service line in place (bookingServiceSetDurations to the
// target duration, bookingServiceSetPrice to the quoted total), then commits back to
// the SAME appointment id. No bookingAddService, no bookingRemoveService, no fresh
// bookingCreate, no cancelAppointment, so a second service line never exists. Every
// step targets the draft bookingId; the live appointment changes only at
// bookingComplete.
//
// The in-place edit unavoidably provokes a STAFF_DOUBLE_BOOKED warning at
// setDurations: the edit-draft transiently overlaps the source appointment it is
// editing, on the same staff/time, until bookingComplete reconciles them. That
// self-overlap is benign (proven by a supervised write-test: bookingComplete commits
// in place, same appointment id). We PROCEED past it only when an independent
// schedule read proves the window holds NO OTHER real appointment on that staff; a
// genuine collision still aborts BEFORE bookingComplete and the draft is abandoned.
async function applyDurationUpgradeViaBooking(apiUrl, headers, appointmentContext, targetServiceId, options = {}) {
  const appointmentId = String(appointmentContext?.appointmentId || '').trim();
  const targetId = String(targetServiceId || '').trim();
  const providerId = String(appointmentContext?.providerId || '').trim();
  if (!appointmentId || !targetId || !providerId) {
    return { applied: false, reason: 'duration_booking_missing_fields' };
  }

  const bookingCreateQuery = `
    mutation DurationBookingCreateFromAppointment($input: BookingCreateFromAppointmentInput!) {
      bookingCreateFromAppointment(input: $input) {
        booking {
          id
          bookingClients { id clientId }
          bookingServices { id baseBookingServiceId editingAppointmentServiceId serviceId staffId }
        }
        bookingWarnings { code message staffId serviceId bookingServiceId }
      }
    }
  `;
  const createAttempt = await runMutationRoot(
    apiUrl,
    headers,
    bookingCreateQuery,
    { input: { appointmentId } },
    'bookingCreateFromAppointment',
  );
  const createWarnings = toBookingWarningList(createAttempt.payload?.bookingWarnings);
  const booking = createAttempt.payload?.booking || null;
  const bookingId = String(booking?.id || '').trim();
  if (!createAttempt.ok || !bookingId) {
    return { applied: false, reason: 'duration_booking_create_failed', error: createAttempt.error || null, warnings: createWarnings };
  }

  // Resolve the editing-linked service line BEFORE any warning gate, so the
  // self-overlap discrimination has the exact line ids it needs to match against.
  const bookingClientId = String(booking?.bookingClients?.[0]?.id || '').trim();
  const sourcePrimary = getPrimaryAppointmentService(appointmentContext);
  const sourceAppointmentServiceId = String(sourcePrimary?.id || '').trim();
  const sourceServiceId = String(sourcePrimary?.serviceId || appointmentContext?.serviceId || '').trim();
  const bookingServices = Array.isArray(booking?.bookingServices) ? booking.bookingServices : [];
  const baseBookingService = bookingServices.find(service =>
    !String(service?.baseBookingServiceId || '').trim() &&
    String(service?.editingAppointmentServiceId || '').trim() === sourceAppointmentServiceId,
  ) || bookingServices.find(service => !String(service?.baseBookingServiceId || '').trim()) || null;
  const baseBookingServiceId = String(baseBookingService?.id || '').trim();
  if (!bookingClientId || !baseBookingServiceId) {
    return { applied: false, reason: 'duration_booking_missing_booking_context', bookingId };
  }

  const targetDuration = Math.round(Number(options?.targetDurationMinutes));
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    return { applied: false, reason: 'duration_booking_missing_target_duration', bookingId };
  }

  // Prove the staff window is clear of OTHER real appointments, recomputed FRESH on
  // each gate that sees a STAFF_DOUBLE_BOOKED. A positive (clear) result is never
  // reused across mutating gates: a collision can be booked, or first surface at
  // commit, in the gap between gates. Once a collision is proven it sticks (a real
  // conflict does not vanish). The check reuses scanAppointments (location-scoped)
  // because the eligibility gap read is client-scoped and cannot see other clients'
  // bookings on the staff. Runs only when a STAFF_DOUBLE_BOOKED is present, so the
  // clean path adds no fetch. Fails closed on any doubt.
  let collisionProven = false;
  async function selfOverlapContext() {
    let staffWindowClear;
    if (collisionProven) {
      staffWindowClear = false;
    } else {
      const currentDuration = Math.round(Number(options?.currentDurationMinutes));
      const extensionMinutes = Number.isFinite(currentDuration) && currentDuration > 0
        ? Math.max(0, targetDuration - currentDuration)
        : targetDuration; // unknown current duration -> assume the full target (wider window, safer)
      const startMs = Date.parse(appointmentContext?.startOn);
      const endMs = Date.parse(appointmentContext?.endOn);
      // The extended block occupies at least [start, start + targetDuration]. Take the
      // widest of that and (end + extension) so a booked block shorter than its
      // bucketed duration cannot shrink the checked window and hide a late collision.
      const candidateEndMs = [];
      if (Number.isFinite(startMs)) candidateEndMs.push(startMs + targetDuration * 60000);
      if (Number.isFinite(endMs)) candidateEndMs.push(endMs + extensionMinutes * 60000);
      const windowEndMs = candidateEndMs.length ? Math.max(...candidateEndMs) : NaN;
      staffWindowClear = await isStaffWindowClearOfOtherAppointments(apiUrl, headers, {
        appointmentId,
        providerId,
        locationId: appointmentContext?.locationId || null,
        startOn: appointmentContext?.startOn || null,
        windowEndOn: Number.isFinite(windowEndMs) ? new Date(windowEndMs).toISOString() : null,
      });
      if (!staffWindowClear) collisionProven = true;
    }
    return { baseBookingServiceId, sourceServiceId, providerId, staffWindowClear };
  }
  // A step's warnings block UNLESS the only blocking one is the benign self-overlap on
  // the edited line in a proven-clear window. The window read happens only when a
  // STAFF_DOUBLE_BOOKED is actually present, so the clean path adds no fetch.
  async function warningsBlock(warnings) {
    const hasStaffDoubleBooked = Array.isArray(warnings)
      && warnings.some(w => String(w?.code || '').trim().toUpperCase() === 'STAFF_DOUBLE_BOOKED');
    const context = hasStaffDoubleBooked ? await selfOverlapContext() : null;
    return hasBlockingBookingWarnings(warnings, context);
  }

  if (await warningsBlock(createWarnings)) {
    return { applied: false, reason: 'duration_booking_create_warning_block', warnings: createWarnings, bookingId };
  }

  // IN-PLACE duration extension: edit the existing editing-linked service line. No
  // bookingAddService, no bookingRemoveService, no cancelAppointment in this path.
  const setDurationsQuery = `
    mutation DurationBookingServiceSetDurations($input: BookingServiceSetDurationsInput!) {
      bookingServiceSetDurations(input: $input) {
        booking { id }
        bookingWarnings { code message staffId serviceId bookingServiceId }
      }
    }
  `;
  const durationAttempt = await runMutationRoot(
    apiUrl,
    headers,
    setDurationsQuery,
    { input: { bookingId, bookingServiceId: baseBookingServiceId, duration: targetDuration } },
    'bookingServiceSetDurations',
  );
  const durationWarnings = toBookingWarningList(durationAttempt.payload?.bookingWarnings);
  if (!durationAttempt.ok) {
    return { applied: false, reason: 'duration_booking_set_durations_failed', error: durationAttempt.error || null, warnings: durationWarnings, bookingId };
  }
  if (await warningsBlock(durationWarnings)) {
    return { applied: false, reason: 'duration_booking_set_durations_warning_block', warnings: durationWarnings, bookingId };
  }

  // Honor the quoted price on the SAME (edited) service line (owner decision
  // 2026-06-18: always charge what the offer quoted). Boulevard Money is in cents.
  const quotedTotal = Number(options?.quotedTotalDollars);
  if (Number.isFinite(quotedTotal) && quotedTotal > 0) {
    const setPriceQuery = `
      mutation DurationBookingServiceSetPrice($input: BookingServiceSetPriceInput!) {
        bookingServiceSetPrice(input: $input) {
          booking { id }
          bookingWarnings { code message staffId serviceId bookingServiceId }
        }
      }
    `;
    const priceAttempt = await runMutationRoot(
      apiUrl,
      headers,
      setPriceQuery,
      { input: { bookingId, bookingServiceId: baseBookingServiceId, price: Math.round(quotedTotal * 100) } },
      'bookingServiceSetPrice',
    );
    if (!priceAttempt.ok) {
      return { applied: false, reason: 'duration_booking_set_price_failed', error: priceAttempt.error || null, bookingId };
    }
    const priceWarnings = toBookingWarningList(priceAttempt.payload?.bookingWarnings);
    if (await warningsBlock(priceWarnings)) {
      return { applied: false, reason: 'duration_booking_set_price_warning_block', warnings: priceWarnings, bookingId };
    }
  }

  // INVARIANT GATE (safety-critical): commit ONLY if the staff window is
  // affirmatively proven clear of OTHER appointments. This runs unconditionally,
  // regardless of whether Boulevard surfaced a STAFF_DOUBLE_BOOKED warning, so the
  // proof is invariant-triggered, not warning-triggered: a real collision is blocked
  // BEFORE bookingComplete even if the provider returns no warning. selfOverlapContext
  // recomputes the window fresh here (never a stale positive). Fails closed.
  const preCommitContext = await selfOverlapContext();
  if (!preCommitContext.staffWindowClear) {
    return { applied: false, reason: 'duration_booking_staff_window_not_clear', bookingId };
  }

  // Commit the edit back to the SAME appointment. notifyClient:false: we send our
  // own confirmation SMS and must not double-notify.
  const bookingCompleteQuery = `
    mutation DurationBookingComplete($input: BookingCompleteInput!) {
      bookingComplete(input: $input) {
        booking { id }
        bookingAppointments { appointmentId clientId }
        bookingWarnings { code message staffId serviceId bookingServiceId }
      }
    }
  `;
  const completeAttempt = await runMutationRoot(
    apiUrl,
    headers,
    bookingCompleteQuery,
    { input: { bookingId, bookWithStaffId: providerId, notifyClient: false } },
    'bookingComplete',
  );
  const completeWarnings = toBookingWarningList(completeAttempt.payload?.bookingWarnings);
  if (!completeAttempt.ok) {
    return { applied: false, reason: 'duration_booking_complete_failed', error: completeAttempt.error || null, warnings: completeWarnings, bookingId };
  }
  if (await warningsBlock(completeWarnings)) {
    return { applied: false, reason: 'duration_booking_complete_warning_block', warnings: completeWarnings, bookingId };
  }

  const updatedAppointmentId = String(
    (completeAttempt.payload?.bookingAppointments || [])
      .find(item => String(item?.appointmentId || '').trim() === appointmentId)?.appointmentId ||
    completeAttempt.payload?.bookingAppointments?.[0]?.appointmentId ||
    appointmentId,
  ).trim();

  return {
    applied: true,
    mutationRoot: 'bookingCreateFromAppointment+bookingServiceSetDurations+bookingServiceSetPrice+bookingComplete',
    updatedId: updatedAppointmentId || appointmentId,
    bookingId,
  };
}

async function reverifyAndApplyUpgradeForProfile(profile, pendingOffer, options = {}) {
  if (!pendingOffer || !pendingOffer.appointmentId) return { success: false, reason: 'missing_pending_offer' };

  const offerKind = String(pendingOffer.offerKind || 'duration').trim().toLowerCase();
  const auth = getBoulevardAuthContext();
  const appointmentId = String(pendingOffer.appointmentId || '').trim();
  const appointmentContext = auth
    ? await fetchAppointmentContextById(auth.apiUrl, auth.headers, appointmentId)
    : null;

  if (offerKind === 'addon') {
    const fresh = await evaluateUpgradeOpportunityForProfile(profile, {
      now: options.now,
      windowHours: options.windowHours,
      appointmentId,
      locationId: appointmentContext?.locationId || pendingOffer?.locationId || options.locationId,
    });
    const mergedOpportunity = {
      ...(fresh || {}),
      offerKind: 'addon',
      appointmentId: fresh?.appointmentId || appointmentId || null,
      currentDurationMinutes: Number(
        fresh?.currentDurationMinutes || pendingOffer?.currentDurationMinutes || 0,
      ) || null,
      targetDurationMinutes: null,
      addOnCode: String(pendingOffer?.addOnCode || '').trim() || null,
      addOnName: String(pendingOffer?.addOnName || '').trim() || null,
      pricing: pendingOffer?.pricing || null,
      clientId: profile?.clientId || appointmentContext?.clientId || fresh?.clientId || null,
      locationId: fresh?.locationId || appointmentContext?.locationId || null,
      providerId: fresh?.providerId || appointmentContext?.providerId || null,
      startOn: fresh?.startOn || appointmentContext?.startOn || null,
      endOn: fresh?.endOn || appointmentContext?.endOn || null,
      notes: appointmentContext?.notes || null,
      appointmentServices: appointmentContext?.appointmentServices || [],
    };

    if (!appointmentContext?.appointmentId) {
      return buildAddonReverifyResult('target_appointment_not_found', mergedOpportunity);
    }
    if (mergedOpportunity.currentDurationMinutes !== 50) {
      return buildAddonReverifyResult('addon_requires_50_min_booking', mergedOpportunity);
    }
    const canAttemptWithoutGapProof = ['appointment_scan_failed', 'no_upcoming_appointment_in_window']
      .includes(String(fresh?.reason || '').trim().toLowerCase());
    if (!isAddonGapEligible(mergedOpportunity) && !canAttemptWithoutGapProof) {
      return buildAddonReverifyResult('insufficient_addon_gap', mergedOpportunity);
    }
    if (!ENABLE_UPGRADE_MUTATION) {
      return {
        success: false,
        reason: 'upgrade_mutation_disabled',
        reverified: true,
        opportunity: mergedOpportunity,
      };
    }
    if (!auth) {
      return {
        success: false,
        reason: 'boulevard_not_configured',
        reverified: true,
        opportunity: mergedOpportunity,
      };
    }
    const appointmentAlreadyContainsAddon = fresh?.hasAddonOnBooking === true
      || await appointmentAlreadyHasAddon(auth.apiUrl, auth.headers, appointmentContext);
    if (appointmentAlreadyContainsAddon) {
      return buildAddonReverifyResult('addon_already_on_booking', mergedOpportunity);
    }

    const addOnService = await resolveAddonServiceContext(auth.apiUrl, auth.headers, pendingOffer);
    if (!addOnService?.id) {
      return {
        success: false,
        reason: 'addon_service_id_not_configured',
        reverified: true,
        opportunity: mergedOpportunity,
      };
    }

    if (await appointmentAlreadyHasAddon(auth.apiUrl, auth.headers, appointmentContext, addOnService.id)) {
      return buildAddonReverifyResult('addon_already_on_booking', {
        ...mergedOpportunity,
        addOnServiceId: addOnService.id,
      });
    }

    const bookingFromAppointmentApplied = await tryApplyAddonViaBookingFromAppointment(
      auth.apiUrl,
      auth.headers,
      appointmentContext,
      addOnService.id,
    );
    if (bookingFromAppointmentApplied.applied) {
      return {
        success: true,
        reason: 'applied_addon_booking_from_appointment',
        reverified: true,
        opportunity: {
          ...mergedOpportunity,
          addOnServiceId: addOnService.id,
        },
        mutationRoot: bookingFromAppointmentApplied.mutationRoot,
        updatedAppointmentId: bookingFromAppointmentApplied.updatedId || appointmentId,
        bookingId: bookingFromAppointmentApplied.bookingId || null,
      };
    }

    return {
      success: false,
      reason: bookingFromAppointmentApplied.reason || 'addon_mutation_failed',
      reverified: true,
      opportunity: {
        ...mergedOpportunity,
        addOnServiceId: addOnService.id,
      },
    };
  }

  const fresh = await evaluateUpgradeOpportunityForProfile(profile, {
    now: options.now,
    windowHours: options.windowHours,
    appointmentId,
    targetDurationMinutes: pendingOffer.targetDurationMinutes,
    locationId: appointmentContext?.locationId || pendingOffer?.locationId || options.locationId,
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

  // Non-destructive booking-edit swap (outbound-sms #13), gated default-OFF until
  // the real-appointment dry-run signs off. When OFF, fall through to the legacy
  // path below (which fails closed to the approved manual-confirm reply, i.e.
  // today's behavior).
  if (ENABLE_BOOKING_UPGRADE) {
    const swapContext = appointmentContext?.appointmentId
      ? appointmentContext
      : await fetchAppointmentContextById(auth.apiUrl, auth.headers, fresh.appointmentId);
    if (!swapContext?.appointmentId) {
      return {
        success: false,
        reason: 'duration_booking_context_unavailable',
        reverified: true,
        opportunity: fresh,
      };
    }
    const bookingApplied = await applyDurationUpgradeViaBooking(
      auth.apiUrl,
      auth.headers,
      swapContext,
      serviceId,
      { quotedTotalDollars: Number(pendingOffer?.totalDollars) || null, targetDurationMinutes: Number(fresh.targetDurationMinutes), currentDurationMinutes: Number(fresh.currentDurationMinutes) || null },
    );
    if (!bookingApplied.applied) {
      await recordUpgradeApplyRejection('booking', fresh.appointmentId, bookingApplied.error, bookingApplied.warnings);
      return {
        success: false,
        reason: bookingApplied.reason || 'upgrade_booking_failed',
        reverified: true,
        opportunity: fresh,
        error: bookingApplied.error || null,
        warnings: bookingApplied.warnings || null,
      };
    }
    const bookingVerified = await verifyAppointmentDurationApplied(
      auth.apiUrl,
      auth.headers,
      fresh.appointmentId,
      Number(fresh.targetDurationMinutes),
      String(swapContext?.serviceId || '').trim() || null,
    );
    if (!bookingVerified) {
      return {
        success: false,
        reason: 'upgrade_verification_failed',
        reverified: true,
        opportunity: fresh,
        mutationRoot: bookingApplied.mutationRoot,
        updatedAppointmentId: bookingApplied.updatedId,
        error: bookingApplied.error || null,
        warnings: bookingApplied.warnings || null,
      };
    }
    return {
      success: true,
      reason: 'applied',
      reverified: true,
      opportunity: fresh,
      mutationRoot: bookingApplied.mutationRoot,
      updatedAppointmentId: bookingApplied.updatedId,
    };
  }

  const applied = await tryApplyAppointmentUpgradeMutation(auth.apiUrl, auth.headers, fresh.appointmentId, serviceId);
  if (!applied.applied) {
    await recordUpgradeApplyRejection('legacy', fresh.appointmentId, applied.error, null);
    return {
      success: false,
      reason: applied.reason || 'upgrade_mutation_failed',
      reverified: true,
      opportunity: fresh,
      error: applied.error || null,
    };
  }

  const verified = await verifyAppointmentServiceApplied(
    auth.apiUrl,
    auth.headers,
    fresh.appointmentId,
    serviceId,
  );
  if (!verified) {
    return {
      success: false,
      reason: 'upgrade_verification_failed',
      reverified: true,
      opportunity: fresh,
      mutationRoot: applied.mutationRoot,
      updatedAppointmentId: applied.updatedId,
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
      console.log(`Boulevard lookup: email=${maskEmailForLogs(normalizedEmail)} strategy=email_exact`);
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
          console.log(`Boulevard lookup: ${fallback.reason} fallback matches for requested name ${maskNameForLogs(name)}`);
        }
      }
    } else {
      const cleanPhone = normalizePhone(rawContact);
      if (!cleanPhone) {
        console.log('Boulevard lookup: invalid phone input');
        return null;
      }
      console.log(`Boulevard lookup: phone=${maskPhoneForLogs(cleanPhone)} strategy=phone_scan`);
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
    if (!match) {
      console.log(`Boulevard lookup: ${clients.length} clients found but none matched requested identity (${describeLookupContactForLogs(rawContact)})`);
      return null;
    }
    if (usedNameScanLocationFallback) lookupStrategy = 'name_scan_location_preferred';
    console.log(`Boulevard lookup: matched ${maskNameForLogs(`${match.node.firstName} ${match.node.lastName}`)} via ${lookupStrategy}`);
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
    // Authoritative membership signal from the lookup boundary: `membership` is
    // either a real Boulevard membership node (active or inactive) or null.
    source.hasMembership = Boolean(membership);
    return buildProfile(source);
  } catch (err) { console.error('Boulevard API error:', err.message || err); return null; }
}

// Resolve a member profile directly from a Boulevard client id, returning the
// same shape as lookupMember. The SMS discovery path builds candidates from
// scanned appointments, which already carry a verified clientId; resolving by
// that id avoids re-running a fuzzy name+email lookup, which misses on
// Boulevard's duplicate/fragmented client records (the cause of the high
// member_not_found rate). Returns null on ANY failure so callers fall back to
// lookupMember; never throws. Inert/null for ids that are not Boulevard client
// URNs (so unit-test fixtures with fake ids fall through unchanged).
async function getClientById(clientId) {
  const id = String(clientId || '').trim();
  if (!id || !/^urn:blvd:Client:/i.test(id)) return null;
  const auth = getBoulevardAuthContext();
  if (!auth) return null;
  try {
    const query = `
      query GetClientById($id: ID!) {
        client(id: $id) {
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
    `;
    const data = await fetchBoulevardGraphQL(
      auth.apiUrl,
      auth.headers,
      query,
      { id },
      { silentErrors: true, returnErrors: true },
    );
    if (!data || data.__error) return null;
    const node = data?.data?.client || null;
    // Guard against the query ignoring the filter and returning some other client.
    if (!node || String(node.id || '') !== id) return null;
    const membership = await findMembershipForClient(auth.apiUrl, auth.headers, node.id);
    const commerce = await fetchClientCommerceMetrics(auth.apiUrl, auth.headers, node);
    const preferMembershipLocation = membership && !isInactiveMembershipStatus(membership.status);
    const resolvedLocationName = preferMembershipLocation
      ? (membership?.location?.name || node?.primaryLocation?.name || null)
      : (node?.primaryLocation?.name || membership?.location?.name || null);
    const resolvedLocationId = preferMembershipLocation
      ? (membership?.location?.id || node?.primaryLocation?.id || null)
      : (node?.primaryLocation?.id || membership?.location?.id || null);
    const source = membership ? {
      ...node,
      ...(commerce || {}),
      membershipName: membership.name,
      membershipStartDate: membership.startOn,
      membershipStatus: membership.status,
      membershipTermNumber: membership.termNumber,
      nextChargeDate: membership.nextChargeDate,
      unitPrice: membership.unitPrice,
      location: resolvedLocationName,
      locationId: resolvedLocationId,
      lookupStrategy: 'client_by_id',
    } : {
      ...node,
      ...(commerce || {}),
      lookupStrategy: 'client_by_id',
    };
    // Authoritative membership signal from the lookup boundary: `membership` is
    // either a real Boulevard membership node (active or inactive) or null.
    source.hasMembership = Boolean(membership);
    return buildProfile(source);
  } catch (err) {
    return null;
  }
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
    // True only when a real Boulevard membership record was found for this
    // client (active or inactive). A matched client with zero memberships
    // (walk-in, retail buyer, lead) is NOT a member. Callers must gate the
    // cancellation flow on this so non-members are never flagged as members.
    // lookupMember/getClientById pass the authoritative `hasMembership` from
    // the lookup boundary; the field-derived fallback covers mock/synthetic
    // callers that build a profile without that flag.
    hasMembership: d.hasMembership === true || Boolean(d.membershipStatus || d.membershipStartDate || d.membershipName),
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
  const ws = wp !== null
    && isFiniteNumber(p.facialsRedeemed)
    && isFiniteNumber(p.totalDuesPaid)
    && p.totalDuesPaid > 0
    && isFiniteNumber(p.monthlyRate)
    && p.monthlyRate > 0
    ? p.facialsRedeemed * wp - p.totalDuesPaid
    : null;
  const cr = p.tier && CURRENT_RATES[p.tier] ? CURRENT_RATES[p.tier] : null;
  const rd = cr !== null && isFiniteNumber(p.monthlyRate) && p.monthlyRate > 0 ? cr - p.monthlyRate : null;
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
  const perFacialServiceDiscount = wp !== null && isFiniteNumber(p.monthlyRate) && p.monthlyRate > 0
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
    `Membership Tier: ${profile.tier ? `${profile.tier}-Minute (known)` : 'UNKNOWN, do not state tier'}`,
    `Monthly Rate: ${isFiniteNumber(profile.monthlyRate) && profile.monthlyRate > 0 ? `$${profile.monthlyRate}/month` : 'UNKNOWN, do not state monthly rate'}`,
    `Member Since: ${profile.memberSince || 'UNKNOWN, do not state join date/tenure'}`,
    `Tenure: ${isFiniteNumber(profile.tenureMonths) ? (profile.tenureMonths === 0 ? 'Less than 1 month (just joined)' : `${profile.tenureMonths} months`) : 'UNKNOWN, do not state tenure'}`,
    `Next Charge Date: ${profile.nextChargeDate || 'UNKNOWN'}`,
    `Account Status: ${profile.accountStatus || 'UNKNOWN'}`,
    `Appointment Count: ${isFiniteNumber(profile.appointmentCount) ? profile.appointmentCount : 'UNKNOWN'}`,
    '',
    `Current New-Member Rate: ${isFiniteNumber(c.currentNewMemberRate) ? `$${c.currentNewMemberRate}/month` : 'UNKNOWN'}`,
    `Rate Difference: ${isFiniteNumber(c.rateDiff) ? (c.rateDiff > 0 ? `$${c.rateDiff}/month ($${c.rateLockAnnual}/year) in grandfathered savings` : 'Rate matches current pricing') : 'UNKNOWN, do not mention rate lock savings'}`,
    `Total Membership Dues Paid: ${isFiniteNumber(profile.totalDuesPaid) ? `$${profile.totalDuesPaid}` : 'UNKNOWN'}`,
    `Total Retail Purchases: ${isFiniteNumber(profile.totalRetailPurchases) ? `$${profile.totalRetailPurchases}` : 'UNKNOWN'}`,
    `Total Add-on Purchases: ${isFiniteNumber(profile.totalAddonPurchases) ? `$${profile.totalAddonPurchases}` : 'UNKNOWN'}`,
    `Member Discount Savings: ${isFiniteNumber(c.memberDiscountSavingsTotal) ? `$${c.memberDiscountSavingsTotal}${c.discountSavingsConfidence === 'estimated_simple_20pct' ? ' (estimated as 20% of known spend)' : (c.discountSavingsConfidence === 'estimated' ? ' (estimated from known purchase totals)' : '')}` : 'UNKNOWN, do not mention total discount savings'}`,
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
    '', `Walk-in Savings: ${isFiniteNumber(c.walkinSavings) ? `$${c.walkinSavings} saved vs. walk-in pricing` : 'UNKNOWN, do not mention walk-in savings'}`,
    `Walk-in Price for Tier: ${isFiniteNumber(c.walkinPrice) ? `$${c.walkinPrice}/facial` : 'UNKNOWN'}`,
    '', `Loyalty Points: ${profile.loyaltyEnrolled === true && isFiniteNumber(profile.loyaltyPoints) ? `${profile.loyaltyPoints} points` : 'UNKNOWN, do not mention loyalty points'}`,
  ];
  // Loyalty redemption: strip the "= $XX value" retail-equivalent annotation per
  // HARD RULE - NO PERK DOLLAR VALUES. The point cost and service name are
  // operational truth; the dollar value is unverified retail-equivalent and the
  // same source-of-truth risk that motivated the static-table strip in Phase 4
  // of the decision audit (commit 5980dbc) applies here.
  if (c.loyaltyRedeemable) lines.push(`Loyalty Redeemable: ${c.loyaltyRedeemable.service} (${c.loyaltyRedeemable.points} points)`);
  if (c.loyaltyNextTier) lines.push(`Next Loyalty Tier: ${c.loyaltyNextTier.pointsNeeded} more points for ${c.loyaltyNextTier.service}`);
  lines.push('', `Unused Credits: ${isFiniteNumber(profile.unusedCredits) ? profile.unusedCredits : 'UNKNOWN'}`);
  if (profile.lastBillDate) lines.push(`Last Bill Date: ${profile.lastBillDate} (credits expire 90 days after this)`);
  lines.push('', `Perks Already Claimed: ${profile.perksClaimed.length > 0 ? profile.perksClaimed.join(', ') : 'None'}`);
  // Next perk milestone: strip the "($XX value)" annotation per HARD RULE - NO PERK
  // DOLLAR VALUES. The perk NAME and MONTH are operational truth; the dollar value
  // is unverified and the same risk that motivated the Phase 4 static-table strip
  // (commit 5980dbc) applies to the runtime-injected version. Enhancement Credit
  // dollar amounts are preserved because they live inside the perk NAME field
  // (e.g., "$50 Enhancement Credit") which IS the perk identity, not an annotation.
  // Em dashes in the perk name (from the PERK_MILESTONES source table) are
  // defensively replaced with commas so the injected profile complies with the
  // global no-em-dash rule the prompt enforces.
  if (c.nextPerk && isFiniteNumber(profile.tenureMonths)) {
    const safeName = String(c.nextPerk.name || '').replace(/\s+[–—]\s+/g, ', ');
    lines.push(`Next Perk Milestone: Month ${c.nextPerk.month}, ${safeName}`);
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
  serviceContextCache.clear();
  serviceLookupCache.clear();
}

export {
  getBoulevardAuthContext,
  lookupMember,
  getClientById,
  scanAppointments,
  fetchAppointmentContextById,
  buildAppointmentWindowQuery,
  evaluateUpgradeOpportunityForProfile,
  evaluateUpgradeEligibilityFromAppointments,
  hasBlockingBookingWarnings,
  computeCloseShiftGapMinutes,
  zonedWallClockToUtcMs,
  probeCancelRebookCapabilities,
  resolveNameScanFallbackCandidate,
  reverifyAndApplyUpgradeForProfile,
  summarizeBoulevardApplyError,
  verifyMemberIdentity,
  levenshtein,
  buildProfile,
  computeValues,
  formatProfileForPrompt,
  normalizePhone,
  normalizeBoulevardLocationId,
  canonicalizeBoulevardLocationId,
  resolveBoulevardLocationInput,
  namesLikelyMatch,
  OFFICIAL_LOCATION_REGISTRY,
  WALKIN_PRICES,
  CURRENT_RATES,
  PERKS,
  LOYALTY_TIERS,
  isInactiveMembershipStatus,
  __resetBoulevardCachesForTests,
};

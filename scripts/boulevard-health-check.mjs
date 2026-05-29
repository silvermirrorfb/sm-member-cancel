#!/usr/bin/env node
/*
 * boulevard-health-check.mjs
 * ---------------------------------------------------------------------------
 * READ-ONLY health check for the Boulevard operations the outbound-SMS upgrade
 * pipeline depends on. It answers the question the team actually cares about on
 * go-live night: "Is Boulevard not just UP, but working correctly for OUR
 * specific queries?"
 *
 * It verifies, in plain language, the four Boulevard operations Path 1 relies on:
 *   1. Auth + connectivity   (every Boulevard call uses the HMAC Basic auth)
 *   2. Client lookup          (registry seed + webhook phone/email resolution)
 *   3. Appointment scan        (scanAppointments, the path Bug 4 just hardened)
 *   4. Duration-upgrade mutation AVAILABILITY (introspection only, never fired)
 *
 * =====================  HARD GUARANTEE: READ-ONLY  =========================
 * This script issues ONLY GraphQL queries and schema introspection. It contains
 * no mutation strings, never calls updateAppointment / appointmentUpdate /
 * cancelAppointment / bookingCreate, never writes to Boulevard, never contacts a
 * real member, and never sends an SMS. Check 4 confirms the upgrade mutation
 * FIELD EXISTS in the schema; it does not execute it.
 * ===========================================================================
 *
 * Usage:
 *   node scripts/boulevard-health-check.mjs
 *   node scripts/boulevard-health-check.mjs --location "Bryant Park" --window-hours 168
 *   node scripts/boulevard-health-check.mjs --json        (machine-readable output)
 *
 * Credentials are read from .env.local at the repo root (same loader as
 * scripts/diag-sms-daily-counts.mjs). Required: BOULEVARD_API_KEY,
 * BOULEVARD_API_SECRET, BOULEVARD_BUSINESS_ID, BOULEVARD_API_URL.
 *
 * Exit code: 0 if every check PASSes, 1 if any check FAILs (so a cron/wrapper
 * can alert on non-zero).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_API_URL = 'https://dashboard.boulevard.io/api/2020-01/admin';
const TIMEOUT_MS = 15000; // matches BOULEVARD_TIMEOUT_MS in src/lib/boulevard.js

// The 10 official Silver Mirror locations (mirrors OFFICIAL_LOCATION_REGISTRY
// in src/lib/boulevard.js). Used to translate a friendly location name into the
// Boulevard URN for the appointment-scan check.
const LOCATIONS = [
  { name: 'Brickell', id: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65' },
  { name: 'Bryant Park', id: 'urn:blvd:Location:c80e43fc-22f5-4adf-b406-f50f59a85b80' },
  { name: 'Coral Gables', id: 'urn:blvd:Location:01b80da8-0b5e-440a-b18b-03afbf5686bd' },
  { name: 'Dupont Circle', id: 'urn:blvd:Location:b11142af-3d1a-4d11-8194-0c50d023fd75' },
  { name: 'Flatiron', id: 'urn:blvd:Location:9482e4e3-e33a-4e31-baa1-9d14acb6c1c8' },
  { name: 'Manhattan West', id: 'urn:blvd:Location:bee8d08c-1a4b-4d7d-bf59-94b9dcd1523f' },
  { name: 'Navy Yard', id: 'urn:blvd:Location:ce941e99-975b-4d98-9343-3139260821bb' },
  { name: 'Penn Quarter', id: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa' },
  { name: 'Upper East Side', id: 'urn:blvd:Location:5feecb61-9bcb-458a-ab42-09478386adbb' },
  { name: 'Upper West Side', id: 'urn:blvd:Location:6eab61bf-d215-4f4f-a464-6211fa802beb' },
];

// ----------------------------- env loading --------------------------------

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

loadDotEnv(path.resolve(__dirname, '../.env.local'));
loadDotEnv(path.resolve(__dirname, '../.env.production')); // optional, if pulled

// ----------------------------- args ---------------------------------------

function getArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
const JSON_MODE = process.argv.includes('--json');
const LOCATION_ARG = getArg('--location', null);
const WINDOW_HOURS = Number(getArg('--window-hours', '168')) || 168; // default 7 days

// ----------------------------- auth ----------------------------------------
// Replicated EXACTLY from generateAuthHeader / getBoulevardAuthContext in
// src/lib/boulevard.js so this check exercises the same auth the SMS code uses.

function generateAuthHeader(apiKey, apiSecret, businessId) {
  const prefix = 'blvd-admin-v1';
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${prefix}${businessId}${timestamp}`;
  const rawKey = Buffer.from(apiSecret, 'base64');
  const signature = crypto.createHmac('sha256', rawKey).update(payload, 'utf8').digest('base64');
  const token = `${signature}${payload}`;
  return Buffer.from(`${apiKey}:${token}`, 'utf8').toString('base64');
}

function getAuthContext() {
  const apiKey = process.env.BOULEVARD_API_KEY;
  const apiSecret = process.env.BOULEVARD_API_SECRET;
  const businessId = process.env.BOULEVARD_BUSINESS_ID;
  if (!apiKey || !apiSecret || !businessId) return null;
  const apiUrl = (process.env.BOULEVARD_API_URL || DEFAULT_API_URL).trim();
  const authCredentials = generateAuthHeader(apiKey, apiSecret, businessId);
  return {
    apiUrl,
    businessId,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${authCredentials}`,
      'X-Boulevard-Business-ID': businessId,
    },
  };
}

// ----------------------------- fetch ---------------------------------------
// Single GraphQL POST with timeout + latency timing + rate-limit header capture.
// This is the only network primitive in the script. It only ever POSTs a query;
// there is no code path here that builds or sends a mutation.

const RATE_LIMIT_HEADER_KEYS = [
  'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
  'x-rate-limit-limit', 'x-rate-limit-remaining', 'x-rate-limit-reset',
  'retry-after',
];

async function gqlQuery(auth, query, variables = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(auth.apiUrl, {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    const rateLimit = {};
    for (const k of RATE_LIMIT_HEADER_KEYS) {
      const v = res.headers.get(k);
      if (v !== null && v !== undefined) rateLimit[k] = v;
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      return { ok: false, stage: 'http', status: res.status, latencyMs, rateLimit, bodyPreview: bodyText.slice(0, 300) };
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      return { ok: false, stage: 'non_json', latencyMs, rateLimit, message: e.message };
    }
    if (json.errors) {
      return { ok: false, stage: 'graphql', latencyMs, rateLimit, errors: json.errors };
    }
    return { ok: true, latencyMs, rateLimit, data: json.data };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const timedOut = err && err.name === 'AbortError';
    return { ok: false, stage: timedOut ? 'timeout' : 'network', latencyMs, message: err?.message || String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

// --------------------------- introspection helpers -------------------------

async function getTypeFieldNames(auth, typeName) {
  const q = `query TypeFields($n: String!) { __type(name: $n) { name fields { name } } }`;
  const r = await gqlQuery(auth, q, { n: typeName });
  if (!r.ok || !r.data?.__type?.fields) return { fields: null, latencyMs: r.latencyMs, raw: r };
  return { fields: new Set(r.data.__type.fields.map(f => f.name)), latencyMs: r.latencyMs, raw: r };
}

function pickField(fieldSet, candidates) {
  if (!fieldSet) return null;
  for (const c of candidates) if (fieldSet.has(c)) return c;
  return null;
}

// ----------------------------- output helpers ------------------------------

const C = process.stdout.isTTY && !JSON_MODE
  ? { green: s => `\x1b[32m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` }
  : { green: s => s, red: s => s, yellow: s => s, bold: s => s, dim: s => s };

function latencyLabel(ms) {
  if (ms == null) return '';
  if (ms < 1500) return `${ms}ms`;
  if (ms < 4000) return C.yellow(`${ms}ms (slow)`);
  return C.red(`${ms}ms (VERY SLOW)`);
}

const results = [];
function record(name, pass, detail, latencyMs, extra = {}) {
  results.push({ name, pass, detail, latencyMs, ...extra });
}

// ------------------------------- checks ------------------------------------

async function check1Auth(auth) {
  // Smallest possible read: confirm auth works and the API answers. Also the
  // place we capture rate-limit headroom headers if Boulevard exposes them.
  const r = await gqlQuery(auth, `query HealthPing { __typename }`);
  if (r.ok) {
    record('1. Auth & connectivity', true, 'Boulevard answered and credentials are valid.', r.latencyMs, { rateLimit: r.rateLimit });
    return { rateLimit: r.rateLimit };
  }
  let detail;
  if (r.stage === 'http' && (r.status === 401 || r.status === 403)) {
    detail = `Auth REJECTED (HTTP ${r.status}). Check BOULEVARD_API_KEY / SECRET / BUSINESS_ID.`;
  } else if (r.stage === 'timeout') {
    detail = `Timed out after ${TIMEOUT_MS}ms. Boulevard is unreachable or overloaded.`;
  } else if (r.stage === 'http' && r.status === 429) {
    detail = `Rate limited (HTTP 429). Boulevard is throttling us right now.`;
  } else {
    detail = `Could not reach Boulevard (${r.stage}${r.status ? ' ' + r.status : ''}). ${r.message || r.bodyPreview || ''}`.trim();
  }
  record('1. Auth & connectivity', false, detail, r.latencyMs, { rateLimit: r.rateLimit });
  return { rateLimit: r.rateLimit, fatal: true };
}

async function check2ClientLookup(auth) {
  // Mirrors the clients(...) query used by findClientsByPhoneScan /
  // findClientsByNameScan in src/lib/boulevard.js. We request only ONE client
  // and report PRESENCE of fields, never the values, so no member PII is printed.
  const q = `
    query HealthClientLookup {
      clients(first: 1) {
        edges { node { id firstName lastName email mobilePhone primaryLocation { id name } } }
        pageInfo { hasNextPage }
      }
    }`;
  const r = await gqlQuery(auth, q);
  if (!r.ok) {
    record('2. Client lookup', false,
      `The clients query failed (${r.stage}${r.status ? ' ' + r.status : ''}). Member lookup (registry seed + webhook) would be broken. ${r.message || (r.errors ? JSON.stringify(r.errors).slice(0, 200) : '') || ''}`.trim(),
      r.latencyMs);
    return;
  }
  const edges = r.data?.clients?.edges || [];
  if (edges.length === 0) {
    record('2. Client lookup', true, 'Clients query works (no rows returned, but the query resolved cleanly).', r.latencyMs);
    return;
  }
  const node = edges[0]?.node || {};
  // Expected shape the SMS code relies on: id + name + email + mobilePhone.
  const hasId = Boolean(node.id);
  const hasName = Boolean(node.firstName || node.lastName);
  const hasEmailField = 'email' in node;       // field resolves (may be null for a given client)
  const hasPhoneField = 'mobilePhone' in node;  // mobilePhone, NOT phone/phoneNumber (see CLAUDE.md)
  const shapeOk = hasId && hasName && hasEmailField && hasPhoneField;
  const detail = shapeOk
    ? 'Clients query works and returns the expected shape (id, name, email, mobilePhone).'
    : `Clients query resolved but shape looks off (id:${hasId} name:${hasName} email:${hasEmailField} mobilePhone:${hasPhoneField}). The SMS code expects all four.`;
  record('2. Client lookup', shapeOk, detail, r.latencyMs);
}

async function check3AppointmentScan(auth, location) {
  // Mirrors scanAppointments in src/lib/boulevard.js: introspect the Appointment
  // type and the Query root, then run a windowed appointments read. Success =
  // the query resolves with HTTP 200 and no GraphQL errors (an empty result set
  // is still a PASS, exactly like scanAppointments' successfulEmptyStrategy).
  // A FAIL here is the equivalent of diagnostics.failure === 'appointments_query_failed'.
  const apptType = await getTypeFieldNames(auth, 'Appointment');
  if (!apptType.fields) {
    record('3. Appointment scan', false,
      'Could not introspect the Appointment type. The appointment-scan path would fail (appointment_type_introspection_failed).',
      apptType.latencyMs);
    return;
  }
  const startField = pickField(apptType.fields, ['startOn', 'startAt', 'startsAt', 'startTime', 'startDateTime', 'start']);
  const clientIdField = pickField(apptType.fields, ['clientId', 'customerId']);
  const clientObjField = pickField(apptType.fields, ['client', 'customer']);
  if (!apptType.fields.has('id') || !startField || (!clientIdField && !clientObjField)) {
    record('3. Appointment scan', false,
      `Appointment type is missing required fields (id:${apptType.fields.has('id')} start:${Boolean(startField)} client:${Boolean(clientIdField || clientObjField)}).`,
      apptType.latencyMs);
    return;
  }

  const queryType = await getTypeFieldNames(auth, 'Query');
  const rootCandidates = ['appointments', 'bookings', 'calendarAppointments'];
  const root = queryType.fields
    ? (rootCandidates.find(r => queryType.fields.has(r)) || 'appointments')
    : 'appointments';

  // Per CLAUDE.md hard rule: select BOTH the scalar clientId AND the client object.
  const clientSelection = [];
  if (clientIdField) clientSelection.push(clientIdField);
  if (clientObjField) clientSelection.push(`${clientObjField} { id firstName lastName email mobilePhone }`);
  const nodeFields = ['id', startField, ...clientSelection].join(' ');

  const startIso = new Date().toISOString().slice(0, 10);
  const endIso = new Date(Date.now() + WINDOW_HOURS * 3600 * 1000).toISOString().slice(0, 10);
  const windowClause = `startAt >= '${startIso}' AND startAt < '${endIso}'`;

  // Try the connection (edges) shape first, then the nodes shape, then a bare
  // list. These are read queries only.
  const attempts = [
    { label: 'edges+query+location', q: `query A($q:String,$loc:ID){ ${root}(first:5, query:$q, locationId:$loc){ edges { node { ${nodeFields} } } } }`, v: { q: windowClause, loc: location?.id || null } },
    { label: 'edges+query', q: `query A($q:String){ ${root}(first:5, query:$q){ edges { node { ${nodeFields} } } } }`, v: { q: windowClause } },
    { label: 'edges', q: `query A{ ${root}(first:5){ edges { node { ${nodeFields} } } } }`, v: {} },
    { label: 'nodes', q: `query A{ ${root}(first:5){ nodes { ${nodeFields} } } }`, v: {} },
    { label: 'list', q: `query A{ ${root}(first:5){ ${nodeFields} } }`, v: {} },
  ];

  let lastErr = null;
  for (const a of attempts) {
    const r = await gqlQuery(auth, a.q, a.v);
    if (r.ok) {
      const payload = r.data?.[root];
      const count = Array.isArray(payload?.edges) ? payload.edges.length
        : Array.isArray(payload?.nodes) ? payload.nodes.length
        : Array.isArray(payload) ? payload.length : 0;
      record('3. Appointment scan', true,
        `scanAppointments path works (root "${root}", shape "${a.label}"). Returned ${count} appointment(s) in the next ${WINDOW_HOURS}h${location ? ' at ' + location.name : ''}. Empty is fine; what matters is the query resolved.`,
        r.latencyMs, { root, shape: a.label, count });
      return;
    }
    lastErr = r;
    // Only fall through to the next shape on a GraphQL/validation error; a
    // timeout/429/5xx is a real outage, not a shape mismatch.
    if (r.stage !== 'graphql') break;
  }
  const e = lastErr || {};
  record('3. Appointment scan', false,
    `Appointment query failed (${e.stage}${e.status ? ' ' + e.status : ''}), equivalent to appointments_query_failed. ${e.message || (e.errors ? JSON.stringify(e.errors).slice(0, 220) : '') || ''}`.trim(),
    e.latencyMs);
}

async function check4MutationAvailability(auth) {
  // INTROSPECTION ONLY. We confirm the duration-upgrade mutation field exists in
  // the schema. We do NOT call it. This catches a schema/permission change that
  // would make a real YES fail to apply, without touching any appointment.
  const mt = await getTypeFieldNames(auth, 'Mutation');
  let fields = mt.fields;
  let latency = mt.latencyMs;
  if (!fields) {
    const alt = await getTypeFieldNames(auth, 'RootMutationType');
    fields = alt.fields;
    latency = (latency || 0) + (alt.latencyMs || 0);
  }
  if (!fields) {
    record('4. Upgrade mutation available', false,
      'Could not introspect the Mutation type. Cannot confirm the duration-upgrade mutation is reachable.',
      latency);
    return;
  }
  const upgradeField = pickField(fields, ['appointmentUpdate', 'updateAppointment']);
  if (upgradeField) {
    record('4. Upgrade mutation available', true,
      `The duration-upgrade mutation field "${upgradeField}" exists in Boulevard's schema (NOT executed, availability check only).`,
      latency, { mutationField: upgradeField });
  } else {
    record('4. Upgrade mutation available', false,
      'Neither appointmentUpdate nor updateAppointment is present in the schema. A YES reply could not apply the upgrade.',
      latency);
  }
}

// ----------------------------- runner --------------------------------------

async function main() {
  const auth = getAuthContext();
  if (!auth) {
    const msg = 'Boulevard credentials are not configured. Set BOULEVARD_API_KEY, BOULEVARD_API_SECRET, and BOULEVARD_BUSINESS_ID in .env.local.';
    if (JSON_MODE) console.log(JSON.stringify({ ok: false, error: 'boulevard_not_configured' }, null, 2));
    else console.error(C.red('FAIL: ') + msg);
    process.exit(1);
  }

  let location = null;
  if (LOCATION_ARG) {
    location = LOCATIONS.find(l => l.name.toLowerCase() === LOCATION_ARG.toLowerCase()) || null;
  }
  if (!location) {
    const envLocs = String(process.env.SMS_CRON_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (envLocs.length) location = LOCATIONS.find(l => l.name.toLowerCase() === envLocs[0].toLowerCase()) || null;
  }
  if (!location) location = LOCATIONS.find(l => l.name === 'Bryant Park') || LOCATIONS[0];

  const ctx = await check1Auth(auth);
  if (ctx.fatal) {
    // Auth/connectivity is dead, the other checks would all fail with the same
    // root cause, so report and stop here.
    finish(ctx.rateLimit, location);
    return;
  }
  await check2ClientLookup(auth);
  await check3AppointmentScan(auth, location);
  await check4MutationAvailability(auth);
  finish(ctx.rateLimit, location);
}

function finish(rateLimit, location) {
  const allPass = results.every(r => r.pass);
  const totalLatency = results.reduce((s, r) => s + (r.latencyMs || 0), 0);

  if (JSON_MODE) {
    console.log(JSON.stringify({
      ok: allPass,
      timestamp: new Date().toISOString(),
      location: location?.name || null,
      windowHours: WINDOW_HOURS,
      totalLatencyMs: totalLatency,
      rateLimit: rateLimit && Object.keys(rateLimit).length ? rateLimit : null,
      checks: results,
    }, null, 2));
    process.exit(allPass ? 0 : 1);
  }

  console.log('');
  console.log(C.bold('  Boulevard health check') + C.dim(`  (${new Date().toLocaleString()})`));
  console.log(C.dim(`  Appointment-scan location: ${location?.name || 'n/a'} | window: next ${WINDOW_HOURS}h`));
  console.log(C.dim('  ' + '-'.repeat(70)));
  for (const r of results) {
    const tag = r.pass ? C.green('PASS') : C.red('FAIL');
    const lat = r.latencyMs != null ? C.dim('  ' + latencyLabel(r.latencyMs)) : '';
    console.log(`  ${tag}  ${C.bold(r.name)}${lat}`);
    console.log(`        ${r.detail}`);
  }
  console.log(C.dim('  ' + '-'.repeat(70)));

  if (rateLimit && Object.keys(rateLimit).length) {
    const remaining = rateLimit['ratelimit-remaining'] || rateLimit['x-ratelimit-remaining'] || rateLimit['x-rate-limit-remaining'];
    const limit = rateLimit['ratelimit-limit'] || rateLimit['x-ratelimit-limit'] || rateLimit['x-rate-limit-limit'];
    console.log(`  Rate-limit headroom: ${remaining != null ? remaining : '?'}${limit ? ' / ' + limit : ''} remaining ` + C.dim(JSON.stringify(rateLimit)));
  } else {
    console.log(C.dim('  Rate-limit headroom: Boulevard did not return rate-limit headers on these calls.'));
  }
  console.log(`  Total Boulevard time this run: ${latencyLabel(totalLatency)}`);
  console.log('');
  if (allPass) {
    console.log('  ' + C.green(C.bold('HEALTHY')) + ', every Boulevard operation the SMS upgrade flow needs is working.');
  } else {
    const failed = results.filter(r => !r.pass).map(r => r.name).join(', ');
    console.log('  ' + C.red(C.bold('UNHEALTHY')) + `, failing: ${failed}.`);
    console.log('  ' + C.yellow('Do not treat the SMS pipeline as trustworthy until this is green. See docs/TEAM_MONITORING_sms-upgrades.md.'));
  }
  console.log('');
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error(C.red('Health check crashed: ') + (err?.stack || err?.message || String(err)));
  process.exit(1);
});

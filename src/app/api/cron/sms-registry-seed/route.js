export const maxDuration = 300;

import { NextResponse } from 'next/server';
import {
  canonicalizeBoulevardLocationId,
  getBoulevardAuthContext,
  normalizePhone,
  resolveBoulevardLocationInput,
} from '../../../../lib/boulevard';
import { registerMember } from '../../../../lib/sms-member-registry';

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

const CLIENTS_QUERY = `
  query SeedRegistryClients($first: Int!, $after: String) {
    clients(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id firstName lastName email mobilePhone active
          primaryLocation { id name }
        }
      }
    }
  }
`;

function isCronAuthorized(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const authHeader = String(request.headers.get('authorization') || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim() === secret;
  }
  return false;
}

export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const enabled = String(process.env.SMS_CRON_ENABLED || '').toLowerCase();
  if (enabled !== 'true' && enabled !== '1') {
    return NextResponse.json({ ok: true, skipped: 'SMS_CRON_ENABLED is false' });
  }

  const locationsRaw = String(process.env.SMS_CRON_LOCATIONS || '').trim();
  if (!locationsRaw) {
    return NextResponse.json({ ok: true, skipped: 'no_locations' });
  }

  const targetLocations = new Map();
  for (const name of locationsRaw.split(',').map(s => s.trim()).filter(Boolean)) {
    const resolved = resolveBoulevardLocationInput(name);
    const canonId = canonicalizeBoulevardLocationId(resolved.locationId || '');
    if (canonId) targetLocations.set(canonId, resolved.locationName || name);
  }
  if (targetLocations.size === 0) {
    return NextResponse.json({ ok: true, skipped: 'no_valid_locations' });
  }

  const auth = getBoulevardAuthContext();
  if (!auth) {
    return NextResponse.json({ error: 'Boulevard not configured' }, { status: 500 });
  }

  let after = null;
  let pageCount = 0;
  let scanned = 0;
  let registered = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    pageCount++;

    let payload = null;
    try {
      const response = await fetch(auth.apiUrl, {
        method: 'POST',
        headers: auth.headers,
        body: JSON.stringify({ query: CLIENTS_QUERY, variables: { first: PAGE_SIZE, after } }),
      });
      if (!response.ok) {
        return NextResponse.json({
          error: `Boulevard HTTP ${response.status}`,
          pageCount, scanned, registered,
        }, { status: 502 });
      }
      payload = await response.json();
    } catch (err) {
      return NextResponse.json({
        error: `Boulevard fetch failed: ${err.message}`,
        pageCount, scanned, registered,
      }, { status: 502 });
    }

    if (payload?.errors?.length) {
      return NextResponse.json({
        error: 'Boulevard GraphQL error',
        details: payload.errors[0]?.message || 'unknown',
        pageCount, scanned, registered,
      }, { status: 502 });
    }

    const connection = payload?.data?.clients;
    const edges = connection?.edges || [];
    scanned += edges.length;

    for (const edge of edges) {
      const node = edge?.node;
      if (!node?.active) continue;

      const phone = normalizePhone(node.mobilePhone || '');
      if (!phone || phone.length < 11) continue;

      const clientLocId = canonicalizeBoulevardLocationId(node.primaryLocation?.id || '');
      if (!clientLocId || !targetLocations.has(clientLocId)) continue;

      const success = await registerMember(clientLocId, {
        clientId: node.id,
        firstName: node.firstName || '',
        lastName: node.lastName || '',
        email: (node.email || '').toLowerCase(),
        phone,
        locationName: targetLocations.get(clientLocId),
      });
      if (success) registered++;
    }

    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection?.pageInfo?.endCursor || null;
    if (!after) break;

    console.log(`[sms-seed] Page ${pageCount}: scanned ${scanned}, registered ${registered}`);
  }

  console.log(`[sms-seed] Done: ${pageCount} pages, ${scanned} scanned, ${registered} registered at ${[...targetLocations.values()].join(', ')}`);

  return NextResponse.json({
    ok: true,
    pageCount,
    scanned,
    registered,
    locations: Object.fromEntries(targetLocations),
  });
}

import { NextResponse } from 'next/server';
import {
  canonicalizeBoulevardLocationId,
  getBoulevardAuthContext,
  normalizePhone,
  resolveBoulevardLocationInput,
} from '../../../../lib/boulevard';
import { getNextWindowStartIso, isWithinSendWindow } from '../../../../lib/sms-window';

const PAGE_SIZE = Number(process.env.SMS_CRON_PAGE_SIZE || 100);
const MAX_PAGES = Number(process.env.SMS_CRON_MAX_PAGES || 5);
const SEND_TIMEZONE = process.env.SMS_SEND_TIMEZONE || 'America/New_York';
const SEND_START_HOUR = Number(process.env.SMS_CRON_SEND_START_HOUR || 9);
const SEND_END_HOUR = Number(process.env.SMS_CRON_SEND_END_HOUR || 19);

const CLIENTS_QUERY = `
  query SmsCronClients($first: Int!, $after: String) {
    clients(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          firstName
          lastName
          email
          mobilePhone
          active
          primaryLocation {
            id
            name
          }
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
  const fallbackHeader = String(request.headers.get('x-cron-secret') || '').trim();
  return fallbackHeader === secret;
}

function parseEnabledFlag() {
  const raw = String(process.env.SMS_CRON_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function parseTargetLocationIds() {
  const raw = String(process.env.SMS_CRON_LOCATIONS || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map(entry => {
        const resolved = resolveBoulevardLocationInput(entry);
        return resolved.canonicalId || resolved.locationId;
      })
      .filter(Boolean)
      .map(id => canonicalizeBoulevardLocationId(id))
      .filter(Boolean),
  );
}

async function fetchBoulevardGraphQL(auth, query, variables) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${auth.apiUrl}`, {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return { error: `Boulevard HTTP ${response.status}`, payload };
    }
    if (payload?.errors?.length) {
      return { error: 'Boulevard GraphQL errors', payload };
    }
    return { data: payload?.data || null };
  } catch (error) {
    return { error: error?.message || 'Boulevard request failed' };
  } finally {
    clearTimeout(timeout);
  }
}

function toCandidate(node) {
  const phone = normalizePhone(node?.mobilePhone || '');
  if (!phone || phone.length < 11) return null;
  return {
    clientId: String(node?.id || ''),
    firstName: String(node?.firstName || '').trim(),
    lastName: String(node?.lastName || '').trim(),
    email: String(node?.email || '').trim().toLowerCase(),
    phone,
    locationId: String(node?.primaryLocation?.id || '').trim(),
    locationName: String(node?.primaryLocation?.name || '').trim(),
  };
}

export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized cron request.' }, { status: 401 });
  }

  if (!parseEnabledFlag()) {
    return NextResponse.json({ ok: true, skipped: 'SMS_CRON_ENABLED is false' });
  }

  const window = isWithinSendWindow(new Date().toISOString(), {
    timeZone: SEND_TIMEZONE,
    startHour: SEND_START_HOUR,
    endHour: SEND_END_HOUR,
  });
  if (!window.allowed) {
    return NextResponse.json({
      ok: true,
      skipped: 'Outside configured send window',
      sendWindow: window,
      nextWindowStartIso: getNextWindowStartIso(new Date().toISOString(), {
        timeZone: SEND_TIMEZONE,
        startHour: SEND_START_HOUR,
        endHour: SEND_END_HOUR,
      }),
    });
  }

  const auth = getBoulevardAuthContext();
  if (!auth) {
    return NextResponse.json({ error: 'Boulevard auth is not configured.' }, { status: 500 });
  }

  const targetLocationIds = parseTargetLocationIds();
  if (targetLocationIds.size === 0) {
    return NextResponse.json({ error: 'SMS_CRON_LOCATIONS is empty or invalid.' }, { status: 400 });
  }

  const candidates = [];
  let after = null;
  let pageCount = 0;
  let scannedClients = 0;

  while (pageCount < MAX_PAGES) {
    pageCount += 1;
    const result = await fetchBoulevardGraphQL(auth, CLIENTS_QUERY, {
      first: PAGE_SIZE,
      after,
    });
    if (result.error) {
      return NextResponse.json({
        error: 'Failed while scanning Boulevard clients.',
        details: result.error,
        pageCount,
      }, { status: 502 });
    }

    const connection = result.data?.clients;
    const edges = Array.isArray(connection?.edges) ? connection.edges : [];
    scannedClients += edges.length;

    for (const edge of edges) {
      const node = edge?.node;
      if (!node?.active) continue;
      const locationCanonicalId = canonicalizeBoulevardLocationId(node?.primaryLocation?.id || '');
      if (!locationCanonicalId || !targetLocationIds.has(locationCanonicalId)) continue;
      const candidate = toCandidate(node);
      if (!candidate) continue;
      candidates.push(candidate);
    }

    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection?.pageInfo?.endCursor || null;
    if (!after) break;
  }

  const endpoint = new URL('/api/sms/automation/pre-appointment', request.url);
  const automationToken = String(process.env.SMS_AUTOMATION_TOKEN || '').trim();
  const automationResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(automationToken ? { 'x-automation-token': automationToken } : {}),
    },
    body: JSON.stringify({
      dryRun: false,
      candidates,
      trigger: 'vercel-cron-sms-upgrade-scan',
      now: new Date().toISOString(),
    }),
    cache: 'no-store',
  });

  const automationPayload = await automationResponse.json().catch(() => ({}));
  if (!automationResponse.ok) {
    return NextResponse.json({
      error: 'pre-appointment automation invocation failed',
      status: automationResponse.status,
      scannedClients,
      candidateCount: candidates.length,
      automationPayload,
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    scannedClients,
    candidateCount: candidates.length,
    pageCount,
    automationPayload,
  });
}

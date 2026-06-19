import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanAppointments, evaluateUpgradeEligibilityFromAppointments, fetchAppointmentContextById, __resetBoulevardCachesForTests } from '../src/lib/boulevard.js';

// Introspection results are memoized at module scope, so a prior test that saw
// an Appointment type WITH cancelled would otherwise leak that into a later test
// that mocks a schema WITHOUT it. Reset before every test.
beforeEach(() => { __resetBoulevardCachesForTests(); });

// PR-B regression coverage. Boulevard's Appointment type has no canceledAt /
// cancelledAt field (so the canceledAt branch of cancellation detection is dead)
// but it does expose a `cancelled` boolean. Before this fix, scanAppointments
// never selected that boolean, so cancelled rows survived the scan and the cron
// discovery path turned them into outbound-SMS candidates. The scan must now
// select the boolean, map it on every row, and drop cancelled rows at the source
// so every consumer (cron discovery, pre-appointment discovery, eligibility,
// reverify) inherits the guard.

const APPOINTMENT_TYPE = {
  fields: [
    { name: 'id' },
    { name: 'startAt' },
    { name: 'endAt' },
    { name: 'clientId' },
    { name: 'client' },
    { name: 'locationId' },
    { name: 'state' },
    { name: 'cancelled' },
  ].map(f => ({ ...f, type: { kind: 'SCALAR', name: 'String', ofType: null } })),
};

const QUERY_TYPE = {
  name: 'Query',
  fields: [
    {
      name: 'appointments',
      type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null },
      args: [
        { name: 'first',      type: { kind: 'SCALAR', name: 'Int',         ofType: null } },
        { name: 'after',      type: { kind: 'SCALAR', name: 'String',      ofType: null } },
        { name: 'query',      type: { kind: 'SCALAR', name: 'QueryString', ofType: null } },
        { name: 'locationId', type: { kind: 'SCALAR', name: 'ID',          ofType: null } },
      ],
    },
  ],
};

const APPT_CONN_TYPE = {
  name: 'AppointmentConnection',
  fields: [
    { name: 'edges',    type: { kind: 'OBJECT', name: 'AppointmentEdge', ofType: null } },
    { name: 'pageInfo', type: { kind: 'OBJECT', name: 'PageInfo',        ofType: null } },
  ],
};

const CLIENT_TYPE = {
  fields: [{ name: 'id' }, { name: 'firstName' }, { name: 'lastName' }, { name: 'email' }, { name: 'mobilePhone' }],
};

function apptNode(overrides = {}) {
  return {
    id: 'urn:blvd:Appointment:1',
    startAt: '2026-05-04T10:00:00-04:00',
    endAt: '2026-05-04T10:50:00-04:00',
    clientId: 'urn:blvd:Client:abc',
    client: {
      id: 'urn:blvd:Client:abc',
      firstName: 'Yan',
      lastName: 'Wu',
      email: 'helloyan.w@gmail.com',
      mobilePhone: '+16465958577',
    },
    locationId: 'urn:blvd:Location:bp',
    state: 'BOOKED',
    ...overrides,
  };
}

function mockGraphQL({ nodes, capturedQueries }) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const q = String(body.query || '');
    const variables = body.variables || {};
    capturedQueries.push(q);

    if (q.includes('__schema')) {
      return new Response(JSON.stringify({ data: { __schema: { queryType: { name: 'Query' } } } }), { status: 200 });
    }
    if (q.includes('__type')) {
      const types = {
        Appointment: APPOINTMENT_TYPE,
        Query: QUERY_TYPE,
        AppointmentConnection: APPT_CONN_TYPE,
        Client: CLIENT_TYPE,
      };
      const t = variables.typeName ? types[variables.typeName] : null;
      if (!t) return new Response(JSON.stringify({ data: { __type: null } }), { status: 200 });
      return new Response(JSON.stringify({ data: { __type: t } }), { status: 200 });
    }
    if (/\bappointments\s*\(/.test(q)) {
      return new Response(JSON.stringify({
        data: {
          appointments: {
            edges: nodes.map((node, i) => ({ cursor: `c${i}`, node })),
            pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
          },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  };
}

async function runScan(nodes) {
  const capturedQueries = [];
  global.fetch = vi.fn(mockGraphQL({ nodes, capturedQueries }));
  const result = await scanAppointments('https://example/api', { 'x-business-id': 'b' }, {
    locationId: 'urn:blvd:Location:bp',
    windowStart: new Date('2026-05-04T00:00:00Z'),
    windowEnd: new Date('2026-05-05T00:00:00Z'),
  });
  const apptQuery = capturedQueries.find(q => /appointments\s*\(/.test(q) && !/__type|__schema/.test(q));
  return { result, apptQuery };
}

describe('scanAppointments — cancelled appointment exclusion', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('selects the cancelled boolean field in the scan query when it exists on Appointment', async () => {
    const { apptQuery } = await runScan([apptNode({ cancelled: false })]);
    expect(apptQuery).toBeTruthy();
    expect(apptQuery).toMatch(/\bcancelled\b/);
  });

  it('excludes a cancelled row from the returned appointments (cancelled row never becomes a candidate)', async () => {
    const { result } = await runScan([apptNode({ id: 'urn:blvd:Appointment:cx', cancelled: true })]);
    expect(result.appointments).toEqual([]);
  });

  it('with mixed cancelled and live rows, returns only the live rows', async () => {
    const { result } = await runScan([
      apptNode({ id: 'urn:blvd:Appointment:live', cancelled: false }),
      apptNode({ id: 'urn:blvd:Appointment:dead', cancelled: true }),
    ]);
    expect(result.appointments).toHaveLength(1);
    expect(result.appointments[0].id).toBe('urn:blvd:Appointment:live');
    expect(result.appointments[0].cancelled).toBe(false);
  });

  it('with all rows cancelled, returns zero appointments so downstream skip reason stays no_appointments_available', async () => {
    const { result } = await runScan([
      apptNode({ id: 'urn:blvd:Appointment:d1', cancelled: true }),
      apptNode({ id: 'urn:blvd:Appointment:d2', cancelled: true }),
    ]);
    expect(result.appointments).toEqual([]);
    const elig = evaluateUpgradeEligibilityFromAppointments(result.appointments, { clientId: 'urn:blvd:Client:abc' });
    expect(elig).toEqual({ eligible: false, reason: 'no_appointments_available' });
  });

  it('normalizer maps cancelled false to false and a missing cancelled field to null', async () => {
    const liveFalse = await runScan([apptNode({ id: 'urn:blvd:Appointment:f', cancelled: false })]);
    expect(liveFalse.result.appointments[0].cancelled).toBe(false);

    // When Boulevard omits the boolean on a row, the normalizer records null, not a crash.
    const liveMissing = await runScan([apptNode({ id: 'urn:blvd:Appointment:m', cancelled: undefined })]);
    expect(liveMissing.result.appointments[0].cancelled).toBeNull();

    // When the field is selected but Boulevard returns an explicit JSON null,
    // the normalizer maps null (not false) and the row survives (null is not cancelled).
    const liveNull = await runScan([apptNode({ id: 'urn:blvd:Appointment:n', cancelled: null })]);
    expect(liveNull.result.appointments).toHaveLength(1);
    expect(liveNull.result.appointments[0].cancelled).toBeNull();
  });
});

describe('evaluateUpgradeEligibilityFromAppointments — cancelled boolean is honored', () => {
  const profile = { clientId: 'urn:blvd:Client:abc', hasMembership: false, tier: null };
  const now = new Date('2026-05-04T08:00:00-04:00');

  function row(overrides = {}) {
    return {
      id: 'urn:blvd:Appointment:e1',
      clientId: 'urn:blvd:Client:abc',
      startOn: '2026-05-04T10:00:00-04:00',
      endOn: '2026-05-04T10:30:00-04:00',
      providerId: 'urn:blvd:Staff:s1',
      locationId: 'urn:blvd:Location:bp',
      status: 'BOOKED',
      canceledAt: null,
      cancelled: false,
      ...overrides,
    };
  }

  it('excludes an otherwise-eligible upcoming row when cancelled is true, even though state is not in the cancel set', () => {
    const result = evaluateUpgradeEligibilityFromAppointments([row({ cancelled: true })], profile, { now });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('no_upcoming_appointment_in_window');
  });

  it('keeps a live (cancelled false) upcoming 30-minute row as eligible', () => {
    // A bounding next commitment (25 min after the block ends) makes the 30->50
    // gap provably sufficient, so this isolates the cancelled filter (the live
    // row is not dropped) rather than the gap math.
    const result = evaluateUpgradeEligibilityFromAppointments([
      row({ cancelled: false }),
      row({ id: 'urn:blvd:Appointment:next', clientId: 'other', startOn: '2026-05-04T10:55:00-04:00', endOn: '2026-05-04T11:25:00-04:00' }),
    ], profile, { now });
    expect(result.eligible).toBe(true);
  });
});

describe('scanAppointments — schema-absent and pagination safety', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('omits the cancelled field from the query when Appointment has no cancelled boolean, and still returns the live row', async () => {
    const APPT_TYPE_NO_CANCELLED = {
      fields: [
        { name: 'id' }, { name: 'startAt' }, { name: 'endAt' },
        { name: 'clientId' }, { name: 'client' }, { name: 'locationId' }, { name: 'state' },
      ].map(f => ({ ...f, type: { kind: 'SCALAR', name: 'String', ofType: null } })),
    };
    const capturedQueries = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const q = String(body.query || '');
      const variables = body.variables || {};
      capturedQueries.push(q);
      if (q.includes('__schema')) {
        return new Response(JSON.stringify({ data: { __schema: { queryType: { name: 'Query' } } } }), { status: 200 });
      }
      if (q.includes('__type')) {
        const types = { Appointment: APPT_TYPE_NO_CANCELLED, Query: QUERY_TYPE, AppointmentConnection: APPT_CONN_TYPE, Client: CLIENT_TYPE };
        const t = variables.typeName ? types[variables.typeName] : null;
        return new Response(JSON.stringify({ data: { __type: t || null } }), { status: 200 });
      }
      if (/\bappointments\s*\(/.test(q)) {
        return new Response(JSON.stringify({
          data: { appointments: { edges: [{ cursor: 'c0', node: apptNode({ id: 'urn:blvd:Appointment:live' }) }], pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const result = await scanAppointments('https://example/api', { 'x-business-id': 'b' }, {
      locationId: 'urn:blvd:Location:bp',
      windowStart: new Date('2026-05-04T00:00:00Z'),
      windowEnd: new Date('2026-05-05T00:00:00Z'),
    });
    const apptQuery = capturedQueries.find(q => /appointments\s*\(/.test(q) && !/__type|__schema/.test(q));
    expect(apptQuery).not.toMatch(/\bcancelled\b/);
    expect(result.appointments).toHaveLength(1);
    expect(result.appointments[0].cancelled).toBeNull();
  });

  it('advances past an all-cancelled first page to return a live row on the next page', async () => {
    const capturedQueries = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const q = String(body.query || '');
      const variables = body.variables || {};
      capturedQueries.push(q);
      if (q.includes('__schema')) {
        return new Response(JSON.stringify({ data: { __schema: { queryType: { name: 'Query' } } } }), { status: 200 });
      }
      if (q.includes('__type')) {
        const types = { Appointment: APPOINTMENT_TYPE, Query: QUERY_TYPE, AppointmentConnection: APPT_CONN_TYPE, Client: CLIENT_TYPE };
        const t = variables.typeName ? types[variables.typeName] : null;
        return new Response(JSON.stringify({ data: { __type: t || null } }), { status: 200 });
      }
      if (/\bappointments\s*\(/.test(q)) {
        // Page 1 (no after cursor): all cancelled, but more pages remain.
        if (!variables.after) {
          return new Response(JSON.stringify({
            data: { appointments: {
              edges: [
                { cursor: 'p1a', node: apptNode({ id: 'urn:blvd:Appointment:d1', cancelled: true }) },
                { cursor: 'p1b', node: apptNode({ id: 'urn:blvd:Appointment:d2', cancelled: true }) },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'cur1', hasPreviousPage: false, startCursor: 'p1a' },
            } },
          }), { status: 200 });
        }
        // Page 2 (after=cur1): one live row.
        return new Response(JSON.stringify({
          data: { appointments: {
            edges: [{ cursor: 'p2a', node: apptNode({ id: 'urn:blvd:Appointment:live', cancelled: false }) }],
            pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: true, startCursor: 'p2a' },
          } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const result = await scanAppointments('https://example/api', { 'x-business-id': 'b' }, {
      locationId: 'urn:blvd:Location:bp',
      windowStart: new Date('2026-05-04T00:00:00Z'),
      windowEnd: new Date('2026-05-05T00:00:00Z'),
    });
    expect(result.appointments).toHaveLength(1);
    expect(result.appointments[0].id).toBe('urn:blvd:Appointment:live');
  });
});

describe('fetchAppointmentContextById — cancelled target fails closed', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  function mockContext({ apptResponse, types }) {
    return async (_url, init) => {
      const body = JSON.parse(init.body);
      const q = String(body.query || '');
      const variables = body.variables || {};
      if (q.includes('__type')) {
        const t = variables.typeName ? types[variables.typeName] : null;
        return new Response(JSON.stringify({ data: { __type: t || null } }), { status: 200 });
      }
      if (/appointment\s*\(\s*id:/.test(q)) {
        return new Response(JSON.stringify({ data: { appointment: apptResponse, __query: q } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    };
  }

  it('returns null when the fetched appointment is cancelled', async () => {
    global.fetch = vi.fn(mockContext({
      types: { Appointment: APPOINTMENT_TYPE },
      apptResponse: {
        id: 'urn:blvd:Appointment:cx', clientId: 'urn:blvd:Client:abc',
        locationId: 'urn:blvd:Location:bp', startAt: '2026-05-04T10:00:00-04:00', endAt: '2026-05-04T10:30:00-04:00',
        cancelled: true, appointmentServices: [{ id: 's1', serviceId: 'svc1', staffId: 'st1' }],
      },
    }));
    const ctx = await fetchAppointmentContextById('https://example/api', { 'x-business-id': 'b' }, 'urn:blvd:Appointment:cx');
    expect(ctx).toBeNull();
  });

  it('returns the context for a live (cancelled false) appointment', async () => {
    global.fetch = vi.fn(mockContext({
      types: { Appointment: APPOINTMENT_TYPE },
      apptResponse: {
        id: 'urn:blvd:Appointment:ok', clientId: 'urn:blvd:Client:abc',
        locationId: 'urn:blvd:Location:bp', startAt: '2026-05-04T10:00:00-04:00', endAt: '2026-05-04T10:30:00-04:00',
        cancelled: false, appointmentServices: [{ id: 's1', serviceId: 'svc1', staffId: 'st1' }],
      },
    }));
    const ctx = await fetchAppointmentContextById('https://example/api', { 'x-business-id': 'b' }, 'urn:blvd:Appointment:ok');
    expect(ctx).not.toBeNull();
    expect(ctx.appointmentId).toBe('urn:blvd:Appointment:ok');
    expect(ctx.providerId).toBe('st1');
  });

  it('returns the context when the cancelled field is selected but the value is null (permissive on null, fail-closed only on true)', async () => {
    global.fetch = vi.fn(mockContext({
      types: { Appointment: APPOINTMENT_TYPE },
      apptResponse: {
        id: 'urn:blvd:Appointment:nul', clientId: 'urn:blvd:Client:abc',
        locationId: 'urn:blvd:Location:bp', startAt: '2026-05-04T10:00:00-04:00', endAt: '2026-05-04T10:30:00-04:00',
        cancelled: null, appointmentServices: [{ id: 's1', serviceId: 'svc1', staffId: 'st1' }],
      },
    }));
    const ctx = await fetchAppointmentContextById('https://example/api', { 'x-business-id': 'b' }, 'urn:blvd:Appointment:nul');
    expect(ctx).not.toBeNull();
    expect(ctx.appointmentId).toBe('urn:blvd:Appointment:nul');
  });

  it('omits the cancelled selection and still returns context when Appointment lacks the field', async () => {
    const APPT_TYPE_NO_CANCELLED = {
      fields: [
        { name: 'id' }, { name: 'clientId' }, { name: 'locationId' },
        { name: 'startAt' }, { name: 'endAt' }, { name: 'appointmentServices' },
      ].map(f => ({ ...f, type: { kind: 'SCALAR', name: 'String', ofType: null } })),
    };
    let capturedContextQuery = '';
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const q = String(body.query || '');
      const variables = body.variables || {};
      if (q.includes('__type')) {
        const t = variables.typeName ? { Appointment: APPT_TYPE_NO_CANCELLED }[variables.typeName] : null;
        return new Response(JSON.stringify({ data: { __type: t || null } }), { status: 200 });
      }
      if (/appointment\s*\(\s*id:/.test(q)) {
        capturedContextQuery = q;
        return new Response(JSON.stringify({ data: { appointment: {
          id: 'urn:blvd:Appointment:ok', clientId: 'urn:blvd:Client:abc',
          locationId: 'urn:blvd:Location:bp', startAt: '2026-05-04T10:00:00-04:00', endAt: '2026-05-04T10:30:00-04:00',
          appointmentServices: [{ id: 's1', serviceId: 'svc1', staffId: 'st1' }],
        } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const ctx = await fetchAppointmentContextById('https://example/api', { 'x-business-id': 'b' }, 'urn:blvd:Appointment:ok');
    expect(capturedContextQuery).not.toMatch(/\bcancelled\b/);
    expect(ctx).not.toBeNull();
    expect(ctx.appointmentId).toBe('urn:blvd:Appointment:ok');
  });
});

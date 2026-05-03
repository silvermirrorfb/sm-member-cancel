import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanAppointments } from '../src/lib/boulevard.js';

// Regression test for the discovery-mode outage. When Boulevard's Appointment type
// exposes both a scalar `clientId` field and a nested `client` object field, the
// GraphQL selection must include BOTH so that downstream code can read
// clientFirstName/clientLastName/clientEmail/clientPhone. Selecting only the scalar
// returned null contact info and silently filtered every candidate out of the
// locations[] discovery path in /api/sms/automation/pre-appointment, producing
// zero outbound texts.

const APPOINTMENT_TYPE = {
  fields: [
    { name: 'id' },
    { name: 'startAt' },
    { name: 'endAt' },
    { name: 'clientId' },
    { name: 'client' },
    { name: 'locationId' },
    { name: 'state' },
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

function mockGraphQLResponse({ types, appointmentEdge, capturedQueries }) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const q = String(body.query || '');
    const variables = body.variables || {};
    capturedQueries.push(q);

    // Schema query type lookup (returns the root Query type name).
    if (q.includes('__schema')) {
      return new Response(JSON.stringify({ data: { __schema: { queryType: { name: 'Query' } } } }), { status: 200 });
    }

    // Type introspection: name is passed via $typeName variable in real code.
    if (q.includes('__type')) {
      const typeName = variables.typeName;
      const t = typeName ? types[typeName] : null;
      if (!t) return new Response(JSON.stringify({ data: { __type: null } }), { status: 200 });
      return new Response(JSON.stringify({ data: { __type: t } }), { status: 200 });
    }

    // Actual appointments query.
    if (/\bappointments\s*\(/.test(q)) {
      return new Response(JSON.stringify({
        data: {
          appointments: {
            edges: appointmentEdge ? [{ cursor: 'c1', node: appointmentEdge }] : [],
            pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
          },
        },
      }), { status: 200 });
    }

    return new Response(JSON.stringify({ data: null }), { status: 200 });
  };
}

describe('scanAppointments — client field selection', () => {
  let originalFetch;
  let capturedQueries;

  beforeEach(() => {
    originalFetch = global.fetch;
    capturedQueries = [];
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('selects BOTH the clientId scalar AND the nested client { ... } when both exist on Appointment', async () => {
    global.fetch = vi.fn(mockGraphQLResponse({
      types: {
        Appointment: APPOINTMENT_TYPE,
        Query: QUERY_TYPE,
        AppointmentConnection: APPT_CONN_TYPE,
        Client: { fields: [{ name: 'id' }, { name: 'firstName' }, { name: 'lastName' }, { name: 'email' }, { name: 'mobilePhone' }] },
      },
      appointmentEdge: {
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
      },
      capturedQueries,
    }));

    const result = await scanAppointments('https://example/api', { 'x-business-id': 'b' }, {
      locationId: 'urn:blvd:Location:bp',
      windowStart: new Date('2026-05-04T00:00:00Z'),
      windowEnd: new Date('2026-05-05T00:00:00Z'),
    });

    const apptQueries = capturedQueries.filter(q => /appointments\s*\(/.test(q) && !/__type|__schema/.test(q));
    expect(apptQueries.length).toBeGreaterThan(0);
    const apptQuery = apptQueries[0];

    // Bug regression assertions — both selections must appear together.
    expect(apptQuery).toMatch(/\bclientId\b/);
    expect(apptQuery).toMatch(/\bclient\s*\{[^}]*\bfirstName\b/);
    expect(apptQuery).toMatch(/\bclient\s*\{[^}]*\bmobilePhone\b/);

    // Defensive: must NOT request fields that don't exist on Boulevard's Client type.
    expect(apptQuery).not.toMatch(/\bclient\s*\{[^}]*\bphoneNumber\b/);
    expect(apptQuery).not.toMatch(/\bclient\s*\{[^}]*\bphone\s/);

    // Behavior: returned appointment must carry populated client contact info.
    expect(result.appointments).toHaveLength(1);
    const appt = result.appointments[0];
    expect(appt.clientId).toBe('urn:blvd:Client:abc');
    expect(appt.clientFirstName).toBe('Yan');
    expect(appt.clientLastName).toBe('Wu');
    expect(appt.clientEmail).toBe('helloyan.w@gmail.com');
    expect(appt.clientPhone).toBe('+16465958577');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit coverage for the PR-3 provider probes. Boulevard/Twilio/Klaviyo go through
// fetch (mocked); Sheets goes through googleapis (mocked). Each must pass on a
// good credential, fail loud on a bad one, and report not-configured when its env
// vars are absent.

const gapis = vi.hoisted(() => ({ get: vi.fn(), GoogleAuth: vi.fn() }));
vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: function (...a) { gapis.GoogleAuth(...a); return {}; } },
    sheets: () => ({ spreadsheets: { get: (...a) => gapis.get(...a) } }),
  },
}));

import { probeBoulevard, probeTwilio, probeKlaviyo, probeSheets } from '../src/lib/health-probes.js';

const originalEnv = process.env;
const originalFetch = global.fetch;

function okResponse(json = {}) {
  return { ok: true, status: 200, json: async () => json };
}
function errResponse(status = 401) {
  return { ok: false, status, json: async () => ({}) };
}

beforeEach(() => {
  process.env = {
    ...originalEnv,
    BOULEVARD_API_KEY: 'k', BOULEVARD_API_SECRET: Buffer.from('s').toString('base64'), BOULEVARD_BUSINESS_ID: 'biz',
    BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
    TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok',
    KLAVIYO_PRIVATE_API_KEY: 'pk_test',
    GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"a@b.iam","private_key":"x"}', GOOGLE_SHEET_ID: 'sheet-1',
  };
  vi.clearAllMocks();
});
afterEach(() => {
  process.env = originalEnv;
  global.fetch = originalFetch;
});

describe('probeBoulevard', () => {
  it('passes on a good credential (200 + __typename)', async () => {
    global.fetch = vi.fn(async () => okResponse({ data: { __typename: 'Query' } }));
    const r = await probeBoulevard();
    expect(r.ok).toBe(true);
    expect(r.configured).toBe(true);
  });
  it('fails loud on a 401', async () => {
    global.fetch = vi.fn(async () => errResponse(401));
    const r = await probeBoulevard();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
  });
  it('fails when Boulevard returns GraphQL errors', async () => {
    global.fetch = vi.fn(async () => okResponse({ errors: [{ message: 'nope' }] }));
    const r = await probeBoulevard();
    expect(r.ok).toBe(false);
  });
  it('reports not-configured when auth env is missing', async () => {
    delete process.env.BOULEVARD_API_KEY;
    global.fetch = vi.fn();
    const r = await probeBoulevard();
    expect(r.ok).toBe(false);
    expect(r.configured).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('probeTwilio', () => {
  it('passes on a good credential and hits the account resource (no SMS send)', async () => {
    const fetchMock = vi.fn(async () => okResponse({ sid: 'AC123' }));
    global.fetch = fetchMock;
    const r = await probeTwilio();
    expect(r.ok).toBe(true);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('/Accounts/AC123.json');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });
  it('fails loud on a 401', async () => {
    global.fetch = vi.fn(async () => errResponse(401));
    const r = await probeTwilio();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
  });
  it('reports not-configured when env is missing', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    global.fetch = vi.fn();
    const r = await probeTwilio();
    expect(r.configured).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('probeKlaviyo', () => {
  it('passes on a good key and calls /profiles/ (the scope production uses) with the API-key header', async () => {
    const fetchMock = vi.fn(async () => okResponse({ data: [] }));
    global.fetch = fetchMock;
    const r = await probeKlaviyo();
    expect(r.ok).toBe(true);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('/profiles/');
    expect(url).toMatch(/page(\[|%5B)size(\]|%5D)=1/);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Klaviyo-API-Key /);
  });
  it('fails loud on a 403', async () => {
    global.fetch = vi.fn(async () => errResponse(403));
    const r = await probeKlaviyo();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/403/);
  });
  it('reports not-configured when the key is missing', async () => {
    delete process.env.KLAVIYO_PRIVATE_API_KEY;
    global.fetch = vi.fn();
    const r = await probeKlaviyo();
    expect(r.configured).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('probe deadline (codex P2: full-operation timeout)', () => {
  it('returns a timeout result instead of hanging when the provider stalls', async () => {
    vi.resetModules();
    process.env = { ...process.env, HEALTH_PROBE_TIMEOUT_MS: '40', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' };
    // A fetch that resolves headers but never finishes the body would also be
    // bounded; the simplest stall is a fetch that never settles at all.
    global.fetch = vi.fn(() => new Promise(() => {}));
    const mod = await import('../src/lib/health-probes.js');
    const r = await mod.probeTwilio();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout');
  });
});

describe('probeSheets', () => {
  it('passes when the service account can read the sheet metadata', async () => {
    gapis.get.mockResolvedValue({ data: { spreadsheetId: 'sheet-1' } });
    const r = await probeSheets();
    expect(r.ok).toBe(true);
    expect(gapis.get).toHaveBeenCalledTimes(1);
    // minimal read: fields=spreadsheetId on the configured sheet
    expect(gapis.get.mock.calls[0][0]).toMatchObject({ spreadsheetId: 'sheet-1', fields: 'spreadsheetId' });
  });
  it('fails loud when the Sheets read rejects (bad creds / no access)', async () => {
    gapis.get.mockRejectedValue(new Error('The caller does not have permission'));
    const r = await probeSheets();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/permission/);
  });
  it('reports not-configured when the service account JSON or sheet id is missing', async () => {
    delete process.env.GOOGLE_SHEET_ID;
    const r = await probeSheets();
    expect(r.configured).toBe(false);
    expect(gapis.get).not.toHaveBeenCalled();
  });
});

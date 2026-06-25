import { describe, it, expect } from 'vitest';
import { parseGoogleServiceAccount } from '../src/lib/google-credentials.js';

// Fake, clearly-not-real key material used only to prove redaction. No real secret.
const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nMIITESTKEYMATERIALdeadbeef0123456789\n-----END PRIVATE KEY-----\n';
const VALID = JSON.stringify({
  type: 'service_account',
  project_id: 'p',
  client_email: 'svc@p.iam.gserviceaccount.com',
  private_key: FAKE_KEY,
});
// The exact shape that leaked four times: JSON pretty-printed with LITERAL
// backslash-n (two chars) instead of real newlines, which is invalid JSON.
const MALFORMED = '{\\n  "type": "service_account",\\n  "private_key": "' + FAKE_KEY + '"\\n}';

function fullErrorText(err) {
  // Everything a logger or an uncaught-exception printout could surface.
  return [err && err.message, err && err.stack, JSON.stringify(err, Object.getOwnPropertyNames(err || {}))].join('\n');
}

describe('parseGoogleServiceAccount', () => {
  it('parses a valid single-line service-account JSON', () => {
    const c = parseGoogleServiceAccount(VALID);
    expect(c.client_email).toBe('svc@p.iam.gserviceaccount.com');
    expect(c.private_key).toContain('BEGIN PRIVATE KEY');
  });

  it('throws a REDACTED error on malformed JSON, with NO key material anywhere on the error', () => {
    let err;
    try { parseGoogleServiceAccount(MALFORMED); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    const text = fullErrorText(err);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('TESTKEYMATERIAL');
    expect(text).not.toContain('service_account');
    expect(text).not.toContain(FAKE_KEY);
    // Must be our fresh redacted error, not the passed-through SyntaxError.
    expect(err.message).toMatch(/GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON \(length=\d+, sha256:[0-9a-f]{8}\)/);
  });

  it('throws a not-set error on empty or missing', () => {
    expect(() => parseGoogleServiceAccount('')).toThrow(/not set/);
    expect(() => parseGoogleServiceAccount(undefined)).toThrow(/not set/);
  });

  it('throws a redacted shape error when required fields are missing, without echoing the parsed object', () => {
    const noKey = JSON.stringify({ type: 'service_account', client_email: 'svc@p.iam.gserviceaccount.com' });
    let err;
    try { parseGoogleServiceAccount(noKey); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/missing or has a non-string/);
    expect(fullErrorText(err)).not.toContain('svc@p.iam.gserviceaccount.com');
  });

  it('throws a redacted shape error when fields are present but non-string (objects/numbers)', () => {
    for (const bad of [JSON.stringify({ client_email: {}, private_key: {} }), JSON.stringify({ client_email: 'svc@p', private_key: 123 })]) {
      let err;
      try { parseGoogleServiceAccount(bad); } catch (e) { err = e; }
      expect(err).toBeTruthy();
      expect(err.message).toMatch(/missing or has a non-string/);
    }
  });
});

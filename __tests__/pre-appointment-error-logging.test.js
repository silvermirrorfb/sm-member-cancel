import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// Production diagnostic 2026-05-19: the sms-upgrade-scan cron observed
// http_500s from /api/sms/automation/pre-appointment, but the stack traces
// behind those 500s were not surfacing through error-level log filters.
// One catch block inside the route was logging an exception payload at
// console.warn (the stop-set Redis check). This test guards against any
// future regression that drops a catch-block exception log back below
// console.error.
//
// This is a source-text test, not a runtime test. We assert that every
// catch block in the route file logs via console.error (not console.warn
// or console.log) when it logs an exception payload.

const ROUTE_PATH = path.join(
  process.cwd(),
  'src',
  'app',
  'api',
  'sms',
  'automation',
  'pre-appointment',
  'route.js',
);

function readRoute() {
  return fs.readFileSync(ROUTE_PATH, 'utf8');
}

describe('pre-appointment route: exception logs surface at console.error', () => {
  it('stop-set check catch block logs at console.error, not console.warn', () => {
    const source = readRoute();
    // The old line was: console.warn('[pre-appointment] stop-set check error:', e.message);
    expect(source).not.toMatch(/console\.warn\('\[pre-appointment\] stop-set check error:/);
    // The new line must be at error level and include both message and stack.
    expect(source).toMatch(
      /console\.error\('\[pre-appointment\] stop-set check error:', e\?\.message, e\?\.stack\)/,
    );
  });

  it('top-level catch already logs at console.error (no regression)', () => {
    const source = readRoute();
    // The outer try/catch was already at error level pre-PR. This test
    // guards against accidentally dropping it.
    expect(source).toMatch(/console\.error\('Pre-appointment automation error:'/);
  });

  it('no catch block in the route file logs an exception payload at console.warn', () => {
    const source = readRoute();
    // Grep-style sanity: a catch block introduces `} catch (NAME) {` and the
    // body until the matching brace. Rather than build a full parser, we
    // assert the simpler invariant: no console.warn line in the file mentions
    // a caught error variable (`e.`, `err.`, `error.`).
    const warnLines = source
      .split('\n')
      .filter(line => /console\.warn\(/.test(line));
    for (const line of warnLines) {
      expect(line).not.toMatch(/\b(e|err|error)\?\.\b/);
      expect(line).not.toMatch(/\b(e|err|error)\.message\b/);
      expect(line).not.toMatch(/\b(e|err|error)\.stack\b/);
    }
  });
});

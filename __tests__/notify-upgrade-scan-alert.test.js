import { describe, it, expect } from 'vitest';
import {
  tallyRunSummary,
  classifyUpgradeScanRun,
  buildUpgradeScanAlert,
  buildDailyZeroSendAlert,
} from '../src/lib/notify.js';

describe('tallyRunSummary', () => {
  it('counts sent, skipped, errors, addonSends, and reason histograms', () => {
    const results = [
      { status: 'sent', offerKind: 'duration', httpStatus: 200, ok: true },
      { status: 'sent', offerKind: 'addon', httpStatus: 200, ok: true },
      { status: 'skipped', reason: 'klaviyo_not_subscribed', httpStatus: 200, ok: true },
      { status: 'error', reason: 'http_500', httpStatus: 500, ok: false },
    ];
    const s = tallyRunSummary(results);
    expect(s.total).toBe(4);
    expect(s.sent).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.addonSends).toBe(1);
    expect(s.errorsByReason).toEqual({ http_500: 1 });
    expect(s.skippedByReason).toEqual({ klaviyo_not_subscribed: 1 });
    expect(s.httpStatusCodes).toEqual({ '200': 3, '500': 1 });
  });

  it('does not count a duration send as an add-on', () => {
    const s = tallyRunSummary([{ status: 'sent', offerKind: 'duration', httpStatus: 200, ok: true }]);
    expect(s.sent).toBe(1);
    expect(s.addonSends).toBe(0);
  });
});

describe('classifyUpgradeScanRun', () => {
  const healthy = { total: 10, sent: 0, skipped: 10, errors: 0, addonSends: 0 };

  it('healthy run does not alert', () => {
    expect(classifyUpgradeScanRun(healthy).shouldAlert).toBe(false);
  });

  it('one absorbed http_500 on a sent=0 run does not alert', () => {
    expect(classifyUpgradeScanRun({ ...healthy, sent: 0, skipped: 9, errors: 1 }).shouldAlert).toBe(false);
  });

  it('sent>0 with one error does not alert (the exact over-firing shape being fixed)', () => {
    const r = classifyUpgradeScanRun({ ...healthy, sent: 5, skipped: 4, errors: 1 });
    expect(r.shouldAlert).toBe(false);
    expect(r.conditions).toEqual([]);
  });

  it('two or more errors alerts on condition a', () => {
    const r = classifyUpgradeScanRun({ ...healthy, errors: 2 });
    expect(r.shouldAlert).toBe(true);
    expect(r.conditions).toContain('errors');
  });

  it('an add-on send alerts on condition d even with zero errors', () => {
    const r = classifyUpgradeScanRun({ ...healthy, sent: 1, addonSends: 1 });
    expect(r.shouldAlert).toBe(true);
    expect(r.conditions).toContain('addon');
  });
});

describe('buildUpgradeScanAlert', () => {
  const base = { total: 10, sent: 0, skipped: 7, errors: 3, addonSends: 0,
    errorsByReason: { http_500: 2, http_502: 1 }, skippedByReason: {}, httpStatusCodes: {} };

  it('leads with a plain verdict and puts JSON after the technical-detail line', () => {
    const { subject, text } = buildUpgradeScanAlert(base, ['errors']);
    const firstLine = text.split('\n')[0];
    expect(firstLine).toMatch(/^Needs attention: the upgrade scan hit 3 errors/);
    expect(firstLine).not.toMatch(/[{}]/);
    expect(subject).toMatch(/Needs attention/i);
    const techIdx = text.indexOf('Technical detail');
    const jsonIdx = text.indexOf('errorsByReason');
    expect(techIdx).toBeGreaterThan(0);
    expect(jsonIdx).toBeGreaterThan(techIdx);
  });

  it('leads with a plain verdict for the add-on condition', () => {
    const { text } = buildUpgradeScanAlert({ ...base, errors: 0, sent: 1, addonSends: 1 }, ['addon']);
    expect(text.split('\n')[0]).toMatch(/^Needs attention: an add-on offer was actually texted/);
  });

  it('no em dashes anywhere', () => {
    const { text, subject } = buildUpgradeScanAlert(base, ['errors']);
    expect(text + subject).not.toContain('—');
  });
});

describe('buildDailyZeroSendAlert', () => {
  it('candidates>0 says eligible members got nothing', () => {
    const { subject, text } = buildDailyZeroSendAlert({ dateStr: '2026-06-07', sends: 0, candidates: 42, threshold: 1 });
    expect(text.split('\n')[0]).toMatch(/^Needs attention: no upgrade texts went out/);
    expect(text).toContain('42 eligible members');
    expect(subject).toMatch(/Needs attention/i);
  });

  it('candidates=0 softens to a quiet-day verify note but still reads as an alert email', () => {
    const { subject, text } = buildDailyZeroSendAlert({ dateStr: '2026-06-07', sends: 0, candidates: 0, threshold: 1 });
    expect(text.split('\n')[0]).toMatch(/quiet day/i);
    expect(text).toMatch(/verify the scan is running/i);
    expect(subject).toMatch(/Heads up/i);
  });
});

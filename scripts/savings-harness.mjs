import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeValues } from '../src/lib/boulevard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.resolve(__dirname, '../__tests__/fixtures/savings-golden-set.json');

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function nearlyEqual(a, b, epsilon = 0.01) {
  if (a === b) return true;
  if (isNumber(a) && isNumber(b)) return Math.abs(a - b) <= epsilon;
  return false;
}

function formatValue(v) {
  return v === null ? 'null' : typeof v === 'undefined' ? 'undefined' : JSON.stringify(v);
}

function run() {
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const cases = JSON.parse(raw);

  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('No fixture cases found in savings-golden-set.json');
  }

  const failures = [];
  const passes = [];

  for (const testCase of cases) {
    const id = String(testCase?.id || 'unnamed');
    const profile = testCase?.profile || {};
    const expected = testCase?.expected || {};
    const computed = computeValues(profile);

    const mismatches = [];
    for (const [key, expectedValue] of Object.entries(expected)) {
      const actualValue = computed?.[key];
      if (!nearlyEqual(actualValue, expectedValue)) {
        mismatches.push(
          `${key}: expected ${formatValue(expectedValue)}, got ${formatValue(actualValue)}`
        );
      }
    }

    if (mismatches.length > 0) {
      failures.push({ id, mismatches });
    } else {
      passes.push(id);
    }
  }

  console.log(`Savings Harness: ${passes.length} passed, ${failures.length} failed`);
  for (const id of passes) console.log(`PASS  ${id}`);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL  ${failure.id}`);
      for (const mismatch of failure.mismatches) {
        console.error(`  - ${mismatch}`);
      }
    }
    process.exitCode = 1;
  }
}

run();

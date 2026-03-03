# Savings Harness

This harness validates deterministic savings math from `computeValues()` using a fixture-driven golden set.

## Run

```bash
npm run test:savings
```

## Fixture file

Path: `__tests__/fixtures/savings-golden-set.json`

Schema per case:

```json
{
  "id": "string",
  "profile": { "...": "input fields consumed by computeValues" },
  "expected": {
    "rateLockAnnual": 240,
    "memberDiscountSavingsTotal": 400,
    "discountSavingsConfidence": "high"
  }
}
```

## Current coverage

- Explicit discounts (with and without first-time promo exclusion)
- Detailed estimate from component discount totals
- Simple fallback estimate (20% of known spend)
- Walk-in savings positive/negative behavior
- Zero/no-data behavior and confidence flags

## Extending for future QA

- Item #1 (golden set): add more real-world fixture rows.
- Item #3 (confidence telemetry): assert confidence values and downstream mapping.
- Add any new computed field to the `expected` block and the harness will compare it.

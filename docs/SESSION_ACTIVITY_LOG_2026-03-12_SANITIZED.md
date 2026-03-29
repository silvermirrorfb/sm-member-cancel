# Session Activity Log - 2026-03-12 (Sanitized)

## Purpose

This is the GitHub-safe version of the March 12, 2026 incident log.

The full raw log was preserved separately because it contains sensitive operational identifiers and guest/contact data. This sanitized copy preserves the engineering history and decisions needed for future work.

## High-Level Summary

- The user reported that earlier QA thread context appeared missing and asked for recovery plus log validation.
- Repeated live QA checks were run against the production SMS upgrade flow.
- Two major production problems were investigated:
  - customer-facing SMS copy did not match the approved source text
  - the upgrade flow changed appointment state incorrectly and required recovery analysis
- A full drill run was executed end-to-end.
- The user also requested an email draft to the Boulevard/API team and a full continuity log.

## Main Findings

- The cancel-and-rebook path had executed in production.
- A replacement booking was created, but the resulting state did not satisfy the intended upgrade behavior.
- A later recovery attempt showed that the Boulevard application still lacked the booking mutation permissions required for a clean API-based restore/rebook flow at that time.
- This confirmed the core blocker was Boulevard application capability, not only app-side logic.

## Code Changes Landed That Day

### Commit `5a78a5d`
- Preserved notes in cancel-rebook upgrades and added follow-up logging behavior.

### Commit `6b7d0ea`
- Switched pre-appointment outbound copy to the approved short-form upgrade wording.

### Commit `1690912`
- Disabled cancel-rebook fallback by default unless explicitly enabled by environment gate.

### Commit `5724f48`
- Restored Column D copy behavior.
- Added fail-safe behavior when provider gap context is unknown.
- Tightened provider identity extraction heuristics.

## Validation Performed

- Focused test suites covering SMS automation, Boulevard logic, and the Twilio webhook passed after final changes.
- `npm run build` passed.
- The latest `main` code for that pass deployed successfully to production.

## Recovery Outcome

- Programmatic recovery/rebook remained blocked at that time by missing Boulevard mutation permissions.
- This is the same permissions gap that was later resolved before the March 28, 2026 live proof work.

## Why This Sanitized File Exists

Future agents need this incident history because it explains:

- why mutation gates were introduced
- why copy source discipline mattered
- why provider/gap context was treated conservatively
- why Boulevard permission enablement was a hard dependency for reliable live mutation behavior

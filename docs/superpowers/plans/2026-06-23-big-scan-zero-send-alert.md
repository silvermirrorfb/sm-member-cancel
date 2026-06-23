# Spec note: page on a big scan that sends nothing (zero-send outage detector)

**Date:** 2026-06-23
**Branch:** `fix/big-scan-zero-send-alert` (stacked on PR #71, not merged)
**Scope lock:** the run classifier and its alert copy in `src/lib/notify.js` plus tests. No route change, no eligibility change, no flag, no pricing.

## Why

The 2026-06-19 to 2026-06-22 zero-send outage scanned ~1100 to 1400 candidates per day and sent 0, with 0 errors: every candidate was skipped as `gap_unprovable` (the #64 eligibility regression). `classifyUpgradeScanRun` only treated `errors >= 2` or an add-on send as alarming, so a four-day total send failure read as a healthy all-skips day and never paged on the spot. The daily zero-send email is the only reason the outage was caught, a day at a time. A big scan that sends nothing should page immediately.

## Locked decision (owner authorized this session)

Fire a per-run alert when a scan looks at many candidates and sends none, REGARDLESS of error count. Threshold: `total > 50` candidates AND `sent == 0`. Below 50, a genuinely light day must not page (the daily zero-send check still covers truly quiet days).

## Changes

1. `classifyUpgradeScanRun` adds a `big_scan_zero_send` condition (`total > 50 && sent === 0`), independent of the existing `errors` and `addon` conditions, so it fires even at zero errors. Threshold constant `BIG_SCAN_MIN_CANDIDATES = 50`.
2. `buildUpgradeScanAlert` renders a plain-English verdict for it in the existing ops-alert style (verdict first, then what-to-do, then the technical JSON with `skippedByReason` so the dominant skip reason is visible). No em dashes.
3. No cron route change: `sms-upgrade-scan/route.js` already calls `classifyUpgradeScanRun` and then iterates `conditions` through per-condition hourly dedup and `buildUpgradeScanAlert`, so the new condition flows through the existing email path unchanged.

## Why stacked, not folded into PR #71

Repo rule is one fix per PR. PR #71 restores sends (the eligibility recovery); this restores the alarm that should have caught the outage. They are separate surfaces (eligibility logic vs the run classifier), so they get separate PRs. #71 can merge first to stop the bleed; this follows.

## Verification

TDD: the firing test and the alert-copy test fail before the change and pass after. Full vitest suite green (959). Gauntlet (/codex on the final SHA, /review, /cso) on the stacked tip. Merge nothing.

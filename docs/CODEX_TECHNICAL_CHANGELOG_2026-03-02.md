# Silver Mirror Cancel Bot
## Codex Technical Change Log (Takeover Window)

Document date: 2026-03-02
Prepared by: Codex
Branch: `main`
Latest commit in this document: `47cd6b4`

---

## 1. Scope

This document covers all code changes made after takeover, from commit:
- Start: `ac68f1b` (`Prevent fabricated membership stats; use verified Boulevard fields only`)
- End: `47cd6b4` (`Sync perks milestones to official Year 3-10 and post-Year-10 spec`)

Total delta for this window:
- `7 files changed`
- `652 insertions`
- `172 deletions`

Files touched in this window:
- `.env.example`
- `src/app/api/chat/end/route.js`
- `src/app/api/chat/message/route.js`
- `src/app/widget/page.js`
- `src/lib/boulevard.js`
- `src/lib/claude.js`
- `src/lib/system-prompt.txt`

---

## 2. Executive Summary

Primary outcomes delivered:
- Eliminated fabricated membership stats by enforcing verified-only profile usage.
- Fixed critical frontend End Chat bugs and strengthened session-loss recovery behavior.
- Hardened member matching and identity verification (middle names, typo tolerance, phone/email pathways).
- Improved reliability of Boulevard profile enrichment (membership start, rate, tier, next charge).
- Synced pricing in prompt dynamically from code constants to avoid pricing drift.
- Replaced inconsistent/duplicative post-lookup chat output with deterministic verified-greeting logic.
- Synced full perks ladder to official SOP/spec through Year 10 and added post-Year-10 cadence.

Deployment state:
- All commits in this report were pushed to `origin/main`.

---

## 3. Commit Timeline

| Time (ET) | Commit | Summary | Files | Net Effect |
|---|---|---|---|---|
| 2026-03-02 16:21 | `ac68f1b` | Prevent fabricated membership stats; verified-only fields | 2 | Data integrity hardening |
| 2026-03-02 16:26 | `721995f` | Fix End Chat frontend crashes + disable prod mock fallback | 3 | P0/P2 reliability |
| 2026-03-02 16:31 | `9069c3b` | Enrich profile from Boulevard memberships feed | 1 | Tier/rate/tenure data quality |
| 2026-03-02 16:34 | `95f5b4d` | Require explicit tier/rate/tenure mention when known | 1 | Prompt behavior correction |
| 2026-03-02 17:51 | `201bee5` | Harden matching + pricing token sync + cost-flow guardrails | 4 | Lookup robustness + policy control |
| 2026-03-02 18:04 | `d3e0334` | Resolve QA blockers (lookup UX, end-chat flow, guardrails) | 5 | Major QA closure |
| 2026-03-02 18:08 | `47cd6b4` | Sync perks to official Year 3–10 + post-Year-10 | 2 | Perk logic correctness |

---

## 4. Detailed Technical Changes

## 4.1 `ac68f1b` — Verified-Only Member Data Rules

### Problem Addressed
The bot was producing fabricated membership facts (e.g., tenure/rate assumptions) when Boulevard fields were absent.

### Changes
In `src/lib/boulevard.js`:
- Added data normalization helpers:
  - `toIsoDate(...)`
  - `isFiniteNumber(...)`
  - `parseTierFromText(...)`
  - `monthsBetween(...)`
- Expanded client query fields for better baseline profile context:
  - `createdAt`, `appointmentCount`, `active`, `primaryLocation`
- Rebuilt `buildProfile(...)` to be null-safe and verified-only:
  - Removed default/fabricated values like forced tier/rate/tenure.
  - Added `clientSince`, strict `memberSince`, computed `tenureMonths` fallback from start date only.
  - Added `appointmentCount` and null-safe financial/usage fields.
- Reworked `computeValues(...)`:
  - Savings/loyalty/perk outputs now only computed when prerequisite fields are known.
  - Avoids false positive savings and false loyalty claims.
- Reworked `formatProfileForPrompt(...)`:
  - Added explicit UNKNOWN guardrails in injected profile text.
  - Added strict “do not state unknown fields” language.

In `src/lib/system-prompt.txt`:
- Added hard rules to avoid claiming unknown tier/rate/tenure.

### Behavioral Impact
- Model no longer claims concrete membership metrics without evidence.
- Initial membership responses are safer and more truthful under partial data.

---

## 4.2 `721995f` — End Chat Crash Fix + Mock Fallback Gate

### Problem Addressed
- Frontend End Chat path had runtime errors (broken history + missing fetch result binding).
- Production could silently fall back to mock member data if Boulevard key missing.

### Changes
In `src/app/widget/page.js`:
- Fixed history append bug: `input` -> `text` in conversation-ending payload.
- Fixed end-chat fetch bug: added `const res = await fetch(...)` before parsing JSON.

In `src/lib/boulevard.js`:
- Added explicit mock gating:
  - Mock only allowed when `BOULEVARD_ALLOW_MOCK=true` and non-production.
  - Production missing key now returns `null` and logs disabled lookup.

In `.env.example`:
- Documented `BOULEVARD_ALLOW_MOCK` as dev-only safety switch.

### Behavioral Impact
- End Chat no longer fails from reference errors.
- Production lookup behavior becomes deterministic and safe (no fake members).

---

## 4.3 `9069c3b` — Boulevard Membership Enrichment

### Problem Addressed
Client search alone did not reliably include membership start date, tier, rate, or status.

### Changes
In `src/lib/boulevard.js`:
- Added membership scanning constants + cache:
  - `MEMBERSHIP_SCAN_*`, cache TTL/negative TTL.
- Added membership cache helpers and selection heuristics:
  - `getCachedMembership`, `setCachedMembership`
  - `membershipStatusScore`, `pickBetterMembership`
- Added `findMembershipForClient(...)` GraphQL pagination over memberships.
- `lookupMember(...)` now merges best membership data onto matched client profile:
  - `membershipStartDate`, `membershipStatus`, `unitPrice`, `nextChargeDate`, location fallback.
- `buildProfile(...)` now ingests these fields and surfaces:
  - stronger `accountStatus`
  - `nextChargeDate`

### Behavioral Impact
- Much better chance to produce real tier/rate/start-date data.
- Reduced “known member but missing membership details” failures.

---

## 4.4 `95f5b4d` — Prompt Requirement for First Membership Greeting

### Problem Addressed
Even with better profile data, responses could omit tier/rate/tenure.

### Changes
In `src/lib/system-prompt.txt`:
- Added explicit instruction for first post-lookup response:
  - Include known tier, known monthly rate, and known tenure/member-since.

### Behavioral Impact
- Stronger consistency in first membership-mode reply structure.

---

## 4.5 `201bee5` — Matching Hardening + Pricing Tokenization + Cost-Flow Rules

### Problem Addressed
- Some real members failed lookup due to middle names/noisy input.
- Pricing existed in multiple hardcoded places.
- Cost-based retention flow occasionally skipped downgrade sequence.

### Changes
In `src/app/api/chat/message/route.js`:
- Improved name candidate extraction from raw mixed text:
  - strips noise tokens (`email`, `text`, `phone`, etc.)
  - generates multiple candidates (`first+last`, `first+second`, full sequence)

In `src/lib/boulevard.js`:
- Added robust name matching helpers:
  - `normalizeNameText`, `tokenizeName`, `namesLikelyMatch`
- Updated `findNameMatch(...)` to use token-aware/middle-name-tolerant matching.

In `src/lib/claude.js`:
- Added prompt pricing token substitution:
  - `{{WALKIN_30/50/90}}`, `{{MEMBER_30/50/90}}`
- Prompt now sources pricing from `WALKIN_PRICES` / `CURRENT_RATES` constants.

In `src/lib/system-prompt.txt`:
- Replaced hardcoded tier pricing with tokens.
- Added hard rule for cost-overwhelming path ordering and downgrade-first enforcement.

### Behavioral Impact
- Higher lookup match success for real-world name formats.
- Single source of truth for pricing across bot behavior.
- More reliable retention sequencing for cost objections.

---

## 4.6 `d3e0334` — Major QA Closure Patch

### Problem Addressed
High-priority QA findings remained around:
- contradictory/double profile responses,
- end-chat reliability,
- session-loss behavior,
- phone lookup misses,
- medical/hardship flow clarity.

### Changes
In `src/app/api/chat/message/route.js`:
- Added deterministic post-lookup greeting generator:
  - `buildPostLookupGreeting(...)` with strict known-field usage.
  - Includes month+year formatting for member-since when available.
  - Includes rate-lock/savings/perk cues only when verified.
- Removed dependence on Claude pre-lookup visible ack text in member-identification response.
- Simplified lookup failure output to deterministic single message (no duplicated mixed text).

In `src/app/widget/page.js`:
- Added reusable session bootstrap function `startChatSession(...)`.
- Added 404/409 recovery path in `handleSend(...)`:
  - attempts fresh start and prompts user to resend last message.
- Reworked `handleEndChat(...)`:
  - end request failure no longer blocks reset.
  - always attempts new session start afterward.
- Implemented missing `handleNewChat(...)` flow.

In `src/app/api/chat/end/route.js`:
- Added sanitized recovery history parsing (`sanitizeRecoveredHistory`).
- Replaced hard 404 for missing session with graceful no-op completion payload.
- Fallback summary now preserves unknowns as `null` (instead of fake zeros).

In `src/lib/boulevard.js`:
- Increased phone scan depth: `PHONE_SCAN_MAX_PAGES` from 20 -> 120.
- Strengthened `verifyMemberIdentity(...)` to use robust token-aware name matching.
- Exported `levenshtein` for test usage compatibility.

In `src/lib/system-prompt.txt`:
- Added guardrails:
  - member-since should include month + year.
  - perk messaging must use injected computed fields only.
  - medical/hardship longer-hold requests route to `memberships@silvermirror.com`.

### Behavioral Impact
- Eliminates contradictory dual-profile output pattern.
- End Chat and new session reset are significantly more resilient.
- Improved response consistency on cold-start/session-rotation edge cases.
- Stronger identity correctness and lookup reliability.

---

## 4.7 `47cd6b4` — Perks SOP + Year 3–10 Spec Sync

### Problem Addressed
Perk ladder in code/prompt diverged from official SOP/spec, causing incorrect milestone messaging.

### Source Documents Applied
- `Silver_Mirror_Perks_Milestone_Rewards_SOP_122625 (4).docx`
- `Silver Mirror Member Perks - Year 3–10 Specification - 022926 (1).docx`

### Changes
In `src/lib/boulevard.js`:
- Replaced `PERKS` matrix with expanded milestone schedule including:
  - Months 2,4,5,6,9,12,18,22,24
  - Years 3–10 milestones at 36..120 with mid-year credits and recognition point.
- Added milestone `type` metadata for clarity (`retail`, `credit`, `service_upgrade`, `diamond`, etc.).
- Added `getNextPerkMilestone(tenureMonths)`:
  - Supports in-matrix milestones first.
  - Adds post-Year-10 recurring cadence:
    - annual anniversary (bundle + add-on)
    - mid-year enhancement credit
- Updated `computeValues(...)` to use the new next-perk function.
- Updated prompt formatting of next-perk line to handle zero-value events (recognition) cleanly.

In `src/lib/system-prompt.txt`:
- Synced milestone list with official schedule through Month 120.
- Added explicit post-Year-10 cadence description.

### Behavioral Impact
- Next-perk calculations now align with official operations documents.
- Long-tenure member perk messaging is materially more accurate.

---

## 5. QA Issue Mapping (High-Level)

Closed or materially mitigated in this window:
- End Chat non-functional / spinner hang.
- Missing `const res` crash in `handleEndChat`.
- Undefined variable in end-history path.
- Session-loss handling weaknesses (message/end resilience improved).
- Fake/assumed member facts in greeting (tier/rate/tenure guardrails).
- Missing tier/rate/tenure mention consistency in first post-lookup message.
- Lookup misses related to middle-name/noisy input matching.
- Conflicting/double profile outputs from mixed pre/post lookup text.
- Incorrect perks ladder for Year 3–10 and beyond.

Partially addressed or dependent on external data/system policy:
- Savings mention availability depends on Boulevard field completeness.
- Phone lookup quality still depends on Boulevard pagination/search surface and data quality.
- Session persistence still in-memory; true cross-instance continuity requires Redis/DB.
- Year 5 milestone references HydraFacial in official perks spec but conflicts with general-service messaging policy (requires business decision).

---

## 6. Validation Performed

Executed:
- `npm run build` passed after major patch sets.
- Spot runtime sanity checks on next-perk calculation using local Node eval.

Not executed in this environment:
- Full `vitest` run (network access unavailable for package retrieval in this environment at run time).
- Direct Vercel deployment inspection via CLI (credentials not present here).

---

## 7. Deployment Trace

Push history in this window:
- `201bee5` pushed to `origin/main`
- `d3e0334` pushed to `origin/main`
- `47cd6b4` pushed to `origin/main`

Current remote head:
- `origin/main` -> `47cd6b4`

---

## 8. Recommended Next Steps

1. Confirm Vercel deployment status for `47cd6b4` in dashboard and run smoke QA on:
   - member lookup (email + phone),
   - cost path (downgrade before cancel),
   - medical path (custom hold escalation),
   - End Chat + restart behavior.
2. Decide and codify Year 5 reward wording conflict:
   - official spec includes HydraFacial, but service policy states discontinued.
3. Move session store from in-memory map to Redis/DB for durable serverless continuity.
4. Add automated tests for:
   - `buildPostLookupGreeting`,
   - `getNextPerkMilestone`,
   - session recovery + end-chat flows.


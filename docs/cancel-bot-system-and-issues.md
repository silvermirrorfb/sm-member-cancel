# Silver Mirror Member Cancellation Bot - What It Does and Every Issue To Date

**Document purpose:** Plain-English explanation of what the cancellation bot is, how it works, and every breakage, bug, and design issue it's hit from initial build through May 12, 2026.

**Audience:** Matt, future Claude sessions, and any non-engineer who needs to understand what this bot does and why it keeps needing fixes.

**Last updated:** May 12, 2026

---

## What the cancellation bot is

A chat widget embedded on `silvermirror.com/memberships/cancel`. When a Silver Mirror member wants to cancel their membership, they go to that page, get the widget, and have a conversation with an AI assistant. The AI is Claude (Anthropic's model), running with a custom system prompt that gives it Silver Mirror's pricing, services, retention playbook, and tone of voice.

The bot does four jobs:

1. **Answer questions** about services, pricing, locations, products, and skincare (general Q&A)
2. **Look up the member's account** in the Boulevard booking system once they share their name and email
3. **Run a retention conversation** designed to save the member by offering pauses, downgrades, bi-monthly billing, or other options
4. **Generate a summary email** to the memberships team with what happened (RETAINED, CANCELLED, REFERRED, or MANAGER_CALLBACK) so they can execute the action

It's the front door for most cancellations now. The old process was email back-and-forth with the memberships team, which was slow and inconsistent.

---

## Where this fits in the bigger picture

The cancellation bot is the most mature piece of Silver Mirror's automated customer-communication infrastructure. It lives in the same codebase (`sm-member-cancel`) as several other systems that share supporting infrastructure (Twilio, Klaviyo, Boulevard, Redis, Google Sheets):

1. **Cancellation chatbot (web widget)** - THIS DOCUMENT
2. Pre-appointment add-on upsells (outbound SMS) - see other doc
3. Pre-appointment duration upgrades (outbound SMS) - see other doc
4. YES/NO appointment confirmations
5. 1-hour appointment reminders
6. Missed-call autotext (in pilot build for Brickell)

The cancel bot has been live in production since early 2026 and handles roughly 660 sessions over a 3-week window based on the most recent log review.

---

## How it actually works (the plain-English pipeline)

### Step 1: Member opens the page
The member clicks "Cancel Membership" somewhere on silvermirror.com and lands on the cancellation page. The widget loads in an iframe. They see an opening greeting from the bot offering to help.

### Step 2: General conversation begins
The bot is in **General Mode**. It can answer any question about Silver Mirror - services, pricing, hours, products, skincare advice. Most members don't start by saying "cancel my membership" right away. They ask a question first. The bot is built to handle that conversationally.

### Step 3: Membership topics trigger the lookup
When the member mentions anything membership-related (cancel, pause, billing, credits, account issues), the bot transitions into **Membership Mode**. It conversationally asks for the member's name and email. There's no separate login screen - it happens inside the chat.

### Step 4: The bot looks up the account
Behind the scenes, when the bot has enough info, it emits a special `<member_lookup>` tag in its response. The backend intercepts that tag (the member never sees it), calls the Boulevard API, and gets the member's full profile: name, email, phone, location, tier (30/50/90 minute), monthly rate, tenure, perks claimed, loyalty points, unused credits, and more.

If the lookup succeeds: the profile gets injected into the bot's system prompt, and the conversation continues with full context. The bot can now say things like "I see you're on the 50-Minute Membership at Flatiron for $129/month, and you've been with us for 13 months."

If the lookup fails: the bot tells the member it can't find their account and directs them to memberships@silvermirror.com.

### Step 5: The retention conversation
Now in Membership Mode with full member context, the bot follows a **retention decision tree**. It identifies one of about 20 cancellation reasons (cost, inconsistent usage, relocation, lack of results, bad experience, etc.) and presents reason-specific save offers in a structured order.

The retention playbook has three tiers, in priority order:
- **Zero-cost saves first**: pauses, downgrades to a smaller tier, bi-monthly billing
- **Low-cost saves second**: free add-on, product sample, location transfer
- **High-cost saves third**: complimentary service, manager callback (requires approval)

The bot is supposed to honor "just cancel" requests. If a member firmly declines offers, the bot is supposed to process the cancellation. There's a "final warning" message that's allowed once, but the bot is not supposed to push past two clear refusals.

### Step 6: Outcome captured
At the end of the conversation, the bot generates a **session summary** with one of four outcomes:

- **RETAINED**: Member accepted a save offer (pause, downgrade, bi-monthly, transfer)
- **CANCELLED**: Member chose to cancel, all offers declined
- **REFERRED**: This isn't a cancellation, route to humans for manual handling (e.g., missing milestone rewards, billing dispute)
- **MANAGER_CALLBACK**: Member needs a manager to follow up (e.g., service complaint)

### Step 7: Notifications fire
When the conversation ends, three things happen in parallel:

1. **Email to memberships@silvermirror.com** with the full session summary, member info, transcript, and a draft response email the memberships team can edit and send. If the member sentiment was upset/frustrated/angry, hello@silvermirror.com gets CC'd. If there was a skin reaction or allergy mentioned, special routing fires to kristen@, matt@, rachael@, and hello@.

2. **Google Sheets logging** to the Cancellations tracker (22 columns: date, name, location, tier, reason, outcome, offer accepted, action required, etc.) so the memberships team can work through it as a queue.

3. **Reason-category alert email** to a per-category recipient list based on what kind of cancellation it was.

### Step 8: Memberships team executes
The bot doesn't actually cancel anything in Boulevard. It generates the summary and draft email; the memberships team (Fernanda primarily) reviews, edits the draft if needed, sends it, and executes the actual cancellation or pause in Boulevard manually.

---

## The legal framework

This bot exists in a regulatory environment that matters:

**New York Auto-Renewal Law** requires clear disclosure of all commitment periods before a member accepts any offer. That's why the bot must disclose the 3-billing-cycle commitment for pauses and bi-monthly billing BEFORE the member says yes, not after.

**FTC Negative Option Rule** prohibits creating barriers to cancellation. The bot can present save offers, but it cannot obstruct or unreasonably delay the cancellation process. "Just cancel" must always work.

**Equinox $600,000 settlement (June 2025)** is a recent cautionary tale. Equinox lost a class action specifically about making cancellation unreasonably difficult. Premium wellness brands in NY are now under closer scrutiny.

The retention decision tree, the pause-disclosure rule, and the "honor just cancel" rule all exist because of these constraints.

---

## The full history of issues, in chronological order

### Issue 1: Bot kept crashing during initial development chats
**When:** Early development, late February to early March 2026
**Severity:** Development friction, not production

The original development chat in Claude.ai got too long and started crashing/failing to load. Lesson learned: start fresh chats at natural stopping points and maintain a separate technical spec doc as source of truth. This is why the SESSION_HANDOFF documents exist.

---

### Issue 2: Member lookup 500 error
**When:** Early development
**Severity:** Bot was unusable for cancellation flow

When a member provided their name and email, the bot crashed with a 500 error before completing the Boulevard lookup. Took a chunk of debugging in a separate chat to track down. Combination of null-safety issues in the lookup code and the start route handler getting accidentally overwritten with rate-limiter code.

**Fix:** Restored proper start route, added null-safety checks throughout the Boulevard integration.

---

### Issue 3: Vercel cold start latency
**When:** Initial production rollout
**Severity:** UX problem, not a hard failure

The first request to the bot after a period of inactivity was slow because Vercel's serverless functions spin up cold. Add Claude's API latency on top and the first message took a noticeable beat.

**Resolution:** This is a serverless architecture limitation. The fix would be Vercel Pro for faster cold starts, which hasn't been done. In practice, second and subsequent messages are fast, so most members don't notice.

---

### Issue 4: Google Sheets logging missing for chatlog
**When:** Initial production rollout
**Severity:** Audit trail gap

The bot was supposed to log every message to two separate Google Sheets:
- Cancellations Sheet (`1zq3a5VrYVKXNu_ITfPcMcX6jZNTJepzNGIcy49c6uTg`) - one row per cancellation session
- Chatlog Sheet (`1Wu7th9Z9tO9nQuy7j2FyEgm1YKhDwvgcVPZDprE8z-Y`) - one row per message

The chatlog logging silently wasn't working because the `GOOGLE_CHATLOG_SHEET_ID` environment variable wasn't set in Vercel.

**Fix:** Set the env var. Both sheets now log correctly.

**Process gap surfaced:** Several integrations in this codebase silently no-op when env vars are missing instead of failing loudly. This is a recurring theme (see Issue 6 below).

---

### Issue 5: The bot was too aggressive on retention (multiple sessions)
**When:** April to early May 2026
**Severity:** Real customer experience harm

Review of 660 sessions surfaced consistent patterns where the bot pushed retention past clear refusals:

- Session `d60c370e`: Member said "no I would like to cancel please." Bot offered a 2-month pause. Member said "No thank you, please just cancel." Bot still ran a final-warning loss-framing block before processing.

- Session `9d661a35`: Member said she was moving to Congo. Bot offered FOUR retention options (1-month pause → bi-monthly → consolidate credits to products → final warning) before letting her cancel. Congo doesn't have a Silver Mirror.

**Fix status:** Both patterns flagged as Decisions 1 and 2 in the chatbot-script-decisions doc sent to Travis. Awaiting his decision on how aggressive retention should be after clear refusals. Code fix is small (system prompt edit) but the business decision is Travis's call.

---

### Issue 6: Bot makes promises Silver Mirror has no process to fulfill
**When:** Ongoing
**Severity:** Trust erosion, ops misalignment

The bot says things like:
- "I'm passing this to our memberships team for backend processing"
- "I've alerted our QA team"
- "I'm flagging this as urgent"
- "You'll receive a confirmation email within 48 hours"

Investigation of the actual notification code (`src/lib/notify.js`):
- The "memberships team" claim is partially real. Email to memberships@ does fire, Google Sheet logging does fire, and reason-category alerts do fire.
- The "QA team alert" and "flagging as urgent" claims map to NOTHING. There is no QA team alert system. The bot is making them up.
- The "48 hours" promise depends on the memberships team's actual capacity, which varies.
- All of the above silently no-op if any env var is missing. The bot still tells the member "you'll get an email" even if the email system is broken.

**Fix status:** Decision 3 in the doc sent to Travis. Highest-priority item because it's a trust issue. Recommended fixes: audit production env vars, strip the bot of unsupported claims, and consider client-side `sendBeacon` to make leg-A more robust against tab-close failures.

---

### Issue 7: Pause-disclosure bait-and-switch
**When:** April to May 2026
**Severity:** At least 3 cancellations directly caused
**Resolution:** Shipped May 11, 2026 via PR #6

The bot was offering 2-month pauses, getting "yes" from the member, then revealing the 3-billing-cycle commitment AFTER acceptance in the post-acceptance message.

Confirmed cases:
- Nicole (April 16): Accepted 2-month pause. Learned about commitment after. Cancelled outright.
- Vanessa (April 17): Same pattern.
- Emily Merghart (May 4): Same pattern. Fernanda escalated this case.

**Why it happened:** The system prompt said "MUST disclose before confirmation" but the model interpreted "before" loosely. It would mention the commitment in the FOLLOWING message (technically "before" the action was processed), but psychologically after the member had already said yes.

**Fix:** Tightened the prompt rule and added an explicit BAD/GOOD example pair. The 3-cycle commitment must now appear in the SAME message as the pause offer, before the member says anything. PR #6 merged May 11.

---

### Issue 8: Email template selection ignored the accepted offer
**When:** May 4, 2026 (Emily Merghart case caught it)
**Severity:** Wrong email drafts going to the memberships team
**Resolution:** Shipped May 11, 2026 via PR #4

The bot generates a draft email at the end of every session for Fernanda to send to the member. The template selector was keying off the cancellation REASON instead of the OUTCOME.

So Emily Merghart, whose reason was "Inconsistent Usage" but who accepted a 1-month pause, got an email draft with the subject "Matching you with a consistent esthetician" - the lead-recommendation template - instead of a pause confirmation email. Fernanda caught it before sending.

**Fix:** Email template selection now keys off outcome first (RETAINED via pause → pause template, RETAINED via downgrade → downgrade template, etc.), with reason-based templates only firing as a fallback for RETAINED with no save offer accepted. PR #4 merged May 11.

---

### Issue 9: REFERRED outcomes generated cancellation emails
**When:** May 7, 2026 (Zoe Dickinson case caught it)
**Severity:** Bot told a loyal 5+ year member her membership was cancelled when she had asked about missing milestone rewards
**Resolution:** Shipped May 12, 2026 via PR #8

Zoe Dickinson asked about milestone rewards she didn't receive over 4+ years of fragmented account history. The bot correctly flagged the session as REFERRED (not a cancellation), but the email draft Fernanda received had the subject "Your Silver Mirror membership cancellation is confirmed." Bad template, bad outcome routing.

Root cause was two-layered:
1. PR #4 fixed RETAINED template routing but didn't cover REFERRED.
2. REFERRED fell through to a reason-based substring matcher, and Zoe's reason "Missing milestone rewards due to multiple account TRANSITIONS" substring-matched the "TRANSIT" / location-relocation branch. By coincidence.

**Fix:** Added a new template (`43-referred-manual-review`) and routed REFERRED outcomes to it before any reason matching. PR #8 merged May 12.

**Adjacent issue surfaced but not yet fixed:** The substring matching vulnerability still affects RETAINED and CANCELLED outcomes when reason matching is in their priority chain. Worth a future tightly-scoped PR.

---

### Issue 10: Bi-monthly pricing used grandfathered rates
**When:** Discovered May 11, 2026
**Severity:** Margin loss on every bi-monthly save offer
**Resolution:** Shipped May 11, 2026 via PR #5

When the bot offered a bi-monthly membership as a save option, it was using the member's existing (possibly grandfathered) monthly price as the bi-monthly price. That's wrong - bi-monthly is its own pricing tier ($99 for 30-minute, $169 for 50-minute), independent of what the member currently pays monthly.

So a member grandfathered at $89/month on the 30-minute plan was being offered bi-monthly at $89, when the correct bi-monthly price is $99. Real revenue impact across every accepted bi-monthly save.

**Fix:** Added centralized current bi-monthly pricing constants. Bi-monthly offers now always quote current pricing regardless of the member's existing rate. PR #5 merged May 11.

---

### Issue 11: Bot quotes specific dollar values for perks without verification
**When:** Ongoing, still unresolved
**Severity:** Trust risk, unverified data going to members

The bot tells members things like:
- "Month 2: Moisturizer ($65 value)"
- "Month 4: Hyaluronic Acid Serum ($77 value)"
- "Month 9: Cleanser ($41 value)"
- "Month 12: Foundational Formulas Bundle ($183 value)"

Nobody has verified whether these dollar values are correct, where they came from, or whether they're hard-coded versus model-fabricated. Reviewing the bot's actual transcripts (Zoe's case among others), the bot quotes them as authoritative facts.

**Fix status:** Decision 4 in the doc sent to Travis. Three options on the table: verify and lock into a single source of truth, drop dollar values entirely, or confirm they're already accurate.

---

### Issue 12: Identity verification floor is name + email only
**When:** Ongoing, design decision
**Severity:** Privacy and bad-actor risk

The bot reveals plan, location, price, join month, perks claimed, and rate-lock savings after name + email only. It will then process pause/cancel/billing-frequency changes on that same identity check.

If someone has another member's name and email (easy to obtain), they can in theory cancel that membership. The 48-hour confirmation email is the only second factor.

**Fix status:** Decision 5 in the doc sent to Travis. Three options: keep as-is, add a soft second factor (last 4 of card, last appointment date), or require a click-to-confirm link in the email.

---

### Issue 13: Refund and double-billing escalation is weak
**When:** Ongoing
**Severity:** Customer experience harm in financially sensitive moments

When a member alleges duplicate charges, the bot says it sees one membership and asks for screenshots via email. Reads as minimizing for a moment that needs to feel taken seriously.

**Fix status:** Decision 6 in the doc sent to Travis. Recommended new script and a real escalation path (depends on Decision 3 fix).

---

### Issue 14: Bot can't see credit balances
**When:** Ongoing
**Severity:** Information gap in critical moments

When a member asks "do I have any unused credits before I cancel?", the bot says it can't see specific credit details and gives a generic answer. This is true (the bot doesn't have credit visibility), but the framing isn't great.

**Fix status:** Decision 7 in the doc sent to Travis. Three options: wire in credit visibility, add an explicit upfront disclaimer plus 24-hour follow-up, or status quo.

---

### Issue 15: Voice and tone issues
**When:** Ongoing
**Severity:** Customer perception, brand consistency

Three recurring tone problems:
- "Perfect!" used as a default acknowledgement, including in unresolved or neutral moments. Reads weird.
- Stacked empathy phrases ("I hear you," "No worries," "That makes sense," "I understand") sometimes 2-3 in adjacent messages. Sounds rehearsed.
- Cancellation benefits list says "20% off services, add-ons, and Silver Mirror products, plus 10% off retail." Products and retail might be the same thing.

**Fix status:** Decision 8 in the doc sent to Travis. Generally favors banning default "Perfect!", limiting empathy phrases, and shortening the benefits list.

---

### Issue 16: Bot uses "(888) 677-0055" as an escape hatch
**When:** Ongoing
**Severity:** Customer frustration, especially when members have already tried that channel

Pattern: A member says she's been trying to cancel via email for six months. Bot suggests calling (888) 677-0055. Member says she's working and can't call. Only then does the bot escalate to a human.

The bot keeps deflecting to the phone number when it doesn't know what else to do, even after the member has said that channel didn't work.

**Fix status:** Decision 9 in the doc sent to Travis. Proposed rule: if a member says they've already tried email or phone, the bot should NOT send them back to that channel. Escalate directly.

---

### Issue 17: Conflicting messaging on commitment
**When:** Ongoing
**Severity:** Member confusion

The bot says "memberships have no minimum commitment, you can cancel anytime with 30 days notice." Then in the same conversation, it offers a pause with a 3-billing-cycle commitment. Side by side, confusing.

**Fix status:** Decision 10 in the doc sent to Travis. Proposed standardized language.

---

## Where things stand on May 12, 2026

### What's been fixed (5 PRs shipped May 11-12)
- PR #4: Email template prioritizes outcome over reason (Emily Merghart case)
- PR #5: Bi-monthly uses current pricing, not grandfathered (revenue leak)
- PR #6: Pause disclosure happens in offer message, not after (Nicole/Vanessa/Emily pattern)
- PR #7: Chatbot script decisions doc (10 decisions for Travis review)
- PR #8: REFERRED outcomes route to manual-review template (Zoe case)

### What's pending Travis review (Decisions 1 through 10)
The 10-decision doc is in his hands. Highest-stakes items: Decision 3 (escalation reality), Decision 5 (identity verification), Decision 1 (retention aggressiveness).

### What's working well
- Core cancellation flow is functional and live
- Boulevard member lookup is reliable
- Email + Sheet logging fires on session end (with caveats from Issue 6)
- Klaviyo SMS consent gate is enforced
- Production deployments are stable on Vercel

---

## Why this bot keeps needing fixes

In plain English:

1. **Real members surface real bugs.** The Emily, Nicole, Vanessa, and Zoe cases all came from Fernanda or the memberships team flagging issues that no test caught. The bot's behavior depends on Claude (the AI model) interpreting the system prompt, and Claude's interpretation can drift in edge cases the prompt didn't anticipate.

2. **The retention playbook is complex.** 20 cancellation reasons, 3 tiers of save offers per reason, legal compliance constraints, ops constraints (some reasons need manager callbacks), and the bot has to pick the right offer order on the fly. Lots of surface area for bugs.

3. **The bot promises things the business hasn't built yet.** The "I've alerted the QA team" example is the clearest case. The bot needs to be told what it can and cannot truthfully promise.

4. **Parallel agents have made changes that broke things.** Claude Code, Cursor, and Codex have all worked on this codebase. Three of the recent issues trace to template selection logic that got refactored without considering all outcome types. The strict scope-lock rules in PRs now exist to prevent this.

5. **There's limited automated testing.** Most issues are caught by humans reading transcripts after the fact. The bot has tests for the email template selection (244 of them as of May 12) but not for the broader conversational behavior. That's a structural gap.

---

## What would make this better

In rough priority order:

1. **Verify the production email and sheet logging actually works.** Spot-check a recent CANCELLED session. Is the email in memberships@? Is the sheet row there? Until this is confirmed, every promise the bot makes is on shaky ground.

2. **Strip unsupported claims from the bot.** "I've alerted our QA team" needs to go unless that's a real system. Easier to fix the bot than to build a fake QA team alert.

3. **Audit perk dollar values and lock them in.** $65, $77, $41, $183 - are these right? If yes, single source of truth. If no, drop them.

4. **Add automated tests for conversational behavior.** Right now we have unit tests for template selection but no integration tests for "does the bot honor 'just cancel' after a clear refusal?" That kind of test would have caught the over-retention issue before Emily got hurt.

5. **Build the missing escalation paths.** Billing disputes, credit questions, and milestone-reward reconciliation (Zoe's case) all currently route to "the team will reach out in 48 hours" with no defined process behind it. Fernanda is doing manual work because there's no system.

6. **Tighten the parallel-agent coordination rules.** The handoff docs and PR scope-locks help, but a more durable answer is a clear "who owns what" map across Claude Code, Cursor, Codex, and Claude chat.

---

## What a healthy session looks like

A well-functioning cancellation session produces:

- Conversational opening, member-friendly tone
- Smooth account lookup (3-4 turns max)
- Reason identification that matches what the member actually said
- 2-3 save offers in the right priority order (zero-cost → low-cost → high-cost)
- Honors "just cancel" after one or at most two clear refusals
- Discloses commitments BEFORE the member accepts anything
- Generates an outcome (RETAINED / CANCELLED / REFERRED / MANAGER_CALLBACK)
- Fires the right email template based on the outcome and accepted offer
- Logs the session to the Cancellations Sheet
- Sends the appropriate alert emails

A broken session looks like the cases above: bot pushes past clear refusals, generates the wrong email draft, makes promises the business can't keep, or quotes dollar values nobody verified.

The goal isn't a bot that never has bugs. It's a bot whose bugs surface fast, get fixed in tightly-scoped PRs, and never compound into multi-week production issues.

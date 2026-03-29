# Tomorrow Decisions In Plain English - 2026-03-28

## What I Already Handled Without You

- I put the safe handoff package into GitHub on `main`.
- I put the full raw archive into GitHub on a separate private archive branch so it is not only on your laptop.
- I fixed a real SMS copy bug:
  - before this fix, a future `50 -> 90` upsell would still text the guest as if it were the `50-minute` service
  - now both the outbound SMS route and the chat-triggered SMS route use the correct service name for the target duration
- I added regression tests for that and ran:
  - focused tests: passing
  - full build: passing

## What I Need You To Decide Or React To

These are the main things I still need your taste, approval, or business call on.

### 1. How should the texts feel?

Plain English:
- Should the bot sound more luxury / polished?
- Or short / direct / transactional?

Why this matters:
- The mechanics now work.
- The next biggest improvement is how the messages feel on a real customer phone.

Current state:
- The texts are functional, but still read more like QA-safe operational copy than premium brand copy.

What I need from you:
- examples of 2-3 texts you love
- examples of 2-3 texts that feel too robotic, too salesy, or too wordy

### 2. Are we ready to actively push the 90-minute upgrade by text?

Plain English:
- The system can now describe `50 -> 90` correctly.
- But that does not automatically mean we should market that path aggressively yet.

Why this matters:
- The 90-minute offer is a bigger jump in both price and appointment time.
- It may need a different tone than the smaller 30-to-50 upgrade.

Current default:
- The code can support it.
- We still need product confidence and QA depth.

What I need from you:
- yes, start treating `50 -> 90` as a normal live upsell
- or no, keep it quieter until we QA it more deeply

### 3. Which add-ons do you actually want the bot to offer automatically?

Plain English:
- Right now the add-on fallback catalog includes:
  - Antioxidant Peel
  - Neck Firming
  - Eye Puff Minimizer
  - Lip Plump and Scrub

Why this matters:
- Just because an add-on is technically easy to attach does not mean it is the right guest experience.
- We should only auto-offer things you are comfortable selling by text without a human conversation first.

What I need from you:
- keep all 4
- cut some of them
- add others
- rank them in the order you want the bot to prefer

### 4. Do you want one reminder text if the guest ignores the first one?

Plain English:
- The system can send one reminder near the one-hour mark before the appointment if the guest does not answer the first offer.

Why this matters:
- A reminder can improve conversion.
- It can also feel pushy if the tone is off.

Current default:
- One reminder is supported by the code.

What I need from you:
- yes, keep one reminder
- no, initial text only
- or yes, but only for certain offer types

### 5. What should we promise when someone replies YES and the system cannot finish instantly?

Plain English:
- Sometimes the guest says YES but the system cannot safely finalize the change on the spot.
- Right now the safe fallback is basically:
  - we got your request
  - our team will confirm before your appointment

Why this matters:
- This is one of the most sensitive pieces of customer trust language.

What I need from you:
- Is that wording acceptable?
- Or do you want something clearer like:
  - "We got your request and will text you shortly if confirmed"
  - or
  - "Our team is reviewing this now"

### 6. How aggressive do you want outbound SMS to become?

Plain English:
- Right now we are mostly in the same-day pre-appointment upsell lane.
- The bigger long-term vision we discussed includes more campaign types.

Future directions already discussed in technical docs:
- more personalized 24-hour upsells
- broader gap-filling campaigns
- empty-chair offers

What I need from you:
- stay conservative for now and perfect the current path
- or start expanding into the broader campaign system soon

### 7. Is GitHub enough for cloud safekeeping, or do you want a second backup too?

Plain English:
- The safe docs are now in GitHub `main`.
- The raw archive is also in GitHub, but on a separate archive branch.

Why this matters:
- This is already much better than leaving it only on your machine.
- But if you want belt-and-suspenders protection, we can mirror the raw archive to a second cloud system too.

What I need from you:
- GitHub-only is fine
- or add a second backup destination later

## Easiest Way To Reply Tomorrow

You do not need to write a long brief.

You can answer like this:

1. Tone: luxury / short / somewhere in between
2. 90-minute upsell: yes or not yet
3. Add-ons to auto-offer: list them in order
4. Reminder text: yes or no
5. YES fallback wording: keep current or rewrite
6. Outbound strategy: conservative or expand
7. Cloud backup: GitHub only or add second backup

## What I Can Keep Doing Once You Answer

- polish the SMS catalog
- tighten add-on QA
- improve reminder behavior
- expand the campaign system carefully

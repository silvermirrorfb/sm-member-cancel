import { describe, it, expect } from 'vitest';
import { getSystemPrompt } from '../src/lib/claude.js';

// Covers the BOOKING SUPPORT flow plus the two content-review items closed alongside it:
// the removed credit-transfer policy and the custom-pause lock. These assert on the prompt
// text because the prompt is the only thing that governs this behavior now that the
// booking/payment canned reply has been retired.

function section(prompt, startMarker, endMarker) {
  const start = prompt.indexOf(startMarker);
  expect(start, `missing section: ${startMarker}`).toBeGreaterThan(-1);
  const end = endMarker ? prompt.indexOf(endMarker, start + startMarker.length) : -1;
  return prompt.slice(start, end > -1 ? end : undefined);
}

describe('system prompt: BOOKING SUPPORT flow', () => {
  const bookingSection = () =>
    section(getSystemPrompt(), 'BOOKING SUPPORT: BOOKING/PAYMENT ISSUE FLOW', 'APPOINTMENT CANCELLATION:');

  it('asks exactly the two capture questions: exact error, and which step', () => {
    const s = bookingSection();
    expect(s).toMatch(/exact error message/i);
    expect(s).toMatch(/while selecting an appointment, or during payment/i);
    expect(s).toMatch(/TWO questions and no more/i);
  });

  it('forbids turning the capture into a form or asking for device details', () => {
    const s = bookingSection();
    expect(s).toMatch(/Do NOT turn this into a form/i);
    expect(s).toMatch(/Do NOT also ask for their device, browser/i);
    expect(s).toMatch(/never ask for it/i);
  });

  it('never asks for card numbers, CVV, or billing details in the capture', () => {
    const s = bookingSection();
    expect(s).toMatch(/Never ask for card numbers, CVV\/CVC, or full billing details/i);
  });

  it('caps troubleshooting at exactly one page-level fix', () => {
    const s = bookingSection();
    expect(s).toMatch(/at MOST ONE page-level fix/i);
    expect(s).toMatch(/refresh the page, or try a different browser or device/i);
    expect(s).toMatch(/entire troubleshooting budget/i);
  });

  it('bans the repeated-troubleshooting loop', () => {
    const s = bookingSection();
    expect(s).toMatch(/Do NOT suggest a second fix/i);
    expect(s).toMatch(/clearing cache/i);
    expect(s).toMatch(/Do NOT ask them to try again and report back/i);
    expect(s).toMatch(/bugs on Silver Mirror's side/i);
  });

  it('escalates with the support number AND the routing confirmation', () => {
    const s = bookingSection();
    expect(s).toMatch(/\(888\) 677-0055/);
    expect(s).toMatch(/passing what you've described to our team/i);
    expect(s).toMatch(/Someone will follow up with you about next steps/i);
  });

  it('promises no timeline, outcome, or fabricated team on escalation', () => {
    const s = bookingSection();
    expect(s).toMatch(/Do NOT promise a timeline, an outcome, or a specific action/i);
    expect(s).toMatch(/HARD RULE - NO FABRICATED ESCALATION/);
    expect(s).not.toMatch(/within 24 hours|within 48 hours|within 24 to 48 hours/i);
    // Fabricated-team names may appear only where the section forbids them.
    const teamMentions = s
      .split('\n')
      .filter(l => /QA team|engineering|ticket number/i.test(l))
      .filter(l => !/no ticket number|no ticket, no|no "engineering"|no named department|Do not embellish/i.test(l));
    expect(teamMentions).toEqual([]);
  });

  it('defines the booking_issue tag with both required fields and the allowed steps', () => {
    const s = bookingSection();
    expect(s).toMatch(/<booking_issue>\{"error_text":/);
    expect(s).toMatch(/"step":"selecting\|payment\|unclear"/);
    expect(s).toMatch(/<\/booking_issue>/);
  });

  it('keeps the tag internal and fires it only once, after a real capture', () => {
    const s = bookingSection();
    expect(s).toMatch(/guest NEVER sees this tag/i);
    expect(s).toMatch(/do not invent error text/i);
    expect(s).toMatch(/not .*more than once per conversation/i);
  });

  it('allows international bookings and gives the local time zone note', () => {
    const s = section(getSystemPrompt(), 'INTERNATIONAL BOOKINGS:', 'APPOINTMENT CANCELLATION:');
    expect(s).toMatch(/welcome/i);
    expect(s).toMatch(/LOCAL time zone of the Silver Mirror location/);
    expect(s).toMatch(/before booking/i);
  });
});

describe('system prompt: gift cards and promo codes stay generic', () => {
  const giftSection = () =>
    section(getSystemPrompt(), 'GIFT CARD AND PROMO RULES THE BOT DOES NOT STATE:', '---');

  it('bans stating stacking, combination, and redemption rules', () => {
    const s = giftSection();
    expect(s).toMatch(/combined or stacked with a promo code/i);
    expect(s).toMatch(/promo codes can be stacked/i);
    expect(s).toMatch(/Redemption limits, partial redemption, expiration/i);
  });

  it('routes to the generic check-the-terms answer with a real channel', () => {
    const s = giftSection();
    expect(s).toMatch(/terms on the card or code are the place to check/i);
    expect(s).toMatch(/hello@silvermirror\.com/);
    expect(s).toMatch(/Do not invent a rule/i);
  });

  it('does not state why a specific code was rejected', () => {
    const s = giftSection();
    expect(s).toMatch(/why a specific code was rejected/i);
  });
});

// The rule heading, not the cross-references to it that appear earlier in the prompt.
const CREDIT_RULE_HEADING = 'HARD RULE - NO INVENTED CREDIT TRANSFER POLICY:\n';
const CREDIT_RULE_END = 'HARD RULE - MEMBER DISCOUNT THREE-CATEGORY STRUCTURE';

describe('system prompt: credit transfer policy removed', () => {
  it('does not state the once-per-year transfer rule as policy anywhere', () => {
    const prompt = getSystemPrompt();
    // The banned wording may only survive inside the rule that bans it and its BAD example.
    const banRuleStart = prompt.indexOf(CREDIT_RULE_HEADING);
    expect(banRuleStart).toBeGreaterThan(-1);
    const banRuleEnd = prompt.indexOf(CREDIT_RULE_END, banRuleStart);
    expect(banRuleEnd).toBeGreaterThan(banRuleStart);
    const outsideTheRule = prompt.slice(0, banRuleStart) + prompt.slice(banRuleEnd);
    expect(outsideTheRule).not.toMatch(/once per year/i);
    expect(outsideTheRule).not.toMatch(/credits can be transferred to someone/i);
    expect(outsideTheRule).not.toMatch(/can be transferred to someone else/i);
  });

  it('drops transfer from the shareable general credit policy list', () => {
    const prompt = getSystemPrompt();
    const s = section(prompt, '- MAY share GENERAL credit policy as policy', 'Banned language for credit-visibility');
    expect(s).toMatch(/90 days from the bill date/);
    expect(s).not.toMatch(/transferred to someone else once per year/i);
    expect(s).toMatch(/not part of the shareable policy set/i);
  });

  it('routes transfer questions to the memberships team instead of answering', () => {
    const s = section(getSystemPrompt(), CREDIT_RULE_HEADING, CREDIT_RULE_END);
    expect(s).toMatch(/MUST NOT state any rule about transferring credits/i);
    expect(s).toMatch(/can I transfer my credits/i);
    expect(s).toMatch(/passing it to our memberships team/i);
    expect(s).toMatch(/Someone will follow up with you about next steps/i);
  });

  it('its GOOD example states no transfer rule', () => {
    const s = section(getSystemPrompt(), CREDIT_RULE_HEADING, CREDIT_RULE_END);
    const good = s.slice(s.indexOf('Example GOOD'));
    expect(good).not.toMatch(/once per year/i);
    expect(good).toMatch(/memberships team/i);
  });
});

describe('system prompt: custom pause lock', () => {
  const pauseSection = () =>
    section(getSystemPrompt(), 'HARD RULE - STANDARD PAUSE LENGTHS ONLY', 'HARD RULE - PAUSE VS CANCEL INTENT BOUNDARY');

  it('offers only the standard 1-month and 2-month pauses', () => {
    const s = pauseSection();
    expect(s).toMatch(/only pause lengths .* are the STANDARD 1-month pause and 2-month pause/i);
  });

  it('bans agreeing to or soft-confirming a custom length', () => {
    const s = pauseSection();
    expect(s).toMatch(/MUST NOT agree to, confirm, set up, or imply approval/i);
    expect(s).toMatch(/3-month pause/i);
    expect(s).toMatch(/6-month pause/i);
    expect(s).toMatch(/should be fine|I don't see why not|That should work/i);
  });

  it('bans proposing a non-standard length itself', () => {
    const s = pauseSection();
    expect(s).toMatch(/never proposes a non-standard length/i);
  });

  it('does not treat a custom request as acceptance of a standard pause', () => {
    const s = pauseSection();
    expect(s).toMatch(/has NOT accepted a 2-month pause/i);
  });

  it('flags the custom request to the team with no approval promise', () => {
    const s = pauseSection();
    expect(s).toMatch(/isn't something I can request from here/i);
    expect(s).toMatch(/passing it to our memberships team/i);
    expect(s).toMatch(/Do not promise the team will approve it/i);
  });

  it('its BAD example is the bot confirming a 3-month pause', () => {
    const s = pauseSection();
    const bad = section(s, 'Example BAD:', 'Example GOOD:');
    expect(bad).toMatch(/I'm setting up a 3-month pause/i);
  });

  it('its GOOD example declines the custom length and discloses the commitment', () => {
    const s = pauseSection();
    const good = s.slice(s.indexOf('Example GOOD:'));
    expect(good).toMatch(/1 month or 2 months/i);
    expect(good).toMatch(/3-billing-cycle commitment/i);
    expect(good).not.toMatch(/setting up a 3-month/i);
  });

  it('the pause-intent trigger list does not license confirming the requested length', () => {
    const prompt = getSystemPrompt();
    const line = prompt.split('\n').find(l => l.includes('"pause for [N] months"'));
    expect(line).toBeDefined();
    expect(line).toMatch(/does not mean the bot may confirm the requested length/i);
  });
});

// Each of these pins a contradiction the codex prompt review found between the new
// sections and a pre-existing rule. Without the fix the model has to resolve the
// conflict at runtime, and it resolves several of them the wrong way.
describe('system prompt: new sections do not contradict the pre-existing hard rules', () => {
  const bookingSection = () =>
    section(getSystemPrompt(), 'BOOKING SUPPORT: BOOKING/PAYMENT ISSUE FLOW', 'APPOINTMENT CANCELLATION:');

  it('defers to billing dispute handling when the guest alleges an actual charge', () => {
    // "the payment screen errored and I was charged twice" must not become a booking capture.
    const s = bookingSection();
    expect(s).toMatch(/SCOPE BOUNDARY, check this FIRST/);
    expect(s).toMatch(/charged twice, duplicate charge, wrong amount, unauthorized charge/i);
    expect(s).toMatch(/HARD RULE - BILLING DISPUTE HANDLING/);
    expect(s).toMatch(/the charge is the priority/i);
  });

  it('does not hand back a channel the guest already tried', () => {
    const s = bookingSection();
    expect(s).toMatch(/EXCEPTION, already-attempted channel/i);
    expect(s).toMatch(/HARD RULE - ALREADY ATTEMPTED CHANNEL/);
    expect(s).toMatch(/Still emit the Step 5 tag/);
  });

  it('is named as a real destination in NO FABRICATED ESCALATION, so the routing claim is true', () => {
    const s = section(
      getSystemPrompt(),
      'HARD RULE - NO FABRICATED ESCALATION:',
      'HARD RULE - NO HUMAN-TEAM SLA PROMISES'
    );
    expect(s).toMatch(/guest support inbox for a captured booking or checkout failure/i);
    expect(s).toMatch(/is therefore a true statement/i);
    // The carve-out must not become a licence to embellish.
    expect(s).toMatch(/no ticket, no queue, no named department, no timeline/i);
  });

  it('the pause-intent handler defers to the standard-lengths rule instead of confirming any duration', () => {
    const prompt = getSystemPrompt();
    const line = prompt.split('\n').find(l => l.includes('If the member opens with a PAUSE intent'));
    expect(line).toBeDefined();
    // The old wording said "Confirm the pause duration the member wants (1-month, 2-month, etc.)"
    // and that "etc." defeated the custom-pause lock.
    expect(line).not.toMatch(/1-month, 2-month, etc\./);
    expect(line).toMatch(/If they ask for ANY other length, do not confirm it/);
    expect(line).toMatch(/HARD RULE - STANDARD PAUSE LENGTHS ONLY/);
  });

  it('no promo copy still tells guests to clear their cache', () => {
    const prompt = getSystemPrompt();
    const offenders = prompt
      .split('\n')
      .filter(l => /clearing your cache|clear your cache/i.test(l))
      .filter(l => !/Do NOT|do not recommend|bans/i.test(l));
    expect(offenders).toEqual([]);
  });

  it('the gift card and promo route respects the already-attempted channel rule', () => {
    const s = section(getSystemPrompt(), 'GIFT CARD AND PROMO RULES THE BOT DOES NOT STATE:', '---');
    expect(s).toMatch(/already tried one of those channels/i);
    expect(s).toMatch(/HARD RULE - ALREADY ATTEMPTED CHANNEL/);
  });
});

describe('system prompt: brand and compliance rules survive the booking changes', () => {
  it('keeps cosmetic-only, facial-bar identity language in the booking section', () => {
    const s = section(getSystemPrompt(), 'BOOKING SUPPORT: BOOKING/PAYMENT ISSUE FLOW', 'APPOINTMENT CANCELLATION:');
    expect(s).not.toMatch(/med-?spa|medical|treatment plan|diagnos/i);
    expect(s).not.toMatch(/HydraFacial/);
  });

  it('adds no em or en dashes to the new sections', () => {
    const prompt = getSystemPrompt();
    // Whole sections, not a fixed-size window: a truncated window silently stops
    // checking partway through. The credit marker must be the rule HEADING, since the
    // bare rule name also appears earlier as a cross-reference.
    const sections = [
      ['BOOKING SUPPORT: BOOKING/PAYMENT ISSUE FLOW', 'APPOINTMENT CANCELLATION:'],
      [CREDIT_RULE_HEADING, CREDIT_RULE_END],
      ['HARD RULE - STANDARD PAUSE LENGTHS ONLY', 'HARD RULE - PAUSE VS CANCEL INTENT BOUNDARY'],
      ['GIFT CARD AND PROMO RULES THE BOT DOES NOT STATE:', '---'],
    ];
    for (const [startMarker, endMarker] of sections) {
      const body = section(prompt, startMarker, endMarker);
      expect(body.length, `empty section: ${startMarker}`).toBeGreaterThan(200);
      expect(body, `em dash in: ${startMarker}`).not.toMatch(/[–—]/);
    }
  });

  it('leaves the FTC cancel-on-request flow intact', () => {
    const prompt = getSystemPrompt();
    // "just cancel" must still be honored; the booking work must not have touched it.
    expect(prompt).toMatch(/HARD RULE - FIRM REFUSAL SHORT-CIRCUIT/);
    expect(prompt).toMatch(/just cancel/i);
    expect(prompt).toMatch(/skip the final-warning loss-framing block and process the cancellation directly/i);
  });

  it('still says 10 locations', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/10 locations/);
    expect(prompt).not.toMatch(/\b9 locations\b|\b11 locations\b/);
  });
});

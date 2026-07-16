import { describe, it, expect } from 'vitest';
import { getSystemPrompt } from '../src/lib/claude.js';

// The bot has NO write access to Boulevard. It cannot cancel, pause, downgrade, or
// switch anyone to bi-monthly; the memberships team executes all of that by hand
// (see CLAUDE.md, "Memberships team executes the actual Boulevard cancellation
// manually. The bot does not cancel anything."). Language like "I'm processing your
// cancellation now" or "I'm setting up the 2-month pause now" claims a completed
// action the bot did not perform. These tests pin the honest framing: the bot
// SUBMITS a request, and the team processes it.
//
// Timeline claims are pinned here too: the bot cannot verify when the team will
// process a request or when a member's final charge lands, so it references the
// written-notice policy generally instead of committing to a day count.

// The prompt has to quote the phrasings it forbids, both as bullets under a "Banned:"
// heading and as the Bot turn of an "Example BAD". Those are the rule working, not the
// rule being broken. Everything else is a real offender: a line the model could copy.
const PROHIBITION = /MUST NOT|Do NOT|Don'?t|Never|Not "|Banned|instead of|rather than|The bot saying|has NO day count/i;

export function linesViolating(text, patterns) {
  const lines = text.split('\n');
  // The header of the blank-line-delimited block a given line sits in.
  const blockHeader = (idx) => {
    let i = idx;
    while (i > 0 && lines[i - 1].trim() !== '') i--;
    return lines[i];
  };
  const underBadExample = (idx) => {
    for (let i = idx; i >= Math.max(0, idx - 6); i--) {
      if (/Example BAD|Example GOOD/i.test(lines[i])) return /Example BAD/i.test(lines[i]);
    }
    return false;
  };
  return lines.filter((line, idx) => {
    if (!patterns.some(p => p.test(line))) return false;
    if (PROHIBITION.test(line)) return false;
    if (PROHIBITION.test(blockHeader(idx))) return false;
    if (underBadExample(idx)) return false;
    return true;
  });
}

function bannedActionClaims(text) {
  return linesViolating(text, [
    /I'?m processing your cancellation/i,
    /I have processed your cancellation/i,
    /I'?ve processed your cancellation/i,
    /I'?m setting up (the|a|your) [^."]*pause/i,
    /I'?m setting up the (downgrade|bi-monthly)/i,
    /I'?ll process your cancellation/i,
    /I will process your cancellation/i,
    /your cancellation (has been|is) processed/i,
    /I'?ve cancelled your membership/i,
    /I'?ve paused your membership/i,
  ]);
}

describe('system prompt: the bot submits requests, it does not execute them', () => {
  it('makes no claim of having processed a cancellation', () => {
    const offenders = bannedActionClaims(getSystemPrompt());
    expect(offenders).toEqual([]);
  });

  it('states the submit framing as the canonical cancellation confirmation', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/submitting your cancellation request to (our|the) memberships team/i);
  });

  it('states the submit framing for an accepted pause', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/submitting your .{0,20}pause request to (our|the) memberships team/i);
  });

  it('has a hard rule naming the lack of write access', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/HARD RULE - THE BOT SUBMITS REQUESTS, IT DOES NOT EXECUTE THEM/);
  });

  it('still confirms a confirmation email will be sent', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/confirmation email summarizing the details/i);
  });
});

describe('system prompt: no unverifiable cancellation timelines', () => {
  it('does not state a 30-day processing time', () => {
    const prompt = getSystemPrompt();
    const offenders = linesViolating(prompt, [
      /processing takes 30 days|Processing time is 30 days|30-day processing|takes the full 30 days/i,
    ]);
    expect(offenders).toEqual([]);
  });

  it('does not attach a day count to the written-notice policy', () => {
    const prompt = getSystemPrompt();
    const offenders = linesViolating(prompt, [
      /\d+\s*days?\s*(of\s*)?written notice|written notice[^.]{0,20}\d+\s*days?/i,
    ]);
    expect(offenders).toEqual([]);
  });

  it('does not describe a 30-day legal notice period', () => {
    const prompt = getSystemPrompt();
    const offenders = linesViolating(prompt, [/30-day legal notice|30 day legal notice/i]);
    expect(offenders).toEqual([]);
  });

  it('still references the written-notice policy in general terms', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/written notice/i);
    expect(prompt).toMatch(/cancel anytime with written notice/i);
  });

  it('bans predicting a specific final charge or end date', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/HARD RULE - NO BILLING DATE PREDICTIONS/);
    const rule = prompt.slice(prompt.indexOf('HARD RULE - NO BILLING DATE PREDICTIONS'));
    expect(rule).toMatch(/cannot see .{0,40}billing (schedule|date)/i);
    expect(rule).toMatch(/no further charges/i);
  });

  it('makes no unhedged next-charge or end-date prediction', () => {
    const prompt = getSystemPrompt();
    const offenders = linesViolating(prompt, [
      /your (membership )?will end (on|after)|no further charges will be made|your next charge will be|you'?ll be charged on/i,
    ]);
    expect(offenders).toEqual([]);
  });

  it('does not disturb the perk claim windows, which are a different 30 days', () => {
    // The $50 Enhancement Credit has a real 30-day claim window. The timeline strip
    // above is about cancellation processing, not perk policy.
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/30-day claim, 60-day use/);
  });

  it('keeps the 90-day credit validity, which is defined published policy', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/credits remain valid for 90 days/i);
  });
});

describe('system prompt: FTC cancel-on-request behavior is untouched', () => {
  it('still honors just cancel and short-circuits after a firm refusal', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/HARD RULE - FIRM REFUSAL SHORT-CIRCUIT/);
    expect(prompt).toMatch(/skip the final-warning loss-framing block and process the cancellation directly/i);
    expect(prompt).toMatch(/just cancel/i);
  });

  it('adds no new pushback or confirmation step before honoring a cancellation', () => {
    const prompt = getSystemPrompt();
    // The submit reframing must not become a chance to re-ask "are you sure?"
    expect(prompt).toMatch(/HARD RULE - THE BOT SUBMITS REQUESTS, IT DOES NOT EXECUTE THEM/);
    const rule = prompt.slice(
      prompt.indexOf('HARD RULE - THE BOT SUBMITS REQUESTS, IT DOES NOT EXECUTE THEM'),
      prompt.indexOf('HARD RULE - THE BOT SUBMITS REQUESTS, IT DOES NOT EXECUTE THEM') + 3000
    );
    expect(rule).toMatch(/not a reason to ask the member to confirm again/i);
  });
});

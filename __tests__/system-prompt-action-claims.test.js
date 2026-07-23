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

// The prompt has to quote the phrasings it forbids: as bullets under a "Banned:"
// heading, and as the Bot turn of an "Example BAD". Those are the rule working, not the
// rule being broken. Everything else is a real offender: a line the model could copy.
//
// Exemptions are STRUCTURAL, never lexical. An earlier version of this helper exempted
// any line containing "Never", "Don't", "instead of", or "Not \"" anywhere in it, and
// took the first line of a blank-line-delimited block as its heading. Measured against
// the pre-change prompt it caught 9 of 22 real offenders: ordinary prose like "Never all
// offers at once" exempted an entire block including two Example GOOD bot turns, and a
// STYLE RULES line carrying both the good wording and a "Not ..." counter-example
// exempted itself. A guard that permissive pins the prose without protecting it.
const BAN_HEADING = /^Banned[.:]|^Banned \(|^Banned patterns|^Additional banned|^What the bot MUST NOT|^The bot MUST NOT/i;

export function linesViolating(text, patterns) {
  const lines = text.split('\n');

  // True only when the line sits under a literal ban heading, up to the next blank line.
  const underBanHeading = (idx) => {
    for (let i = idx; i >= 0; i--) {
      if (lines[i].trim() === '') return false;
      if (BAN_HEADING.test(lines[i].trim())) return true;
    }
    return false;
  };

  // True only inside an Example BAD block, up to the next blank line after it.
  const underBadExample = (idx) => {
    for (let i = idx; i >= 0; i--) {
      if (/^Example (BAD|GOOD)/i.test(lines[i].trim())) return /^Example BAD/i.test(lines[i].trim());
      if (lines[i].trim() === '' && i !== idx) {
        // Allow one blank line between the marker and the block it labels.
        const prev = lines[i - 1] ? lines[i - 1].trim() : '';
        if (!/^Example (BAD|GOOD)/i.test(prev)) return false;
      }
    }
    return false;
  };

  // A line may pair the required wording with a counter-example: `... "good". Not "bad".`
  // Only the part BEFORE `Not "` is the instruction, so only that part is tested.
  const instructionPart = (line) => line.split(/\bNot "/)[0];

  return lines.filter((line, idx) => {
    const subject = instructionPart(line);
    if (!patterns.some(p => p.test(subject))) return false;
    // An explicit self-contained prohibition on the line itself. Case-SENSITIVE on
    // purpose: this prompt writes instructions in caps ("Do NOT", "MUST NOT"), while
    // ordinary bot copy says "Do not worry" and would otherwise excuse itself.
    if (/MUST NOT|Do NOT|DO NOT|Never disclose|Never say|never says|is banned|The bot saying/.test(subject)) return false;
    if (underBanHeading(idx)) return false;
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
    /I'?ll set up (the|a|your)/i,
    /I can set up (the|a|your)/i,
    /set up (here|from here)/i,
    /I'?m setting up the (downgrade|bi-monthly)/i,
    /I'?ll process your cancellation/i,
    /I will process your cancellation/i,
    /your cancellation (has been|is) processed/i,
    /I'?ve cancelled your membership/i,
    /I'?ve paused your membership/i,
  ]);
}

// Tests for the guard itself. A prose-scanning test is only worth its exemptions: too
// strict and it fails on the rule's own ban list, too loose and it silently permits the
// regression it exists to stop. The first version of this helper was the second kind, so
// these pin that it actually bites on the two highest-copy-risk sites in the file.
describe('the action-claim guard actually catches regressions', () => {
  const revert = (from, to) => getSystemPrompt().replace(from, to);

  it('catches a GOOD example reverted to the old pause wording', () => {
    const regressed = revert(
      'Bot: "Got it, Nicole. I\'m submitting your 2-month pause request to our memberships team now.',
      'Bot: "Got it, Nicole. I\'m setting up the 2-month pause now.'
    );
    expect(bannedActionClaims(regressed).length).toBeGreaterThan(0);
  });

  it('catches an instruction line that pairs the old wording with a Not "..." counter-example', () => {
    // This shape self-exempted before: the counter-example token excused the whole line.
    const regressed = revert(
      '- Offer refusal (firm): proceed to processing per HARD RULE - FIRM REFUSAL SHORT-CIRCUIT. "Got it, I\'m submitting your cancellation request to our memberships team now."',
      '- Offer refusal (firm): proceed to processing per HARD RULE - FIRM REFUSAL SHORT-CIRCUIT. "Got it, I\'m processing your cancellation now."'
    );
    expect(bannedActionClaims(regressed).length).toBeGreaterThan(0);
  });

  it('is not fooled by unrelated prose containing the word Never or Do not', () => {
    const regressed = getSystemPrompt().replace(
      'Example BAD:\nMember: "Please just cancel it."',
      'Never all offers at once.\nBot: "Got it. I\'m processing your cancellation now. Do not worry."\n\nExample BAD:\nMember: "Please just cancel it."'
    );
    expect(bannedActionClaims(regressed).length).toBeGreaterThan(0);
  });

  it('still exempts the rule\'s own ban list and Example BAD blocks', () => {
    // The live prompt contains every banned phrasing, inside those two structures.
    expect(bannedActionClaims(getSystemPrompt())).toEqual([]);
    expect(getSystemPrompt()).toMatch(/- "I'm processing your cancellation now"/);
  });
});

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
    expect(rule).toMatch(/cannot see the team's processing queue/i);
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

// Each of these pins a gauntlet finding: a place the new rules were wrong, overshot,
// or contradicted a pre-existing rule.
describe('system prompt: the billing-date rule is honest about what the bot can see', () => {
  const rule = () => {
    const prompt = getSystemPrompt();
    const start = prompt.indexOf('HARD RULE - NO BILLING DATE PREDICTIONS');
    const end = prompt.indexOf('HARD RULE - GUEST DEMANDS AND ULTIMATUMS', start);
    return prompt.slice(start, end);
  };

  it('does not claim the bot cannot see the billing schedule, because it can', () => {
    // boulevard.js injects "Next Charge Date: ..." into every identified member's
    // profile. A rule justified on honesty grounds must not itself be false, and the
    // model can see the contradicting field sitting in its own context.
    const s = rule();
    expect(s).not.toMatch(/cannot see the member's billing schedule/i);
    expect(s).toMatch(/may include a Next Charge Date/i);
    expect(s).toMatch(/It can see that field/);
  });

  it('grounds the ban in what the bot genuinely cannot see', () => {
    const s = rule();
    expect(s).toMatch(/cannot see the team's processing queue/i);
    expect(s).toMatch(/does not do arithmetic on the Next Charge Date/i);
  });

  it('does not tell the bot to deny having billing dates', () => {
    const prompt = getSystemPrompt();
    expect(prompt).not.toMatch(/I don't have visibility into your exact billing dates/i);
  });

  it('does not promise what the confirmation email will contain', () => {
    const prompt = getSystemPrompt();
    // The session-end email goes to the team; the member-facing confirmation is sent
    // by hand. Promising its contents is an outcome promise on a human team's behalf.
    expect(prompt).not.toMatch(/will confirm the exact dates in your confirmation email/i);
    expect(prompt).not.toMatch(/confirmation email will lay out the specifics/i);
    expect(rule()).toMatch(/Do NOT promise what the confirmation email will CONTAIN/);
  });

  it('still promises the email exists, which is the part that is defined policy', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/confirmation email summarizing the details/i);
  });
});

describe('system prompt: no residual claim that the bot sets things up', () => {
  it('the custom-pause rule offers to submit, not to set up', () => {
    const prompt = getSystemPrompt();
    const start = prompt.indexOf('HARD RULE - STANDARD PAUSE LENGTHS ONLY');
    const end = prompt.indexOf('HARD RULE - PAUSE VS CANCEL INTENT BOUNDARY', start);
    const s = prompt.slice(start, end);
    // Its Example GOOD is the highest copy-risk line in the section.
    expect(s).toMatch(/The pause options I can submit for you are 1 month or 2 months/);
    expect(s).not.toMatch(/pause options I can set up here/i);
    expect(s).not.toMatch(/isn't something I can set up from here/i);
  });

  it('drops "Done." from the membership-mode acknowledgments', () => {
    const prompt = getSystemPrompt();
    expect(prompt).not.toMatch(/- "Done\." \(after a processing step\)/);
    expect(prompt).toMatch(/that's submitted/i);
  });

  it('tells the reader that short GOOD examples do not drop the rest of the pattern', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/They are wording samples, not a licence to drop the rest/);
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

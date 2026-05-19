import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// cancel-bot #24 regression. The bot generated a fictional service-quality
// follow-up in the CANCELLED Megan Bruns case (Navy Yard, 2026-05-18):
// "Let me connect you with Karen, our Experience Ambassador at Navy Yard.
// She's specifically trained to ensure members have consistently great
// experiences and could work with you directly on any service concerns."
// Karen is in the LOCATION LEADS ROSTER but at Bryant Park, not Navy Yard.
// The "specifically trained to ensure" / "work with you directly" framing
// is a fabricated connection program with no defined Silver Mirror process.
//
// This is a distinct hallucination class from PR #27 (fabricated escalation):
// PR #27 swept "I've alerted our QA team" style false escalations; this rule
// covers "let me connect you with [named person] at [location]" handoffs that
// invent a person, a title, or a program.
//
// The cancel bot's output is not currently filtered by a runtime validation
// layer, so the strongest signal we can lock in via unit tests is the
// presence of the HARD RULE language, its BAD examples (so future drift on
// the prompt cannot quietly delete them), and the handoff pattern it
// requires the bot to fall back to.

const SYSTEM_PROMPT_PATH = path.join(process.cwd(), 'src', 'lib', 'system-prompt.txt');

function readSystemPrompt() {
  return fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
}

describe('cancel-bot #24: HARD RULE against fabricated staff names, roles, and connection programs', () => {
  it('declares the new HARD RULE in the prompt', () => {
    const prompt = readSystemPrompt();
    expect(prompt).toContain('HARD RULE - NO FABRICATED STAFF NAMES, ROLES, OR CONNECTION PROGRAMS');
  });

  it('names the Megan Bruns production case so future edits know the source', () => {
    const prompt = readSystemPrompt();
    expect(prompt).toContain('Megan Bruns');
    expect(prompt).toContain('2026-05-18');
    expect(prompt).toContain('Navy Yard');
  });

  it('bans cross-location lead assignment', () => {
    const prompt = readSystemPrompt();
    // The rule must say a roster lead may not be assigned to a different location.
    expect(prompt).toMatch(/Karen is at Bryant Park/);
    expect(prompt).toMatch(/lead from the LOCATION LEADS ROSTER to a location OTHER than the one listed/);
  });

  it('bans invented job titles by listing concrete examples', () => {
    const prompt = readSystemPrompt();
    // Each banned title must appear as a BAD example so the model sees the
    // exact pattern it must not invent.
    expect(prompt).toContain('Member Success Manager');
    expect(prompt).toContain('Regional Director');
    // The two documented titles must remain as the only permitted titles.
    expect(prompt).toContain('Experience Ambassador');
    expect(prompt).toContain('Support Ambassador');
  });

  it('bans fabricated connection programs with named individuals', () => {
    const prompt = readSystemPrompt();
    expect(prompt).toMatch(/would love to hear from you/);
    expect(prompt).toMatch(/reach out to you directly/);
    expect(prompt).toMatch(/would definitely value hearing your perspective/);
  });

  it('points the bot at the existing no-defined-process handoff pattern for fallback', () => {
    const prompt = readSystemPrompt();
    // The GOOD example must use the established handoff phrase from
    // HARD RULE - NO DEFINED PROCESS HANDOFFS so we are not introducing a
    // brand new handoff shape.
    expect(prompt).toContain("I'm flagging this for our memberships team to review");
    expect(prompt).toContain('Someone will follow up with you about next steps');
  });

  it('preserves the existing LOCATION LEADS ROSTER (narrow scope, do not delete the roster)', () => {
    const prompt = readSystemPrompt();
    // HARD RULE #16 still requires roster-based lead names. The narrow scope of
    // this fix does not remove the roster; future cross-cutting work may.
    expect(prompt).toContain('LOCATION LEADS ROSTER');
    expect(prompt).toContain('Navy Yard: Nique');
    expect(prompt).toContain('Bryant Park: Karen');
    expect(prompt).toMatch(/Use lead names from roster\. Never generic\./);
  });

  it('does not contradict the existing decision-tree Lead recommendation offers', () => {
    const prompt = readSystemPrompt();
    // Sanity check: the eight decision-tree paths that call for "Lead
    // recommendation" must still be present in the prompt.
    expect(prompt).toMatch(/4\. New Provider: Lead recommendation/);
    expect(prompt).toMatch(/7\. Repetitive: Free add-on . Lead recommendation/);
    expect(prompt).toMatch(/9\. No Results: .* Lead recommendation/);
  });
});

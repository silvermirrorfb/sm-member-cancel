import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// cancel-bot #24 follow-up. Commit 244978f added a narrow HARD RULE against
// cross-location lead assignment and pure fabrication. Travis (Director of
// Operations) then confirmed on 2026-05-19 that the people in the LOCATION
// LEADS ROSTER are real internal staff but act as Lead Estheticians who
// TRAIN other staff; they are not member-facing in a member-outreach
// capacity. "Experience Ambassador" and "Support Ambassador" are internal
// training-team designations.
//
// This follow-up PR strips the named-lead retention play from the
// customer-facing flow entirely:
//   1. "Lead recommendation" removed from every decision-tree path (was in
//      reasons 4, 7, 8, 9, 10, 11, 13, 17, 18, 20).
//   2. "with lead" / "Lead for calming" qualifiers stripped from the tree.
//   3. HARD RULE #16 rewritten to mark the roster as internal-only.
//   4. New HARD RULE - SERVICE QUALITY DISCOVERY STEP added: bot asks ONE
//      open-ended follow-up for vague service-quality complaints (Reasons
//      12, 13, 18) before offering retention or handoff.
//   5. PERMITTED section of the 244978f HARD RULE rewritten to remove the
//      two named-lead allowances; one-line update note in the rule cites
//      Travis's 2026-05-19 operational clarification.
//
// The roster data at lines 428-438 stays in the prompt as internal
// reference; consumption in customer-facing paths is what changed.

const SYSTEM_PROMPT_PATH = path.join(process.cwd(), 'src', 'lib', 'system-prompt.txt');

function readSystemPrompt() {
  return fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
}

describe('cancel-bot #24 follow-up: named-lead retention play removed from customer-facing flow', () => {
  it('removes "Lead recommendation" from every decision-tree path', () => {
    const prompt = readSystemPrompt();
    // None of the numbered reasons should still say "Lead recommendation"
    // as a retention offer. The exact pattern that used to appear was
    // "X. <Name>: ... Lead recommendation ..." in lines 510-527 of the
    // original prompt. We assert the pattern is gone.
    const decisionTreeBlock = prompt.split(/MEMBERSHIP MODE.*DECISION TREE/)[1]?.split(/MEMBERSHIP MODE.*HARD RULES/)[0] ?? '';
    expect(decisionTreeBlock).not.toMatch(/Lead recommendation/);
  });

  it('removes "with lead" and "Lead for calming" qualifiers from the decision tree', () => {
    const prompt = readSystemPrompt();
    const decisionTreeBlock = prompt.split(/MEMBERSHIP MODE.*DECISION TREE/)[1]?.split(/MEMBERSHIP MODE.*HARD RULES/)[0] ?? '';
    expect(decisionTreeBlock).not.toMatch(/Free facial with lead/);
    expect(decisionTreeBlock).not.toMatch(/Free add-on with lead/);
    expect(decisionTreeBlock).not.toMatch(/Lead for calming/);
  });

  it('rewrites HARD RULE #16 to mark the roster as internal-only', () => {
    const prompt = readSystemPrompt();
    // The pre-rewrite line "16. Use lead names from roster. Never generic."
    // must be gone.
    expect(prompt).not.toMatch(/16\. Use lead names from roster\. Never generic\./);
    // The rewritten #16 must explicitly say internal-only and ban surfacing
    // the two titles in member-facing output.
    expect(prompt).toMatch(/16\. The LOCATION LEADS ROSTER \(above\) is INTERNAL reference data only/);
    expect(prompt).toMatch(/[Dd]o NOT name specific leads in member-facing output/);
    expect(prompt).toMatch(/[Dd]o NOT use the titles "Experience Ambassador" or "Support Ambassador" in member-facing output/);
    // Travis cited by date.
    expect(prompt).toMatch(/Travis.*2026-05-19/);
  });

  it('adds HARD RULE - SERVICE QUALITY DISCOVERY STEP', () => {
    const prompt = readSystemPrompt();
    expect(prompt).toContain('HARD RULE - SERVICE QUALITY DISCOVERY STEP');
    // Discovery is ONE question, applied to the three service-quality reasons.
    expect(prompt).toMatch(/ONE open-ended follow-up/);
    expect(prompt).toMatch(/Reasons 12 Front Desk Issues, 13 Inexperienced Esthetician, 18 Inconsistent Experience/);
    // Must include the GOOD/BAD example pair.
    expect(prompt).toMatch(/Could you tell me a bit more about what happened so I can pass the specifics to our team\?/);
    // Must instruct: if member declines, do not ask again.
    expect(prompt).toMatch(/does NOT ask a second time/);
  });

  it('updates the 244978f rule PERMITTED section to remove named-lead allowances', () => {
    const prompt = readSystemPrompt();
    // The two old PERMITTED bullets (recommending a lead, saying the
    // lead's title) must be gone.
    expect(prompt).not.toMatch(/Recommending a lead from the LOCATION LEADS ROSTER for the member's OWN location/);
    expect(prompt).not.toMatch(/Saying the lead's documented title alongside their name/);
    // The new PERMITTED section must list generic team references and the
    // discovery-gated retention path.
    expect(prompt).toMatch(/Generic team references in member-facing output/);
    // Update note must cite the Travis 2026-05-19 clarification.
    expect(prompt).toMatch(/Update note 2026-05-19/);
    expect(prompt).toMatch(/HARD RULE - SERVICE QUALITY DISCOVERY STEP/);
  });

  it('updates the 244978f rule GOOD examples to remove named leads', () => {
    const prompt = readSystemPrompt();
    // The old GOOD example used "Vanessa, our Experience Ambassador at Flatiron"
    // as a permitted recommendation. That example is gone.
    expect(prompt).not.toMatch(/Vanessa, our Experience Ambassador at Flatiron/);
    expect(prompt).not.toMatch(/bot uses Nique, the correct Navy Yard lead/);
    // The Megan Bruns BAD example stays in the file (the production case
    // citation is the rule's anchor).
    expect(prompt).toContain('Megan Bruns');
    expect(prompt).toContain('Navy Yard');
  });

  it('decision tree still has all 20 reasons (no reason was dropped)', () => {
    const prompt = readSystemPrompt();
    const decisionTreeBlock = prompt.split(/MEMBERSHIP MODE.*DECISION TREE/)[1]?.split(/MEMBERSHIP MODE.*HARD RULES/)[0] ?? '';
    for (let i = 1; i <= 20; i++) {
      expect(decisionTreeBlock).toMatch(new RegExp(`^${i}\\. `, 'm'));
    }
  });

  it('decision tree paths for service-quality reasons (12, 13, 18) reference the discovery rule', () => {
    const prompt = readSystemPrompt();
    expect(prompt).toMatch(/12\. Front Desk Issues:.*Discovery question.*HARD RULE - SERVICE QUALITY DISCOVERY STEP/);
    expect(prompt).toMatch(/13\. Inexperienced Esthetician:.*Discovery question.*HARD RULE - SERVICE QUALITY DISCOVERY STEP/);
    expect(prompt).toMatch(/18\. Inconsistent Experience:.*Discovery question.*HARD RULE - SERVICE QUALITY DISCOVERY STEP/);
  });

  it('does not strip the roster data itself (lines around 428-438 stay as internal reference)', () => {
    const prompt = readSystemPrompt();
    expect(prompt).toContain('LOCATION LEADS ROSTER');
    expect(prompt).toContain('Bryant Park: Karen');
    expect(prompt).toContain('Navy Yard: Nique');
    expect(prompt).toContain('Flatiron: Vanessa');
    expect(prompt).toContain('Manhattan West: Missy');
  });

  it('preserves the 244978f HARD RULE (build on top of it, do not remove)', () => {
    const prompt = readSystemPrompt();
    expect(prompt).toContain('HARD RULE - NO FABRICATED STAFF NAMES, ROLES, OR CONNECTION PROGRAMS');
    // Its BAD examples (the actual production hallucinations) stay.
    expect(prompt).toContain('Member Success Manager');
    expect(prompt).toContain('Regional Director');
    // Its production-case anchor stays.
    expect(prompt).toContain('Megan Bruns');
    expect(prompt).toContain('2026-05-18');
  });
});

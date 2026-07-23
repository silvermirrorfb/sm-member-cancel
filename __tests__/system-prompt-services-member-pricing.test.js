import { describe, it, expect } from 'vitest';
import { getSystemPrompt } from '../src/lib/claude.js';
import { WALKIN_PRICES, CURRENT_RATES } from '../src/lib/boulevard.js';

// Prospect conversion: a non-member asking "what services do you offer" should be able
// to see that membership lowers the per-visit cost. Member pricing must be visible in
// General Mode, not only after a member profile is loaded.

function servicesSection() {
  const prompt = getSystemPrompt();
  const start = prompt.indexOf('KNOWLEDGE BASE: SERVICES & PRICING');
  const end = prompt.indexOf('KNOWLEDGE BASE: ADD-ONS');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

describe('system prompt: services menu shows member pricing alongside walk-in', () => {
  it('every facial tier header carries both a walk-in and a member price', () => {
    const s = servicesSection();
    for (const minutes of ['30', '50', '90']) {
      const walkin = `$${WALKIN_PRICES[minutes]}`;
      const member = `$${CURRENT_RATES[minutes]}`;
      const header = s.split('\n').find(l => new RegExp(`^${minutes}-MINUTE FACIALS?\\b`).test(l));
      expect(header, `missing tier header for ${minutes} minutes`).toBeDefined();
      expect(header, `${minutes}-min header missing walk-in price`).toContain(walkin);
      expect(header, `${minutes}-min header missing member price`).toContain(member);
    }
  });

  it('resolves the member prices in General Mode, with no member profile loaded', () => {
    // getSystemPrompt() is the General Mode prompt. If member pricing only resolved in
    // Membership Mode, a prospect would never see it.
    const s = servicesSection();
    expect(s).not.toMatch(/\{\{MEMBER_\d+\}\}/);
    expect(s).not.toMatch(/\{\{WALKIN_\d+\}\}/);
    expect(s).toContain(`$${CURRENT_RATES['50']}`);
  });

  it('tells the bot to quote both price points whenever it quotes a facial price', () => {
    const s = servicesSection();
    expect(s).toMatch(/MEMBER PRICING IS ALWAYS SHOWN/);
    expect(s).toMatch(/quote(s)? a facial price[^.]*both/i);
    expect(s).toMatch(/even when the guest is not a member/i);
  });

  it('carries a members-save line in the overview for prospects', () => {
    const s = servicesSection();
    expect(s).toMatch(/[Mm]embers save on every visit/);
  });

  it('does not gate the member price behind being identified as a member', () => {
    const s = servicesSection();
    expect(s).toMatch(/Do NOT wait until someone says they are a member/i);
  });

  it('keeps the centralized price placeholders as the source of truth', () => {
    // The raw file must still use tokens; only the rendered prompt has dollars in it.
    const fs = require('fs');
    const path = require('path');
    const raw = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'system-prompt.txt'), 'utf-8');
    const start = raw.indexOf('KNOWLEDGE BASE: SERVICES & PRICING');
    const end = raw.indexOf('KNOWLEDGE BASE: ADD-ONS');
    const rawSection = raw.slice(start, end);
    for (const minutes of ['30', '50', '90']) {
      expect(rawSection).toContain(`{{WALKIN_${minutes}}}`);
      expect(rawSection).toContain(`{{MEMBER_${minutes}}}`);
    }
    // No hardcoded dollar amount may shadow the tokens in the tier headers.
    const headers = rawSection.split('\n').filter(l => /^\d+-MINUTE FACIALS?\b/.test(l));
    expect(headers.length).toBe(3);
    for (const h of headers) {
      expect(h, `hardcoded price in header: ${h}`).not.toMatch(/\$\d/);
    }
  });

  it('the first-time recommendation shows both price points', () => {
    // "It's my first time, which facial should I book?" is the prospect question the
    // whole rule exists for, and this line used to answer it with walk-in only.
    const prompt = getSystemPrompt();
    const line = prompt.split('\n').find(l => l.startsWith('- First-time'));
    expect(line).toBeDefined();
    expect(line).toContain(`$${WALKIN_PRICES['30']}`);
    expect(line).toContain(`$${CURRENT_RATES['30']}`);
    expect(line).toContain(`$${WALKIN_PRICES['50']}`);
    expect(line).toContain(`$${CURRENT_RATES['50']}`);
  });

  it('no worked example the bot should copy quotes a facial price without the member price', () => {
    // A GOOD example that quotes walk-in alone teaches the bot to do the same.
    // Example BAD blocks are exempt: two of them record real production failures
    // (the Accutane and multi-condition probes) verbatim, and claude.test.js pins
    // that exact wording. The price is incidental to why those are BAD.
    const prompt = getSystemPrompt();
    const walkin50 = `$${WALKIN_PRICES['50']}`;
    const member50 = `$${CURRENT_RATES['50']}`;
    const lines = prompt.split('\n');
    const underBadExample = (idx) => {
      for (let i = idx; i >= Math.max(0, idx - 4); i--) {
        if (/Example BAD|Example GOOD/i.test(lines[i])) return /Example BAD/i.test(lines[i]);
      }
      return false;
    };
    const offenders = lines.filter((l, idx) =>
      l.includes('Facial') && l.includes(walkin50) && !l.includes(member50) && !underBadExample(idx)
    );
    expect(offenders).toEqual([]);
  });

  it('the style-rule pricing example models both price points, not walk-in alone', () => {
    // The bot copies this example when it lists services, so a single-price example
    // teaches it to quote walk-in only. Assert the actual prices: a bare /member/i
    // match passed even on the old single-price example, because the same line
    // mentions "member" elsewhere.
    const prompt = getSystemPrompt();
    const styleStart = prompt.indexOf('STYLE RULES');
    const styleEnd = prompt.indexOf('MODE', styleStart);
    const style = prompt.slice(styleStart, styleEnd);
    const exampleLine = style.split('\n').find(l => l.includes('Signature Facial'));
    expect(exampleLine).toBeDefined();
    expect(exampleLine).toContain(`$${WALKIN_PRICES['30']} walk-in`);
    expect(exampleLine).toContain(`$${CURRENT_RATES['30']} membership`);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  buildLookupFailureMessage,
  buildPostLookupGreeting,
} from '../src/app/api/chat/message/route.js';

// These tests cover the deterministic, server-side fallback responses in
// src/app/api/chat/message/route.js that bypass Claude entirely. Codex's review
// of the decision-audit branch flagged these as P2 because the prompt's
// HARD RULE - NO HUMAN-TEAM SLA PROMISES could not reach them (the LLM never sees
// these strings). Tests assert: (1) the banned timeline patterns are gone, (2) the
// GOOD generic-handoff pattern is used.
//
// buildSupportIncidentResponse was removed when the booking/payment canned reply was
// retired: booking issues now run through the model via the BOOKING SUPPORT flow in
// system-prompt.txt, so the prompt's SLA rules reach that copy directly. The
// end-to-end source scan at the bottom of this file still guards route.js as a whole.

describe('chat/message route fallback strings: HARD RULE - NO HUMAN-TEAM SLA PROMISES enforcement', () => {
  describe('buildLookupFailureMessage (second-attempt cancellation lookup failure)', () => {
    it('attempt 2 does not promise a specific timeline (either variant)', () => {
      // pickVariant is deterministic for a given seed; we test both seed values
      // explicitly by trying multiple first-name strings to exercise both branches.
      const seedsToTry = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Henry'];
      const variants = new Set();
      for (const name of seedsToTry) {
        variants.add(buildLookupFailureMessage(name, 2));
      }
      // Expect at least both variants observed
      expect(variants.size).toBeGreaterThanOrEqual(2);
      for (const message of variants) {
        expect(message).not.toMatch(/within 24-48 hours/i);
        expect(message).not.toMatch(/within 48 hours/i);
        expect(message).not.toMatch(/within 24 hours/i);
        expect(message).not.toMatch(/replies within \d+/i);
        expect(message).not.toMatch(/respond within \d+/i);
        expect(message).not.toMatch(/follow up within \d+/i);
      }
    });

    it('attempt 2 uses the GOOD generic-handoff pattern (either variant)', () => {
      const seedsToTry = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Henry'];
      const variants = new Set();
      for (const name of seedsToTry) {
        variants.add(buildLookupFailureMessage(name, 2));
      }
      for (const message of variants) {
        expect(message).toMatch(/Someone will follow up with you about next steps/i);
        expect(message).toMatch(/memberships team can (complete|locate)/i);
      }
    });

    it('attempt 1 (first-attempt friendly retry) is unchanged in its non-SLA shape', () => {
      // Attempt 1 historically never carried an SLA promise; this test just locks in
      // that it stays SLA-free if anyone modifies it later.
      const message = buildLookupFailureMessage('Alice', 1);
      expect(message).not.toMatch(/within 24-48 hours/i);
      expect(message).not.toMatch(/within 48 hours/i);
      expect(message).not.toMatch(/aim to respond within/i);
    });

    it('contains no em or en dashes', () => {
      const messages = [
        buildLookupFailureMessage('Alice', 2),
        buildLookupFailureMessage('Bob', 2),
        buildLookupFailureMessage('Alice', 1),
      ];
      for (const message of messages) {
        expect(message).not.toMatch(/[–—]/);
      }
    });
  });

  describe('buildPostLookupGreeting (inactive account + cancel intent fallback)', () => {
    function inactiveProfile() {
      return {
        firstName: 'Sample',
        location: 'Flatiron',
        tier: '50',
        monthlyRate: 99,
        memberSince: 'September 2023',
        tenureMonths: 12,
        accountStatus: 'inactive',
        computed: {},
      };
    }

    it('inactive + cancel intent does not promise a specific timeline', () => {
      const greeting = buildPostLookupGreeting(inactiveProfile(), 'I want to cancel my membership');
      expect(greeting).not.toMatch(/within 24-48 hours/i);
      expect(greeting).not.toMatch(/within 48 hours/i);
      expect(greeting).not.toMatch(/within 24 hours/i);
      expect(greeting).not.toMatch(/follow up within \d+/i);
    });

    it('inactive + cancel intent uses the GOOD generic-handoff pattern', () => {
      const greeting = buildPostLookupGreeting(inactiveProfile(), 'I want to cancel my membership');
      expect(greeting).toMatch(/Someone will follow up with you about next steps/i);
      expect(greeting).toMatch(/memberships team/i);
      expect(greeting).toMatch(/inactive/i); // still acknowledges the inactive state
    });

    it('inactive + cancel intent contains no em or en dashes', () => {
      const greeting = buildPostLookupGreeting(inactiveProfile(), 'I want to cancel my membership');
      expect(greeting).not.toMatch(/[–—]/);
    });
  });

  describe('end-to-end: no banned SLA pattern in any deterministic chat-fallback string', () => {
    it('scans the route.js source file for residual SLA patterns outside comments and BAD examples', () => {
      const filePath = path.join(process.cwd(), 'src', 'app', 'api', 'chat', 'message', 'route.js');
      const source = fs.readFileSync(filePath, 'utf-8');
      const lines = source.split('\n');
      const banned = [
        /within 24[-\s]?48 hours/i,
        /within 48 hours/i,
        /within 24 hours/i,
        /aim to respond within/i,
        /respond within \d+ (hours?|business days?)/i,
        /alerted (our )?QA team/i,
      ];
      const offenders = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comment-only lines and lines explicitly marked BAD / banned in comments
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        for (const pattern of banned) {
          if (pattern.test(line)) {
            offenders.push(`L${i + 1}: ${line.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetOutboundQueueForTests,
  enqueueOutboundCandidate,
  getOutboundQueueSnapshot,
  popDueCandidates,
} from '../src/lib/sms-outbound-queue.js';

describe('sms outbound queue', () => {
  beforeEach(() => {
    __resetOutboundQueueForTests();
  });

  it('dedupes identical payloads', () => {
    const payload = { candidate: { firstName: 'A', lastName: 'B', email: 'a@example.com' } };
    const first = enqueueOutboundCandidate(payload, { runAfter: '2026-03-10T14:00:00Z' });
    const second = enqueueOutboundCandidate(payload, { runAfter: '2026-03-10T14:00:00Z' });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(getOutboundQueueSnapshot().size).toBe(1);
  });

  it('pops only due items', () => {
    enqueueOutboundCandidate(
      { candidate: { firstName: 'Soon', lastName: 'One', email: 'soon@example.com' } },
      { runAfter: '2026-03-10T09:00:00Z' },
    );
    enqueueOutboundCandidate(
      { candidate: { firstName: 'Later', lastName: 'Two', email: 'later@example.com' } },
      { runAfter: '2026-03-10T11:00:00Z' },
    );

    const due = popDueCandidates({ now: '2026-03-10T10:00:00Z', limit: 10 });
    expect(due.length).toBe(1);
    expect(getOutboundQueueSnapshot().size).toBe(1);
  });
});

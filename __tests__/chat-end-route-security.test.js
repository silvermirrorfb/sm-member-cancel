import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Security regression suite for the 2026-07-01 white-box pen test, VULN-1
// (member-profile injection on POST /api/chat/end).
//
// The route must NEVER elevate a session to a "membership" outcome from data
// supplied in the request body. Membership status is established only by the
// server-side Boulevard lookup during the live conversation (which populates
// session.memberProfile in the session store). A caller who supplies
// body.memberProfile / body.summary must resolve to a GENERAL outcome with no
// ops email and no cancellations-sheet write.

const mockGetSession = vi.fn();
const mockCreateSession = vi.fn();
const mockAddMessage = vi.fn();
const mockCompleteSession = vi.fn();
const mockSaveSession = vi.fn();
const mockSendMessage = vi.fn();
const mockParseSessionSummary = vi.fn();
const mockStripSummaryFromResponse = vi.fn();
const mockProcessConversationEnd = vi.fn();

vi.mock('../src/lib/sessions.js', () => ({
  getSession: (...args) => mockGetSession(...args),
  createSession: (...args) => mockCreateSession(...args),
  addMessage: (...args) => mockAddMessage(...args),
  completeSession: (...args) => mockCompleteSession(...args),
  saveSession: (...args) => mockSaveSession(...args),
}));

vi.mock('../src/lib/claude.js', () => ({
  sendMessage: (...args) => mockSendMessage(...args),
  parseSessionSummary: (...args) => mockParseSessionSummary(...args),
  stripSummaryFromResponse: (...args) => mockStripSummaryFromResponse(...args),
}));

vi.mock('../src/lib/notify.js', () => ({
  processConversationEnd: (...args) => mockProcessConversationEnd(...args),
}));

import { POST } from '../src/app/api/chat/end/route.js';

const ATTACKER_PROFILE = {
  name: 'Attacker Injected',
  email: 'attacker@evil.test',
  phone: '+15550000000',
  location: 'Union Square',
  tier: 'Unlimited',
  monthlyRate: 199,
  tenureMonths: 12,
};

const ATTACKER_SUMMARY = {
  client_name: 'Attacker Injected',
  email: 'attacker@evil.test',
  phone: '+15550000000',
  location: 'Union Square',
  membership_tier: 'Unlimited',
  monthly_rate: 199,
  tenure_months: 12,
  outcome: 'CANCELLED',
};

function endRequest(body) {
  return new Request('http://localhost/api/chat/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/chat/end — VULN-1 member-profile injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompleteSession.mockResolvedValue({});
    mockSaveSession.mockResolvedValue({});
    mockAddMessage.mockResolvedValue({});
    mockProcessConversationEnd.mockResolvedValue({ emailed: true, logged: true });
    mockStripSummaryFromResponse.mockImplementation(value => String(value || ''));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('(a) rejects body.memberProfile on the session-recovery path → GENERAL, no email, no sheet row', async () => {
    // Serverless rotation: session not found, client resends history to recover.
    mockGetSession.mockResolvedValue(null);
    mockCreateSession.mockResolvedValue({
      id: 'sess-recover',
      memberProfile: null,
      mode: 'general',
      messages: [],
    });
    // If the injection were still live, the route would call Claude here.
    mockSendMessage.mockResolvedValue('<session_summary></session_summary>');
    mockParseSessionSummary.mockReturnValue({ ...ATTACKER_SUMMARY });

    const res = await POST(endRequest({
      sessionId: 'sess-recover',
      history: [{ role: 'user', content: 'I want to cancel my membership' }],
      memberProfile: ATTACKER_PROFILE,
      summary: ATTACKER_SUMMARY,
    }));
    const json = await res.json();

    expect(json.outcome).toBe('GENERAL');
    expect(mockProcessConversationEnd).not.toHaveBeenCalled();
    expect(mockCompleteSession).toHaveBeenCalledWith('sess-recover', 'GENERAL', null);
  });

  it('(a) rejects body.memberProfile on an existing session with no server-side member → GENERAL, no email, no sheet row', async () => {
    mockGetSession.mockResolvedValue({
      id: 'sess-existing',
      memberProfile: null,
      mode: 'general',
      summary: null,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello there' }],
    });
    mockSendMessage.mockResolvedValue('<session_summary></session_summary>');
    mockParseSessionSummary.mockReturnValue({ ...ATTACKER_SUMMARY });

    const res = await POST(endRequest({
      sessionId: 'sess-existing',
      memberProfile: ATTACKER_PROFILE,
      summary: ATTACKER_SUMMARY,
    }));
    const json = await res.json();

    expect(json.outcome).toBe('GENERAL');
    expect(mockProcessConversationEnd).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockCompleteSession).toHaveBeenCalledWith('sess-existing', 'GENERAL', null);
  });

  it('(c) a genuine server-side Boulevard member still elevates to a membership outcome (email + sheet)', async () => {
    // memberProfile is present because the live conversation resolved it via
    // the server-side Boulevard lookup — this is the legitimate path.
    mockGetSession.mockResolvedValue({
      id: 'sess-member',
      memberProfile: {
        name: 'Real Member',
        email: 'real@member.test',
        location: 'Flatiron',
        tier: 'Unlimited',
      },
      mode: 'membership',
      systemPrompt: 'sys',
      summary: {
        client_name: 'Real Member',
        outcome: 'RETAINED',
        location: 'Flatiron',
        membership_tier: 'Unlimited',
      },
      messages: [
        { role: 'user', content: 'I am thinking about cancelling' },
        { role: 'assistant', content: 'I understand, let me help.' },
      ],
    });

    const res = await POST(endRequest({ sessionId: 'sess-member' }));
    const json = await res.json();

    expect(json.outcome).toBe('RETAINED');
    expect(mockProcessConversationEnd).toHaveBeenCalledTimes(1);
    expect(mockCompleteSession).toHaveBeenCalledWith(
      'sess-member',
      'RETAINED',
      expect.objectContaining({ outcome: 'RETAINED' }),
    );
  });
});

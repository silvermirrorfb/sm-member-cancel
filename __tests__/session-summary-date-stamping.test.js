import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// cancel-bot #22 regression suite. The bot was emitting a session_summary.date
// field that downstream code (notify.js) wrote verbatim to the Cancellations
// Google Sheet. Production cases:
//   - Zoe Dickinson (actual May 7 2026) logged as 2024-12-19
//   - Sindhura Polepalli (actual May 10 2026) logged as 2025-01-27
// The fix has three parts: strip date from the bot's output schema, stamp
// date server-side at session end, and a defense-in-depth fallback in
// notify.js for any session that bypasses the stamping path.

const SYSTEM_PROMPT_PATH = path.join(process.cwd(), 'src', 'lib', 'system-prompt.txt');

function readSystemPrompt() {
  return fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
}

function todayInEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

describe('cancel-bot #22: system prompt no longer instructs the bot to emit a date', () => {
  it('removes the "date" field from the session_summary JSON schema', () => {
    const prompt = readSystemPrompt();
    // The pre-fix schema started with `"date": "[ISO date]",` as the first
    // field of session_summary. Make sure that is gone.
    expect(prompt).not.toMatch(/"date"\s*:\s*"\[ISO date\]"/);
  });

  it('keeps the rest of the session_summary schema intact (preservation)', () => {
    const prompt = readSystemPrompt();
    expect(prompt).toContain('<session_summary>');
    expect(prompt).toContain('"client_name"');
    expect(prompt).toContain('"outcome"');
    expect(prompt).toContain('"reason_primary"');
    expect(prompt).toContain('"reason_verbatim"');
  });

  it('explicitly tells the bot not to include a date field', () => {
    const prompt = readSystemPrompt();
    expect(prompt).toContain('HARD RULE - SESSION SUMMARY DATE FIELD');
    expect(prompt).toMatch(/Do NOT include a "date" field/);
    expect(prompt).toMatch(/set server-side/i);
  });

  it('cites the production cases that motivated the rule', () => {
    const prompt = readSystemPrompt();
    expect(prompt).toContain('Zoe Dickinson');
    expect(prompt).toContain('2024-12-19');
    expect(prompt).toContain('Sindhura Polepalli');
    expect(prompt).toContain('2025-01-27');
  });
});

describe('cancel-bot #22: notify.js safeIsoDate defense in depth', () => {
  it('passes through a valid YYYY-MM-DD value', async () => {
    const { safeIsoDate } = await import('../src/lib/notify.js');
    expect(safeIsoDate('2026-05-15')).toBe('2026-05-15');
  });

  it('returns today (Eastern) when the value is missing', async () => {
    const { safeIsoDate } = await import('../src/lib/notify.js');
    expect(safeIsoDate(undefined)).toBe(todayInEastern());
    expect(safeIsoDate(null)).toBe(todayInEastern());
    expect(safeIsoDate('')).toBe(todayInEastern());
  });

  it('returns today when the value is a malformed string', async () => {
    const { safeIsoDate } = await import('../src/lib/notify.js');
    expect(safeIsoDate('not-a-date')).toBe(todayInEastern());
    expect(safeIsoDate('May 7, 2026')).toBe(todayInEastern());
    expect(safeIsoDate('2026/05/15')).toBe(todayInEastern());
    expect(safeIsoDate('20260515')).toBe(todayInEastern());
  });

  it('returns today when the value is a non-string', async () => {
    const { safeIsoDate } = await import('../src/lib/notify.js');
    expect(safeIsoDate(0)).toBe(todayInEastern());
    expect(safeIsoDate(new Date())).toBe(todayInEastern());
    expect(safeIsoDate({})).toBe(todayInEastern());
  });

  it('output is always YYYY-MM-DD format', async () => {
    const { safeIsoDate } = await import('../src/lib/notify.js');
    expect(safeIsoDate(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(safeIsoDate('not-a-date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(safeIsoDate('2026-05-15')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('preserves a valid date even if it is from a prior year (legitimate value)', async () => {
    const { safeIsoDate } = await import('../src/lib/notify.js');
    // We can't tell the difference between a hallucinated wrong-year date
    // (e.g. bot emits 2024-12-19) and a legitimate prior-year session that
    // is being re-processed late, so pattern-matching is the safe contract.
    // Server-side stamping (Edit B) is what actually prevents the wrong-year
    // value from being passed in the first place.
    expect(safeIsoDate('2024-12-19')).toBe('2024-12-19');
  });

  it('trims leading/trailing whitespace from valid values', async () => {
    const { safeIsoDate } = await import('../src/lib/notify.js');
    expect(safeIsoDate('  2026-05-15  ')).toBe('2026-05-15');
  });
});

describe('cancel-bot #22: end-of-session handler stamps date server-side', () => {
  const originalEnv = process.env;
  const mockGetSession = vi.fn();
  const mockCreateSession = vi.fn();
  const mockAddMessage = vi.fn();
  const mockCompleteSession = vi.fn();
  const mockSaveSession = vi.fn();
  const mockSendMessage = vi.fn();
  const mockParseSessionSummary = vi.fn();
  const mockProcessConversationEnd = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };

    vi.doMock('../src/lib/sessions.js', () => ({
      getSession: (...args) => mockGetSession(...args),
      createSession: (...args) => mockCreateSession(...args),
      addMessage: (...args) => mockAddMessage(...args),
      completeSession: (...args) => mockCompleteSession(...args),
      saveSession: (...args) => mockSaveSession(...args),
    }));

    vi.doMock('../src/lib/claude.js', () => ({
      sendMessage: (...args) => mockSendMessage(...args),
      parseSessionSummary: (...args) => mockParseSessionSummary(...args),
      stripSummaryFromResponse: (value) => String(value || ''),
    }));

    vi.doMock('../src/lib/notify.js', () => ({
      processConversationEnd: (...args) => mockProcessConversationEnd(...args),
    }));

    mockProcessConversationEnd.mockResolvedValue({
      email: { sent: true },
      sheet: { logged: true },
      alert: { sent: false },
    });
    mockCompleteSession.mockResolvedValue(undefined);
    mockSaveSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  function makeMembershipSession(overrides = {}) {
    return {
      id: 'sess-cancel-bot-22',
      mode: 'membership',
      memberProfile: {
        name: 'Test Member',
        email: 'test@example.com',
        phone: '5550001111',
        location: 'Bryant Park',
        tier: '50',
        monthlyRate: 199,
        tenureMonths: 18,
      },
      messages: [
        { role: 'user', content: 'I want to cancel.' },
        { role: 'assistant', content: 'Ok.' },
      ],
      systemPrompt: 'system',
      ...overrides,
    };
  }

  function makeRequest(body) {
    return new Request('http://localhost/api/chat/end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('stamps today (Eastern, YYYY-MM-DD) when the bot omitted the date field', async () => {
    const session = makeMembershipSession({
      summary: {
        // No date field, like the new bot output should look.
        client_name: 'Test Member',
        email: 'test@example.com',
        outcome: 'CANCELLED',
        reason_primary: 'Cost',
        reason_verbatim: 'Too expensive',
      },
    });
    mockGetSession.mockResolvedValue(session);

    const { POST } = await import('../src/app/api/chat/end/route.js');
    const res = await POST(makeRequest({ sessionId: session.id }));
    expect(res.status).toBe(200);

    expect(mockProcessConversationEnd).toHaveBeenCalledTimes(1);
    const passedSummary = mockProcessConversationEnd.mock.calls[0][0];
    expect(passedSummary.date).toBe(todayInEastern());
    expect(passedSummary.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('overwrites a hallucinated bot-supplied date (Zoe Dickinson regression)', async () => {
    const session = makeMembershipSession({
      summary: {
        // The Zoe production case: actual session was May 7 2026, bot emitted 2024-12-19.
        date: '2024-12-19',
        client_name: 'Zoe Dickinson',
        email: 'zoe@example.com',
        outcome: 'REFERRED',
        reason_primary: 'Missing milestone rewards',
        reason_verbatim: 'I never got my perks',
      },
    });
    mockGetSession.mockResolvedValue(session);

    const { POST } = await import('../src/app/api/chat/end/route.js');
    await POST(makeRequest({ sessionId: session.id }));

    const passedSummary = mockProcessConversationEnd.mock.calls[0][0];
    expect(passedSummary.date).toBe(todayInEastern());
    expect(passedSummary.date).not.toBe('2024-12-19');
  });

  it('overwrites a hallucinated bot-supplied date (Sindhura Polepalli regression)', async () => {
    const session = makeMembershipSession({
      summary: {
        // The Sindhura production case: actual session May 10 2026, bot emitted 2025-01-27.
        date: '2025-01-27',
        client_name: 'Sindhura Polepalli',
        email: 'sindhura@example.com',
        outcome: 'REFERRED',
        reason_primary: 'Technical issue',
        reason_verbatim: 'My credits disappeared',
      },
    });
    mockGetSession.mockResolvedValue(session);

    const { POST } = await import('../src/app/api/chat/end/route.js');
    await POST(makeRequest({ sessionId: session.id }));

    const passedSummary = mockProcessConversationEnd.mock.calls[0][0];
    expect(passedSummary.date).toBe(todayInEastern());
    expect(passedSummary.date).not.toBe('2025-01-27');
  });

  it('still stamps date when summary comes from the fallback path (Claude failure)', async () => {
    const session = makeMembershipSession({ summary: undefined });
    mockGetSession.mockResolvedValue(session);
    mockSendMessage.mockRejectedValue(new Error('Claude API down'));

    const { POST } = await import('../src/app/api/chat/end/route.js');
    await POST(makeRequest({ sessionId: session.id }));

    const passedSummary = mockProcessConversationEnd.mock.calls[0][0];
    expect(passedSummary.outcome).toBe('INCOMPLETE'); // fallback path fired
    expect(passedSummary.date).toBe(todayInEastern());
    expect(passedSummary.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('preserves all other summary fields (no scope creep)', async () => {
    const session = makeMembershipSession({
      summary: {
        date: 'whatever-the-bot-said',
        client_name: 'Test Member',
        email: 'test@example.com',
        outcome: 'RETAINED',
        reason_primary: 'Travel',
        reason_verbatim: 'Going to Italy',
        offer_accepted: '2-month pause',
        commitment_disclosed: true,
        offers_presented: ['1-month pause', '2-month pause'],
        member_sentiment: 'satisfied',
      },
    });
    mockGetSession.mockResolvedValue(session);

    const { POST } = await import('../src/app/api/chat/end/route.js');
    await POST(makeRequest({ sessionId: session.id }));

    const passed = mockProcessConversationEnd.mock.calls[0][0];
    expect(passed.client_name).toBe('Test Member');
    expect(passed.outcome).toBe('RETAINED');
    expect(passed.reason_primary).toBe('Travel');
    expect(passed.reason_verbatim).toBe('Going to Italy');
    expect(passed.offer_accepted).toBe('2-month pause');
    expect(passed.commitment_disclosed).toBe(true);
    expect(passed.offers_presented).toEqual(['1-month pause', '2-month pause']);
    expect(passed.member_sentiment).toBe('satisfied');
  });

  it('does not stamp date for general (non-membership) conversations', async () => {
    const generalSession = {
      id: 'sess-general',
      mode: 'general',
      memberProfile: null,
      messages: [],
    };
    mockGetSession.mockResolvedValue(generalSession);

    const { POST } = await import('../src/app/api/chat/end/route.js');
    const res = await POST(makeRequest({ sessionId: generalSession.id }));
    expect(res.status).toBe(200);

    // General conversations bypass notify entirely.
    expect(mockProcessConversationEnd).not.toHaveBeenCalled();
  });
});

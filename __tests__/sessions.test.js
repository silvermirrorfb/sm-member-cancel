import { beforeEach, describe, it, expect } from 'vitest';
import {
  createSession,
  getSession,
  addMessage,
  completeSession,
  __resetSessionStoreForTests,
} from '../src/lib/sessions.js';

describe('sessions', () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
  });

  it('creates a session with a generated ID', async () => {
    const session = await createSession(null, null);
    expect(session.id).toBeTruthy();
    expect(session.status).toBe('active');
    expect(session.messages).toEqual([]);
    expect(session.chatTranscriptStarted).toBe(false);
    expect(session.lastProcessedUserFingerprint).toBeNull();
    expect(session.lastAssistantVisibleMessage).toBeNull();
  });

  it('creates a session with a provided ID (recovery)', async () => {
    const session = await createSession(null, null, 'test-recovery-id');
    expect(session.id).toBe('test-recovery-id');
    expect(session.status).toBe('active');
  });

  it('retrieves a session by ID', async () => {
    const session = await createSession(null, null, 'get-test');
    const retrieved = await getSession('get-test');
    expect(retrieved).toBeTruthy();
    expect(retrieved.id).toBe('get-test');
  });

  it('returns null for unknown session', async () => {
    await expect(getSession('nonexistent-id')).resolves.toBeNull();
  });

  it('adds messages to a session', async () => {
    const session = await createSession(null, null, 'msg-test');
    await addMessage('msg-test', 'user', 'Hello');
    await addMessage('msg-test', 'assistant', 'Hi there!');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[1].role).toBe('assistant');
    expect(session.lastAssistantVisibleMessage).toBe('Hi there!');
    expect(session.lastAssistantAt).toBeTruthy();
  });

  it('completes a session with outcome', async () => {
    await createSession(null, null, 'complete-test');
    const result = await completeSession('complete-test', 'RETAINED', { outcome: 'RETAINED' });
    expect(result.status).toBe('completed');
    expect(result.outcome).toBe('RETAINED');
  });
});

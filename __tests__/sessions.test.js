import { describe, it, expect } from 'vitest';
import {
  createSession,
  getSession,
  addMessage,
  completeSession,
} from '../src/lib/sessions.js';

describe('sessions', () => {
  it('creates a session with a generated ID', () => {
    const session = createSession(null, null);
    expect(session.id).toBeTruthy();
    expect(session.status).toBe('active');
    expect(session.messages).toEqual([]);
    expect(session.chatTranscriptStarted).toBe(false);
    expect(session.lastProcessedUserFingerprint).toBeNull();
    expect(session.lastAssistantVisibleMessage).toBeNull();
  });

  it('creates a session with a provided ID (recovery)', () => {
    const session = createSession(null, null, 'test-recovery-id');
    expect(session.id).toBe('test-recovery-id');
    expect(session.status).toBe('active');
  });

  it('retrieves a session by ID', () => {
    const session = createSession(null, null, 'get-test');
    const retrieved = getSession('get-test');
    expect(retrieved).toBeTruthy();
    expect(retrieved.id).toBe('get-test');
  });

  it('returns null for unknown session', () => {
    expect(getSession('nonexistent-id')).toBeNull();
  });

  it('adds messages to a session', () => {
    const session = createSession(null, null, 'msg-test');
    addMessage('msg-test', 'user', 'Hello');
    addMessage('msg-test', 'assistant', 'Hi there!');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[1].role).toBe('assistant');
    expect(session.lastAssistantVisibleMessage).toBe('Hi there!');
    expect(session.lastAssistantAt).toBeTruthy();
  });

  it('completes a session with outcome', () => {
    createSession(null, null, 'complete-test');
    const result = completeSession('complete-test', 'RETAINED', { outcome: 'RETAINED' });
    expect(result.status).toBe('completed');
    expect(result.outcome).toBe('RETAINED');
  });
});

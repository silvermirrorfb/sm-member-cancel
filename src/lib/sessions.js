// In-memory session store. For production, replace with Redis or a database.
// Sessions auto-expire after 30 minutes of inactivity.

import { v4 as uuidv4 } from 'uuid';

const sessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function createSession(memberId, memberProfile) {
  const sessionId = uuidv4();
  const session = {
    id: sessionId,
    memberId,
    memberProfile,
    messages: [], // Claude conversation history
    outcome: null,
    summary: null,
    createdAt: new Date(),
    lastActivity: new Date(),
    status: 'active', // active | completed | abandoned | error
  };
  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  // Check timeout
  const elapsed = Date.now() - session.lastActivity.getTime();
  if (elapsed > SESSION_TIMEOUT_MS && session.status === 'active') {
    session.status = 'abandoned';
  }

  return session;
}

function updateActivity(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivity = new Date();
  }
}

function addMessage(sessionId, role, content) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.messages.push({ role, content });
  session.lastActivity = new Date();
  return session;
}

function completeSession(sessionId, outcome, summary) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.outcome = outcome;
  session.summary = summary;
  session.status = 'completed';
  return session;
}

function getAllActiveSessions() {
  const active = [];
  for (const [id, session] of sessions) {
    if (session.status === 'active') {
      active.push({ id, memberId: session.memberId, createdAt: session.createdAt, lastActivity: session.lastActivity });
    }
  }
  return active;
}

// Cleanup old sessions every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - (2 * 60 * 60 * 1000); // 2 hours
  for (const [id, session] of sessions) {
    if (session.lastActivity.getTime() < cutoff) {
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);


export {
  createSession,
  getSession,
  updateActivity,
  addMessage,
  completeSession,
  getAllActiveSessions,
};

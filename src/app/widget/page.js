'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

const API_BASE = typeof window !== 'undefined'
  ? `${window.location.origin}/api/chat`
  : '/api/chat';

// ââ STYLES ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const BRIGHT_BLUE = '#50aaf2';
const LIGHT_BLUE = '#d6ebff';
const BLACK = '#1a1a1a';
const WHITE = '#FFFFFF';
const BORDER = '#e2e8f0';
const TEXT = '#1a1a1a';
const TEXT_LIGHT = '#6b7280';
const BG_SUBTLE = '#f8fafc';

const styles = {
  container: {
    fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif",
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: WHITE,
    color: TEXT,
    maxWidth: 520,
    margin: '0 auto',
    overflow: 'hidden',
  },
  header: {
    background: WHITE,
    color: BLACK,
    padding: '16px 24px',
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    flexShrink: 0,
    borderBottom: `1px solid ${BORDER}`,
  },
  headerLogo: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    objectFit: 'cover',
    flexShrink: 0,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 600,
    margin: 0,
    color: BLACK,
    letterSpacing: 0.3,
  },
  headerSub: {
    fontSize: 12,
    color: BRIGHT_BLUE,
    margin: 0,
    fontWeight: 500,
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    background: BG_SUBTLE,
  },
  msgBot: {
    background: WHITE,
    border: `1px solid ${BORDER}`,
    borderRadius: '18px 18px 18px 4px',
    padding: '12px 16px',
    maxWidth: '85%',
    fontSize: 14,
    lineHeight: 1.55,
    alignSelf: 'flex-start',
    color: TEXT,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  msgUser: {
    background: BRIGHT_BLUE,
    color: WHITE,
    borderRadius: '18px 18px 4px 18px',
    padding: '12px 16px',
    maxWidth: '80%',
    fontSize: 14,
    lineHeight: 1.55,
    alignSelf: 'flex-end',
  },
  typing: {
    background: LIGHT_BLUE,
    border: `1px solid ${BORDER}`,
    borderRadius: '18px 18px 18px 4px',
    padding: '12px 16px',
    maxWidth: '85%',
    alignSelf: 'flex-start',
    fontSize: 14,
    color: BRIGHT_BLUE,
  },
  inputArea: {
    padding: '12px 16px 20px',
    background: WHITE,
    borderTop: `1px solid ${BORDER}`,
    flexShrink: 0,
  },
  inputRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    border: `1px solid ${BORDER}`,
    borderRadius: 24,
    padding: '12px 18px',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
    resize: 'none',
    lineHeight: 1.4,
    maxHeight: 120,
    color: TEXT,
    transition: 'border-color 0.2s',
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: '50%',
    background: BRIGHT_BLUE,
    color: WHITE,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    flexShrink: 0,
    transition: 'opacity 0.2s',
  },
  sendBtnDisabled: {
    opacity: 0.4,
    cursor: 'default',
  },
  authContainer: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '32px 24px',
    background: WHITE,
  },
  authTitle: {
    fontSize: 22,
    fontWeight: 600,
    color: BLACK,
    marginBottom: 8,
    textAlign: 'center',
  },
  authSub: {
    fontSize: 14,
    color: TEXT_LIGHT,
    marginBottom: 28,
    textAlign: 'center',
    lineHeight: 1.5,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: 500,
    color: TEXT,
    marginBottom: 6,
    display: 'block',
  },
  fieldInput: {
    width: '100%',
    border: `1px solid ${BORDER}`,
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
    marginBottom: 16,
    boxSizing: 'border-box',
    color: TEXT,
    transition: 'border-color 0.2s',
  },
  authBtn: {
    width: '100%',
    background: BRIGHT_BLUE,
    color: WHITE,
    border: 'none',
    borderRadius: 10,
    padding: '14px',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    letterSpacing: 0.3,
    transition: 'opacity 0.2s',
  },
  authError: {
    background: '#FFF3F0',
    border: '1px solid #FFCCC7',
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 13,
    color: '#C41E3A',
    marginBottom: 16,
    lineHeight: 1.5,
  },
  gatedMsg: {
    background: LIGHT_BLUE,
    border: `1px solid ${BRIGHT_BLUE}33`,
    borderRadius: 10,
    padding: '16px',
    fontSize: 14,
    color: TEXT,
    lineHeight: 1.6,
    textAlign: 'center',
  },
  footer: {
    textAlign: 'center',
    padding: '8px 0 12px',
    fontSize: 11,
    color: TEXT_LIGHT,
    background: WHITE,
    borderTop: `1px solid ${BORDER}`,
  },
  poweredBy: {
    opacity: 0.6,
  },
};

// ââ MAIN WIDGET COMPONENT âââââââââââââââââââââââââââââââââââââââ
export default function ChatWidget() {
  const [phase, setPhase] = useState('auth');
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputVal, setInputVal] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [gatedMessage, setGatedMessage] = useState('');

  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [contactType, setContactType] = useState('email');
  const [authAttempts, setAuthAttempts] = useState(0);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading, scrollToBottom]);

  useEffect(() => {
    if (phase === 'chat' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [phase]);

  const handleAuth = async (e) => {
    e.preventDefault();
    if (!name.trim() || !contact.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), contact: contact.trim() }),
      });

      const data = await res.json();

      if (data.error) {
        setError(data.error);
        setLoading(false);
        return;
      }

      if (!data.authenticated) {
        setAuthAttempts(prev => prev + 1);
        if (authAttempts >= 1) {
          setError("We're having trouble finding your account. Please try a different email or phone number, or reach out to memberships@silvermirror.com for help.");
        } else {
          setError(data.message || "We couldn't find a membership under that info. Double-check and try again?");
        }
        setLoading(false);
        return;
      }

      if (data.gated) {
        setGatedMessage(data.message);
        setPhase('gated');
        setLoading(false);
        return;
      }

      setSessionId(data.sessionId);
      setMessages([{ role: 'bot', content: data.message }]);
      setPhase('chat');
    } catch (err) {
      setError('Something went wrong. Please try again or email memberships@silvermirror.com.');
    }
    setLoading(false);
  };

  const handleSend = async () => {
    const text = inputVal.trim();
    if (!text || loading || phase !== 'chat') return;

    setInputVal('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text }),
      });

      const data = await res.json();

      if (data.error) {
        setMessages(prev => [...prev, {
          role: 'bot',
          content: "I'm sorry, something went wrong on my end. Our team at memberships@silvermirror.com can help you from here."
        }]);
        setLoading(false);
        return;
      }

      setMessages(prev => [...prev, { role: 'bot', content: data.message }]);

      if (data.conversationEnding) {
        await fetch(`${API_BASE}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
        setPhase('ended');
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'bot',
        content: "I'm having trouble connecting right now. Please reach out to memberships@silvermirror.com and they'll take care of you."
      }]);
    }
    setLoading(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleEndChat = async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      await fetch(`${API_BASE}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    } catch (e) { /* best effort */ }
    setPhase('ended');
    setLoading(false);
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <img src="/sm-logo.jpg" alt="Silver Mirror" style={styles.headerLogo} />
        <div style={styles.headerText}>
          <p style={styles.headerTitle}>Silver Mirror</p>
          <p style={styles.headerSub}>Membership Assistant</p>
        </div>
        {phase === 'chat' && (
          <button
            onClick={handleEndChat}
            style={{
              background: 'transparent', border: `1px solid ${BORDER}`,
              color: TEXT_LIGHT, borderRadius: 6, padding: '6px 12px',
              fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            End Chat
          </button>
        )}
      </div>

      {/* AUTH SCREEN */}
      {phase === 'auth' && (
        <div style={styles.authContainer}>
          <h2 style={styles.authTitle}>Hi there</h2>
          <p style={styles.authSub}>
            I&apos;m Silver Mirror&apos;s membership assistant. To get started,
            I&apos;ll need to pull up your account.
          </p>

          {error && <div style={styles.authError}>{error}</div>}

          <form onSubmit={handleAuth}>
            <label style={styles.fieldLabel}>Full Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="First and last name"
              style={styles.fieldInput}
              autoFocus
              disabled={loading}
            />

            <label style={styles.fieldLabel}>
              {contactType === 'email' ? 'Email Address' : 'Phone Number'}
            </label>
            <input
              type={contactType === 'email' ? 'email' : 'tel'}
              value={contact}
              onChange={e => setContact(e.target.value)}
              placeholder={contactType === 'email' ? 'you@example.com' : '(555) 555-5555'}
              style={styles.fieldInput}
              disabled={loading}
            />

            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <button
                type="button"
                onClick={() => {
                  setContactType(prev => prev === 'email' ? 'phone' : 'email');
                  setContact('');
                }}
                style={{
                  background: 'none', border: 'none', color: BRIGHT_BLUE,
                  fontSize: 13, cursor: 'pointer', textDecoration: 'underline',
                  fontFamily: 'inherit',
                }}
              >
                {contactType === 'email' ? 'Use phone number instead' : 'Use email instead'}
              </button>
            </div>

            <button
              type="submit"
              style={{
                ...styles.authBtn,
                opacity: loading || !name.trim() || !contact.trim() ? 0.5 : 1,
              }}
              disabled={loading || !name.trim() || !contact.trim()}
            >
              {loading ? 'Looking up your account...' : 'Continue'}
            </button>
          </form>
        </div>
      )}

      {/* GATED SCREEN */}
      {phase === 'gated' && (
        <div style={styles.authContainer}>
          <div style={styles.gatedMsg}>
            <p style={{ margin: '0 0 12px', fontSize: 16 }}>{gatedMessage}</p>
            <p style={{ margin: 0, fontSize: 13, color: TEXT_LIGHT }}>
              Need help? Email <strong>memberships@silvermirror.com</strong>
            </p>
          </div>
        </div>
      )}

      {/* CHAT SCREEN */}
      {(phase === 'chat' || phase === 'ended') && (
        <>
          <div style={styles.messages}>
            {messages.map((msg, i) => (
              <div
                key={i}
                style={msg.role === 'user' ? styles.msgUser : styles.msgBot}
              >
                {msg.content.split('\n').map((line, j) => (
                  <span key={j}>
                    {line}
                    {j < msg.content.split('\n').length - 1 && <br />}
                  </span>
                ))}
              </div>
            ))}
            {loading && (
              <div style={styles.typing}>
                <TypingDots />
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {phase === 'ended' ? (
            <div style={styles.footer}>
              <p style={{ margin: '8px 0', color: TEXT_LIGHT }}>
                This conversation has ended. You&apos;ll receive a confirmation within 48 hours.
              </p>
            </div>
          ) : (
            <div style={styles.inputArea}>
              <div style={styles.inputRow}>
                <textarea
                  ref={inputRef}
                  value={inputVal}
                  onChange={e => setInputVal(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your message..."
                  style={styles.input}
                  rows={1}
                  disabled={loading}
                />
                <button
                  onClick={handleSend}
                  style={{
                    ...styles.sendBtn,
                    ...((!inputVal.trim() || loading) ? styles.sendBtnDisabled : {}),
                  }}
                  disabled={!inputVal.trim() || loading}
                  aria-label="Send"
                >
                  &#8593;
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Footer */}
      {(phase === 'auth' || phase === 'gated') && (
        <div style={styles.footer}>
          <span style={styles.poweredBy}>Silver Mirror Facial Bar</span>
        </div>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <span>
      <style>{`
        @keyframes blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
        .dot { display: inline-block; animation: blink 1.4s infinite both; }
        .dot:nth-child(2) { animation-delay: 0.2s; }
        .dot:nth-child(3) { animation-delay: 0.4s; }
      `}</style>
      <span className="dot">&bull;</span>
      <span className="dot">&bull;</span>
      <span className="dot">&bull;</span>
    </span>
  );
}

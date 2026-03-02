'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

const API_BASE = typeof window !== 'undefined'
  ? `${window.location.origin}/api/chat`
  : '/api/chat';

// ── STYLES ──────────────────────────────────────────────────────
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
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: WHITE,
    color: TEXT,
    overflow: 'hidden',
  },
  header: {
    background: WHITE,
    color: BLACK,
    padding: '14px 20px',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
    borderBottom: `1px solid ${BORDER}`,
  },
  headerLogo: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    objectFit: 'cover',
    flexShrink: 0,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: 600,
    margin: 0,
    color: BLACK,
    letterSpacing: 0.3,
  },
  headerSub: {
    fontSize: 11,
    color: BRIGHT_BLUE,
    margin: 0,
    fontWeight: 500,
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    background: BG_SUBTLE,
  },
  msgBot: {
    background: WHITE,
    border: `1px solid ${BORDER}`,
    borderRadius: '16px 16px 16px 4px',
    padding: '10px 14px',
    maxWidth: '88%',
    fontSize: 13,
    lineHeight: 1.55,
    alignSelf: 'flex-start',
    color: TEXT,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  msgUser: {
    background: BRIGHT_BLUE,
    color: WHITE,
    borderRadius: '16px 16px 4px 16px',
    padding: '10px 14px',
    maxWidth: '80%',
    fontSize: 13,
    lineHeight: 1.55,
    alignSelf: 'flex-end',
  },
  typing: {
    background: LIGHT_BLUE,
    border: `1px solid ${BORDER}`,
    borderRadius: '16px 16px 16px 4px',
    padding: '10px 14px',
    maxWidth: '88%',
    alignSelf: 'flex-start',
    fontSize: 13,
    color: BRIGHT_BLUE,
  },
  inputArea: {
    padding: '10px 14px 16px',
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
    borderRadius: 22,
    padding: '10px 16px',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
    resize: 'none',
    lineHeight: 1.4,
    maxHeight: 100,
    color: TEXT,
    transition: 'border-color 0.2s',
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: '50%',
    background: BRIGHT_BLUE,
    color: WHITE,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    flexShrink: 0,
    transition: 'opacity 0.2s',
  },
  sendBtnDisabled: {
    opacity: 0.4,
    cursor: 'default',
  },
  footer: {
    textAlign: 'center',
    padding: '6px 0 10px',
    fontSize: 10,
    color: TEXT_LIGHT,
    background: WHITE,
    borderTop: `1px solid ${BORDER}`,
  },
};

// ── MAIN WIDGET COMPONENT ───────────────────────────────────────
export default function ChatWidget() {
  const [phase, setPhase] = useState('loading'); // loading, chat, ended
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputVal, setInputVal] = useState('');
  const [loading, setLoading] = useState(false);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading, scrollToBottom]);

  // ── Initialize session on mount ──
  useEffect(() => {
    async function init() {
      try {
        const res = await fetch(`${API_BASE}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (data.error) {
          setMessages([{ role: 'bot', content: 'Something went wrong starting the chat. Please call (888) 677-0055 for help.' }]);
          setPhase('chat');
          return;
        }
        setSessionId(data.sessionId);
        setMessages([{ role: 'bot', content: data.message }]);
        setPhase('chat');
      } catch (err) {
        setMessages([{ role: 'bot', content: 'Unable to connect. Please call (888) 677-0055 for help.' }]);
        setPhase('chat');
      }
    }
    init();
  }, []);

  useEffect(() => {
    if (phase === 'chat' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [phase]);

  const handleSend = async () => {
    const text = inputVal.trim();
    if (!text || loading || phase !== 'chat' || !sessionId) return;

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
          content: "I'm sorry, something went wrong on my end. Please call (888) 677-0055 for immediate help, or email hello@silvermirror.com."
        }]);
        setLoading(false);
        return;
      }

      setMessages(prev => [...prev, { role: 'bot', content: data.message }]);

      if (data.conversationEnding) {
        // Trigger end-of-conversation processing
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
        content: "I'm having trouble connecting right now. Please call (888) 677-0055 or email hello@silvermirror.com."
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

  // ── Render ──
  if (phase === 'loading') {
    return (
      <div style={{ ...styles.container, justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ color: TEXT_LIGHT, fontSize: 13 }}>Loading...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <img src="/sm-logo.jpg" alt="Silver Mirror" style={styles.headerLogo} />
        <div style={styles.headerText}>
          <p style={styles.headerTitle}>Silver Mirror</p>
          <p style={styles.headerSub}>Virtual Assistant</p>
        </div>
        {phase === 'chat' && (
          <button
            onClick={handleEndChat}
            style={{
              background: 'transparent', border: `1px solid ${BORDER}`,
              color: TEXT_LIGHT, borderRadius: 6, padding: '5px 10px',
              fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            End Chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={styles.messages}>
        {messages.map((msg, i) => (
          <div key={i} style={msg.role === 'user' ? styles.msgUser : styles.msgBot}>
            {msg.content.split('\n').map((line, j) => (
              <span key={j}>
                {renderLine(line)}
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

      {/* Input or Ended */}
      {phase === 'ended' ? (
        <div style={styles.footer}>
          <p style={{ margin: '6px 0', color: TEXT_LIGHT, fontSize: 12 }}>
            Chat ended. Need more help? Call (888) 677-0055 or email hello@silvermirror.com
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
    </div>
  );
}

/**
 * Render a line of text, converting URLs to clickable links.
 */
function renderLine(text) {
  const urlRegex = /(https?:\/\/[^\s)]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) => {
    if (urlRegex.test(part)) {
      // Reset lastIndex since we're reusing the regex
      urlRegex.lastIndex = 0;
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#50aaf2', textDecoration: 'underline' }}
        >
          {part}
        </a>
      );
    }
    return part;
  });
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

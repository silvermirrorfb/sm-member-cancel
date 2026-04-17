'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

const API_BASE =
    typeof window !== 'undefined'
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
          WebkitTextSizeAdjust: '100%',
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
    headerActions: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingRight: 34,
          flexShrink: 0,
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
    headerIconBtn: {
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: `1px solid ${BORDER}`,
          background: WHITE,
          color: TEXT_LIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
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
          fontSize: 16,
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
          padding: '12px 14px 16px',
          background: WHITE,
          borderTop: `1px solid ${BORDER}`,
    },
};

function shouldAutoFocusInput() {
    if (typeof window === 'undefined') return false;
    // Never autofocus when embedded in an iframe — it causes the parent page to scroll
    try { if (window.self !== window.top) return false; } catch (e) { return false; }
    if (window.matchMedia?.('(pointer: coarse)').matches) return false;
    if (window.innerWidth <= 768) return false;
    return true;
}

function RestartIcon() {
    return (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M20 11a8 8 0 1 1-2.34-5.66"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M20 4v6h-6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
    );
}

// ── MAIN WIDGET COMPONENT ─────────────────────────────────────
export default function ChatWidget() {
    const [phase, setPhase] = useState('loading'); // loading, chat, ended
  const [sessionId, setSessionId] = useState(null);
    const [memberProfile, setMemberProfile] = useState(null);
    const [messages, setMessages] = useState([]);
    const [inputVal, setInputVal] = useState('');
    const [loading, setLoading] = useState(false);
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);
    const didInitRef = useRef(false);
    const messagesContainerRef = useRef(null);
    const isFirstRenderRef = useRef(true);

  const scrollToBottom = useCallback(() => {
        const el = messagesContainerRef.current;
        if (!el) return;
        // Use instant scroll on first render to avoid triggering parent iframe scroll
        if (isFirstRenderRef.current) {
          el.scrollTop = el.scrollHeight;
          isFirstRenderRef.current = false;
        } else {
          el.scrollTop = el.scrollHeight;
        }
  }, []);

  useEffect(() => {
        scrollToBottom();
  }, [messages, loading, scrollToBottom]);

  const startChatSession = useCallback(async (options = {}) => {
        try {
                const res = await fetch(`${API_BASE}/start`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({}),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.error || !data.sessionId || !data.message) {
                        throw new Error(data?.error || 'Failed to start session');
                }
                setSessionId(data.sessionId);
                setMemberProfile(null);
                const visibleMessage =
                          typeof options.visibleMessage === 'string' && options.visibleMessage.trim()
                          ? options.visibleMessage.trim()
                          : data.message;
                setMessages([{ role: 'bot', content: visibleMessage }]);
                setPhase('chat');
                return true;
        } catch (err) {
                setSessionId(null);
                setMemberProfile(null);
                setMessages([{
                          role: 'bot',
                          content: 'Unable to connect. Please call (888) 677-0055 for help.',
                }]);
                setPhase('chat');
                return false;
        }
  }, []);

  // ── Initialize session on mount ──
  useEffect(() => {
        if (didInitRef.current) return;
        didInitRef.current = true;
        async function init() {
                await startChatSession();
        }
        init();
  }, [startChatSession]);

  useEffect(() => {
        if (phase === 'chat' && inputRef.current && shouldAutoFocusInput()) {
                inputRef.current.focus({ preventScroll: true });
        }
  }, [phase]);

  // ── Programmatic input sync ──
  // Ensures automation tools (form_input, element.value = ...) update React state.
  // Intercepts the native value setter so programmatic assignments sync immediately.
  useEffect(() => {
        const textarea = inputRef.current;
        if (!textarea) return;

                // Listen for 'input' events dispatched programmatically
                const handleInput = () => {
                        setInputVal(textarea.value);
                };

                // Expose a global setter so automation can reliably set the value
                window.__smChatSetInput = (text) => {
                        setInputVal(text);
                };

                // Override the value setter to intercept programmatic assignments
                const descriptor = Object.getOwnPropertyDescriptor(
                        HTMLTextAreaElement.prototype,
                        'value'
                      );
        const originalSetter = descriptor?.set;

                if (originalSetter) {
                        Object.defineProperty(textarea, 'value', {
                                  configurable: true,
                                  get: descriptor.get?.bind(textarea),
                                  set(val) {
                                              originalSetter.call(this, val);
                                              setInputVal(val);
                                  },
                        });
                }

                textarea.addEventListener('input', handleInput);

                return () => {
                        textarea.removeEventListener('input', handleInput);
                        delete window.__smChatSetInput;
                        // Restore original setter
                        if (originalSetter) {
                                  Object.defineProperty(textarea, 'value', descriptor);
                        }
                };
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
                          body: JSON.stringify({ sessionId, message: text, history: messages.map(m => ({ role: m.role === 'bot' ? 'assistant' : 'user', content: m.content })) }),
                });
                const data = await res.json().catch(() => ({}));

          if (!res.ok || data.error) {
                    if (res.status === 404 || res.status === 409) {
                              const restarted = await startChatSession({
                                        visibleMessage: 'I refreshed the chat after a connection reset. Please resend your last message.',
                              });
                              if (!restarted) {
                                        setMessages(prev => [
                                                    ...prev,
                                            {
                                                          role: 'bot',
                                                          content: 'Your session expired and I could not reconnect. Please call (888) 677-0055 for immediate help.',
                                            },
                                                    ]);
                              }
                              setLoading(false);
                              return;
                    }
                    setMessages(prev => [
                                ...prev,
                      {
                                    role: 'bot',
                                    content:
                                                    "I'm sorry, something went wrong on my end. Please call (888) 677-0055 for immediate help, or email hello@silvermirror.com.",
                      },
                              ]);
                    setLoading(false);
                    return;
          }

          // Null-safety: if message is missing, show fallback
          const botMessage =
                    data.message ||
                    "I'm sorry, I wasn't able to generate a response. Please try again or call (888) 677-0055.";

          setMessages(prev => [...prev, { role: 'bot', content: botMessage }]);
          if (data.memberProfile && typeof data.memberProfile === 'object') {
                    setMemberProfile(data.memberProfile);
          }

          if (data.conversationEnding) {
                    // Include history + summary for serverless recovery (P1-3)
                    const allMessages = [...messages, { role: 'user', content: text }, { role: 'bot', content: botMessage }];
                    const profileForEnd = (data.memberProfile && typeof data.memberProfile === 'object')
                              ? data.memberProfile
                              : memberProfile;
                    await fetch(`${API_BASE}/end`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                          sessionId,
                                          history: allMessages,
                                          summary: data.summary || null,
                                          memberProfile: profileForEnd || null,
                                }),
                    });
                    setPhase('ended');
          }
        } catch (err) {
                setMessages(prev => [
                          ...prev,
                  {
                              role: 'bot',
                              content:
                                            "I'm having trouble connecting right now. Please call (888) 677-0055 or email hello@silvermirror.com.",
                  },
                        ]);
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
        if (loading) return;
        setLoading(true);

        const history = messages.map(m => ({
                role: m.role === 'bot' ? 'assistant' : 'user',
                content: m.content,
        }));

        try {
                if (sessionId) {
                          await fetch(`${API_BASE}/end`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                              sessionId,
                                              history,
                                              memberProfile: memberProfile || null,
                                    }),
                          });
                }
        } catch {
                // End endpoint failures should not block chat reset.
        }

        const restarted = await startChatSession();
        if (!restarted) {
                setMessages([{
                          role: 'bot',
                          content: 'Chat ended, but I could not start a new session. Please call (888) 677-0055 for help.',
                }]);
                setPhase('chat');
        }

        setLoading(false);
  };

  const handleNewChat = async () => {
        if (loading) return;
        setLoading(true);
        await startChatSession();
        setLoading(false);
  };

  // ── Render ──
  if (phase === 'loading') {
        return (
                <div
            style={{
                        ...styles.container,
                        justifyContent: 'center',
                        alignItems: 'center',
            }}
        >
          <div style={{ color: TEXT_LIGHT, fontSize: 13 }}>Loading...</div>
  </div>
    );
}

  return (
        <div style={styles.container}>
  {/* Header */}
      <div style={styles.header}>
        <img
          src="/sm-logo.jpg"
          alt="Silver Mirror"
          style={styles.headerLogo}
        />
        <div style={styles.headerText}>
          <p style={styles.headerTitle}>Silver Mirror</p>
          <p style={styles.headerSub}>Virtual Assistant</p>
        </div>
        {phase === 'chat' && (
          <div style={styles.headerActions}>
            <button
              onClick={handleEndChat}
              style={styles.headerIconBtn}
              aria-label="Start new chat"
              title="Start new chat"
            >
              <RestartIcon />
            </button>
          </div>
        )}
</div>

{/* Messages */}
      <div ref={messagesContainerRef} style={styles.messages}>
      {messages.map((msg, i) => (
                  <div
                                key={i}
            style={msg.role === 'user' ? styles.msgUser : styles.msgBot}
          >
{msg.role === 'user'
               ? renderPlainText(msg.content)
                : renderMarkdown(msg.content)}
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
          <p style={{ margin: '4px 0 10px', color: TEXT_LIGHT, fontSize: 12 }}>
            Chat ended. Need more help? Call{' '}
            <a
              href="tel:8886770055"
              style={{ color: BRIGHT_BLUE, textDecoration: 'none' }}
            >
              (888) 677-0055
                </a>{' '}
            or email{' '}
            <a
              href="mailto:hello@silvermirror.com"
              style={{ color: BRIGHT_BLUE, textDecoration: 'none' }}
            >
              hello@silvermirror.com
                </a>
                </p>
          <button
            onClick={handleNewChat}
            style={{
                            background: BRIGHT_BLUE,
                            color: WHITE,
                            border: 'none',
                            borderRadius: 20,
                            padding: '8px 20px',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
            }}
          >
            Start New Chat
              </button>
              </div>
      ) : (
                <div style={styles.inputArea}>
                  <div style={styles.inputRow}>
            <textarea
              ref={inputRef}
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
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
                                ...(!inputVal.trim() || loading
                                                      ? styles.sendBtnDisabled
                                                      : {}),
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
 * Render plain text with line breaks (for user messages).
 */
function renderPlainText(content) {
    const text = content || '';
    return text.split('\n').map((line, i) => (
          <span key={i}>
      {line}
                                {i < text.split('\n').length - 1 && <br />}
  </span>
    ));
}

/**
 * Render bot messages with markdown support:
 * - ## Headers -> bold section headers
 * - **bold** -> <strong>
 * - - bullet items -> indented with bullet
 * - URLs -> clickable links
 * - Line breaks preserved
 */
function renderMarkdown(content) {
    const text = content || '';
    const lines = text.split('\n');

  return lines.map((line, i) => {
        const trimmed = line.trim();

                       // Empty lines -> spacing
                       if (!trimmed) {
                               return <div key={i} style={{ height: 6 }} />;
  }

                       // ## Header
                       if (trimmed.startsWith('## ')) {
          const headerText = trimmed.replace(/^##\s+/, '');
          return (
                    <div
              key={i}
              style={{
                            fontWeight: 700,
                            fontSize: 13.5,
                            marginTop: i > 0 ? 10 : 0,
                            marginBottom: 2,
                            color: '#1a1a1a',
              }}
          >
  {renderInline(headerText)}
  </div>
        );
}

    // # Header (larger)
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
            const headerText = trimmed.replace(/^#\s+/, '');
            return (
                      <div
                key={i}
                style={{
                              fontWeight: 700,
                              fontSize: 14.5,
                              marginTop: i > 0 ? 12 : 0,
                              marginBottom: 4,
                              color: '#1a1a1a',
                }}
        >
{renderInline(headerText)}
</div>
      );
}

    // Bullet items: - or *
    if (/^[-•*]\s+/.test(trimmed)) {
            const bulletText = trimmed.replace(/^[-•*]\s+/, '');
            return (
                      <div
                key={i}
                style={{
                              paddingLeft: 14,
                              position: 'relative',
                              marginBottom: 2,
                }}
        >
          <span
            style={{
                            position: 'absolute',
                            left: 0,
                            color: '#9ca3af',
            }}
          >
            &bull;
</span>
{renderInline(bulletText)}
</div>
      );
}

    // Numbered items: 1. 2. etc.
    if (/^\d+\.\s+/.test(trimmed)) {
            const match = trimmed.match(/^(\d+\.)\s+(.*)/);
            if (match) {
                      return (
                                  <div
                          key={i}
                          style={{
                                          paddingLeft: 20,
                                          position: 'relative',
                                          marginBottom: 2,
                          }}
                >
                  <span
                    style={{
                                      position: 'absolute',
                                      left: 0,
                                      color: '#9ca3af',
                                      fontWeight: 600,
                                      fontSize: 12,
                    }}
            >
{match[1]}
</span>
{renderInline(match[2])}
</div>
        );
}
}

    // Regular paragraph
    return (
            <div key={i} style={{ marginBottom: 2 }}>
{renderInline(trimmed)}
</div>
    );
});
}

/**
 * Render inline formatting: **bold**, URLs
 */
function renderInline(text) {
    if (!text) return null;

  const boldParts = text.split(/(\*\*[^*]+\*\*)/g);
    return boldParts.map((part, i) => {
          if (part.startsWith('**') && part.endsWith('**')) {
                  const inner = part.slice(2, -2);
                  return (
                            <strong key={i} style={{ fontWeight: 600 }}>
                         {renderUrls(inner)}
                         </strong>
                               );
}
    return <span key={i}>{renderUrls(part)}</span>;
});
}

/**
 * Convert URLs to clickable links.
 */
function renderUrls(text) {
    if (!text) return null;

  const urlRegex = /(https?:\/\/[^\s),]+)/g;
    const parts = text.split(urlRegex);

  return parts.map((part, i) => {
        if (/^https?:\/\//.test(part)) {
                let url = part;
                let trailing = '';
                if (/[.)!?;:]$/.test(url)) {
                          trailing = url.slice(-1);
                          url = url.slice(0, -1);
                }
                return (
                          <span key={i}>
                            <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#50aaf2', textDecoration: 'underline' }}
              >
                   {url}
                   </a>
                   {trailing}
                   </span>
                         );
}
    return part;
});
}

function TypingDots() {
    return (
          <span>
            <style>{`
                    @keyframes blink {
                              0%, 80%, 100% { opacity: 0.3; }
                                        40% { opacity: 1; }
                                                }
                                                        .dot {
                                                                  display: inline-block;
                                                                            animation: blink 1.4s infinite both;
                                                                                    }
                                                                                            .dot:nth-child(2) { animation-delay: 0.2s; }
                                                                                                    .dot:nth-child(3) { animation-delay: 0.4s; }
                                                                                                          `}</style>
      <span className="dot">&bull;</span>
      <span className="dot">&bull;</span>
      <span className="dot">&bull;</span>
  </span>
  );
}

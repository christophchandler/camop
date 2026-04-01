import { useState, useEffect, useRef, useCallback } from 'react';
import Landing from './Landing.jsx';
import Session from './Session.jsx';

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectDelay = useRef(1000);

  useEffect(() => {
    fetch('/api/sessions')
      .then(r => r.json())
      .then(data => { setSessions(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setWsConnected(false);
      return;
    }

    function connect() {
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${wsProtocol}//${location.host}/ws?session=${activeSessionId}&role=producer`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        reconnectDelay.current = 1000;
        clearTimeout(reconnectTimer.current);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'session-state') {
          setSessions(prev =>
            prev.map(s => s.id === msg.session.id ? msg.session : s)
          );
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setWsConnected(false);
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
          connect();
        }, reconnectDelay.current);
      };

      ws.onerror = () => {};
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [activeSessionId]);

  const createSession = async (name) => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const session = await res.json();
    setSessions(prev => [session, ...prev]);
    setActiveSessionId(session.id);
  };

  const sendCommand = useCallback((type, payload = {}) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, ...payload }));
    }
  }, []);

  const activeSession = sessions.find(s => s.id === activeSessionId);

  // Landing page when no active session
  if (!activeSession) {
    return (
      <div>
        <Landing onCreateSession={createSession} />

        {/* Session history drawer */}
        {sessions.length > 0 && (
          <div className="fixed bottom-0 left-0 right-0 z-20">
            <div className="max-w-2xl mx-auto px-6 pb-6">
              <details className="glass group">
                <summary className="px-5 py-3 cursor-pointer text-sm text-gray-400 hover:text-white transition-colors flex items-center justify-between select-none">
                  <span className="font-medium">{sessions.length} previous session{sessions.length !== 1 ? 's' : ''}</span>
                  <svg className="w-4 h-4 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                  </svg>
                </summary>
                <div className="px-2 pb-2 max-h-64 overflow-y-auto space-y-1">
                  {sessions.map(s => (
                    <button
                      key={s.id}
                      onClick={() => setActiveSessionId(s.id)}
                      className="w-full px-4 py-3 text-left rounded-xl hover:bg-white/[0.06] transition-all duration-200 flex justify-between items-center group/item"
                    >
                      <div>
                        <div className="text-sm text-white font-medium group-hover/item:text-brand-400 transition-colors">{s.name}</div>
                        <div className="text-xs text-gray-600">{new Date(s.createdAt).toLocaleString()}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-600">{s.guests.length} guest{s.guests.length !== 1 ? 's' : ''}</span>
                        <svg className="w-4 h-4 text-gray-600 group-hover/item:text-brand-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </button>
                  ))}
                </div>
              </details>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Active session view
  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <div className="sticky top-0 z-30 glass border-b border-white/[0.06] backdrop-blur-2xl">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setActiveSessionId(null)}
              className="btn-ghost text-sm flex items-center gap-1.5 -ml-3"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
            <div className="h-5 w-px bg-white/10" />
            <h1 className="text-sm font-semibold text-gradient">CamOp</h1>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className={`status-dot ${wsConnected ? 'bg-emerald-400' : 'bg-red-400 animate-pulse'}`} />
            <span className={wsConnected ? 'text-emerald-400' : 'text-red-400'}>
              {wsConnected ? 'Live' : 'Reconnecting...'}
            </span>
          </div>
        </div>
      </div>

      {/* Session content */}
      <div className="max-w-4xl mx-auto px-6 py-8 animate-fade-in">
        <Session session={activeSession} sendCommand={sendCommand} />
      </div>
    </div>
  );
}

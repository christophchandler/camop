import { useState, useEffect, useRef, useCallback } from 'react';
import Session from './Session.jsx';

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [sessionName, setSessionName] = useState('');
  const [creating, setCreating] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectDelay = useRef(1000);

  // Fetch existing sessions on mount
  useEffect(() => {
    fetch('/api/sessions')
      .then(r => r.json())
      .then(setSessions)
      .catch(() => {});
  }, []);

  // WebSocket connection for the active session with reconnect
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
        reconnectDelay.current = 1000; // reset backoff
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
        // Auto-reconnect with exponential backoff
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

  const createSession = async () => {
    if (!sessionName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sessionName.trim() })
      });
      const session = await res.json();
      setSessions(prev => [session, ...prev]);
      setActiveSessionId(session.id);
      setSessionName('');
    } catch (err) {
      console.error('Failed to create session:', err);
    }
    setCreating(false);
  };

  const sendCommand = useCallback((type, payload = {}) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, ...payload }));
    }
  }, []);

  const activeSession = sessions.find(s => s.id === activeSessionId);

  return (
    <div className="min-h-screen p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">CamOp</h1>
          <p className="text-sm text-gray-500">Producer Dashboard</p>
        </div>
        {activeSessionId && (
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
            <span className={wsConnected ? 'text-green-400' : 'text-red-400'}>
              {wsConnected ? 'Connected' : 'Reconnecting...'}
            </span>
          </div>
        )}
      </div>

      {/* Create Session */}
      <div className="bg-gray-900 rounded-xl p-5 mb-6 border border-gray-800">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">New Session</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={sessionName}
            onChange={e => setSessionName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && createSession()}
            placeholder="Session name (e.g. Goodwater CEO Testimonial)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 outline-none focus:border-blue-500"
          />
          <button
            onClick={createSession}
            disabled={creating || !sessionName.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
          >
            Create Session
          </button>
        </div>
      </div>

      {/* Session List */}
      {sessions.length > 0 && !activeSession && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 divide-y divide-gray-800">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide px-5 py-3">Sessions</h2>
          {sessions.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveSessionId(s.id)}
              className="w-full px-5 py-3 text-left hover:bg-gray-800/50 transition-colors flex justify-between items-center"
            >
              <div>
                <div className="text-white font-medium">{s.name}</div>
                <div className="text-xs text-gray-500">{new Date(s.createdAt).toLocaleString()}</div>
              </div>
              <div className="text-sm text-gray-500">{s.guests.length} guest{s.guests.length !== 1 ? 's' : ''}</div>
            </button>
          ))}
        </div>
      )}

      {/* Active Session */}
      {activeSession && (
        <>
          <button
            onClick={() => setActiveSessionId(null)}
            className="text-sm text-gray-500 hover:text-gray-300 mb-4 flex items-center gap-1"
          >
            &larr; Back to sessions
          </button>
          <Session session={activeSession} sendCommand={sendCommand} />
        </>
      )}
    </div>
  );
}

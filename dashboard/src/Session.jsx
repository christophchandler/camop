import { useState } from 'react';
import GuestTile from './GuestTile.jsx';

export default function Session({ session, sendCommand }) {
  const [copied, setCopied] = useState(false);

  const magicLink = session.magicLink || 'Loading link...';

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(magicLink);
    } catch {
      const input = document.createElement('input');
      input.value = magicLink;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const hasReadyGuests = session.guests.some(g => g.status === 'ready' || g.status === 'done');
  const hasRecordingGuests = session.guests.some(g => g.status === 'recording');

  return (
    <div className="space-y-5">
      {/* Session Header */}
      <div className="glass p-6 animate-slide-up">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-white mb-1">{session.name}</h2>
            {session.path && <p className="text-xs text-gray-400 font-mono break-all">Saving to {session.path}</p>}
            {session.brief && <p className="text-xs text-gray-500 mt-1 whitespace-pre-wrap">{session.brief}</p>}
          </div>
          <div className="flex gap-2">
            {hasReadyGuests && (
              <button
                onClick={() => sendCommand('start-recording', { guestId: 'all' })}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-emerald-500/20"
                style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}
              >
                Start All
              </button>
            )}
            {hasRecordingGuests && (
              <button
                onClick={() => sendCommand('stop-recording', { guestId: 'all' })}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-500 hover:bg-red-400 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-red-500/20"
              >
                Stop All
              </button>
            )}
          </div>
        </div>

        {/* Magic Link */}
        <div className="bg-white/[0.03] rounded-xl p-1 flex items-center gap-1 border border-white/[0.06]">
          <div className="flex-1 px-3 py-2 text-sm text-gray-400 truncate font-mono select-all">{magicLink}</div>
          <button
            onClick={copyLink}
            className={`px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all duration-300 ${
              copied
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'btn-brand'
            }`}
          >
            {copied ? (
              <span className="flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Copied!
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
                Copy Link
              </span>
            )}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-2 ml-1">Drop this link in your meeting chat. Guests click it to join.</p>
        {session.recovered && (
          <p className="text-xs text-amber-400 mt-2 ml-1">CamOp has no saved record of this session, so its files go to Projects/_CamOp_Unsorted. Recordings are safe; start a new session to file them under a project.</p>
        )}
      </div>

      {/* Guest Tiles */}
      {session.guests.length === 0 ? (
        <div className="glass p-12 text-center animate-slide-up" style={{ animationDelay: '0.1s', animationFillMode: 'both' }}>
          <div className="text-4xl mb-4 animate-float">📡</div>
          <p className="text-gray-400 font-medium mb-1">Waiting for guests to connect...</p>
          <p className="text-xs text-gray-600">Share the magic link above in your meeting chat.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {session.guests.map((guest, i) => (
            <div key={guest.id} className="animate-slide-up" style={{ animationDelay: `${i * 0.05}s`, animationFillMode: 'both' }}>
              <GuestTile
                guest={guest}
                sessionId={session.id}
                sendCommand={sendCommand}
              />
            </div>
          ))}
        </div>
      )}

      {/* Session Log */}
      {session.log.length > 0 && (
        <details className="glass group animate-slide-up" style={{ animationDelay: '0.2s', animationFillMode: 'both' }}>
          <summary className="px-5 py-3 cursor-pointer text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-300 transition-colors flex items-center justify-between select-none">
            Session Log
            <svg className="w-4 h-4 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <div className="px-5 pb-4 space-y-1 max-h-48 overflow-y-auto">
            {session.log.slice().reverse().map((entry, i) => (
              <div key={i} className="text-xs flex gap-3 py-0.5">
                <span className="text-gray-600 font-mono whitespace-nowrap">
                  {new Date(entry.time).toLocaleTimeString()}
                </span>
                <span className="text-gray-500">{entry.message}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

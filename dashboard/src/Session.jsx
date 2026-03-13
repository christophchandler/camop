import { useState } from 'react';
import GuestTile from './GuestTile.jsx';

export default function Session({ session, sendCommand }) {
  const [copied, setCopied] = useState(false);

  const magicLink = `${location.origin}/guest/?session=${session.id}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(magicLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const input = document.createElement('input');
      input.value = magicLink;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const hasRecordingGuests = session.guests.some(g => g.status === 'recording');

  return (
    <div className="space-y-4">
      {/* Session Header */}
      <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <h2 className="text-lg font-semibold text-white mb-1">{session.name}</h2>
        <p className="text-xs text-gray-500 mb-4">Session ID: {session.id}</p>

        {/* Magic Link */}
        <div className="bg-gray-800 rounded-lg p-3 flex items-center gap-3">
          <div className="flex-1 text-sm text-gray-300 truncate font-mono">{magicLink}</div>
          <button
            onClick={copyLink}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-1.5 rounded-md font-medium transition-colors whitespace-nowrap"
          >
            {copied ? 'Copied!' : 'Copy Link'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">Drop this link in your meeting chat. Guests click it to join.</p>
      </div>

      {/* Global Controls */}
      {session.guests.length > 0 && (
        <div className="flex gap-3">
          <button
            onClick={() => sendCommand('start-recording', { guestId: 'all' })}
            className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Start All
          </button>
          {hasRecordingGuests && (
            <button
              onClick={() => sendCommand('stop-recording', { guestId: 'all' })}
              className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Stop All
            </button>
          )}
        </div>
      )}

      {/* Guest Tiles */}
      {session.guests.length === 0 ? (
        <div className="bg-gray-900 rounded-xl p-8 border border-gray-800 text-center">
          <p className="text-gray-500">Waiting for guests to connect...</p>
          <p className="text-xs text-gray-600 mt-1">Share the magic link above in your meeting chat.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {session.guests.map(guest => (
            <GuestTile
              key={guest.id}
              guest={guest}
              sessionId={session.id}
              sendCommand={sendCommand}
            />
          ))}
        </div>
      )}

      {/* Session Log */}
      {session.log.length > 0 && (
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Session Log</h3>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {session.log.slice().reverse().map((entry, i) => (
              <div key={i} className="text-xs flex gap-3">
                <span className="text-gray-600 font-mono whitespace-nowrap">
                  {new Date(entry.time).toLocaleTimeString()}
                </span>
                <span className="text-gray-400">{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

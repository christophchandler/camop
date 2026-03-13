import { useState, useEffect } from 'react';

const STATUS_CONFIG = {
  'connected':          { label: 'Connected',        color: 'bg-blue-500',   text: 'text-blue-400' },
  'recording':          { label: 'Recording',         color: 'bg-red-500',    text: 'text-red-400' },
  'uploading':          { label: 'Uploading',         color: 'bg-yellow-500', text: 'text-yellow-400' },
  'needs-conversion':   { label: 'Needs Conversion',  color: 'bg-orange-500', text: 'text-orange-400' },
  'converting':         { label: 'Converting...',     color: 'bg-orange-500', text: 'text-orange-400' },
  'conversion-failed':  { label: 'Conversion Failed', color: 'bg-red-500',    text: 'text-red-400' },
  'complete':           { label: 'Complete',           color: 'bg-green-500',  text: 'text-green-400' },
};

export default function GuestTile({ guest, sessionId, sendCommand }) {
  const [elapsed, setElapsed] = useState(0);
  const [converting, setConverting] = useState(false);

  const config = STATUS_CONFIG[guest.status] || { label: guest.status, color: 'bg-gray-500', text: 'text-gray-400' };

  // Timer for recording
  useEffect(() => {
    if (guest.status !== 'recording') {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [guest.status]);

  const formatTime = (secs) => {
    const h = String(Math.floor(secs / 3600)).padStart(2, '0');
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  const triggerConversion = async () => {
    if (!guest.fileName) return;
    setConverting(true);
    try {
      await fetch(`/api/sessions/${sessionId}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: guest.id })
      });
    } catch (err) {
      console.error('Conversion request failed:', err);
    }
    setConverting(false);
  };

  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800 flex items-center gap-4">
      {/* Status dot */}
      <div className={`w-3 h-3 rounded-full ${config.color} ${guest.status === 'recording' ? 'animate-pulse' : ''}`} />

      {/* Guest info */}
      <div className="flex-1 min-w-0">
        <div className="text-white font-medium truncate">{guest.name}</div>
        <div className={`text-xs ${config.text} flex items-center gap-2`}>
          {config.label}
          {guest.status === 'recording' && (
            <span className="font-mono">{formatTime(elapsed)}</span>
          )}
          {guest.status === 'uploading' && guest.uploadProgress != null && (
            <span>{guest.uploadProgress}%</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {guest.status === 'connected' && (
          <button
            onClick={() => sendCommand('start-recording', { guestId: guest.id })}
            className="bg-green-600 hover:bg-green-500 text-white text-sm px-3 py-1.5 rounded-md font-medium transition-colors"
          >
            Start Recording
          </button>
        )}
        {guest.status === 'recording' && (
          <button
            onClick={() => sendCommand('stop-recording', { guestId: guest.id })}
            className="bg-red-600 hover:bg-red-500 text-white text-sm px-3 py-1.5 rounded-md font-medium transition-colors"
          >
            Stop
          </button>
        )}
        {guest.status === 'needs-conversion' && (
          <button
            onClick={triggerConversion}
            disabled={converting}
            className="bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded-md font-medium transition-colors"
          >
            Convert to MP4
          </button>
        )}
        {guest.status === 'complete' && guest.fileName && (
          <span className="text-xs text-gray-500 font-mono truncate max-w-[200px]">
            {guest.fileName}
          </span>
        )}
      </div>
    </div>
  );
}

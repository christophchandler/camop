import { useState, useEffect } from 'react';
import RequestButton from './RequestButton.jsx';

const STATUS_CONFIG = {
  'connected':          { label: 'Connected',        color: 'bg-blue-400',    text: 'text-blue-400',    ring: 'ring-blue-400/30' },
  'setting-up':         { label: 'Setting Up',       color: 'bg-blue-400',    text: 'text-blue-400',    ring: 'ring-blue-400/30' },
  'ready':              { label: 'Ready',             color: 'bg-emerald-400', text: 'text-emerald-400', ring: 'ring-emerald-400/30' },
  'recording':          { label: 'Recording',         color: 'bg-red-400',     text: 'text-red-400',     ring: 'ring-red-400/30' },
  'uploading':          { label: 'Uploading',         color: 'bg-amber-400',   text: 'text-amber-400',   ring: 'ring-amber-400/30' },
  'needs-conversion':   { label: 'Needs Conversion',  color: 'bg-orange-400',  text: 'text-orange-400',  ring: 'ring-orange-400/30' },
  'converting':         { label: 'Converting',        color: 'bg-orange-400',  text: 'text-orange-400',  ring: 'ring-orange-400/30' },
  'conversion-failed':  { label: 'Conv. Failed',      color: 'bg-red-400',     text: 'text-red-400',     ring: 'ring-red-400/30' },
  'done':               { label: 'Done',              color: 'bg-emerald-400', text: 'text-emerald-400', ring: 'ring-emerald-400/30' },
  'complete':           { label: 'Complete',           color: 'bg-emerald-400', text: 'text-emerald-400', ring: 'ring-emerald-400/30' },
  'disconnected':       { label: 'Disconnected',      color: 'bg-gray-400',    text: 'text-gray-400',    ring: 'ring-gray-400/30' },
};

const mb = b => (b / 1048576).toFixed(b > 100 * 1048576 ? 0 : 1);

function Health({ guest }) {
  const s = guest.stats;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  if (!s) return null;
  const age = Math.round((now - (s.at || 0)) / 1000);
  const total = s.uploadedBytes + s.pendingBytes;
  const pct = total > 0 ? Math.floor((s.uploadedBytes / total) * 100) : 100;
  const warnings = [];
  if (guest.status === 'disconnected') warnings.push(s.recording ? 'Lost connection. Their computer keeps recording and will upload when it reconnects.' : 'Lost connection.');
  else if (age > 10) warnings.push(`No update from the guest for ${age}s`);
  if (s.recording && s.micLevel < 0.01) warnings.push('Mic is silent');
  if (s.recording && s.width && s.width < 1280) warnings.push(`Camera is only ${s.width}x${s.height}`);
  if (s.storageFreeMB && s.storageFreeMB < 3000) warnings.push(`Low disk space: ${(s.storageFreeMB / 1024).toFixed(1)} GB free`);
  if (s.lastError) warnings.push(s.lastError);
  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400 font-mono">
        <span>{mb(s.recordedBytes)} MB recorded</span>
        <span>{mb(s.uploadedBytes)} MB uploaded ({pct}%)</span>
        {s.pendingBytes > 0 && <span>{mb(s.pendingBytes)} MB to go</span>}
        {s.width > 0 && <span>{s.width}x{s.height} @ {Math.round(s.fps)} fps</span>}
        <span className="flex items-center gap-1.5">mic
          <span className="inline-block w-16 h-1.5 bg-white/[0.06] rounded-full overflow-hidden align-middle">
            <span className="block h-full bg-emerald-400" style={{ width: `${Math.round(Math.min(1, s.micLevel * 2) * 100)}%` }} />
          </span>
        </span>
      </div>
      {warnings.map((w, i) => (
        <div key={i} className="text-[11px] text-amber-400">{w}</div>
      ))}
    </div>
  );
}

export default function GuestTile({ guest, sessionId, sendCommand }) {
  const [elapsed, setElapsed] = useState(0);

  const config = STATUS_CONFIG[guest.status] || { label: guest.status, color: 'bg-gray-400', text: 'text-gray-400', ring: 'ring-gray-400/30' };
  const isActive = guest.status === 'recording';

  useEffect(() => {
    if (!isActive) { setElapsed(0); return; }
    const base = guest.stats && guest.stats.recording ? guest.stats.recordingMs + (Date.now() - guest.stats.at) : 0;
    const start = Date.now() - base;
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(interval);
  }, [guest.status, guest.stats && guest.stats.recording]);

  const formatTime = (secs) => {
    const h = String(Math.floor(secs / 3600)).padStart(2, '0');
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  const triggerConversion = async (fileIndex) => {
    try {
      await fetch(`/api/sessions/${sessionId}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: guest.id, fileIndex })
      });
    } catch (err) {
      console.error('Conversion request failed:', err);
    }
  };

  const canStart = guest.status === 'ready' || guest.status === 'done';

  return (
    <div className={`glass-hover p-5 transition-all duration-500 ${isActive ? 'border-red-500/20 shadow-lg shadow-red-500/5' : ''}`}>
      {/* Top row */}
      <div className="flex items-center gap-4">
        {/* Avatar circle with status */}
        <div className="relative flex-shrink-0">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-400/20 to-brand-600/20 flex items-center justify-center text-brand-400 font-bold text-sm">
            {guest.name.charAt(0).toUpperCase()}
          </div>
          <div className={`absolute -bottom-0.5 -right-0.5 status-dot ${config.color} ${isActive ? 'animate-pulse' : ''}`} />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="text-white font-semibold truncate">{guest.name}</div>
          <div className={`text-xs ${config.text} flex items-center gap-2`}>
            <span>{config.label}</span>
            {isActive && (
              <span className="font-mono bg-red-500/10 px-1.5 py-0.5 rounded text-[11px]">{formatTime(elapsed)}</span>
            )}
            {guest.status === 'uploading' && guest.uploadProgress != null && (
              <span className="font-mono">{guest.uploadProgress}%</span>
            )}
          </div>
        </div>

        {/* Control state badges */}
        {(isActive || guest.status === 'ready') && (
          <div className="flex items-center gap-1.5">
            {guest.muted && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
                MUTED
              </span>
            )}
            {guest.cameraOff && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
                CAM OFF
              </span>
            )}
            {guest.screenSharing && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                SCREEN
              </span>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 flex-shrink-0">
          {(guest.status === 'connected' || guest.status === 'setting-up') && (
            <button
              disabled
              className="px-4 py-2 rounded-xl text-sm font-medium text-gray-600 bg-white/[0.03] border border-white/[0.06] cursor-not-allowed"
              title={guest.status === 'setting-up' ? 'Guest is setting up devices' : 'Waiting for device setup'}
            >
              Start Recording
            </button>
          )}
          {canStart && (
            <button
              onClick={() => sendCommand('start-recording', { guestId: guest.id })}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-emerald-500/20"
              style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}
            >
              Start Recording
            </button>
          )}
          {isActive && (
            <button
              onClick={() => sendCommand('stop-recording', { guestId: guest.id })}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-500 hover:bg-red-400 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-red-500/20"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      <Health guest={guest} />

      {/* Upload progress bar */}
      {guest.status === 'uploading' && guest.uploadProgress != null && (
        <div className="mt-3 h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${guest.uploadProgress}%`,
              background: 'linear-gradient(90deg, #f97316, #ea580c)'
            }}
          />
        </div>
      )}

      {/* Producer request buttons */}
      {isActive && (
        <div className="mt-4 pt-4 border-t border-white/[0.06] flex items-center gap-2">
          <span className="text-[10px] text-gray-600 uppercase tracking-wider font-semibold mr-1">Requests</span>
          <RequestButton label="Mute" requestType="mute" guestId={guest.id} pendingRequest={guest.pendingRequest} sendCommand={sendCommand} />
          <RequestButton label="Camera Off" requestType="cameraOff" guestId={guest.id} pendingRequest={guest.pendingRequest} sendCommand={sendCommand} />
          <RequestButton label="Switch Device" requestType="deviceSwitch" guestId={guest.id} pendingRequest={guest.pendingRequest} sendCommand={sendCommand} />
        </div>
      )}

      {/* File list */}
      {guest.files && guest.files.length > 0 && (
        <div className="mt-4 pt-4 border-t border-white/[0.06]">
          <div className="text-[10px] text-gray-600 uppercase tracking-wider font-semibold mb-2">Files</div>
          <div className="space-y-2">
            {guest.files.map((file, i) => (
              <div key={i} className="flex items-center gap-2 text-xs bg-white/[0.02] rounded-lg px-3 py-2">
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide ${
                  file.fileType === 'screen'
                    ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                    : file.fileType === 'audio'
                      ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                      : 'bg-brand-500/10 text-brand-400 border border-brand-500/20'
                }`}>
                  {file.fileType}
                </span>
                <span className="text-gray-500 font-mono truncate flex-1 text-[11px]">{file.fileName}</span>
                {file.size > 0 && (
                  <span className="text-gray-600 text-[11px]">{mb(file.size)} MB</span>
                )}
                {file.durationMs && (
                  <span className="text-gray-600 text-[11px]">{Math.round(file.durationMs / 1000)}s</span>
                )}
                {file.status === 'needs-conversion' && (
                  <button
                    onClick={() => triggerConversion(i)}
                    className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-orange-500/10 text-orange-400 border border-orange-500/20 hover:bg-orange-500/20 transition-colors"
                  >
                    Convert
                  </button>
                )}
                {file.status === 'converting' && (
                  <span className="text-orange-400 text-[11px] flex items-center gap-1">
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Converting
                  </span>
                )}
                {file.status === 'conversion-failed' && (
                  <button
                    onClick={() => triggerConversion(i)}
                    className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                  >
                    Retry
                  </button>
                )}
                {file.status === 'complete' && (
                  <span className="text-emerald-400">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

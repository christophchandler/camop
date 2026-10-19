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

// Must match the guest page's tiers.
const QUALITY = [
  { id: 'low', label: 'Low bandwidth', detail: '1080p, 3 Mbps', needMbps: 0, gbPerHour: 1.4 },
  { id: 'standard', label: '1080p Standard', detail: '6 Mbps', needMbps: 8, gbPerHour: 2.7 },
  { id: 'high', label: '1080p High', detail: '10 Mbps', needMbps: 13, gbPerHour: 4.5 },
  { id: '4k', label: '4K', detail: '20 Mbps', needMbps: 26, gbPerHour: 9 },
];

function QualityPicker({ guest, sendCommand, disabled }) {
  const sp = guest.speed;
  const chosen = guest.quality || (sp && sp.recommended) || 'standard';
  const camLabel = sp && sp.camMaxW ? `${sp.camMaxW}x${sp.camMaxH}` : null;
  const fits = q => !sp || sp.failed || sp.uploadMbps >= q.needMbps;
  const camOk = q => q.id !== '4k' || !sp || (sp.camMaxW >= 3840);
  const pick = QUALITY.find(q => q.id === chosen) || QUALITY[1];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px]">
      <span className="text-gray-500">
        {!sp ? 'Testing connection...' : sp.failed ? 'Speed test failed' : <>Upload <span className="text-gray-300 font-mono">{sp.uploadMbps} Mbps</span></>}
        {camLabel && <> · camera up to <span className="text-gray-300 font-mono">{camLabel}</span></>}
      </span>
      <label className="flex items-center gap-2 text-gray-400">
        Quality
        <select
          value={chosen}
          disabled={disabled}
          onChange={e => sendCommand('producer:set-quality', { guestId: guest.id, quality: e.target.value })}
          className="bg-white/[0.04] border border-white/[0.1] rounded-lg px-2 py-1 text-gray-200 text-[12px] disabled:opacity-50"
        >
          {QUALITY.map(q => (
            <option key={q.id} value={q.id}>
              {q.label} ({q.detail}){sp && sp.recommended === q.id ? ', recommended' : ''}{!camOk(q) ? ', camera is not 4K' : ''}
            </option>
          ))}
        </select>
      </label>
      {sp && !sp.failed && !fits(pick) && (
        <span className="text-amber-400">Faster than their upload: the file will finish uploading after the call.</span>
      )}
      {sp && !camOk(pick) && (
        <span className="text-amber-400">Their camera tops out at {camLabel}, so 4K will record at that size.</span>
      )}
      <span className="text-gray-600">about {pick.gbPerHour} GB per hour</span>
    </div>
  );
}

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
  if (/airpods|bluetooth|beats|buds|jabra|bose|sony wh|headset|hands-free/i.test(guest.activeMic || '')) warnings.push('Bluetooth mic: records at phone quality. Ask them to pick the laptop or a USB mic in the Mic menu (between takes).');
  if (s.recording && !s.cameraOff && s.brightness >= 0 && s.brightness < 0.04) warnings.push('Camera image looks black. Another app may have taken the camera, or the lens is covered.');
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
        {/* Live thumbnail (updates every 5 s), avatar until the first frame arrives */}
        <div className="relative flex-shrink-0">
          {guest.thumbAt ? (
            <img
              src={`/api/sessions/${sessionId}/thumb/${guest.id}?v=${guest.thumbAt}`}
              alt={`${guest.name} camera`}
              className="w-40 aspect-video object-cover rounded-lg bg-black border border-white/[0.08]"
            />
          ) : (
            <div className="w-40 aspect-video rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-center text-brand-400 font-bold text-lg">
              {guest.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className={`absolute top-1.5 left-1.5 status-dot ${config.color} ${isActive ? 'animate-pulse' : ''}`} />
          {guest.thumbAt && Date.now() - guest.thumbAt > 20000 && (
            <div className="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-gray-300">{Math.round((Date.now() - guest.thumbAt) / 1000)}s old</div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="text-white font-semibold truncate">{guest.name}</div>
          {(guest.activeCamera || guest.activeMic) && (
            <div className="text-[11px] text-gray-500 leading-snug">
              {guest.activeCamera && <div className="truncate"><span className="text-gray-600">Camera:</span> {guest.activeCamera}</div>}
              {guest.activeMic && <div className="truncate"><span className="text-gray-600">Mic:</span> {guest.activeMic}</div>}
            </div>
          )}
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
              onClick={() => sendCommand('start-recording', { guestId: guest.id, quality: guest.quality || (guest.speed && guest.speed.recommended) || 'standard' })}
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

      {['connected', 'setting-up', 'ready', 'done'].includes(guest.status) && (
        <QualityPicker guest={guest} sendCommand={sendCommand} disabled={false} />
      )}

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

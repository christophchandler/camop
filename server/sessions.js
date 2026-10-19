const crypto = require('crypto');

// Sessions live in memory, but nothing that matters depends on them surviving:
// guest links carry a signed token, uploads are tracked by the guest's own browser,
// and a session is recreated on the next connection after a restart.
const sessions = new Map();

function generateId() {
  return crypto.randomBytes(16).toString('hex'); // 128-bit, not guessable
}

function newSession(id, name, recovered = false) {
  const session = {
    id,
    name,
    recovered,
    createdAt: new Date().toISOString(),
    guests: new Map(), // guestId -> guest object
    log: []
  };
  sessions.set(id, session);
  addLog(session, recovered ? 'Session restored after a server restart' : 'Session created');
  return session;
}

function createSession(name) {
  return newSession(generateId(), name);
}

function ensureSession(id, name) {
  return sessions.get(id) || newSession(id, name || 'Restored session', true);
}

function getSession(id) {
  return sessions.get(id);
}

function getAllSessions() {
  return [...sessions.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(serializeSession);
}

function sessionCount() {
  return sessions.size;
}

function addGuestToSession(sessionId, guestId, name, ws) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const existing = session.guests.get(guestId);
  if (existing) {
    // Same browser reconnecting: keep its files and stats, swap the socket.
    existing.ws = ws;
    existing.name = name || existing.name;
    if (existing.status === 'disconnected') existing.status = existing.wasRecording ? 'recording' : 'connected';
    existing.lastSeen = Date.now();
    addLog(session, `${existing.name} reconnected`);
    return session;
  }
  session.guests.set(guestId, {
    name,
    status: 'connected', // connected | setting-up | ready | recording | uploading | done | disconnected
    ws,
    muted: false,
    cameraOff: false,
    screenSharing: false,
    activeCamera: null,
    activeMic: null,
    files: [],
    uploadProgress: null,
    pendingRequest: null,
    consentAt: null,
    stats: null,
    speed: null,     // { uploadMbps, camMaxW, camMaxH, recommended }
    quality: null,   // producer's choice; falls back to speed.recommended
    wasRecording: false,
    lastSeen: Date.now()
  });
  addLog(session, `${name} connected`);
  return session;
}

function markGuestDisconnected(sessionId, guestId, ws) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const guest = session.guests.get(guestId);
  if (!guest || guest.ws !== ws) return; // a newer socket already replaced this one
  guest.ws = null;
  guest.wasRecording = guest.status === 'recording';
  guest.status = 'disconnected';
  addLog(session, `${guest.name} disconnected`);
}

function updateGuestStatus(sessionId, guestId, status, extra = {}) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const guest = session.guests.get(guestId);
  if (!guest) return;
  if (guest.status !== status) addLog(session, `${guest.name}: ${status}`);
  guest.status = status;
  Object.assign(guest, extra);
}

function updateGuestControls(sessionId, guestId, controls) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const guest = session.guests.get(guestId);
  if (!guest) return;
  for (const k of ['muted', 'cameraOff', 'screenSharing', 'activeCamera', 'activeMic']) {
    if (controls[k] !== undefined) guest[k] = controls[k];
  }
}

function updateGuestStats(sessionId, guestId, stats) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const guest = session.guests.get(guestId);
  if (!guest) return;
  guest.stats = stats;
  guest.lastSeen = Date.now();
}

function setGuestPendingRequest(sessionId, guestId, requestType) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const guest = session.guests.get(guestId);
  if (!guest) return;
  guest.pendingRequest = requestType ? { requestType, timestamp: Date.now() } : null;
}

function addGuestFile(sessionId, guestId, fileInfo) {
  const session = sessions.get(sessionId);
  if (!session) return;
  // After a restart an upload can finish before its guest reconnects; keep the file anyway.
  if (!session.guests.has(guestId)) addGuestToSession(sessionId, guestId, 'Guest', null);
  const guest = session.guests.get(guestId);
  if (guest.status === 'connected' && !guest.ws) guest.status = 'disconnected';
  const i = guest.files.findIndex(f => f.key === fileInfo.key);
  if (i >= 0) guest.files[i] = { ...guest.files[i], ...fileInfo };
  else guest.files.push(fileInfo);
}

function addLog(session, message) {
  session.log.push({ time: new Date().toISOString(), message });
  if (session.log.length > 500) session.log = session.log.slice(-500);
}

function serializeSession(session) {
  const guests = [];
  for (const [guestId, guest] of session.guests) {
    guests.push({
      id: guestId,
      name: guest.name,
      status: guest.status,
      muted: guest.muted,
      cameraOff: guest.cameraOff,
      screenSharing: guest.screenSharing,
      activeCamera: guest.activeCamera,
      activeMic: guest.activeMic,
      files: guest.files,
      uploadProgress: guest.uploadProgress,
      pendingRequest: guest.pendingRequest,
      consentAt: guest.consentAt,
      stats: guest.stats,
      speed: guest.speed,
      thumbAt: guest.thumbAt || null,
      device: guest.device || 'computer',
      quality: guest.quality,
      lastSeen: guest.lastSeen
    });
  }
  return {
    id: session.id,
    name: session.name,
    recovered: session.recovered,
    createdAt: session.createdAt,
    guests,
    log: session.log.slice(-100)
  };
}

function cleanupExpiredSessions(ttlMs) {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - new Date(session.createdAt).getTime() > ttlMs) {
      for (const [, guest] of session.guests) {
        if (guest.ws && guest.ws.readyState === 1) guest.ws.close(1001, 'Session expired');
      }
      sessions.delete(id);
    }
  }
}

module.exports = {
  createSession,
  ensureSession,
  getSession,
  getAllSessions,
  sessionCount,
  addGuestToSession,
  markGuestDisconnected,
  updateGuestStatus,
  updateGuestControls,
  updateGuestStats,
  setGuestPendingRequest,
  addGuestFile,
  serializeSession,
  cleanupExpiredSessions,
  addLog
};

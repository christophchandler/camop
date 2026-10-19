const crypto = require('crypto');
const P = require('./project');

// Sessions live in memory and are saved to the bucket as a small manifest next to
// their recordings (see persist.js), so a restart restores names, folders and files.
// Nothing about recording depends on that: guest links carry a signed token, uploads
// are tracked by the guest's own browser, and an unknown session is recreated on the
// next connection.
const sessions = new Map();

// persist.js registers here; called whenever something worth saving changes.
let onChange = () => {};
function setOnChange(fn) { onChange = fn; }
function changed(session) { try { onChange(session); } catch {} }

function generateId() {
  return crypto.randomBytes(16).toString('hex'); // 128-bit, not guessable
}

function newSession(id, meta, recovered = false) {
  const createdAt = meta.createdAt || new Date().toISOString();
  const session = {
    id,
    name: meta.name || [meta.client, meta.project].filter(Boolean).join(' ') || 'CamOp session',
    client: meta.client || '',
    project: meta.project || '',
    brief: meta.brief || '',
    folder: meta.folder || P.folderFor({ ...meta, createdAt }),
    takeCount: meta.takeCount || 0,
    recovered,
    createdAt,
    guests: new Map(), // guestId -> guest object
    log: []
  };
  sessions.set(id, session);
  return session;
}

function createSession(meta) {
  const session = newSession(generateId(), meta);
  addLog(session, 'Session created');
  changed(session);
  return session;
}

// A session we have no record of (made before manifests existed, or the bucket was
// unreachable at boot). Its files go to an unsorted folder rather than nowhere.
function ensureSession(id, name) {
  const existing = sessions.get(id);
  if (existing) return existing;
  const session = newSession(id, { name: name || 'Restored session', folder: P.fallbackFolder(id) }, true);
  addLog(session, 'Session restored after a server restart');
  return session;
}

// Rebuild a session from its saved manifest after a restart.
function restoreSession(doc) {
  if (!doc || typeof doc.sessionId !== 'string' || sessions.has(doc.sessionId)) return null;
  const session = newSession(doc.sessionId, {
    name: doc.name, client: doc.client, project: doc.project, brief: doc.brief,
    folder: doc.folder, createdAt: doc.createdAt, takeCount: doc.takeCount
  });
  session.log = Array.isArray(doc.log) ? doc.log.slice(-200) : [];
  for (const g of doc.guests || []) {
    if (!g || typeof g.id !== 'string') continue;
    session.guests.set(g.id, blankGuest(g.name || 'Guest', null, {
      status: 'disconnected', quality: g.quality || null, consentAt: g.consentAt || null,
      files: Array.isArray(g.files) ? g.files : []
    }));
  }
  addLog(session, 'Server restarted; session restored');
  return session;
}

function nextTake(session) {
  session.takeCount = (session.takeCount || 0) + 1;
  changed(session);
  return session.takeCount;
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
    changed(session);
    return session;
  }
  session.guests.set(guestId, blankGuest(name, ws));
  addLog(session, `${name} connected`);
  changed(session);
  return session;
}

function blankGuest(name, ws, extra = {}) {
  return {
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
    lastSeen: Date.now(),
    ...extra
  };
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
  changed(session);
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
      quality: guest.quality,
      lastSeen: guest.lastSeen
    });
  }
  return {
    id: session.id,
    name: session.name,
    client: session.client,
    project: session.project,
    brief: session.brief,
    folder: session.folder,
    path: `Projects/${P.prefixFor(session.folder)}`,
    takeCount: session.takeCount,
    recovered: session.recovered,
    createdAt: session.createdAt,
    guests,
    log: session.log.slice(-100)
  };
}

// What gets saved next to the recordings. No tokens, sockets or thumbnails.
function toManifest(session) {
  const guests = [];
  for (const [id, g] of session.guests) {
    guests.push({ id, name: g.name, quality: g.quality, consentAt: g.consentAt, files: g.files });
  }
  return {
    camop: 1,
    sessionId: session.id,
    name: session.name,
    client: session.client,
    project: session.project,
    brief: session.brief,
    folder: session.folder,
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    takeCount: session.takeCount,
    guests,
    log: session.log.slice(-200)
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
  setOnChange,
  createSession,
  ensureSession,
  restoreSession,
  nextTake,
  toManifest,
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

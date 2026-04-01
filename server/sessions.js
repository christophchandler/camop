const crypto = require('crypto');

// In-memory session store — sessions do not survive server restart (acceptable for MVP)
const sessions = new Map();

function generateId() {
  return crypto.randomBytes(3).toString('hex'); // 6-char hex
}

function createSession(name) {
  const id = generateId();
  const session = {
    id,
    name,
    createdAt: new Date().toISOString(),
    guests: new Map(), // guestId -> guest object
    log: []
  };
  sessions.set(id, session);
  addLog(session, 'Session created');
  return session;
}

function getSession(id) {
  return sessions.get(id);
}

function getAllSessions() {
  const result = [];
  for (const [id, session] of sessions) {
    result.push(serializeSession(session));
  }
  return result;
}

function sessionCount() {
  return sessions.size;
}

function addGuestToSession(sessionId, guestId, name, ws) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  session.guests.set(guestId, {
    name,
    status: 'connected',    // connected | setting-up | ready | recording | uploading | done
    ws,
    // Control state
    muted: false,
    cameraOff: false,
    screenSharing: false,
    activeCamera: null,
    activeMic: null,
    // Files from this session (camera + screen + restarts)
    files: [],
    // Current upload progress
    uploadProgress: null,
    // Pending producer request
    pendingRequest: null     // { requestType, timestamp } or null
  });
  addLog(session, `${name} connected`);
  return session;
}

function removeGuestFromSession(sessionId, guestId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const guest = session.guests.get(guestId);
  if (guest) {
    addLog(session, `${guest.name} disconnected`);
    session.guests.delete(guestId);
  }
}

function updateGuestStatus(sessionId, guestId, status, extra = {}) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const guest = session.guests.get(guestId);
  if (!guest) return;
  guest.status = status;
  Object.assign(guest, extra);
  addLog(session, `${guest.name}: ${status}`);
}

function updateGuestControls(sessionId, guestId, controls) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const guest = session.guests.get(guestId);
  if (!guest) return;
  if (controls.muted !== undefined) guest.muted = controls.muted;
  if (controls.cameraOff !== undefined) guest.cameraOff = controls.cameraOff;
  if (controls.screenSharing !== undefined) guest.screenSharing = controls.screenSharing;
  if (controls.activeCamera !== undefined) guest.activeCamera = controls.activeCamera;
  if (controls.activeMic !== undefined) guest.activeMic = controls.activeMic;
}

function setGuestPendingRequest(sessionId, guestId, requestType) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const guest = session.guests.get(guestId);
  if (!guest) return;
  guest.pendingRequest = requestType
    ? { requestType, timestamp: Date.now() }
    : null;
}

function addGuestFile(sessionId, guestId, fileInfo) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const guest = session.guests.get(guestId);
  if (!guest) return;
  guest.files.push(fileInfo);
}

function addLog(session, message) {
  session.log.push({
    time: new Date().toISOString(),
    message
  });
  if (session.log.length > 500) {
    session.log = session.log.slice(-500);
  }
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
      pendingRequest: guest.pendingRequest
    });
  }
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    guests,
    log: session.log
  };
}

function cleanupExpiredSessions(ttlMs) {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of sessions) {
    const age = now - new Date(session.createdAt).getTime();
    if (age > ttlMs) {
      for (const [, guest] of session.guests) {
        if (guest.ws && guest.ws.readyState === 1) {
          guest.ws.close(1001, 'Session expired');
        }
      }
      sessions.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} expired session(s). ${sessions.size} remaining.`);
  }
}

module.exports = {
  createSession,
  getSession,
  getAllSessions,
  sessionCount,
  addGuestToSession,
  removeGuestFromSession,
  updateGuestStatus,
  updateGuestControls,
  setGuestPendingRequest,
  addGuestFile,
  serializeSession,
  cleanupExpiredSessions
};

const crypto = require('crypto');

// In-memory session store — sessions do not survive server restart (acceptable for MVP)
const sessions = new Map();

function generateId() {
  return crypto.randomBytes(4).toString('hex'); // 8-char hex
}

function createSession(name) {
  const id = generateId();
  const session = {
    id,
    name,
    createdAt: new Date().toISOString(),
    guests: new Map(), // guestId -> { name, status, ws, fileName }
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
    status: 'connected',
    ws,
    fileName: null
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

function addLog(session, message) {
  session.log.push({
    time: new Date().toISOString(),
    message
  });
  // Cap log at 500 entries to prevent memory growth
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
      fileName: guest.fileName,
      uploadProgress: guest.uploadProgress
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
      // Close any remaining WebSocket connections for this session's guests
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
  serializeSession,
  cleanupExpiredSessions
};

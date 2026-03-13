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
}

function serializeSession(session) {
  const guests = [];
  for (const [guestId, guest] of session.guests) {
    guests.push({
      id: guestId,
      name: guest.name,
      status: guest.status,
      fileName: guest.fileName
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

module.exports = {
  createSession,
  getSession,
  getAllSessions,
  addGuestToSession,
  removeGuestFromSession,
  updateGuestStatus,
  serializeSession
};

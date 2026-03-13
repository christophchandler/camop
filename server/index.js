require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const {
  createSession, getSession, getAllSessions,
  addGuestToSession, removeGuestFromSession,
  updateGuestStatus, serializeSession, cleanupExpiredSessions, sessionCount
} = require('./sessions');
const { generatePresignedPutUrl, generatePresignedGetUrl } = require('./b2');
const { downloadAndConvert } = require('./converter');

const app = express();

// ========================================================
// Middleware
// ========================================================

// Trust proxy (Cloudflare / reverse proxy)
app.set('trust proxy', 1);

// CORS — restrict in production
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null; // null = allow all in dev

app.use(cors({
  origin: ALLOWED_ORIGINS || true,
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', apiLimiter);

// ========================================================
// Static files
// ========================================================

// Serve guest recording page
app.use('/guest', express.static(path.join(__dirname, '..', 'guest')));

// Serve dashboard (production build)
const dashboardDist = path.join(__dirname, '..', 'dashboard', 'dist');
if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
}

// ========================================================
// Health check
// ========================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    sessions: sessionCount()
  });
});

// ========================================================
// Input helpers
// ========================================================
function sanitizeString(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}

// ========================================================
// HTTP API
// ========================================================

const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS, 10) || 100;

// Create session
app.post('/api/sessions', (req, res) => {
  const name = sanitizeString(req.body.name, 200);
  if (!name) {
    return res.status(400).json({ error: 'Session name is required' });
  }
  if (sessionCount() >= MAX_SESSIONS) {
    return res.status(429).json({ error: 'Maximum session limit reached' });
  }
  const session = createSession(name);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const magicLink = `${baseUrl}/guest/?session=${session.id}`;
  res.json({
    ...serializeSession(session),
    magicLink
  });
});

// List sessions
app.get('/api/sessions', (req, res) => {
  res.json(getAllSessions());
});

// Get session
app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(serializeSession(session));
});

// Generate presigned PUT URL (called at stop time)
app.post('/api/sessions/:id/upload-url', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const fileName = sanitizeString(req.body.fileName, 500);
  const contentType = sanitizeString(req.body.contentType, 100);
  if (!fileName || !contentType) {
    return res.status(400).json({ error: 'fileName and contentType are required' });
  }

  try {
    const url = await generatePresignedPutUrl(fileName, contentType);
    res.json({ url });
  } catch (err) {
    console.error('Failed to generate presigned URL:', err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// Trigger WebM-to-MP4 conversion
app.post('/api/sessions/:id/convert', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { guestId } = req.body;
  if (!guestId) {
    return res.status(400).json({ error: 'guestId is required' });
  }

  const guest = session.guests.get(guestId);
  if (!guest || !guest.fileName) {
    return res.status(400).json({ error: 'Guest not found or no file to convert' });
  }
  const fileName = guest.fileName;

  try {
    updateGuestStatus(req.params.id, guestId, 'converting');
    broadcastSessionUpdate(req.params.id);

    const downloadUrl = await generatePresignedGetUrl(fileName);
    const mp4Path = await downloadAndConvert(downloadUrl, fileName);
    const mp4FileName = fileName.replace(/\.webm$/, '.mp4');

    const uploadUrl = await generatePresignedPutUrl(mp4FileName, 'video/mp4');
    const mp4Buffer = fs.readFileSync(mp4Path);

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: mp4Buffer
    });

    try { fs.unlinkSync(mp4Path); } catch {}

    if (!uploadRes.ok) throw new Error(`B2 upload failed: ${uploadRes.status}`);

    updateGuestStatus(req.params.id, guestId, 'complete', { fileName: mp4FileName });
    broadcastSessionUpdate(req.params.id);

    res.json({ success: true, fileName: mp4FileName });
  } catch (err) {
    console.error('Conversion failed:', err);
    updateGuestStatus(req.params.id, guestId, 'conversion-failed');
    broadcastSessionUpdate(req.params.id);
    res.status(500).json({ error: `Conversion failed: ${err.message}` });
  }
});

// ========================================================
// Server Setup (HTTP or HTTPS based on env)
// ========================================================
let server;

if (process.env.NODE_ENV === 'development') {
  const certPath = path.join(__dirname, '..', 'localhost+1.pem');
  const keyPath = path.join(__dirname, '..', 'localhost+1-key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    server = https.createServer({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath)
    }, app);
    console.log('Running with HTTPS (mkcert)');
  } else {
    server = http.createServer(app);
    console.log('Warning: No mkcert certs found. Running HTTP. Camera access may be blocked.');
    console.log('Run: mkcert localhost 127.0.0.1');
  }
} else {
  // Production: plain HTTP behind Cloudflare
  server = http.createServer(app);
}

// ========================================================
// WebSocket Server
// ========================================================
const wss = new WebSocketServer({ server });

// Track which WebSocket belongs to which session/guest
const wsMap = new Map(); // ws -> { sessionId, guestId, role }

// Valid message types (whitelist)
const VALID_GUEST_MSGS = new Set(['guest-join', 'recording-started', 'upload-progress', 'upload-complete']);
const VALID_PRODUCER_MSGS = new Set(['start-recording', 'stop-recording']);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session');
  const role = url.searchParams.get('role');

  if (!sessionId || !['guest', 'producer'].includes(role)) {
    ws.close(4000, 'Missing or invalid parameters');
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    ws.close(4001, 'Session not found');
    return;
  }

  const clientId = crypto.randomBytes(4).toString('hex');
  wsMap.set(ws, { sessionId, guestId: clientId, role });

  if (role === 'producer') {
    ws.send(JSON.stringify({
      type: 'session-state',
      session: serializeSession(session)
    }));
  }

  // Ping/pong for connection health
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    // Guard against huge messages
    if (data.length > 4096) return;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    const info = wsMap.get(ws);
    if (!info) return;

    // Validate message type against role
    const validTypes = info.role === 'guest' ? VALID_GUEST_MSGS : VALID_PRODUCER_MSGS;
    if (!validTypes.has(msg.type)) return;

    handleMessage(ws, info, msg);
  });

  ws.on('close', () => {
    const info = wsMap.get(ws);
    if (info && info.role === 'guest') {
      removeGuestFromSession(info.sessionId, info.guestId);
      broadcastSessionUpdate(info.sessionId);
    }
    wsMap.delete(ws);
  });
});

// Ping interval to detect dead connections
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function handleMessage(ws, info, msg) {
  const { sessionId, guestId, role } = info;

  switch (msg.type) {
    case 'guest-join': {
      const name = sanitizeString(msg.name || 'Guest', 60);
      addGuestToSession(sessionId, guestId, name, ws);
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'start-recording':
    case 'stop-recording': {
      if (role !== 'producer') return;
      const targetGuestId = msg.guestId;
      const session = getSession(sessionId);
      if (!session) return;

      const sendToGuest = (guest) => {
        if (guest.ws && guest.ws.readyState === 1) {
          guest.ws.send(JSON.stringify({ type: msg.type }));
        }
      };

      if (targetGuestId === 'all') {
        for (const [, guest] of session.guests) {
          sendToGuest(guest);
        }
      } else {
        const guest = session.guests.get(targetGuestId);
        if (guest) sendToGuest(guest);
      }
      break;
    }

    case 'recording-started': {
      if (role !== 'guest') return;
      updateGuestStatus(sessionId, guestId, 'recording');
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'upload-progress': {
      if (role !== 'guest') return;
      const percent = typeof msg.percent === 'number' ? Math.min(100, Math.max(0, msg.percent)) : 0;
      updateGuestStatus(sessionId, guestId, 'uploading', { uploadProgress: percent });
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'upload-complete': {
      if (role !== 'guest') return;
      const fileName = sanitizeString(msg.fileName || '', 500);
      const needsConversion = fileName.endsWith('.webm');
      updateGuestStatus(sessionId, guestId, needsConversion ? 'needs-conversion' : 'complete', {
        fileName
      });
      broadcastSessionUpdate(sessionId);
      break;
    }
  }
}

function broadcastSessionUpdate(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;
  const payload = JSON.stringify({
    type: 'session-state',
    session: serializeSession(session)
  });

  for (const [ws, info] of wsMap) {
    if (info.sessionId === sessionId && ws.readyState === 1) {
      ws.send(payload);
    }
  }
}

// Dashboard SPA catch-all (production)
if (fs.existsSync(dashboardDist)) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(dashboardDist, 'index.html'));
  });
}

// ========================================================
// Session cleanup (hourly, 24h TTL)
// ========================================================
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_HOURS, 10) * 3600000 || 24 * 3600000;
const cleanupInterval = setInterval(() => {
  cleanupExpiredSessions(SESSION_TTL_MS);
}, 60 * 60 * 1000);

// ========================================================
// Graceful Shutdown
// ========================================================
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  clearInterval(pingInterval);
  clearInterval(cleanupInterval);

  // Close all WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });

  wss.close(() => {
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ========================================================
// Start
// ========================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`CamOp server running at ${proto}://localhost:${PORT}`);
  console.log(`Guest page: ${proto}://localhost:${PORT}/guest/`);
});

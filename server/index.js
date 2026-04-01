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
  updateGuestStatus, updateGuestControls, setGuestPendingRequest,
  addGuestFile, serializeSession, cleanupExpiredSessions, sessionCount
} = require('./sessions');
const { generatePresignedPutUrl, generatePresignedGetUrl } = require('./b2');
const { downloadAndConvert } = require('./converter');

const app = express();

// ========================================================
// Middleware
// ========================================================
app.set('trust proxy', 1);

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null;

app.use(cors({
  origin: ALLOWED_ORIGINS || true,
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));

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
app.use('/guest', express.static(path.join(__dirname, '..', 'guest')));

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

app.get('/api/sessions', (req, res) => {
  res.json(getAllSessions());
});

app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(serializeSession(session));
});

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

app.post('/api/sessions/:id/convert', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { guestId, fileIndex } = req.body;
  if (!guestId) {
    return res.status(400).json({ error: 'guestId is required' });
  }

  const guest = session.guests.get(guestId);
  if (!guest) {
    return res.status(400).json({ error: 'Guest not found' });
  }

  // Find the file to convert (by index or the last webm file)
  const idx = typeof fileIndex === 'number' ? fileIndex : guest.files.findIndex(f => f.fileName.endsWith('.webm'));
  const fileEntry = guest.files[idx];
  if (!fileEntry) {
    return res.status(400).json({ error: 'No file to convert' });
  }

  try {
    fileEntry.status = 'converting';
    broadcastSessionUpdate(req.params.id);

    const downloadUrl = await generatePresignedGetUrl(fileEntry.fileName);
    const mp4Path = await downloadAndConvert(downloadUrl, fileEntry.fileName);
    const mp4FileName = fileEntry.fileName.replace(/\.webm$/, '.mp4');

    const uploadUrl = await generatePresignedPutUrl(mp4FileName, 'video/mp4');
    const mp4Buffer = fs.readFileSync(mp4Path);

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: mp4Buffer
    });

    try { fs.unlinkSync(mp4Path); } catch {}

    if (!uploadRes.ok) throw new Error(`B2 upload failed: ${uploadRes.status}`);

    fileEntry.fileName = mp4FileName;
    fileEntry.status = 'complete';
    broadcastSessionUpdate(req.params.id);

    // Check if all files are complete
    const allDone = guest.files.every(f => f.status === 'complete');
    if (allDone) {
      updateGuestStatus(req.params.id, guestId, 'done');
      broadcastSessionUpdate(req.params.id);
    }

    res.json({ success: true, fileName: mp4FileName });
  } catch (err) {
    console.error('Conversion failed:', err);
    fileEntry.status = 'conversion-failed';
    broadcastSessionUpdate(req.params.id);
    res.status(500).json({ error: `Conversion failed: ${err.message}` });
  }
});

// ========================================================
// Server Setup
// ========================================================
let server;

// Always create HTTP server (needed for preview tools and production behind Cloudflare)
server = http.createServer(app);

// In development, also create HTTPS server for camera access
let httpsServer = null;
if (process.env.NODE_ENV === 'development') {
  const certPath = path.join(__dirname, '..', 'localhost+1.pem');
  const keyPath = path.join(__dirname, '..', 'localhost+1-key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    httpsServer = https.createServer({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath)
    }, app);
    console.log('HTTPS available (mkcert) on port 3443');
  } else {
    console.log('Warning: No mkcert certs found. Camera access may be blocked.');
  }
}

// ========================================================
// WebSocket Server
// ========================================================
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrades on both HTTP and HTTPS servers
function handleUpgrade(request, socket, head) {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
}
server.on('upgrade', handleUpgrade);
if (httpsServer) httpsServer.on('upgrade', handleUpgrade);

const wsMap = new Map(); // ws -> { sessionId, guestId, role }

const VALID_GUEST_MSGS = new Set([
  'guest-join',
  'guest-setup-started',
  'guest-ready',
  'recording-started',
  'upload-progress',
  'upload-complete',
  'guest:control-update',
  'guest:request-response',
  'guest:recording-restarted',
  'guest:screen-share-started',
  'guest:screen-share-stopped'
]);

const VALID_PRODUCER_MSGS = new Set([
  'start-recording',
  'stop-recording',
  'producer:request',
  'producer:cancel-request'
]);

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

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
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

    case 'guest-setup-started': {
      if (role !== 'guest') return;
      updateGuestStatus(sessionId, guestId, 'setting-up');
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'guest-ready': {
      if (role !== 'guest') return;
      // Store the confirmed devices
      if (msg.activeCamera) {
        updateGuestControls(sessionId, guestId, {
          activeCamera: msg.activeCamera,
          activeMic: msg.activeMic
        });
      }
      updateGuestStatus(sessionId, guestId, 'ready');
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'start-recording': {
      if (role !== 'producer') return;
      const targetGuestId = msg.guestId;
      const session = getSession(sessionId);
      if (!session) return;

      const sendToGuest = (guest, gId) => {
        // Only allow start if guest is ready
        if (guest.status !== 'ready' && guest.status !== 'connected') {
          // Send rejection back to producer
          const producerWs = findProducerWs(sessionId);
          if (producerWs) {
            producerWs.send(JSON.stringify({
              type: 'start-rejected',
              guestId: gId,
              reason: guest.status === 'setting-up'
                ? 'Guest is still setting up — please wait.'
                : `Cannot start: guest is ${guest.status}`
            }));
          }
          return;
        }
        if (guest.ws && guest.ws.readyState === 1) {
          guest.ws.send(JSON.stringify({ type: msg.type }));
        }
      };

      if (targetGuestId === 'all') {
        for (const [gId, guest] of session.guests) {
          sendToGuest(guest, gId);
        }
      } else {
        const guest = session.guests.get(targetGuestId);
        if (guest) sendToGuest(guest, targetGuestId);
      }
      break;
    }

    case 'stop-recording': {
      if (role !== 'producer') return;
      const session2 = getSession(sessionId);
      if (!session2) return;
      const targetId = msg.guestId;

      const sendStop = (guest) => {
        if (guest.ws && guest.ws.readyState === 1) {
          guest.ws.send(JSON.stringify({ type: 'stop-recording' }));
        }
      };

      if (targetId === 'all') {
        for (const [, guest] of session2.guests) {
          sendStop(guest);
        }
      } else {
        const guest = session2.guests.get(targetId);
        if (guest) sendStop(guest);
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
      const fileType = msg.fileType || 'camera'; // camera or screen
      const startTs = msg.startTs || null;
      const durationMs = msg.durationMs || null;
      const recIndex = msg.recIndex || 1;
      const needsConversion = fileName.endsWith('.webm');

      addGuestFile(sessionId, guestId, {
        fileName,
        fileType,
        startTs,
        durationMs,
        recIndex,
        status: needsConversion ? 'needs-conversion' : 'complete'
      });

      // Check if all expected uploads are done
      updateGuestStatus(sessionId, guestId, 'done', { uploadProgress: 100 });
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'guest:control-update': {
      if (role !== 'guest') return;
      updateGuestControls(sessionId, guestId, {
        muted: msg.muted,
        cameraOff: msg.cameraOff,
        screenSharing: msg.screenSharing,
        activeCamera: msg.activeCamera,
        activeMic: msg.activeMic
      });
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'producer:request': {
      if (role !== 'producer') return;
      const session3 = getSession(sessionId);
      if (!session3) return;
      const targetGuest = session3.guests.get(msg.guestId);
      if (!targetGuest || !targetGuest.ws || targetGuest.ws.readyState !== 1) return;

      setGuestPendingRequest(sessionId, msg.guestId, msg.requestType);
      targetGuest.ws.send(JSON.stringify({
        type: 'producer:request',
        requestType: msg.requestType,
        deviceId: msg.deviceId || null
      }));
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'producer:cancel-request': {
      if (role !== 'producer') return;
      setGuestPendingRequest(sessionId, msg.guestId, null);
      // Notify guest to dismiss toast
      const session4 = getSession(sessionId);
      if (session4) {
        const g = session4.guests.get(msg.guestId);
        if (g && g.ws && g.ws.readyState === 1) {
          g.ws.send(JSON.stringify({ type: 'producer:cancel-request' }));
        }
      }
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'guest:request-response': {
      if (role !== 'guest') return;
      setGuestPendingRequest(sessionId, guestId, null);
      // Forward response to producer
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'guest:recording-restarted': {
      if (role !== 'guest') return;
      updateGuestStatus(sessionId, guestId, 'recording');
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'guest:screen-share-started': {
      if (role !== 'guest') return;
      updateGuestControls(sessionId, guestId, { screenSharing: true });
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'guest:screen-share-stopped': {
      if (role !== 'guest') return;
      updateGuestControls(sessionId, guestId, { screenSharing: false });
      broadcastSessionUpdate(sessionId);
      break;
    }
  }
}

function findProducerWs(sessionId) {
  for (const [ws, info] of wsMap) {
    if (info.sessionId === sessionId && info.role === 'producer' && ws.readyState === 1) {
      return ws;
    }
  }
  return null;
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
// Session cleanup
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
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });
  wss.close(() => {
    if (httpsServer) httpsServer.close();
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });
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
  console.log(`CamOp server running at http://localhost:${PORT}`);
  console.log(`Guest page: http://localhost:${PORT}/guest/`);
});

if (httpsServer) {
  const HTTPS_PORT = 3443;
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`CamOp HTTPS server running at https://localhost:${HTTPS_PORT}`);
    console.log(`Guest page (HTTPS): https://localhost:${HTTPS_PORT}/guest/`);
  });
}

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const {
  createSession, getSession, getAllSessions,
  addGuestToSession, removeGuestFromSession,
  updateGuestStatus, serializeSession
} = require('./sessions');
const { generatePresignedPutUrl, generatePresignedGetUrl } = require('./b2');
const { downloadAndConvert } = require('./converter');

const app = express();
app.use(cors());
app.use(express.json());

// Serve guest recording page
app.use('/guest', express.static(path.join(__dirname, '..', 'guest')));

// Serve dashboard (production build)
const dashboardDist = path.join(__dirname, '..', 'dashboard', 'dist');
if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
}

// ========================================================
// HTTP API
// ========================================================

// Create session
app.post('/api/sessions', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Session name is required' });
  }
  const session = createSession(name.slice(0, 200));
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

  const { fileName, contentType } = req.body;
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

  // Look up the guest's fileName from the session (don't trust client-supplied URLs)
  const guest = session.guests.get(guestId);
  if (!guest || !guest.fileName) {
    return res.status(400).json({ error: 'Guest not found or no file to convert' });
  }
  const fileName = guest.fileName;

  try {
    updateGuestStatus(req.params.id, guestId, 'converting');
    broadcastSessionUpdate(req.params.id);

    // Generate a presigned GET URL to download the WebM from B2
    const downloadUrl = await generatePresignedGetUrl(fileName);
    const mp4Path = await downloadAndConvert(downloadUrl, fileName);
    const mp4FileName = fileName.replace(/\.webm$/, '.mp4');

    // Upload converted file to B2
    const uploadUrl = await generatePresignedPutUrl(mp4FileName, 'video/mp4');
    const mp4Buffer = fs.readFileSync(mp4Path);

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: mp4Buffer
    });

    // Cleanup temp file
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
  // Try HTTPS for local dev (mkcert certs)
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

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session');
  const role = url.searchParams.get('role') || 'guest'; // 'guest' or 'producer'

  if (!sessionId) {
    ws.close(4000, 'Missing session parameter');
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
    // Producer connects — send current session state
    ws.send(JSON.stringify({
      type: 'session-state',
      session: serializeSession(session)
    }));
  }

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const info = wsMap.get(ws);
    if (!info) return;

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

function handleMessage(ws, info, msg) {
  const { sessionId, guestId, role } = info;

  switch (msg.type) {
    case 'guest-join': {
      // Guest announces their name
      const name = (msg.name || 'Guest').slice(0, 60);
      addGuestToSession(sessionId, guestId, name, ws);
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'start-recording': {
      // Producer -> guest
      if (role !== 'producer') return;
      const targetGuestId = msg.guestId;
      const session = getSession(sessionId);
      if (!session) return;

      if (targetGuestId === 'all') {
        // Start all guests
        for (const [gId, guest] of session.guests) {
          if (guest.ws && guest.ws.readyState === 1) {
            guest.ws.send(JSON.stringify({ type: 'start-recording' }));
          }
        }
      } else {
        const guest = session.guests.get(targetGuestId);
        if (guest && guest.ws && guest.ws.readyState === 1) {
          guest.ws.send(JSON.stringify({ type: 'start-recording' }));
        }
      }
      break;
    }

    case 'stop-recording': {
      // Producer -> guest
      if (role !== 'producer') return;
      const targetGuestId = msg.guestId;
      const session = getSession(sessionId);
      if (!session) return;

      if (targetGuestId === 'all') {
        for (const [gId, guest] of session.guests) {
          if (guest.ws && guest.ws.readyState === 1) {
            guest.ws.send(JSON.stringify({ type: 'stop-recording' }));
          }
        }
      } else {
        const guest = session.guests.get(targetGuestId);
        if (guest && guest.ws && guest.ws.readyState === 1) {
          guest.ws.send(JSON.stringify({ type: 'stop-recording' }));
        }
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
      updateGuestStatus(sessionId, guestId, 'uploading', { uploadProgress: msg.percent });
      broadcastSessionUpdate(sessionId);
      break;
    }

    case 'upload-complete': {
      if (role !== 'guest') return;
      const fileName = msg.fileName || '';
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
// Start
// ========================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`Fieldcast server running at ${proto}://localhost:${PORT}`);
  console.log(`Guest page: ${proto}://localhost:${PORT}/guest/`);
});

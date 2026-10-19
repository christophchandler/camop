require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const S = require('./sessions');
const storage = require('./b2');
const { downloadAndConvert } = require('./converter');

const app = express();
app.set('trust proxy', 1);

// ========================================================
// Secrets and auth
// ========================================================
// Guest links are signed with this secret, so they keep working after a restart.
// Falls back to the storage key so it is stable without extra setup.
const SECRET = process.env.SESSION_SECRET || process.env.B2_APPLICATION_KEY || 'camop-dev-secret';
if (!process.env.SESSION_SECRET && !process.env.B2_APPLICATION_KEY) {
  console.warn('Warning: no SESSION_SECRET or B2_APPLICATION_KEY set; using a development secret.');
}
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

function hmac(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
const guestToken = sessionId => hmac(`guest:${sessionId}`).slice(0, 32);
const verifyGuestToken = (sessionId, t) => typeof sessionId === 'string' && /^[a-f0-9]{6,64}$/.test(sessionId) && safeEqual(guestToken(sessionId), t);
const AUTH_COOKIE = 'camop_auth';
const authCookieValue = () => hmac(`producer:${DASHBOARD_PASSWORD}`);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isProducer(req) {
  if (!DASHBOARD_PASSWORD) return true;
  return safeEqual(parseCookies(req.headers.cookie)[AUTH_COOKIE], authCookieValue());
}
function requireProducer(req, res, next) {
  if (isProducer(req)) return next();
  res.status(401).json({ error: 'Sign in required' });
}

// ========================================================
// Middleware
// ========================================================
app.use(express.json({ limit: '1mb' }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

function sanitizeString(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}
function safeFileName(name) {
  return sanitizeString(name, 200).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'recording';
}

// ========================================================
// Static files (guest page is never cached, so a deploy can't leave a stale copy)
// ========================================================
app.use('/guest', express.static(path.join(__dirname, '..', 'guest'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-store')
}));
const dashboardDist = path.join(__dirname, '..', 'dashboard', 'dist');
if (fs.existsSync(dashboardDist)) app.use(express.static(dashboardDist));

// ========================================================
// Health and auth
// ========================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    sessions: S.sessionCount(),
    storageConfigured: Boolean(process.env.B2_BUCKET_NAME && process.env.B2_ACCOUNT_ID && process.env.B2_APPLICATION_KEY && process.env.B2_BUCKET_ENDPOINT),
    passwordRequired: Boolean(DASHBOARD_PASSWORD)
  });
});

app.get('/api/me', (req, res) => {
  res.json({ passwordRequired: Boolean(DASHBOARD_PASSWORD), authed: isProducer(req) });
});

app.post('/api/login', loginLimiter, (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.json({ ok: true });
  if (!safeEqual(req.body && req.body.password, DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(authCookieValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  res.json({ ok: true });
});

// ========================================================
// Sessions (producer only)
// ========================================================
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS, 10) || 200;

function magicLinkFor(req, sessionId) {
  return `${req.protocol}://${req.get('host')}/guest/?session=${sessionId}&t=${guestToken(sessionId)}`;
}

app.post('/api/sessions', requireProducer, (req, res) => {
  const name = sanitizeString(req.body && req.body.name, 200);
  if (!name) return res.status(400).json({ error: 'Session name is required' });
  if (S.sessionCount() >= MAX_SESSIONS) return res.status(429).json({ error: 'Maximum session limit reached' });
  const session = S.createSession(name);
  res.json({ ...S.serializeSession(session), magicLink: magicLinkFor(req, session.id) });
});

app.get('/api/sessions', requireProducer, (req, res) => {
  res.json(S.getAllSessions().map(s => ({ ...s, magicLink: magicLinkFor(req, s.id) })));
});

app.get('/api/sessions/:id', requireProducer, (req, res) => {
  const session = S.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ ...S.serializeSession(session), magicLink: magicLinkFor(req, session.id) });
});

// ========================================================
// Uploads (guest, authorized by the signed link)
// Each recording is one multipart upload. The guest's browser keeps the
// uploadId and part progress on disk, so it can resume after anything.
// ========================================================
function guestAuth(req, res) {
  const src = req.method === 'PUT' ? req.query : (req.body || {});
  const { sessionId, t } = src;
  if (!verifyGuestToken(sessionId, t)) {
    res.status(403).json({ error: 'Invalid session link' });
    return null;
  }
  S.ensureSession(sessionId);
  return src;
}
function keyBelongs(sessionId, key) {
  return typeof key === 'string' && key.startsWith(`recordings/${sessionId}/`) && !key.includes('..');
}

app.post('/api/uploads/create', async (req, res) => {
  const b = guestAuth(req, res); if (!b) return;
  const contentType = sanitizeString(b.contentType, 100) || 'application/octet-stream';
  const key = `recordings/${b.sessionId}/${safeFileName(b.fileName)}`;
  try {
    const uploadId = await storage.createMultipart(key, contentType);
    res.json({ key, uploadId });
  } catch (err) {
    console.error('createMultipart failed:', err);
    res.status(502).json({ error: 'Storage unavailable, will retry' });
  }
});

// Upload speed test: the guest sends throwaway bytes over the same path its
// recording will take; the server counts and discards them.
const SPEEDTEST_MAX = 16 * 1024 * 1024;
app.put('/api/speedtest', (req, res) => {
  const q = guestAuth(req, res); if (!q) return;
  let bytes = 0;
  req.on('data', c => { bytes += c.length; if (bytes > SPEEDTEST_MAX) req.destroy(); });
  req.on('end', () => res.json({ ok: true, bytes }));
  req.on('error', () => { if (!res.headersSent) res.status(400).end(); });
});

const QUALITIES = new Set(['low', 'standard', 'high', '4k']);

// Producer thumbnails: the guest uploads a small JPEG every few seconds; the latest is kept in memory.
const THUMB_MAX = 300 * 1024;
app.put('/api/thumb', (req, res) => {
  const q = guestAuth(req, res); if (!q) return;
  const session = S.getSession(q.sessionId);
  const guest = session && session.guests.get(String(q.guestId || ''));
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > THUMB_MAX) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    if (guest) { guest.thumb = Buffer.concat(chunks); guest.thumbAt = Date.now(); broadcastSessionUpdate(q.sessionId); }
    res.json({ ok: true });
  });
  req.on('error', () => { if (!res.headersSent) res.status(400).end(); });
});
app.get('/api/sessions/:id/thumb/:guestId', requireProducer, (req, res) => {
  const session = S.getSession(req.params.id);
  const guest = session && session.guests.get(req.params.guestId);
  if (!guest || !guest.thumb) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.end(guest.thumb);
});

const MAX_PART_BYTES = 64 * 1024 * 1024;
app.put('/api/uploads/part', async (req, res) => {
  const q = guestAuth(req, res); if (!q) return;
  const partNumber = parseInt(q.partNumber, 10);
  const length = parseInt(req.headers['content-length'], 10);
  if (!keyBelongs(q.sessionId, q.key) || !q.uploadId || !(partNumber >= 1 && partNumber <= 10000)) {
    return res.status(400).json({ error: 'Bad part request' });
  }
  if (!(length > 0 && length <= MAX_PART_BYTES)) return res.status(411).json({ error: 'Content-Length required (max 64 MB)' });
  try {
    const etag = await storage.uploadPart(q.key, q.uploadId, partNumber, req, length);
    res.json({ ok: true, etag });
  } catch (err) {
    console.error(`uploadPart ${partNumber} failed:`, err.name || err);
    if (!res.headersSent) res.status(err.name === 'NoSuchUpload' ? 410 : 502).json({ error: err.name || 'Upload failed' });
  }
});

app.post('/api/uploads/complete', async (req, res) => {
  const b = guestAuth(req, res); if (!b) return;
  if (!keyBelongs(b.sessionId, b.key) || !b.uploadId) return res.status(400).json({ error: 'Bad request' });
  const expected = parseInt(b.expectedParts, 10) || 0;
  const fileInfo = {
    key: b.key,
    fileName: b.key.split('/').pop(),
    fileType: ['camera', 'screen', 'audio'].includes(b.fileType) ? b.fileType : 'camera',
    startTs: Number(b.startTs) || null,
    durationMs: Number(b.durationMs) || null,
    recIndex: Number(b.recIndex) || 1
  };
  try {
    let parts;
    try {
      parts = await storage.listAllParts(b.key, b.uploadId);
    } catch (err) {
      // Already completed by an earlier attempt whose response was lost.
      if (err.name === 'NoSuchUpload') {
        const head = await storage.headObject(b.key);
        finishFile(b, fileInfo, head.size);
        return res.json({ ok: true, size: head.size, alreadyComplete: true });
      }
      throw err;
    }
    const numbers = new Set(parts.map(p => p.PartNumber));
    const missing = [];
    for (let n = 1; n <= expected; n++) if (!numbers.has(n)) missing.push(n);
    if (missing.length) return res.status(409).json({ error: 'Missing parts', missing });
    if (!parts.length) return res.status(409).json({ error: 'No parts uploaded', missing: [1] });
    await storage.completeMultipart(b.key, b.uploadId, parts);
    const head = await storage.headObject(b.key);
    finishFile(b, fileInfo, head.size);
    res.json({ ok: true, size: head.size });
  } catch (err) {
    console.error('complete failed:', err);
    res.status(502).json({ error: 'Storage unavailable, will retry' });
  }
});

function finishFile(b, fileInfo, size) {
  const guestId = sanitizeString(b.guestId, 64);
  const needsConversion = fileInfo.fileName.endsWith('.webm');
  S.addGuestFile(b.sessionId, guestId, { ...fileInfo, size, status: needsConversion ? 'needs-conversion' : 'complete' });
  const session = S.getSession(b.sessionId);
  if (session) S.addLog(session, `Saved ${fileInfo.fileName} (${(size / 1048576).toFixed(1)} MB)`);
  broadcastSessionUpdate(b.sessionId);
}

app.post('/api/uploads/abort', async (req, res) => {
  const b = guestAuth(req, res); if (!b) return;
  if (!keyBelongs(b.sessionId, b.key) || !b.uploadId) return res.status(400).json({ error: 'Bad request' });
  try { await storage.abortMultipart(b.key, b.uploadId); } catch {}
  res.json({ ok: true });
});

// WebM (Firefox) to MP4, producer-triggered.
app.post('/api/sessions/:id/convert', requireProducer, async (req, res) => {
  const session = S.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const guest = session.guests.get(req.body.guestId);
  if (!guest) return res.status(400).json({ error: 'Guest not found' });
  const idx = typeof req.body.fileIndex === 'number' ? req.body.fileIndex : guest.files.findIndex(f => f.fileName.endsWith('.webm'));
  const fileEntry = guest.files[idx];
  if (!fileEntry) return res.status(400).json({ error: 'No file to convert' });
  try {
    fileEntry.status = 'converting';
    broadcastSessionUpdate(req.params.id);
    const mp4Path = await downloadAndConvert(await storage.generatePresignedGetUrl(fileEntry.key), fileEntry.fileName);
    const mp4Key = fileEntry.key.replace(/\.webm$/, '.mp4');
    const uploadRes = await fetch(await storage.generatePresignedPutUrl(mp4Key, 'video/mp4'), {
      method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: fs.readFileSync(mp4Path)
    });
    try { fs.unlinkSync(mp4Path); } catch {}
    if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
    Object.assign(fileEntry, { key: mp4Key, fileName: mp4Key.split('/').pop(), status: 'complete' });
    broadcastSessionUpdate(req.params.id);
    res.json({ success: true, fileName: fileEntry.fileName });
  } catch (err) {
    console.error('Conversion failed:', err);
    fileEntry.status = 'conversion-failed';
    broadcastSessionUpdate(req.params.id);
    res.status(500).json({ error: `Conversion failed: ${err.message}` });
  }
});

// ========================================================
// Servers
// ========================================================
const server = http.createServer(app);
server.requestTimeout = 0; // long part uploads on slow connections
let httpsServer = null;
if (process.env.NODE_ENV === 'development') {
  const certPath = path.join(__dirname, '..', 'localhost+1.pem');
  const keyPath = path.join(__dirname, '..', 'localhost+1-key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    httpsServer = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app);
  }
}

// ========================================================
// WebSockets
// ========================================================
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
function handleUpgrade(request, socket, head) {
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
}
server.on('upgrade', handleUpgrade);
if (httpsServer) httpsServer.on('upgrade', handleUpgrade);

const wsMap = new Map(); // ws -> { sessionId, guestId, role }

const GUEST_MSGS = new Set([
  'guest-join', 'guest-setup-started', 'guest-ready', 'recording-started', 'recording-stopped',
  'guest-status', 'guest:control-update', 'guest:request-response', 'guest:recording-restarted',
  'guest:screen-share-started', 'guest:screen-share-stopped', 'guest-speed'
]);
const PRODUCER_MSGS = new Set(['start-recording', 'stop-recording', 'producer:request', 'producer:cancel-request', 'producer:set-quality']);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session');
  const role = url.searchParams.get('role');

  if (role === 'guest') {
    if (!verifyGuestToken(sessionId, url.searchParams.get('t'))) return ws.close(4003, 'Invalid session link');
  } else if (role === 'producer') {
    if (!isProducer(req)) return ws.close(4003, 'Sign in required');
    if (!sessionId || !/^[a-f0-9]{6,64}$/.test(sessionId)) return ws.close(4000, 'Missing session');
  } else {
    return ws.close(4000, 'Missing or invalid parameters');
  }

  const session = S.ensureSession(sessionId);
  wsMap.set(ws, { sessionId, guestId: null, role });

  if (role === 'producer') {
    ws.send(JSON.stringify({ type: 'session-state', session: S.serializeSession(session) }));
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const info = wsMap.get(ws);
    if (!info) return;
    const allowed = info.role === 'guest' ? GUEST_MSGS : PRODUCER_MSGS;
    if (!allowed.has(msg.type)) return;
    if (info.role === 'guest' && msg.type !== 'guest-join' && !info.guestId) return;
    handleMessage(ws, info, msg);
  });

  ws.on('close', () => {
    const info = wsMap.get(ws);
    wsMap.delete(ws);
    if (info && info.role === 'guest' && info.guestId) {
      S.markGuestDisconnected(info.sessionId, info.guestId, ws);
      broadcastSessionUpdate(info.sessionId);
    }
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

function sendToGuest(session, gId, payload) {
  const guest = session.guests.get(gId);
  if (guest && guest.ws && guest.ws.readyState === 1) guest.ws.send(JSON.stringify(payload));
}
function findProducerSockets(sessionId) {
  const out = [];
  for (const [ws, info] of wsMap) {
    if (info.sessionId === sessionId && info.role === 'producer' && ws.readyState === 1) out.push(ws);
  }
  return out;
}

function handleMessage(ws, info, msg) {
  const { sessionId, role } = info;
  const session = S.getSession(sessionId) || S.ensureSession(sessionId);
  const guestId = info.guestId;

  switch (msg.type) {
    case 'guest-join': {
      const id = sanitizeString(msg.clientId, 64).replace(/[^a-zA-Z0-9_-]/g, '') || crypto.randomBytes(8).toString('hex');
      info.guestId = id;
      S.addGuestToSession(sessionId, id, sanitizeString(msg.name || 'Guest', 60), ws);
      if (msg.consentAt) S.updateGuestStatus(sessionId, id, session.guests.get(id).status, { consentAt: sanitizeString(String(msg.consentAt), 40) });
      ws.send(JSON.stringify({ type: 'joined', guestId: id }));
      broadcastSessionUpdate(sessionId);
      break;
    }
    case 'guest-setup-started':
      S.updateGuestStatus(sessionId, guestId, 'setting-up');
      broadcastSessionUpdate(sessionId);
      break;
    case 'guest-ready':
      S.updateGuestControls(sessionId, guestId, { activeCamera: sanitizeString(msg.activeCamera || '', 120), activeMic: sanitizeString(msg.activeMic || '', 120) });
      S.updateGuestStatus(sessionId, guestId, 'ready');
      broadcastSessionUpdate(sessionId);
      break;
    case 'recording-started':
    case 'guest:recording-restarted':
      S.updateGuestStatus(sessionId, guestId, 'recording');
      broadcastSessionUpdate(sessionId);
      break;
    case 'recording-stopped':
      S.updateGuestStatus(sessionId, guestId, 'uploading');
      broadcastSessionUpdate(sessionId);
      break;
    case 'guest-status': {
      const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
      const stats = {
        recording: Boolean(msg.recording),
        recordingMs: num(msg.recordingMs),
        recordedBytes: num(msg.recordedBytes),
        uploadedBytes: num(msg.uploadedBytes),
        pendingBytes: num(msg.pendingBytes),
        unfinished: num(msg.unfinished),
        width: num(msg.width),
        height: num(msg.height),
        fps: num(msg.fps),
        micLevel: num(msg.micLevel),
        brightness: typeof msg.brightness === 'number' ? msg.brightness : -1,
        cameraOff: Boolean(msg.cameraOff),
        lastError: sanitizeString(msg.lastError || '', 200),
        storageFreeMB: num(msg.storageFreeMB),
        at: Date.now()
      };
      S.updateGuestStats(sessionId, guestId, stats);
      const guest = session.guests.get(guestId);
      if (guest) {
        const total = stats.uploadedBytes + stats.pendingBytes;
        const pct = total > 0 ? Math.floor((stats.uploadedBytes / total) * 100) : 100;
        if (stats.recording) S.updateGuestStatus(sessionId, guestId, 'recording', { uploadProgress: pct });
        else if (stats.unfinished > 0) S.updateGuestStatus(sessionId, guestId, 'uploading', { uploadProgress: pct });
        else if (guest.status === 'uploading' || guest.status === 'recording') S.updateGuestStatus(sessionId, guestId, 'done', { uploadProgress: 100 });
      }
      broadcastSessionUpdate(sessionId);
      break;
    }
    case 'guest-speed': {
      const guest = session.guests.get(guestId);
      if (!guest) return;
      const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
      guest.speed = {
        uploadMbps: Math.round(num(msg.uploadMbps) * 10) / 10,
        camMaxW: num(msg.camMaxW), camMaxH: num(msg.camMaxH),
        recommended: QUALITIES.has(msg.recommended) ? msg.recommended : 'standard',
        failed: Boolean(msg.failed),
        at: Date.now()
      };
      S.addLog(session, `${guest.name}: upload ${guest.speed.failed ? 'test failed' : guest.speed.uploadMbps + ' Mbps'}, recommended ${guest.speed.recommended}`);
      broadcastSessionUpdate(sessionId);
      break;
    }
    case 'producer:set-quality': {
      if (role !== 'producer') return;
      const guest = session.guests.get(msg.guestId);
      if (!guest || !QUALITIES.has(msg.quality)) return;
      guest.quality = msg.quality;
      broadcastSessionUpdate(sessionId);
      break;
    }
    case 'guest:control-update':
      S.updateGuestControls(sessionId, guestId, {
        muted: Boolean(msg.muted), cameraOff: Boolean(msg.cameraOff), screenSharing: Boolean(msg.screenSharing),
        activeCamera: msg.activeCamera ? sanitizeString(msg.activeCamera, 120) : undefined,
        activeMic: msg.activeMic ? sanitizeString(msg.activeMic, 120) : undefined
      });
      broadcastSessionUpdate(sessionId);
      break;
    case 'guest:request-response':
      S.setGuestPendingRequest(sessionId, guestId, null);
      broadcastSessionUpdate(sessionId);
      break;
    case 'guest:screen-share-started':
    case 'guest:screen-share-stopped':
      S.updateGuestControls(sessionId, guestId, { screenSharing: msg.type === 'guest:screen-share-started' });
      broadcastSessionUpdate(sessionId);
      break;

    case 'start-recording':
    case 'stop-recording': {
      if (role !== 'producer') return;
      const targets = msg.guestId === 'all' ? [...session.guests.keys()] : [msg.guestId];
      for (const gId of targets) {
        const guest = session.guests.get(gId);
        if (!guest) continue;
        if (msg.type === 'start-recording' && !['ready', 'connected', 'done'].includes(guest.status)) {
          for (const p of findProducerSockets(sessionId)) {
            p.send(JSON.stringify({ type: 'start-rejected', guestId: gId, reason: guest.status === 'setting-up' ? 'Guest is still setting up.' : `Cannot start: guest is ${guest.status}` }));
          }
          continue;
        }
        const quality = QUALITIES.has(msg.quality) && msg.guestId !== 'all' ? msg.quality
          : (guest.quality || (guest.speed && guest.speed.recommended) || 'standard');
        if (msg.type === 'start-recording' && msg.guestId !== 'all' && QUALITIES.has(msg.quality)) guest.quality = msg.quality;
        sendToGuest(session, gId, msg.type === 'start-recording' ? { type: msg.type, quality } : { type: msg.type });
      }
      break;
    }
    case 'producer:request': {
      if (role !== 'producer') return;
      const guest = session.guests.get(msg.guestId);
      if (!guest || !guest.ws || guest.ws.readyState !== 1) return;
      const requestType = ['mute', 'cameraOff', 'deviceSwitch'].includes(msg.requestType) ? msg.requestType : null;
      if (!requestType) return;
      S.setGuestPendingRequest(sessionId, msg.guestId, requestType);
      sendToGuest(session, msg.guestId, { type: 'producer:request', requestType });
      broadcastSessionUpdate(sessionId);
      break;
    }
    case 'producer:cancel-request':
      if (role !== 'producer') return;
      S.setGuestPendingRequest(sessionId, msg.guestId, null);
      sendToGuest(session, msg.guestId, { type: 'producer:cancel-request' });
      broadcastSessionUpdate(sessionId);
      break;
  }
}

// Coalesce updates: at most one broadcast per session every 400 ms.
const pendingBroadcasts = new Map();
function broadcastSessionUpdate(sessionId) {
  if (pendingBroadcasts.has(sessionId)) return;
  pendingBroadcasts.set(sessionId, setTimeout(() => {
    pendingBroadcasts.delete(sessionId);
    const session = S.getSession(sessionId);
    if (!session) return;
    const payload = JSON.stringify({ type: 'session-state', session: S.serializeSession(session) });
    for (const ws of findProducerSockets(sessionId)) ws.send(payload);
  }, 400));
}

// Dashboard SPA catch-all
if (fs.existsSync(dashboardDist)) {
  app.get('*', (req, res) => res.sendFile(path.join(dashboardDist, 'index.html')));
}

// ========================================================
// Housekeeping and shutdown
// ========================================================
const SESSION_TTL_MS = (parseInt(process.env.SESSION_TTL_HOURS, 10) || 72) * 3600000;
const cleanupInterval = setInterval(() => S.cleanupExpiredSessions(SESSION_TTL_MS), 60 * 60 * 1000);

function shutdown(signal) {
  console.log(`${signal} received. Shutting down.`);
  clearInterval(pingInterval);
  clearInterval(cleanupInterval);
  wss.clients.forEach(ws => ws.close(1012, 'Server restarting'));
  server.close(() => process.exit(0));
  if (httpsServer) httpsServer.close();
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`CamOp server running on port ${PORT}`));
if (httpsServer) httpsServer.listen(3443, () => console.log('CamOp HTTPS on 3443'));

module.exports = { guestToken };

// Delivers finished recordings to a Google Drive shared drive.
//
// Guests upload into CamOp's bucket first (that path survives crashes and restarts);
// as soon as a file is complete, this copies it to
//   <shared drive>/<YYMMDD_Client_Project>/2_FOOTAGE/1_VIDEO/CAMOP/<file>
// using Drive's resumable upload, checks Drive's MD5 against the bytes sent, and records
// the Drive link on the file. Anything not yet delivered is picked up again after a restart.
//
// Auth: a service account key in GOOGLE_SERVICE_ACCOUNT_JSON, added to the shared drive as
// Content manager. Optional: DRIVE_SHARED_DRIVE_NAME when it belongs to several drives.
const crypto = require('crypto');
const storage = require('./b2');
const S = require('./sessions');
const P = require('./project');

const API = process.env.DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3';
const UPLOAD = process.env.DRIVE_UPLOAD_BASE || 'https://www.googleapis.com/upload/drive/v3';
const CHUNK = Math.max(256 * 1024, Math.round((Number(process.env.DRIVE_CHUNK_MB) || 32) * 4) * 256 * 1024); // multiple of 256 KiB
const FOLDER = 'application/vnd.google-apps.folder';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let key = null;
function loadKey() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  try {
    const k = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    if (!k.client_email || !k.private_key) throw new Error('missing client_email or private_key');
    return k;
  } catch (e) {
    console.error('GOOGLE_SERVICE_ACCOUNT_JSON is not a valid service account key:', e.message);
    return null;
  }
}
key = loadKey();
const configured = () => Boolean(key);

// ------------------------------------------------------------------ auth
let token = null, tokenExp = 0;
const b64url = s => Buffer.from(s).toString('base64url');
async function accessToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const tokenUri = process.env.DRIVE_TOKEN_URI || key.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: tokenUri, iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key.private_key, 'base64url');
  const res = await fetch(tokenUri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` })
  });
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  token = j.access_token; tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

// One Drive API call, retried on rate limits, server errors and dropped connections.
async function call(method, url, { json, body, headers = {}, okStatuses = [200], tries = 6 } = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const h = { Authorization: `Bearer ${await accessToken()}`, ...headers };
      let payload = body;
      if (json !== undefined) { h['Content-Type'] = 'application/json; charset=UTF-8'; payload = JSON.stringify(json); }
      const res = await fetch(url, { method, headers: h, body: payload, redirect: 'manual' });
      if (okStatuses.includes(res.status)) return res;
      const text = await res.text().catch(() => '');
      last = new Error(`Drive ${method} ${res.status}: ${text.slice(0, 200)}`);
      last.status = res.status;
      if (res.status === 401) token = null;
      if (![401, 408, 429, 500, 502, 503, 504].includes(res.status) && !(res.status === 403 && /rateLimit|userRateLimit/i.test(text))) throw last;
    } catch (e) {
      if (e.status && ![401, 408, 429, 500, 502, 503, 504, 403].includes(e.status)) throw e;
      last = e;
    }
    await sleep(Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 300);
  }
  throw last;
}
const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const ALL = 'supportsAllDrives=true';

// ------------------------------------------------------------------ shared drive and folders
let drive = null; // { id, name }
async function sharedDrive() {
  if (drive) return drive;
  if (process.env.DRIVE_SHARED_DRIVE_ID) { drive = { id: process.env.DRIVE_SHARED_DRIVE_ID, name: process.env.DRIVE_SHARED_DRIVE_ID }; return drive; }
  const res = await call('GET', `${API}/drives?pageSize=100&fields=drives(id,name)`);
  const drives = (await res.json()).drives || [];
  const want = (process.env.DRIVE_SHARED_DRIVE_NAME || '').trim().toLowerCase();
  const pick = want ? drives.find(d => d.name.trim().toLowerCase() === want) : (drives.length === 1 ? drives[0] : null);
  if (!pick) {
    throw new Error(drives.length
      ? `The service account is in ${drives.length} shared drives (${drives.map(d => d.name).join(', ')}); set DRIVE_SHARED_DRIVE_NAME`
      : `Add ${key.client_email} to the shared drive as Content manager`);
  }
  drive = pick;
  return drive;
}

const folderCache = new Map();
let folderChain = Promise.resolve(); // one folder lookup/create at a time, so two files never make twin folders
function folderId(parentId, name) {
  const k = `${parentId}/${name}`;
  if (folderCache.has(k)) return Promise.resolve(folderCache.get(k));
  const p = folderChain.then(async () => {
    if (folderCache.has(k)) return folderCache.get(k);
    const d = await sharedDrive();
    const query = `name = '${q(name)}' and '${parentId}' in parents and mimeType = '${FOLDER}' and trashed = false`;
    const res = await call('GET', `${API}/files?q=${encodeURIComponent(query)}&corpora=drive&driveId=${d.id}&includeItemsFromAllDrives=true&${ALL}&fields=files(id,name,webViewLink)`);
    let f = ((await res.json()).files || [])[0];
    if (!f) {
      const c = await call('POST', `${API}/files?${ALL}&fields=id,name,webViewLink`, { json: { name, mimeType: FOLDER, parents: [parentId] } });
      f = await c.json();
    }
    folderCache.set(k, f.id);
    if (f.webViewLink) folderCache.set(`link:${f.id}`, f.webViewLink);
    return f.id;
  });
  folderChain = p.catch(() => {});
  return p;
}
async function camopFolder(session) {
  let id = (await sharedDrive()).id;
  for (const part of [...session.folder.split('/'), '2_FOOTAGE', '1_VIDEO', 'CAMOP']) id = await folderId(id, part);
  return id;
}
const projectFolderLink = id => folderCache.get(`link:${id}`) || `https://drive.google.com/drive/folders/${id}`;

async function findFile(parentId, name) {
  const d = await sharedDrive();
  const query = `name = '${q(name)}' and '${parentId}' in parents and trashed = false`;
  const res = await call('GET', `${API}/files?q=${encodeURIComponent(query)}&corpora=drive&driveId=${d.id}&includeItemsFromAllDrives=true&${ALL}&fields=files(id,name,size,md5Checksum,webViewLink)`);
  return ((await res.json()).files || [])[0] || null;
}

// ------------------------------------------------------------------ resumable upload from storage
const FIELDS = 'id,name,size,md5Checksum,webViewLink';
async function uploadFromStorage(objKey, name, parentId, mimeType, size, onProgress) {
  const init = await call('POST', `${UPLOAD}/files?uploadType=resumable&${ALL}&fields=${FIELDS}`, {
    json: { name, parents: [parentId], mimeType },
    headers: { 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size) }
  });
  const session = init.headers.get('location');
  if (!session) throw new Error('Drive did not return an upload session');
  const md5 = crypto.createHash('md5');
  let hashed = 0, offset = 0, meta = null, stalls = 0;
  const committed = res => { const r = /bytes=0-(\d+)/.exec(res.headers.get('range') || ''); return r ? Number(r[1]) + 1 : 0; };

  while (!meta) {
    if (offset >= size && size > 0) {
      // Every byte is there but the last answer was lost: ask Drive to finish.
      const st = await call('PUT', session, { headers: { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }, okStatuses: [200, 201, 308] });
      if (st.status === 308) { offset = committed(st); continue; }
      meta = await st.json(); break;
    }
    const end = Math.min(offset + CHUNK, size) - 1;
    const buf = size ? await storage.getRange(objKey, offset, end) : Buffer.alloc(0);
    let res = null;
    try {
      res = await fetch(session, {
        method: 'PUT', body: buf, redirect: 'manual',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Length': String(buf.length), 'Content-Range': size ? `bytes ${offset}-${end}/${size}` : 'bytes */0' }
      });
    } catch { res = null; }
    let next;
    if (res && (res.status === 200 || res.status === 201)) { meta = await res.json(); next = size; }
    else if (res && res.status === 308) next = committed(res);
    else if (res && res.status === 404) throw Object.assign(new Error('Drive upload session expired'), { restart: true });
    else {
      // Dropped connection or a server error: Drive may have kept part of the chunk. Ask where it got to.
      if (res) await res.text().catch(() => {});
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(stalls, 5)));
      const st = await call('PUT', session, { headers: { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }, okStatuses: [200, 201, 308, 404] });
      if (st.status === 404) throw Object.assign(new Error('Drive upload session expired'), { restart: true });
      if (st.status !== 308) { meta = await st.json(); next = size; }
      else next = committed(st);
    }
    // Hash each byte exactly once, in order, as Drive confirms it.
    if (next > hashed) {
      const from = hashed - offset, to = Math.min(next, end + 1) - offset;
      if (from >= 0 && to > from) { md5.update(buf.subarray(from, to)); hashed = offset + to; }
    }
    stalls = next > offset ? 0 : stalls + 1;
    if (stalls > 20) throw new Error('Drive upload stopped making progress');
    offset = next;
    onProgress(Math.min(1, offset / (size || 1)));
  }
  if (hashed < size) {
    // Finished on a lost answer: hash the tail we know Drive holds.
    for (let o = hashed; o < size; o += CHUNK) md5.update(await storage.getRange(objKey, o, Math.min(o + CHUNK, size) - 1));
  }
  const sent = md5.digest('hex');
  if (meta.md5Checksum && meta.md5Checksum !== sent) {
    await call('DELETE', `${API}/files/${meta.id}?${ALL}`, { okStatuses: [200, 204, 404] }).catch(() => {});
    throw Object.assign(new Error(`Drive copy did not match (md5 ${meta.md5Checksum} vs ${sent}); retrying`), { restart: true });
  }
  if (Number(meta.size) !== size) throw Object.assign(new Error(`Drive copy is ${meta.size} bytes, expected ${size}`), { restart: true });
  return { ...meta, md5: sent };
}

// ------------------------------------------------------------------ delivery queue
const MIME = { mp4: 'video/mp4', m4a: 'audio/mp4', webm: 'video/webm', json: 'application/json' };
let onUpdate = () => {};
const queue = [];
const queued = new Set();
let active = 0;
const MAX_ACTIVE = 2;

function findFileEntry(session, fileKey) {
  for (const [guestId, g] of session.guests) {
    const f = g.files.find(x => x.key === fileKey);
    if (f) return { guestId, f };
  }
  return null;
}

function enqueue(sessionId, fileKey, delayMs = 0) {
  if (!configured()) return;
  const id = `${sessionId}|${fileKey}`;
  if (queued.has(id)) return;
  queued.add(id);
  const push = () => { queue.push({ sessionId, fileKey, id }); pump(); };
  if (delayMs) setTimeout(push, delayMs).unref(); else push();
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    active++;
    deliver(job).finally(() => { active--; queued.delete(job.id); pump(); });
  }
}

async function deliver(job) {
  const session = S.getSession(job.sessionId);
  const hit = session && findFileEntry(session, job.fileKey);
  if (!hit) return;
  const f = hit.f;
  if (f.drive && f.drive.state === 'delivered') return;
  const attempts = ((f.drive && f.drive.attempts) || 0) + 1;
  f.drive = { state: 'uploading', pct: 0, attempts };
  onUpdate(session.id);
  try {
    const parent = await camopFolder(session);
    session.driveFolderLink = projectFolderLink(parent);
    const name = f.fileName;
    const size = f.size || (await storage.headObject(f.key)).size;
    let meta = await findFile(parent, name);
    if (!(meta && Number(meta.size) === size)) {
      let lastPct = 0;
      meta = await uploadFromStorage(f.key, name, parent, MIME[name.split('.').pop()] || 'application/octet-stream', size, pct => {
        if (pct - lastPct >= 0.05 || pct === 1) { lastPct = pct; f.drive = { state: 'uploading', pct: Math.round(pct * 100), attempts }; onUpdate(session.id); }
      });
    }
    f.drive = { state: 'delivered', id: meta.id, link: meta.webViewLink || `https://drive.google.com/file/d/${meta.id}/view`, md5: meta.md5 || meta.md5Checksum || null, at: new Date().toISOString() };
    S.addLog(session, `In Google Drive: ${name}`);
    S.touch(session);
    onUpdate(session.id);
    scheduleManifest(session.id);
  } catch (e) {
    const wait = Math.min(10 * 60_000, 15_000 * 2 ** Math.min(attempts - 1, 6));
    f.drive = { state: 'retrying', attempts, error: String(e.message || e).slice(0, 200), next: new Date(Date.now() + wait).toISOString() };
    console.error(`Drive delivery of ${f.fileName} failed (attempt ${attempts}):`, e.message);
    S.touch(session);
    onUpdate(session.id);
    enqueue(session.id, f.key, wait);
  }
}

// The session file goes to Drive too, beside the recordings.
const manifestTimers = new Map();
function scheduleManifest(sessionId) {
  if (manifestTimers.has(sessionId)) return;
  manifestTimers.set(sessionId, setTimeout(async () => {
    manifestTimers.delete(sessionId);
    const session = S.getSession(sessionId);
    if (!session) return;
    try {
      const parent = await camopFolder(session);
      const name = P.manifestKey(session).split('/').pop();
      const body = JSON.stringify(S.toManifest(session), null, 2);
      let id = session.driveManifestId;
      if (!id) { const ex = await findFile(parent, name); id = ex && ex.id; }
      if (!id) {
        const c = await call('POST', `${API}/files?${ALL}&fields=id`, { json: { name, parents: [parent], mimeType: 'application/json' } });
        id = (await c.json()).id;
      }
      await call('PATCH', `${UPLOAD}/files/${id}?uploadType=media&${ALL}&fields=id`, { body, headers: { 'Content-Type': 'application/json' } });
      session.driveManifestId = id;
    } catch (e) {
      console.error('Drive session file update failed:', e.message);
      setTimeout(() => scheduleManifest(sessionId), 60_000).unref();
    }
  }, 3000));
}

// After a restart: anything finished but not yet in Drive goes back in the queue.
function rescan() {
  if (!configured()) return 0;
  let n = 0;
  for (const s of S.allSessionObjects()) {
    for (const [, g] of s.guests) {
      for (const f of g.files) {
        if (f.size > 0 && ['complete', 'needs-conversion'].includes(f.status) && !(f.drive && f.drive.state === 'delivered')) { enqueue(s.id, f.key); n++; }
      }
    }
  }
  return n;
}

async function status() {
  if (!configured()) return { configured: false };
  try {
    const d = await sharedDrive();
    return { configured: true, ok: true, drive: d.name, account: key.client_email, queue: queue.length + active };
  } catch (e) {
    return { configured: true, ok: false, account: key.client_email, error: e.message };
  }
}

function start(update) { onUpdate = update || onUpdate; }

module.exports = { configured, enqueue, rescan, status, start, _internals: { CHUNK, uploadFromStorage, camopFolder } };

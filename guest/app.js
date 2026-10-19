/* CamOp guest recorder.
 *
 * Reliability model:
 *  - Every 2 s of footage is written to IndexedDB on the guest's own disk.
 *  - A background uploader turns those chunks into 8 MB multipart parts and sends
 *    them to CamOp's server while the call is still running.
 *  - Progress (uploadId, parts done) lives on disk too, so a refresh, crash, lost
 *    connection or reopened link resumes exactly where it stopped.
 *  - An audio-only safety track records in parallel as its own file.
 */
(() => {
  'use strict';

  // ========================================================
  // Setup and helpers
  // ========================================================
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session');
  const token = params.get('t');

  // 8 MB parts; tests can lower it (storage requires at least 5 MB for every part but the last).
  const PART_SIZE = Math.max(5, Number(params.get('partmb')) || 8) * 1024 * 1024;
  const CHUNK_MS = 2000;
  const VIDEO_BPS = 6_000_000; // screen share and fallback
  // Quality tiers. 'needMbps' is the upload speed that keeps up live, with ~30% headroom.
  const QUALITY = {
    low:      { label: 'Low bandwidth', w: 1920, h: 1080, bps: 3_000_000,  needMbps: 0 },
    standard: { label: '1080p Standard', w: 1920, h: 1080, bps: 6_000_000,  needMbps: 8 },
    high:     { label: '1080p High',     w: 1920, h: 1080, bps: 10_000_000, needMbps: 13 },
    '4k':     { label: '4K',             w: 3840, h: 2160, bps: 20_000_000, needMbps: 26 }
  };
  let speedResult = null;

  // High then Main profile H.264 first: Baseline 3.0 is only specified up to 720x576.
  const VIDEO_MIMES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d0028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  const AUDIO_MIMES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  const pick = list => (window.MediaRecorder ? list.find(t => MediaRecorder.isTypeSupported(t)) : null);
  const videoMime = pick(VIDEO_MIMES);
  const audioMime = pick(AUDIO_MIMES);
  const extFor = mime => (mime && mime.includes('webm') ? 'webm' : (mime && mime.startsWith('audio') ? 'm4a' : 'mp4'));

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmtMB = b => (b / 1048576).toFixed(b > 100 * 1048576 ? 0 : 1);
  let lastError = '';
  function noteError(msg) { lastError = String(msg).slice(0, 200); console.warn('[camop]', msg); }

  // One stable id per browser per session, so reconnects resume the same guest tile.
  function clientId() {
    const k = `camop_client_${sessionId}`;
    try {
      let id = localStorage.getItem(k);
      if (!id) { id = crypto.getRandomValues(new Uint32Array(3)).join('-'); localStorage.setItem(k, id); }
      return id;
    } catch { return 'g-' + Math.random().toString(36).slice(2); }
  }
  const CLIENT_ID = sessionId ? clientId() : null;

  // ========================================================
  // DOM
  // ========================================================
  const nameScreen = $('name-screen'), nameInput = $('name-input'), joinBtn = $('join-btn'), consentInput = $('consent-input');
  const recordingScreen = $('recording-screen'), videoPreview = $('video-preview');
  const statusText = $('status-text'), recBar = $('rec-bar'), timerEl = $('timer');
  const codecBadge = $('codec-badge'), sizeBadge = $('size-badge');
  const controls = $('controls'), stopBtn = $('stop-btn');
  const progressContainer = $('progress-container'), progressBar = $('progress-bar');
  const connectionBar = $('connection-bar'), mutedWarning = $('muted-warning');
  const noticeBar = $('notice-bar'), recoveryBar = $('recovery-bar'), uploadLine = $('upload-line');
  const errorScreen = $('error-screen'), errorMsg = $('error-msg'), errorInstructions = $('error-instructions');
  const setupModal = $('setup-modal'), setupPreview = $('setup-preview');
  const cameraSelect = $('camera-select'), micSelect = $('mic-select');
  const audioMeterBar = $('audio-meter-bar'), setupError = $('setup-error'), setupConfirmBtn = $('setup-confirm-btn');
  const toolbarWrapper = $('toolbar-wrapper');
  const tbMute = $('tb-mute'), micPair = $('mic-pair'), tbMuteLabel = $('tb-mute-label');
  const tbVideo = $('tb-video'), camPair = $('cam-pair'), tbVideoLabel = $('tb-video-label');
  const tbCamSwitch = $('tb-cam-switch'), camDropdown = $('cam-dropdown');
  const tbMicSwitch = $('tb-mic-switch'), micDropdown = $('mic-dropdown');
  const tbScreen = $('tb-screen'), tbScreenLabel = $('tb-screen-label');
  const screenThumbContainer = $('screen-thumb-container'), screenThumbVideo = $('screen-thumb-video');
  const toastContainer = $('toast-container'), toastText = $('toast-text');
  const toastApprove = $('toast-approve'), toastDismiss = $('toast-dismiss');

  function setStatus(text, cls) { statusText.textContent = text; statusText.className = `status-msg ${cls || 'status-waiting'}`; }
  function notice(text) { noticeBar.textContent = text; noticeBar.style.display = text ? 'flex' : 'none'; }

  // ========================================================
  // IndexedDB: recordings + chunks on the guest's disk
  // ========================================================
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('camop', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('recordings')) d.createObjectStore('recordings', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function tx(stores, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
      result = fn(t);
    });
  }
  const putRec = rec => tx(['recordings'], 'readwrite', t => { t.objectStore('recordings').put(rec); });
  const getRec = id => tx(['recordings'], 'readonly', t => {
    const out = {}; const r = t.objectStore('recordings').get(id); r.onsuccess = () => { out.v = r.result; }; return out;
  }).then(o => o.v);
  const allRecs = () => tx(['recordings'], 'readonly', t => {
    const out = { v: [] }; const r = t.objectStore('recordings').getAll(); r.onsuccess = () => { out.v = r.result; }; return out;
  }).then(o => o.v);
  // Read-modify-write inside one transaction, so the recorder and the uploader
  // never overwrite each other's fields.
  const patchRec = (id, fn) => tx(['recordings'], 'readwrite', t => {
    const out = {}; const s = t.objectStore('recordings'); const r = s.get(id);
    r.onsuccess = () => { const v = r.result; if (!v) return; fn(v); s.put(v); out.v = v; };
    return out;
  }).then(o => o.v);
  const appendChunk = (recId, seq, blob) => tx(['chunks', 'recordings'], 'readwrite', t => {
    t.objectStore('chunks').put({ recId, seq, blob });
    const s = t.objectStore('recordings'); const r = s.get(recId);
    r.onsuccess = () => { const v = r.result; if (!v) return; v.chunkCount = Math.max(v.chunkCount, seq + 1); v.totalBytes += blob.size; s.put(v); };
  });
  const getChunks = (recId, from, to) => tx(['chunks'], 'readonly', t => {
    const out = { v: [] };
    const r = t.objectStore('chunks').getAll(IDBKeyRange.bound([recId, from], [recId, to - 1]));
    r.onsuccess = () => { out.v = r.result; };
    return out;
  }).then(o => o.v);
  const deleteChunks = recId => tx(['chunks'], 'readwrite', t => {
    t.objectStore('chunks').delete(IDBKeyRange.bound([recId, 0], [recId, Number.MAX_SAFE_INTEGER]));
  });

  // ========================================================
  // Track recorder: one MediaRecorder writing to disk
  // ========================================================
  class TrackRecorder {
    constructor(stream, { fileType, mime, videoBps, audioBps, recIndex }) {
      this.stream = stream; this.fileType = fileType; this.mime = mime;
      this.videoBps = videoBps; this.audioBps = audioBps; this.recIndex = recIndex;
      this.writeChain = Promise.resolve();
      this.seq = 0; this.bytes = 0;
    }
    async start() {
      const startTs = Date.now();
      this.rec = {
        id: `${sessionId}_${CLIENT_ID}_${this.fileType}_${startTs}`,
        sessionId, t: token, guestId: CLIENT_ID,
        fileName: buildFileName(this.fileType, startTs, this.recIndex, extFor(this.mime)),
        mime: this.mime, fileType: this.fileType, recIndex: this.recIndex,
        startTs, endTs: null, state: 'recording',
        chunkCount: 0, totalBytes: 0,
        key: null, uploadId: null, partEnds: [], uploadedBytes: 0, completeSize: null,
        createdAt: startTs
      };
      lockedRecs.add(this.rec.id); // before it hits disk, so the uploader never finalizes a live recording
      await putRec(this.rec);
      const opts = { mimeType: this.mime };
      if (this.videoBps) opts.videoBitsPerSecond = this.videoBps;
      if (this.audioBps) opts.audioBitsPerSecond = this.audioBps;
      this.mr = new MediaRecorder(this.stream, opts);
      this.mr.ondataavailable = e => {
        if (!e.data || !e.data.size) return;
        const seq = this.seq++;
        this.bytes += e.data.size;
        const blob = e.data;
        this.writeChain = this.writeChain.then(async () => {
          await appendChunk(this.rec.id, seq, blob);
          kickUploader();
        }).catch(err => noteError(`Disk write failed: ${err.message || err}`));
      };
      this.stopped = new Promise(resolve => {
        this.mr.onstop = async () => {
          await this.writeChain;
          await patchRec(this.rec.id, r => { r.state = 'finalizing'; r.endTs = Date.now(); }).catch(e => noteError(e));
          kickUploader();
          resolve();
        };
      });
      this.mr.onerror = e => noteError(`Recorder error: ${e.error ? e.error.message : 'unknown'}`);
      this.mr.start(CHUNK_MS);
      return this;
    }
    stop() {
      if (this.mr && this.mr.state !== 'inactive') { try { this.mr.stop(); } catch (e) { noteError(e); } }
      return this.stopped || Promise.resolve();
    }
  }

  function buildFileName(type, startTs, idx, ext) {
    const d = new Date(startTs);
    const date = d.toISOString().split('T')[0];
    const safeName = (guestName || 'guest').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'guest';
    return `${date}_${safeName}_${type}_${startTs}_rec${idx}.${ext}`;
  }

  // ========================================================
  // Uploader: disk -> 8 MB parts -> server -> storage
  // ========================================================
  let uploaderRunning = false, uploaderKick = null, backoff = 1000;
  const lockedRecs = new Set(); // recordings this tab is actively recording

  function kickUploader() { if (uploaderKick) uploaderKick(); }

  async function api(pathname, body) {
    const res = await fetch(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  function putPart(rec, partNumber, blob) {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ sessionId: rec.sessionId, t: rec.t, key: rec.key, uploadId: rec.uploadId, partNumber: String(partNumber) });
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/uploads/part?${q}`, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.timeout = Math.max(120000, (blob.size / (64 * 1024)) * 1000); // allow 64 KB/s minimum
      xhr.upload.onprogress = e => { inFlight = { recId: rec.id, loaded: e.loaded }; };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Object.assign(new Error(`HTTP ${xhr.status}`), { status: xhr.status })));
      xhr.ontimeout = () => reject(new Error('Part upload timed out'));
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(blob);
    });
  }
  let inFlight = null;

  // Pick the chunk range for the next part: at least PART_SIZE, or everything left once finalized.
  async function nextPartRange(rec) {
    const from = rec.partEnds.length ? rec.partEnds[rec.partEnds.length - 1] : 0;
    if (from >= rec.chunkCount) return null;
    const chunks = await getChunks(rec.id, from, rec.chunkCount);
    let size = 0, to = from;
    for (const c of chunks) {
      size += c.blob.size; to = c.seq + 1;
      if (size >= PART_SIZE) break;
    }
    if (size < PART_SIZE && rec.state !== 'finalizing') return null;
    const parts = chunks.filter(c => c.seq < to).map(c => c.blob);
    return { from, to, blob: new Blob(parts, { type: 'application/octet-stream' }) };
  }

  async function processRec(rec) {
    if (rec.state === 'done') return false;
    if (!rec.uploadId) {
      if (rec.state === 'finalizing' && rec.chunkCount === 0) { await patchRec(rec.id, r => { r.state = 'done'; }); return true; }
      const r = await api('/api/uploads/create', {
        sessionId: rec.sessionId, t: rec.t, fileName: rec.fileName, contentType: rec.mime,
        guestId: rec.guestId, guestName, fileType: rec.fileType, startTs: rec.startTs, recIndex: rec.recIndex
      });
      if (!r.ok) throw Object.assign(new Error(r.data.error || `Create failed (${r.status})`), { status: r.status });
      rec = await patchRec(rec.id, x => { x.key = r.data.key; x.uploadId = r.data.uploadId; x.partEnds = []; x.uploadedBytes = 0; });
    }
    const range = await nextPartRange(rec);
    if (range) {
      const partNumber = rec.partEnds.length + 1;
      try {
        await putPart(rec, partNumber, range.blob);
      } catch (err) {
        if (err.status === 410) { // upload expired or aborted on the storage side: start this file over
          await patchRec(rec.id, x => { x.uploadId = null; x.key = null; x.partEnds = []; x.uploadedBytes = 0; });
        }
        throw err;
      } finally { inFlight = null; }
      await patchRec(rec.id, x => {
        if (x.partEnds.length === partNumber - 1) { x.partEnds.push(range.to); x.uploadedBytes += range.blob.size; }
      });
      return true;
    }
    const lastEnd = rec.partEnds.length ? rec.partEnds[rec.partEnds.length - 1] : 0;
    if (rec.state === 'finalizing' && rec.partEnds.length && lastEnd >= rec.chunkCount) {
      const r = await api('/api/uploads/complete', {
        sessionId: rec.sessionId, t: rec.t, guestId: rec.guestId, key: rec.key, uploadId: rec.uploadId,
        expectedParts: rec.partEnds.length, fileType: rec.fileType, startTs: rec.startTs,
        durationMs: (rec.endTs || Date.now()) - rec.startTs, recIndex: rec.recIndex
      });
      if (r.status === 409 && Array.isArray(r.data.missing) && r.data.missing.length) {
        const first = Math.min(...r.data.missing); // rewind to the first missing part and resend from there
        await patchRec(rec.id, x => {
          x.partEnds = x.partEnds.slice(0, first - 1);
          x.uploadedBytes = 0; // recomputed below from remaining parts is not tracked; show conservative progress
        });
        return true;
      }
      if (!r.ok) throw Object.assign(new Error(r.data.error || `Complete failed (${r.status})`), { status: r.status });
      const sizeOk = r.data.size === rec.totalBytes;
      await patchRec(rec.id, x => { x.state = 'done'; x.completeSize = r.data.size; x.uploadedBytes = x.totalBytes; });
      if (sizeOk) await deleteChunks(rec.id).catch(() => {});
      else noteError(`Size check: stored ${r.data.size} bytes, recorded ${rec.totalBytes}; local copy kept`);
      return true;
    }
    return false;
  }

  async function uploaderLoop() {
    if (uploaderRunning) return;
    uploaderRunning = true;
    for (;;) {
      let didWork = false;
      try {
        const recs = (await allRecs()).filter(r => r.state !== 'done').sort((a, b) => a.createdAt - b.createdAt);
        for (const rec of recs) {
          // A recording left in 'recording' state by a tab that no longer exists gets finalized.
          let cur = rec;
          if (cur.state === 'recording' && !lockedRecs.has(cur.id)) {
            cur = await patchRec(cur.id, x => { if (x.state === 'recording') { x.state = 'finalizing'; x.endTs = x.endTs || Date.now(); } });
          }
          if (await processRec(cur)) { didWork = true; break; }
        }
        backoff = 1000;
      } catch (err) {
        noteError(`Upload: ${err.message || err}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
        continue;
      }
      updateRecoveryBar();
      if (!didWork) {
        await new Promise(resolve => { uploaderKick = resolve; setTimeout(resolve, 3000); });
        uploaderKick = null;
      }
    }
  }

  async function uploadTotals() {
    const recs = await allRecs();
    let recorded = 0, uploaded = 0, pending = 0, unfinished = 0;
    for (const r of recs) {
      if (r.sessionId !== sessionId && r.state === 'done') continue;
      if (r.state === 'done') { if (r.sessionId === sessionId) { recorded += r.totalBytes; uploaded += r.totalBytes; } continue; }
      unfinished++;
      recorded += r.totalBytes; uploaded += r.uploadedBytes;
      pending += Math.max(0, r.totalBytes - r.uploadedBytes);
    }
    if (inFlight) { uploaded += inFlight.loaded; pending = Math.max(0, pending - inFlight.loaded); }
    return { recorded, uploaded, pending, unfinished };
  }

  async function updateRecoveryBar() {
    try {
      const tot = await uploadTotals();
      if (!isRecording && tot.unfinished > 0) {
        const pct = tot.uploaded + tot.pending > 0 ? Math.floor((tot.uploaded / (tot.uploaded + tot.pending)) * 100) : 0;
        recoveryBar.textContent = `Saving your recording: ${pct}% uploaded (${fmtMB(tot.pending)} MB left). Please keep this tab open.`;
        recoveryBar.style.display = 'flex';
        progressContainer.style.display = 'block'; progressBar.style.width = pct + '%';
      } else if (!isRecording && sessionStarted && tot.recorded > 0) {
        recoveryBar.textContent = 'All saved. You can close this tab.';
        uploadLine.textContent = `${fmtMB(tot.recorded)} MB recorded, all uploaded`;
        recoveryBar.style.display = 'flex';
        progressBar.style.width = '100%';
        if (statusText.classList.contains('status-uploading')) setStatus('Upload complete. You can close this tab.', 'status-complete');
      } else if (!isRecording) {
        recoveryBar.style.display = 'none';
      }
    } catch {}
  }

  // ========================================================
  // State
  // ========================================================
  let guestName = '';
  let mediaStream = null;
  let ws = null, wsReconnectTimer = null, reconnectAttempts = 0;
  let isRecording = false, sessionStarted = false;
  let recIndex = 1, recordingStartTime = null, timerInterval = null;
  let tracks = []; // active TrackRecorders
  let isMuted = false, isCameraOff = false, isScreenSharing = false;
  let selectedCameraId = null, selectedMicId = null;
  let screenStream = null, screenTrack = null;
  let meterCtx = null, meterAnalyser = null, meterRAF = null, micLevel = 0;
  let wakeLock = null;
  let requestQueue = [], currentRequest = null;

  const AUDIO_CONSTRAINTS = id => ({
    ...(id ? { deviceId: { exact: id } } : {}),
    echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 }
  });
  const VIDEO_CONSTRAINTS = id => ({
    ...(id ? { deviceId: { exact: id } } : {}),
    width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }
  });

  // ========================================================
  // Environment checks
  // ========================================================
  function environmentWarnings() {
    const ua = navigator.userAgent;
    const warnings = [];
    if (/FBAN|FBAV|Instagram|LinkedInApp|Line\/|Slack|GSA\/|; wv\)/.test(ua)) {
      warnings.push('This link opened inside an app. Please open it in Safari or Chrome for recording to work.');
    } else if (/iPhone|iPad|iPod|Android/.test(ua)) {
      warnings.push('Please join from a laptop or desktop. Phones cannot share the camera with your meeting app.');
    }
    if (!window.MediaRecorder || !videoMime) warnings.push('This browser cannot record video. Please use Chrome, Edge or Safari.');
    if (!window.indexedDB) warnings.push('This browser cannot save the recording to disk. Please use a normal (not private) Chrome or Safari window.');
    return warnings;
  }

  let persistAsked = false;
  async function storageCheck() {
    try {
      if (!persistAsked && navigator.storage && navigator.storage.persist) { persistAsked = true; await navigator.storage.persist(); }
      if (navigator.storage && navigator.storage.estimate) {
        const { quota = 0, usage = 0 } = await navigator.storage.estimate();
        const freeMB = (quota - usage) / 1048576;
        return freeMB;
      }
    } catch {}
    return null;
  }

  // ========================================================
  // Startup
  // ========================================================
  async function boot() {
    if (!sessionId || !token) {
      showFatal('This recording link is incomplete.', 'Please ask your producer to send the full link again.');
      return;
    }
    const warnings = environmentWarnings();
    if (warnings.length) notice(warnings.join(' '));

    // Only one CamOp tab may record at a time; a second tab just finishes uploads.
    if (navigator.locks) {
      navigator.locks.request(`camop-recorder-${sessionId}`, { ifAvailable: true }, lock => {
        if (!lock) {
          showFatal('CamOp is already open in another tab.', 'Use the other tab, or close it and reload this one.');
          return;
        }
        return new Promise(() => {}); // hold the lock for the life of the page
      });
    }

    uploaderLoop();
    updateRecoveryBar();
    const freeMB = await storageCheck();
    if (freeMB !== null && freeMB < 3000) {
      notice((noticeBar.textContent ? noticeBar.textContent + ' ' : '') + `Only about ${Math.max(0, Math.round(freeMB / 1024 * 10) / 10)} GB is available for recording here. If this is a private window, please reopen the link in a normal window.`);
    }
    setInterval(sendStatus, 2000);
    setInterval(sendThumb, 5000);
  }

  function showFatal(msg, instructions) {
    nameScreen.style.display = 'none'; recordingScreen.style.display = 'none';
    errorScreen.style.display = 'flex';
    errorMsg.textContent = msg; errorInstructions.textContent = instructions || '';
  }

  // ========================================================
  // Name entry and consent
  // ========================================================
  function updateJoin() { joinBtn.disabled = !(nameInput.value.trim() && consentInput.checked); }
  nameInput.addEventListener('input', updateJoin);
  consentInput.addEventListener('change', updateJoin);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click(); });
  try { const saved = localStorage.getItem('camop_name'); if (saved) nameInput.value = saved; } catch {}

  let consentAt = null;
  joinBtn.addEventListener('click', async () => {
    guestName = nameInput.value.trim();
    if (!guestName || !consentInput.checked) return;
    consentAt = new Date().toISOString();
    try { localStorage.setItem('camop_name', guestName); } catch {}
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS(), audio: AUDIO_CONSTRAINTS() });
    } catch (err) { showMediaError(err); return; }
    nameScreen.style.display = 'none';
    recordingScreen.style.display = 'flex';
    videoPreview.srcObject = mediaStream;
    codecBadge.textContent = extFor(videoMime).toUpperCase();
    watchTracks();
    connectWebSocket();
    openDeviceSetup();
  });

  // ========================================================
  // Device setup modal
  // ========================================================
  // ========================================================
  // Upload speed test (same path the recording uploads take)
  // ========================================================
  async function measureUpload() {
    const block = new Uint8Array(1024 * 1024);
    for (let i = 0; i < block.length; i += 65536) crypto.getRandomValues(block.subarray(i, i + 65536));
    const body = new Blob([block, block]); // 2 MB per request
    const q = new URLSearchParams({ sessionId, t: token });
    const deadline = performance.now() + 6000;
    let bytes = 0;
    const t0 = performance.now();
    const lane = async () => {
      while (performance.now() < deadline && bytes < 24 * 1024 * 1024) {
        const r = await fetch(`/api/speedtest?${q}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' }, cache: 'no-store' });
        if (!r.ok) throw new Error(`Speed test HTTP ${r.status}`);
        bytes += body.size;
      }
    };
    await Promise.all([lane(), lane()]);
    const secs = (performance.now() - t0) / 1000;
    return (bytes * 8) / secs / 1e6;
  }

  function cameraMax() {
    const vt = mediaStream && mediaStream.getVideoTracks()[0];
    try {
      const c = vt && vt.getCapabilities ? vt.getCapabilities() : null;
      if (c && c.width && c.width.max) return { w: c.width.max, h: (c.height && c.height.max) || 0 };
    } catch {}
    const s = vt ? vt.getSettings() : {};
    return { w: s.width || 0, h: s.height || 0 };
  }

  function recommendQuality(mbps, cam) {
    if (cam.w >= 3840 && mbps >= QUALITY['4k'].needMbps) return '4k';
    if (mbps >= QUALITY.high.needMbps) return 'high';
    if (mbps >= QUALITY.standard.needMbps) return 'standard';
    return 'low';
  }

  async function runSpeedTest() {
    const line = $('speed-line');
    if (line) { line.textContent = 'Checking your internet upload speed...'; line.className = 'speed-line'; }
    const cam = cameraMax();
    try {
      const mbps = await measureUpload();
      const rec = recommendQuality(mbps, cam);
      speedResult = { uploadMbps: mbps, camMaxW: cam.w, camMaxH: cam.h, recommended: rec, failed: false };
      if (line) {
        line.textContent = `Upload speed: ${mbps.toFixed(1)} Mbps. ${mbps >= QUALITY.standard.needMbps ? 'Good for high-quality recording.' : 'A little slow; your recording will finish uploading after the call.'}`;
        line.className = 'speed-line ' + (mbps >= QUALITY.standard.needMbps ? 'ok' : 'warn');
      }
    } catch (err) {
      noteError(`Speed test: ${err.message}`);
      speedResult = { uploadMbps: 0, camMaxW: cam.w, camMaxH: cam.h, recommended: 'standard', failed: true };
      if (line) { line.textContent = 'Could not test your upload speed. Recording will still work.'; line.className = 'speed-line warn'; }
    }
    sendWs({ type: 'guest-speed', ...speedResult });
  }

  async function openDeviceSetup() {
    setupModal.classList.add('active');
    sendWs({ type: 'guest-setup-started' });
    await fillDeviceSelects();
    setupPreview.srcObject = mediaStream;
    startMeter(mediaStream, true);
    runSpeedTest();
  }

  async function fillDeviceSelects() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const mics = devices.filter(d => d.kind === 'audioinput');
    setupError.style.display = 'none'; setupConfirmBtn.disabled = false;
    if (!cams.length || !mics.length) {
      setupError.textContent = !cams.length ? 'No camera detected. Connect one and reload.' : 'No microphone detected. Connect one and reload.';
      setupError.style.display = 'block'; setupConfirmBtn.disabled = true;
    }
    cameraSelect.innerHTML = ''; micSelect.innerHTML = '';
    cams.forEach((c, i) => cameraSelect.add(new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
    mics.forEach((m, i) => micSelect.add(new Option(m.label || `Microphone ${i + 1}`, m.deviceId)));
    const vt = mediaStream.getVideoTracks()[0], at = mediaStream.getAudioTracks()[0];
    if (vt && vt.getSettings().deviceId) cameraSelect.value = vt.getSettings().deviceId;
    if (at && at.getSettings().deviceId) micSelect.value = at.getSettings().deviceId;
    selectedCameraId = cameraSelect.value; selectedMicId = micSelect.value;
    // Pick the best camera and a non-Bluetooth mic automatically, once, unless the guest already chose.
    if (!autoPicked) {
      autoPicked = true;
      const bestCam = rankCameras(cams)[0];
      const curMic = mics.find(m => m.deviceId === selectedMicId);
      const betterMic = curMic && isBluetooth(curMic.label) ? mics.find(m => m.deviceId !== 'default' && !isBluetooth(m.label)) : null;
      let changed = false;
      if (bestCam && bestCam.deviceId !== selectedCameraId) { selectedCameraId = bestCam.deviceId; cameraSelect.value = bestCam.deviceId; changed = true; }
      if (betterMic) { selectedMicId = betterMic.deviceId; micSelect.value = betterMic.deviceId; changed = true; }
      if (changed) await reopenStream();
    }
    bluetoothCheck();
  }

  let autoPicked = false;
  const isBluetooth = label => /airpods|bluetooth|beats|buds|jabra|bose|sony wh|headset|hands-free/i.test(label || '');
  // iPhone Continuity Camera first, then external webcams, then the built-in camera; virtual cameras last.
  function rankCameras(cams) {
    const score = c => {
      const l = c.label || '';
      if (/desk view/i.test(l)) return -1;
      if (/obs|virtual|snap camera|mmhmm|screen|ndi|manycam/i.test(l)) return 0;
      if (/iphone|continuity/i.test(l)) return 3;
      if (/facetime|built-in|integrated|internal|front|back|user facing/i.test(l)) return 1;
      return 2; // external USB webcam (Brio, Insta360, OBSBOT, capture cards...)
    };
    return [...cams].sort((x, y) => score(y) - score(x));
  }

  function bluetoothCheck() {
    const label = (micSelect.options[micSelect.selectedIndex] || {}).text || '';
    if (isBluetooth(label)) {
      setupError.textContent = 'This looks like a Bluetooth mic, which records at phone quality. Pick your laptop or USB mic if you can.';
      setupError.style.display = 'block';
    }
  }

  cameraSelect.addEventListener('change', async () => { autoPicked = true; selectedCameraId = cameraSelect.value; await reopenStream(); });
  micSelect.addEventListener('change', async () => { selectedMicId = micSelect.value; await reopenStream(); bluetoothCheck(); });

  async function reopenStream() {
    const old = mediaStream;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS(selectedCameraId), audio: AUDIO_CONSTRAINTS(selectedMicId) });
      if (old) old.getTracks().forEach(t => t.stop());
      setupPreview.srcObject = mediaStream; videoPreview.srcObject = mediaStream;
      applyMuteState(); applyVideoState();
      startMeter(mediaStream, setupModal.classList.contains('active'));
      watchTracks();
      setupError.style.display = 'none'; setupConfirmBtn.disabled = false;
      return true;
    } catch (err) {
      setupError.textContent = `Could not open that device: ${err.message}`;
      setupError.style.display = 'block';
      return false;
    }
  }

  function startMeter(stream, drawSetup) {
    stopMeter();
    try {
      meterCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = meterCtx.createMediaStreamSource(stream);
      meterAnalyser = meterCtx.createAnalyser();
      meterAnalyser.fftSize = 512;
      src.connect(meterAnalyser);
      const data = new Uint8Array(meterAnalyser.fftSize);
      const read = () => {
        meterAnalyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        micLevel = Math.min(1, peak / 128);
        if (drawSetup) audioMeterBar.style.width = Math.round(micLevel * 100) + '%';
      };
      const loop = () => { read(); meterRAF = requestAnimationFrame(loop); };
      loop();
      meterCtx._interval = setInterval(read, 1000); // keeps the level fresh while the tab is hidden
    } catch (e) { noteError(`Meter: ${e.message}`); }
  }
  function stopMeter() {
    if (meterRAF) cancelAnimationFrame(meterRAF);
    if (meterCtx) { clearInterval(meterCtx._interval); meterCtx.close().catch(() => {}); }
    meterCtx = meterAnalyser = meterRAF = null;
  }

  setupConfirmBtn.addEventListener('click', () => {
    setupModal.classList.remove('active');
    startMeter(mediaStream, false);
    toolbarWrapper.style.display = 'flex';
    $('main-container').style.paddingBottom = '100px';
    sendWs({
      type: 'guest-ready',
      activeCamera: (cameraSelect.options[cameraSelect.selectedIndex] || {}).text || 'Camera',
      activeMic: (micSelect.options[micSelect.selectedIndex] || {}).text || 'Mic'
    });
    setStatus('Ready. Waiting for the producer to start recording.', 'status-waiting');
  });

  // ========================================================
  // Device health during a session
  // ========================================================
  function watchTracks() {
    for (const t of mediaStream.getTracks()) {
      t.onended = () => onTrackLost(t.kind);
    }
  }
  async function onTrackLost(kind) {
    noteError(`${kind === 'video' ? 'Camera' : 'Microphone'} disconnected`);
    notice(`Your ${kind === 'video' ? 'camera' : 'microphone'} disconnected. Reconnecting...`);
    const wasRecording = isRecording;
    if (wasRecording) await stopRecording(false);
    selectedCameraId = kind === 'video' ? null : selectedCameraId;
    selectedMicId = kind === 'audio' ? null : selectedMicId;
    for (let i = 0; i < 5; i++) {
      if (await reopenStream()) { notice(''); if (wasRecording) startRecording(currentQuality); return; }
      await sleep(2000);
    }
    notice(`Your ${kind === 'video' ? 'camera' : 'microphone'} is unavailable. Please reconnect it.`);
  }

  // ========================================================
  // WebSocket (reconnects forever; recording never depends on it)
  // ========================================================
  function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?session=${encodeURIComponent(sessionId)}&role=guest&t=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      connectionBar.style.display = 'none';
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'guest-join', name: guestName, clientId: CLIENT_ID, consentAt }));
      if (isRecording) ws.send(JSON.stringify({ type: 'recording-started' }));
      else if (!setupModal.classList.contains('active')) {
        ws.send(JSON.stringify({ type: 'guest-ready', activeCamera: (cameraSelect.options[cameraSelect.selectedIndex] || {}).text, activeMic: (micSelect.options[micSelect.selectedIndex] || {}).text }));
      }
      if (speedResult) ws.send(JSON.stringify({ type: 'guest-speed', ...speedResult }));
      sendStatus();
    };
    ws.onmessage = e => { try { handleServerMessage(JSON.parse(e.data)); } catch {} };
    ws.onclose = ev => {
      if (ev.code === 4003) { showFatal('This recording link is not valid.', 'Please ask your producer for a new link.'); return; }
      if (isRecording) connectionBar.style.display = 'flex';
      reconnectAttempts++;
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWebSocket, Math.min(1000 * 2 ** Math.min(reconnectAttempts, 4), 10000));
    };
    ws.onerror = () => {};
  }
  function sendWs(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

  // A small still for the producer's tile, and a brightness reading to catch a black camera.
  let thumbCanvas = null, brightness = -1, thumbBusy = false;
  async function sendThumb() {
    if (thumbBusy || !mediaStream) return;
    const vt = mediaStream.getVideoTracks()[0];
    if (!vt || vt.readyState !== 'live') return;
    thumbBusy = true;
    try {
      let src = null;
      // grabFrame keeps working while this tab is behind the meeting window
      if (window.ImageCapture) { try { src = await new ImageCapture(vt).grabFrame(); } catch {} }
      if (!src && videoPreview.videoWidth) src = videoPreview;
      if (!src) return;
      const sw = src.width || src.videoWidth, sh = src.height || src.videoHeight;
      if (!sw || !sh) return;
      const W = 320, H = Math.round(W * sh / sw);
      thumbCanvas = thumbCanvas || document.createElement('canvas');
      thumbCanvas.width = W; thumbCanvas.height = H;
      const ctx = thumbCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(src, 0, 0, W, H);
      if (src.close) src.close();
      const px = ctx.getImageData(0, 0, W, H).data;
      let sum = 0, n = 0;
      for (let i = 0; i < px.length; i += 4 * 16) { sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n++; }
      brightness = n ? sum / n / 255 : -1;
      const blob = await new Promise(r => thumbCanvas.toBlob(r, 'image/jpeg', 0.7));
      if (!blob) return;
      const q = new URLSearchParams({ sessionId, t: token, guestId: CLIENT_ID });
      await fetch(`/api/thumb?${q}`, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/jpeg' }, cache: 'no-store' });
    } catch (e) { /* thumbnails are best-effort */ }
    finally { thumbBusy = false; }
  }

  async function sendStatus() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const tot = await uploadTotals().catch(() => ({ recorded: 0, uploaded: 0, pending: 0, unfinished: 0 }));
    const vt = mediaStream && mediaStream.getVideoTracks()[0];
    const s = vt ? vt.getSettings() : {};
    const free = await storageCheck();
    sendWs({
      type: 'guest-status',
      recording: isRecording,
      recordingMs: isRecording ? Date.now() - recordingStartTime : 0,
      recordedBytes: tot.recorded, uploadedBytes: tot.uploaded, pendingBytes: tot.pending, unfinished: tot.unfinished,
      width: s.width || 0, height: s.height || 0, fps: s.frameRate || 0,
      micLevel: Math.round(micLevel * 100) / 100,
      brightness: Math.round(brightness * 100) / 100,
      cameraOff: isCameraOff,
      storageFreeMB: free === null ? 0 : Math.round(free),
      lastError
    });
    if (isRecording || tot.unfinished || sessionStarted) {
      uploadLine.textContent = `${fmtMB(tot.recorded)} MB recorded, ${fmtMB(tot.uploaded)} MB uploaded${tot.pending > 0 ? `, ${fmtMB(tot.pending)} MB to go` : ''}`;
    }
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'start-recording': startRecording(msg.quality, msg.take); break;
      case 'stop-recording': stopRecording(true); break;
      case 'producer:request': enqueueRequest(msg); break;
      case 'producer:cancel-request': dismissCurrentToast(); break;
    }
  }

  // ========================================================
  // Recording
  // ========================================================
  let starting = false, currentQuality = 'standard';
  async function startRecording(quality, take) {
    if (isRecording || starting) return;
    if (!videoMime) { setStatus('This browser cannot record video. Please use Chrome, Edge or Safari.', 'status-error'); return; }
    starting = true;
    try {
      if (!mediaStream || !mediaStream.active) { if (!(await reopenStream())) return; }
      if (quality && QUALITY[quality]) currentQuality = quality;
      const q = QUALITY[currentQuality] || QUALITY.standard;
      // Ask the camera for this tier's resolution; it delivers the closest it can.
      const vt = mediaStream.getVideoTracks()[0];
      if (vt && vt.applyConstraints) {
        try { await vt.applyConstraints({ width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: 30 } }); }
        catch (e) { noteError(`Camera could not switch to ${q.label}: ${e.message}`); }
      }
      await startTakes(q, take);
    } finally { starting = false; }
  }

  async function startTakes(q, take) {
    isRecording = true; sessionStarted = true;
    recordingStartTime = Date.now();
    // The server numbers takes per session so every guest's files share a take number.
    const idx = take > 0 ? take : recIndex;
    recIndex = idx + 1;
    try {
      const cam = new TrackRecorder(mediaStream, { fileType: 'camera', mime: videoMime, videoBps: q.bps, audioBps: 192000, recIndex: idx });
      tracks = [await cam.start()];
      const at = mediaStream.getAudioTracks()[0];
      if (at && audioMime) {
        const aud = new TrackRecorder(new MediaStream([at]), { fileType: 'audio', mime: audioMime, audioBps: 192000, recIndex: idx });
        tracks.push(await aud.start());
      }
      for (const t of tracks) lockedRecs.add(t.rec.id);
    } catch (err) {
      isRecording = false;
      noteError(`Could not start recording: ${err.message}`);
      setStatus(`Could not start recording: ${err.message}`, 'status-error');
      return;
    }
    if (isMuted) mutedWarning.style.display = 'flex';
    setStatus('Recording. Your video is being saved to this computer and uploaded as you go.', 'status-recording');
    toolbarWrapper.classList.add('is-recording');
    recoveryBar.style.display = 'none'; progressContainer.style.display = 'none';
    startTimer();
    holdWakeLock();
    sizeBadge.title = q.label;
    sendWs({ type: 'recording-started', quality: currentQuality });
    sendStatus();
  }

  async function stopRecording(final) {
    if (!isRecording) return;
    isRecording = false;
    stopTimer();
    const stopping = tracks.map(t => t.stop());
    if (final && isScreenSharing) stopScreenShare();
    await Promise.all(stopping);
    for (const t of tracks) lockedRecs.delete(t.rec.id);
    tracks = [];
    releaseWakeLock();
    toolbarWrapper.classList.remove('is-recording'); mutedWarning.style.display = 'none';
    setStatus('Recording stopped. Finishing the upload; please keep this tab open.', 'status-uploading');
    sendWs({ type: 'recording-stopped' });
    kickUploader();
    updateRecoveryBar();
    sendStatus();
    if (switchAfterTake) { switchAfterTake = false; setTimeout(() => tbCamSwitch.click(), 300); }
  }
  stopBtn.addEventListener('click', () => stopRecording(true));

  function startTimer() {
    timerInterval = setInterval(() => {
      const e = Math.floor((Date.now() - recordingStartTime) / 1000);
      timerEl.textContent = `${String(Math.floor(e / 3600)).padStart(2, '0')}:${String(Math.floor((e % 3600) / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
      const bytes = tracks.reduce((s, t) => s + t.bytes, 0);
      sizeBadge.textContent = `${fmtMB(bytes)} MB`;
    }, 500);
  }
  function stopTimer() { clearInterval(timerInterval); }

  async function holdWakeLock() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => { if (isRecording && document.visibilityState === 'visible') holdWakeLock(); });

  // ========================================================
  // Toolbar
  // ========================================================
  tbMute.addEventListener('click', () => { isMuted = !isMuted; applyMuteState(); broadcastControlState(); });
  function applyMuteState() {
    const t = mediaStream && mediaStream.getAudioTracks()[0]; if (t) t.enabled = !isMuted;
    micPair.classList.toggle('off', isMuted);
    tbMuteLabel.textContent = isMuted ? 'Unmute' : 'Mute';
    const mt = isMuted ? 'Unmute microphone' : 'Mute microphone';
    tbMute.title = mt; tbMute.setAttribute('aria-label', mt); tbMute.setAttribute('aria-pressed', String(isMuted));
    mutedWarning.style.display = isMuted && isRecording ? 'flex' : 'none';
  }
  tbVideo.addEventListener('click', () => { isCameraOff = !isCameraOff; applyVideoState(); broadcastControlState(); });
  function applyVideoState() {
    const t = mediaStream && mediaStream.getVideoTracks()[0]; if (t) t.enabled = !isCameraOff;
    camPair.classList.toggle('off', isCameraOff);
    tbVideoLabel.textContent = isCameraOff ? 'Start video' : 'Stop video';
    const vt = isCameraOff ? 'Start video' : 'Stop video';
    tbVideo.title = vt; tbVideo.setAttribute('aria-label', vt); tbVideo.setAttribute('aria-pressed', String(isCameraOff));
  }
  function broadcastControlState() {
    sendWs({
      type: 'guest:control-update', muted: isMuted, cameraOff: isCameraOff, screenSharing: isScreenSharing,
      activeCamera: (cameraSelect.options[cameraSelect.selectedIndex] || {}).text || null,
      activeMic: (micSelect.options[micSelect.selectedIndex] || {}).text || null
    });
  }

  async function showDeviceMenu(kind, dropdown, otherDropdown) {
    if (dropdown.classList.contains('show')) { dropdown.classList.remove('show'); return; }
    otherDropdown.classList.remove('show');
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === kind);
    dropdown.innerHTML = '';
    const current = kind === 'videoinput' ? selectedCameraId : selectedMicId;
    const heading = document.createElement('div');
    heading.className = 'dev-heading';
    heading.textContent = kind === 'videoinput' ? 'Select a camera' : 'Select a microphone';
    dropdown.appendChild(heading);
    if (isRecording) {
      const note = document.createElement('div');
      note.className = 'dev-note';
      note.textContent = `To keep this take clean, change your ${kind === 'videoinput' ? 'camera' : 'microphone'} after recording stops.`;
      dropdown.appendChild(note);
    }
    devs.forEach(d => {
      const b = document.createElement('button');
      b.className = 'dev-dropdown-item' + (d.deviceId === current ? ' selected' : '');
      b.textContent = d.label || (kind === 'videoinput' ? 'Camera' : 'Microphone');
      b.disabled = isRecording;
      b.addEventListener('click', async () => {
        dropdown.classList.remove('show');
        if (d.deviceId === current) return;
        if (kind === 'videoinput') { selectedCameraId = d.deviceId; cameraSelect.value = d.deviceId; }
        else { selectedMicId = d.deviceId; micSelect.value = d.deviceId; bluetoothCheck(); }
        await reopenStream(); broadcastControlState();
      });
      dropdown.appendChild(b);
    });
    dropdown.classList.add('show');
  }
  tbCamSwitch.addEventListener('click', () => showDeviceMenu('videoinput', camDropdown, micDropdown));
  tbMicSwitch.addEventListener('click', () => showDeviceMenu('audioinput', micDropdown, camDropdown));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { camDropdown.classList.remove('show'); micDropdown.classList.remove('show'); } });
  document.addEventListener('click', e => {
    if (!e.target.closest('#tb-cam-switch') && !e.target.closest('#cam-dropdown')) camDropdown.classList.remove('show');
    if (!e.target.closest('#tb-mic-switch') && !e.target.closest('#mic-dropdown')) micDropdown.classList.remove('show');
  });

  // ========================================================
  // Screen share (its own file, same disk-first uploader)
  // ========================================================
  tbScreen.addEventListener('click', () => (isScreenSharing ? stopScreenShare() : startScreenShare()));
  async function startScreenShare() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenTrack = await new TrackRecorder(screenStream, { fileType: 'screen', mime: videoMime, videoBps: VIDEO_BPS, recIndex: recIndex }).start();
      lockedRecs.add(screenTrack.rec.id);
      isScreenSharing = true;
      tbScreen.classList.add('sharing'); tbScreenLabel.textContent = 'Stop sharing'; tbScreen.title = 'Stop sharing';
      screenThumbContainer.style.display = 'block'; screenThumbVideo.srcObject = screenStream;
      screenStream.getVideoTracks()[0].onended = () => { if (isScreenSharing) stopScreenShare(); };
      broadcastControlState(); sendWs({ type: 'guest:screen-share-started' });
    } catch (err) {
      if (err.name !== 'NotAllowedError') setStatus('Screen share was blocked. Check your screen recording permission.', 'status-error');
    }
  }
  async function stopScreenShare() {
    if (!isScreenSharing) return;
    isScreenSharing = false;
    const t = screenTrack; screenTrack = null;
    if (screenStream) screenStream.getTracks().forEach(tr => tr.stop());
    tbScreen.classList.remove('sharing'); tbScreenLabel.textContent = 'Share screen'; tbScreen.title = 'Share screen';
    screenThumbContainer.style.display = 'none';
    broadcastControlState(); sendWs({ type: 'guest:screen-share-stopped' });
    if (t) { await t.stop(); lockedRecs.delete(t.rec.id); kickUploader(); }
  }

  // ========================================================
  // Producer request toasts
  // ========================================================
  // Switching cameras mid-take would break the file, so during a take the guest
  // still sees the request, and "OK" opens the camera menu as soon as the take stops.
  let switchAfterTake = false;
  function enqueueRequest(msg) {
    requestQueue.push(msg); if (!currentRequest) showNextToast();
  }
  function showNextToast() {
    if (!requestQueue.length) { currentRequest = null; toastContainer.classList.remove('show'); return; }
    currentRequest = requestQueue.shift();
    const text = { mute: 'Your producer is asking you to mute your mic', cameraOff: 'Your producer is asking you to turn off your camera', deviceSwitch: 'Your producer is asking you to switch your camera' };
    const duringTake = currentRequest.requestType === 'deviceSwitch' && isRecording;
    toastText.textContent = (text[currentRequest.requestType] || 'Your producer has a request')
      + (duringTake ? '. You can change it as soon as this take stops.' : '');
    toastApprove.textContent = duringTake ? 'OK' : 'Approve';
    toastContainer.classList.add('show');
  }
  toastApprove.addEventListener('click', () => {
    if (!currentRequest) return;
    const rt = currentRequest.requestType;
    if (rt === 'mute' && !isMuted) { isMuted = true; applyMuteState(); }
    else if (rt === 'cameraOff' && !isCameraOff) { isCameraOff = true; applyVideoState(); }
    else if (rt === 'deviceSwitch') { if (isRecording) switchAfterTake = true; else tbCamSwitch.click(); }
    sendWs({ type: 'guest:request-response', requestType: rt, response: 'approved' });
    broadcastControlState(); dismissCurrentToast();
  });
  toastDismiss.addEventListener('click', () => {
    if (!currentRequest) return;
    sendWs({ type: 'guest:request-response', requestType: currentRequest.requestType, response: 'dismissed' });
    dismissCurrentToast();
  });
  function dismissCurrentToast() { currentRequest = null; toastContainer.classList.remove('show'); setTimeout(showNextToast, 300); }

  // ========================================================
  // Errors
  // ========================================================
  function showMediaError(err) {
    nameScreen.style.display = 'none'; recordingScreen.style.display = 'none'; errorScreen.style.display = 'flex';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      errorMsg.textContent = 'Camera or microphone access was blocked.';
      errorInstructions.innerHTML = 'Click the camera icon in the address bar, choose Allow, then reload.<br><br>On a Mac, also check System Settings &gt; Privacy &amp; Security &gt; Camera and Microphone for your browser.<br><br>If you never saw a permission prompt, your company may block cameras in the browser. Your IT team can allow this site.';
    } else if (err.name === 'NotFoundError') {
      errorMsg.textContent = 'No camera or microphone found.';
      errorInstructions.textContent = 'Connect a camera and microphone, then reload.';
    } else if (err.name === 'NotReadableError') {
      errorMsg.textContent = 'Your camera is being used by another app.';
      errorInstructions.innerHTML = 'On Windows, only one app can use the camera unless sharing is turned on: Settings &gt; Bluetooth &amp; devices &gt; Cameras &gt; your camera &gt; allow multiple apps. Or turn your video off in the meeting app and reload this page.';
    } else {
      errorMsg.textContent = `Could not access the camera or microphone: ${err.message}`;
      errorInstructions.textContent = 'Try Chrome or Edge for the best experience.';
    }
  }

  window.addEventListener('beforeunload', e => {
    if (isRecording || (recoveryBar.style.display !== 'none' && /Saving/.test(recoveryBar.textContent))) { e.preventDefault(); e.returnValue = ''; }
  });

  // Test hook for automated end-to-end checks
  window.__camop = { uploadTotals, allRecs, startRecording, stopRecording, isRecording: () => isRecording };

  boot();
})();

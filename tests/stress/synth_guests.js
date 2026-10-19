// Synthetic guests: speak CamOp's guest protocol without a browser, so one machine
// can push many guests' worth of 4K uploads through the server.
// Each guest records at MBPS, cuts PART_MB parts as a real guest would, and uploads
// them one at a time; if uploads fall behind, the backlog grows exactly as it would.
//
// node synth_guests.js BASE SESSION TOKEN GUESTS MBPS SECONDS [PART_MB]
// Prints one JSON line with results.
const WebSocket = require('../../server/node_modules/ws');
const crypto = require('crypto');

const [BASE, SESSION, TOKEN, N, MBPS, SECONDS, PART_MB = '8'] = process.argv.slice(2);
const partBytes = Number(PART_MB) * 1024 * 1024;
const bytesPerSec = Number(MBPS) * 1e6 / 8;
const payload = crypto.randomBytes(partBytes);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

async function guest(i) {
  const id = `synth${i}_${crypto.randomBytes(3).toString('hex')}`;
  const out = { id, parts: 0, partErrors: 0, latencies: [], backlogMB: 0, drainS: 0, completeOk: false, wsOk: false, errors: [] };
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?session=${SESSION}&role=guest&t=${TOKEN}`);
  ws.on('open', () => { out.wsOk = true; ws.send(JSON.stringify({ type: 'guest-join', name: `Synth ${i}`, clientId: id })); });
  ws.on('error', e => out.errors.push('ws ' + e.message));
  await sleep(300 + Math.random() * 700);
  const startTs = Date.now();
  let c;
  for (let a = 0; a < 5; a++) {
    c = await post('/api/uploads/create', { sessionId: SESSION, t: TOKEN, guestId: id, fileName: 'x.mp4', contentType: 'video/mp4', fileType: 'camera', startTs, recIndex: 1 }).catch(e => ({ status: 0, data: { error: e.message } }));
    if (c.status === 200) break;
    await sleep(1000);
  }
  if (!c || c.status !== 200) { out.errors.push('create ' + (c && c.status)); ws.close(); return out; }
  const { key, uploadId } = c.data;

  // "Recording": bytes accrue at the target bitrate; a part is ready every partBytes.
  const recordEnd = startTs + Number(SECONDS) * 1000;
  const recorded = () => Math.min(Date.now(), recordEnd) - startTs;
  let sent = 0, partNumber = 0;
  for (;;) {
    const available = Math.floor(recorded() / 1000 * bytesPerSec) - sent;
    const recordingDone = Date.now() >= recordEnd;
    if (available < partBytes && !recordingDone) { await sleep(100); continue; }
    if (recordingDone && available <= 0) break;
    const size = Math.min(partBytes, available);
    partNumber++;
    let ok = false;
    for (let attempt = 0; attempt < 8 && !ok; attempt++) {
      const t0 = Date.now();
      try {
        const q = new URLSearchParams({ sessionId: SESSION, t: TOKEN, key, uploadId, partNumber: String(partNumber) });
        const r = await fetch(`${BASE}/api/uploads/part?${q}`, { method: 'PUT', body: payload.subarray(0, size), headers: { 'Content-Length': String(size) }, duplex: 'half' });
        await r.text();
        if (r.ok) { ok = true; out.latencies.push(Date.now() - t0); } else { out.partErrors++; await sleep(500 * (attempt + 1)); }
      } catch (e) { out.partErrors++; out.errors.push('part ' + e.message); await sleep(500 * (attempt + 1)); }
    }
    if (!ok) { out.errors.push(`part ${partNumber} gave up`); break; }
    sent += size; out.parts++;
    if (Date.now() >= recordEnd && !out._stopAt) { out._stopAt = Date.now(); out.backlogMB = +((Math.floor(Number(SECONDS) * bytesPerSec) - sent) / 1048576).toFixed(1); }
  }
  if (!out._stopAt) out._stopAt = Date.now();
  out.drainS = +((Date.now() - recordEnd) / 1000).toFixed(1);
  for (let a = 0; a < 5; a++) {
    const r = await post('/api/uploads/complete', { sessionId: SESSION, t: TOKEN, guestId: id, key, uploadId, expectedParts: partNumber, fileType: 'camera', startTs, durationMs: Number(SECONDS) * 1000, recIndex: 1 }).catch(e => ({ status: 0 }));
    if (r.status === 200) { out.completeOk = r.data.size === sent; if (!out.completeOk) out.errors.push(`size ${r.data.size} != ${sent}`); break; }
    await sleep(1000);
  }
  delete out._stopAt;
  ws.close();
  return out;
}

(async () => {
  const t0 = Date.now();
  const res = await Promise.all(Array.from({ length: Number(N) }, (_, i) => guest(i)));
  const lat = res.flatMap(r => r.latencies).sort((a, b) => a - b);
  const pct = p => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null;
  console.log(JSON.stringify({
    guests: Number(N), mbps: Number(MBPS), seconds: Number(SECONDS),
    wallS: +((Date.now() - t0) / 1000).toFixed(1),
    completed: res.filter(r => r.completeOk).length,
    parts: lat.length, partErrors: res.reduce((s, r) => s + r.partErrors, 0),
    partMsP50: pct(0.5), partMsP95: pct(0.95), partMsMax: lat[lat.length - 1] || null,
    maxBacklogMB: Math.max(...res.map(r => r.backlogMB)), maxDrainS: Math.max(...res.map(r => r.drainS)),
    errors: [...new Set(res.flatMap(r => r.errors))].slice(0, 8)
  }));
})();

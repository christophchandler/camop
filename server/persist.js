// Saves each session's manifest next to its recordings and reads them back at boot.
// Saving is best effort: a failed write is retried on the next change and never
// gets in the way of a recording or an upload.
const S = require('./sessions');
const P = require('./project');
const storage = require('./b2');

const DELAY_MS = 1500;
const timers = new Map();
let enabled = false;

function save(session) {
  return storage.putText(P.manifestKey(session), JSON.stringify(S.toManifest(session), null, 2));
}

function scheduleSave(session) {
  if (!enabled || timers.has(session.id)) return;
  timers.set(session.id, setTimeout(async () => {
    timers.delete(session.id);
    try { await save(session); }
    catch (err) {
      console.error(`Saving session ${session.id.slice(0, 8)} failed:`, err.name || err.message);
      setTimeout(() => scheduleSave(session), 30000).unref();
    }
  }, DELAY_MS));
}

// Write everything still waiting (used at shutdown).
async function flush() {
  const ids = [...timers.keys()];
  for (const id of ids) { clearTimeout(timers.get(id)); timers.delete(id); }
  await Promise.all(ids.map(id => {
    const s = S.getSession(id);
    return s ? save(s).catch(() => {}) : null;
  }));
}

// Restore every session whose manifest changed within the TTL.
async function loadRecent(ttlMs) {
  const cutoff = Date.now() - ttlMs;
  const keys = (await storage.listKeys())
    .filter(o => P.MANIFEST_RE.test(o.key) && new Date(o.modified).getTime() > cutoff);
  let restored = 0;
  for (const o of keys) {
    try {
      const doc = JSON.parse(await storage.getText(o.key));
      if (doc && doc.camop === 1 && S.restoreSession(doc)) restored++;
    } catch (err) {
      console.error(`Could not read ${o.key}:`, err.name || err.message);
    }
  }
  return restored;
}

function start() {
  enabled = true;
  S.setOnChange(scheduleSave);
}

module.exports = { start, loadRecent, flush, scheduleSave };

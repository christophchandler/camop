// Where a session's files live in the CamOp bucket.
//
// The bucket mirrors the studio's Projects folder, so a download-only Cloud Sync
// task (bucket root -> Projects) drops each session straight into its project:
//   261019_Client_Project/2_FOOTAGE/1_VIDEO/CAMOP/20261019_141502_Guest_CAM_take01.mp4
//   261019_Client_Project/2_FOOTAGE/1_VIDEO/CAMOP/camop_session_<id8>.json

const TZ = process.env.STUDIO_TZ || 'America/Los_Angeles';
const CAMOP_SUBPATH = '2_FOOTAGE/1_VIDEO/CAMOP/';

function parts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return o;
}
function yymmdd(date = new Date()) {
  const p = parts(date);
  return `${p.year.slice(2)}${p.month}${p.day}`;
}
function stamp(date = new Date()) {
  const p = parts(date);
  return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}`;
}

// "bonsai robotics" -> "BonsaiRobotics"; "RFM" stays "RFM".
function squash(text, max = 40) {
  return String(text || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9&-]+/).filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('').slice(0, max);
}

// An existing folder name typed by the producer, e.g. "261008_BonsaiRobtoics_RFM".
// Slashes, colons and leading dots would break the path on the server, so they go.
function cleanFolder(text) {
  return String(text || '').trim()
    .replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/^[.\s]+/, '').replace(/\s+$/, '')
    .slice(0, 120);
}

function folderFor({ client, project, folder, createdAt }) {
  const existing = cleanFolder(folder);
  if (existing) return existing;
  const bits = [yymmdd(createdAt ? new Date(createdAt) : new Date()), squash(client), squash(project)].filter(Boolean);
  return bits.length > 1 ? bits.join('_') : `${bits[0]}_CamOp`;
}

function prefixFor(folder) {
  return `${folder}/${CAMOP_SUBPATH}`;
}

// A session made before folders existed (or one we could not restore) still needs
// somewhere to put files; keep those together and obviously unsorted.
function fallbackFolder(sessionId) {
  return `_CamOp_Unsorted/${yymmdd()}_${String(sessionId).slice(0, 8)}`;
}

const TYPE_TAG = { camera: 'CAM', audio: 'AUDIO', screen: 'SCREEN' };
function recordingName({ startTs, guestName, fileType, take, ext }) {
  const when = stamp(new Date(Number(startTs) || Date.now()));
  const who = squash(guestName, 30) || 'Guest';
  const tag = TYPE_TAG[fileType] || 'CAM';
  const n = String(Math.max(1, Math.min(999, parseInt(take, 10) || 1))).padStart(2, '0');
  const e = /^[a-z0-9]{2,5}$/i.test(ext || '') ? ext.toLowerCase() : 'mp4';
  return `${when}_${who}_${tag}_take${n}.${e}`;
}

// Older guest pages send only a file name like
// "2026-10-19_danielle_camera_1760900000000_rec1.mp4"; pull what we need out of it.
function parseLegacyName(fileName) {
  const m = /_(camera|audio|screen)_(\d{10,})_rec(\d+)\.([a-z0-9]{2,5})$/i.exec(String(fileName || ''));
  if (!m) {
    const ext = /\.([a-z0-9]{2,5})$/i.exec(String(fileName || ''));
    return { ext: ext ? ext[1] : 'mp4' };
  }
  return { fileType: m[1].toLowerCase(), startTs: Number(m[2]), take: Number(m[3]), ext: m[4] };
}

function manifestKey(session) {
  return `${prefixFor(session.folder)}camop_session_${session.id.slice(0, 8)}.json`;
}
const MANIFEST_RE = /(^|\/)2_FOOTAGE\/1_VIDEO\/CAMOP\/camop_session_[0-9a-f]{8}\.json$/;

module.exports = {
  TZ, yymmdd, stamp, squash, cleanFolder, folderFor, prefixFor, fallbackFolder,
  recordingName, parseLegacyName, manifestKey, MANIFEST_RE
};

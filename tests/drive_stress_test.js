// Stress test for Google Drive delivery (server/drive.js) against tests/fake_drive.py:
// files of awkward sizes copied from a local S3 under heavy injected faults, every copy
// checked byte for byte, and a corrupted upload must be caught by the MD5 check.
// Usage: node tests/drive_stress_test.js   (needs moto_server, python3, openssl)
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const S3P = 5088, DP = 5089;
const pem = execSync('openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048').toString();
Object.assign(process.env, {
  B2_BUCKET_ENDPOINT: `http://127.0.0.1:${S3P}`, B2_ACCOUNT_ID: 'test', B2_APPLICATION_KEY: 'test-secret', B2_BUCKET_NAME: 'drive-stress',
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'camop-drive@test.iam.gserviceaccount.com', private_key: pem, token_uri: `http://127.0.0.1:${DP}/token` }),
  DRIVE_API_BASE: `http://127.0.0.1:${DP}/drive/v3`, DRIVE_UPLOAD_BASE: `http://127.0.0.1:${DP}/upload/drive/v3`, DRIVE_CHUNK_MB: '1'
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) failures++; };

(async () => {
  const moto = spawn('moto_server', ['-p', String(S3P)], { stdio: 'ignore' });
  const fake = spawn('python3', [path.join(__dirname, 'fake_drive.py'), String(DP)], { stdio: 'ignore' });
  const faults = async f => fetch(`http://127.0.0.1:${DP}/__faults`, { method: 'POST', body: JSON.stringify(f) });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${S3P}/`); await fetch(`http://127.0.0.1:${DP}/__dump`); break; } catch { await sleep(300); } }
    const { S3Client, CreateBucketCommand, PutObjectCommand } = require('../server/node_modules/@aws-sdk/client-s3');
    const s3 = new S3Client({ endpoint: `http://127.0.0.1:${S3P}`, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test-secret' } });
    await s3.send(new CreateBucketCommand({ Bucket: 'drive-stress' }));
    const drive = require('../server/drive.js');
    const S = require('../server/sessions.js');
    const session = S.createSession({ client: 'Stress', project: 'Drive' });
    const parent = await drive._internals.camopFolder(session);
    check('Folders created under the shared drive', !!parent);

    const MB = 1024 * 1024;
    const sizes = [3, 256 * 1024, MB, MB + 1, 5 * MB - 7, 20 * MB + 12345, 37 * MB];
    await faults({ chunk_fail: 0.25, chunk_partial: 0.2, chunk_drop: 0.15, api_fail: 0.1 });
    const t0 = Date.now();
    for (const size of sizes) {
      const data = crypto.randomBytes(size);
      const key = `stress/file_${size}.mp4`;
      await s3.send(new PutObjectCommand({ Bucket: 'drive-stress', Key: key, Body: data }));
      let meta, err;
      try { meta = await drive._internals.uploadFromStorage(key, `file_${size}.mp4`, parent, 'video/mp4', size, () => {}); } catch (e) { err = e; }
      const want = crypto.createHash('md5').update(data).digest('hex');
      check(`${size} bytes through heavy faults: identical copy in Drive`, meta && meta.md5Checksum === want && Number(meta.size) === size, err ? err.message : `md5 ${meta.md5Checksum.slice(0, 8)}`);
    }
    const dump = await (await fetch(`http://127.0.0.1:${DP}/__dump`)).json();
    console.log('   faults injected:', JSON.stringify(dump.stats), `in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    check('Faults actually happened', dump.stats.chunk_fail > 3 && dump.stats.chunk_partial > 2 && dump.stats.chunk_drop > 2, JSON.stringify(dump.stats));

    // A copy that arrives corrupted must be thrown away, not kept.
    await faults({ corrupt: 1 });
    const data = crypto.randomBytes(3 * MB);
    await s3.send(new PutObjectCommand({ Bucket: 'drive-stress', Key: 'stress/corrupt.mp4', Body: data }));
    let caught = null;
    try { await drive._internals.uploadFromStorage('stress/corrupt.mp4', 'corrupt.mp4', parent, 'video/mp4', data.length, () => {}); } catch (e) { caught = e; }
    const after = (await (await fetch(`http://127.0.0.1:${DP}/__dump`)).json()).items.filter(i => i.name === 'corrupt.mp4');
    check('Corrupted copy caught by the MD5 check and deleted', caught && /did not match/.test(caught.message) && caught.restart && after.length === 0, caught ? caught.message.slice(0, 60) : 'not caught');

    // Through the queue: a file is retried until it lands, and the dashboard state says so.
    await faults({ api_fail: 0.3, chunk_fail: 0.3 });
    const fdata = crypto.randomBytes(6 * MB);
    const fkey = `${session.folder}/2_FOOTAGE/1_VIDEO/CAMOP/queued.mp4`;
    await s3.send(new PutObjectCommand({ Bucket: 'drive-stress', Key: fkey, Body: fdata }));
    S.addGuestToSession(session.id, 'g1', 'Guest', null);
    S.addGuestFile(session.id, 'g1', { key: fkey, fileName: 'queued.mp4', fileType: 'camera', size: fdata.length, status: 'complete' });
    drive.start(() => {});
    drive.enqueue(session.id, fkey);
    const f = session.guests.get('g1').files[0];
    for (let i = 0; i < 240 && !(f.drive && f.drive.state === 'delivered'); i++) await sleep(500);
    check('Queued delivery lands and records the Drive link', f.drive && f.drive.state === 'delivered' && /drive.google.com/.test(f.drive.link), JSON.stringify(f.drive));
  } catch (e) {
    check('stress run', false, e.stack);
  } finally {
    moto.kill(); fake.kill();
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
  }
})();

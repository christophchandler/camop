"""End-to-end reliability test for CamOp.

Runs a local S3 (moto), the CamOp server, and headless Chrome with a fake camera
and mic, then checks the failure cases that matter:
  1. Parts upload while recording is still running.
  2. The guest tab is reloaded mid-recording (stands in for a crash); the take is
     finalized and uploaded from disk after the reload.
  3. The server is killed mid-recording and restarted; recording continues and
     the upload completes after it comes back.
Every stored file is downloaded and checked with ffprobe.

Usage:  python3 tests/e2e_test.py
Needs:  pip install "moto[server]" boto3 playwright ; Chromium for Playwright ; ffprobe
"""
import datetime
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time

import boto3
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S3_PORT, APP_PORT = 5055, 3999
BUCKET = 'camop-test'
PASSWORD = 'test-password'
BASE = f'http://localhost:{APP_PORT}'

ENV = dict(os.environ,
           B2_BUCKET_ENDPOINT=f'http://127.0.0.1:{S3_PORT}', B2_ACCOUNT_ID='test', B2_APPLICATION_KEY='test-secret',
           B2_BUCKET_NAME=BUCKET, DASHBOARD_PASSWORD=PASSWORD, PORT=str(APP_PORT), NODE_ENV='test')

results = []
# CFR=vp9 runs the guest's constant-frame-rate recorder (VP9 + Opus here, since this
# Chromium has no H.264/AAC encoder); unset, the camera file comes from MediaRecorder.
CFR = os.environ.get('CFR', '')
# DRIVE=1 adds Google Drive delivery against tests/fake_drive.py, with injected faults.
DRIVE = os.environ.get('DRIVE', '')
DRIVE_PORT = 5077
DRIVE_FAULTS = os.environ.get('DRIVE_FAULTS', '{"chunk_fail":0.1,"chunk_partial":0.1,"chunk_drop":0.05,"api_fail":0.05}')
from zoneinfo import ZoneInfo
FOLDER = datetime.datetime.now(ZoneInfo('America/Los_Angeles')).strftime('%y%m%d') + '_BonsaiRobotics_ExecInterviews'


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  ({detail})' if detail else ''), flush=True)


def wait_for(fn, timeout, step=0.5, what='condition'):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    raise TimeoutError(f'Timed out waiting for {what} (last={last})')


def drive_env():
    pem = subprocess.run(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048'], capture_output=True, text=True).stdout
    sa = {'type': 'service_account', 'client_email': 'camop-drive@test.iam.gserviceaccount.com', 'private_key': pem,
          'token_uri': f'http://127.0.0.1:{DRIVE_PORT}/token'}
    return {'GOOGLE_SERVICE_ACCOUNT_JSON': json.dumps(sa), 'DRIVE_API_BASE': f'http://127.0.0.1:{DRIVE_PORT}/drive/v3',
            'DRIVE_UPLOAD_BASE': f'http://127.0.0.1:{DRIVE_PORT}/upload/drive/v3', 'DRIVE_CHUNK_MB': '1'}


def drive_dump():
    import urllib.request
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{DRIVE_PORT}/__dump').read())


def start_server(log):
    return subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=ENV, stdout=log, stderr=subprocess.STDOUT)


def main():
    tmp = tempfile.mkdtemp(prefix='camop-e2e-')
    s3_log = open(os.path.join(tmp, 's3.log'), 'w')
    app_log = open(os.path.join(tmp, 'app.log'), 'w')
    moto = subprocess.Popen(['moto_server', '-p', str(S3_PORT)], stdout=s3_log, stderr=subprocess.STDOUT)
    fake_drive = None
    if DRIVE:
        ENV.update(drive_env())
        fake_drive = subprocess.Popen([sys.executable, os.path.join(ROOT, 'tests', 'fake_drive.py'), str(DRIVE_PORT)],
                                      env=dict(os.environ, FAKE_DRIVE_FAULTS=DRIVE_FAULTS), stdout=s3_log, stderr=subprocess.STDOUT)
    s3 = boto3.client('s3', endpoint_url=f'http://127.0.0.1:{S3_PORT}', aws_access_key_id='test',
                      aws_secret_access_key='test-secret', region_name='us-east-1')
    wait_for(lambda: _try(lambda: s3.list_buckets()), 20, what='local S3')
    s3.create_bucket(Bucket=BUCKET)
    app = start_server(app_log)
    import urllib.request
    wait_for(lambda: _try(lambda: urllib.request.urlopen(f'{BASE}/api/health').read()), 20, what='CamOp server')

    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                                          '--autoplay-policy=no-user-gesture-required'])
        prod = browser.new_context().new_page()
        gctx = browser.new_context(permissions=['camera', 'microphone'])
        guest = gctx.new_page()
        guest_console = []
        guest.on('console', lambda m: guest_console.append(f'{m.type}: {m.text}'))

        # Producer signs in and creates a session
        prod.goto(BASE)
        prod.fill('input[type=password]', PASSWORD)
        prod.click('button[type=submit]')
        prod.fill('input[aria-label="Client"]', 'bonsai robotics')
        prod.fill('input[aria-label="Project"]', 'Exec Interviews')
        preview = prod.inner_text('text=Saves to Projects/')
        prod.click('button:has-text("Start Session")')
        link = wait_for(lambda: _link(prod), 15, what='magic link')
        check('Dashboard sign-in and signed guest link', '&t=' in link, link.split('?')[1][:40] + '...')
        check('Folder preview shown before creating', FOLDER in preview, preview)
        wait_for(lambda: FOLDER in prod.inner_text('body'), 10, what='saving-to line')
        check('Session shows where files are saved', f'Projects/{FOLDER}/2_FOOTAGE/1_VIDEO/CAMOP' in prod.inner_text('body'))

        # Wrong token is rejected
        bad = link.split('&t=')[0] + '&t=wrong'
        status = _try(lambda: urllib.request.urlopen(urllib.request.Request(
            f'{BASE}/api/uploads/create', data=json.dumps({'sessionId': bad.split('session=')[1].split('&')[0], 't': 'wrong', 'fileName': 'x.mp4'}).encode(),
            headers={'Content-Type': 'application/json'})).status) or 403
        check('Forged guest link is refused', status == 403)

        guest_url = link + '&partmb=5' + (f'&cfr={CFR}&testres=640x360' if CFR else '&cfr=0')

        def join():
            guest.goto(guest_url)
            guest.fill('#name-input', 'Test Guest')
            guest.check('#consent-input')
            guest.click('#join-btn')
            guest.wait_for_selector('#setup-modal.active', timeout=15000)
            guest.click('#setup-confirm-btn')

        def start_take():
            btn = prod.get_by_role('button', name='Start Recording').filter(has_not=prod.locator('[disabled]'))
            wait_for(lambda: prod.locator('button:has-text("Start Recording"):not([disabled])').count() > 0, 20, what='Start button')
            prod.locator('button:has-text("Start Recording"):not([disabled])').first.click()
            wait_for(lambda: guest.evaluate('window.__camop.isRecording()'), 15, what='guest recording')

        def totals():
            return guest.evaluate('window.__camop.uploadTotals()')

        def all_done():
            recs = guest.evaluate('window.__camop.allRecs()')
            return recs if recs and all(r['state'] == 'done' for r in recs) else None

        # Take 1: upload during recording, then a reload mid-take
        join()
        start_take()
        # VP9 on the fake camera's simple picture runs ~1 Mbps, so a 5 MB part takes longer to fill.
        t = wait_for(lambda: (lambda x: x if x['uploaded'] > 0 else None)(totals()), 240 if CFR else 90, step=1, what='first part upload')
        check('Parts upload while still recording', guest.evaluate('window.__camop.isRecording()') and t['uploaded'] > 0,
              f"{t['uploaded'] / 1048576:.1f} MB uploaded of {t['recorded'] / 1048576:.1f} MB recorded")
        time.sleep(3)
        guest.reload()  # stands in for a crash or accidental refresh
        recs = wait_for(all_done, 120, step=1, what='take 1 finished after reload')
        check('Reloaded mid-take: recording finalized and uploaded from disk', len(recs) >= 2,
              ', '.join(f"{r['fileType']} {r['completeSize']} B" for r in recs))
        check('Stored size matches recorded size (take 1)', all(r['completeSize'] == r['totalBytes'] for r in recs))

        # Take 2: kill the server mid-recording, restart it, stop, finish
        guest.fill('#name-input', 'Test Guest')
        guest.check('#consent-input')
        guest.click('#join-btn')
        guest.wait_for_selector('#setup-modal.active', timeout=15000)
        guest.click('#setup-confirm-btn')
        start_take()
        # Switch-camera request during a take: the guest is told, not silently refused
        prod.locator('button:has-text("Switch Device")').first.click()
        guest.wait_for_selector('#toast-container.show', timeout=10000)
        toast = guest.inner_text('#toast-text')
        check('Switch-camera request shows on the guest during a take', 'as soon as this take stops' in toast, toast)
        guest.click('#toast-approve')
        time.sleep(6)
        app.send_signal(signal.SIGKILL)
        app.wait()
        time.sleep(10)  # recording keeps going with the server gone
        still = guest.evaluate('window.__camop.isRecording()')
        app = start_server(app_log)
        wait_for(lambda: _try(lambda: urllib.request.urlopen(f'{BASE}/api/health').read()), 20, what='server restart')
        time.sleep(8)
        check('Recording continued while the server was down', still)
        prod.reload()
        wait_for(lambda: 'previous session' in prod.inner_text('body'), 20, what='session list after restart')
        prod.click('summary:has-text("previous session")')
        check('Session name and folder restored after a server crash', FOLDER in prod.inner_text('body'))
        prod.locator('button:has-text("Exec Interviews")').first.click()
        # Producer's dashboard reconnects on its own; stop from the tile
        wait_for(lambda: prod.locator('button:has-text("Stop")').count() > 0, 30, what='Stop button after restart')
        prod.locator('button:has-text("Stop")').first.click()
        recs = wait_for(lambda: (lambda r: r if r and len(r) >= 4 and all(x['state'] == 'done' for x in r) else None)(
            guest.evaluate('window.__camop.allRecs()')), 120, step=1, what='take 2 finished')
        check('Server crash mid-take: upload completed after restart', True, f'{len(recs)} files done')
        check('Stored size matches recorded size (all takes)', all(r['completeSize'] == r['totalBytes'] for r in recs))
        wait_for(lambda: 'All saved' in guest.inner_text('#recovery-bar'), 15, what='All saved message')
        check('Guest sees "All saved"', True)
        time.sleep(1)
        check('Camera menu opens once the take stops', guest.evaluate("document.getElementById('cam-dropdown').classList.contains('show')"))
        time.sleep(3)  # let the manifest save
        if DRIVE:
            prefix = f'CamOp Uploads/{FOLDER}/2_FOOTAGE/1_VIDEO/CAMOP/'
            def delivered():
                d = drive_dump()
                files = [i for i in d['items'] if i['path'].startswith(prefix) and i['mimeType'] != 'application/vnd.google-apps.folder']
                media = [f for f in files if not f['name'].endswith('.json')]
                ok = len(media) >= 4 and prod.locator('a:has-text("In Drive")').count() >= 4 and any(f['name'].endswith('.json') for f in files)
                return (d, files) if ok else None
            d, drive_files = wait_for(delivered, 240, step=2, what='files delivered to Drive')
            check('Every take delivered to Google Drive (with faults injected)', True,
                  f"{len([f for f in drive_files if not f['name'].endswith('.json')])} files; faults: " + json.dumps({k: v for k, v in d['stats'].items() if v}))
            names = [f['name'] for f in drive_files]
            check('No duplicate files in Drive', len(names) == len(set(names)), ', '.join(sorted(names)))
            folders = [i['path'] for i in d['items'] if i['mimeType'] == 'application/vnd.google-apps.folder']
            check('Drive folders created once each', len(folders) == len(set(folders)), ', '.join(sorted(folders)))
            body = prod.inner_text('body')
            check('Dashboard links the session folder in Drive', 'Open in Google Drive' in body)
        # Producer download from the dashboard: signed link to storage, exact bytes
        href = prod.locator('a:has-text("Download")').first.get_attribute('href')
        dl = prod.request.get(BASE + href, max_redirects=5)
        check('Dashboard Download link returns the file', dl.status == 200 and len(dl.body()) > 1000 and 'attachment' in (dl.headers.get('content-disposition') or ''),
              f"status={dl.status} bytes={len(dl.body())}")
        browser.close()

    # Verify every stored object is a playable media file
    objs = s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])
    prefix = f'{FOLDER}/2_FOOTAGE/1_VIDEO/CAMOP/'
    media = [o for o in objs if not o['Key'].endswith('.json')]
    check('Files in storage', len(media) >= 4, ', '.join(o['Key'].split('/')[-1] for o in media))
    check('Every file is inside the project folder', all(o['Key'].startswith(prefix) for o in objs), objs[0]['Key'] if objs else '')
    name_re = re.compile(r'^\d{8}_\d{6}_TestGuest_(CAM|AUDIO)_take(\d\d)\.(mp4|m4a|webm|ogg)$')
    names = [o['Key'].split('/')[-1] for o in media]
    check('File names read like 20261019_141502_TestGuest_CAM_take01.mp4', all(name_re.match(n) for n in names), ', '.join(names))
    takes = sorted({name_re.match(n).group(2) for n in names if name_re.match(n)})
    check('Takes numbered by the server (take01, take02)', takes == ['01', '02'], str(takes))
    manifests = [o for o in objs if o['Key'].endswith('.json')]
    doc = json.loads(s3.get_object(Bucket=BUCKET, Key=manifests[0]['Key'])['Body'].read()) if manifests else {}
    listed = {f['fileName'] for g in doc.get('guests', []) for f in g.get('files', [])}
    check('Session manifest saved next to the files and lists them', len(manifests) == 1 and doc.get('folder') == FOLDER
          and set(names) <= listed and doc.get('client') == 'bonsai robotics', manifests[0]['Key'].split('/')[-1] if manifests else 'none')
    check('Manifest holds no guest link token', 't=' not in json.dumps(doc) and '"t"' not in json.dumps(doc))
    # Camera and audio-only files of the same take should be about the same length
    durs = {}
    for o in media:
        pth = os.path.join(tmp, 'len_' + o['Key'].split('/')[-1]); s3.download_file(BUCKET, o['Key'], pth)
        d = float(json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', pth], capture_output=True, text=True).stdout or '{}').get('format', {}).get('duration') or 0)
        m = name_re.match(o['Key'].split('/')[-1])
        if m: durs.setdefault(m.group(2), {})[m.group(1)] = d
    for take, d in sorted(durs.items()):
        if 'CAM' in d and 'AUDIO' in d:
            check(f'Take {take}: camera and audio files the same length (within 6 s)', abs(d['CAM'] - d['AUDIO']) < 6, f"camera {d['CAM']:.1f}s, audio {d['AUDIO']:.1f}s")
    if DRIVE:
        import hashlib
        dd = {i['name']: i for i in drive_dump()['items']}
        same = []
        for o in media:
            body = s3.get_object(Bucket=BUCKET, Key=o['Key'])['Body'].read()
            it = dd.get(o['Key'].split('/')[-1])
            same.append(bool(it) and it['md5Checksum'] == hashlib.md5(body).hexdigest() and int(it['size']) == len(body))
        check('Drive copies are byte-for-byte identical to the recordings', all(same) and same, f'{sum(same)}/{len(same)}')
        man = next((i for n, i in dd.items() if n.startswith('camop_session_')), None)
        check('Session file in Drive', man is not None)
    for o in media:
        path = os.path.join(tmp, o['Key'].split('/')[-1])
        s3.download_file(BUCKET, o['Key'], path)
        # Full decode catches truncated or corrupt files that a header probe would miss
        dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'], capture_output=True, text=True)
        probe = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration',
                                           '-of', 'json', path], capture_output=True, text=True).stdout or '{}')
        kinds = sorted(s['codec_type'] for s in probe.get('streams', []))
        dur = probe.get('format', {}).get('duration')
        expect = ['audio'] if '_AUDIO_' in path else ['audio', 'video']
        if CFR and '_CAM_' in path:
            v = next((s_ for s_ in json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,avg_frame_rate,r_frame_rate',
                      '-of', 'json', path], capture_output=True, text=True).stdout or '{}').get('streams', []) if s_.get('codec_type') == 'video'), {})
            pts = sorted(int(x) for x in subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts', '-of', 'csv=p=0', path],
                         capture_output=True, text=True).stdout.split() if x.strip().lstrip('-').isdigit())
            off = [b - a for a, b in zip(pts, pts[1:]) if b - a != 1001]
            # The fake camera runs at 20 fps, so CamOp picks the 23.976 grid for it.
            check(f"Constant frame rate: {os.path.basename(path)}", v.get('avg_frame_rate') in ('30000/1001', '24000/1001') and not off and len(pts) > 30,
                  f"avg={v.get('avg_frame_rate')} frames={len(pts)} off-grid={len(off)}")
        # Duplicate timestamps from MediaRecorder under CPU load are a muxer warning, not lost data.
        decode_errors = [l for l in dec.stderr.splitlines() if l.strip() and 'non monotonically increasing dts' not in l]
        check(f"Decodes cleanly: {os.path.basename(path)}", kinds == expect and not decode_errors,
              f"streams={kinds} duration={dur} errors={len(decode_errors)}")

    app.terminate(); moto.terminate()
    if fake_drive:
        fake_drive.terminate()
    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed. Logs: {tmp}')
    if failed:
        print('Guest console tail:\n' + '\n'.join(guest_console[-30:]))
        sys.exit(1)


def _try(fn):
    try:
        return fn()
    except Exception:
        return None


def _link(page):
    try:
        t = page.locator('div.select-all').first.inner_text(timeout=1000)
        return t if '/guest/?session=' in t else None
    except Exception:
        return None


if __name__ == '__main__':
    main()

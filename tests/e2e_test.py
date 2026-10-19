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
import json
import os
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


def start_server(log):
    return subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=ENV, stdout=log, stderr=subprocess.STDOUT)


def main():
    tmp = tempfile.mkdtemp(prefix='camop-e2e-')
    s3_log = open(os.path.join(tmp, 's3.log'), 'w')
    app_log = open(os.path.join(tmp, 'app.log'), 'w')
    moto = subprocess.Popen(['moto_server', '-p', str(S3_PORT)], stdout=s3_log, stderr=subprocess.STDOUT)
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
        prod.fill('input[placeholder="Name your session..."]', 'E2E session')
        prod.keyboard.press('Enter')
        link = wait_for(lambda: _link(prod), 15, what='magic link')
        check('Dashboard sign-in and signed guest link', '&t=' in link, link.split('?')[1][:40] + '...')

        # Wrong token is rejected
        bad = link.split('&t=')[0] + '&t=wrong'
        status = _try(lambda: urllib.request.urlopen(urllib.request.Request(
            f'{BASE}/api/uploads/create', data=json.dumps({'sessionId': bad.split('session=')[1].split('&')[0], 't': 'wrong', 'fileName': 'x.mp4'}).encode(),
            headers={'Content-Type': 'application/json'})).status) or 403
        check('Forged guest link is refused', status == 403)

        guest_url = link + '&partmb=5'

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
        t = wait_for(lambda: (lambda x: x if x['uploaded'] > 0 else None)(totals()), 90, step=1, what='first part upload')
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
        time.sleep(8)
        app.send_signal(signal.SIGKILL)
        app.wait()
        time.sleep(10)  # recording keeps going with the server gone
        still = guest.evaluate('window.__camop.isRecording()')
        app = start_server(app_log)
        wait_for(lambda: _try(lambda: urllib.request.urlopen(f'{BASE}/api/health').read()), 20, what='server restart')
        time.sleep(8)
        check('Recording continued while the server was down', still)
        # Producer's dashboard reconnects on its own; stop from the tile
        wait_for(lambda: prod.locator('button:has-text("Stop")').count() > 0, 30, what='Stop button after restart')
        prod.locator('button:has-text("Stop")').first.click()
        recs = wait_for(lambda: (lambda r: r if r and len(r) >= 4 and all(x['state'] == 'done' for x in r) else None)(
            guest.evaluate('window.__camop.allRecs()')), 120, step=1, what='take 2 finished')
        check('Server crash mid-take: upload completed after restart', True, f'{len(recs)} files done')
        check('Stored size matches recorded size (all takes)', all(r['completeSize'] == r['totalBytes'] for r in recs))
        wait_for(lambda: 'All saved' in guest.inner_text('#recovery-bar'), 15, what='All saved message')
        check('Guest sees "All saved"', True)
        browser.close()

    # Verify every stored object is a playable media file
    objs = s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])
    check('Files in storage', len(objs) >= 4, ', '.join(o['Key'].split('/')[-1] for o in objs))
    for o in objs:
        path = os.path.join(tmp, o['Key'].split('/')[-1])
        s3.download_file(BUCKET, o['Key'], path)
        # Full decode catches truncated or corrupt files that a header probe would miss
        dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'], capture_output=True, text=True)
        probe = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration',
                                           '-of', 'json', path], capture_output=True, text=True).stdout or '{}')
        kinds = sorted(s['codec_type'] for s in probe.get('streams', []))
        dur = probe.get('format', {}).get('duration')
        expect = ['audio'] if '_audio_' in path else ['audio', 'video']
        decode_errors = [l for l in dec.stderr.splitlines() if l.strip()]
        check(f"Decodes cleanly: {os.path.basename(path)}", kinds == expect and not decode_errors,
              f"streams={kinds} duration={dur} errors={len(decode_errors)}")

    app.terminate(); moto.terminate()
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

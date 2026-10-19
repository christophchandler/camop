"""Screenshots of the guest toolbar and dashboard tile for visual review."""
import os, subprocess, sys, tempfile, time, urllib.request
import boto3
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S3_PORT, APP_PORT = 5056, 3998
BASE = f'http://localhost:{APP_PORT}'
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='camop-shots-')
os.makedirs(OUT, exist_ok=True)
ENV = dict(os.environ, B2_BUCKET_ENDPOINT=f'http://127.0.0.1:{S3_PORT}', B2_ACCOUNT_ID='t', B2_APPLICATION_KEY='t',
           B2_BUCKET_NAME='shots', DASHBOARD_PASSWORD='pw', PORT=str(APP_PORT), NODE_ENV='test')


def wait(fn, t=20):
    end = time.time() + t
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(0.5)
    raise TimeoutError


moto = subprocess.Popen(['moto_server', '-p', str(S3_PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
s3 = boto3.client('s3', endpoint_url=f'http://127.0.0.1:{S3_PORT}', aws_access_key_id='t', aws_secret_access_key='t', region_name='us-east-1')
wait(lambda: s3.list_buckets())
s3.create_bucket(Bucket='shots')
app = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
wait(lambda: urllib.request.urlopen(f'{BASE}/api/health').read())
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
        prod = b.new_context(viewport={'width': 1280, 'height': 900}).new_page()
        prod.goto(BASE)
        prod.fill('input[type=password]', 'pw'); prod.click('button[type=submit]')
        prod.fill('input[placeholder="Name your session..."]', 'Toolbar review'); prod.keyboard.press('Enter')
        wait(lambda: '/guest/?session=' in prod.locator('div.select-all').first.inner_text(timeout=1000))
        link = prod.locator('div.select-all').first.inner_text()
        g = b.new_context(viewport={'width': 1280, 'height': 800}, permissions=['camera', 'microphone']).new_page()
        g.goto(link)
        g.fill('#name-input', 'Jordan Lee'); g.check('#consent-input'); g.click('#join-btn')
        g.wait_for_selector('#setup-modal.active')
        wait(lambda: 'Mbps' in g.inner_text('#speed-line') or 'Could not' in g.inner_text('#speed-line'), 30)
        g.screenshot(path=f'{OUT}/1-setup.png')
        print('speed line:', g.inner_text('#speed-line'))
        g.click('#phone-cam-btn'); g.wait_for_function("document.getElementById('phone-qr').complete && document.getElementById('phone-qr').naturalWidth > 0", timeout=10000)
        g.screenshot(path=f'{OUT}/1b-setup-phone-qr.png')
        # Phone joins the same session from the QR link
        ph = b.new_context(**p.devices['iPhone 13'], permissions=['camera', 'microphone']).new_page()
        ph.goto(link + '&device=phone')
        ph.fill('#name-input', 'Jordan Lee'); ph.check('#consent-input'); ph.click('#join-btn')
        ph.wait_for_selector('#setup-modal.active')
        time.sleep(7)
        ph.screenshot(path=f'{OUT}/9-phone-setup.png')
        ph.click('#setup-confirm-btn'); time.sleep(1)
        ph.screenshot(path=f'{OUT}/10-phone-ready.png')
        g.click('#setup-confirm-btn')
        time.sleep(1)
        g.screenshot(path=f'{OUT}/2-guest-idle.png')
        g.click('#tb-mic-switch'); time.sleep(0.4)
        g.screenshot(path=f'{OUT}/3-guest-mic-menu.png')
        g.keyboard.press('Escape')
        wait(lambda: prod.locator('select').count() > 0, 20)
        time.sleep(1.5)
        prod.screenshot(path=f'{OUT}/4-dashboard-ready.png')
        print('options:', prod.locator('select').first.inner_text())
        prod.screenshot(path=f'{OUT}/4b-dashboard-two-tiles.png', full_page=True)
        prod.locator('button:has-text("Start All")').first.click()
        wait(lambda: g.evaluate('window.__camop.isRecording()'), 15)
        g.click('#tb-mute'); time.sleep(3)
        g.screenshot(path=f'{OUT}/5-guest-recording-muted.png')
        g.click('#tb-cam-switch'); time.sleep(0.4)
        g.screenshot(path=f'{OUT}/6-guest-cam-menu-locked.png')
        g.keyboard.press('Escape')
        prod.screenshot(path=f'{OUT}/7-dashboard-recording.png', full_page=True)
        ph.screenshot(path=f'{OUT}/11-phone-recording.png')
        print('phone recording:', ph.evaluate('window.__camop.isRecording()'))
        g.set_viewport_size({'width': 390, 'height': 800}); time.sleep(0.5)
        g.screenshot(path=f'{OUT}/8-guest-narrow.png')
        b.close()
finally:
    app.terminate(); moto.terminate()
print('shots in', OUT)

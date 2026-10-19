"""Browser tests for the constant-frame-rate recorder (guest/cfr.js).

Runs the real recorder in headless Chromium against a test source whose picture flashes
in step with a beep scheduled on the audio clock, then checks the file:
  - every frame lands on the exact 29.97 (or 23.976) grid, with no gaps,
  - audio and video are the same length,
  - flashes line up with beeps from start to end (no drift),
  - it decodes cleanly.
Headless Chromium has no H.264/AAC encoder, so these runs use VP9 + Opus through the same
code path; tests/cfr_mac_probe.md covers H.264 + AAC on a real Mac.

Usage: python3 tests/cfr_browser_test.py [--long]
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
from functools import partial

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8766
OUT = tempfile.mkdtemp(prefix='camop-cfr-')
saved = []
results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  ({detail})' if detail else ''), flush=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        path = os.path.join(OUT, f'take{len(saved) + 1}.mp4')
        with open(path, 'wb') as f:
            f.write(self.rfile.read(n))
        saved.append(path)
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')


def probe(path):
    j = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                                   'stream=codec_type,codec_name,avg_frame_rate,r_frame_rate,nb_frames,duration,time_base,width,height',
                                   '-of', 'json', path], capture_output=True, text=True).stdout)
    v = next(s for s in j['streams'] if s['codec_type'] == 'video')
    a = next((s for s in j['streams'] if s['codec_type'] == 'audio'), None)
    pts = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts',
                          '-of', 'csv=p=0', path], capture_output=True, text=True).stdout.split()
    pts = sorted(int(x) for x in pts if x.strip().lstrip('-').isdigit())
    dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'], capture_output=True, text=True).stderr
    errors = [l for l in dec.splitlines() if l.strip()]
    return v, a, pts, errors


def luma_series(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', 'scale=16:9,format=gray', '-f', 'rawvideo', '-'],
                         capture_output=True).stdout
    return [sum(raw[i:i + 144]) / 144 for i in range(0, len(raw) - 143, 144)]


def audio_env(path):
    import array
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
                         capture_output=True).stdout
    a = array.array('f'); a.frombytes(raw[:len(raw) // 4 * 4])
    return a


def onsets_video(luma, dur):
    out, prev = [], False
    for i, y in enumerate(luma):
        on = y > 150
        if on and not prev:
            out.append(i * dur)
        prev = on
    return out


def onsets_audio(a, sr=48000):
    out, quiet, i, n = [], sr, 0, len(a)
    while i < n:
        x = abs(a[i])
        if x > 0.2:
            if quiet >= sr // 2:
                out.append(i / sr); quiet = 0; i += sr // 4; continue
            quiet = 0
        elif x < 0.05:
            quiet += 1
        i += 1
    return out


def analyze(label, path, fps_num, fps_den, seconds, expect_stall=False):
    v, a, pts, errors = probe(path)
    tb_num, tb_den = (int(x) for x in v['time_base'].split('/'))
    tick = fps_den * tb_den / (fps_num * tb_num)  # one frame in time_base units
    deltas = [b - a_ for a_, b in zip(pts, pts[1:])]
    off_grid = [d for d in deltas if abs(d - tick) > 0.5]
    vdur = float(v.get('duration') or 0); adur = float(a.get('duration') or 0) if a else 0
    check(f'{label}: frame rate is exactly {fps_num}/{fps_den}', v['avg_frame_rate'] == f'{fps_num}/{fps_den}' and v['r_frame_rate'] == f'{fps_num}/{fps_den}',
          f"avg={v['avg_frame_rate']} r={v['r_frame_rate']} timebase={v['time_base']}")
    check(f'{label}: every frame exactly one frame apart (constant frame rate)', len(pts) > 10 and not off_grid,
          f'{len(pts)} frames, {len(off_grid)} off-grid, tick={tick:g}')
    check(f'{label}: audio and video the same length (within a frame)', a is not None and abs(vdur - adur) <= 1.5 * fps_den / fps_num,
          f'video {vdur:.3f}s audio {adur:.3f}s')
    check(f'{label}: length matches the take', abs(vdur - seconds) < 1.0, f'{vdur:.2f}s for a {seconds}s take')
    check(f'{label}: decodes cleanly', not errors, '; '.join(errors[:2]))
    dur = fps_den / fps_num
    vo = onsets_video(luma_series(path), dur)
    ao = onsets_audio(audio_env(path))
    pairs = []
    for t in vo:
        near = min(ao, key=lambda x: abs(x - t)) if ao else None
        if near is not None and abs(near - t) < 0.4:
            pairs.append(t - near)
    if pairs:
        first, last = pairs[:3], pairs[-3:]
        drift = (sum(last) / len(last)) - (sum(first) / len(first))
        spread = max(pairs) - min(pairs)
        mean = sum(pairs) / len(pairs)
        check(f'{label}: picture and sound in sync (flash vs beep)', abs(mean) <= 0.050 and spread <= 0.070,
              f'{len(pairs)} beeps, offset mean {mean * 1000:+.0f} ms, spread {spread * 1000:.0f} ms')
        check(f'{label}: no drift from start to end', abs(drift) <= 0.034, f'{drift * 1000:+.0f} ms')
    else:
        check(f'{label}: picture and sound in sync (flash vs beep)', False, f'video onsets {len(vo)}, audio onsets {len(ao)}')
    return v, a


def main():
    long_run = '--long' in sys.argv
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), partial(Handler, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                                    '--autoplay-policy=no-user-gesture-required'])
        pg = b.new_context(permissions=['camera', 'microphone']).new_page()
        console = []
        pg.on('console', lambda m: console.append(m.text))
        pg.goto(f'http://127.0.0.1:{PORT}/tests/cfr_harness.html')

        def take(label, seconds, fps='29.97', **opts):
            r = pg.evaluate('o => recordTest(o)', {'seconds': seconds, 'fps': fps, **opts})
            if not r.get('ok'):
                check(f'{label}: recorder ran', False, json.dumps(r)); return None
            check(f'{label}: recorder ran without errors', not r['errors'], '; '.join(r['errors'][:2]))
            print('   stats:', json.dumps(r['stats']))
            return r, saved[-1]

        num, den = (30000, 1001)
        t = take('30 fps source', 20)
        if t: analyze('30 fps source', t[1], num, den, 20)

        t = take('Jittery 24 fps source (like the test file)', 20, srcOpts={'alternate': [37.2, 43.2]})
        if t:
            analyze('Jittery 24 fps source', t[1], num, den, 20)
            check('Jittery 24 fps source: repeats counted', t[0]['stats']['dups'] > 50, f"dups={t[0]['stats']['dups']}")

        t = take('1.5 s camera stall', 20, srcOpts={'stallAt': 8.0, 'stallFor': 1.5})
        if t:
            analyze('1.5 s camera stall', t[1], num, den, 20)
            check('1.5 s camera stall: reported', 1400 <= t[0]['stats']['maxStallMs'] <= 1700, f"maxStallMs={t[0]['stats']['maxStallMs']}")

        t = take('23.976 grid', 15, fps='23.976')
        if t: analyze('23.976 grid', t[1], 24000, 1001, 15)

        t = take('Fake camera device', 10, source='camera')
        if t:
            v, a, pts, errors = probe(t[1])
            check('Fake camera device: constant 29.97 and decodes', v['avg_frame_rate'] == '30000/1001' and not errors and a is not None,
                  f"{v['avg_frame_rate']} {len(pts)} frames")
            check('Track still live after the recorder stops', t[0]['trackState'] == 'live', t[0]['trackState'])

        if long_run:
            t = take('10 minute take', 600, srcOpts={'width': 640, 'height': 360}, videoBps=1e6)
            if t: analyze('10 minute take', t[1], num, den, 600)
        b.close()
    srv.shutdown()
    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed. Files: {OUT}')
    if failed:
        print('console tail:', console[-10:])
        sys.exit(1)


if __name__ == '__main__':
    main()

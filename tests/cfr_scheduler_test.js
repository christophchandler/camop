// Unit tests for the constant-frame-rate scheduler in guest/cfr.js.
// Simulates cameras that run fast, slow, jittery or stall, and microphones whose clock
// drifts, then checks every output slot is filled exactly once and shows the right frame.
// Usage: node tests/cfr_scheduler_test.js
const { FrameScheduler, RATES } = require('../guest/cfr.js');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

// Deterministic jitter
let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function run({ fps = '29.97', camFps = 30, seconds = 60, jitterMs = 0, alternate = null, stalls = [], driftPpm = 0, firstFrameDelayMs = 0 }) {
  const rate = RATES[fps];
  const dur = 1e6 * rate.den / rate.num;
  const emitted = []; // [slot, frameTs]
  let released = 0, live = 0;
  const s = new FrameScheduler(dur, (h, n) => emitted.push([n, h.ts]), () => { released++; live--; });
  const origin = 1_000_000_000;
  s.setOrigin(origin);
  // Camera frames
  const frames = [];
  let t = origin + firstFrameDelayMs * 1000, i = 0;
  const end = origin + seconds * 1e6;
  // The camera runs until the moment the last audio sample was captured.
  const camEnd = end + (end - origin) * driftPpm / 1e6;
  while (t < camEnd) {
    const inStall = stalls.some(([a, b]) => t >= origin + a * 1e6 && t < origin + b * 1e6);
    if (!inStall) frames.push(t + (jitterMs ? (rand() - 0.5) * 2 * jitterMs * 1000 : 0));
    const step = alternate ? alternate[i % alternate.length] * 1000 : 1e6 / camFps;
    t += step; i++;
  }
  // Drift: the microphone's sample clock runs driftPpm slow, so capture time moves ahead of sample time.
  const offsetAt = ts => (ts - origin) * driftPpm / 1e6;
  for (const ts of frames.sort((a, b) => a - b)) {
    s.setOffset(offsetAt(ts));
    live++;
    s.push({ ts }, ts);
  }
  const endTs = end + offsetAt(end);
  s.setOffset(offsetAt(end));
  const n = s.finish(endTs);

  // Every slot 0..n-1 exactly once, in order
  const contiguous = emitted.every(([slot], k) => slot === k) && emitted.length === n;
  // How far each slot's frame is from the moment it should show (ignoring stall windows)
  let maxEarly = 0, maxLate = 0;
  for (const [slot, ts] of emitted) {
    const target = origin + slot * dur + offsetAt(origin + slot * dur);
    if (stalls.some(([a, b]) => target >= origin + a * 1e6 - dur && target < origin + b * 1e6 + 2 * dur)) continue;
    if (slot * dur < firstFrameDelayMs * 1000 + dur) continue;
    const err = ts - target; // negative: an older frame than ideal
    maxEarly = Math.min(maxEarly, err); maxLate = Math.max(maxLate, err);
  }
  return { n, dur, emitted, contiguous, maxEarlyMs: maxEarly / 1000, maxLateMs: maxLate / 1000, s, expectN: Math.ceil((endTs - origin - offsetAt(end)) / dur), leaked: live };
}

// 1. 30 fps camera on a 29.97 grid for an hour: about one dropped frame every 33 s, nothing else
{
  const r = run({ camFps: 30, seconds: 3600 });
  check('1h, 30 fps camera -> 29.97: every slot filled once', r.contiguous && Math.abs(r.n - r.expectN) <= 1, `${r.n} slots, expected ~${r.expectN}`);
  check('1h, 30 fps camera -> 29.97: frames within one frame of their moment', r.maxEarlyMs >= -r.dur / 1000 && r.maxLateMs <= r.dur / 2000 + 0.01, `${r.maxEarlyMs.toFixed(1)}..${r.maxLateMs.toFixed(1)} ms`);
  check('1h, 30 fps camera -> 29.97: ~108 frames dropped, none repeated', Math.abs(r.s.drops - 108) <= 3 && r.s.dups <= 1, `drops=${r.s.drops} dups=${r.s.dups}`);
  check('No frames leaked (all released)', r.leaked === 0, `${r.leaked} held`);
}
// 2. The camera from the glitching test file: ~24 fps with frames alternating 37 and 43 ms
{
  const r = run({ alternate: [37.2, 43.2], seconds: 60 });
  check('Jittery 24 fps camera -> 29.97: every slot filled once', r.contiguous && Math.abs(r.n - r.expectN) <= 1, `${r.n} slots`);
  check('Jittery 24 fps camera -> 29.97: repeats fill the gaps (~20%)', r.s.dups > 0.15 * r.n && r.s.dups < 0.25 * r.n, `dups=${r.s.dups}`);
  check('Jittery 24 fps camera -> 29.97: never shows a frame from the future', r.maxLateMs <= r.dur / 2000 + 0.01, `${r.maxLateMs.toFixed(1)} ms`);
}
// 3. A 1.5 s camera stall like the one at 0:08.8 in the test file
{
  const r = run({ camFps: 30, seconds: 30, stalls: [[8.79, 10.28]] });
  check('1.5 s camera stall: no missing slots', r.contiguous && Math.abs(r.n - r.expectN) <= 1, `${r.n} slots`);
  check('1.5 s camera stall: held picture, ~45 repeats', r.s.dups >= 40 && r.s.dups <= 50, `dups=${r.s.dups}`);
  check('1.5 s camera stall: reported as the longest gap', r.s.maxGapUs / 1000 >= 1490 && r.s.maxGapUs / 1000 <= 1560, `${Math.round(r.s.maxGapUs / 1000)} ms`);
}
// 4. Microphone clock 200 ppm slow over an hour (0.72 s of drift): video follows the audio
{
  const r = run({ camFps: 30, seconds: 3600, driftPpm: 200 });
  check('1h, mic drifting 200 ppm: every slot filled once', r.contiguous, `${r.n} slots`);
  check('1h, mic drifting 200 ppm: picture stays within a frame of the sound', r.maxEarlyMs >= -r.dur / 1000 - 0.5 && r.maxLateMs <= r.dur / 2000 + 0.5, `${r.maxEarlyMs.toFixed(1)}..${r.maxLateMs.toFixed(1)} ms`);
}
// 5. Microphone clock 200 ppm fast
{
  const r = run({ camFps: 30, seconds: 3600, driftPpm: -200 });
  check('1h, mic drifting -200 ppm: picture stays within a frame of the sound', r.contiguous && r.maxEarlyMs >= -r.dur / 1000 - 0.5 && r.maxLateMs <= r.dur / 2000 + 0.5, `${r.maxEarlyMs.toFixed(1)}..${r.maxLateMs.toFixed(1)} ms`);
}
// 6. 30 fps camera on a 23.976 grid
{
  const r = run({ fps: '23.976', camFps: 30, seconds: 120 });
  check('30 fps camera -> 23.976: every slot filled once', r.contiguous && Math.abs(r.n - r.expectN) <= 1, `${r.n} slots, expected ~${r.expectN}`);
  check('30 fps camera -> 23.976: about one frame in five dropped', Math.abs(r.s.drops / r.n - 0.25) < 0.02, `drops=${r.s.drops}`);
}
// 7. Camera starts 300 ms after the microphone: the opening slots show the first frame
{
  const r = run({ camFps: 30, seconds: 10, firstFrameDelayMs: 300 });
  check('Late first frame: opening slots filled with it', r.contiguous && r.emitted[0][0] === 0 && r.emitted[8][1] === r.emitted[0][1], `${r.n} slots`);
}
// 8. Random jitter of +-8 ms on a 30 fps camera
{
  const r = run({ camFps: 30, seconds: 300, jitterMs: 8 });
  check('Jitter +-8 ms: every slot filled once, frames within a frame', r.contiguous && r.maxEarlyMs >= -r.dur / 1000 - 8 && r.maxLateMs <= r.dur / 2000 + 0.01, `${r.maxEarlyMs.toFixed(1)}..${r.maxLateMs.toFixed(1)} ms dups=${r.s.dups} drops=${r.s.drops}`);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

// CamOp constant-frame-rate recorder.
//
// Browsers' MediaRecorder stamps each frame when the camera happens to deliver it, so
// its files are variable frame rate and judder in editors. This recorder encodes on the
// guest's own GPU (WebCodecs) and places every frame on an exact 29.97 or 23.976 grid,
// repeating the previous frame when the camera is late and skipping extras when it is
// early. Audio is the master clock: each video slot shows the frame captured when that
// moment of audio was captured, so picture and sound stay together however the camera
// and microphone clocks drift over a long take.
//
// Output is fragmented MP4 (H.264 + AAC), streamed out piece by piece like MediaRecorder
// output, so a crash mid-take still leaves a playable file up to the last fragment.
(function (root) {
  'use strict';

  const RATES = {
    '29.97': { num: 30000, den: 1001 },
    '23.976': { num: 24000, den: 1001 }
  };

  // ------------------------------------------------------------------
  // Frame scheduler: pure logic, unit-tested in Node (tests/cfr_scheduler_test.js).
  // Slot n covers capture times [slotTime(n) - dur/2, slotTime(n) + dur/2) and shows the
  // newest camera frame captured before the end of that window.
  // ------------------------------------------------------------------
  class FrameScheduler {
    constructor(frameDurUs, emit, release) {
      this.dur = frameDurUs;
      this.emit = emit;          // (handle, slotIndex) => void
      this.release = release;    // (handle) => void
      this.origin = null;        // capture time of file time 0
      this.offset = 0;           // capture clock minus audio sample clock (us)
      this.n = 0;                // next slot to fill
      this.last = null; this.lastUsed = false;
      this.prevTs = null;
      this.dups = 0; this.drops = 0; this.maxGapUs = 0; this.frames = 0;
    }
    setOrigin(t) { if (this.origin === null) this.origin = t; }
    setOffset(us) { this.offset = us; }
    slotEnd(n) { return this.origin + n * this.dur + this.offset + this.dur / 2; }
    _fillBefore(ts) {
      while (this.last !== null && this.slotEnd(this.n) <= ts) {
        if (this.lastUsed) this.dups++;
        this.emit(this.last, this.n++);
        this.lastUsed = true;
      }
    }
    // keepLast: the encoder is behind, so hold the current frame instead of taking a new one.
    push(handle, ts, keepLast = false) {
      if (this.origin === null) this.origin = ts;
      this.frames++;
      if (this.prevTs !== null) this.maxGapUs = Math.max(this.maxGapUs, ts - this.prevTs);
      this.prevTs = ts;
      if (this.last === null) {
        // First frame: any slots that ended before it arrived show it too.
        if (this.slotEnd(this.n) <= ts) {
          this.last = handle; this.lastUsed = false;
          while (this.slotEnd(this.n) <= ts) { if (this.lastUsed) this.dups++; this.emit(handle, this.n++); this.lastUsed = true; }
          return;
        }
        this.last = handle; this.lastUsed = false;
        return;
      }
      this._fillBefore(ts);
      if (keepLast) { this.release(handle); this.drops++; return; }
      if (!this.lastUsed && this.n > 0) this.drops++;
      this.release(this.last);
      this.last = handle; this.lastUsed = false;
    }
    // Fill every slot that starts before endTs, then let go of the last frame.
    finish(endTs) {
      if (this.last !== null) {
        while (this.origin + this.n * this.dur + this.offset < endTs) {
          if (this.lastUsed) this.dups++;
          this.emit(this.last, this.n++);
          this.lastUsed = true;
        }
        this.release(this.last);
        this.last = null;
      }
      return this.n;
    }
  }

  // ------------------------------------------------------------------
  // Browser recorder
  // ------------------------------------------------------------------
  const isChromium = () => {
    try {
      const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
      return brands.some(b => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand));
    } catch { return false; }
  };

  function videoCodecFor(kind, w, h) {
    if (kind === 'vp9') return 'vp09.00.41.08';
    return (w > 1920 || h > 1080) ? 'avc1.640033' : 'avc1.640028'; // High 5.1 for 4K, High 4.0 for 1080p
  }

  async function encoderConfigs({ width, height, videoBps, audioBps, rate, sampleRate, channels, kind = 'avc', audioKind = 'aac' }) {
    if (!('VideoEncoder' in root) || !('AudioEncoder' in root) || !('MediaStreamTrackProcessor' in root) || !('VideoFrame' in root)) return null;
    const base = {
      codec: videoCodecFor(kind, width, height), width, height, bitrate: videoBps,
      framerate: rate.num / rate.den, latencyMode: 'quality',
      ...(kind === 'avc' ? { avc: { format: 'avc' } } : {})
    };
    let video = null;
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      const cfg = { ...base, hardwareAcceleration };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) { video = cfg; break; } } catch {}
    }
    if (!video) return null;
    let audio = null;
    if (channels) {
      const cfg = { codec: audioKind === 'opus' ? 'opus' : 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: audioBps };
      try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) audio = cfg; } catch {}
      if (!audio) return null; // no AAC encoder here (e.g. Chrome on Linux): use MediaRecorder instead
    }
    return { video, audio };
  }

  // Can this computer encode this size faster than real time? A detailed moving test
  // picture, 30 frames; the result is kept for the page so each take doesn't pay for it.
  const benchCache = {};
  async function encodeSpeed(cfg) {
    const key = `${cfg.codec}|${cfg.width}x${cfg.height}|${cfg.hardwareAcceleration}`;
    if (key in benchCache) return benchCache[key];
    const N = 30;
    let failed = false;
    const enc = new VideoEncoder({ output: () => {}, error: () => { failed = true; } });
    try {
      enc.configure(cfg);
      const tex = new OffscreenCanvas(256, 256), tx = tex.getContext('2d');
      const img = tx.createImageData(256, 256);
      for (let i = 0; i < img.data.length; i++) img.data[i] = (i % 4 === 3) ? 255 : (Math.random() * 255) | 0;
      tx.putImageData(img, 0, 0);
      const cv = new OffscreenCanvas(cfg.width, cfg.height), cx = cv.getContext('2d');
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        cx.fillStyle = cx.createPattern(tex, 'repeat');
        cx.setTransform(1, 0, 0, 1, i * 7, i * 3);
        cx.fillRect(-i * 7, -i * 3, cfg.width, cfg.height);
        const f = new VideoFrame(cv, { timestamp: Math.round(i * 33366.67) });
        enc.encode(f, { keyFrame: i === 0 }); f.close();
      }
      await enc.flush();
      benchCache[key] = failed ? 0 : N / ((performance.now() - t0) / 1000);
    } catch { benchCache[key] = 0; }
    try { enc.close(); } catch {}
    return benchCache[key];
  }

  // AAC (and to a lesser degree Opus) encoders add silent "priming" samples at the start,
  // so a player hears everything a little late. Measure it once: encode a click at a
  // known moment, decode it back, and see where it lands. The picture is then shifted by
  // the same amount so the two line up in any editor.
  const delayCache = {};
  async function codecDelayUs(cfg) {
    const key = `${cfg.codec}|${cfg.sampleRate}|${cfg.numberOfChannels}`;
    if (key in delayCache) return delayCache[key];
    let result = 0;
    try {
      const sr = cfg.sampleRate, ch = cfg.numberOfChannels, block = 1024, clickAt = Math.round(0.25 * sr);
      const chunks = []; let decoderConfig = null;
      const enc = new AudioEncoder({ output: (c, meta) => { chunks.push(c); if (meta && meta.decoderConfig) decoderConfig = meta.decoderConfig; }, error: () => {} });
      enc.configure(cfg);
      for (let start = 0; start < sr; start += block) {
        const buf = new Float32Array(block * ch);
        for (let c = 0; c < ch; c++) for (let i = 0; i < block; i++) { const n = start + i; if (n >= clickAt && n < clickAt + 48) buf[c * block + i] = (n % 2 ? -0.9 : 0.9); }
        const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: block, numberOfChannels: ch, timestamp: Math.round(start * 1e6 / sr), data: buf });
        enc.encode(ad); ad.close();
      }
      await enc.flush(); enc.close();
      let found = null;
      const dec = new AudioDecoder({
        output: ad => {
          if (found === null) {
            const x = new Float32Array(ad.numberOfFrames);
            ad.copyTo(x, { planeIndex: 0, format: 'f32-planar' });
            for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.3) { found = ad.timestamp + i * 1e6 / ad.sampleRate; break; }
          }
          ad.close();
        }, error: () => {}
      });
      dec.configure(decoderConfig || { codec: cfg.codec, sampleRate: sr, numberOfChannels: ch });
      for (const c of chunks) dec.decode(c);
      await dec.flush(); dec.close();
      if (found !== null) result = Math.max(0, Math.min(150000, found - clickAt * 1e6 / sr));
    } catch { result = 0; }
    delayCache[key] = result;
    return result;
  }

  // Copy an AudioData with a new timestamp (all planes, any sample format).
  function retime(ad, timestamp) {
    const planes = /planar/.test(ad.format) ? ad.numberOfChannels : 1;
    let total = 0; const sizes = [];
    for (let i = 0; i < planes; i++) { const s = ad.allocationSize({ planeIndex: i }); sizes.push(s); total += s; }
    const buf = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < planes; i++) { ad.copyTo(buf.subarray(off, off + sizes[i]), { planeIndex: i }); off += sizes[i]; }
    return new AudioData({ format: ad.format, sampleRate: ad.sampleRate, numberOfFrames: ad.numberOfFrames, numberOfChannels: ad.numberOfChannels, timestamp, data: buf });
  }
  function silence(format, sampleRate, channels, frames, timestamp) {
    const bytesPer = /s16/.test(format) ? 2 : /u8/.test(format) ? 1 : 4;
    return new AudioData({ format, sampleRate, numberOfFrames: frames, numberOfChannels: channels, timestamp, data: new Uint8Array(frames * channels * bytesPer) });
  }

  class CfrRecorder {
    // opts: { fps: '29.97'|'23.976', videoBps, audioBps, kind: 'avc'|'vp9', audioKind: 'aac'|'opus',
    //         onData(Uint8Array), onError(err) }
    constructor(stream, opts) {
      this.stream = stream; this.opts = opts;
      this.rate = RATES[opts.fps] || RATES['29.97'];
      this.dur = 1e6 * this.rate.den / this.rate.num;
      this.keyEvery = Math.round(2 * this.rate.num / this.rate.den); // a keyframe every 2 s
      this.written = 0; this.failed = false; this.stopped = false;
      this.samples = 0; this.drift = 0; this.silenceUs = 0; this.queueMax = 0;
      // Camera and microphone timestamps normally share the system clock. Some sources
      // (a canvas, a virtual camera) count from their own zero; we detect that from arrival
      // times and move the picture onto the audio clock.
      this.vArr = Infinity; this.aArr = Infinity; this.vSeen = 0; this.aSeen = 0; this.vShift = 0;
    }

    static isChromium() { return isChromium(); }

    // Everything is negotiated before the first frame, so a guest whose browser can't do
    // this falls back to MediaRecorder before anything is recorded.
    async prepare() {
      const vt = this.stream.getVideoTracks()[0];
      const at = this.stream.getAudioTracks()[0] || null;
      if (!vt) throw new Error('No camera track');
      this.vt = vt; this.at = at;
      const s = vt.getSettings();
      this.width = Math.max(2, Math.floor((s.width || 1280) / 2) * 2);
      this.height = Math.max(2, Math.floor((s.height || 720) / 2) * 2);
      // Audio format comes from the first buffer the microphone delivers.
      if (at) {
        this.aReader = new MediaStreamTrackProcessor({ track: at }).readable.getReader();
        const first = await Promise.race([this.aReader.read(), new Promise(r => setTimeout(() => r(null), 3000))]);
        if (!first || first.done) throw new Error('Microphone delivered no audio');
        this.firstAudio = first.value;
        this.sampleRate = first.value.sampleRate; this.channels = first.value.numberOfChannels; this.aFormat = first.value.format;
      }
      this.cfg = await encoderConfigs({
        width: this.width, height: this.height, videoBps: this.opts.videoBps, audioBps: this.opts.audioBps || 192000,
        rate: this.rate, sampleRate: this.sampleRate, channels: at ? this.channels : 0,
        kind: this.opts.kind || 'avc', audioKind: this.opts.audioKind || 'aac'
      });
      // A computer that can't encode this size in real time would fall further and further
      // behind; MediaRecorder copes by dropping frames, so it gets the job instead.
      if (this.cfg && this.opts.benchmark !== false) {
        this.encodeFps = await encodeSpeed(this.cfg.video);
        if (this.encodeFps < 1.25 * this.rate.num / this.rate.den) this.cfg = null;
      }
      if (this.cfg && this.cfg.audio) this.audioDelay = await codecDelayUs(this.cfg.audio);
      if (!this.cfg) {
        if (this.firstAudio) { this.firstAudio.close(); this.firstAudio = null; }
        if (this.aReader) { try { this.aReader.cancel(); } catch {} } // detach from the mic; the track itself keeps running
        return false;
      }
      return true;
    }

    start() {
      const M = root.Mp4Muxer;
      const kind = this.opts.kind || 'avc';
      this.muxer = new M.Muxer({
        target: new M.StreamTarget({ onData: (data, position) => this._onData(data, position) }),
        video: { codec: kind, width: this.width, height: this.height, frameRate: this.rate.num }, // timescale 30000 / 24000: exact 1001-tick frames
        ...(this.cfg.audio ? { audio: { codec: (this.opts.audioKind || 'aac') === 'opus' ? 'opus' : 'aac', numberOfChannels: this.channels, sampleRate: this.sampleRate } } : {}),
        fastStart: 'fragmented',
        firstTimestampBehavior: 'offset',
        minFragmentDuration: 1.5
      });
      this.venc = new VideoEncoder({
        output: (chunk, meta) => { try { this.muxer.addVideoChunk(chunk, meta); } catch (e) { this._fail(e); } },
        error: e => this._fail(e)
      });
      this.venc.configure(this.cfg.video);
      if (this.cfg.audio) {
        this.aenc = new AudioEncoder({
          output: (chunk, meta) => { try { this.muxer.addAudioChunk(chunk, meta); } catch (e) { this._fail(e); } },
          error: e => this._fail(e)
        });
        this.aenc.configure(this.cfg.audio);
      }
      this.scaler = null;
      this.sched = new FrameScheduler(this.dur, (frame, n) => this._encodeSlot(frame, n), frame => { try { frame.close(); } catch {} });
      if (this.firstAudio) {
        this.aOrigin = this.firstAudio.timestamp;
        // Audio plays back audioDelay late, so the picture starts that much earlier too.
        this.sched.setOrigin(this.aOrigin - (this.audioDelay || 0));
        this._audio(this.firstAudio); this.firstAudio = null;
        this.aLoop = this._audioLoop();
      }
      this.vReader = new MediaStreamTrackProcessor({ track: this.vt }).readable.getReader();
      this.vLoop = this._videoLoop();
      return this;
    }

    _onData(data, position) {
      if (position !== this.written) {
        // Fragmented output is append-only; anything else would corrupt the file on disk.
        this._fail(new Error(`Muxer wrote out of order at ${position}, expected ${this.written}`));
        return;
      }
      this.written += data.byteLength;
      try { this.opts.onData(data); } catch (e) { this._fail(e); }
    }

    _fail(err) {
      if (this.failed) return;
      this.failed = true;
      try { this.opts.onError && this.opts.onError(err); } catch {}
    }

    _encodeSlot(frame, n) {
      if (this.failed || this.venc.state !== 'configured') return;
      let src = frame;
      if (frame.displayWidth !== this.width || frame.displayHeight !== this.height) {
        // The camera changed size mid-take: scale to the file's size rather than break it.
        if (!this.scaler) { this.scaler = new OffscreenCanvas(this.width, this.height); this.sctx = this.scaler.getContext('2d'); }
        this.sctx.drawImage(frame, 0, 0, this.width, this.height);
        src = this.scaler;
      }
      const out = new VideoFrame(src, { timestamp: Math.round(n * this.dur), duration: Math.round(this.dur) });
      try { this.venc.encode(out, { keyFrame: n % this.keyEvery === 0 }); }
      catch (e) { this._fail(e); }
      finally { out.close(); }
      this.queueMax = Math.max(this.queueMax, this.venc.encodeQueueSize);
      // More than three seconds behind and growing: hand over to MediaRecorder for the rest of the take.
      if (this.venc.encodeQueueSize > 3 * this.rate.num / this.rate.den) this._fail(new Error('the computer could not keep up with the encode'));
    }

    async _videoLoop() {
      for (;;) {
        let r;
        try { r = await this.vReader.read(); } catch { break; }
        if (r.done) break;
        const f = r.value;
        if (this.stopped || this.failed) { f.close(); continue; }
        if (this.vSeen++ < 30) {
          this.vArr = Math.min(this.vArr, performance.now() * 1000 - f.timestamp);
          if (this.cfg.audio && this.aArr !== Infinity) {
            const d = this.vArr - this.aArr;
            this.vShift = Math.abs(d) > 1e6 ? d : 0;
          }
        }
        // A slow encoder holds frames; past two seconds' worth, keep the current picture.
        const busy = this.venc.encodeQueueSize > 60;
        this.sched.push(f, f.timestamp + this.vShift, busy);
      }
    }

    _audio(ad) {
      const sr = ad.sampleRate;
      if (this.aSeen++ < 30) this.aArr = Math.min(this.aArr, performance.now() * 1000 - ad.timestamp);
      if (this.aOrigin === undefined) this.aOrigin = ad.timestamp;
      const expected = this.aOrigin + this.samples * 1e6 / sr;
      const raw = ad.timestamp - expected; // capture time ahead of sample count
      if (raw - this.drift > 60000) {
        // The microphone skipped (a glitch or a busy computer): fill the hole with silence
        // so the audio stays on real time and the picture doesn't jump to catch up.
        let gap = Math.round((raw - this.drift) * sr / 1e6);
        this.silenceUs += (raw - this.drift);
        while (gap > 0) {
          const n = Math.min(gap, 4800);
          const z = silence(ad.format, sr, ad.numberOfChannels, n, Math.round(this.samples * 1e6 / sr));
          this.aenc.encode(z); z.close();
          this.samples += n; gap -= n;
        }
      } else {
        this.drift += 0.05 * (raw - this.drift);
      }
      this.sched.setOffset(this.drift);
      const copy = retime(ad, Math.round(this.samples * 1e6 / sr));
      try { this.aenc.encode(copy); } catch (e) { this._fail(e); }
      copy.close();
      this.samples += ad.numberOfFrames;
      ad.close();
    }

    async _audioLoop() {
      for (;;) {
        let r;
        try { r = await this.aReader.read(); } catch { break; }
        if (r.done) break;
        if (this.stopped || this.failed) { r.value.close(); continue; }
        this._audio(r.value);
      }
    }

    stats() {
      const s = this.sched || {};
      return {
        mode: 'cfr', fps: this.opts.fps, frames: s.n || 0, cameraFrames: s.frames || 0,
        dups: s.dups || 0, drops: s.drops || 0, maxStallMs: Math.round((s.maxGapUs || 0) / 1000),
        queueMax: this.queueMax, driftMs: Math.round(this.drift / 100) / 10, silenceMs: Math.round(this.silenceUs / 1000),
        codec: this.cfg && this.cfg.video.codec, hw: this.cfg && this.cfg.video.hardwareAcceleration,
        encodeFps: this.encodeFps ? Math.round(this.encodeFps) : null,
        audioDelayMs: Math.round((this.audioDelay || 0) / 100) / 10
      };
    }

    async stop() {
      if (this.stopped) return this.stats();
      this.stopped = true;
      try { await this.vReader.cancel(); } catch {}
      if (this.aReader) { try { await this.aReader.cancel(); } catch {} }
      await Promise.allSettled([this.vLoop, this.aLoop].filter(Boolean));
      // Video runs to the end of the audio so both tracks are the same length.
      const endTs = this.cfg.audio ? this.aOrigin + this.samples * 1e6 / this.sampleRate + this.drift - (this.audioDelay || 0)
        : (this.sched.prevTs || 0) + this.dur;
      if (!this.failed) this.sched.finish(endTs);
      try { if (this.venc.state === 'configured') await this.venc.flush(); } catch (e) { this._fail(e); }
      try { if (this.aenc && this.aenc.state === 'configured') await this.aenc.flush(); } catch (e) { this._fail(e); }
      try { this.muxer.finalize(); } catch (e) { this._fail(e); }
      try { this.venc.close(); } catch {}
      try { this.aenc && this.aenc.close(); } catch {}
      return this.stats();
    }
  }

  const api = { RATES, FrameScheduler, CfrRecorder, encoderConfigs, isChromium };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CamOpCFR = api;
})(typeof window !== 'undefined' ? window : globalThis);

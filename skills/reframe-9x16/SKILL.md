---
name: reframe-9x16
description: Reframe a Frame.io share (or a folder of videos) from 16:9 to 9:16 (1080x1920) with intelligent, AutoFlip-style subject tracking. Input a Frame.io link or a folder; output a job folder with source/, output/, work/ (per-shot crop keyframes as JSON), qc/ (contact sheets + report) and a Telegram report. Use when asked to reframe, verticalise, make 9:16 / vertical / social cuts of Frame.io footage.
---

# reframe-9x16

One message in, a finished 9:16 batch out. This skill wraps `scripts/reframe_9x16.py`.

## Run

```bash
# Frame.io share link (f.io short link, app.frame.io/reviews|presentations, next.frame.io/share)
python3 skills/reframe-9x16/scripts/reframe_9x16.py "https://f.io/XXXX" --date 2026-09-08

# a folder of videos (or an existing job's source/ folder to re-process)
python3 skills/reframe-9x16/scripts/reframe_9x16.py ~/Jobs/reframe-9x16/2026-09-08-share/source
python3 skills/reframe-9x16/scripts/reframe_9x16.py ~/Downloads/clips --name "client-share" --date 2026-09-08

# useful options
--device mps          # YOLO on Apple Silicon GPU (default cpu)
--only NAME           # only clips whose name contains NAME (repeatable) - for fixes by clip name
--stride 3            # analyse every 3rd frame (0 = auto: 2 for <=30 fps, 3 above)
--job-root DIR        # default ~/Jobs/reframe-9x16
--job-dir DIR         # use an exact job folder
--no-telegram         # write qc/report.md only
```

Job folder: `~/Jobs/reframe-9x16/<date>-<share name>/{source,output,work,qc}/`.

Exit code 2 with a `NEEDS INPUT FROM YOU:` block means the Frame.io originals could not be fetched;
the block says exactly what is needed (enable downloads / token / drop files into `source/`). Stop and
relay it verbatim; never scrape the streaming proxy.

## Setup (once)

```bash
pip install -r skills/reframe-9x16/requirements.txt   # opencv, ultralytics, scenedetect, requests, lap
brew install ffmpeg                                     # ffmpeg + ffprobe on PATH
pip install playwright && playwright install chromium   # optional: share-page download fallback
```

Environment (all optional):

| var | purpose |
|---|---|
| `FRAMEIO_TOKEN` | Frame.io API token (v4 Adobe IMS bearer or legacy v2 developer token). Tried first. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | send the batch report + contact sheets to Telegram |
| `R9X16_MODELS` | model cache dir (default `~/.cache/reframe-9x16/models`); weights download on first run |

Models: `yolov8n.pt` (people + 80 COCO objects, ByteTrack ids), YuNet 2023mar (faces + eye landmarks),
PP-OCRv3 DB (text overlays). All CPU-friendly; `--device mps` speeds YOLO up on Apple Silicon.

## What it does

1. **Acquire**: resolve the share, list assets recursively, latest version of each version stack, videos
   only, original/highest-quality download, original filenames. Order: API with token -> share page
   Download button (Playwright) -> stop and ask.
2. **Shots**: PySceneDetect (AdaptiveDetector). Every shot is analysed and planned independently; the crop
   resets hard on every cut, never eased across one.
3. **Analyse** on a 640 px proxy, every 2nd/3rd frame: YOLO track + YuNet faces + text detector +
   motion/saliency map. Focal point priority: face-tracked person > person body > group (if all heads fit
   in 80% of the window, else hold on the dominant person; runner-up within 20% => `ambiguous_subjects`)
   > tracked object (YOLO) > dominant moving blob > colour/spectral saliency. A centre crop is only
   produced when the measured focal point sits at centre (noted as verified in the sidecar and report).
4. **Camera** (one mode per shot, preference order): `LOCKED` (5th-95th percentile of the subject stays inside
   the middle 60% of the window) > `PAN` (hold; after 0.25 s outside the deadband ease over >=1 s to a new
   hold, speed capped at 0.6 window-widths/s; accepted if <=0.6 moves/s and subject inside >=93% of frames)
   > `TRACK` (0.3 s median + 0.25 s EMA follow, speed capped). Always clamped to the source (active
   picture if letterboxed). Full source height; punch-in only for tiny subjects (cap 1.15x HD, 2x 4K).
5. **Render**: ffmpeg `sendcmd` drives `crop` per frame (VFR-safe, uses real packet pts), lanczos scale to
   1080x1920, libx264 High CRF 18 yuv420p faststart, audio stream-copied, no rate/colour changes.
   Vertical/square sources are remuxed through unchanged and flagged.
6. **QC**: `qc/<clip>_contact.jpg` (6 evenly spaced frames: source with crop box over output),
   `work/<clip>.reframe.json` (per-shot mode, zoom, crop size, keyframes with `x,y` and normalised centre
   `cx_norm,cy_norm` + easing, evidence), `qc/report.md` + `report.json`, Telegram message + photos.

## Flags

`low_confidence`, `text_cut_off`, `subject_leaves_frame`, `ambiguous_subjects`, `punch_in_used`,
`letterboxed_source`, `pillarboxed_source`, `already_vertical`, `already_square`, `failed`.

## Rebuilding in Resolve / Premiere

`work/<clip>.reframe.json` -> `shots[].keyframes[]`: `frame`, `time`, crop top-left `x,y` in source px,
crop size `crop.w x crop.h`, `cx_norm/cy_norm` (0..1 crop centre) and `ease` (`hold`, `smoothstep`,
`linear`). Position keyframes on a 9:16 timeline: pan = `(cx_norm - 0.5) * source_width`, scale =
`1920 / crop.h`.

## Fix loop

Reply with fixes by clip name; re-run with `--only <clip>` after adjusting (e.g. `--stride`, or force a
different device). For a manual override edit the sidecar keyframes and re-render with the same ffmpeg
command (see `render.py`).

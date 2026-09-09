"""ffprobe / decoding helpers."""
from __future__ import annotations
import json
import re
import subprocess
from collections import Counter
from dataclasses import dataclass, asdict
from fractions import Fraction
from pathlib import Path
from typing import Iterator, Optional

import cv2
import numpy as np

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mxf", ".mkv", ".avi", ".webm", ".mts", ".m2ts", ".prores", ".braw", ".r3d"}


@dataclass
class Probe:
    path: str
    width: int          # effective (after display rotation)
    height: int
    coded_width: int
    coded_height: int
    rotation: int
    fps: float
    fps_str: str
    nb_frames: int
    duration: float
    codec: str
    pix_fmt: str
    has_audio: bool
    audio_codec: str
    container: str
    active: tuple       # (x, y, w, h) active picture after letterbox detection
    letterboxed: bool
    pillarboxed: bool

    def to_dict(self):
        return asdict(self)


def _run(cmd) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def is_video_file(p: Path) -> bool:
    if p.suffix.lower() not in VIDEO_EXT:
        return False
    try:
        out = _run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,disposition", "-of", "json", str(p)])
        streams = json.loads(out).get("streams", [])
        for s in streams:
            if s.get("codec_type") == "video" and s.get("codec_name") not in ("mjpeg", "png", "bmp", "gif") \
                    and not (s.get("disposition", {}).get("attached_pic")):
                return True
        return False
    except subprocess.CalledProcessError:
        return False


def probe(path: Path) -> Probe:
    out = _run(["ffprobe", "-v", "error", "-show_entries",
                "format=format_name,duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,pix_fmt,side_data_list:stream_tags=rotate",
                "-of", "json", str(path)])
    info = json.loads(out)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(round(float(sd["rotation"])))
    if not rot and v.get("tags", {}).get("rotate"):
        rot = int(v["tags"]["rotate"])
    rot = rot % 360
    cw, ch = int(v["width"]), int(v["height"])
    w, h = (ch, cw) if rot in (90, 270) else (cw, ch)
    fps_str = v.get("avg_frame_rate") or v.get("r_frame_rate")
    if fps_str in (None, "0/0"):
        fps_str = v.get("r_frame_rate", "25/1")
    fps = float(Fraction(fps_str))
    dur = float(v.get("duration") or info["format"].get("duration") or 0)
    nb = int(v.get("nb_frames") or 0) or int(round(dur * fps))
    active, lb, pb = detect_letterbox(path, w, h, dur)
    return Probe(str(path), w, h, cw, ch, rot, fps, fps_str, nb, dur, v.get("codec_name", ""), v.get("pix_fmt", ""),
                 a is not None, (a or {}).get("codec_name", ""), info["format"].get("format_name", ""), active, lb, pb)


def detect_letterbox(path: Path, w: int, h: int, dur: float):
    """Sample cropdetect at a few positions; treat as letterboxed if the active picture is
    noticeably shorter than the frame (black bars top/bottom) in most samples."""
    if dur <= 0:
        return (0, 0, w, h), False, False
    samples = [dur * f for f in (0.1, 0.3, 0.5, 0.7, 0.9)]
    found = Counter()
    for t in samples:
        try:
            r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{t:.3f}", "-i", str(path), "-t", "1.0",
                                "-vf", "cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"],
                               capture_output=True, text=True, timeout=120)
            m = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", r.stderr)
            if m:
                found[tuple(int(x) for x in m[-1])] += 1
        except Exception:
            pass
    if not found:
        return (0, 0, w, h), False, False
    (cw, ch, cx, cy), n = found.most_common(1)[0]
    if n < 3 or cw <= 0 or ch <= 0:
        return (0, 0, w, h), False, False
    lb = ch < 0.92 * h and cw >= 0.92 * w
    pb = cw < 0.92 * w and ch >= 0.92 * h
    if lb or pb:
        return (cx, cy, cw, ch), lb, pb
    return (0, 0, w, h), False, False


def frame_times(path: Path, fps: float, nb_frames: int) -> np.ndarray:
    """Presentation times of every video frame (handles VFR). Falls back to i/fps."""
    try:
        out = _run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,dts_time",
                    "-of", "csv=p=0", str(path)])
        ts = []
        for line in out.splitlines():
            parts = line.strip().split(",")
            for p in parts:
                if p and p != "N/A":
                    ts.append(float(p))
                    break
        ts = np.array(sorted(ts))
        if len(ts) >= max(1, nb_frames - 2):
            ts = ts - ts[0]
            return ts
    except Exception:
        pass
    return np.arange(nb_frames) / fps


def iter_frames(path: Path, stride: int, proxy_w: int, start: int = 0, end: Optional[int] = None) -> Iterator[tuple]:
    """Yield (frame_index, proxy_bgr, scale) for every `stride`-th frame in [start, end)."""
    cap = cv2.VideoCapture(str(path))
    if start:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start)
    i = start
    while True:
        if end is not None and i >= end:
            break
        ok = cap.grab()
        if not ok:
            break
        if (i - start) % stride == 0:
            ok, fr = cap.retrieve()
            if not ok:
                break
            scale = proxy_w / fr.shape[1]
            if scale < 1:
                fr = cv2.resize(fr, (proxy_w, int(round(fr.shape[0] * scale))), interpolation=cv2.INTER_AREA)
            else:
                scale = 1.0
            yield i, fr, scale
        i += 1
    cap.release()


def count_frames(path: Path) -> int:
    cap = cv2.VideoCapture(str(path))
    n = 0
    while cap.grab():
        n += 1
    cap.release()
    return n


def read_frame(path: Path, index: int):
    cap = cv2.VideoCapture(str(path))
    cap.set(cv2.CAP_PROP_POS_FRAMES, index)
    ok, fr = cap.read()
    cap.release()
    return fr if ok else None

"""ffmpeg render: per-frame crop driven by sendcmd, lanczos scale to 1080x1920, audio stream-copied."""
from __future__ import annotations
import json
import shutil
import subprocess
from pathlib import Path
from typing import List

import numpy as np

from .media import probe as ffprobe


def write_sendcmd(path: Path, shots: List[tuple], times: np.ndarray, fps: float) -> int:
    """shots: list of (start_frame, ShotCamera). Emits a command whenever the crop changes."""
    lines = []
    last = None
    half = 0.5 / fps
    for a, cam in shots:
        for i in range(len(cam.x)):
            f = a + i
            vals = (cam.crop_w, cam.crop_h, int(cam.x[i]), int(cam.y[i]))
            if i == 0 or vals != last:
                t = float(times[f]) if f < len(times) else f / fps
                t = max(0.0, t - half)
                lines.append(f"{t:.5f} crop w {vals[0]}, crop h {vals[1]}, crop x {vals[2]}, crop y {vals[3]};")
                last = vals
    path.write_text("\n".join(lines) + "\n")
    return len(lines)


def render(src: Path, dst: Path, cmd_file: Path, first: tuple, cfg, has_audio: bool) -> None:
    cw, ch, x0, y0 = first
    vf = (f"[0:v]sendcmd=f={cmd_file.name},crop=w={cw}:h={ch}:x={x0}:y={y0},"
          f"scale={cfg.out_w}:{cfg.out_h}:flags=lanczos,setsar=1,format=yuv420p[v]")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-nostats", "-loglevel", "error", "-i", str(src),
           "-filter_complex", vf, "-map", "[v]"]
    if has_audio:
        cmd += ["-map", "0:a", "-c:a", "copy"]
    cmd += ["-c:v", "libx264", "-profile:v", "high", "-crf", str(cfg.crf), "-preset", cfg.preset,
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-map_metadata", "0", str(dst)]
    r = subprocess.run(cmd, cwd=str(cmd_file.parent), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {r.stderr[-2000:]}")


def copy_through(src: Path, dst_stem: Path, pr) -> Path:
    """Vertical / square sources: pass through unchanged (remux to mp4 when possible)."""
    remuxable = pr.codec in ("h264", "hevc", "av1") and pr.audio_codec in ("", "aac", "mp3", "ac3", "eac3", "alac")
    if remuxable:
        dst = dst_stem.with_suffix(".mp4")
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src), "-map", "0:v:0"]
        if pr.has_audio:
            cmd += ["-map", "0:a"]
        cmd += ["-c", "copy", "-movflags", "+faststart", str(dst)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            return dst
    dst = dst_stem.with_suffix(src.suffix)
    shutil.copy2(src, dst)
    return dst


def verify(dst: Path) -> dict:
    p = ffprobe(dst)
    return dict(width=p.width, height=p.height, fps=round(p.fps, 3), duration=round(p.duration, 3),
                codec=p.codec, pix_fmt=p.pix_fmt, audio=p.audio_codec or None, nb_frames=p.nb_frames)

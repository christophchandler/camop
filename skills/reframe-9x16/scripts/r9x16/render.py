"""ffmpeg render. Sub-pixel-accurate crop in two stages, driven per frame by sendcmd:
  format=yuv444p -> crop@c1 (integer, crop_w+2 wide) -> scale@sc lanczos (2 src px of margin)
  -> crop@c2 (1080x1920, offset = fractional remainder in output px) -> yuv420p
Scale size follows the shot (scale@sc accepts w/h commands), so every shot maps crop_w x crop_h to exactly
1080x1920 (no stretch). Audio is stream-copied."""
from __future__ import annotations
import shutil
import subprocess
from pathlib import Path
from typing import List

import numpy as np

from .media import probe as ffprobe


def plan_commands(shots: List[tuple], times: np.ndarray, fps: float, probe, cfg) -> tuple:
    """Per-frame sendcmd lines. Returns (lines, first) where first = (c1w, c1h, c1x, c1y, sw, sh, c2x, c2y).
    Stage 1 crops an integer window padded by 2 source px (where the source has room), stage 2 scales it so
    the padded window maps to exactly out_w/out_h * (pad ratio), stage 3 crops out_w x out_h at the
    fractional remainder converted to output px. Net: crop positions accurate to one output pixel."""
    ax, ay, aw, ah = probe.active
    lines = []
    last = None
    first = None
    half = 0.5 / fps
    for a, cam in shots:
        pad_x = 2 if cam.crop_w + 2 <= aw else 0
        pad_y = 2 if cam.crop_h + 2 <= ah else 0
        c1w, c1h = cam.crop_w + pad_x, cam.crop_h + pad_y
        sw = int(round(cfg.out_w * c1w / cam.crop_w))
        sh = int(round(cfg.out_h * c1h / cam.crop_h))
        kx, ky = sw / c1w, sh / c1h
        max_x, max_y = ax + aw - c1w, ay + ah - c1h
        for i in range(len(cam.x)):
            f = a + i
            X = float(np.clip(cam.x[i], ax, max_x))
            Y = float(np.clip(cam.y[i], ay, max_y))
            c1x = int(np.floor(X))
            c2x = max(0, min(sw - cfg.out_w, int(round((X - c1x) * kx))))
            if pad_y:
                c1y = int(np.floor(Y))
                c2y = max(0, min(sh - cfg.out_h, int(round((Y - c1y) * ky))))
            else:
                c1y, c2y = int(round(Y)), 0
            vals = (c1w, c1h, c1x, c1y, sw, sh, c2x, c2y)
            if first is None:
                first = vals
            if i == 0 or vals != last:
                t = float(times[f]) if f < len(times) else f / fps
                t = max(0.0, t - half)
                lines.append(f"{t:.5f} crop@c1 w {c1w}, crop@c1 h {c1h}, scale@sc w {sw}, scale@sc h {sh}, "
                             f"crop@c1 x {c1x}, crop@c1 y {c1y}, crop@c2 x {c2x}, crop@c2 y {c2y};")
                last = vals
    return lines, first


def write_sendcmd(path: Path, shots: List[tuple], times: np.ndarray, fps: float, probe, cfg) -> tuple:
    lines, first = plan_commands(shots, times, fps, probe, cfg)
    path.write_text("\n".join(lines) + "\n")
    return len(lines), first


def render(src: Path, dst: Path, cmd_file: Path, first: tuple, cfg, has_audio: bool) -> None:
    c1w, c1h, c1x, c1y, sw, sh, c2x, c2y = first
    vf = (f"[0:v]sendcmd=f={cmd_file.name},format=yuv444p,"
          f"crop@c1=w={c1w}:h={c1h}:x={c1x}:y={c1y}:exact=1,"
          f"scale@sc=w={sw}:h={sh}:flags=lanczos,"
          f"crop@c2=w={cfg.out_w}:h={cfg.out_h}:x={c2x}:y={c2y}:exact=1,setsar=1,format=yuv420p[v]")
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

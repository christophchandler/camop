#!/usr/bin/env python3
"""Quick self-test of the camera planner on synthetic subject trajectories (no video needed)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
from r9x16.config import Config
from r9x16.camera import plan_axis

cfg = Config()
fps, W, cw = 30.0, 1920, 1080 * 9 // 16   # 607 px window on a 1080p source
lo, hi = cw / 2, W - cw / 2
n = int(10 * fps)
t = np.arange(n) / fps
dead = cfg.deadband * cw
ok = True

def check(name, tgt, want):
    global ok
    tgt = np.clip(tgt, lo, hi)
    p = plan_axis(tgt, np.ones(n, bool), fps, dead, cw, lo, hi, cfg, "x")
    v = np.diff(p.pos)
    jitter = float(np.mean(np.abs(np.diff(v)))) if len(v) > 2 else 0.0
    good = p.mode == want and p.pos.min() >= lo - 1e-6 and p.pos.max() <= hi + 1e-6
    print(f"{name:<34} -> {p.mode:<6} (want {want}) moves={p.moves} inside={p.inside_ratio:.2f} max|v|={np.abs(v).max():.1f}px/f accel={jitter:.2f} {'OK' if good else 'FAIL'}")
    ok &= good

check("still subject + 5px noise", 900 + np.random.default_rng(0).normal(0, 5, n), "LOCKED")
check("small wander within deadband", 900 + 120 * np.sin(t), "LOCKED")
check("slow drift 60px/s", 500 + 60 * t, "PAN")
check("step move at 4s", np.where(t < 4, 500, 1300), "PAN")
check("fast oscillation 1.5Hz +-500px", 960 + 500 * np.sin(2 * np.pi * 1.5 * t), "TRACK")
check("walk across 250px/s", 200 + 250 * t, "TRACK")
check("at frame edge (clamp)", np.full(n, 10.0), "LOCKED")
print("ALL OK" if ok else "FAILURES")
sys.exit(0 if ok else 1)

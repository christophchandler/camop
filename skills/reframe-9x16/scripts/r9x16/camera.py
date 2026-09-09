"""AutoFlip-style camera planner. One mode per shot: LOCKED > PAN > TRACK. Hard reset on cuts."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import List

import numpy as np

from .analyze import ShotAnalysis

MODE_RANK = {"LOCKED": 0, "PAN": 1, "TRACK": 2}


@dataclass
class AxisPlan:
    mode: str
    pos: np.ndarray            # per-frame crop centre along this axis (float px)
    keyframes: List[dict]      # frame, value, ease
    moves: int = 0
    inside_ratio: float = 1.0


@dataclass
class ShotCamera:
    mode: str
    zoom: float
    crop_w: int
    crop_h: int
    x: np.ndarray              # per-frame crop left (float px, sub-pixel)
    y: np.ndarray              # per-frame crop top (float px)
    keyframes: List[dict]
    moves: int
    inside_ratio: float
    flags: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)


def _even(v: float) -> int:
    return int(round(v / 2.0)) * 2


def _smootherstep(u):
    """Ken Perlin's C2 ease: zero velocity AND zero acceleration at both ends (no visible kick)."""
    u = np.clip(u, 0.0, 1.0)
    return u * u * u * (u * (u * 6 - 15) + 10)


def _gauss_smooth(v: np.ndarray, sigma_frames: float) -> np.ndarray:
    """Non-causal Gaussian smoothing (we have the whole shot, so no lag)."""
    if sigma_frames < 0.5 or len(v) < 3:
        return v.copy()
    r = int(np.ceil(3 * sigma_frames))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_frames) ** 2)
    k /= k.sum()
    pad = np.pad(v, r, mode="edge")
    return np.convolve(pad, k, mode="valid")


def plan_axis(tgt: np.ndarray, sampled_mask: np.ndarray, fps: float, dead: float, win: float,
              lo: float, hi: float, cfg, name: str) -> AxisPlan:
    """tgt: desired crop centre per frame (already clamped to [lo, hi]). dead: deadband half-width (px).
    win: window size along this axis (px)."""
    n = len(tgt)
    if hi <= lo:  # no freedom on this axis
        c = np.full(n, (lo + hi) / 2)
        return AxisPlan("LOCKED", c, [dict(frame=0, value=float(c[0]), ease="hold")])
    s = tgt[sampled_mask] if sampled_mask.any() else tgt
    p5, p95 = np.percentile(s, [5, 95])
    # ---- LOCKED: one fixed crop keeps the subject inside the deadband ------------------------
    if p95 - p5 <= 2 * dead:
        c0 = float(np.clip((p5 + p95) / 2, lo, hi))
        c = np.full(n, c0)
        inside = float(np.mean(np.abs(s - c0) <= 0.45 * win))
        return AxisPlan("LOCKED", c, [dict(frame=0, value=c0, ease="hold")], 0, inside)
    # ---- PAN: hold, then ease to a new hold when the subject drifts out of the deadband ---------
    hyst = max(1, int(round(cfg.hysteresis_s * fps)))
    look = max(1, int(round(0.5 * fps)))
    max_speed = cfg.max_pan_speed * win  # px/s
    c = np.zeros(n)
    cur = float(np.clip(np.median(tgt[:look]), lo, hi))
    moving = False
    m0 = m1 = 0
    c0 = c1 = cur
    outside = 0
    moves = []
    for i in range(n):
        if moving:
            u = (i - m0) / max(1, (m1 - m0))
            cur = c0 + (c1 - c0) * float(_smootherstep(u))
            if i >= m1:
                moving = False
                cur = c1
        else:
            err = tgt[i] - cur
            outside = outside + 1 if abs(err) > dead else 0
            if outside >= hyst:
                dest = float(np.clip(np.median(tgt[i:i + look]), lo, hi))
                dist = abs(dest - cur)
                dur = max(cfg.ease_s, dist / max_speed)
                m0, m1 = i, i + max(2, int(round(dur * fps)))
                c0, c1 = cur, dest
                moving = True
                outside = 0
                moves.append((m0, m1, c0, c1))
        c[i] = cur
    # accept PAN when the subject stays inside the window while we hold, we are not moving most of the
    # time (that would be a staircase: TRACK is smoother), and moves are rare
    in_move = np.zeros(n, bool)
    for (m_a, m_b, _, _) in moves:
        in_move[m_a:min(n, m_b)] = True
    hold_mask = sampled_mask & ~in_move
    inside = float(np.mean(np.abs(tgt - c)[hold_mask] <= 0.45 * win)) if hold_mask.any() else 1.0
    moving_frac = float(in_move.mean())
    moves_per_s = len(moves) / max(1e-6, n / fps)
    # sustained wide movement (subject keeps travelling for >3 s at >15% window/s) reads better as TRACK
    k1 = max(1, int(round(fps)))
    vel = np.abs(np.gradient(tgt)) * fps
    vel = np.convolve(vel, np.ones(k1) / k1, mode="same")
    fast = vel > 0.15 * win
    longest = 0
    run = 0
    for f_ in fast:
        run = run + 1 if f_ else 0
        longest = max(longest, run)
    sustained = longest > 3 * fps
    if inside >= 0.9 and moving_frac <= 0.4 and moves_per_s <= 0.6 and not sustained:
        kf = [dict(frame=0, value=float(c[0]), ease="hold")]
        for (a, b, v0, v1) in moves:
            kf.append(dict(frame=int(a), value=float(v0), ease="smootherstep"))
            kf.append(dict(frame=int(min(b, n - 1)), value=float(v1), ease="hold"))
        return AxisPlan("PAN", c, kf, len(moves), inside)
    # ---- TRACK: continuous smoothed follow for fast / wide movement -------------------------------
    # non-causal Gaussian (sigma ~0.35 s) kills detector jitter and hunting without lag; then a speed
    # cap; then a light second pass so the cap never leaves a velocity kink; then clamp.
    dt = 1.0 / fps
    c = _gauss_smooth(tgt, cfg.track_sigma_s * fps)
    vmax = cfg.max_track_speed * win * dt
    for i in range(1, n):
        step = float(np.clip(c[i] - c[i - 1], -vmax, vmax))
        c[i] = c[i - 1] + step
    c = _gauss_smooth(c, 0.4 * cfg.track_sigma_s * fps)
    c = np.clip(c, lo, hi)
    inside = float(np.mean(np.abs(tgt - c)[sampled_mask] <= 0.45 * win)) if sampled_mask.any() else 1.0
    stride = max(1, int(np.diff(np.where(sampled_mask)[0]).min()) if sampled_mask.sum() > 1 else 1)
    kf = [dict(frame=int(i), value=float(c[i]), ease="linear") for i in range(0, n, stride)]
    if kf[-1]["frame"] != n - 1:
        kf.append(dict(frame=n - 1, value=float(c[-1]), ease="linear"))
    return AxisPlan("TRACK", c, kf, 0, inside)


def plan_shot(sa: ShotAnalysis, cfg, probe, times) -> ShotCamera:
    a, b = sa.start, sa.end
    n = b - a
    fps = probe.fps
    ax, ay, aw, ah = probe.active
    flags = list(sa.flags)
    notes = list(sa.notes)

    # ---- zoom (punch-in) only for tiny subjects, per-shot constant ---------------------------
    cap = cfg.zoom_cap_4k if probe.height >= 2000 else cfg.zoom_cap_hd
    zoom = 1.0
    cls = sa.focal_class
    if sa.subject_size > 0 and not cls.startswith("group"):
        if cls.startswith("person"):
            if sa.subject_size < cfg.tiny_face_frac * ah:
                zoom = cfg.target_face_frac * ah / sa.subject_size
        elif cls.startswith("object") or cls == "motion_subject":
            if sa.subject_size < 0.12 * ah:
                zoom = 0.2 * ah / sa.subject_size
    zoom = float(min(cap, zoom))
    if zoom < 1.05:
        zoom = 1.0
    zoom = round(zoom, 2)
    crop_h = _even(ah / zoom)
    crop_w = _even(crop_h * 9 / 16)
    if crop_w > aw:
        crop_w = _even(aw)
        crop_h = _even(crop_w * 16 / 9)
    if zoom > 1.0:
        flags.append("punch_in_used")
        notes.append(f"subject small ({sa.subject_size:.0f}px); punched in {zoom:.2f}x (cap {cap:.2f})")

    # ---- desired crop centres --------------------------------------------------------------
    lo_x, hi_x = ax + crop_w / 2, ax + aw - crop_w / 2
    lo_y, hi_y = ay + crop_h / 2, ay + ah - crop_h / 2
    tx = np.clip(sa.tx, lo_x, hi_x)
    ty = np.clip(sa.ty - sa.anchor_frac * crop_h + crop_h / 2, lo_y, hi_y)
    sampled = sa.tconf > 0
    px = plan_axis(tx, sampled, fps, cfg.deadband * crop_w, crop_w, lo_x, hi_x, cfg, "x")
    if hi_y - lo_y > 2:
        py = plan_axis(ty, sampled, fps, cfg.deadband * crop_h, crop_h, lo_y, hi_y, cfg, "y")
    else:
        py = AxisPlan("LOCKED", np.full(n, (lo_y + hi_y) / 2), [dict(frame=0, value=float((lo_y + hi_y) / 2), ease="hold")])
    mode = px.mode if MODE_RANK[px.mode] >= MODE_RANK[py.mode] else py.mode
    x = np.clip(px.pos - crop_w / 2, ax, ax + aw - crop_w).astype(float)
    y = np.clip(py.pos - crop_h / 2, ay, ay + ah - crop_h).astype(float)

    # ---- keyframes (union of both axes) -------------------------------------------------------
    kf_frames = sorted({k["frame"] for k in px.keyframes} | {k["frame"] for k in py.keyframes})
    ease_x = {k["frame"]: k["ease"] for k in px.keyframes}
    ease_y = {k["frame"]: k["ease"] for k in py.keyframes}
    keyframes = []
    for f in kf_frames:
        ease = ease_x.get(f) or ease_y.get(f) or "linear"
        t = float(times[a + f]) if a + f < len(times) else (a + f) / fps
        keyframes.append(dict(frame=int(a + f), time=round(t, 5), x=round(float(x[f]), 2), y=round(float(y[f]), 2),
                              cx_norm=round((x[f] + crop_w / 2) / probe.width, 5),
                              cy_norm=round((y[f] + crop_h / 2) / probe.height, 5), ease=ease))

    inside = min(px.inside_ratio, py.inside_ratio)
    if inside < 0.9:
        flags.append("subject_leaves_frame")
        notes.append(f"subject outside the crop window for {100 * (1 - inside):.0f}% of sampled frames")
    if mode == "LOCKED" and abs((x[0] + crop_w / 2) - (ax + aw / 2)) < 0.02 * aw:
        notes.append("crop is centred: verified by analysis (focal point sits at frame centre), not assumed")
    # ---- text safety ----------------------------------------------------------------------------
    cut_notes = []
    for tb in sa.text_boxes:
        if (tb[2] - tb[0]) < 0.05 * probe.width or (tb[3] - tb[1]) < 0.015 * probe.height:
            continue
        x1 = x + 0
        x2 = x + crop_w
        cut = np.mean(((tb[0] < x1) & (x1 < tb[2])) | ((tb[0] < x2) & (x2 < tb[2])))
        gone = np.mean((tb[2] <= x1) | (tb[0] >= x2))
        if cut > 0.2 or gone > 0.2:
            cut_notes.append("text at x=%d..%d y=%d..%d %s (%.0f%% of frames)" %
                             (tb[0], tb[2], tb[1], tb[3], "cut" if cut >= gone else "outside crop", 100 * max(cut, gone)))
    if cut_notes:
        flags.append("text_cut_off")
        notes.extend(cut_notes)
    if sa.confidence < 0.6 and "low_confidence" not in flags:
        flags.append("low_confidence")
    return ShotCamera(mode, zoom, crop_w, crop_h, x, y, keyframes, px.moves + py.moves, inside,
                      sorted(set(flags)), notes)

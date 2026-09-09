"""Per-shot analysis on a downscaled proxy: who/what is the focal point, and where is it each frame."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np

from .media import iter_frames


@dataclass
class ShotAnalysis:
    start: int
    end: int
    sampled: List[int]
    focal_class: str = "none"
    confidence: float = 0.0
    subject: dict = field(default_factory=dict)
    # per-frame arrays over [start, end): anchor x/y in source px, and confidence (0 = no evidence)
    tx: np.ndarray = None
    ty: np.ndarray = None
    tconf: np.ndarray = None
    anchor_frac: float = 0.5          # where the anchor sits vertically inside a punched-in crop
    subject_size: float = 0.0         # median subject height (px) for zoom decisions
    text_boxes: List[list] = field(default_factory=list)
    flags: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    evidence: dict = field(default_factory=dict)


def _iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def _scale_box(b, k):
    return [v / k for v in b]


def analyze_shot(det, cfg, path, probe, shot, stride, times) -> ShotAnalysis:
    a, b = shot
    W, H = probe.width, probe.height
    fps = probe.fps
    n = b - a
    det.reset_tracker()
    records = []
    last_text_t = -1e9
    last_text = []
    text_samples = []
    for fi, frame, k in iter_frames(path, stride, cfg.proxy_w, a, b):
        t = times[fi] if fi < len(times) else fi / fps
        objs = det.track(frame)
        faces = det.faces(frame)
        if t - last_text_t >= cfg.text_every_s:
            last_text = det.text_boxes(frame)
            text_samples.append([_scale_box(tb, k) for tb in last_text])
            last_text_t = t
        sal = det.saliency(frame, last_text)
        for o in objs:
            o["box"] = _scale_box(o["box"], k)
        for f in faces:
            f["box"] = _scale_box(f["box"], k)
            f["eyes"] = [[e[0] / k, e[1] / k] for e in f["eyes"]]
        for key in ("sal_center", "motion_center"):
            if key in sal:
                sal[key] = [sal[key][0] / k, sal[key][1] / k]
        for key in ("sal_box", "motion_box"):
            if key in sal:
                sal[key] = _scale_box(sal[key], k)
        records.append(dict(f=fi, objs=objs, faces=faces, sal=sal))
    sa = ShotAnalysis(a, b, [r["f"] for r in records])
    if not records:
        sa.focal_class = "none"
        sa.tx = np.full(n, W / 2.0)
        sa.ty = np.full(n, H / 2.0)
        sa.tconf = np.zeros(n)
        sa.flags.append("low_confidence")
        return sa
    sa.text_boxes = _static_text(text_samples)
    _choose_subject(sa, records, cfg, W, H, fps, stride)
    return sa


def _static_text(samples: List[list]) -> List[list]:
    """Text boxes that persist across samples (lower thirds, titles)."""
    if not samples:
        return []
    if len(samples) == 1:
        return samples[0]
    keep = []
    for i, s in enumerate(samples):
        for bx in s:
            hits = sum(1 for j, o in enumerate(samples) if j != i and any(_iou(bx, ob) > 0.4 for ob in o))
            if hits >= 1 and not any(_iou(bx, kb) > 0.6 for kb in keep):
                keep.append(bx)
    return keep


def _head_box(pbox):
    x1, y1, x2, y2 = pbox
    w, h = x2 - x1, y2 - y1
    return [x1 + 0.25 * w, y1, x2 - 0.25 * w, y1 + 0.25 * h]


def _choose_subject(sa: ShotAnalysis, records, cfg, W, H, fps, stride):
    a, b = sa.start, sa.end
    n = b - a
    nsamp = len(records)
    cw = H * 9 / 16  # crop width in source px (no zoom)

    # --- build person tracks (YOLO ids), attach faces --------------------------------------
    tracks: Dict[int, dict] = {}
    next_face_id = -1
    prev_face_only = {}  # id -> box
    for r in records:
        persons = [o for o in r["objs"] if o["name"] == "person"]
        used = set()
        for p in persons:
            tid = p["id"] if p["id"] >= 0 else None
            if tid is None:
                continue
            tr = tracks.setdefault(tid, dict(frames=[], boxes=[], faces={}, kind="person"))
            tr["frames"].append(r["f"])
            tr["boxes"].append(p["box"])
            x1, y1, x2, y2 = p["box"]
            best, bi = None, -1
            for i, f in enumerate(r["faces"]):
                if i in used:
                    continue
                fx, fy = (f["box"][0] + f["box"][2]) / 2, (f["box"][1] + f["box"][3]) / 2
                if x1 <= fx <= x2 and y1 <= fy <= y1 + 0.5 * (y2 - y1):
                    if best is None or f["conf"] > best["conf"]:
                        best, bi = f, i
            if best is not None:
                used.add(bi)
                tr["faces"][r["f"]] = best
        # faces without a person box: tiny IoU tracker
        cur_face_only = {}
        for i, f in enumerate(r["faces"]):
            if i in used:
                continue
            mid, miou = None, 0.3
            for pid, pbox in prev_face_only.items():
                v = _iou(f["box"], pbox)
                if v > miou:
                    mid, miou = pid, v
            if mid is None:
                mid = next_face_id
                next_face_id -= 1
            cur_face_only[mid] = f["box"]
            tr = tracks.setdefault(mid, dict(frames=[], boxes=[], faces={}, kind="face"))
            tr["frames"].append(r["f"])
            fx1, fy1, fx2, fy2 = f["box"]
            fh = fy2 - fy1
            # synthesize a head+shoulders box for framing
            tr["boxes"].append([fx1 - fh * 0.8, fy1 - fh * 0.5, fx2 + fh * 0.8, fy2 + fh * 2.2])
            tr["faces"][r["f"]] = f
        prev_face_only = cur_face_only

    for tid, tr in tracks.items():
        boxes = np.array(tr["boxes"])
        tr["presence"] = len(tr["frames"]) / nsamp
        tr["med_box"] = np.median(boxes, axis=0).tolist()
        tr["area"] = float(np.median((boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])))
        tr["face_ratio"] = len(tr["faces"]) / max(1, len(tr["frames"]))
        cx = (boxes[:, 0] + boxes[:, 2]) / 2
        tr["centrality"] = float(np.median(1 - np.abs(cx - W / 2) / (W / 2)))
        fconf = [f["conf"] for f in tr["faces"].values()]
        tr["face_conf"] = float(np.mean(fconf)) if fconf else 0.0
        tr["score"] = tr["presence"] * np.sqrt(tr["area"] / (W * H)) * (1 + 1.5 * tr["face_ratio"]) * (0.6 + 0.4 * tr["centrality"])

    stable = {t: tr for t, tr in tracks.items() if tr["presence"] >= 0.3 and tr["area"] >= 0.002 * W * H}
    sa.evidence["tracks"] = {str(t): dict(presence=round(tr["presence"], 2), face_ratio=round(tr["face_ratio"], 2),
                                          score=round(float(tr["score"]), 4), med_box=[round(v) for v in tr["med_box"]])
                             for t, tr in tracks.items()}

    if stable:
        ranked = sorted(stable.items(), key=lambda kv: kv[1]["score"], reverse=True)
        top_id, top = ranked[0]
        chosen_ids = [top_id]
        mode_desc = "single"
        if len(ranked) >= 2:
            # do the people fit together inside the 9:16 window? (test on heads, they matter most)
            heads = []
            for t, tr in ranked:
                fb = [f["box"] for f in tr["faces"].values()]
                heads.append(np.median(np.array(fb), axis=0).tolist() if fb else _head_box(tr["med_box"]))
            heads = np.array(heads)
            union_w = heads[:, 2].max() - heads[:, 0].min()
            if union_w <= 0.8 * cw:
                chosen_ids = [t for t, _ in ranked]
                mode_desc = "group"
            else:
                # dominant person only; note ambiguity when the runner-up is close
                if ranked[1][1]["score"] >= 0.8 * top["score"]:
                    sa.flags.append("ambiguous_subjects")
                    sa.notes.append(f"two comparable subjects (ids {top_id}, {ranked[1][0]}); holding on {top_id}")
                mode_desc = "dominant_of_%d" % len(ranked)
        any_face = any(stable[t]["face_ratio"] > 0.3 for t in chosen_ids)
        sa.focal_class = ("group" if mode_desc == "group" else "person") + ("_face" if any_face else "_body")
        # per-frame anchor = union of chosen subjects' faces (or heads) at each sampled frame
        xs, ys, fs, sizes = [], [], [], []
        for r in records:
            f = r["f"]
            bx = []
            for t in chosen_ids:
                tr = stable[t]
                if f in tr["frames"]:
                    i = tr["frames"].index(f)
                    if f in tr["faces"]:
                        fb = tr["faces"][f]["box"]
                        eyes = tr["faces"][f]["eyes"]
                        ey = (eyes[0][1] + eyes[1][1]) / 2
                        bx.append((fb, ey, fb[3] - fb[1]))
                    else:
                        hb = _head_box(tr["boxes"][i])
                        bx.append((hb, hb[1] + 0.45 * (hb[3] - hb[1]), (hb[3] - hb[1]) * 1.4))
            if bx:
                x1 = min(v[0][0] for v in bx)
                x2 = max(v[0][2] for v in bx)
                xs.append((x1 + x2) / 2)
                ys.append(float(np.mean([v[1] for v in bx])))
                fs.append(f)
                sizes.append(float(np.median([v[2] for v in bx])))
        sa.subject = dict(ids=[int(t) for t in chosen_ids], arrangement=mode_desc,
                          presence=round(float(np.mean([stable[t]["presence"] for t in chosen_ids])), 2))
        sa.subject_size = float(np.median(sizes)) if sizes else 0.0
        sa.anchor_frac = cfg.eye_line
        conf_base = 0.55 + 0.35 * min(1.0, top["presence"]) + (0.1 if any_face else 0.0)
        sa.confidence = round(min(0.98, conf_base * (0.9 if "ambiguous_subjects" in sa.flags else 1.0)), 2)
        _fill_targets(sa, fs, xs, ys, W, H, fps, n, a)
        return

    # --- no people: objects -----------------------------------------------------------------
    otracks: Dict[int, dict] = {}
    for r in records:
        for o in r["objs"]:
            if o["name"] == "person" or o["id"] < 0:
                continue
            tr = otracks.setdefault(o["id"], dict(frames=[], boxes=[], name=o["name"]))
            tr["frames"].append(r["f"])
            tr["boxes"].append(o["box"])
    best, best_score = None, 0.0
    for tid, tr in otracks.items():
        boxes = np.array(tr["boxes"])
        presence = len(tr["frames"]) / nsamp
        area = float(np.median((boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])))
        if presence < 0.3 or area < 0.001 * W * H:
            continue
        cx = (boxes[:, 0] + boxes[:, 2]) / 2
        motion = float(np.std(cx) / W)
        score = presence * np.sqrt(area / (W * H)) * (1 + 3 * motion)
        if score > best_score:
            best, best_score = (tid, tr, presence, boxes), score
    if best is not None:
        tid, tr, presence, boxes = best
        sa.focal_class = f"object:{tr['name']}"
        sa.subject = dict(ids=[int(tid)], name=tr["name"], presence=round(presence, 2))
        xs = ((boxes[:, 0] + boxes[:, 2]) / 2).tolist()
        ys = ((boxes[:, 1] + boxes[:, 3]) / 2).tolist()
        sa.subject_size = float(np.median(boxes[:, 3] - boxes[:, 1]))
        sa.anchor_frac = 0.5
        sa.confidence = round(0.45 + 0.35 * presence, 2)
        _fill_targets(sa, tr["frames"], xs, ys, W, H, fps, n, a)
        return

    # --- no detections: motion blob first, then saliency -------------------------------------
    fs = [r["f"] for r in records]
    motion = np.array([r["sal"]["motion"] for r in records])
    spread = np.array([r["sal"]["spread"] for r in records])
    has_blob = np.array(["motion_center" in r["sal"] for r in records])
    blob_ratio = float(has_blob.mean())
    sal_x = np.array([r["sal"]["sal_center"][0] for r in records])
    sal_y = np.array([r["sal"]["sal_center"][1] for r in records])
    win = max(1, int(round(fps / stride)) | 1)

    def _medfilt(v):
        if len(v) < win:
            return v
        pad = win // 2
        pv = np.pad(v, pad, mode="edge")
        return np.array([np.median(pv[i:i + win]) for i in range(len(v))])

    sa.anchor_frac = 0.5
    if blob_ratio >= 0.6:
        # a coherent moving subject exists in most samples: follow it (bridge the gaps)
        mf = [r["f"] for r in records if "motion_center" in r["sal"]]
        mx = np.array([r["sal"]["motion_center"][0] for r in records if "motion_center" in r["sal"]])
        my = np.array([r["sal"]["motion_center"][1] for r in records if "motion_center" in r["sal"]])
        # reject outlier blobs (noise) with a median filter
        mx, my = _medfilt(mx), _medfilt(my)
        sizes = [r["sal"]["motion_box"][3] - r["sal"]["motion_box"][1] for r in records if "motion_box" in r["sal"]]
        sa.focal_class = "motion_subject"
        sa.subject = dict(kind="motion_blob", blob_ratio=round(blob_ratio, 2), motion=round(float(motion.mean()), 3))
        sa.subject_size = float(np.median(sizes)) if sizes else 0.0
        sa.confidence = round(0.5 + 0.3 * blob_ratio, 2)
        sa.evidence["motion"] = dict(blob_ratio=round(blob_ratio, 2), median_x=round(float(np.median(mx))),
                                     median_y=round(float(np.median(my))))
        if sa.confidence < 0.6:
            sa.flags.append("low_confidence")
        _fill_targets(sa, mf, mx.tolist(), my.tolist(), W, H, fps, n, a)
        return

    sal_x, sal_y = _medfilt(sal_x), _medfilt(sal_y)
    mean_spread = float(spread.mean())
    med_x = float(np.median(sal_x))
    sa.evidence["saliency"] = dict(median_x=round(med_x), median_y=round(float(np.median(sal_y))),
                                   spread=round(mean_spread, 2), motion=round(float(motion.mean()), 3))
    if mean_spread > 0.85:
        # diffuse: no clear compositional subject. Only centre if the mass really is centred.
        if abs(med_x - W / 2) < 0.06 * W:
            sa.focal_class = "center_verified"
            sa.notes.append("saliency mass centred (diffuse scene); centre crop verified by saliency centroid")
            sa.confidence = 0.5
        else:
            sa.focal_class = "saliency"
            sa.confidence = 0.4
            sa.flags.append("low_confidence")
        sa.subject = dict(kind="saliency", spread=round(mean_spread, 2))
        _fill_targets(sa, fs, [med_x] * len(fs), [float(np.median(sal_y))] * len(fs), W, H, fps, n, a)
        return
    sa.focal_class = "saliency"
    sa.subject = dict(kind="saliency", spread=round(mean_spread, 2), motion=round(float(motion.mean()), 3))
    sa.confidence = round(0.45 + 0.25 * (1 - mean_spread), 2)
    if sa.confidence < 0.55:
        sa.flags.append("low_confidence")
    _fill_targets(sa, fs, sal_x.tolist(), sal_y.tolist(), W, H, fps, n, a)


def _fill_targets(sa: ShotAnalysis, frames, xs, ys, W, H, fps, n, a):
    """Interpolate sampled anchors to every frame of the shot; hold at the ends."""
    idx = np.arange(a, a + n)
    if not frames:
        sa.tx = np.full(n, W / 2.0)
        sa.ty = np.full(n, H / 2.0)
        sa.tconf = np.zeros(n)
        sa.flags.append("low_confidence")
        return
    fr = np.array(frames, dtype=float)
    sa.tx = np.interp(idx, fr, np.array(xs, dtype=float))
    sa.ty = np.interp(idx, fr, np.array(ys, dtype=float))
    conf = np.zeros(n)
    # confidence 1 near samples, decaying across gaps
    for f in frames:
        conf[int(f) - a] = 1.0
    sa.tconf = conf
    gaps = np.diff(fr)
    big = gaps[gaps > fps * 1.0]
    lead = fr[0] - a
    tail = (a + n - 1) - fr[-1]
    if len(big) or lead > fps or tail > fps:
        sa.flags.append("subject_leaves_frame")
        sa.notes.append("subject absent for >1 s (gap=%.1fs, lead=%.1fs, tail=%.1fs); crop holds/bridges last known position"
                        % ((big.max() / fps) if len(big) else 0.0, lead / fps, tail / fps))

"""reframe-9x16 command line. Input: a Frame.io share link or a folder of videos. Output: job folder with
source/, output/, work/, qc/ and a batch report (Telegram if configured)."""
from __future__ import annotations
import argparse
import datetime as dt
import json
import re
import shutil
import sys
import time
import traceback
from pathlib import Path

import numpy as np

from . import __version__
from .config import Config
from .models import ensure_models
from .media import probe, frame_times, is_video_file
from .shots import detect_shots
from .detect import Detectors
from .analyze import analyze_shot
from .camera import plan_shot
from .render import write_sendcmd, render, copy_through, verify
from .qc import contact_sheet
from .report import build_report, write_report, send_telegram


def slug(s: str) -> str:
    s = re.sub(r"[^\w\-. ]+", "", s).strip().replace(" ", "-")
    return re.sub(r"-{2,}", "-", s) or "share"


def make_job_dir(root: Path, date: str, name: str) -> Path:
    job = root / f"{date}-{slug(name)}"
    for d in ("source", "output", "work", "qc"):
        (job / d).mkdir(parents=True, exist_ok=True)
    return job


def process_clip(src: Path, job: Path, cfg: Config, det: Detectors, log) -> dict:
    t0 = time.time()
    stem = src.stem
    entry = dict(name=src.name, source=None, output=None, sidecar=None, qc=None, status="failed",
                 shots=[], flags=[], error=None, seconds=0)
    pr = probe(src)
    entry["source"] = dict(width=pr.width, height=pr.height, fps=round(pr.fps, 3), duration=round(pr.duration, 3),
                           codec=pr.codec, audio=pr.audio_codec or None, rotation=pr.rotation,
                           letterboxed=pr.letterboxed, pillarboxed=pr.pillarboxed, active=list(pr.active))
    out_stem = job / "output" / f"{stem}_9x16"
    plan = dict(version=f"reframe-9x16/{__version__}", source=pr.to_dict(), output=None,
                analysis=dict(proxy_width=cfg.proxy_w, stride=None, models=["yolov8n", "yunet-2023mar", "ppocrv3-db"]),
                shots=[], flags=[])
    # ---- vertical / square: copy through ----------------------------------------------------
    if pr.width <= pr.height:
        flag = "already_vertical" if pr.width < pr.height else "already_square"
        dst = copy_through(src, out_stem, pr)
        entry.update(output=str(dst), status="copied", flags=[flag])
        plan["flags"] = [flag]
        plan["output"] = dict(path=str(dst), copied_through=True)
        plan["shots"] = [dict(index=1, start_frame=0, end_frame=pr.nb_frames, start_time=0, end_time=pr.duration,
                              mode="COPY", focal_class="n/a", confidence=1.0, flags=[flag], notes=["source not landscape; copied through unchanged"])]
        sidecar = job / "work" / f"{stem}.reframe.json"
        sidecar.write_text(json.dumps(plan, indent=2))
        entry["sidecar"] = str(sidecar)
        entry["shots"] = plan["shots"]
        sheet = contact_sheet(src, job / "qc" / f"{stem}_contact.jpg", plan, dst, cfg.contact_frames, copy_through=True)
        entry["qc"] = str(sheet)
        entry["verify"] = verify(dst)
        entry["seconds"] = round(time.time() - t0, 1)
        return entry
    # ---- timing / frame count -------------------------------------------------------------------
    times = frame_times(src, pr.fps, pr.nb_frames)
    nb = len(times) if (pr.nb_frames == 0 or abs(len(times) - pr.nb_frames) <= 2) else pr.nb_frames
    pr.nb_frames = nb
    plan["source"]["nb_frames"] = nb
    stride = cfg.stride or (2 if pr.fps <= 31 else 3)
    plan["analysis"]["stride"] = stride
    if pr.letterboxed:
        entry["flags"].append("letterboxed_source")
    if pr.pillarboxed:
        entry["flags"].append("pillarboxed_source")
    # ---- shots ----------------------------------------------------------------------------------
    shots = detect_shots(src, pr.fps, nb, cfg.min_shot_s)
    log(f"  {len(shots)} shot(s), {nb} frames, {pr.width}x{pr.height} @ {pr.fps:.2f}fps, stride {stride}")
    cams = []
    for si, (a, b) in enumerate(shots, 1):
        sa = analyze_shot(det, cfg, src, pr, (a, b), stride, times)
        cam = plan_shot(sa, cfg, pr, times)
        cams.append((a, cam))
        ta = float(times[a]) if a < len(times) else a / pr.fps
        tb = float(times[b - 1]) + 1 / pr.fps if b - 1 < len(times) else b / pr.fps
        shot_rec = dict(index=si, start_frame=a, end_frame=b, start_time=round(ta, 4), end_time=round(tb, 4),
                        mode=cam.mode, focal_class=sa.focal_class, confidence=sa.confidence, subject=sa.subject,
                        zoom=cam.zoom, crop=dict(w=cam.crop_w, h=cam.crop_h), moves=cam.moves,
                        subject_inside_ratio=round(cam.inside_ratio, 3), keyframes=cam.keyframes,
                        text_boxes=[[round(v) for v in tb_] for tb_ in sa.text_boxes],
                        flags=cam.flags, notes=cam.notes, evidence=sa.evidence)
        plan["shots"].append(shot_rec)
        log(f"  shot {si:>2} f{a}-{b} {cam.mode:<6} {sa.focal_class:<14} conf {sa.confidence:.2f} zoom {cam.zoom:.2f}"
            + (" moves %d" % cam.moves if cam.moves else "") + ("  ! " + ", ".join(cam.flags) if cam.flags else ""))
    all_flags = sorted(set(entry["flags"]) | {f for s in plan["shots"] for f in s["flags"]})
    plan["flags"] = all_flags
    entry["flags"] = all_flags
    # ---- sidecar + render -------------------------------------------------------------------------
    dst = out_stem.with_suffix(".mp4")
    plan["output"] = dict(path=str(dst), width=cfg.out_w, height=cfg.out_h, codec="h264 high crf%d" % cfg.crf)
    sidecar = job / "work" / f"{stem}.reframe.json"
    sidecar.write_text(json.dumps(plan, indent=2, default=float))
    cmd_file = job / "work" / f"{slug(stem)}.sendcmd"
    ncmd = write_sendcmd(cmd_file, cams, times, pr.fps)
    first = cams[0][1]
    log(f"  rendering ({ncmd} crop commands) -> {dst.name}")
    render(src, dst, cmd_file, (first.crop_w, first.crop_h, int(first.x[0]), int(first.y[0])), cfg, pr.has_audio)
    entry["verify"] = verify(dst)
    # dense per-frame crop for the QC overlay
    for (a, cam), s in zip(cams, plan["shots"]):
        s["_dense"] = list(zip(cam.x.tolist(), cam.y.tolist()))
    sheet = contact_sheet(src, job / "qc" / f"{stem}_contact.jpg", plan, dst, cfg.contact_frames)
    for s in plan["shots"]:
        s.pop("_dense", None)
    entry.update(output=str(dst), sidecar=str(sidecar), qc=str(sheet), status="rendered",
                 shots=[{k: v for k, v in s.items() if k not in ("keyframes", "evidence", "text_boxes", "notes")} for s in plan["shots"]],
                 seconds=round(time.time() - t0, 1))
    return entry


def main(argv=None):
    ap = argparse.ArgumentParser(prog="reframe-9x16", description=__doc__)
    ap.add_argument("input", help="Frame.io share link (f.io / app.frame.io / next.frame.io) or a folder of videos")
    ap.add_argument("--job-root", default=str(Path.home() / "Jobs" / "reframe-9x16"))
    ap.add_argument("--job-dir", help="use this exact job folder (skips the date/name naming)")
    ap.add_argument("--name", help="job name (defaults to the share name or folder name)")
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--stride", type=int, default=0, help="analyse every Nth frame (0 = auto)")
    ap.add_argument("--proxy-width", type=int, default=640)
    ap.add_argument("--device", default="cpu", help="cpu | mps | cuda (YOLO)")
    ap.add_argument("--only", action="append", help="process only clips whose name contains this (repeatable)")
    ap.add_argument("--no-telegram", action="store_true")
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--preset", default="medium")
    args = ap.parse_args(argv)

    cfg = Config(stride=args.stride, proxy_w=args.proxy_width, device=args.device, crf=args.crf,
                 preset=args.preset, telegram=not args.no_telegram)
    log = lambda m: print(m, file=sys.stderr, flush=True)
    inp = args.input
    root = Path(args.job_root).expanduser()

    # ---- acquire sources -----------------------------------------------------------------------
    notes = []
    if Path(inp).expanduser().exists():
        folder = Path(inp).expanduser().resolve()
        name = args.name or folder.name
        if folder.name == "source" and (folder.parent / "output").exists():
            job = folder.parent
        else:
            job = Path(args.job_dir).expanduser() if args.job_dir else make_job_dir(root, args.date, name)
            for d in ("source", "output", "work", "qc"):
                (job / d).mkdir(parents=True, exist_ok=True)
            if folder != job / "source":
                for f in sorted(folder.iterdir()):
                    if f.is_file() and is_video_file(f) and not (job / "source" / f.name).exists():
                        shutil.copy2(f, job / "source" / f.name)
        sources = sorted(f for f in (job / "source").iterdir() if f.is_file() and is_video_file(f))
    else:
        from .frameio import acquire, NeedsUser
        tmp_job = Path(args.job_dir).expanduser() if args.job_dir else None
        try:
            stage = (tmp_job or root / "_incoming") / "source"
            name, files = acquire(inp, stage, cfg.frameio_token)
        except NeedsUser as e:
            log("\nNEEDS INPUT FROM YOU:\n" + str(e))
            return 2
        name = args.name or name
        job = tmp_job or make_job_dir(root, args.date, name)
        for d in ("source", "output", "work", "qc"):
            (job / d).mkdir(parents=True, exist_ok=True)
        for f in files:
            if f.parent != job / "source":
                shutil.move(str(f), job / "source" / f.name)
        sources = sorted(f for f in (job / "source").iterdir() if f.is_file() and is_video_file(f))
    if args.only:
        sources = [s for s in sources if any(o.lower() in s.name.lower() for o in args.only)]
    if not sources:
        log(f"no video files in {job / 'source'}")
        return 2
    log(f"job: {job}\n{len(sources)} clip(s): " + ", ".join(s.name for s in sources))

    # ---- models ---------------------------------------------------------------------------------
    paths = ensure_models(cfg.models_dir)
    det = Detectors(cfg, paths)

    # ---- process ------------------------------------------------------------------------------
    job_rec = dict(name=name, job_dir=str(job), date=args.date, input=inp, clips=[], notes=notes,
                   started=dt.datetime.now().isoformat(timespec="seconds"))
    for src in sources:
        log(f"\n== {src.name}")
        try:
            entry = process_clip(src, job, cfg, det, log)
        except Exception as e:
            traceback.print_exc()
            entry = dict(name=src.name, status="failed", error=f"{e.__class__.__name__}: {e}", shots=[], flags=["failed"],
                         source=dict(width=0, height=0, fps=0, duration=0))
        job_rec["clips"].append(entry)
        write_report(job_rec, job / "qc")
    job_rec["finished"] = dt.datetime.now().isoformat(timespec="seconds")
    report_path = write_report(job_rec, job / "qc")
    text = build_report(job_rec)
    log("\n" + text)
    if cfg.telegram:
        try:
            msg = send_telegram(text, [c["qc"] for c in job_rec["clips"] if c.get("qc")])
        except Exception as e:
            msg = f"telegram: failed ({e})"
        log(msg)
        notes.append(msg)
        write_report(job_rec, job / "qc")
    log(f"report: {report_path}")
    return 0 if all(c["status"] != "failed" for c in job_rec["clips"]) else 1


if __name__ == "__main__":
    sys.exit(main())

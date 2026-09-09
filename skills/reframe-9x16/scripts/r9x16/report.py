"""Batch report (markdown + json) and optional Telegram delivery."""
from __future__ import annotations
import json
import os
from pathlib import Path

import requests


def _fmt_t(t):
    m, s = divmod(float(t), 60)
    return f"{int(m)}:{s:05.2f}"


def build_report(job: dict) -> str:
    L = [f"REFRAME 9:16 - {job['name']}", f"job: {job['job_dir']}", ""]
    clips = job["clips"]
    n_r = sum(1 for c in clips if c["status"] == "rendered")
    n_c = sum(1 for c in clips if c["status"] == "copied")
    n_f = sum(1 for c in clips if c["status"] == "failed")
    L.append(f"{len(clips)} clip(s): {n_r} reframed, {n_c} copied through, {n_f} failed")
    L.append("")
    for c in clips:
        src = c["source"]
        L.append(f"* {c['name']}  ->  {Path(c['output']).name if c.get('output') else '-'}")
        L.append(f"  {src['width']}x{src['height']} {src['fps']:.2f}fps {_fmt_t(src['duration'])}  status: {c['status']}")
        if c["status"] == "failed":
            L.append(f"  ERROR: {c.get('error')}")
        for s in c.get("shots", []):
            line = (f"  shot {s['index']:>2} {_fmt_t(s['start_time'])}-{_fmt_t(s['end_time'])}  {s['mode']:<6} "
                    f"{s['focal_class']:<14} conf {s['confidence']:.2f}")
            if s.get("zoom", 1.0) > 1.0:
                line += f" zoom {s['zoom']:.2f}x"
            if s.get("moves"):
                line += f" moves {s['moves']}"
            if s.get("flags"):
                line += "  ! " + ", ".join(s["flags"])
            L.append(line)
        if c.get("flags"):
            L.append("  FLAGS: " + ", ".join(c["flags"]))
        if c.get("verify"):
            v = c["verify"]
            L.append(f"  out: {v['width']}x{v['height']} {v['fps']}fps {_fmt_t(v['duration'])} {v['codec']} audio={v['audio']}")
        L.append("")
    if job.get("notes"):
        L.append("NOTES")
        L.extend("- " + n for n in job["notes"])
    return "\n".join(L)


def write_report(job: dict, qc_dir: Path) -> Path:
    qc_dir.mkdir(parents=True, exist_ok=True)
    (qc_dir / "report.json").write_text(json.dumps(job, indent=2, default=str))
    p = qc_dir / "report.md"
    p.write_text(build_report(job))
    return p


def send_telegram(text: str, photos: list) -> str:
    tok = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not tok or not chat:
        return "telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; report written to qc/report.md only"
    base = f"https://api.telegram.org/bot{tok}"
    chunks = []
    cur = ""
    for line in text.splitlines():
        if len(cur) + len(line) + 1 > 3900:
            chunks.append(cur)
            cur = ""
        cur += line + "\n"
    if cur:
        chunks.append(cur)
    for ch in chunks:
        r = requests.post(f"{base}/sendMessage", data=dict(chat_id=chat, text=ch), timeout=60)
        r.raise_for_status()
    for p in photos:
        with open(p, "rb") as f:
            r = requests.post(f"{base}/sendPhoto", data=dict(chat_id=chat, caption=Path(p).name), files=dict(photo=f), timeout=120)
            r.raise_for_status()
    return f"telegram: sent {len(chunks)} message(s) and {len(photos)} contact sheet(s)"

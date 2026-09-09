"""QC contact sheet: 6 evenly spaced frames, source (with crop box) over output, phone-friendly."""
from __future__ import annotations
from pathlib import Path

import cv2
import numpy as np

from .media import read_frame


def _fit(img, w, h):
    ih, iw = img.shape[:2]
    k = min(w / iw, h / ih)
    return cv2.resize(img, (max(1, int(iw * k)), max(1, int(ih * k))), interpolation=cv2.INTER_AREA)


def _put(img, text, org, scale=0.5, color=(255, 255, 255)):
    (tw, th), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)
    x, y = org
    cv2.rectangle(img, (x - 3, y - th - 3), (min(img.shape[1] - 1, x + tw + 3), y + base + 2), (24, 24, 24), -1)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)


def contact_sheet(src: Path, out: Path, plan: dict, dst: Path, n: int = 6, copy_through: bool = False):
    nb = plan["source"]["nb_frames"]
    fps = plan["source"]["fps"]
    idxs = [int(round((i + 0.5) * nb / n)) for i in range(n)]
    cols, rows = 3, int(np.ceil(n / 3))
    cell_w, src_h, out_h = 360, 203, 480
    cell_h = 26 + src_h + 6 + out_h + 30
    header = 64
    sheet = np.full((header + rows * cell_h, cols * cell_w, 3), 24, np.uint8)
    flags = plan.get("flags", [])
    _put(sheet, f"{src.name}  ->  {dst.name if dst else '(none)'}", (10, 26), 0.6, (255, 255, 255))
    _put(sheet, f"{plan['source']['width']}x{plan['source']['height']} {fps:.2f}fps  shots:{len(plan['shots'])}  "
                f"flags: {', '.join(flags) if flags else 'none'}", (10, 52), 0.5, (200, 200, 90) if flags else (160, 220, 160))
    shots = plan["shots"]
    for i, fi in enumerate(idxs):
        r, c = divmod(i, cols)
        ox, oy = c * cell_w, header + r * cell_h
        shot = next((s for s in shots if s["start_frame"] <= fi < s["end_frame"]), shots[-1] if shots else None)
        sf = read_frame(src, fi)
        if sf is not None:
            if shot and "crop" in shot and not copy_through:
                # crop position at this frame from the dense per-frame table
                dense = shot.get("_dense")
                if dense is not None:
                    x, y = dense[fi - shot["start_frame"]]
                    cw, ch = shot["crop"]["w"], shot["crop"]["h"]
                    cv2.rectangle(sf, (int(x), int(y)), (int(x + cw), int(y + ch)), (0, 220, 255), max(2, sf.shape[1] // 400))
            sm = _fit(sf, cell_w - 8, src_h)
            sheet[oy + 26:oy + 26 + sm.shape[0], ox + 4:ox + 4 + sm.shape[1]] = sm
        label = f"{fi / fps:6.2f}s  f{fi}"
        if shot:
            label += f"  shot {shot['index']} {shot['mode']} {shot['focal_class']}"
        _put(sheet, label, (ox + 6, oy + 18), 0.42, (230, 230, 230))
        if dst and dst.exists():
            of = read_frame(dst, fi)
            if of is not None:
                om = _fit(of, cell_w - 8, out_h)
                yy = oy + 26 + src_h + 6
                xx = ox + (cell_w - om.shape[1]) // 2
                sheet[yy:yy + om.shape[0], xx:xx + om.shape[1]] = om
        if shot and shot.get("flags"):
            _put(sheet, "! " + ", ".join(shot["flags"]), (ox + 6, oy + cell_h - 10), 0.42, (90, 200, 255))
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return out

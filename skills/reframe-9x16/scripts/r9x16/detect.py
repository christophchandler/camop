"""Detectors: YOLO (persons + objects, with built-in ByteTrack), YuNet faces, PP-OCR DB text, and a
spectral-residual saliency + motion map used when there are no people."""
from __future__ import annotations
import contextlib
import io
from typing import List, Optional

import cv2
import numpy as np


class Detectors:
    def __init__(self, cfg, model_paths: dict):
        from ultralytics import YOLO
        self.cfg = cfg
        self.yolo = YOLO(str(model_paths["yolov8n.pt"]))
        self.device = cfg.device
        self.yunet = cv2.FaceDetectorYN.create(str(model_paths["face_detection_yunet_2023mar.onnx"]), "", (320, 320),
                                               cfg.face_conf, 0.3, 5000)
        self.text = None
        try:
            t = cv2.dnn.TextDetectionModel_DB(str(model_paths["text_detection_en_ppocrv3_2023may.onnx"]))
            t.setBinaryThreshold(0.3)
            t.setPolygonThreshold(0.5)
            t.setInputParams(1.0 / 255, (736, 736), (122.67891434, 116.66876762, 104.00698793))
            self.text = t
        except Exception as e:  # text detection is best-effort
            print(f"[detect] text detector unavailable: {e}")
        self._prev_gray = None

    # ---- people / objects -------------------------------------------------------------------
    def reset_tracker(self):
        try:
            for t in self.yolo.predictor.trackers:
                t.reset()
        except Exception:
            pass
        self._prev_gray = None

    def track(self, frame: np.ndarray) -> List[dict]:
        with contextlib.redirect_stdout(io.StringIO()):
            res = self.yolo.track(frame, persist=True, conf=self.cfg.yolo_conf, imgsz=640, verbose=False,
                                  device=self.device, tracker="bytetrack.yaml")[0]
        out = []
        if res.boxes is None or len(res.boxes) == 0:
            return out
        ids = res.boxes.id
        for k in range(len(res.boxes)):
            cls = int(res.boxes.cls[k])
            out.append(dict(cls=cls, name=res.names[cls], conf=float(res.boxes.conf[k]),
                            box=[float(v) for v in res.boxes.xyxy[k].tolist()],
                            id=int(ids[k]) if ids is not None else -1))
        return out

    # ---- faces --------------------------------------------------------------------------------
    def faces(self, frame: np.ndarray) -> List[dict]:
        h, w = frame.shape[:2]
        self.yunet.setInputSize((w, h))
        _, f = self.yunet.detect(frame)
        out = []
        if f is None:
            return out
        for row in f:
            x, y, bw, bh = row[:4]
            out.append(dict(box=[float(x), float(y), float(x + bw), float(y + bh)], conf=float(row[14]),
                            eyes=[[float(row[4]), float(row[5])], [float(row[6]), float(row[7])]]))
        return out

    # ---- text ---------------------------------------------------------------------------------
    def text_boxes(self, frame: np.ndarray) -> List[list]:
        if self.text is None:
            return []
        h, w = frame.shape[:2]
        try:
            polys, confs = self.text.detect(frame)
        except Exception:
            return []
        out = []
        for poly, c in zip(polys, confs):
            if c < 0.5:
                continue
            p = np.array(poly).reshape(-1, 2)
            x1, y1 = p.min(0)
            x2, y2 = p.max(0)
            bw, bh = x2 - x1, y2 - y1
            # text lines are wide and short; reject blobs that are not text-shaped (signs, machinery, windows)
            if bw < 0.02 * w or bh < 4 or bw / max(1.0, bh) < 2.5 or bh > 0.15 * h:
                continue
            out.append([float(x1), float(y1), float(x2), float(y2)])
        return out

    # ---- saliency + motion --------------------------------------------------------------------
    def saliency(self, frame: np.ndarray, text_boxes=None) -> dict:
        """Dominant moving / compositional subject when there are no people.
        Motion first: the largest coherent moving blob (frame difference vs the previous sample, global
        motion discounted). Otherwise multi-scale spectral-residual saliency. Text overlays are masked
        out so a lower third never becomes the subject. Returns centre / bbox in frame coords,
        motion energy (fraction of the frame moving) and spread (0..1, 1 = uniformly spread)."""
        h, w = frame.shape[:2]
        sw = 160
        sh = max(8, int(round(h * sw / w)))
        k = w / sw
        small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA)
        g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
        mask = np.ones((sh, sw), np.float32)
        for tb in text_boxes or []:
            x1, y1, x2, y2 = [int(round(v / k)) for v in tb]
            mask[max(0, y1 - 2):y2 + 2, max(0, x1 - 2):x2 + 2] = 0.0
        # --- motion blob ---
        energy = 0.0
        blob = None
        if self._prev_gray is not None and self._prev_gray.shape == g.shape:
            d = np.abs(cv2.GaussianBlur(g, (0, 0), 1.0) - cv2.GaussianBlur(self._prev_gray, (0, 0), 1.0))
            d = np.clip(d - np.median(d), 0, None) * mask
            thr = max(6.0, float(np.percentile(d, 98)) * 0.5)
            mv = (d > thr).astype(np.uint8)
            mv = cv2.morphologyEx(mv, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
            energy = float(mv.mean())
            if 0.001 < energy < 0.35:
                n, lab, stats, cents = cv2.connectedComponentsWithStats(mv, connectivity=8)
                if n > 1:
                    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
                    x, y, bw, bh, area = stats[i]
                    if area >= 12:
                        blob = dict(center=[float(cents[i][0]), float(cents[i][1])], box=[float(x), float(y), float(x + bw), float(y + bh)])
        self._prev_gray = g
        # --- saliency: spectral residual (two scales) + frequency-tuned colour contrast ---
        sal = _spectral_residual(g)
        g2 = cv2.resize(g, (sw // 2, sh // 2), interpolation=cv2.INTER_AREA)
        sal2 = cv2.resize(_spectral_residual(g2), (sw, sh), interpolation=cv2.INTER_LINEAR)
        lab = cv2.cvtColor(cv2.GaussianBlur(small, (0, 0), 1.5), cv2.COLOR_BGR2LAB).astype(np.float32)
        ft = np.linalg.norm(lab - lab.reshape(-1, 3).mean(0), axis=2)
        ft -= ft.min()
        if ft.max() > 1e-9:
            ft /= ft.max()
        m = (0.25 * sal + 0.25 * sal2 + 0.5 * ft) * mask
        m = cv2.GaussianBlur(m, (0, 0), 2.0)
        m -= m.min()
        if m.max() > 1e-9:
            m /= m.max()
        mass = m ** 2
        tot = mass.sum() + 1e-9
        ys, xs = np.mgrid[0:sh, 0:sw]
        cx = float((mass * xs).sum() / tot)
        cy = float((mass * ys).sum() / tot)
        sx = float(np.sqrt((mass * (xs - cx) ** 2).sum() / tot))
        spread = float(np.clip(sx / (sw / np.sqrt(12)), 0, 1))  # 1 == uniform
        if tot < 1e-6:
            cx, cy, spread = sw / 2, sh / 2, 1.0
        thr = m > 0.5
        if thr.any():
            yy, xx = np.where(thr)
            sbox = [float(xx.min()), float(yy.min()), float(xx.max() + 1), float(yy.max() + 1)]
        else:
            sbox = [cx - 8, cy - 8, cx + 8, cy + 8]
        out = dict(sal_center=[cx * k, cy * k], sal_box=[v * k for v in sbox], motion=energy, spread=spread)
        if blob is not None:
            out["motion_center"] = [blob["center"][0] * k, blob["center"][1] * k]
            out["motion_box"] = [v * k for v in blob["box"]]
        return out


def _spectral_residual(g: np.ndarray) -> np.ndarray:
    f = np.fft.fft2(g)
    mag = np.abs(f) + 1e-9
    phase = np.angle(f)
    logmag = np.log(mag)
    sr = logmag - cv2.blur(logmag, (3, 3))
    sal = np.abs(np.fft.ifft2(np.exp(sr + 1j * phase))) ** 2
    sal = cv2.GaussianBlur(sal.astype(np.float32), (0, 0), 2.5)
    sal -= sal.min()
    if sal.max() > 1e-9:
        sal /= sal.max()
    return sal

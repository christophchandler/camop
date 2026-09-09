"""Shot boundaries via PySceneDetect. Every shot is treated independently downstream."""
from pathlib import Path
from typing import List, Tuple

from scenedetect import detect, AdaptiveDetector, ContentDetector


def detect_shots(path: Path, fps: float, nb_frames: int, min_shot_s: float = 0.4) -> List[Tuple[int, int]]:
    min_len = max(2, int(round(min_shot_s * fps)))
    scenes = []
    try:
        scenes = detect(str(path), AdaptiveDetector(adaptive_threshold=3.0, min_scene_len=min_len), show_progress=False)
    except Exception:
        try:
            scenes = detect(str(path), ContentDetector(threshold=27.0, min_scene_len=min_len), show_progress=False)
        except Exception:
            scenes = []
    shots = []
    for s, e in scenes:
        a, b = s.get_frames(), e.get_frames()
        if b > a:
            shots.append((a, b))
    if not shots:
        return [(0, nb_frames)]
    # normalise to the decoded frame count
    shots[0] = (0, shots[0][1])
    shots[-1] = (shots[-1][0], max(shots[-1][1], nb_frames))
    fixed = []
    for a, b in shots:
        b = min(b, nb_frames)
        if b - a >= 1:
            fixed.append((a, b))
    return fixed or [(0, nb_frames)]

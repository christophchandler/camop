"""Model weights: fetched on first use into Config.models_dir."""
from pathlib import Path
import sys
import requests

URLS = {
    "yolov8n.pt": "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt",
    "face_detection_yunet_2023mar.onnx": "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "text_detection_en_ppocrv3_2023may.onnx": "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/text_detection_ppocr/text_detection_en_ppocrv3_2023may.onnx",
}


def ensure_models(models_dir: Path) -> dict:
    models_dir = Path(models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, url in URLS.items():
        p = models_dir / name
        if not p.exists() or p.stat().st_size < 10000:
            print(f"[models] downloading {name} ...", file=sys.stderr)
            with requests.get(url, stream=True, timeout=120) as r:
                r.raise_for_status()
                tmp = p.with_suffix(p.suffix + ".part")
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
                tmp.rename(p)
        paths[name] = p
    return paths

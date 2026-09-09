from dataclasses import dataclass, field
from pathlib import Path
import os


@dataclass
class Config:
    out_w: int = 1080
    out_h: int = 1920
    proxy_w: int = 640            # analysis proxy width
    stride: int = 0               # 0 = auto (2 for <=30fps, 3 above)
    device: str = "cpu"           # cpu | mps | cuda
    yolo_conf: float = 0.30
    face_conf: float = 0.60
    deadband: float = 0.30        # subject may drift +-30% of crop width (= middle 60%) before we move
    ease_s: float = 1.0           # duration of an eased PAN move
    max_pan_speed: float = 0.60   # crop widths per second (PAN)
    max_track_speed: float = 1.60 # crop widths per second (TRACK)
    hysteresis_s: float = 0.25    # subject must be outside deadband this long before a PAN starts
    track_tau_s: float = 0.25     # TRACK smoothing time constant
    min_shot_s: float = 0.4
    zoom_cap_hd: float = 1.15
    zoom_cap_4k: float = 2.0
    tiny_face_frac: float = 0.075 # face height / frame height below which a punch-in is considered
    target_face_frac: float = 0.11
    eye_line: float = 0.37        # eyes at 37% from top of the crop when punched in
    crf: int = 18
    preset: str = "medium"
    telegram: bool = True
    models_dir: Path = field(default_factory=lambda: Path(os.environ.get("R9X16_MODELS", Path.home() / ".cache" / "reframe-9x16" / "models")))
    contact_frames: int = 6
    text_every_s: float = 1.0     # run text detector this often
    frameio_token: str = field(default_factory=lambda: os.environ.get("FRAMEIO_TOKEN", "") or os.environ.get("FRAME_IO_TOKEN", ""))

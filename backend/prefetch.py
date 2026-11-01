"""Download the ungated model weights into the image, so a container that was
just restarted does not spend its first ingest downloading them again.

    python prefetch.py          # run by the Dockerfile; safe to run anywhere

Hugging Face checkpoints land in HF_HOME, weight files in VIDRA_WEIGHTS. Left
to download on first use: pyannote (gated, needs HF_TOKEN at run time) and the
`object_detection` analyzer's YOLO-World weights and their text encoder.
"""

from __future__ import annotations

import os
import urllib.request
from pathlib import Path

WEIGHTS = Path(os.environ.get("VIDRA_WEIGHTS", "weights"))
FILES = {
    "yolo11n.pt": "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt",
    "ocr/text_detection_en_ppocrv3_2023may.onnx":
        "https://huggingface.co/opencv/text_detection_ppocr/resolve/main/"
        "text_detection_en_ppocrv3_2023may.onnx",
}


def main() -> None:
    for name, url in FILES.items():
        target = WEIGHTS / name
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            print(f"fetching {name}", flush=True)
            urllib.request.urlretrieve(url, target)

    # Loading each model once is the surest way to pull every file it needs.
    print("fetching whisper small", flush=True)
    from faster_whisper import WhisperModel
    WhisperModel("small", device="cpu", compute_type="int8")

    print("fetching clip", flush=True)
    from transformers import CLIPModel, CLIPProcessor, pipeline
    CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
    CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")

    print("fetching sentiment", flush=True)
    pipeline("sentiment-analysis", model="distilbert-base-uncased-finetuned-sst-2-english")

    print("fetching gliner", flush=True)
    from gliner import GLiNER
    GLiNER.from_pretrained("urchade/gliner_small-v2.1")


if __name__ == "__main__":
    main()

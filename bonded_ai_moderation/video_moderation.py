"""Video moderation using the BondEd custom image CNN on sampled frames."""
from pathlib import Path
import tempfile
import cv2
import numpy as np
from PIL import Image
import tensorflow as tf

ROOT = Path(__file__).resolve().parent
MODEL_PATH = ROOT / "model" / "bonded_moderation_model.keras"
IMG_SIZE = (160, 160)


def moderate_video(video_path: str, sample_every_seconds: float = 2.0):
    model = tf.keras.models.load_model(MODEL_PATH)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError("Could not open video")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = total_frames / fps if fps else 0
    interval = max(1, int(fps * sample_every_seconds))

    probabilities = []
    frame_index = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_index % interval == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = Image.fromarray(rgb).resize(IMG_SIZE)
                arr = np.asarray(image, dtype=np.float32)[None, ...]
                p = float(model.predict(arr, verbose=0)[0][0])
                probabilities.append(p)
            frame_index += 1
    finally:
        cap.release()

    if not probabilities:
        return {"decision": "review", "reason": "No analyzable frames", "frames_analyzed": 0}

    max_risk = max(probabilities)
    avg_risk = sum(probabilities) / len(probabilities)

    # Conservative policy: a high-risk frame blocks; borderline results go to review.
    if max_risk >= 0.85:
        decision = "blocked"
    elif max_risk >= 0.50 or avg_risk >= 0.35:
        decision = "review"
    else:
        decision = "approved"

    return {
        "decision": decision,
        "duration_seconds": round(duration, 2),
        "frames_analyzed": len(probabilities),
        "max_inappropriate_probability": round(max_risk, 4),
        "average_inappropriate_probability": round(avg_risk, 4),
    }

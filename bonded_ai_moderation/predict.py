"""Predict whether one image is appropriate or inappropriate."""
from pathlib import Path
import sys
import numpy as np
from PIL import Image
import tensorflow as tf

ROOT = Path(__file__).resolve().parent
MODEL_PATH = ROOT / "model" / "bonded_moderation_model.keras"
IMG_SIZE = (160, 160)

if len(sys.argv) != 2:
    raise SystemExit("Usage: python predict.py path/to/image.jpg")

model = tf.keras.models.load_model(MODEL_PATH)
image = Image.open(sys.argv[1]).convert("RGB").resize(IMG_SIZE)
arr = np.asarray(image, dtype=np.float32)[None, ...]
prob_inappropriate = float(model.predict(arr, verbose=0)[0][0])
label = "inappropriate" if prob_inappropriate >= 0.5 else "appropriate"
print({
    "label": label,
    "inappropriate_probability": round(prob_inappropriate, 4),
    "appropriate_probability": round(1 - prob_inappropriate, 4),
})

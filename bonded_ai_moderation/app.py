"""FastAPI wrapper for BondEd's custom moderation model.

Run after training:
    uvicorn app:app --host 0.0.0.0 --port 8000
"""
from pathlib import Path
import tempfile
from fastapi import FastAPI, File, UploadFile, HTTPException
from PIL import Image
import numpy as np
import tensorflow as tf

from video_moderation import moderate_video

ROOT = Path(__file__).resolve().parent
MODEL_PATH = ROOT / "model" / "bonded_moderation_model.keras"
IMG_SIZE = (160, 160)

app = FastAPI(title="BondEd AI Moderation API", version="1.0.0")
model = None


def get_model():
    global model
    if model is None:
        if not MODEL_PATH.exists():
            raise HTTPException(status_code=503, detail="Model not trained yet. Run train_model.py first.")
        model = tf.keras.models.load_model(MODEL_PATH)
    return model


@app.get("/health")
def health():
    return {"status": "ok", "model_exists": MODEL_PATH.exists()}


@app.post("/moderate/image")
async def moderate_image(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Expected an image file")
    data = await file.read()
    try:
        image = Image.open(__import__("io").BytesIO(data)).convert("RGB").resize(IMG_SIZE)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid image") from exc

    arr = np.asarray(image, dtype=np.float32)[None, ...]
    p = float(get_model().predict(arr, verbose=0)[0][0])
    if p >= 0.85:
        decision = "blocked"
    elif p >= 0.50:
        decision = "review"
    else:
        decision = "approved"
    return {
        "decision": decision,
        "inappropriate_probability": round(p, 4),
        "appropriate_probability": round(1 - p, 4),
    }


@app.post("/moderate/video")
async def moderate_video_endpoint(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("video/"):
        raise HTTPException(status_code=415, detail="Expected a video file")
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        temp_path = tmp.name
    try:
        return moderate_video(temp_path)
    finally:
        Path(temp_path).unlink(missing_ok=True)

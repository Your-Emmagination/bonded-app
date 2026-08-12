"""Evaluate the trained BondEd CNN on the held-out test set."""
from pathlib import Path
import json
import numpy as np
import tensorflow as tf
from sklearn.metrics import classification_report, confusion_matrix

ROOT = Path(__file__).resolve().parent
MODEL_PATH = ROOT / "model" / "bonded_moderation_model.keras"
TEST_DIR = ROOT / "dataset" / "test"
IMG_SIZE = (160, 160)
BATCH_SIZE = 32

model = tf.keras.models.load_model(MODEL_PATH)
test_ds = tf.keras.utils.image_dataset_from_directory(
    TEST_DIR,
    labels="inferred",
    label_mode="binary",
    class_names=["appropriate", "inappropriate"],
    image_size=IMG_SIZE,
    batch_size=BATCH_SIZE,
    shuffle=False,
)

images, labels = [], []
for x, y in test_ds:
    images.append(x.numpy())
    labels.append(y.numpy().reshape(-1))
X = np.concatenate(images)
y_true = np.concatenate(labels).astype(int)
y_prob = model.predict(X, verbose=0).reshape(-1)
y_pred = (y_prob >= 0.5).astype(int)

print(classification_report(y_true, y_pred, target_names=["appropriate", "inappropriate"], digits=4))
print("Confusion matrix:")
print(confusion_matrix(y_true, y_pred))

with open(ROOT / "model" / "evaluation_report.json", "w", encoding="utf-8") as f:
    json.dump({
        "classification_report": classification_report(
            y_true, y_pred,
            target_names=["appropriate", "inappropriate"],
            output_dict=True,
        ),
        "confusion_matrix": confusion_matrix(y_true, y_pred).tolist(),
    }, f, indent=2)

"""Train BondEd's custom CNN from scratch.

Dataset layout:
dataset/train/{appropriate,inappropriate}
dataset/validation/{appropriate,inappropriate}
dataset/test/{appropriate,inappropriate}

The CNN is created with random initialization; no pretrained backbone is used.
"""
from pathlib import Path
import json
import tensorflow as tf

ROOT = Path(__file__).resolve().parent
DATASET = ROOT / "dataset"
MODEL_DIR = ROOT / "model"
MODEL_DIR.mkdir(exist_ok=True)

IMG_SIZE = (160, 160)
BATCH_SIZE = 32
EPOCHS = 25
SEED = 42


def load_split(name):
    return tf.keras.utils.image_dataset_from_directory(
        DATASET / name,
        labels="inferred",
        label_mode="binary",
        class_names=["appropriate", "inappropriate"],
        image_size=IMG_SIZE,
        batch_size=BATCH_SIZE,
        shuffle=(name == "train"),
        seed=SEED,
    )


train_ds = load_split("train")
val_ds = load_split("validation")
test_ds = load_split("test")

AUTOTUNE = tf.data.AUTOTUNE
train_ds = train_ds.prefetch(AUTOTUNE)
val_ds = val_ds.prefetch(AUTOTUNE)
test_ds = test_ds.prefetch(AUTOTUNE)

# Data augmentation is part of training; it does not use a pretrained model.
data_augmentation = tf.keras.Sequential([
    tf.keras.layers.RandomFlip("horizontal"),
    tf.keras.layers.RandomRotation(0.08),
    tf.keras.layers.RandomZoom(0.10),
], name="augmentation")

# Custom CNN: weights are initialized randomly and learned from the BondEd dataset.
model = tf.keras.Sequential([
    tf.keras.layers.Input(shape=(*IMG_SIZE, 3)),
    tf.keras.layers.Rescaling(1.0 / 255),
    data_augmentation,

    tf.keras.layers.Conv2D(32, 3, padding="same", activation="relu"),
    tf.keras.layers.MaxPooling2D(),
    tf.keras.layers.BatchNormalization(),

    tf.keras.layers.Conv2D(64, 3, padding="same", activation="relu"),
    tf.keras.layers.MaxPooling2D(),
    tf.keras.layers.BatchNormalization(),

    tf.keras.layers.Conv2D(128, 3, padding="same", activation="relu"),
    tf.keras.layers.MaxPooling2D(),
    tf.keras.layers.BatchNormalization(),

    tf.keras.layers.Conv2D(256, 3, padding="same", activation="relu"),
    tf.keras.layers.GlobalAveragePooling2D(),
    tf.keras.layers.Dropout(0.35),
    tf.keras.layers.Dense(64, activation="relu"),
    tf.keras.layers.Dropout(0.25),
    tf.keras.layers.Dense(1, activation="sigmoid"),
], name="bonded_custom_cnn")

model.compile(
    optimizer=tf.keras.optimizers.Adam(learning_rate=1e-3),
    loss="binary_crossentropy",
    metrics=[
        "accuracy",
        tf.keras.metrics.Precision(name="precision"),
        tf.keras.metrics.Recall(name="recall"),
    ],
)

callbacks = [
    tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=5, restore_best_weights=True),
    tf.keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=2),
    tf.keras.callbacks.ModelCheckpoint(
        MODEL_DIR / "bonded_moderation_model.keras",
        monitor="val_loss",
        save_best_only=True,
    ),
]

history = model.fit(train_ds, validation_data=val_ds, epochs=EPOCHS, callbacks=callbacks)

# Final held-out test metrics.
test_metrics = model.evaluate(test_ds, return_dict=True)
with open(MODEL_DIR / "training_metadata.json", "w", encoding="utf-8") as f:
    json.dump({
        "classes": ["appropriate", "inappropriate"],
        "image_size": IMG_SIZE,
        "batch_size": BATCH_SIZE,
        "epochs_requested": EPOCHS,
        "test_metrics": {k: float(v) for k, v in test_metrics.items()},
    }, f, indent=2)

print("\nTraining complete.")
print(f"Model: {MODEL_DIR / 'bonded_moderation_model.keras'}")
print("Test metrics:", {k: round(float(v), 4) for k, v in test_metrics.items()})

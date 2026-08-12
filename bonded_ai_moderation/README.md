# BondEd Custom AI Moderation

This module is designed for the capstone requirement to **make and train our own AI**. The classifier is a custom CNN initialized from scratch; it does **not** use a pretrained vision backbone.

## 1. Dataset

Put only legally usable, appropriately labeled data into:

```text
dataset/
├── train/
│   ├── appropriate/
│   └── inappropriate/
├── validation/
│   ├── appropriate/
│   └── inappropriate/
└── test/
    ├── appropriate/
    └── inappropriate/
```

The folders are labels. Keep the test set separate from training images.

For the first prototype, use the two classes:

- `appropriate` — content allowed by the BondEd community rules
- `inappropriate` — content that violates the BondEd rules

Do not place disturbing or illegal material into the repository unless it is lawful, ethically sourced, and necessary for the research. Document the labeling rules before collecting data.

## 2. Install Python dependencies

Create a virtual environment and install:

```bash
python -m venv .venv
# Windows PowerShell
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## 3. Train from scratch

```bash
python train_model.py
```

The best model is saved to:

```text
model/bonded_moderation_model.keras
```

## 4. Evaluate

```bash
python test_model.py
```

This reports accuracy-related metrics plus precision, recall, F1, and a confusion matrix.

## 5. Test one image

```bash
python predict.py path/to/image.jpg
```

## 6. Run the API

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

Then open `/docs` on the server to test the endpoints.

## 7. Video moderation

`video_moderation.py` samples video frames and runs the custom image CNN on those frames. It returns:

- `approved`
- `review`
- `blocked`

This is a prototype moderation strategy. It is not a guarantee that every unsafe scene will be detected, so BondEd should retain human moderator review for uncertain cases.

## Important research note

Do not claim the model is accurate until it has actually been trained and evaluated on a held-out test set. Report the real metrics from `test_model.py` in the manuscript.

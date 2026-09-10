"""
Trains a small, separate binary classifier that flags whether a comment on
a Lost & Found post sounds like the item has been resolved (found/returned/
claimed) — e.g. "found na po", "already returned", "thank you nakuha ko na"
— versus an ordinary comment ("is this yours?", "what color was it?").

This is deliberately NOT a new label on the existing intent model
(chatbot_training/train_intent_model.py) — it's a separate, purpose-built
classifier over a different vocabulary (comment replies, not questions to
B.E.A.), trained and exported independently. See utils/lostAndFoundResolution.ts
for how it's used: it never generates a chat reply, it only flags UI state
for the original poster to confirm.

Same TF-IDF + Logistic Regression technique as train_intent_model.py, same
"explicit wide type instead of `as const`" export pattern.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline

ROOT = Path(__file__).resolve().parents[1]
DATASET = Path(__file__).resolve().parent / "resolution_training.csv"
REPORT = Path(__file__).resolve().parent / "resolution_evaluation_report.json"
EXPORT = ROOT / "utils" / "resolutionDetectorModel.ts"


def normalize_text(value: str) -> str:
    value = value.lower()
    value = value.replace("'", "")
    import re

    value = re.sub(r"[^a-z0-9\s]", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def load_data():
    rows = []
    with DATASET.open("r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            text = (row.get("text") or "").strip()
            label = (row.get("label") or "").strip()
            if text and label:
                rows.append((text, label))
    return rows


def make_vectorizer():
    return TfidfVectorizer(
        preprocessor=normalize_text,
        lowercase=False,
        ngram_range=(1, 2),
        sublinear_tf=True,
        min_df=1,
        norm="l2",
        token_pattern=r"(?u)\b\w+\b",
    )


def make_logreg():
    return LogisticRegression(
        max_iter=3000,
        C=4.0,
        class_weight="balanced",
        solver="lbfgs",
    )


def linear_payload(pipe: Pipeline):
    vectorizer: TfidfVectorizer = pipe.named_steps["tfidf"]
    clf: LogisticRegression = pipe.named_steps["clf"]

    terms = [""] * len(vectorizer.vocabulary_)
    for term, index in vectorizer.vocabulary_.items():
        terms[index] = term

    return {
        "classes": clf.classes_.tolist(),
        "terms": terms,
        "idf": vectorizer.idf_.astype(float).tolist(),
        "coef": clf.coef_.astype(float).tolist(),
        "intercept": clf.intercept_.astype(float).tolist(),
    }


def main():
    rows = load_data()
    texts = [t for t, _ in rows]
    labels = [l for _, l in rows]

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    pipe = Pipeline([("tfidf", make_vectorizer()), ("clf", make_logreg())])
    cv_scores = cross_val_score(pipe, texts, labels, cv=cv, scoring="accuracy")

    X_train, X_test, y_train, y_test = train_test_split(
        texts, labels, test_size=0.25, random_state=42, stratify=labels,
    )
    eval_model = Pipeline([("tfidf", make_vectorizer()), ("clf", make_logreg())])
    eval_model.fit(X_train, y_train)
    y_pred = eval_model.predict(X_test)

    final_model = Pipeline([("tfidf", make_vectorizer()), ("clf", make_logreg())])
    final_model.fit(texts, labels)

    metrics = {
        "training_rows": len(rows),
        "labels": sorted(set(labels)),
        "cross_validation_accuracy": float(cv_scores.mean()),
        "cross_validation_std": float(cv_scores.std()),
        "holdout_accuracy": float(accuracy_score(y_test, y_pred)),
        "classification_report": classification_report(
            y_test, y_pred, output_dict=True, zero_division=0
        ),
        "generative_ai": False,
    }
    REPORT.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    payload = {
        "modelName": "bonded-lost-found-resolution-tfidf-logreg-v1",
        "algorithm": "TF-IDF + Logistic Regression",
        "generative": False,
        "trainingRows": len(rows),
        "crossValidationAccuracy": float(cv_scores.mean()),
        "model": linear_payload(final_model),
    }

    # Explicit wide type instead of `as const` — same reasoning as
    # train_intent_model.py / general_knowledge/build_index.py: keeps the
    # TS compiler's type-checker cheap regardless of how large this grows.
    ts_type_declaration = (
        "type ResolutionLinearModelShape = {\n"
        "  classes: string[];\n"
        "  terms: string[];\n"
        "  idf: number[];\n"
        "  coef: number[][];\n"
        "  intercept: number[];\n"
        "};\n\n"
        "type ResolutionDetectorModelShape = {\n"
        "  modelName: string;\n"
        "  algorithm: string;\n"
        "  generative: boolean;\n"
        "  trainingRows: number;\n"
        "  crossValidationAccuracy: number;\n"
        "  model: ResolutionLinearModelShape;\n"
        "};\n\n"
    )

    ts = (
        "// AUTO-GENERATED by chatbot_training/train_resolution_detector.py\n"
        "// Do not hand-edit. Retrain the model to regenerate this file.\n\n"
        + ts_type_declaration
        + "export const RESOLUTION_DETECTOR_MODEL: ResolutionDetectorModelShape = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    EXPORT.write_text(ts, encoding="utf-8")

    print(json.dumps({
        "training_rows": len(rows),
        "cv_accuracy": metrics["cross_validation_accuracy"],
        "holdout_accuracy": metrics["holdout_accuracy"],
        "export": str(EXPORT),
    }, indent=2))


if __name__ == "__main__":
    main()

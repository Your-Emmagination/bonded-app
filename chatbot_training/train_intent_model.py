from __future__ import annotations

import csv
import json
import re
import unicodedata
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import Pipeline
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parents[1]
DATASET = Path(__file__).resolve().parent / "intent_training.csv"
REPORT = Path(__file__).resolve().parent / "evaluation_report.json"
EXPORT = ROOT / "utils" / "chatbotIntentModel.ts"

def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower()
    value = re.sub(r"@(?:ai|bondedai)\b", " ", value)
    value = re.sub(r"[^a-z0-9+\-*/().%\s]", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value

def load_data():
    rows = []
    with DATASET.open("r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            text = (row.get("text") or "").strip()
            intent = (row.get("intent") or "").strip()
            if text and intent:
                rows.append((text, intent))
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
    supported = [(text, intent) for text, intent in rows if intent != "unknown"]
    unknown = [(text, intent) for text, intent in rows if intent == "unknown"]

    supported_texts = [x[0] for x in supported]
    supported_labels = [x[1] for x in supported]

    # ---- Intent model evaluation (supported intents only) ----
    candidates = {
        "Multinomial Naive Bayes": MultinomialNB(alpha=0.6),
        "Logistic Regression": make_logreg(),
        "Linear SVM": LinearSVC(C=1.5, class_weight="balanced"),
    }
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    cv_results = {}
    for name, estimator in candidates.items():
        pipe = Pipeline([("tfidf", make_vectorizer()), ("clf", estimator)])
        scores = cross_val_score(pipe, supported_texts, supported_labels, cv=cv, scoring="accuracy")
        cv_results[name] = {
            "mean_accuracy": float(scores.mean()),
            "std_accuracy": float(scores.std()),
            "folds": [float(x) for x in scores],
        }

    best_name = max(cv_results, key=lambda n: cv_results[n]["mean_accuracy"])
    logreg_score = cv_results["Logistic Regression"]["mean_accuracy"]
    best_score = cv_results[best_name]["mean_accuracy"]
    selected_name = "Logistic Regression" if best_score - logreg_score <= 0.02 else best_name
    if selected_name != "Logistic Regression":
        raise RuntimeError(
            f"{selected_name} clearly outperformed Logistic Regression. "
            "Add an exporter/runtime for it before deployment."
        )

    X_train, X_test, y_train, y_test = train_test_split(
        supported_texts,
        supported_labels,
        test_size=0.25,
        random_state=42,
        stratify=supported_labels,
    )
    intent_eval = Pipeline([("tfidf", make_vectorizer()), ("clf", make_logreg())])
    intent_eval.fit(X_train, y_train)
    intent_pred = intent_eval.predict(X_test)

    intent_model = Pipeline([("tfidf", make_vectorizer()), ("clf", make_logreg())])
    intent_model.fit(supported_texts, supported_labels)

    # ---- Scope model: supported BondED question vs out-of-scope question ----
    scope_texts = [text for text, _ in rows]
    scope_labels = ["out_of_scope" if intent == "unknown" else "supported" for _, intent in rows]
    SX_train, SX_test, sy_train, sy_test = train_test_split(
        scope_texts,
        scope_labels,
        test_size=0.25,
        random_state=42,
        stratify=scope_labels,
    )
    scope_eval = Pipeline([("tfidf", make_vectorizer()), ("clf", make_logreg())])
    scope_eval.fit(SX_train, sy_train)
    scope_pred = scope_eval.predict(SX_test)

    scope_model = Pipeline([("tfidf", make_vectorizer()), ("clf", make_logreg())])
    scope_model.fit(scope_texts, scope_labels)

    metrics = {
        "training_rows": len(rows),
        "supported_rows": len(supported),
        "out_of_scope_rows": len(unknown),
        "intents": sorted(set(supported_labels)),
        "selected_intent_model": selected_name,
        "intent_cross_validation": cv_results,
        "intent_holdout_accuracy": float(accuracy_score(y_test, intent_pred)),
        "intent_classification_report": classification_report(
            y_test, intent_pred, output_dict=True, zero_division=0
        ),
        "scope_holdout_accuracy": float(accuracy_score(sy_test, scope_pred)),
        "scope_classification_report": classification_report(
            sy_test, scope_pred, output_dict=True, zero_division=0
        ),
        "generative_ai": False,
    }
    REPORT.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    payload = {
        "modelName": "bonded-intent-tfidf-logreg-v2",
        "algorithm": "TF-IDF + Logistic Regression",
        "generative": False,
        "trainingRows": len(rows),
        "crossValidationAccuracy": cv_results["Logistic Regression"]["mean_accuracy"],
        "intentModel": linear_payload(intent_model),
        "scopeModel": linear_payload(scope_model),
    }

    ts = (
        "// AUTO-GENERATED by chatbot_training/train_intent_model.py\n"
        "// Do not hand-edit. Retrain the model to regenerate this file.\n\n"
        "export const CHATBOT_INTENT_MODEL = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + " as const;\n"
    )
    EXPORT.write_text(ts, encoding="utf-8")

    print(json.dumps({
        "selected_intent_model": selected_name,
        "training_rows": len(rows),
        "intent_holdout_accuracy": metrics["intent_holdout_accuracy"],
        "intent_cv_accuracy": cv_results["Logistic Regression"]["mean_accuracy"],
        "scope_holdout_accuracy": metrics["scope_holdout_accuracy"],
        "export": str(EXPORT),
    }, indent=2))

if __name__ == "__main__":
    main()

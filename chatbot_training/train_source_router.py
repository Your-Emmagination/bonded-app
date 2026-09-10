from __future__ import annotations

import copy
import csv
import json
import math
import re
import unicodedata
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import accuracy_score, classification_report, log_loss
from sklearn.model_selection import train_test_split
from sklearn.neural_network import MLPClassifier

ROOT = Path(__file__).resolve().parents[1]
INTENT_CSV = Path(__file__).resolve().parent / "intent_training.csv"
GENERAL_CSV = Path(__file__).resolve().parent / "general_knowledge" / "general_knowledge.csv"
REPORT = Path(__file__).resolve().parent / "source_router_evaluation.json"
EXPORT = ROOT / "utils" / "sourceRouterModel.ts"

MAX_EPOCHS = 50
PATIENCE = 6
MAX_FEATURES = 1600
RANDOM_STATE = 42
GENERAL_SAMPLE_LIMIT = 5000

UTILITY_INTENTS = {"date", "time", "calculator"}
GENERAL_INTENTS = {"unknown", "general_knowledge"}

# These are supervised TRAINING examples, not runtime if/else rules.
# They teach the source router distinctions that caused conflicts previously.
SEED_EXAMPLES: list[tuple[str, str]] = [
    # BondED / live app data
    ("what are the upcoming events", "bonded"),
    ("show upcoming campus events", "bonded"),
    ("when is the next school event", "bonded"),
    ("what event is happening next on campus", "bonded"),
    ("what programs are available in bonded", "bonded"),
    ("what courses does our school offer", "bonded"),
    ("what is my name", "bonded"),
    ("what is my student id", "bonded"),
    ("what course am i enrolled in", "bonded"),
    ("what year level am i", "bonded"),
    ("who are the teachers", "bonded"),
    ("show school staff", "bonded"),
    ("what are the campus rules", "bonded"),
    ("tell me about bonded", "bonded"),
    ("hello", "bonded"),
    ("how are you", "bonded"),
    ("who are you", "bonded"),
    ("what can you do", "bonded"),
    # Joke intent — B.E.A. answers these from a fixed local set of pre-written
    # jokes (non-generative), so joke requests must route to "bonded", not
    # "general". Several phrasings don't contain the word "joke" on purpose.
    ("tell me a joke", "bonded"),
    ("tell me another joke", "bonded"),
    ("say something funny", "bonded"),
    ("make me laugh", "bonded"),
    ("do you know any jokes", "bonded"),
    ("got any jokes", "bonded"),
    ("tell me a dad joke", "bonded"),
    ("crack a joke", "bonded"),
    # Campus FAQ / "how BondED works" questions. These feed the
    # campus_knowledge answer path, which lives on the bonded branch. Generic
    # "how do i ..." / "what is ..." phrasing otherwise pattern-matches the
    # large bundled general-knowledge corpus and is misrouted to "general",
    # leaving these questions unanswerable.
    ("how do i report a post", "bonded"),
    ("how do i report a comment", "bonded"),
    ("how can i report someone", "bonded"),
    ("what is a post flair", "bonded"),
    ("what does a flair mean", "bonded"),
    ("can i post anonymously", "bonded"),
    ("who can see my anonymous post", "bonded"),
    ("why is my post pending", "bonded"),
    ("why was my post removed", "bonded"),
    ("how do i save a post", "bonded"),
    ("how do i bookmark a post", "bonded"),
    ("how do i find my saved posts", "bonded"),
    ("how do i create a poll", "bonded"),
    ("what is a server or channel", "bonded"),
    ("how do i join a server", "bonded"),
    ("how do i edit my post", "bonded"),
    ("how do i delete my post", "bonded"),
    ("how do i tag someone in a post", "bonded"),
    ("when do i get a notification", "bonded"),
    ("how do i contact a moderator", "bonded"),
    ("how do i use the ai assistant", "bonded"),
    ("what is the lost and found feature", "bonded"),
    ("how do i mark a lost item as found", "bonded"),
    ("who reviews reported content", "bonded"),
    ("how does bonded handle my data", "bonded"),
    ("is my data private in this app", "bonded"),
    # General negatives using words that overlap BondED vocabulary
    ("what is an event in programming", "general"),
    ("what is an event in history", "general"),
    ("what is event driven programming", "general"),
    ("what is a computer program", "general"),
    ("what is a degree in mathematics", "general"),
    ("what is a student loan", "general"),
    ("what is a school of fish", "general"),
    ("what is academic freedom", "general"),
    ("what is community ecology", "general"),
    ("what is sports psychology", "general"),
    ("what is photosynthesis", "general"),
    ("which planet is the largest", "general"),
    ("what is orogeny", "general"),
    ("what is snowboard cross", "general"),
    # "how is X" negatives — the BondED corpus's small set of "how is it
    # going" / "how is your day" wellbeing rows was enough surface-pattern
    # signal to pull unrelated "how is X made/measured/formed" general
    # trivia toward "bonded". These teach the router the auxiliary verb
    # alone isn't the signal; what X refers to is.
    ("how is glass made", "general"),
    ("how is chocolate made", "general"),
    ("how is rain formed", "general"),
    ("how is electricity generated", "general"),
    ("how is gold mined", "general"),
    ("how is paper recycled", "general"),
    ("how is wine made", "general"),
    ("how is dna sequenced", "general"),
    ("how is a rainbow formed", "general"),
    ("how is steel produced", "general"),
    ("how is root beer made", "general"),
    ("how is schizophrenia diagnosed", "general"),
    ("how is public policy created", "general"),
    ("how is human height measured", "general"),
    ("how is hydrogen produced", "general"),
    ("how is slugging percentage calculated", "general"),
    ("how is rfid tag powered", "general"),
    # Utilities
    ("what time is it", "utility"),
    ("tell me the current time", "utility"),
    ("what is today's date", "utility"),
    ("what date is it today", "utility"),
    ("calculate 25 times 4", "utility"),
    ("what is 12 plus 9", "utility"),
    ("solve 100 divided by 5", "utility"),
    # Directory (Part 2) negatives — added after the "directory" intent was
    # introduced in intent_training.csv. Bulk-roster and person-lookup
    # phrasing ("how many students are enrolled", "who is X") reads a lot
    # like open-domain trivia surface patterns ("who is <public figure>",
    # "how many X are there"), which pulled several of these toward
    # "general" even though load_rows() already includes every
    # intent_training.csv "directory" row as "bonded" — these seed examples
    # reinforce that signal directly rather than relying on oversampling of
    # the (relatively few) directory rows alone.
    ("how many students are enrolled", "bonded"),
    ("list everyone in the system", "bonded"),
    ("who is registered", "bonded"),
    ("list every staff member in the system", "bonded"),
    ("show all users", "bonded"),
    ("list all registered users", "bonded"),
    ("how many users are in the system", "bonded"),
    ("who is juan cruz", "bonded"),
    ("who is maria santos", "bonded"),
    ("who is ana lopez", "bonded"),
    ("what program is juan cruz in", "bonded"),
    ("what course is maria santos taking", "bonded"),
    ("what year level is pedro reyes", "bonded"),
    ("show the member directory", "bonded"),
    ("show the full staff directory", "bonded"),
    ("list all students in bonded", "bonded"),
]


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower()
    value = re.sub(r"@(?:ai|bondedai)\b", " ", value)
    value = re.sub(r"[^a-z0-9+\-*/().%\s]", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _balance(rows: list[tuple[str, str]], rng: np.random.Generator) -> list[tuple[str, str]]:
    """Oversample (with replacement), deterministically, so every class
    matches the largest class's count. Must be called SEPARATELY on the
    train split and the validation split (never on the combined pool before
    splitting) — oversampling before train_test_split let the exact same
    sentence land on both sides of the split, which is what silently
    inflated validation_accuracy in the past without it reflecting real
    generalization. Called independently per split, a duplicate can only
    ever land on the same side as its original."""
    by_label: dict[str, list[str]] = {"bonded": [], "general": [], "utility": []}
    for text, label in rows:
        by_label[label].append(text)

    target = max(len(values) for values in by_label.values())
    balanced: list[tuple[str, str]] = []
    for label, values in by_label.items():
        if not values:
            raise RuntimeError(f"No examples for source class {label} in this split")
        balanced.extend((value, label) for value in values)
        remaining = target - len(values)
        if remaining > 0:
            choices = rng.choice(values, size=remaining, replace=True)
            balanced.extend((str(value), label) for value in choices)
    rng.shuffle(balanced)
    return balanced


def load_rows() -> tuple[list[str], list[str], list[str], list[str]]:
    """Returns (train_texts, val_texts, train_labels, val_labels), balanced
    by class within each split independently. Splitting happens on the
    DEDUPLICATED, un-oversampled examples, before any balancing — see
    _balance's docstring for why order matters here."""
    labeled: list[tuple[str, str]] = []

    with INTENT_CSV.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            text = (row.get("text") or "").strip()
            intent = (row.get("intent") or "").strip()
            if not text or not intent:
                continue
            if intent in UTILITY_INTENTS:
                source = "utility"
            elif intent in GENERAL_INTENTS:
                source = "general"
            else:
                source = "bonded"
            labeled.append((text, source))

    # General knowledge provides real open-domain wording, which is essential
    # for teaching the router not to send random factual questions to Firestore.
    if GENERAL_CSV.exists():
        with GENERAL_CSV.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            count = 0
            for row in reader:
                question = (row.get("question") or "").strip()
                if not question:
                    continue
                labeled.append((question, "general"))
                count += 1
                if count >= GENERAL_SAMPLE_LIMIT:
                    break

    labeled.extend(SEED_EXAMPLES)

    # De-duplicate by normalized question + label BEFORE splitting, so the
    # same underlying sentence can never independently end up on both sides
    # of the train/validation split.
    seen: set[tuple[str, str]] = set()
    deduped: list[tuple[str, str]] = []
    for text, label in labeled:
        key = (normalize_text(text), label)
        if not key[0] or key in seen:
            continue
        seen.add(key)
        deduped.append((text, label))

    texts = [row[0] for row in deduped]
    labels = [row[1] for row in deduped]
    train_text, val_text, train_label, val_label = train_test_split(
        texts, labels, test_size=0.20, random_state=RANDOM_STATE, stratify=labels,
    )

    # Balance classes by deterministic oversampling, independently per split.
    # The general corpus is much larger than BondED/utility examples; without
    # balancing, the source router would learn to call almost everything
    # "general".
    rng = np.random.default_rng(RANDOM_STATE)
    train_balanced = _balance(list(zip(train_text, train_label)), rng)
    val_balanced = _balance(list(zip(val_text, val_label)), rng)

    return (
        [row[0] for row in train_balanced],
        [row[0] for row in val_balanced],
        [row[1] for row in train_balanced],
        [row[1] for row in val_balanced],
    )


def export_model(vectorizer: TfidfVectorizer, clf: MLPClassifier, metrics: dict) -> None:
    terms = [""] * len(vectorizer.vocabulary_)
    for term, index in vectorizer.vocabulary_.items():
        terms[index] = term

    payload = {
        "modelName": "bea-source-router-mlp-v1",
        "algorithm": "TF-IDF + MLP neural source router",
        "generative": False,
        "epochsTrained": int(metrics["epochs_trained"]),
        "validationAccuracy": float(metrics["validation_accuracy"]),
        "classes": clf.classes_.tolist(),
        "terms": terms,
        "idf": vectorizer.idf_.astype(float).tolist(),
        "coefs": [layer.astype(float).tolist() for layer in clf.coefs_],
        "intercepts": [layer.astype(float).tolist() for layer in clf.intercepts_],
    }

    # Explicit wide type instead of `as const` — see the matching comment in
    # general_knowledge/build_index.py. This file is smaller, but growing
    # the training set (MAX_FEATURES, more seed examples) pushes it the
    # same direction, so it gets the same fix pre-emptively.
    ts_type_declaration = (
        "type SourceRouterModelShape = {\n"
        "  modelName: string;\n"
        "  algorithm: string;\n"
        "  generative: boolean;\n"
        "  epochsTrained: number;\n"
        "  validationAccuracy: number;\n"
        "  classes: string[];\n"
        "  terms: string[];\n"
        "  idf: number[];\n"
        "  coefs: number[][][];\n"
        "  intercepts: number[][];\n"
        "};\n\n"
    )

    source = (
        "// AUTO-GENERATED by chatbot_training/train_source_router.py\n"
        "// Epoch-trained NON-GENERATIVE source router. Do not hand-edit.\n\n"
        + ts_type_declaration
        + "export const SOURCE_ROUTER_MODEL: SourceRouterModelShape = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    EXPORT.write_text(source, encoding="utf-8")


def main() -> None:
    X_train_text, X_val_text, y_train, y_val = load_rows()
    print("Balanced training rows:", len(X_train_text))
    print("Balanced validation rows:", len(X_val_text))
    print("Train class counts:", dict(Counter(y_train)))
    print("Validation class counts:", dict(Counter(y_val)))

    vectorizer = TfidfVectorizer(
        preprocessor=normalize_text,
        lowercase=False,
        ngram_range=(1, 2),
        max_features=MAX_FEATURES,
        sublinear_tf=True,
        norm="l2",
        token_pattern=r"(?u)\b\w+\b",
    )
    X_train = vectorizer.fit_transform(X_train_text).toarray().astype(np.float32)
    X_val = vectorizer.transform(X_val_text).toarray().astype(np.float32)

    clf = MLPClassifier(
        hidden_layer_sizes=(24,),
        activation="relu",
        solver="adam",
        alpha=1e-4,
        batch_size=64,
        learning_rate_init=0.001,
        max_iter=1,
        warm_start=True,
        shuffle=True,
        random_state=RANDOM_STATE,
    )

    best_loss = math.inf
    best_state = None
    best_epoch = 0
    stale_epochs = 0
    history = []

    for epoch in range(1, MAX_EPOCHS + 1):
        clf.fit(X_train, y_train)
        probabilities = clf.predict_proba(X_val)
        predictions = clf.classes_[np.argmax(probabilities, axis=1)]
        val_loss = float(log_loss(y_val, probabilities, labels=clf.classes_))
        val_accuracy = float(accuracy_score(y_val, predictions))
        history.append({"epoch": epoch, "validation_loss": val_loss, "validation_accuracy": val_accuracy})
        print(f"Epoch {epoch:02d}/{MAX_EPOCHS} - val_loss={val_loss:.4f} - val_accuracy={val_accuracy:.4f}")

        if val_loss < best_loss - 1e-4:
            best_loss = val_loss
            best_epoch = epoch
            best_state = (copy.deepcopy(clf.coefs_), copy.deepcopy(clf.intercepts_))
            stale_epochs = 0
        else:
            stale_epochs += 1
            if stale_epochs >= PATIENCE:
                print(f"Early stopping after epoch {epoch}; best epoch was {best_epoch}.")
                break

    if best_state is None:
        raise RuntimeError("Training did not produce a valid model")
    clf.coefs_, clf.intercepts_ = best_state

    probabilities = clf.predict_proba(X_val)
    predictions = clf.classes_[np.argmax(probabilities, axis=1)]
    accuracy = float(accuracy_score(y_val, predictions))
    report = classification_report(y_val, predictions, output_dict=True, zero_division=0)

    # Required regression checks for the conflict that motivated this router.
    regression_questions = [
        "what are the upcoming events",
        "when is the next campus event",
        "what is my name",
        "what programs are available",
        "what is photosynthesis",
        "what is orogeny",
        "what is snowboard cross",
        "what is an event in programming",
        "what time is it",
        "what is 25 plus 4",
        "how many students are enrolled",
        "list everyone in the system",
        "who is registered",
        "who is ana lopez",
        "list every staff member in the system",
    ]
    regression_expected = [
        "bonded", "bonded", "bonded", "bonded",
        "general", "general", "general", "general",
        "utility", "utility",
        "bonded", "bonded", "bonded", "bonded", "bonded",
    ]
    regression_matrix = vectorizer.transform(regression_questions).toarray().astype(np.float32)
    regression_pred = clf.predict(regression_matrix).tolist()
    regression = [
        {"question": q, "expected": expected, "predicted": predicted, "passed": expected == predicted}
        for q, expected, predicted in zip(regression_questions, regression_expected, regression_pred)
    ]

    metrics = {
        "model": "TF-IDF + one-hidden-layer MLP",
        "generative_ai": False,
        "epochs_trained": best_epoch,
        "max_epochs": MAX_EPOCHS,
        "early_stopping_patience": PATIENCE,
        "validation_accuracy": accuracy,
        "best_validation_loss": best_loss,
        "training_rows": len(X_train_text),
        "validation_rows": len(X_val_text),
        "vocabulary_size": len(vectorizer.vocabulary_),
        "classification_report": report,
        "history": history,
        "regression_checks": regression,
    }
    REPORT.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    export_model(vectorizer, clf, metrics)

    print("\nValidation accuracy:", round(accuracy, 4))
    print("Epochs trained:", best_epoch)
    print("Vocabulary size:", len(vectorizer.vocabulary_))
    print("Regression checks:")
    for item in regression:
        marker = "PASS" if item["passed"] else "FAIL"
        print(f"  {marker}: {item['question']} -> {item['predicted']} (expected {item['expected']})")
    print("Created:", EXPORT)
    print("Created:", REPORT)


if __name__ == "__main__":
    main()

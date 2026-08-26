from pathlib import Path
import pandas as pd
from datasets import load_dataset

BASE = Path(__file__).parent
OUTPUT = BASE / "general_knowledge.csv"

TARGET_NQ = 8000
TARGET_TRIVIA = 5000
TARGET_SCIQ = 3000

rows = []

# ---------------------------------------------------------
# 1. Natural Questions Open
# ---------------------------------------------------------

print("Loading Natural Questions Open...")

nq = load_dataset(
    "google-research-datasets/nq_open",
    split="train"
)

count = 0

for item in nq:
    question = str(item.get("question", "")).strip()

    answers = item.get("answer", [])

    if not question or not answers:
        continue

    if isinstance(answers, list):
        answer = str(answers[0]).strip()
    else:
        answer = str(answers).strip()

    if not answer:
        continue

    rows.append({
        "question": question,
        "answer": answer,
        "source": "nq_open"
    })

    count += 1

    if count >= TARGET_NQ:
        break

print("Natural Questions added:", count)


# ---------------------------------------------------------
# 2. TriviaQA
# ---------------------------------------------------------

print("Loading TriviaQA...")

trivia = load_dataset(
    "mandarjoshi/trivia_qa",
    "unfiltered.nocontext",
    split="train"
)

count = 0

for item in trivia:
    question = str(item.get("question", "")).strip()

    answer_data = item.get("answer", {})

    answer = ""

    if isinstance(answer_data, dict):
        answer = str(
            answer_data.get("value")
            or answer_data.get("normalized_value")
            or ""
        ).strip()

    if not question or not answer:
        continue

    rows.append({
        "question": question,
        "answer": answer,
        "source": "trivia_qa"
    })

    count += 1

    if count >= TARGET_TRIVIA:
        break

print("TriviaQA added:", count)


# ---------------------------------------------------------
# 3. SciQ
# ---------------------------------------------------------

print("Loading SciQ...")

sciq = load_dataset(
    "allenai/sciq",
    split="train"
)

count = 0

for item in sciq:
    question = str(item.get("question", "")).strip()
    answer = str(item.get("correct_answer", "")).strip()

    if not question or not answer:
        continue

    rows.append({
        "question": question,
        "answer": answer,
        "source": "sciq"
    })

    count += 1

    if count >= TARGET_SCIQ:
        break

print("SciQ added:", count)


# ---------------------------------------------------------
# 4. Convert to dataframe
# ---------------------------------------------------------

df = pd.DataFrame(rows)

print()
print("Before cleaning:", len(df))


# ---------------------------------------------------------
# 5. Clean empty data
# ---------------------------------------------------------

df["question"] = (
    df["question"]
    .fillna("")
    .astype(str)
    .str.strip()
)

df["answer"] = (
    df["answer"]
    .fillna("")
    .astype(str)
    .str.strip()
)

df = df[
    (df["question"].str.len() > 2)
    & (df["answer"].str.len() > 0)
]


# ---------------------------------------------------------
# 6. Remove extremely long answers
# ---------------------------------------------------------

df = df[
    df["answer"].str.len() <= 1000
]


# ---------------------------------------------------------
# 7. Remove duplicate questions
# ---------------------------------------------------------

df["question_normalized"] = (
    df["question"]
    .str.lower()
    .str.replace(r"\s+", " ", regex=True)
)

df = df.drop_duplicates(
    subset=["question_normalized"],
    keep="first"
)

df = df.drop(columns=["question_normalized"])


# ---------------------------------------------------------
# 8. Shuffle
# ---------------------------------------------------------

df = df.sample(
    frac=1,
    random_state=42
).reset_index(drop=True)


# ---------------------------------------------------------
# 9. Save
# ---------------------------------------------------------

df.to_csv(
    OUTPUT,
    index=False
)

print()
print("General knowledge dataset prepared successfully!")
print("Final Q&A count:", len(df))
print("Created:", OUTPUT)

print()
print("Source counts:")
print(df["source"].value_counts())
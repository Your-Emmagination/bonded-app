from pathlib import Path
import pandas as pd

BASE = Path(__file__).parent

files = [
    BASE / "train.csv",
    BASE / "validation.csv",
    BASE / "test.csv"
]

frames = []

for file in files:
    df = pd.read_csv(file)
    frames.append(df)

dataset = pd.concat(frames, ignore_index=True)

# Keep only correct answers
dataset = dataset[dataset["label"] == 1]

# Keep only needed columns
dataset = dataset[["question", "answer"]]

# Remove duplicates
dataset = dataset.drop_duplicates()

dataset.to_csv(BASE / "general_knowledge.csv", index=False)

print("General knowledge created!")
print("Questions:", len(dataset))
# BondED Non-Generative Chatbot Training

This folder trains the BondED/B.E.A. intent classifier without using an LLM or generative AI.

## Architecture

1. `intent_training.csv` contains labeled example questions.
2. `train_intent_model.py` converts text to TF-IDF features.
3. The script evaluates Multinomial Naive Bayes, Logistic Regression, and Linear SVM.
4. A Logistic Regression model is exported to `utils/chatbotIntentModel.ts` when its validation performance is competitive with the best candidate.
5. The app runs the exported model locally in TypeScript.
6. Firestore provides the factual answers. Response text remains controlled/template-based.

The runtime does not contain the training examples and does not match exact questions.

## Current evaluation

- Training rows: 290
- Supported-intent rows: 250
- Out-of-scope rows: 40
- Intent 5-fold CV accuracy (Logistic Regression): 0.832
- Intent holdout accuracy: 0.778
- Out-of-scope holdout accuracy: 0.890

These values are a baseline, not a guarantee of production accuracy. Add real anonymized student phrasing to the CSV and retrain before final evaluation.

## Retrain

From the BondED project root:

```bash
python -m pip install -r chatbot_training/requirements.txt
python chatbot_training/train_intent_model.py
```

The trainer regenerates:

```text
utils/chatbotIntentModel.ts
chatbot_training/evaluation_report.json
```

Do not manually edit `chatbotIntentModel.ts`.

## How to improve accuracy

Add diverse examples to `intent_training.csv`. Do not add answers to the training data. Each row should contain only:

```text
text,intent
```

For example:

```text
"could you show the programs students can enroll in?",programs
"when will foundation week start?",events
"which course am i enrolled in?",user_profile
```

Then retrain and compare the evaluation report.

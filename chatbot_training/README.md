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

- Training rows: 602
- Supported-intent rows: 490
- Out-of-scope rows: 112
- Intent 5-fold CV accuracy (Logistic Regression): 0.871
- Intent holdout accuracy: 0.870
- Out-of-scope holdout accuracy: 0.934

These values are a baseline, not a guarantee of production accuracy. Add real anonymized student phrasing to the CSV and retrain before final evaluation.

## Intents

- `programs` — answered from the `programs` Firestore collection.
- `events` — answered from the `events` Firestore collection.
- `staff_directory` — "who are the teachers/moderators/admins" questions, answered from the `students` Firestore collection (`role` field). The reply is filtered to whichever of the words "teacher", "moderator", or "admin" actually appear in the question — e.g. "who are the teachers" only returns teachers, "who are the teachers and moderators" returns both but not admins. If none of those words appear (e.g. "list the staff", "who manages this app"), all three roles are shown together. Only `firstname`/`lastname` are ever surfaced — no email, studentID, or other profile fields.
- `campus_knowledge` — "how BondED works" and school-policy questions, answered from the staff-maintained `campusFaq` Firestore collection with the bundled offline FAQ index (`utils/campusKnowledgeIndex.ts`) as a fallback.

## Post-flair answer sources

Beyond the trained intents, `answerFromAnySource` also grounds replies in recent approved `posts`, matched by token overlap (same minimum-match threshold of 2 as AI Memory):

- **Announcement posts** — staff-authored, scanned unconditionally as a last resort (90-day window).
- **Lost & Found posts** — only when the query mentions lost/found/missing/misplaced; resolved posts are excluded (21-day window).
- **Help / Advice posts** — only when the query itself is help-seeking (help/advice/struggling/explain/stuck/confused); surfaces related peer questions (45-day window). Checked after campus knowledge since it is student-authored, lower-authority content.

## Filipino / Taglish support

The classifier is not bilingual in the sense of having a separate language path — it widens the same English pipeline instead:

- `SYNONYMS` (in `utils/nonGenerativeChatbot.ts`) maps common Tagalog/Taglish content words (`kailan`, `ano`, `sino`, `saan`, and the `tulong`/`tumulong`/`matulungan`/`makakatulong` family) to the English canonical words the training data already uses heavily, so a Taglish question can land on the same vocabulary an equivalent English question would.
- `paano` ("how") is deliberately **not** synonym-mapped, even though it easily could be — `how` is heavily weighted toward the `wellbeing` intent in the English training data ("how are you", "how is it going", ...), so routing `paano` through it pulled help-intent Taglish questions like "paano ka makakatulong" toward the wrong intent. It's left as its own token and taught directly via the Taglish training rows below instead.
- `FILLER_WORDS` strips pure Tagalog grammatical particles with no content signal (`mga`, `ang`, `yung`, `po`, `na`, `ba`) so adjacent content words stay next to each other for bigram matching. Pronouns like `ka`/`mo` are deliberately left alone — `kamusta ka` (wellbeing) needs to stay distinguishable from bare `kamusta`/`kumusta` (greeting).
- `KNOWN_TYPO_OVERRIDES` covers a few common Taglish shortenings (`pano`→`paano`, `kmusta`/`kamsta`→`kamusta`, `slmt`/`salamt`→`salamat`).
- `intent_training.csv` has Taglish rows added for `greeting`, `thanks`, `goodbye`, `programs`, `events`, and `help`, plus extra `user_identity` rows for "do you know me"-style phrasing.

Reply text itself stays in English for now — only the *understanding* side is bilingual. Localizing reply text is a separate, not-yet-scoped follow-up.

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

## Epoch-trained source router

B.E.A. now has a first-stage non-generative source router trained with epochs.
It decides which knowledge source may answer before the existing intent/retrieval
logic runs:

- `bonded` -> BondED/local conversation + live Firestore only
- `general` -> bundled general-knowledge retrieval only
- `utility` -> calculator/date/time only

Train/retrain it from the project root:

```bash
python chatbot_training/train_source_router.py
```

The trainer uses `intent_training.csv` plus a sample of
`general_knowledge/general_knowledge.csv`, trains a one-hidden-layer MLP with
validation + early stopping, and regenerates:

- `utils/sourceRouterModel.ts`
- `chatbot_training/source_router_evaluation.json`

The model is non-generative. It only selects a source; it does not write answers.
Changing Firestore events, profiles, programs, or other live data does not require
retraining because the router learns the type of request, while Firestore remains
the source of the current answer.

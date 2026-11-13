# BondED Non-Generative Chatbot

This is B.E.A.'s on-phone bot. B.E.A. normally answers with GPT (on Groq)
through the Cloudflare Worker (see `docs/bea-ai.md`); this bot answers the easy
messages that never need the AI, and everything else whenever the AI is
switched off, over its free limit, or unreachable. It uses no LLM: a supervised
Multinomial Naive Bayes intent classifier, trained from labeled example
phrases in `utils/nonGenerativeChatbot.ts`, picks the intent, and the answer
comes from fixed code or BondED's own data.

## Supported intents

- greeting
- help
- date
- time
- calculator
- upcoming campus events
- academic programs
- campus knowledge retrieval

## Response sources

The classifier only decides the user's intent. Answers are deterministic:

- date/time: device clock
- calculator: built-in arithmetic parser (no `eval`)
- events: Firestore `events`
- programs: Firestore `programs`
- campus knowledge: `campusFaq` Firestore records, plus active `aiMemory` records
- announcement posts: recent approved posts with the Announcement flair (Firestore `posts`), scanned as a last resort
- Lost & Found: recent approved, unresolved posts with the Lost & Found flair (Firestore `posts`), only when the query mentions lost/found/missing/misplaced
- Help / Advice: recent approved posts with the Help / Advice flair (Firestore `posts`), only when the query itself is help-seeking (help/advice/struggling/explain/stuck/confused)
- unknown questions: safe fallback message

## Three sources: bonded, campus, utility

`utils/sourceRouter.ts` (a TF-IDF + MLP model, `utils/sourceRouterModel.ts`,
trained by `chatbot_training/train_source_router.py`) decides where a
question belongs:

- **bonded** — BondED's own data and campus knowledge (the sources above)
- **utility** — date, time and the calculator
- **general** — world knowledge (facts, definitions, weather). This bot
  doesn't answer these any more: it says it can't look that up right now.
  World knowledge is the AI's job.

The old general-knowledge code (the Wikipedia/Wiktionary/weather/currency
lookups in `utils/generalKnowledgeApi.ts`, its Firestore cache
`chatbotKnowledgeCache`, the bundled offline index and its build scripts) has
been removed. `chatbot_training/general_knowledge/general_knowledge.csv` stays
because the source router is trained on it — it's how the router learns what
"general" looks like.

`npm run test:router` is a no-network regression check: BondED and campus
questions must never be routed to "general", or a student is told "I can't
look that up" about their own school. Re-run it after any retrain.

## Improving accuracy

Add more labeled natural-language examples to `TRAINING_EXAMPLES`. The classifier is rebuilt in memory when the app loads. Keep examples representative of how students actually phrase questions.

# BondED Non-Generative Chatbot

The BondED chatbot no longer uses an LLM for replies. The app-side chatbot uses a supervised Multinomial Naive Bayes intent classifier trained from labeled example phrases in `utils/nonGenerativeChatbot.ts`.

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
- campus knowledge: active `aiMemory` records already stored in BondED/Firestore
- unknown questions: safe fallback message

The chatbot does not generate free-form answers and does not call ChatGPT, Gemini, Grok, Claude, Groq, or another LLM.

## Improving accuracy

Add more labeled natural-language examples to `TRAINING_EXAMPLES`. The classifier is rebuilt in memory when the app loads. Keep examples representative of how students actually phrase questions.

## Important remaining work

Text moderation in the existing Cloudflare worker is still the previous implementation and should be replaced separately with the planned non-generative text-classification moderation system. Image moderation remains unchanged/local as requested.

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
- campus knowledge: `campusFaq` Firestore records, plus active `aiMemory` records
- **general knowledge** (only when the source router picks `general` —
  see `utils/sourceRouter.ts`): retrieved live from free public APIs, never
  bundled or generated. See "General knowledge" below.
- announcement posts: recent approved posts with the Announcement flair (Firestore `posts`), scanned as a last resort
- Lost & Found: recent approved, unresolved posts with the Lost & Found flair (Firestore `posts`), only when the query mentions lost/found/missing/misplaced
- Help / Advice: recent approved posts with the Help / Advice flair (Firestore `posts`), only when the query itself is help-seeking (help/advice/struggling/explain/stuck/confused)
- unknown questions: safe fallback message

The chatbot does not generate free-form answers and does not call ChatGPT, Gemini, Grok, Claude, Groq, or another LLM.

## General knowledge

Previously a bundled 6 MB offline TF-IDF index (`utils/generalKnowledgeIndex.ts`,
built from Natural Questions/TriviaQA/SciQ). That index, its retrieval code
(`utils/chatbotKnowledge.ts`), and the `chatbot_training/general_knowledge/`
build pipeline have been **removed**.

General knowledge is now retrieved live, in this order, from
`utils/generalKnowledgeApi.ts` (each provider returns `null` immediately if
its trigger doesn't match, so no network call is made unless it's relevant):

1. **Frankfurter** (currency conversion / exchange rates)
2. **Open-Meteo** (current weather, with a geocoding lookup for the place)
3. **Wiktionary** (word definitions — "define X" / "what does X mean")
4. **Wikipedia** (full-text search → full plain-text intro section) — the
   catch-all for everything else, including country facts

Every answer is the **full text returned by the source, not truncated** —
the app does not shorten it, and shows the retrieved sentences on their own
with no citation line appended. This is still non-generative: the text is
retrieved from a cited source, never composed by a model.

Before hitting an API, a normalized question key is checked against the
`chatbotKnowledgeCache` Firestore collection (`utils/knowledgeCache.ts`). A
fresh Wikipedia/Wiktionary answer is cached (fire-and-forget)
so the same question next time is answered instantly with no API call.
Weather and FX answers are time-sensitive and are **never** cached.

### Reaching the general branch, and staying out of BondED's way

`utils/sourceRouter.ts` (a TF-IDF + MLP model, `utils/sourceRouterModel.ts`,
trained by `chatbot_training/train_source_router.py`) decides whether a
prompt is `general`. Two things sit around it so the two knowledge sources
never answer each other's questions:

- `hasGeneralKnowledgeTrigger` rescues an unmistakable currency / weather /
  dictionary phrasing the router doesn't recognise (it is retrained
  periodically, so it lags behind capabilities added straight to
  `generalKnowledgeApi.ts`). It can only ever ADD a question to the general
  branch.
- When the router picks `bonded` but with low confidence
  (`ROUTER_UNSURE_BELOW` in `nonGenerativeChatbot.ts`) **and** BondED's own
  data turns up nothing, the question is handed to general knowledge instead
  of returning "I couldn't find an answer". BondED data always gets first
  refusal, and a confident bonded routing never reaches this path — so a
  campus question is never answered from Wikipedia.

`npm run test:router` is a permanent, no-network regression check covering
both directions (campus questions must not reach Wikipedia; world-knowledge
questions must not be sent to the campus handlers). Re-run it after any
retrain.

### How a question becomes an answer

The Wikipedia lookup uses the MediaWiki **full-text search** (`list=search`)
rather than `action=opensearch`. That distinction is the reason the pipeline
no longer needs question-shape rules: `opensearch` is a title-PREFIX
completion API, so an ordinary question ("who founded amazon company")
matched nothing at all and had to be rescued by hand-written logic that
shaved words off each end of the sentence until something stuck. Full-text
search ranks by relevance over article text, so phrasings nobody anticipated
resolve on their own.

Results are then re-ranked by `scoreTitle`, because search's own top hit is
sometimes a same-topic neighbour — for "when was python programming language
created" it returns "Mojo (programming language)" first. Ranking is:

1. **coverage** — the fraction of the title's own subject words the question
   accounts for. A title's parenthetical is Wikipedia's disambiguator, not
   part of the subject's name, so it is excluded from the subject and only
   breaks ties (otherwise "Python (programming language)" is penalised for
   being precise and a bare "what is python" lands on "Monty Python").
2. **questionMatches** — how much of the question the title accounts for,
   which separates "Philippine Revolution" from plain "Revolution" when both
   are fully covered.
3. Wikipedia's own relevance order, for anything still tied.

Candidates are opened best-first and disambiguation pages (flagged by
MediaWiki's `pageprops.disambiguation`) are skipped rather than served as an
answer. Accents are folded on both sides so "jose rizal" matches "José
Rizal".

The reply is the retrieved text alone — no citation line. The source is
still recorded on the answer object and in the Firestore cache for
provenance, it just isn't printed into the chat bubble.

**English only.** A Tagalog/Cebuano layer (stopwords, a translation
glossary, a router rescue, Taglish training examples) was built and then
removed: Wikipedia's index is English, so translated fragments produced
confidently wrong matches — "sino ang nag-imbento ng telepono" resolved to
the Indian state "Nagaland" — rather than better ones. Non-English questions
now stay with the campus/bonded handlers. Note this is separate from the
intent classifier's own Taglish synonym map in `nonGenerativeChatbot.ts`,
which is what lets students ask *campus* questions in Taglish; that is
untouched and still works.

## Improving accuracy

Add more labeled natural-language examples to `TRAINING_EXAMPLES`. The classifier is rebuilt in memory when the app loads. Keep examples representative of how students actually phrase questions.

## Important remaining work

Text moderation in the existing Cloudflare worker is still the previous implementation and should be replaced separately with the planned non-generative text-classification moderation system. Image and video moderation now runs in that same Worker (`moderateMediaWithOpenModeration` in `cloudflare/ai-worker/src/index.js`) on the same pass as the post/comment text — a student item with media is approved only when both text and every attachment come back clean, otherwise it stays pending for review.

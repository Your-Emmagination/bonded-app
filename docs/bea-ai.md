# B.E.A.'s AI (GPT on Groq)

B.E.A. understands questions with `openai/gpt-oss-20b`, OpenAI's open GPT
model, run by Groq on its free tier. It answers school questions from
BondED's own data. The AI never connects to Firestore: it asks
the Cloudflare Worker for one of a few approved tools, and the Worker runs that
one query and returns only safe fields.

```
Phone ──(question, recent messages, sign-in token)──▶ Cloudflare Worker
                                                          │ checks who is asking
                                                          ▼
                                                     GPT on Groq ── "I need get_upcoming_events"
                                                          │
                              Worker runs that tool on Firestore, keeps only
                              the allowlisted fields, sends them back
                                                          ▼
                                                   GPT writes the reply ──▶ Phone
```

If the Worker can't answer (no key yet, switched off, over Groq's free limit,
offline, slow), the app falls back to the original on-phone bot
(`utils/nonGenerativeChatbot.ts`, see `docs/non-generative-chatbot.md`). So
B.E.A. always answers something.

## Files

| File | What it does |
|---|---|
| `cloudflare/ai-worker/src/beaTools.js` | The tools, the collection names and the field allowlists |
| `cloudflare/ai-worker/src/index.js` | The `bea-chat` endpoint: sign-in check, rate limit, Groq calls, answer cache |
| `utils/beaChat.ts` | The app side: calls the Worker, falls back to the on-phone bot |
| `utils/directMessageChecks.ts` | `@bea` in DMs and the DM photo/video check |
| `app/(main)/(tabs)/AiChatScreen.tsx` | Sends each question with the last 10 messages |
| `scripts/test-bea-tools.ts` | `npx tsx scripts/test-bea-tools.ts` — tools, allowlists, no network |

## Turning it on

1. B.E.A. uses the same `GROQ_API_KEY` Worker secret the video captions
   already use. If it isn't set yet (it must never go in the app or in any
   file):
   ```
   cd cloudflare/ai-worker
   npx wrangler secret put GROQ_API_KEY
   ```
2. It's free, within Groq's limits for the model: requests and tokens per
   minute and per day. See them at console.groq.com → Settings → Limits.
   Every question carries B.E.A.'s instructions, its tools and the last few
   messages, so the tokens-per-minute limit is the one reached first. Past a
   limit, Groq answers 429 (or 413 for "too many tokens this minute"), the
   Worker answers `quota`, and the app answers from the on-phone bot until
   the limit resets.
3. Optional: pick the model. The default is `openai/gpt-oss-20b`
   (`BEA_DEFAULT_MODEL` in `src/index.js`). To change it without editing
   code, add to `wrangler.toml` under `[vars]`: `BEA_MODEL = "…"`. Any Groq
   chat model with tool calling works; each has its own free limits.
4. Deploy: `npx wrangler deploy`, then build the APK.

## Turning it off

In the Firebase console, create the document `appSettings/bea` with the field
`aiEnabled` = `false`. Phones pick it up within five minutes and go back to
the on-phone bot. No new APK needed. Set it to `true` (or delete the document)
to turn it back on. (The old `geminiEnabled` field still works the same way.)

## Old answers

Answers are cached in `beaAnswerCache` (see below). Every cache key includes
`BEA_CACHE_VERSION` (`src/index.js`), so answers saved by an earlier AI (Gemini)
are never given again. Bump it whenever the AI or its instructions
change enough that old answers shouldn't be reused. Old entries expire on
their own (a week at most); deleting the `beaAnswerCache` collection in the
Firebase console clears them at once.

## The tools

| Tool | Reads | Gives the AI only |
|---|---|---|
| `get_upcoming_events` | `events` | title, dates, times, venue, audience, cancelled |
| `get_academic_programs` | `programs` | name, code, description |
| `search_campus_knowledge` | `campusFaq`, global AI Memory | the best matching question/answer entries |
| `get_announcements` | approved Announcement posts | text, date, who posted (unless anonymous) |
| `find_lost_and_found` | approved, open Lost & Found posts | text, status, date — never who posted |
| `find_staff` | staff profiles | name, role, and a teacher's position (Faculty, Program Chair, Dean) |
| `get_school_officers` | `schoolOfficers` | position, name, school year |

Collection and field names are in the CONFIG block at the top of
`beaTools.js`. Change them there if your database uses different names.

**School officers** — this collection doesn't exist yet, so B.E.A. says it
couldn't find the officers. To add them, create documents in `schoolOfficers`
like: `{ position: "President", name: "Juan Santos", schoolYear: "2026-2027", order: 1, active: true }`.

## Privacy

The Worker reads Firestore with a service account, which firestore.rules
don't apply to. So the tools protect the data themselves:

- Every request is checked against the person's sign-in token.
- Each tool asks Firestore for its listed fields only. Emails, phone numbers,
  ID numbers, private records, messages and the people behind anonymous posts
  are never read.
- the AI can only pick a tool and fill in checked values. It can't write its
  own query or name a collection.
- There is no tool for anyone's contact details, and the AI is told to refuse.
- Each person can ask 30 questions an hour (`BEA_HOURLY_LIMIT` to change it).

## Saving the free allowance

Three things keep AI calls for questions that need them:

1. **Easy messages never leave the phone.** Greetings, thanks, goodbyes,
   "who are you", the date and time, and plain sums ("25 * 4") are answered
   by `answerQuickLocally` in `utils/nonGenerativeChatbot.ts`. It's narrow on
   purpose: short messages only, and only when the intent model is sure, so
   "hi, who is our school president?" still goes to the AI.
   `npx tsx scripts/test-bea-quick.ts` checks both directions.
2. **General answers are kept a week** in `beaAnswerCache`: a question asked
   on its own (not a follow-up), with no school data, is answered from there
   the next time anyone asks it the same way.
3. **School answers are kept ten minutes**, per program: when a class asks
   "what events are coming up?" at once, the AI answers the first student
   and the rest get the same answer. Ten minutes keeps it fresh; an answer
   where a tool failed is never kept.

Follow-up questions are never answered from the cache, since their meaning
depends on the conversation.

## @bea in DMs

Typing `@bea` in a direct message (the composer offers B.E.A. when you type
`@`) asks B.E.A. to answer that message in the chat, for both people to see.

- The phone sends only the conversation and message ids (`bea-dm-reply`).
  The Worker reads that one message itself, checks that the caller wrote it,
  that it mentions `@bea` and is under ten minutes old, and sends only its
  text (without `@bea`) to the AI. The rest of the conversation never leaves.
- The reply is saved as `bea_<messageId>`, sender `ai-assistant`, with
  `aiAssistant: true`, as a reply to the question. Asking twice can't make
  two replies. The app shows it with B.E.A.'s orb and name.
- It counts toward the same 30-an-hour allowance as the B.E.A. tab. It's
  never cached, and markdown is flattened because DM bubbles show plain text.

## DM photo and video check

Before a photo or video in a DM is sent, the phone asks the Worker
(`moderate-dm-media`) to check the uploaded copy with the same image checks
posts use (OpenAI image moderation, and Sightengine when it's set up; a video
is checked as three frames).

- **Something found:** the message isn't sent and a red "Photo blocked"
  box says what was found. Nothing is saved and no staff member is told.
- **Check couldn't run** (provider down, Worker unreachable, or more than 60
  checks in an hour): the photo is sent anyway.
- Only this app's Cloudinary uploads are accepted, and only people in the
  conversation can ask. GIFs from the GIF picker aren't checked.
- The phone runs this check, so a modified app could skip it. Posts are
  different: the Worker checks those after they're saved.

## Testing a tool without the AI

A staff account can see a tool's raw answer by posting to the Worker with its
sign-in token:

```json
{ "mode": "bea-chat", "dryRun": true, "tool": "get_upcoming_events", "args": { "limit": 3 } }
```

# Bonded AI Worker

This Worker keeps the AI backend hosted without Firebase Functions.

## What it stores

- Your app chat history remains in Firestore.
- The Worker is stateless. It receives recent thread context in the request and returns a reply.
- The shared AI cooldown stays in Firestore in `aiAssistantCooldowns/{serverId}_{channelId}`.

## Setup

1. Create a Cloudflare account.
2. Install Wrangler:

```bash
npm install -g wrangler
```

3. Log in:

```bash
wrangler login
```

4. In this folder, create `.dev.vars` from `.dev.vars.example`.
5. Put your Groq key in `GROQ_API_KEY`.
6. Deploy:

```bash
wrangler deploy
```

7. Copy the deployed Worker URL.
8. In your Expo app environment, set:

```env
EXPO_PUBLIC_AI_WORKER_URL=https://your-worker-name.your-subdomain.workers.dev
```

## Default model

- `llama-3.1-8b-instant`

You can change it by setting `GROQ_MODEL`.

## Image & video moderation

`moderate-firestore-post` and `moderate-firestore-content` now check any
image/video attachment on the same pass as the post/comment text. A student
item with media is approved only when the text AND every attachment come
back clean; anything flagged (or any check that can't complete) holds it as
pending for a human reviewer. Nothing auto-rejects — the two outcomes are
"approved" and "pending review".

- **Images** are sent to the moderation model as an image input.
- **Videos** are sampled: the Worker turns the Cloudinary video URL into a
  few still-frame JPEGs (`so_<seconds>` transform) and moderates each as an
  image. A non-Cloudinary video is sent to the provider as a video attachment.
- Same key, model and per-category thresholds as text moderation
  (`OPENMODERATION_*`), so the school-safety thresholds (sexual, sexual/
  minors, violence/graphic, self-harm) apply to media too.

Two image layers run in parallel and the item is held if EITHER flags:

1. **OpenAI moderation** (always) -- sexual, violence, violence/graphic,
   self-harm. It has no class for weapons, drugs or hate symbols, so on its
   own a plain weapon photo passes.
2. **Sightengine** (only if configured) -- fills exactly that gap: weapon,
   recreational_drug, medical, offensive (nazi / confederate / supremacist /
   terrorist symbols, offensive gestures). A weapon or hate-symbol hit is
   treated as critical, same as the text keyword backstop.

### `SIGHTENGINE_API_USER` / `SIGHTENGINE_API_SECRET`

From the Sightengine dashboard (sightengine.com). Add both as secrets:

```bash
wrangler secret put SIGHTENGINE_API_USER
wrangler secret put SIGHTENGINE_API_SECRET
```

If they are not set, the Sightengine layer is silently skipped and only the
OpenAI layer runs. If they are set but a check fails, the item fails closed
(pending).

Optional `[vars]`:

- `SIGHTENGINE_MODELS` -- comma-separated model list, default
  `weapon,recreational_drug,medical,offensive`. Trim it to stretch the free
  tier: it is **2,000 operations/month**, and one operation is one model on
  one image or one video frame -- so the default is 4 ops per image and 12
  per video (3 frames sampled). `weapon,offensive` alone is 2/6.
- `SIGHTENGINE_THRESHOLD` -- fallback review threshold (default `0.35`) for
  any model without a specific threshold in `SIGHTENGINE_SIGNAL_THRESHOLDS`.

Not covered by this "gaps only" set: image-based **sexual/minors**. OpenAI's
`sexual` class still fires on such an image, it just can't flag the minor
specifically -- add Sightengine's `nudity-2.1` model to `SIGHTENGINE_MODELS`
to close that.

### `OPENAI_API_KEY` (optional but recommended)

If set, image attachments and video frames are checked by calling OpenAI's
`/v1/moderations` endpoint directly (free, and documented to analyse
`image_url` inputs) instead of relying on the OpenModeration proxy to
forward the attachment to its configured provider. Text moderation is
unaffected. Add it as a secret:

```bash
wrangler secret put OPENAI_API_KEY
```

## Password reset (email 6-digit code)

BondED accounts sign in with an ID and have a synthetic, undeliverable auth
email, so Firebase's own `sendPasswordResetEmail` can't work. These modes
replace it:

| mode | auth | purpose |
|---|---|---|
| `recovery-email-start` | signed-in (Bearer ID token) | email a 6-digit code to a new recovery email |
| `recovery-email-confirm` | signed-in | verify that code, save `recoveryEmail` + `recoveryEmailVerified` on `students/{id}` |
| `password-reset-start` | none | email a 6-digit code to the account's verified recovery email (always returns `{ ok: true }` so it can't probe which IDs exist) |
| `password-reset-confirm` | none | verify the code + set the new password via the Identity Toolkit admin API |

Codes live in `authCodes/{uid}__recovery` / `authCodes/{uid}__pwreset` as a
salted SHA-256 hash, expire after 15 minutes, lock after 5 wrong attempts,
and are rate-limited to one send per minute. The `authCodes` collection is
Worker-only (`firestore.rules` denies all client access).

### Config

Set ONE email provider. `sendResetEmail` uses Brevo if `BREVO_API_KEY` is
present, otherwise Resend.

**Brevo** -- no domain needed, verify a single sender by clicking a link:

```bash
wrangler secret put BREVO_API_KEY       # from app.brevo.com -> SMTP & API -> API Keys
```

- `BREVO_SENDER` (`[vars]`) -- the email you verified in Brevo
  (Senders, Domains & Dedicated IPs -> Senders). Required for Brevo.
- `BREVO_SENDER_NAME` (`[vars]`, optional) -- defaults to `BondED`.

**Resend** -- better inbox delivery, but needs a verified domain to send to
arbitrary recipients:

```bash
wrangler secret put RESEND_API_KEY      # from resend.com
```

- `RESEND_FROM` (`[vars]`) -- e.g. `BondED <noreply@yourdomain.com>` on a
  domain verified in Resend. Without it the default `onboarding@resend.dev`
  can only email your own Resend-account address (test mode).

**Both:**

- `AUTH_CODE_PEPPER` (secret, optional) -- extra salt for the code hash.
  Falls back to `FIREBASE_WEB_API_KEY`.

`firebaseAccessToken` now requests the `identitytoolkit` scope in addition to
`datastore`, so the service account can set passwords. The default Firebase
Admin SDK service account already has the matching IAM permission; a custom
service account needs the **Firebase Authentication Admin** role.

## Video captions (speech-to-text)

The `transcribe-video` mode generates auto-captions for feed video posts via
Groq's Whisper API (`/openai/v1/audio/transcriptions`). Triggered once by the
app right after a video post is approved; runs in `ctx.waitUntil()` so
publishing is never blocked. Writes `captionStatus` / `captions` /
`captionLanguage` back to `posts/{id}`.

Reuses the existing `GROQ_API_KEY` (also accepts `GROQ_API_KEYS`, first entry).
Optional overrides:

- `GROQ_TRANSCRIBE_MODEL` — default `whisper-large-v3` (full multilingual
  model; better on Taglish / non-English than `whisper-large-v3-turbo`).
- `GROQ_TRANSCRIBE_LANGUAGE` — leave unset for auto-detect (recommended for
  code-switched Taglish; forcing `en` or `tl` degrades the other half).

**Cost:** Groq bills per second of audio transcribed. There is a free tier,
but this is a real recurring per-video-minute operating cost — not one-time.
Only approved video posts are transcribed, and each post is transcribed at
most once.

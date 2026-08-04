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

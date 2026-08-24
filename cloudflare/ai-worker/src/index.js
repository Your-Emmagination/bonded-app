import { handlePushNotificationRequest } from "./push.js";
const DEFAULT_MODEL = "openai/gpt-oss-20b";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_CONTEXT_MESSAGES = 12;
const EXACT_BLOCKLIST = ["shabu", "weed", "marijuana", "cannabis", "vape", "nude", "nudes", "nudity", "naked", "porn", "pornography", "drug", "drugs", "meth", "cocaine", "heroin", "fentanyl", "mdma", "ecstasy", "suicide"];
const IMMEDIATE_BLOCKLIST = new Set([
  "shabu", "meth", "cocaine", "heroin", "fentanyl",
  "nude", "nudes", "nudity", "naked", "porn", "pornography",
  "drug", "drugs", "drug dealer", "buy drugs", "sell drugs",
]);
const SUBSTRING_BLOCKLIST = [
  "kill yourself",
  "sex video",
  "bomb",
  "sexual assault",
  "drug dealer",
  "escort",
  "explicit",
];
const MAX_MEMORY_BLOCKS = 12;

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...buildCorsHeaders(init.headers?.["Access-Control-Allow-Origin"]),
      ...(init.headers || {}),
    },
  });

function buildCorsHeaders(allowedOrigin = "*") {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function sanitizeContextMessages(contextMessages = []) {
  return contextMessages
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: `${message.name || "User"}: ${message.content || ""}`.trim(),
    }))
    .filter((message) => message.content);
}

function sanitizeMemoryBlocks(memoryBlocks = []) {
  return memoryBlocks
    .slice(0, MAX_MEMORY_BLOCKS)
    .map((block) => String(block || "").trim())
    .filter(Boolean);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runRuleBasedModeration(text = "") {
  const normalized = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { status: "approved", reasons: [], matchedKeywords: [] };
  }

  const matchedKeywords = [
    ...EXACT_BLOCKLIST.filter((keyword) =>
      new RegExp(`(^|\\b)${escapeRegex(keyword)}(\\b|$)`, "i").test(normalized),
    ),
    ...SUBSTRING_BLOCKLIST.filter((keyword) => normalized.includes(keyword)),
  ];

  if (matchedKeywords.length === 0) {
    return { status: "approved", reasons: [], matchedKeywords: [] };
  }

  const shouldBlockImmediately = matchedKeywords.some((keyword) =>
    IMMEDIATE_BLOCKLIST.has(keyword),
  );

  return {
    status: shouldBlockImmediately ? "rejected" : "pending",
    reasons: [
      shouldBlockImmediately
        ? "Post blocked because it contains prohibited content."
        : "Matched restricted campus-safety keywords.",
    ],
    matchedKeywords,
  };
}

async function callGroq(env, payload) {
  return fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
}

async function moderateTextWithGroq(env, text, scope) {
  const groqResponse = await callGroq(env, {
    model: env.GROQ_MODEL || DEFAULT_MODEL,
    temperature: 0.1,
    max_tokens: 180,
    messages: [
      {
        role: "system",
        content:
          "You are a campus community moderator. Review content for harassment, hate, sexual content, self-harm encouragement, explicit drug dealing, bomb threats, or unsafe abuse. Respond with strict JSON only: {\"status\":\"approved\"|\"pending\",\"reasons\":[\"...\"],\"matchedKeywords\":[\"...\"]}. Use pending when review is needed.",
      },
      {
        role: "user",
        content: `Scope: ${scope || "general"}\nContent: ${text}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "moderation_decision",
        strict: true,
        schema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["approved", "pending"] },
            reasons: { type: "array", items: { type: "string" } },
            matchedKeywords: { type: "array", items: { type: "string" } },
          },
          required: ["status", "reasons", "matchedKeywords"],
          additionalProperties: false,
        },
      },
    },
  });

  const groqPayload = await groqResponse.json().catch(() => null);
  if (!groqResponse.ok) {
    throw new Error(groqPayload?.error?.message || "Groq moderation request failed.");
  }

  const raw = groqPayload?.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    return { status: "approved", reasons: [], matchedKeywords: [] };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      status: parsed?.status === "pending" ? "pending" : "approved",
      reasons: Array.isArray(parsed?.reasons) ? parsed.reasons : [],
      matchedKeywords: Array.isArray(parsed?.matchedKeywords) ? parsed.matchedKeywords : [],
      model: groqPayload?.model || env.GROQ_MODEL || DEFAULT_MODEL,
    };
  } catch {
    return { status: "approved", reasons: [], matchedKeywords: [] };
  }
}



let firebaseTokenCache = null;
let firebaseTokenExpires = 0;

const b64url = (bytes) => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

async function firebaseAccessToken(env) {
  if (firebaseTokenCache && Date.now() < firebaseTokenExpires - 60000) return firebaseTokenCache;
  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) throw new Error("Missing Firebase service-account Worker secrets.");
  const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const raw = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", raw.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: env.FIREBASE_CLIENT_EMAIL, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const unsigned = `${head}.${claim}`;
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(unsigned));
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(new Uint8Array(sig))}` }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) throw new Error(payload?.error_description || "Firebase service authentication failed.");
  firebaseTokenCache = payload.access_token;
  firebaseTokenExpires = Date.now() + Number(payload.expires_in || 3600) * 1000;
  return firebaseTokenCache;
}

async function verifyFirebaseUser(env, idToken) {
  if (!env.FIREBASE_WEB_API_KEY) throw new Error("Missing FIREBASE_WEB_API_KEY Worker secret.");
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.users?.[0]?.localId) throw new Error("Invalid or expired Firebase ID token.");
  return payload.users[0].localId;
}

const fsValue = (v) => {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return !!v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(fsValue);
  if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fsValue(x)]));
  if (v.nullValue !== undefined) return null;
  return null;
};
const fsDoc = (d) => Object.fromEntries(Object.entries(d?.fields || {}).map(([k, v]) => [k, fsValue(v)]));
const toFs = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
};
const firestoreUrl = (env, path = "") => `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents${path}`;

async function firestore(env, path, options = {}) {
  const token = await firebaseAccessToken(env);
  const response = await fetch(firestoreUrl(env, path), { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `Firestore request failed (${response.status}).`);
  return payload;
}

async function patchFirestore(env, collectionName, id, fields) {
  const params = new URLSearchParams();
  Object.keys(fields).forEach(k => params.append("updateMask.fieldPaths", k));
  return firestore(env, `/${collectionName}/${encodeURIComponent(id)}?${params}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFs(v)])) }),
  });
}

async function createFirestore(env, collectionName, id, fields) {
  const path = id ? `/${collectionName}/${encodeURIComponent(id)}` : `/${collectionName}`;
  return firestore(env, path, {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFs(v)])) }),
  });
}

async function queryFirestore(env, collectionId, fieldPath, value) {
  const token = await firebaseAccessToken(env);
  const response = await fetch(firestoreUrl(env) + ":runQuery", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath }, op: "EQUAL", value: toFs(value) } } } }),
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok) throw new Error(payload?.error?.message || `Firestore query failed (${response.status}).`);
  return Array.isArray(payload) ? payload.filter(x => x.document).map(x => fsDoc(x.document)) : [];
}

async function runApprovedSideEffects(env, postId, post) {
  const tagged = Array.isArray(post.taggedUsers) ? post.taggedUsers : [];
  const actorId = String(post.realUserId || "");
  const actorName = post.isAnonymous ? "Anonymous" : String(post.authorName || post.username || "Someone");
  const recipients = new Set(tagged.map(x => String(x?.id || "")).filter(x => x && x !== actorId && x !== "ai-assistant" && x !== "everyone-mention"));

  if (tagged.some(x => String(x?.id || "") === "everyone-mention")) {
    if (post.serverId) {
      const memberships = await queryFirestore(env, "communityServerMemberships", "serverId", post.serverId);
      memberships.forEach(x => { if (x.userId && String(x.status || "joined") !== "removed") recipients.add(String(x.userId)); });
      try {
        const server = fsDoc(await firestore(env, `/communityServers/${encodeURIComponent(post.serverId)}`));
        if (server.ownerId || server.createdBy) recipients.add(String(server.ownerId || server.createdBy));
      } catch (_) {}
    } else {
      const students = await firestore(env, "/students");
      (students.documents || []).forEach(d => { const x = fsDoc(d); const id = String(x.userId || d.name?.split("/").pop() || ""); if (id) recipients.add(id); });
    }
  }

  const preview = String(post.content || "").replace(/\s+/g, " ").trim().slice(0, 117);
  await Promise.all([...recipients].map(recipientId => {
    const safe = recipientId.replace(/[/.#$[\]]/g, "_");
    const actorSafe = actorId.replace(/[/.#$[\]]/g, "_");
    const notificationId = `mention_${safe}_${actorSafe}_${postId}`;
    return createFirestore(env, "notifications", notificationId, {
      recipientId, actorId, actorName, actorProfileImage: null, actorIsAnonymous: !!post.isAnonymous,
      type: "mention", entityType: "post", entityId: postId, parentId: null,
      message: "mentioned you in a post", preview: preview || null, read: false, createdAt: new Date().toISOString(),
    });
  }));

  if (tagged.some(x => String(x?.id || "") === "ai-assistant")) {
    const prompt = String(post.aiPrompt || post.content || "").trim();
    if (prompt) {
      await patchFirestore(env, "posts", postId, { aiReply: { text: "", status: "generating", generatedAtMs: Date.now() } });
      try {
        const response = await callGroq(env, {
          model: env.GROQ_MODEL || DEFAULT_MODEL, temperature: 0.6, max_tokens: 300,
          messages: [
            { role: "system", content: "You are Bonded AI, a helpful assistant inside a student community. Reply briefly, warmly, and clearly. Answer only from the user's post. Never encourage violence or harm and never invent private school facts." },
            { role: "user", content: prompt },
          ],
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message || "Groq AI reply failed.");
        const reply = String(payload?.choices?.[0]?.message?.content || "").trim();
        if (!reply) throw new Error("Groq returned an empty AI reply.");
        await patchFirestore(env, "posts", postId, { aiReply: { text: reply, model: payload?.model || env.GROQ_MODEL || DEFAULT_MODEL, status: "completed", generatedAtMs: Date.now() } });
      } catch (error) {
        console.warn("[Moderation] @AI failed:", error?.message || error);
        await patchFirestore(env, "posts", postId, { aiReply: { text: "", status: "failed", generatedAtMs: Date.now() } }).catch(() => undefined);
      }
    }
  }
}

async function moderateFirestoreContent(env, request, body) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!idToken) return json({ error: "Missing Firebase ID token." }, { status: 401 });

  const callerUid = await verifyFirebaseUser(env, idToken);
  const collectionName = String(body?.collection || "").trim();
  const documentId = String(body?.documentId || "").trim();
  const scope = String(body?.scope || "general").trim();

  if (!["comments", "replies"].includes(collectionName)) {
    return json({ error: "collection must be comments or replies." }, { status: 400 });
  }
  if (!documentId) return json({ error: "documentId is required." }, { status: 400 });

  const document = await firestore(env, `/${collectionName}/${encodeURIComponent(documentId)}`);
  const content = fsDoc(document);
  const ownerId = String(content.realUserId || content.userId || "");
  if (ownerId !== callerUid) return json({ error: "You are not allowed to moderate this content." }, { status: 403 });

  const existingStatus = String(content.moderationStatus || "pending");
  if (existingStatus === "approved") {
    return json({ status: "approved", reasons: [], matchedKeywords: [], moderationSource: "server" });
  }

  const text = String(content.text || "").trim();
  const rulesDecision = runRuleBasedModeration(text);
  if (rulesDecision.status === "rejected") {
    await patchFirestore(env, collectionName, documentId, {
      moderationStatus: "rejected",
      moderationReasons: rulesDecision.reasons,
      moderatedAtMs: Date.now(),
      moderationRuleSource: "exact",
    });
    return json({ ...rulesDecision, moderationSource: "server-rules" });
  }

  if (Array.isArray(content.files) && content.files.length > 0) {
    const result = {
      status: "pending",
      reasons: ["Media attached to comments and replies requires moderator review."],
      matchedKeywords: [],
      moderationSource: "server-media-fallback",
    };
    await patchFirestore(env, collectionName, documentId, {
      moderationStatus: "pending",
      moderationReasons: result.reasons,
      moderatedAtMs: Date.now(),
      moderationRuleSource: "pattern",
    });
    return json(result);
  }

  let decision;
  try {
    decision = await moderateTextWithGroq(env, text, scope);
  } catch (error) {
    console.warn(`[Moderation] ${collectionName} Groq failed; keeping content pending:`, error?.message || error);
    decision = {
      status: "pending",
      reasons: ["Automatic moderation could not complete. This content requires review."],
      matchedKeywords: [],
    };
  }

  const status = decision.status === "approved" ? "approved" : "pending";
  await patchFirestore(env, collectionName, documentId, {
    moderationStatus: status,
    moderationReasons: decision.reasons || [],
    moderatedAtMs: Date.now(),
    moderationModel: decision.model || env.GROQ_MODEL || DEFAULT_MODEL,
    moderationRuleSource: decision.ruleSource || "ai",
  });

  return json({
    status,
    reasons: decision.reasons || [],
    matchedKeywords: decision.matchedKeywords || [],
    moderationSource: "server-ai",
    model: decision.model || env.GROQ_MODEL || DEFAULT_MODEL,
    ruleSource: decision.ruleSource || "ai",
  });
}

async function moderateFirestorePost(env, request, body) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!idToken) return json({ error: "Missing Firebase ID token." }, { status: 401 });
  const callerUid = await verifyFirebaseUser(env, idToken);
  const postId = String(body?.postId || "").trim();
  if (!postId) return json({ error: "postId is required." }, { status: 400 });

  const document = await firestore(env, `/posts/${encodeURIComponent(postId)}`);
  const post = fsDoc(document);
  if (String(post.realUserId || post.userId || "") !== callerUid) return json({ error: "You are not allowed to moderate this post." }, { status: 403 });
  if (String(post.moderationStatus || "") === "approved") return json({ status: "approved", reasons: [], moderationSource: "server" });

  const text = String(post.content || "").trim();
  const rulesDecision = runRuleBasedModeration(text);
  if (rulesDecision.status === "rejected") {
    await patchFirestore(env, "posts", postId, { moderationStatus: "rejected", moderationReasons: rulesDecision.reasons, moderatedAtMs: Date.now() });
    return json({ ...rulesDecision, moderationSource: "server-rules" });
  }

  if (Array.isArray(post.files) && post.files.length > 0) {
    const result = { status: "pending", reasons: ["Media posts require moderator review."], matchedKeywords: [], moderationSource: "server-media-fallback" };
    await patchFirestore(env, "posts", postId, { moderationStatus: "pending", moderationReasons: result.reasons, moderatedAtMs: Date.now() });
    return json(result);
  }

  let decision;
  try { decision = await moderateTextWithGroq(env, text, "post"); }
  catch (error) {
    console.warn("[Moderation] Groq failed; keeping post pending:", error?.message || error);
    decision = { status: "pending", reasons: ["Automatic moderation could not complete. This post requires review."], matchedKeywords: [] };
  }

  const status = decision.status === "approved" ? "approved" : "pending";
  await patchFirestore(env, "posts", postId, { moderationStatus: status, moderationReasons: decision.reasons || [], moderatedAtMs: Date.now() });
  if (status === "approved") {
    try { await runApprovedSideEffects(env, postId, post); }
    catch (error) { console.warn("[Moderation] publication side effect failed:", error?.message || error); }
    await patchFirestore(env, "posts", postId, { publishedSideEffectsAtMs: Date.now(), publishedSideEffectsAt: new Date().toISOString() }).catch(() => undefined);
  }
  return json({ status, reasons: decision.reasons || [], matchedKeywords: decision.matchedKeywords || [], moderationSource: "server-ai" });
}

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(allowedOrigin),
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, {
        status: 405,
        headers: { "Access-Control-Allow-Origin": allowedOrigin },
      });
    }

    if (!env.GROQ_API_KEY) {
      return json(
        { error: "Missing GROQ_API_KEY in Worker environment." },
        { status: 500, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
      );
    }

    try {
      const body = await request.json();

      if (body?.mode === "moderate-firestore-post") {
        return await moderateFirestorePost(env, request, body);
      }

      if (body?.mode === "moderate-firestore-content") {
        return await moderateFirestoreContent(env, request, body);
      }

      if (body?.mode === "push-notification") {
        const result = await handlePushNotificationRequest(
          new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(body),
          }),
          env,
        );
        return json(result.body, {
          status: result.status,
          headers: { "Access-Control-Allow-Origin": allowedOrigin },
        });
      }

      const mode = body?.mode === "moderate" ? "moderate" : "chat";
      const prompt = body?.prompt?.trim();
      const contextMessages = sanitizeContextMessages(body?.contextMessages);
      const memoryBlocks = sanitizeMemoryBlocks(body?.memoryBlocks);

      if (mode === "moderate") {
        const text = String(body?.text || "").trim();
        if (!text) {
          return json(
            { status: "approved", reasons: [], matchedKeywords: [] },
            { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
          );
        }

        const ruleDecision = runRuleBasedModeration(text);
        if (ruleDecision.status === "pending") {
          return json(
            ruleDecision,
            { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
          );
        }

        let aiDecision;
        try {
          aiDecision = await moderateTextWithGroq(env, text, body?.scope);
        } catch (error) {
          // A moderation provider/schema failure must never turn into HTTP 500.
          // The local rule-based moderation has already run above. For an AI
          // failure, fail closed into pending review instead of publishing an
          // uncertain result as approved.
          console.warn("[Moderation] Groq moderation failed; using pending fallback.", error?.message || error);
          aiDecision = {
            status: "pending",
            reasons: ["Automatic moderation could not complete. This post requires review."],
            matchedKeywords: [],
            moderationSource: "local-fallback",
          };
        }

        return json(
          aiDecision,
          { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
        );
      }

      if (!prompt) {
        return json(
          { error: "Prompt is required." },
          { status: 400, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
        );
      }

      const groqResponse = await callGroq(env, {
        model: env.GROQ_MODEL || DEFAULT_MODEL,
        temperature: 0.6,
        max_tokens: 300,
        messages: [
          {
            role: "system",
            content: [
              "You are Bonded AI, a helpful assistant inside a student community thread.",
              "Reply briefly, warmly, and clearly.",
              "Answer based on the exact post, comment, reply, or AI message you are under.",
              "If prior Bonded AI messages are in the conversation, you may continue them naturally.",
              "If tagged users are mentioned in the prompt or context, use those names directly in your answer.",
              "You may make light hypothetical comparisons or nickname suggestions when asked, but never encourage real violence or harm.",
              "If the request is vague, ask one short clarifying question.",
              "Do not invent school-private facts or admin-only data.",
              memoryBlocks.length
                ? `Use the long-term memory below as trusted project knowledge.\n\n${memoryBlocks
                    .map((block, index) => `Memory ${index + 1}:\n${block}`)
                    .join("\n\n")}`
                : "",
              "If the answer is not in long-term memory, you may still help from the current conversation, but do not pretend the missing fact is confirmed project knowledge.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          ...contextMessages,
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const groqPayload = await groqResponse.json().catch(() => null);
      if (!groqResponse.ok) {
        return json(
          { error: groqPayload?.error?.message || "Groq request failed." },
          { status: groqResponse.status, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
        );
      }

      const reply = groqPayload?.choices?.[0]?.message?.content?.trim();
      if (!reply) {
        return json(
          { error: "Groq returned an empty reply." },
          { status: 502, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
        );
      }

      return json(
        {
          reply,
          model: groqPayload?.model || env.GROQ_MODEL || DEFAULT_MODEL,
        },
        { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : "Unexpected worker error.",
        },
        { status: 500, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
      );
    }
  },
};
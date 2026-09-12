const FIREBASE_PROJECT_ID = "bonded-app-c8483";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Firebase ID-token signing keys as JWKs (not the x509 cert endpoint — those
// are full certificates, which WebCrypto's "spki" import can't parse).
const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9\-_]+\]$/;
const SOUND_IDS = new Set(["default", "chime", "pop", "bubble", "alert", "silent"]);

let cachedGoogleAccessToken = null;
let cachedGoogleAccessTokenExpiresAt = 0;
let cachedFirebaseJwks = null;
let cachedFirebaseJwksExpiresAt = 0;

const base64UrlEncode = (value) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const base64UrlDecodeBytes = (value) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const decodeJsonPart = (value) =>
  JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(value)));

const pemToDer = (pem) => {
  const base64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s/g, "");
  return base64UrlDecodeBytes(base64.replace(/\+/g, "-").replace(/\//g, "_"));
};

const importPrivateKey = async (pem) => {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
};

const importJwkVerifyKey = async (jwk) =>
  crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

const signJwt = async (header, payload, privateKey) => {
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
};

const getGoogleAccessToken = async (env) => {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleAccessToken && cachedGoogleAccessTokenExpiresAt > now + 60) {
    return cachedGoogleAccessToken;
  }

  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new Error("Missing Firebase service-account secrets in Worker.");
  }

  const privateKey = await importPrivateKey(env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"));
  const assertion = await signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: env.FIREBASE_CLIENT_EMAIL,
      scope: FIRESTORE_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    privateKey,
  );

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || "Could not obtain Google access token.");
  }

  cachedGoogleAccessToken = payload.access_token;
  cachedGoogleAccessTokenExpiresAt = now + Number(payload.expires_in || 3600);
  return cachedGoogleAccessToken;
};

// { kid -> jwk } map of Firebase's current RS256 signing keys, cached for the
// lifetime the endpoint advertises via Cache-Control.
const getFirebaseJwks = async () => {
  const now = Date.now();
  if (cachedFirebaseJwks && cachedFirebaseJwksExpiresAt > now + 60_000) {
    return cachedFirebaseJwks;
  }

  const response = await fetch(FIREBASE_JWKS_URL);
  if (!response.ok) {
    throw new Error(`Firebase JWKS lookup failed: ${response.status}`);
  }

  const cacheControl = response.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 3600_000;

  const payload = await response.json();
  const keys = Array.isArray(payload?.keys) ? payload.keys : [];
  cachedFirebaseJwks = Object.fromEntries(
    keys.filter((key) => key?.kid).map((key) => [key.kid, key]),
  );
  cachedFirebaseJwksExpiresAt = now + maxAgeMs;
  return cachedFirebaseJwks;
};

const verifyFirebaseIdToken = async (token) => {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Firebase ID token.");

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonPart(encodedHeader);
  const payload = decodeJsonPart(encodedPayload);
  const now = Math.floor(Date.now() / 1000);

  if (header.alg !== "RS256" || !header.kid) throw new Error("Invalid Firebase token header.");
  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error("Invalid Firebase token audience.");
  if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
    throw new Error("Invalid Firebase token issuer.");
  }
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Invalid Firebase token subject.");
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("Firebase ID token expired.");
  if (typeof payload.iat !== "number" || payload.iat > now + 300) throw new Error("Invalid Firebase token time.");

  const jwks = await getFirebaseJwks();
  const jwk = jwks[header.kid];
  if (!jwk) throw new Error("Firebase signing key not found.");

  const publicKey = await importJwkVerifyKey(jwk);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64UrlDecodeBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );

  if (!valid) throw new Error("Invalid Firebase ID token signature.");
  return payload;
};

const firestoreGet = async (env, documentPath) => {
  const accessToken = await getGoogleAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${documentPath}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Firestore read failed (${response.status}): ${text}`);
  }
  return response.json();
};

const firestoreCommit = async (env, writes) => {
  const accessToken = await getGoogleAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ writes }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Firestore commit failed (${response.status}): ${text}`);
  }
  return response.json();
};

// Drop tokens from a user's userPushTokens document. A removeAllFromArray
// transform rather than a read-modify-write, so it cannot clobber a token the
// device registered concurrently.
const removePushTokens = async (env, userId, tokens) => {
  if (!tokens.length) return;
  await firestoreCommit(env, [
    {
      transform: {
        document:
          `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/` +
          `userPushTokens/${encodeURIComponent(userId)}`,
        fieldTransforms: [
          {
            fieldPath: "expoPushTokens",
            removeAllFromArray: {
              values: tokens.map((token) => ({ stringValue: token })),
            },
          },
        ],
      },
      currentDocument: { exists: true },
    },
  ]);
};

const firestoreValue = (value) => {
  if (!value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  return null;
};

const firestoreFields = (document) => document?.fields || {};

const readNotification = async (env, notificationId) => {
  const document = await firestoreGet(env, `notifications/${encodeURIComponent(notificationId)}`);
  if (!document) return null;
  const fields = firestoreFields(document);
  const read = (name) => firestoreValue(fields[name]);
  return {
    id: notificationId,
    recipientId: read("recipientId"),
    actorId: read("actorId"),
    actorName: read("actorName") || "Someone",
    type: read("type") || "activity",
    entityType: read("entityType") || "post",
    entityId: read("entityId") || "",
    parentId: read("parentId"),
    message: read("message") || "sent you a notification",
    preview: read("preview"),
  };
};

const readUserPushToken = async (env, userId) => {
  const document = await firestoreGet(env, `userPushTokens/${encodeURIComponent(userId)}`);
  if (!document) return [];
  const value = document.fields?.expoPushTokens;
  if (!value?.arrayValue?.values) return [];
  return value.arrayValue.values
    .map((item) => firestoreValue(item))
    .filter((token) => typeof token === "string" && EXPO_TOKEN_RE.test(token));
};

const readSoundId = async (env, userId) => {
  const document = await firestoreGet(env, `userNotificationSettings/${encodeURIComponent(userId)}`);
  const value = firestoreValue(document?.fields?.soundId);
  return SOUND_IDS.has(value) ? value : "default";
};

// Unread count for one participant of a direct conversation, used to decide
// whether a push would merely repeat one the recipient has not opened yet.
const readConversationUnread = async (env, conversationId, userId) => {
  const document = await firestoreGet(
    env,
    `directConversations/${encodeURIComponent(conversationId)}`,
  );
  const entry = firestoreFields(document)?.unreadCounts?.mapValue?.fields?.[userId];
  const value = Number(entry?.integerValue ?? entry?.doubleValue ?? 0);
  return Number.isFinite(value) ? value : 0;
};

const soundForNotification = (soundId) => {
  const options = {
    default: { file: "notif_default.wav", channel: "sound_default" },
    chime: { file: "notif_chime.wav", channel: "sound_chime" },
    pop: { file: "notif_pop.wav", channel: "sound_pop" },
    bubble: { file: "notif_bubble.wav", channel: "sound_bubble" },
    alert: { file: "notif_alert.wav", channel: "sound_alert" },
    silent: { file: null, channel: "sound_silent" },
  };
  return options[soundId] || options.default;
};

const buildPushData = (notification) => ({
  screen: notification.entityType === "event" ? "event-calendar" : "notifications",
  type: String(notification.type),
  entityType: String(notification.entityType),
  entityId: String(notification.entityId),
  ...(notification.parentId ? { parentId: String(notification.parentId) } : {}),
});

// ── Notification content ──────────────────────────────────────────────────

// Trim a snippet to a readable length, collapsing whitespace and adding an
// ellipsis when cut.
export const truncateSnippet = (text, max = 100) => {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

// Deduplicated, lowercased @-usernames from a block of text.
export const extractMentions = (text) => {
  const found = new Set();
  const pattern = /@([a-zA-Z0-9_]+)/g;
  let match;
  while ((match = pattern.exec(String(text || ""))) !== null) {
    found.add(match[1].toLowerCase());
  }
  return [...found];
};

// Stored notifications carry { type, entityType }; map that pair to a
// task-level "kind" so each gets its own title/body template.
const notificationKind = (notification) => {
  const type = String(notification.type || "");
  const entity = String(notification.entityType || "");
  if (entity === "direct_message") return "direct_message";
  // A community-server channel message. Before this it was filed as a
  // "comment", which made the push announce the wrong place entirely.
  if (entity === "thread_message") {
    return type === "mention" ? "mention_thread" : "thread_message";
  }
  if (type === "like") {
    if (entity === "poll") return "poll_like";
    if (entity === "comment" || entity === "reply") return "comment_like";
    return "post_like";
  }
  if (type === "comment") return "post_comment";
  if (type === "reply") return "comment_reply";
  if (type === "mention") {
    return entity === "comment" || entity === "reply"
      ? "mention_comment"
      : "mention_post";
  }
  if (type === "announcement") return "announcement";
  return null;
};

const NOTIFICATION_TEMPLATES = {
  direct_message: (n) => ({ title: n.actorName, body: truncateSnippet(n.preview, 100) || "Sent you a message" }),
  post_like: (n) => ({
    title: "New Like ❤️",
    body: `${n.actorName} liked your post.`,
  }),
  poll_like: (n) => ({
    title: "New Like ❤️",
    body: `${n.actorName} liked your poll.`,
  }),
  comment_like: (n) => ({
    title: "New Like ❤️",
    body: `${n.actorName} liked your ${n.entityType === "reply" ? "reply" : "comment"}.`,
  }),
  post_comment: (n) => ({
    title: "New Comment 💬",
    body: `${n.actorName} commented: "${truncateSnippet(n.preview, 80)}"`,
  }),
  comment_reply: (n) => ({
    title: "New Reply ↩️",
    body: `${n.actorName} replied: "${truncateSnippet(n.preview, 80)}"`,
  }),
  mention_post: (n) => ({
    title: "You were mentioned 📣",
    body: `${n.actorName} mentioned you in a post.`,
  }),
  mention_comment: (n) => ({
    title: "You were mentioned 💬",
    body: `${n.actorName} mentioned you in a comment: "${truncateSnippet(n.preview, 80)}"`,
  }),
  // The client already words the location ("mentioned you in #general"), so
  // that text is used verbatim instead of being overwritten with comment
  // wording that named the wrong place.
  mention_thread: (n) => {
    const snippet = truncateSnippet(n.preview, 60);
    return {
      title: "You were mentioned 💬",
      body: `${n.actorName} ${n.message || "mentioned you in a channel"}${
        snippet ? `: "${snippet}"` : ""
      }`,
    };
  },
  // Ready for plain channel messages. Nothing creates this notification today:
  // pushing every channel message needs a deliberate fan-out to members that
  // respects channelMutes, which is a client-side change.
  thread_message: (n) => ({
    title: String(n.actorName || "New message"),
    body: truncateSnippet(n.preview, 100) || "Sent a message",
  }),
  announcement: (n) => ({
    title: "📢 Announcement from Staff",
    body: truncateSnippet(n.preview || n.message, 120),
  }),
};

// Returns { kind, title, body } for a stored notification. Types without a
// bespoke template (moderation, server_deletion, generic activity) fall back
// to "<actor name>" / "<message>", which is the prior behaviour.
export const buildNotificationPayload = (notification) => {
  const kind = notificationKind(notification);
  const template = kind && NOTIFICATION_TEMPLATES[kind];
  if (template) {
    const { title, body } = template(notification);
    return { kind, title, body };
  }
  return {
    kind: "activity",
    title: String(notification.actorName || "BondED"),
    body: String(notification.message || "sent you a notification"),
  };
};

// ── Expo batch dispatch ──────────────────────────────────────────────────

// POST messages to Expo in chunks of 100 (Expo's max batch size). Returns the
// flattened array of push tickets.
export const sendPushNotifications = async (messages) => {
  const tickets = [];
  for (let start = 0; start < messages.length; start += 100) {
    const chunk = messages.slice(start, start + 100);
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chunk),
    });
    const responseText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`Expo push failed (${response.status}): ${responseText}`);
    }
    const parsed = JSON.parse(responseText || "{}");
    if (Array.isArray(parsed?.data)) tickets.push(...parsed.data);
  }
  return tickets;
};

export const sendNotificationPush = async (env, notification) => {
  if (!notification?.recipientId) {
    console.warn("Push skipped: notification has no recipient ID.", {
      notificationId: notification?.id || null,
    });
    return { sent: 0 };
  }

  // One notification per conversation until it is opened, the way Messenger
  // behaves. The unread count already includes this message, so a count above
  // one means an earlier message was already announced and still has not been
  // read — announcing again would just stack another row for the same chat.
  if (notificationKind(notification) === "direct_message" && notification.parentId) {
    const unread = await readConversationUnread(
      env,
      String(notification.parentId),
      String(notification.recipientId),
    );
    if (unread > 1) {
      console.log("Push skipped: conversation already has an unopened notification.", {
        notificationId: notification.id,
        unread,
      });
      return { sent: 0, skipped: "conversation-already-notified" };
    }
  }

  const tokens = await readUserPushToken(env, notification.recipientId);
  if (tokens.length === 0) {
    console.warn("Push skipped: no valid Expo tokens for recipient.", {
      notificationId: notification.id,
      recipientId: notification.recipientId,
    });
    return { sent: 0 };
  }

  const soundId = await readSoundId(env, notification.recipientId);
  const sound = soundForNotification(soundId);
  const { kind, title, body } = buildNotificationPayload(notification);
  const messages = tokens.map((token) => ({
    to: token,
    title,
    body,
    sound: sound.file,
    priority: "high",
    channelId: sound.channel,
    data: { ...buildPushData(notification), kind },
  }));

  // One ticket per token. Log only statuses/errors, never tokens.
  const tickets = await sendPushNotifications(messages);
  console.log("Expo push result", {
    notificationId: notification.id,
    recipientId: notification.recipientId,
    tokenCount: tokens.length,
    tickets: tickets.map((ticket) => ({
      status: ticket?.status || "unknown",
      message: ticket?.message || null,
      error: ticket?.details?.error || null,
    })),
  });

  // Expo returns tickets in message order, so tickets[i] belongs to tokens[i].
  // DeviceNotRegistered means that address is permanently dead — the app was
  // uninstalled, or the install issued a fresh token — so drop it instead of
  // retrying it on every future notification for this user.
  const deadTokens = tokens.filter(
    (_, index) => tickets[index]?.details?.error === "DeviceNotRegistered",
  );
  if (deadTokens.length) {
    await removePushTokens(env, notification.recipientId, deadTokens).catch(
      (error) =>
        console.error("Dead push token cleanup failed:", error?.message || error),
    );
  }

  return { sent: messages.length };
};

// ── Staff announcement broadcast ─────────────────────────────────────────

const firestoreQueryFirst = async (env, collectionId, field, value) => {
  const accessToken = await getGoogleAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: field },
            op: "EQUAL",
            value: { stringValue: value },
          },
        },
        limit: 1,
      },
    }),
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) ? rows.find((entry) => entry.document) : null;
  return row?.document || null;
};

const readStudentRole = async (env, uid) => {
  let document = await firestoreGet(env, `students/${encodeURIComponent(uid)}`);
  if (!document) {
    document = await firestoreQueryFirst(env, "students", "userId", uid);
  }
  const role = firestoreValue(firestoreFields(document).role);
  return String(role || "student").toLowerCase();
};

// Every valid Expo token across every userPushTokens doc, deduplicated.
const listAllPushTokens = async (env) => {
  const accessToken = await getGoogleAccessToken(env);
  const tokens = new Set();
  let pageToken = "";
  do {
    const url =
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents/userPushTokens?pageSize=300` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`userPushTokens list failed (${response.status}).`);
    }
    const data = await response.json();
    for (const document of data.documents || []) {
      const values = document.fields?.expoPushTokens?.arrayValue?.values || [];
      for (const value of values) {
        const token = firestoreValue(value);
        if (typeof token === "string" && EXPO_TOKEN_RE.test(token)) {
          tokens.add(token);
        }
      }
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return [...tokens];
};

/**
 * Fan a staff announcement post out to every registered device. The client
 * only sends { postId } + its Firebase token; the Worker re-verifies that the
 * caller is staff AND owns an announcement-flair post, then gathers every push
 * token itself and batches to Expo (100 per request). No client-supplied
 * token list — so this can't be used to spam arbitrary devices.
 */
export const handleAnnouncementBroadcast = async (request, env) => {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!token) {
    return { status: 401, body: { error: "Missing Firebase authentication token." } };
  }
  const caller = await verifyFirebaseIdToken(token);

  const body = await request.json();
  const postId = typeof body?.postId === "string" ? body.postId.trim() : "";
  if (!postId) return { status: 400, body: { error: "postId is required." } };

  const role = await readStudentRole(env, caller.sub);
  if (!["teacher", "moderator", "admin"].includes(role)) {
    return { status: 403, body: { error: "Announcements are staff only." } };
  }

  const post = await firestoreGet(env, `posts/${encodeURIComponent(postId)}`);
  if (!post) return { status: 404, body: { error: "Post not found." } };
  const fields = firestoreFields(post);
  const flair = firestoreValue(fields.flair);
  const ownerId =
    firestoreValue(fields.realUserId) || firestoreValue(fields.userId);
  if (flair !== "announcement") {
    return { status: 400, body: { error: "Post is not an announcement." } };
  }
  if (ownerId !== caller.sub) {
    return { status: 403, body: { error: "You can only broadcast your own post." } };
  }

  const snippet = truncateSnippet(firestoreValue(fields.content), 120);
  const { title, body: pushBody } = buildNotificationPayload({
    type: "announcement",
    entityType: "post",
    preview: snippet,
    message: snippet,
  });

  const authorTokens = new Set(await readUserPushToken(env, caller.sub));
  const tokens = (await listAllPushTokens(env)).filter(
    (token) => !authorTokens.has(token),
  );
  if (tokens.length === 0) {
    return { status: 200, body: { success: true, result: { sent: 0 } } };
  }

  // Mass broadcast uses the default sound/channel — reading each recipient's
  // sound setting would be one Firestore read per user. Per-user sound still
  // applies to the 1:1 notifications above.
  const messages = tokens.map((to) => ({
    to,
    title,
    body: pushBody,
    sound: "default",
    priority: "high",
    channelId: "sound_default",
    data: {
      screen: "notifications",
      type: "announcement",
      kind: "announcement",
      entityType: "post",
      entityId: postId,
    },
  }));

  const tickets = await sendPushNotifications(messages);
  console.log("Announcement broadcast result", {
    postId,
    actorId: caller.sub,
    tokenCount: tokens.length,
    errorCount: tickets.filter((ticket) => ticket?.status === "error").length,
  });

  return {
    status: 200,
    body: {
      success: true,
      result: {
        sent: messages.length,
        tickets: tickets.map((ticket) => ({
          status: ticket?.status || "unknown",
          error: ticket?.details?.error || null,
        })),
      },
    },
  };
};

export const handlePushNotificationRequest = async (request, env) => {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return { status: 401, body: { error: "Missing Firebase authentication token." } };

  const caller = await verifyFirebaseIdToken(token);
  const body = await request.json();
  const notificationId = typeof body?.notificationId === "string" ? body.notificationId.trim() : "";
  if (!notificationId) return { status: 400, body: { error: "notificationId is required." } };

  const notification = await readNotification(env, notificationId);
  if (!notification) return { status: 404, body: { error: "Notification not found." } };

  console.log("Push request received", {
    notificationId,
    recipientId: notification.recipientId,
    actorId: notification.actorId,
  });

  // Only the user who created the notification may ask the gateway to send it.
  // This prevents an authenticated user from using the endpoint to spam another
  // person's push token.
  if (notification.actorId !== caller.sub) {
    return { status: 403, body: { error: "You cannot send this notification." } };
  }

  if (notification.entityType === "direct_message") {
    const conversation = await firestoreGet(env, `directConversations/${encodeURIComponent(notification.parentId || "")}`);
    const participants = conversation?.fields?.participants?.arrayValue?.values?.map(firestoreValue) || [];
    const mutedBy = conversation?.fields?.mutedBy?.arrayValue?.values?.map(firestoreValue) || [];
    if (!participants.includes(caller.sub) || !participants.includes(notification.recipientId)) {
      return { status: 403, body: { error: "Conversation unavailable." } };
    }
    if (mutedBy.includes(notification.recipientId)) return { status: 200, body: { sent: 0, muted: true } };
  }

  const result = await sendNotificationPush(env, notification);
  return { status: 200, body: result };
};

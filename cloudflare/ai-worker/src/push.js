const FIREBASE_PROJECT_ID = "bonded-app-c8483";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIREBASE_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9\-_]+\]$/;
const SOUND_IDS = new Set(["default", "chime", "pop", "bubble", "alert", "silent"]);

let cachedGoogleAccessToken = null;
let cachedGoogleAccessTokenExpiresAt = 0;
let cachedFirebaseCerts = null;
let cachedFirebaseCertsExpiresAt = 0;

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

const importPublicKey = async (pem) => {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
};

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

const getFirebaseCerts = async () => {
  const now = Date.now();
  if (cachedFirebaseCerts && cachedFirebaseCertsExpiresAt > now + 60_000) {
    return cachedFirebaseCerts;
  }

  const response = await fetch(FIREBASE_CERTS_URL);
  if (!response.ok) {
    throw new Error(`Firebase public-key lookup failed: ${response.status}`);
  }

  const cacheControl = response.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 3600_000;
  cachedFirebaseCerts = await response.json();
  cachedFirebaseCertsExpiresAt = now + maxAgeMs;
  return cachedFirebaseCerts;
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

  const certs = await getFirebaseCerts();
  const cert = certs[header.kid];
  if (!cert) throw new Error("Firebase signing key not found.");

  const publicKey = await importPublicKey(cert);
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

export const sendNotificationPush = async (env, notification) => {
  if (!notification?.recipientId) {
    console.warn("Push skipped: notification has no recipient ID.", {
      notificationId: notification?.id || null,
    });
    return { sent: 0 };
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
  const messages = tokens.map((token) => ({
    to: token,
    title: notification.actorName,
    body: notification.message,
    sound: sound.file,
    priority: "high",
    channelId: sound.channel,
    data: buildPushData(notification),
  }));

  const response = await fetch(EXPO_PUSH_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messages),
  });

  const responseBody = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Expo push failed (${response.status}): ${responseBody}`);
  }

  // Expo returns one ticket per token. Log only statuses/errors, never tokens.
  const expoResult = JSON.parse(responseBody || "{}");
  const ticketSummary = Array.isArray(expoResult?.data)
    ? expoResult.data.map((ticket) => ({
        status: ticket?.status || "unknown",
        message: ticket?.message || null,
        error: ticket?.details?.error || null,
      }))
    : [];
  console.log("Expo push result", {
    notificationId: notification.id,
    recipientId: notification.recipientId,
    tokenCount: tokens.length,
    tickets: ticketSummary,
  });

  return { sent: messages.length };
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

  const result = await sendNotificationPush(env, notification);
  return { status: 200, body: result };
};

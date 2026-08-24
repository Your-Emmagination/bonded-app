const express = require("express");
const cors = require("cors");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const PORT = Number(process.env.PORT || 5000);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "bonded-app-c8483";

function getFirebaseApp() {
  if (getApps().length) return getApps()[0];

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (clientEmail && privateKey) {
    return initializeApp({
      credential: cert({
        projectId: PROJECT_ID,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, "\n"),
      }),
    });
  }

  // Local development fallback:
  // set GOOGLE_APPLICATION_CREDENTIALS to your service-account JSON path.
  return initializeApp({
    projectId: PROJECT_ID,
  });
}

const firebaseApp = getFirebaseApp();
const db = getFirestore(firebaseApp);
const adminAuth = getAuth(firebaseApp);

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9\-_]+\]$/;

const SOUND_OPTIONS = {
  default: { sound: "notif_default.wav", channelId: "sound_default" },
  chime: { sound: "notif_chime.wav", channelId: "sound_chime" },
  pop: { sound: "notif_pop.wav", channelId: "sound_pop" },
  bubble: { sound: "notif_bubble.wav", channelId: "sound_bubble" },
  alert: { sound: "notif_alert.wav", channelId: "sound_alert" },
  silent: { sound: null, channelId: "sound_silent" },
};

const EMERGENCY_SOUND = { sound: "default", channelId: "emergency" };

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeTokens(value) {
  if (typeof value === "string") {
    return EXPO_TOKEN_RE.test(value) ? [value] : [];
  }

  if (!Array.isArray(value)) return [];

  return value.filter(
    (token) => typeof token === "string" && EXPO_TOKEN_RE.test(token)
  );
}

function notificationTitle(notification) {
  const actor = clean(notification.actorName) || "BondED";

  switch (clean(notification.type)) {
    case "event":
      return "New event";
    case "emergency":
      return "Emergency alert";
    case "moderation":
      return "BondED moderation";
    default:
      return actor;
  }
}

function buildPushData(notification, notificationId) {
  const entityType = clean(notification.entityType);
  return {
    notificationId,
    screen: entityType === "event" ? "event-calendar" : "notifications",
    type: clean(notification.type),
    entityType,
    entityId: clean(notification.entityId),
    ...(notification.parentId
      ? { parentId: clean(notification.parentId) }
      : {}),
  };
}

async function verifyCaller(req) {
  const header = req.get("authorization") || "";
  if (!header.startsWith("Bearer ")) {
    const error = new Error("Missing Firebase authentication token.");
    error.status = 401;
    throw error;
  }

  const idToken = header.slice(7).trim();
  if (!idToken) {
    const error = new Error("Missing Firebase authentication token.");
    error.status = 401;
    throw error;
  }

  return adminAuth.verifyIdToken(idToken);
}

async function sendExpoMessages(messages) {
  let total = 0;

  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);

    const response = await fetch(EXPO_PUSH_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });

    const text = await response.text();
    let result = {};
    try {
      result = JSON.parse(text || "{}");
    } catch {
      // Keep raw response in the error below.
    }

    if (!response.ok) {
      throw new Error(`Expo push failed (${response.status}): ${text}`);
    }

    const tickets = Array.isArray(result.data) ? result.data : [];
    const errors = tickets
      .map((ticket, index) => ({
        index,
        status: ticket?.status,
        message: ticket?.message || null,
        error: ticket?.details?.error || null,
      }))
      .filter((ticket) => ticket.status === "error");

    console.log("Expo push batch result", {
      count: batch.length,
      tickets: tickets.map((ticket) => ({
        status: ticket?.status || "unknown",
        message: ticket?.message || null,
        error: ticket?.details?.error || null,
      })),
    });

    if (errors.length) {
      console.warn("Expo push ticket errors", errors);
    }

    total += batch.length;
  }

  return total;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "bonded-notification-backend",
    projectId: PROJECT_ID,
  });
});

app.post("/notifications/push", async (req, res) => {
  try {
    const caller = await verifyCaller(req);

    const notificationId = clean(req.body?.notificationId);
    if (!notificationId) {
      return res.status(400).json({ error: "notificationId is required." });
    }

    const notificationRef = db.collection("notifications").doc(notificationId);
    const notificationSnap = await notificationRef.get();

    if (!notificationSnap.exists) {
      return res.status(404).json({ error: "Notification not found." });
    }

    const notification = notificationSnap.data() || {};
    const recipientId = clean(notification.recipientId);
    const actorId = clean(notification.actorId);

    // Same security rule as the current Cloudflare Worker:
    // only the actor who created the notification may ask the backend to push it.
    if (!recipientId) {
      return res.status(400).json({ error: "Notification has no recipientId." });
    }

    if (actorId !== caller.uid) {
      return res.status(403).json({
        error: "You cannot send this notification.",
      });
    }

    const [tokenSnap, settingsSnap] = await Promise.all([
      db.collection("userPushTokens").doc(recipientId).get(),
      db.collection("userNotificationSettings").doc(recipientId).get(),
    ]);

    if (!tokenSnap.exists) {
      return res.json({ sent: 0, reason: "No push-token document." });
    }

    const tokens = normalizeTokens(tokenSnap.data()?.expoPushTokens);

    if (!tokens.length) {
      return res.json({ sent: 0, reason: "No valid Expo push tokens." });
    }

    const type = clean(notification.type);
    const soundId = clean(settingsSnap.data()?.soundId) || "default";
    const sound =
      type === "emergency"
        ? EMERGENCY_SOUND
        : SOUND_OPTIONS[soundId] || SOUND_OPTIONS.default;

    const messages = tokens.map((token) => ({
      to: token,
      title: notificationTitle(notification),
      body:
        clean(notification.message) ||
        "You have a new BondED notification.",
      sound: sound.sound,
      priority: "high",
      channelId: sound.channelId,
      data: buildPushData(notification, notificationId),
    }));

    const sent = await sendExpoMessages(messages);

    return res.json({
      success: true,
      sent,
      tokenCount: tokens.length,
      notificationId,
    });
  } catch (error) {
    console.error("Notification push error:", error);

    return res.status(error.status || 500).json({
      error: error.message || "Notification push failed.",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `BondED notification backend listening on port ${PORT}`
  );
});

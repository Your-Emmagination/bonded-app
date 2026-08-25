const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const {
  getAuth,
} = require("firebase-admin/auth");
const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

initializeApp();

const auth = getAuth();
const db = getFirestore();

function getUserConfig(userType) {
  const type = String(userType || "student")
    .trim()
    .toLowerCase();

  const configs = {
    student: {
      domain: "@student.csap",
      role: "student",
    },

    moderator: {
      domain: "@student.csap",
      role: "moderator",
    },

    teacher: {
      domain: "@teacher.csap",
      role: "teacher",
    },

    admin: {
      domain: "@admin.csap",
      role: "admin",
    },
  };

  return configs[type] || configs.student;
}

function getRolePermissions(role) {
  const permissions = {
    student: {
      canPost: true,
      canComment: true,
      canLike: true,
      canReport: true,
      canDeleteOwnPost: true,
      canEditOwnPost: true,
      canVotePoll: true,
      canCreatePoll: true,
    },

    moderator: {
      canPost: true,
      canComment: true,
      canLike: true,
      canReport: true,
      canDeleteOwnPost: true,
      canEditOwnPost: true,
      canVotePoll: true,
      canCreatePoll: true,
      canDeleteAnyPost: true,
      canDeleteAnyComment: true,
      canBanUser: false,
      canViewReports: true,
      canManageReports: true,
    },

    teacher: {
      canPost: true,
      canComment: true,
      canLike: true,
      canReport: true,
      canDeleteOwnPost: true,
      canEditOwnPost: true,
      canVotePoll: true,
      canCreatePoll: true,
      canDeleteAnyPost: true,
      canDeleteAnyComment: true,
      canBanUser: false,
      canViewReports: true,
      canManageReports: true,
    },

    admin: {
      canPost: true,
      canComment: true,
      canLike: true,
      canReport: true,
      canDeleteOwnPost: true,
      canEditOwnPost: true,
      canVotePoll: true,
      canCreatePoll: true,
      canDeleteAnyPost: true,
      canDeleteAnyComment: true,
      canBanUser: true,
      canViewReports: true,
      canManageReports: true,
      canManageUsers: true,
      canManageRoles: true,
      canViewAnalytics: true,
    },
  };

  return permissions[role] || permissions.student;
}

function clean(value) {
  return String(value || "").trim();
}

function generatePassword(lastname) {
  return `${clean(lastname)}12345`;
}

function buildEmail(studentID, userType) {
  const config = getUserConfig(userType);

  return `${clean(studentID)}${config.domain}`.toLowerCase();
}

function validateUser(data) {
  const studentID = clean(data.studentID);
  const firstname = clean(data.firstname);
  const lastname = clean(data.lastname);
  const course = clean(data.course);
  const yearlvl = clean(data.yearlvl);
  const userType = clean(data.userType) || "student";

  if (!studentID) {
    throw new HttpsError(
      "invalid-argument",
      "Student/Staff ID is required."
    );
  }

  if (!firstname) {
    throw new HttpsError(
      "invalid-argument",
      "First name is required."
    );
  }

  if (!lastname) {
    throw new HttpsError(
      "invalid-argument",
      "Last name is required."
    );
  }

  return {
    studentID,
    firstname,
    lastname,
    course: course || "N/A",
    yearlvl: yearlvl || "N/A",
    userType,
  };
}

async function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "You must be signed in."
    );
  }

  const role = request.auth.token?.role;

  if (role !== "admin") {
    throw new HttpsError(
      "permission-denied",
      "Only administrators can register users."
    );
  }
}

const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";

const NOTIFICATION_SOUND_OPTIONS = {
  default: { sound: "notif_default.wav", channelId: "sound_default" },
  chime: { sound: "notif_chime.wav", channelId: "sound_chime" },
  pop: { sound: "notif_pop.wav", channelId: "sound_pop" },
  bubble: { sound: "notif_bubble.wav", channelId: "sound_bubble" },
  alert: { sound: "notif_alert.wav", channelId: "sound_alert" },
  silent: { sound: null, channelId: "sound_silent" },
};

const EMERGENCY_SOUND = { sound: "default", channelId: "emergency" };

function normalizeExpoPushTokens(value) {
  if (typeof value === "string") {
    return /^Expo(nent)?PushToken\[[A-Za-z0-9\-_]+\]$/.test(value)
      ? [value]
      : [];
  }

  if (!Array.isArray(value)) return [];

  return value.filter(
    (item) =>
      typeof item === "string" &&
      /^Expo(nent)?PushToken\[[A-Za-z0-9\-_]+\]$/.test(item),
  );
}

function notificationTitle(notification) {
  const actor = String(notification.actorName || "BondED").trim() || "BondED";

  switch (notification.type) {
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

async function sendExpoPushMessages(messages) {
  if (!messages.length) return 0;

  let sent = 0;

  for (let index = 0; index < messages.length; index += 100) {
    const batch = messages.slice(index, index + 100);
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`Expo push send failed: ${response.status} ${errorBody}`);
    }

    const result = await response.json().catch(() => null);
    const tickets = Array.isArray(result?.data) ? result.data : [];
    const rejected = tickets.filter((ticket) => ticket?.status === "error");
    if (rejected.length) {
      console.error("Expo push ticket errors:", rejected);
    }

    sent += batch.length;
  }

  return sent;
}

/**
 * Every Firestore notification becomes a push notification here.
 * This is intentionally server-side: students must never be allowed to list
 * or read another student's push token. Admin SDK can safely read the token
 * and sound preference and then send through Expo.
 */
exports.sendNotificationPush = onDocumentCreated(
  "notifications/{notificationId}",
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const notification = snapshot.data() || {};
    const recipientId = clean(notification.recipientId);
    if (!recipientId) return;

    const [tokenSnap, settingsSnap] = await Promise.all([
      db.collection("userPushTokens").doc(recipientId).get(),
      db.collection("userNotificationSettings").doc(recipientId).get(),
    ]);

    if (!tokenSnap.exists) return;

    const tokenData = tokenSnap.data() || {};
    const tokens = normalizeExpoPushTokens(tokenData.expoPushTokens);
    if (!tokens.length) return;

    const type = clean(notification.type);
    const soundId = String(settingsSnap.data()?.soundId || "default");
    const soundOption =
      type === "emergency"
        ? EMERGENCY_SOUND
        : NOTIFICATION_SOUND_OPTIONS[soundId] || NOTIFICATION_SOUND_OPTIONS.default;

    const entityType = clean(notification.entityType);
    const entityId = clean(notification.entityId);
    const parentId = clean(notification.parentId);

    const messages = tokens.map((token) => ({
      to: token,
      title: notificationTitle(notification),
      body: String(notification.message || "You have a new BondED notification."),
      sound: soundOption.sound,
      priority: "high",
      channelId: soundOption.channelId,
      data: {
        notificationId: snapshot.id,
        screen: entityType === "event" ? "event-calendar" : "notifications",
        entityType,
        entityId,
        parentId,
      },
    }));

    try {
      await sendExpoPushMessages(messages);
    } catch (error) {
      console.error(
        `Push delivery failed for notification ${snapshot.id}:`,
        error,
      );
    }
  },
);



const MODERATION_WORKER_URL =
  process.env.MODERATION_WORKER_URL ||
  "https://bonded-ai-worker.encaboemmz77.workers.dev";

async function requestServerModeration({ text, hasMedia }) {
  if (hasMedia) {
    return {
      status: "pending",
      reasons: [
        "Post contains media and requires moderator review before publishing.",
      ],
      matchedKeywords: [],
      moderationSource: "server-media-review",
    };
  }

  const response = await fetch(MODERATION_WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "moderate",
      text: String(text || "").trim(),
      scope: "post",
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `Moderation worker failed: HTTP ${response.status} ${
        payload?.error || "Unknown error"
      }`,
    );
  }

  return {
    status: payload?.status === "rejected" ? "rejected" :
      payload?.status === "pending" ? "pending" : "approved",
    reasons: Array.isArray(payload?.reasons) ? payload.reasons : [],
    matchedKeywords: Array.isArray(payload?.matchedKeywords)
      ? payload.matchedKeywords
      : [],
    moderationSource: "server-worker",
  };
}


const AI_WORKER_URL =
  process.env.AI_WORKER_URL ||
  "https://bonded-ai-worker.encaboemmz77.workers.dev";

const AI_ASSISTANT_ID = "ai-assistant";
const EVERYONE_MENTION_ID = "everyone-mention";

function cleanNotificationIdPart(value) {
  return String(value || "").replace(/[/.#$[\]]/g, "_");
}

function notificationPreview(value, maxLength = 120) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

async function createServerMentionNotifications({
  postId,
  postData,
  actorId,
}) {
  const taggedUsers = Array.isArray(postData.taggedUsers)
    ? postData.taggedUsers
    : [];

  const taggedIds = [...new Set(
    taggedUsers
      .map((tag) => clean(tag?.id))
      .filter(Boolean),
  )];

  if (!taggedIds.length) return;

  const recipientIds = new Set(
    taggedIds.filter(
      (id) => id !== AI_ASSISTANT_ID && id !== EVERYONE_MENTION_ID && id !== actorId,
    ),
  );

  if (taggedIds.includes(EVERYONE_MENTION_ID)) {
    const serverId = clean(postData.serverId);

    if (serverId) {
      const membershipSnapshot = await db
        .collection("communityServerMemberships")
        .where("serverId", "==", serverId)
        .get();

      membershipSnapshot.docs.forEach((item) => {
        const data = item.data() || {};
        if (String(data.status || "joined") === "removed") return;
        const userId = clean(data.userId);
        if (userId && userId !== actorId) recipientIds.add(userId);
      });

      const serverSnapshot = await db.collection("communityServers").doc(serverId).get();
      if (serverSnapshot.exists) {
        const serverData = serverSnapshot.data() || {};
        const ownerId = clean(serverData.ownerId || serverData.createdBy);
        if (ownerId && ownerId !== actorId) recipientIds.add(ownerId);
      }
    } else {
      const studentsSnapshot = await db.collection("students").get();
      studentsSnapshot.docs.forEach((item) => {
        const data = item.data() || {};
        const userId = clean(data.userId || item.id);
        if (userId && userId !== actorId) recipientIds.add(userId);
      });
    }
  }

  if (!recipientIds.size) return;

  const actorName = clean(postData.isAnonymous ? "Anonymous" : postData.authorName || postData.username) || "Someone";
  const preview = notificationPreview(postData.content);
  const batch = db.batch();

  for (const recipientId of recipientIds) {
    const notificationId = [
      "mention",
      cleanNotificationIdPart(recipientId),
      cleanNotificationIdPart(postId),
    ].join("_");

    const ref = db.collection("notifications").doc(notificationId);
    batch.set(ref, {
      recipientId,
      actorId,
      actorName,
      actorProfileImage: postData.authorProfileImage || null,
      actorIsAnonymous: Boolean(postData.isAnonymous),
      type: "mention",
      entityType: "post",
      entityId: postId,
      parentId: null,
      message: "mentioned you in a post",
      preview,
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: false });
  }

  await batch.commit();
}

async function reserveServerAiCooldown({ actorId, serverId, channelId, cooldownMs = 15000 }) {
  const safeActor = clean(actorId) || "unknown";
  const safeServer = clean(serverId) || "home";
  const safeChannel = clean(channelId) || "feed";
  const docId = [safeActor, safeServer, safeChannel]
    .map(cleanNotificationIdPart)
    .join("_");
  const ref = db.collection("aiCooldowns").doc(docId);
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const lastRequestedAtMs = Number(snap.data()?.lastRequestedAtMs || 0);
    const remainingMs = Math.max(0, cooldownMs - (now - lastRequestedAtMs));

    if (remainingMs > 0) {
      return { allowed: false, remainingMs };
    }

    transaction.set(ref, {
      actorId: safeActor,
      serverId: safeServer,
      channelId: safeChannel,
      lastRequestedAtMs: now,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { allowed: true, remainingMs: 0 };
  });
}

async function requestServerAiReply({ postId, postData }) {
  const prompt = clean(postData.aiPrompt);
  if (!prompt) return null;

  // Non-generative server fallback for @AI on approved posts. The main
  // client chatbot uses the trained Naive Bayes intent classifier. This
  // server path deliberately uses deterministic retrieval/templates only
  // and never calls an LLM provider.
  const text = prompt
    .toLowerCase()
    .replace(/@(?:ai|bondedai)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const mathText = text
    .replace(/\bplus\b/g, "+")
    .replace(/\bminus\b/g, "-")
    .replace(/\b(times|multiplied by|multiply by)\b/g, "*")
    .replace(/\b(divided by|divide by|over)\b/g, "/");
  const simpleMath = mathText.match(/(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)/);
  if (simpleMath) {
    const left = Number(simpleMath[1]);
    const op = simpleMath[2];
    const right = Number(simpleMath[3]);
    let result = null;
    if (op === "+") result = left + right;
    if (op === "-") result = left - right;
    if (op === "*") result = left * right;
    if (op === "/" && right !== 0) result = left / right;
    if (Number.isFinite(result)) {
      return { reply: `${simpleMath[0]} = ${result}`, model: "bonded-deterministic-server-v1" };
    }
  }

  if (/\b(hello|hi|hey|good morning|good afternoon|good evening)\b/.test(text)) {
    return {
      reply: "Hello! I'm Bonded AI. I can help with campus events, academic programs, school information, date/time, and basic calculations.",
      model: "bonded-deterministic-server-v1",
    };
  }

  if (/\b(date|day today|today's date)\b/.test(text)) {
    return {
      reply: `Today is ${new Intl.DateTimeFormat("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Manila" }).format(new Date())}.`,
      model: "bonded-deterministic-server-v1",
    };
  }

  if (/\b(time|current time|time now)\b/.test(text)) {
    return {
      reply: `The current Philippine time is ${new Intl.DateTimeFormat("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }).format(new Date())}.`,
      model: "bonded-deterministic-server-v1",
    };
  }

  if (/\b(event|events|schedule)\b/.test(text)) {
    const snapshot = await db.collection("events").get();
    const now = new Date();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const events = snapshot.docs
      .map((item) => ({ id: item.id, ...(item.data() || {}) }))
      .filter((event) => typeof event.date === "string" && event.date >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(0, 5);
    return {
      reply: events.length
        ? `Upcoming events: ${events.map((event) => `${clean(event.title) || "Untitled event"} on ${event.date}${event.startTime ? ` at ${event.startTime}` : ""}`).join("; ")}.`
        : "I couldn't find any upcoming campus events in the BondED database.",
      model: "bonded-deterministic-server-v1",
    };
  }

  if (/\b(program|programs|course|courses)\b/.test(text)) {
    const snapshot = await db.collection("programs").get();
    const programs = snapshot.docs
      .map((item) => item.data() || {})
      .slice(0, 10)
      .map((program) => program.code ? `${program.code} — ${program.name || "Program"}` : clean(program.name))
      .filter(Boolean);
    return {
      reply: programs.length
        ? `Programs currently listed in BondED: ${programs.join("; ")}.`
        : "I couldn't find any academic programs in the BondED database.",
      model: "bonded-deterministic-server-v1",
    };
  }

  return {
    reply: "I couldn't match that question to a supported BondED intent. Try asking about campus events, academic programs, date/time, or a basic calculation.",
    model: "bonded-deterministic-server-v1",
  };
}

async function runApprovedPostSideEffects(snapshot) {
  if (!snapshot?.exists) return;
  const data = snapshot.data() || {};
  if (data.moderationStatus !== "approved") return;
  if (data.publishedSideEffectsAtMs) return;

  const actorId = clean(data.userId || data.realUserId);
  if (!actorId) return;

  await createServerMentionNotifications({
    postId: snapshot.id,
    postData: data,
    actorId,
  });

  const taggedUsers = Array.isArray(data.taggedUsers) ? data.taggedUsers : [];
  const hasAiMention = taggedUsers.some(
    (tag) => clean(tag?.id) === AI_ASSISTANT_ID,
  );

  if (hasAiMention) {
    const cooldown = await reserveServerAiCooldown({
      actorId,
      serverId: data.serverId,
      channelId: data.channelId,
    });

    if (cooldown.allowed) {
      try {
        await snapshot.ref.update({
          aiReply: {
            text: "",
            status: "processing",
            generatedAtMs: Date.now(),
          },
        });

        const result = await requestServerAiReply({
          postId: snapshot.id,
          postData: data,
        });

        if (result) {
          await snapshot.ref.update({
            aiReply: {
              text: result.reply,
              model: result.model,
              status: "completed",
              generatedAtMs: Date.now(),
            },
          });
        }
      } catch (error) {
        console.error(`Approved post @AI request failed for ${snapshot.id}:`, error);
        await snapshot.ref.update({
          aiReply: {
            text: "",
            status: "failed",
            error: String(error?.message || error),
            generatedAtMs: Date.now(),
          },
        }).catch(() => undefined);
      }
    }
  }

  await snapshot.ref.update({
    publishedSideEffectsAtMs: Date.now(),
    publishedSideEffectsAt: FieldValue.serverTimestamp(),
  });
}

async function moderatePostSnapshot(snapshot) {
  if (!snapshot?.exists) return;

  const data = snapshot.data() || {};
  if (data.moderationStatus !== "pending") return;

  const text = String(data.content || "").trim();
  const files = Array.isArray(data.files) ? data.files : [];

  try {
    const decision = await requestServerModeration({
      text,
      hasMedia: files.length > 0,
    });

    await snapshot.ref.update({
      moderationStatus: decision.status,
      moderationReasons: decision.reasons,
      moderationMatchedKeywords: decision.matchedKeywords,
      moderationSource: decision.moderationSource,
      moderatedAtMs: Date.now(),
      moderatedAt: FieldValue.serverTimestamp(),
      ...(decision.status === "approved"
        ? { publishedSideEffectsAtMs: null, publishedSideEffectsAt: null }
        : {}),
    });

    if (decision.status === "approved") {
      // Refresh the document because the trigger snapshot still contains the
      // pre-moderation pending state.
      const approvedSnapshot = await snapshot.ref.get();
      await runApprovedPostSideEffects(approvedSnapshot);
    }
  } catch (error) {
    // Fail closed: a moderation outage must never publish unreviewed content.
    console.error(
      `Server moderation failed for post ${snapshot.id}; leaving it pending.`,
      error,
    );

    await snapshot.ref.update({
      moderationStatus: "pending",
      moderationReasons: [
        "Automatic moderation could not complete. This post requires review.",
      ],
      moderationSource: "server-fallback",
      moderationError: String(error?.message || error),
      moderatedAtMs: null,
    });
  }
}

exports.moderatePostOnCreate = onDocumentCreated(
  "posts/{postId}",
  async (event) => {
    await moderatePostSnapshot(event.data);
  },
);

exports.moderatePostOnUpdate = onDocumentUpdated(
  "posts/{postId}",
  async (event) => {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!before?.exists || !after?.exists) return;

    const beforeData = before.data() || {};
    const afterData = after.data() || {};

    // Only re-run moderation when the user changed the content or media and
    // the document has been put back into the pending state.
    const contentChanged =
      String(beforeData.content || "") !== String(afterData.content || "");
    const filesChanged =
      JSON.stringify(beforeData.files || []) !==
      JSON.stringify(afterData.files || []);

    if (
      afterData.moderationStatus === "pending" &&
      (contentChanged || filesChanged)
    ) {
      await moderatePostSnapshot(after);
    }
  },
);

exports.registerUser = onCall(
  async (request) => {
    await requireAdmin(request);

    const user = validateUser(request.data || {});

    const config = getUserConfig(user.userType);

    const email = buildEmail(
      user.studentID,
      user.userType
    );

    const password = generatePassword(
      user.lastname
    );

    let authUser;

    try {
      authUser = await auth.createUser({
        uid: user.studentID,
        email,
        password,
        displayName:
          `${user.firstname} ${user.lastname}`.trim(),
      });
    } catch (error) {
      if (error.code === "auth/uid-already-exists") {
        throw new HttpsError(
          "already-exists",
          `User ${user.studentID} already exists.`
        );
      }

      if (error.code === "auth/email-already-exists") {
        throw new HttpsError(
          "already-exists",
          `Email ${email} is already registered.`
        );
      }

      console.error(
        "Firebase Auth registration error:",
        error
      );

      throw new HttpsError(
        "internal",
        "Unable to create the authentication account."
      );
    }

    try {
      await auth.setCustomUserClaims(
        authUser.uid,
        {
          role: config.role,
        }
      );

      await db
        .collection("students")
        .doc(user.studentID)
        .set(
          {
            studentID: user.studentID,
            firstname: user.firstname,
            lastname: user.lastname,
            course: user.course,
            yearlvl: user.yearlvl,

            role: config.role,

            permissions:
              getRolePermissions(config.role),

            userId: authUser.uid,

            email,

            bio: "",
            isOnline: false,

            mustChangePassword: true,

            createdAt:
              FieldValue.serverTimestamp(),

            updatedAt:
              FieldValue.serverTimestamp(),
          },
          {
            merge: true,
          }
        );
    } catch (error) {
      console.error(
        "Registration database error:",
        error
      );

      // Roll back Auth account if Firestore fails.
      try {
        await auth.deleteUser(authUser.uid);
      } catch (deleteError) {
        console.error(
          "Rollback failed:",
          deleteError
        );
      }

      throw new HttpsError(
        "internal",
        "User creation could not be completed."
      );
    }

    return {
      success: true,

      uid: authUser.uid,

      studentID: user.studentID,

      email,

      temporaryPassword: password,

      role: config.role,
    };
  }
);
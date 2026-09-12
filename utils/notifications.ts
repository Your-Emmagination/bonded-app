import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "../Firebase_configure";
import { getAiWorkerUrl } from "./aiConfig";
import { EVERYONE_MENTION_ID } from "./aiAssistant";

export type NotificationType =
  | "direct_message"
  | "like"
  | "comment"
  | "reply"
  | "mention"
  | "activity"
  | "event"
  | "emergency"
  | "moderation"
  | "moderation_approved"
  | "server_deletion";

export type NotificationEntityType =
  | "direct_message"
  // A message in a community server channel. Kept distinct from "comment" so
  // the push can name the channel instead of calling it a comment.
  | "thread_message"
  | "post"
  | "poll"
  | "comment"
  | "reply"
  | "event"
  | "emergency";

type NotificationActor = {
  id: string;
  name?: string | null;
  profileImage?: string | null;
  isAnonymous?: boolean;
};

type CreateNotificationInput = {
  recipientId?: string | null;
  actor: NotificationActor;
  type: NotificationType;
  entityType: NotificationEntityType;
  entityId: string;
  message: string;
  preview?: string | null;
  parentId?: string | null;
  notificationId?: string;
};

type LikeNotificationInput = {
  recipientId?: string | null;
  actor: NotificationActor;
  entityType: Exclude<NotificationEntityType, "event" | "emergency" | "direct_message" | "thread_message">;
  entityId: string;
  preview?: string | null;
  parentId?: string | null;
};

type MentionNotificationInput = {
  recipientIds: string[];
  actor: NotificationActor;
  entityType: NotificationEntityType;
  entityId: string;
  message: string;
  preview?: string | null;
  parentId?: string | null;
  excludeUserIds?: string[];
};

type BroadcastEventNotificationInput = {
  actor: NotificationActor;
  entityId: string;
  title: string;
  description?: string | null;
  eventDate?: string | null;
  excludeUserIds?: string[];
};

type EmergencyNotificationInput = {
  recipientIds: string[];
  actor: NotificationActor;
  entityId: string;
  message: string;
  preview?: string | null;
  parentId?: string | null;
  excludeUserIds?: string[];
};

const NOTIFICATIONS_COLLECTION = "notifications";

const cleanIdPart = (value: string) => value.replace(/[/.#$[\]]/g, "_");

const buildLikeNotificationId = (
  recipientId: string,
  actorId: string,
  entityType: NotificationEntityType,
  entityId: string,
) =>
  [
    "like",
    cleanIdPart(recipientId),
    cleanIdPart(actorId),
    entityType,
    cleanIdPart(entityId),
  ].join("_");

const normalizeActorName = (actor: NotificationActor) => {
  if (actor.name?.trim()) {
    return actor.name.trim();
  }

  return actor.isAnonymous ? "Anonymous" : "Someone";
};

const sanitizePreview = (value?: string | null, maxLength = 120) => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
};

export const createNotification = async ({
  recipientId,
  actor,
  type,
  entityType,
  entityId,
  message,
  preview,
  parentId,
  notificationId,
}: CreateNotificationInput) => {
  if (!recipientId || !actor.id || recipientId === actor.id) {
    return;
  }

  const payload = {
    recipientId,
    actorId: actor.id,
    actorName: normalizeActorName(actor),
    actorProfileImage: actor.profileImage ?? null,
    actorIsAnonymous: Boolean(actor.isAnonymous),
    type,
    entityType,
    entityId,
    parentId: parentId ?? null,
    message,
    preview: sanitizePreview(preview),
    read: false,
    createdAt: serverTimestamp(),
  };

  let savedNotificationId = notificationId;

  if (notificationId) {
    await setDoc(doc(db, NOTIFICATIONS_COLLECTION, notificationId), payload, {
      merge: true,
    });
  } else {
    const notificationRef = await addDoc(
      collection(db, NOTIFICATIONS_COLLECTION),
      payload,
    );
    savedNotificationId = notificationRef.id;
  }

  // Events and emergency broadcasts already have dedicated fan-out senders
  // (they can send to many recipients at once), so do not send them a second
  // time through the single-notification gateway.
  if (type === "event" || type === "emergency") {
    return;
  }

  // Push delivery runs on the free Cloudflare Worker (cloudflare/ai-worker/
  // src/push.js) + the free Expo Push API — no billable server. The client
  // only sends this notification's id; the Worker re-reads the doc, checks
  // the caller is the notification's actor, applies the recipient's sound
  // setting, and sends. Fire-and-forget: a push failure must never break the
  // Firestore write or the like/comment action that triggered it.
  if (savedNotificationId && auth.currentUser) {
    try {
      const workerUrl = getAiWorkerUrl();
      if (!workerUrl) {
        if (__DEV__) {
          console.warn(
            "Push skipped: EXPO_PUBLIC_AI_WORKER_URL is not configured.",
          );
        }
        return;
      }

      const idToken = await auth.currentUser.getIdToken();
      const response = await fetch(workerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          mode: "push-notification",
          notificationId: savedNotificationId,
        }),
      });

      if (!response.ok && __DEV__) {
        console.warn(
          "Push worker failed:",
          response.status,
          await response.text().catch(() => ""),
        );
      }
    } catch (error) {
      console.warn("Push worker error:", error);
    }
  }
};

export const upsertLikeNotification = async ({
  recipientId,
  actor,
  entityType,
  entityId,
  preview,
  parentId,
}: LikeNotificationInput) => {
  if (!recipientId || recipientId === actor.id) {
    return;
  }

  const likeMessages: Record<
    Exclude<NotificationEntityType, "event" | "emergency" | "direct_message" | "thread_message">,
    string
  > = {
    post: "liked your post",
    poll: "liked your poll",
    comment: "liked your comment",
    reply: "liked your reply",
  };

  await createNotification({
    recipientId,
    actor,
    type: "like",
    entityType,
    entityId,
    parentId,
    preview,
    message: likeMessages[entityType],
    notificationId: buildLikeNotificationId(
      recipientId,
      actor.id,
      entityType,
      entityId,
    ),
  });
};

export const removeLikeNotification = async ({
  recipientId,
  actorId,
  entityType,
  entityId,
}: {
  recipientId?: string | null;
  actorId?: string | null;
  entityType: NotificationEntityType;
  entityId: string;
}) => {
  if (!recipientId || !actorId || recipientId === actorId) {
    return;
  }

  await deleteDoc(
    doc(
      db,
      NOTIFICATIONS_COLLECTION,
      buildLikeNotificationId(recipientId, actorId, entityType, entityId),
    ),
  );
};

export const createMentionNotifications = async ({
  recipientIds,
  actor,
  entityType,
  entityId,
  message,
  preview,
  parentId,
  excludeUserIds = [],
}: MentionNotificationInput) => {
  const excludedIds = new Set([...excludeUserIds, actor.id]);
  const uniqueRecipientIds = [...new Set(recipientIds)].filter(
    (recipientId) => recipientId && !excludedIds.has(recipientId),
  );

  await Promise.all(
    uniqueRecipientIds.map((recipientId) =>
      createNotification({
        recipientId,
        actor,
        type: "mention",
        entityType,
        entityId,
        parentId,
        preview,
        message,
      }),
    ),
  );
};

export const resolveMentionRecipientIds = async ({
  taggedUserIds,
  actorId,
  serverId,
}: {
  taggedUserIds: string[];
  actorId?: string | null;
  serverId?: string | null;
}) => {
  const normalizedIds = [...new Set(taggedUserIds.filter(Boolean))];
  const directRecipientIds = normalizedIds.filter(
    (recipientId) => recipientId !== EVERYONE_MENTION_ID,
  );

  if (!normalizedIds.includes(EVERYONE_MENTION_ID)) {
    return directRecipientIds.filter((recipientId) => recipientId !== actorId);
  }

  const everyoneRecipientIds = new Set<string>();

  if (serverId) {
    const [membershipSnapshot, serverSnapshot] = await Promise.all([
      getDocs(
        query(
          collection(db, "communityServerMemberships"),
          where("serverId", "==", serverId),
        ),
      ),
      getDoc(doc(db, "communityServers", serverId)),
    ]);

    membershipSnapshot.docs.forEach((item) => {
      const data = item.data();
      const status = String(data?.status || "joined");
      const userId = String(data?.userId || "");
      if (status !== "removed" && userId) {
        everyoneRecipientIds.add(userId);
      }
    });

    if (serverSnapshot.exists()) {
      const serverData = serverSnapshot.data();
      const ownerId = String(serverData?.ownerId || serverData?.createdBy || "");
      if (ownerId) {
        everyoneRecipientIds.add(ownerId);
      }
    }
  } else {
    const studentsSnapshot = await getDocs(collection(db, "students"));
    studentsSnapshot.docs.forEach((item) => {
      const data = item.data();
      const userId = String(data?.userId || item.id || "");
      if (userId) {
        everyoneRecipientIds.add(userId);
      }
    });
  }

  return [...new Set([...directRecipientIds, ...everyoneRecipientIds])].filter(
    (recipientId) => recipientId && recipientId !== actorId,
  );
};

export const createBroadcastEventNotifications = async ({
  actor,
  entityId,
  title,
  description,
  eventDate,
  excludeUserIds = [],
}: BroadcastEventNotificationInput) => {
  const studentsSnapshot = await getDocs(collection(db, "students"));
  const excludedIds = new Set([...excludeUserIds, actor.id].filter(Boolean));
  const recipientIds = Array.from(
    new Set(
      studentsSnapshot.docs
        .map((item) => {
          const data = item.data();
          return String(data?.userId || item.id || "").trim();
        })
        .filter((recipientId) => recipientId && !excludedIds.has(recipientId)),
    ),
  );

  const previewParts = [title.trim(), eventDate?.trim(), description?.trim()].filter(Boolean);

  await Promise.all(
    recipientIds.map((recipientId) =>
      createNotification({
        recipientId,
        actor,
        type: "event",
        entityType: "event",
        entityId,
        message: "scheduled a new event",
        preview: previewParts.join(" - "),
      }),
    ),
  );
};

export const createEmergencyNotifications = async ({
  recipientIds,
  actor,
  entityId,
  message,
  preview,
  parentId,
  excludeUserIds = [],
}: EmergencyNotificationInput) => {
  const excludedIds = new Set([...excludeUserIds, actor.id].filter(Boolean));
  const uniqueRecipientIds = [...new Set(recipientIds)].filter(
    (recipientId) => recipientId && !excludedIds.has(recipientId),
  );

  await Promise.all(
    uniqueRecipientIds.map((recipientId) =>
      createNotification({
        recipientId,
        actor,
        type: "emergency",
        entityType: "emergency",
        entityId,
        parentId,
        message,
        preview,
      }),
    ),
  );
};

export type ModerationNotificationInput = {
  recipientId?: string | null;
  moderator: NotificationActor;
  entityType: Exclude<NotificationEntityType, "event" | "emergency" | "direct_message" | "thread_message">;
  entityId: string;
  reasons?: string[];
  preview?: string | null;
  parentId?: string | null;
};

const MODERATION_ENTITY_LABEL: Record<
  Exclude<NotificationEntityType, "event" | "emergency" | "direct_message" | "thread_message">,
  string
> = {
  post: "post",
  poll: "poll",
  comment: "comment",
  reply: "reply",
};

/**
 * Notifies a student when a moderator removes their flagged content, so it
 * doesn't just silently disappear from their feed with no explanation.
 */
export const createModerationNotification = async ({
  recipientId,
  moderator,
  entityType,
  entityId,
  reasons,
  preview,
  parentId,
}: ModerationNotificationInput) => {
  const label = MODERATION_ENTITY_LABEL[entityType];
  const reasonSuffix = reasons?.length
    ? ` (${reasons.join(", ")})`
    : "";

  await createNotification({
    recipientId,
    actor: moderator,
    type: "moderation",
    entityType,
    entityId,
    parentId,
    preview,
    message: `removed your ${label} for violating community guidelines${reasonSuffix}`,
  });
};

export type ModerationApprovalNotificationInput = {
  recipientId?: string | null;
  moderator: NotificationActor;
  entityType: "post" | "poll";
  entityId: string;
  preview?: string | null;
};

export const createModerationApprovalNotification = async ({
  recipientId,
  moderator,
  entityType,
  entityId,
  preview,
}: ModerationApprovalNotificationInput) => {
  if (!recipientId) return;

  await createNotification({
    recipientId,
    actor: moderator,
    type: "moderation_approved",
    entityType,
    entityId,
    preview,
    message: `approved your ${entityType}. It is now visible on Home`,
    notificationId: [
      "moderation_approved",
      cleanIdPart(recipientId),
      cleanIdPart(moderator.id),
      entityType,
      cleanIdPart(entityId),
    ].join("_"),
  });
};

export type ServerDeletionOutcomeNotificationInput = {
  recipientId?: string | null;
  admin: NotificationActor;
  serverId: string;
  serverName: string;
  approved: boolean;
};

/**
 * Task 6: tells the teacher who asked for a server to be deleted what the
 * reviewing admin decided — approved (the server is gone) or rejected (it
 * stays). Informational only, so it carries no navigable entity id.
 */
export const createServerDeletionOutcomeNotification = async ({
  recipientId,
  admin,
  serverId,
  serverName,
  approved,
}: ServerDeletionOutcomeNotificationInput) => {
  await createNotification({
    recipientId,
    actor: admin,
    type: "server_deletion",
    // Not a navigable target — "server" is just a label; the empty entityId
    // makes the notification list treat a tap as a no-op.
    entityType: "server" as NotificationEntityType,
    entityId: "",
    message: approved
      ? `approved your request to delete "${serverName}". The server has been removed.`
      : `rejected your request to delete "${serverName}". The server is still active.`,
    notificationId: [
      "server_deletion",
      cleanIdPart(recipientId || ""),
      cleanIdPart(serverId),
    ].join("_"),
  });
};

export const subscribeToUnreadNotificationCount = (
  recipientId: string | null | undefined,
  onChange: (count: number) => void,
) => {
  if (!recipientId) {
    onChange(0);
    return () => undefined;
  }

  const notificationsQuery = query(
    collection(db, NOTIFICATIONS_COLLECTION),
    where("recipientId", "==", recipientId),
    where("read", "==", false),
  );

  return onSnapshot(
    notificationsQuery,
    (snapshot) => onChange(snapshot.size),
    (error) => {
      console.error("Error subscribing to unread notifications:", error);
      onChange(0);
    },
  );
};

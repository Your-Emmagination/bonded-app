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
import { db } from "../Firebase_configure";
import { EVERYONE_MENTION_ID } from "./aiAssistant";

export type NotificationType =
  | "like"
  | "comment"
  | "reply"
  | "mention"
  | "activity"
  | "event";

export type NotificationEntityType = "post" | "comment" | "reply" | "event";

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
  entityType: Exclude<NotificationEntityType, "event">;
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

  if (notificationId) {
    await setDoc(doc(db, NOTIFICATIONS_COLLECTION, notificationId), payload, {
      merge: true,
    });
    return;
  }

  await addDoc(collection(db, NOTIFICATIONS_COLLECTION), payload);
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

  const likeMessages: Record<Exclude<NotificationEntityType, "event">, string> = {
    post: "liked your post",
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

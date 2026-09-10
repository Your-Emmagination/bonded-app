// utils/directMessages.ts
import {
    arrayRemove,
    arrayUnion,
    collection,
    doc,
    increment,
    limitToLast,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    runTransaction,
    updateDoc,
    where,
    type Unsubscribe
} from "firebase/firestore";
import { db } from "../Firebase_configure";
import { createNotification } from "./notifications";
import { isConversationVisible, receiptCoversMessage, timestampMillis } from "./messengerState";

export const DIRECT_MESSAGE_PAGE_SIZE = 50;

export type ThemeOption = {
  id: string;
  name: string;
  color: string;
};

export const MESSENGER_THEMES: ThemeOption[] = [
  { id: "crimson", name: "BondED Crimson", color: "#8f2117" },
  { id: "blue", name: "Ocean Blue", color: "#1d4ed8" },
  { id: "green", name: "Emerald Green", color: "#059669" },
  { id: "purple", name: "Royal Purple", color: "#7c3aed" },
  { id: "gold", name: "Sunset Gold", color: "#e0a53d" },
  { id: "pink", name: "Rose Pink", color: "#db2777" },
  { id: "midnight", name: "Midnight Charcoal", color: "#262626" },
];

export const DEFAULT_THEME_COLOR = "#8f2117";

export type ParticipantDetail = {
  displayName: string;
  role?: string | null;
  profileImage?: string | null;
  studentID?: string | null;
  email?: string | null;
};

export type DirectConversation = {
  id: string;
  type: "direct" | "group";
  participants: string[];
  participantDetails: Record<string, ParticipantDetail>;
  nicknames?: Record<string, string>;
  themeColor?: string;
  quickEmoji?: string;
  lastMessage?: {
    id?: string;
    text: string;
    senderId: string;
    senderName?: string;
    createdAt: any;
    status?: "sent" | "delivered" | "seen";
    isImage?: boolean;
    isFile?: boolean;
  };
  unreadCounts?: Record<string, number>;
  lastReadAt?: Record<string, any>;
  lastDeliveredAt?: Record<string, any>;
  deletedThrough?: Record<string, any>;
  mutedBy?: string[];
  pinnedMessageIds?: string[];
  createdAt?: any;
  updatedAt?: any;
};

export type DirectFileAttachment = {
  url: string;
  mimeType: string;
  name?: string;
  size?: number;
};

export type DirectMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string | null;
  senderRole?: string | null;
  text: string;
  files?: DirectFileAttachment[];
  link?: { url: string; title: string };
  replyTo?: { id: string; senderName: string; preview: string };
  reactions?: Record<string, string[]>;
  pinned?: boolean;
  pinnedAt?: any;
  pinnedBy?: string;
  forwarded?: boolean;
  forwardedFrom?: { senderName?: string; preview?: string };
  status: "sent" | "delivered" | "seen";
  seenBy?: Record<string, any>;
  createdAt: any;
  editedAt?: any;
  deleted?: boolean;
};

/**
 * Deterministic conversation ID for two users. Ensures only one 1-on-1 thread exists.
 */
export function getDirectConversationId(uid1: string, uid2: string): string {
  return [uid1, uid2].sort().join("_");
}

export type ParticipantInfo = {
  uid: string;
  displayName?: string;
  role?: string | null;
  profileImage?: string | null;
  studentID?: string;
};

/** Shared by every Message button. Opening a chat must not write to Firestore. */
export function getDirectChatParams(currentUid: string, recipient: ParticipantInfo) {
  if (!currentUid || !recipient.uid || currentUid === recipient.uid) {
    throw new Error("Both current user and recipient IDs are required.");
  }
  return {
    conversationId: getDirectConversationId(currentUid, recipient.uid),
    recipientId: recipient.uid,
    recipientName: recipient.displayName || "User",
    recipientAvatar: recipient.profileImage || "",
    recipientRole: recipient.role || "student",
    recipientStudentID: recipient.studentID || "",
  };
}

function newConversation(conversationId: string, sender: ParticipantInfo, recipient: ParticipantInfo): DirectConversation {
  const detail = (user: ParticipantInfo): ParticipantDetail => ({
    displayName: user.displayName || "User", role: user.role || "student",
    profileImage: user.profileImage || null, studentID: user.studentID || null,
  });
  return {
    id: conversationId, type: "direct", participants: [sender.uid, recipient.uid],
    participantDetails: { [sender.uid]: detail(sender), [recipient.uid]: detail(recipient) },
    nicknames: {}, themeColor: DEFAULT_THEME_COLOR, quickEmoji: "👍",
    unreadCounts: { [sender.uid]: 0, [recipient.uid]: 0 },
    lastReadAt: {}, lastDeliveredAt: {}, deletedThrough: {}, mutedBy: [], pinnedMessageIds: [],
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  };
}

/**
 * Real-time listener for all active conversations the user participates in.
 */
export function subscribeToUserConversations(
  userId: string,
  onUpdate: (conversations: DirectConversation[]) => void,
): Unsubscribe {
  if (!userId) {
    onUpdate([]);
    return () => {};
  }

  const q = query(
    collection(db, "directConversations"),
    where("participants", "array-contains", userId),
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const convs: DirectConversation[] = snapshot.docs.map((docSnap) => {
        return {
          id: docSnap.id,
          ...(docSnap.data() as Omit<DirectConversation, "id">),
        };
      }).filter((conversation) => isConversationVisible(conversation, userId));

      // Sort newest updated first
      convs.sort((a, b) => {
        const timeA = a.updatedAt?.toMillis?.() ?? (a.createdAt?.toMillis?.() ?? 0);
        const timeB = b.updatedAt?.toMillis?.() ?? (b.createdAt?.toMillis?.() ?? 0);
        return timeB - timeA;
      });

      onUpdate(convs);
    },
    (err) => {
      console.warn("[directMessages] subscribeToUserConversations error:", err);
      onUpdate([]);
    },
  );
}

/**
 * Real-time listener for total unread direct message count for a user.
 */
export function subscribeToTotalUnreadMessages(
  userId: string,
  onCountChange: (count: number) => void,
): Unsubscribe {
  return subscribeToUserConversations(userId, (conversations) => {
    let total = 0;
    for (const conv of conversations) {
      total += conv.unreadCounts?.[userId] || 0;
    }
    onCountChange(total);
  });
}

/**
 * Real-time listener for messages in a conversation.
 */
export function subscribeToDirectMessages(
  conversationId: string,
  onUpdate: (messages: DirectMessage[]) => void,
  pageSize = DIRECT_MESSAGE_PAGE_SIZE,
  onError?: (error: Error) => void,
  deletedThrough?: any,
): Unsubscribe {
  if (!conversationId) {
    onUpdate([]);
    return () => {};
  }

  const q = query(
    collection(db, "directConversations", conversationId, "messages"),
    ...(deletedThrough ? [where("createdAt", ">", deletedThrough)] : []),
    orderBy("createdAt", "asc"),
    limitToLast(pageSize),
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const messages: DirectMessage[] = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<DirectMessage, "id">),
      }));
      onUpdate(messages);
    },
    (err) => {
      console.warn("[directMessages] subscribeToDirectMessages error:", err);
      onError?.(err);
    },
  );
}

/**
 * Send a message in a conversation.
 */
export async function sendDirectMessage({
  conversationId,
  sender,
  recipient,
  text,
  files = [],
  link,
  replyTo,
  forwarded,
  forwardedFrom,
  messageId,
}: {
  conversationId: string;
  sender: { uid: string; displayName: string; profileImage?: string | null; role?: string | null; studentID?: string };
  recipient?: ParticipantInfo;
  text: string;
  files?: DirectFileAttachment[];
  link?: { url: string; title: string };
  replyTo?: { id: string; senderName: string; preview: string };
  forwarded?: boolean;
  forwardedFrom?: { senderName?: string; preview?: string };
  recipients: string[];
  messageId?: string;
}): Promise<string> {
  const messagesCol = collection(db, "directConversations", conversationId, "messages");
  const messageRef = messageId ? doc(messagesCol, messageId) : doc(messagesCol);
  const convRef = doc(db, "directConversations", conversationId);
  if (!text.trim() && files.length === 0) throw new Error("A message cannot be empty.");
  if (text.trim().length > 2000) throw new Error("Messages must be 2,000 characters or fewer.");

  const messagePayload: Omit<DirectMessage, "id"> = {
    conversationId,
    senderId: sender.uid,
    senderName: sender.displayName,
    senderAvatar: sender.profileImage || null,
    senderRole: sender.role || "student",
    text: text.trim(),
    files,
    ...(link ? { link } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(forwarded ? { forwarded: true, ...(forwardedFrom ? { forwardedFrom } : {}) } : {}),
    status: "sent",
    seenBy: { [sender.uid]: serverTimestamp() },
    reactions: {},
    pinned: false,
    createdAt: serverTimestamp(),
  };

  // The message, preview, and unread counts commit together. Retrying the same
  // message ID cannot send a duplicate or increment unread counts twice.
  const notifyRecipients = await runTransaction(db, async (transaction) => {
    const conversationSnap = await transaction.get(convRef);
    let conversation: DirectConversation;
    if (conversationSnap.exists()) {
      conversation = conversationSnap.data() as DirectConversation;
      const existingMessage = await transaction.get(messageRef);
      if (existingMessage.exists()) return [] as string[];
    } else {
      if (!recipient || getDirectChatParams(sender.uid, recipient).conversationId !== conversationId) {
        throw new Error("Recipient details are required to start this conversation.");
      }
      conversation = newConversation(conversationId, sender, recipient);
    }
    if (!conversation.participants.includes(sender.uid)) throw new Error("Not a conversation participant.");
    const actualRecipients = conversation.participants.filter((id) => id !== sender.uid);
    const unreadUpdates: Record<string, any> = {};
    for (const id of actualRecipients) unreadUpdates[`unreadCounts.${id}`] = increment(1);
    transaction.set(messageRef, messagePayload);
    const conversationUpdate = {
      lastMessage: {
        id: messageRef.id,
        text: text.trim() || (files.length > 0 ? (files[0].mimeType.startsWith("image/") ? "Sent an image" : "Sent a file") : ""),
        senderId: sender.uid,
        senderName: sender.displayName,
        createdAt: serverTimestamp(),
        status: "sent",
        isImage: files.some((f) => f.mimeType.startsWith("image/")),
        isFile: files.some((f) => !f.mimeType.startsWith("image/")),
      },
      updatedAt: serverTimestamp(),
    };
    if (conversationSnap.exists()) {
      transaction.update(convRef, {
        ...conversationUpdate, ...unreadUpdates,
        [`participantDetails.${sender.uid}`]: {
          displayName: sender.displayName, role: sender.role || "student",
          profileImage: sender.profileImage || null,
          studentID: sender.studentID || conversation.participantDetails?.[sender.uid]?.studentID || null,
        },
      });
    } else {
      // The first message and inbox entry become visible in the same commit.
      transaction.set(convRef, {
        ...conversation, ...conversationUpdate,
        unreadCounts: { [sender.uid]: 0, [recipient!.uid]: 1 },
      });
    }
    return actualRecipients.filter((id) => !conversation.mutedBy?.includes(id));
  });

  // Recipients and mute preferences come from the committed conversation.
  for (const recipientId of notifyRecipients) {
      void createNotification({
        recipientId,
        actor: {
          id: sender.uid,
          name: sender.displayName,
          profileImage: sender.profileImage || null,
        },
        type: "direct_message",
        entityType: "direct_message",
        entityId: messageRef.id,
        notificationId: `dm_${messageRef.id}_${recipientId}`,
        parentId: conversationId,
        message: "sent you a message",
        preview: text.trim() || (files.length > 0 ? "Sent an attachment" : "Message"),
      }).catch((e) => console.warn("[directMessages] notification error:", e));
  }

  return messageRef.id;
}

export function createDirectMessageId(conversationId: string) {
  return doc(collection(db, "directConversations", conversationId, "messages")).id;
}

/** Delete only this participant's view, keeping the shared history for the other person.
 * The transaction serializes against sends so messages committed after deletion return to the inbox. */
export async function deleteDirectConversationForMe(conversationId: string, userId: string): Promise<void> {
  const ref = doc(db, "directConversations", conversationId);
  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists()) return;
    const conversation = snap.data() as DirectConversation;
    if (!conversation.participants.includes(userId)) throw new Error("Not a conversation participant.");
    if (!conversation.lastMessage?.createdAt) return;
    transaction.update(ref, {
      [`deletedThrough.${userId}`]: conversation.lastMessage.createdAt,
      [`unreadCounts.${userId}`]: 0,
    });
  });
}

/**
 * Mark a conversation as seen by the current user.
 * Advances the read cursor to rendered messages, without clearing newer arrivals.
 */
export async function markConversationAsSeen(
  conversationId: string,
  currentUserId: string,
  messages: DirectMessage[],
): Promise<void> {
  if (!conversationId || !currentUserId) return;

  const latest = messages.reduce<DirectMessage | undefined>((previous, message) =>
    timestampMillis(message.createdAt) > timestampMillis(previous?.createdAt) ? message : previous, undefined);
  if (!latest) return;
  const convRef = doc(db, "directConversations", conversationId);
  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(convRef);
    if (!snap.exists()) return;
    const conversation = snap.data() as DirectConversation;
    const updates: Record<string, any> = {};
    if (!receiptCoversMessage(conversation.lastReadAt?.[currentUserId], latest.createdAt)) {
      updates[`lastReadAt.${currentUserId}`] = latest.createdAt;
    }
    // A message may arrive after the rendered snapshot. Never clear its badge
    // or stamp it as read using the current wall clock.
    if (receiptCoversMessage(latest.createdAt, conversation.lastMessage?.createdAt) &&
        (conversation.unreadCounts?.[currentUserId] || 0) > 0) {
      updates[`unreadCounts.${currentUserId}`] = 0;
    }
    if (Object.keys(updates).length) transaction.update(convRef, updates);
  });
}

/** Delivery means the recipient's active app received the conversation update. */
export function subscribeToDirectMessageDelivery(userId: string): Unsubscribe {
  return onSnapshot(query(collection(db, "directConversations"), where("participants", "array-contains", userId)), { includeMetadataChanges: true }, (snapshot) => {
    if (snapshot.metadata.fromCache) return;
    // Query-level cache confirmation can arrive without a document change.
    for (const conversationDoc of snapshot.docs) {
      if (conversationDoc.metadata.hasPendingWrites) continue;
      const conversation = conversationDoc.data() as DirectConversation;
      const latest = conversation.lastMessage;
      if (!latest || latest.senderId === userId || !timestampMillis(latest.createdAt) ||
          receiptCoversMessage(conversation.lastDeliveredAt?.[userId], latest.createdAt)) continue;
      void runTransaction(db, async (transaction) => {
        const fresh = await transaction.get(conversationDoc.ref);
        if (!fresh.exists() || receiptCoversMessage(fresh.data().lastDeliveredAt?.[userId], latest.createdAt)) return;
        transaction.update(conversationDoc.ref, { [`lastDeliveredAt.${userId}`]: latest.createdAt });
      }).catch((error) => console.warn("[directMessages] Delivery receipt failed:", error));
    }
  }, (error) => console.warn("[directMessages] Delivery listener failed:", error));
}

export async function deleteDirectMessage(conversationId: string, message: DirectMessage) {
  const convRef = doc(db, "directConversations", conversationId);
  const msgRef = doc(convRef, "messages", message.id);
  await runTransaction(db, async (transaction) => {
    const conversationSnap = await transaction.get(convRef);
    const messageSnap = await transaction.get(msgRef);
    if (!conversationSnap.exists() || !messageSnap.exists()) return;
    const conversation = conversationSnap.data() as DirectConversation;
    // A tombstone preserves message order, reply references, and receipt cursors.
    transaction.update(msgRef, { text: "Message deleted", files: [], deleted: true, pinned: false, editedAt: serverTimestamp() });
    const updates: Record<string, any> = { pinnedMessageIds: arrayRemove(message.id) };
    if (conversation.lastMessage?.id === message.id || (!conversation.lastMessage?.id &&
        conversation.lastMessage?.senderId === message.senderId &&
        timestampMillis(conversation.lastMessage?.createdAt) === timestampMillis(message.createdAt))) {
      updates.lastMessage = { ...conversation.lastMessage, text: "Message deleted", isImage: false, isFile: false };
    }
    transaction.update(convRef, updates);
  });
}

/**
 * Toggle an emoji reaction on a direct message.
 */
export async function toggleDirectMessageReaction(
  conversationId: string,
  messageId: string,
  userId: string,
  emoji: string,
  currentReactions: Record<string, string[]> = {},
): Promise<void> {
  const msgRef = doc(db, "directConversations", conversationId, "messages", messageId);
  const currentUsers = currentReactions[emoji] || [];
  const alreadyReacted = currentUsers.includes(userId);

  if (alreadyReacted) {
    await updateDoc(msgRef, {
      [`reactions.${emoji}`]: arrayRemove(userId),
    });
  } else {
    await updateDoc(msgRef, {
      [`reactions.${emoji}`]: arrayUnion(userId),
    });
  }
}

/**
 * Pin or unpin a direct message in a conversation.
 */
export async function togglePinDirectMessage(
  conversationId: string,
  messageId: string,
  shouldPin: boolean,
  userId: string,
): Promise<void> {
  const msgRef = doc(db, "directConversations", conversationId, "messages", messageId);
  const convRef = doc(db, "directConversations", conversationId);

  await updateDoc(msgRef, {
    pinned: shouldPin,
    pinnedAt: shouldPin ? serverTimestamp() : null,
    pinnedBy: shouldPin ? userId : null,
  });

  await updateDoc(convRef, {
    pinnedMessageIds: shouldPin ? arrayUnion(messageId) : arrayRemove(messageId),
  });
}

/**
 * Update the conversation theme color.
 */
export async function updateConversationTheme(
  conversationId: string,
  themeColor: string,
): Promise<void> {
  const convRef = doc(db, "directConversations", conversationId);
  await updateDoc(convRef, { themeColor });
}

/**
 * Update a participant's nickname in the conversation.
 */
export async function updateConversationNickname(
  conversationId: string,
  targetUserId: string,
  nickname: string,
): Promise<void> {
  const convRef = doc(db, "directConversations", conversationId);
  await updateDoc(convRef, {
    [`nicknames.${targetUserId}`]: nickname.trim() || null,
  });
}

/**
 * Toggle notification mute for this conversation for the current user.
 */
export async function toggleMuteConversation(
  conversationId: string,
  userId: string,
  isMuted: boolean,
): Promise<void> {
  const convRef = doc(db, "directConversations", conversationId);
  await updateDoc(convRef, {
    mutedBy: isMuted ? arrayUnion(userId) : arrayRemove(userId),
  });
}

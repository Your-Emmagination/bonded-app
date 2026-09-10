// Pure state helpers shared by presence, receipts, and regression tests.
export const PRESENCE_TIMEOUT_MS = 90_000;

export function timestampMillis(value: any): number {
  const result = typeof value?.toMillis === "function" ? value.toMillis()
    : value instanceof Date ? value.getTime()
    : typeof value === "number" ? value
    : typeof value?.seconds === "number" ? value.seconds * 1000 + (value.nanoseconds || 0) / 1_000_000 : 0;
  return Number.isFinite(result) ? result : 0;
}

export type PresenceData = {
  isOnline?: boolean;
  lastSeen?: any;
  activeStatusEnabled?: boolean;
  presenceSessions?: Record<string, { isOnline?: boolean; lastSeen?: any }>;
};

export function getPresenceState(data: PresenceData | null | undefined, now = Date.now()) {
  if (data?.activeStatusEnabled === false) return { active: false, label: "Offline" };
  const sessions = Object.values(data?.presenceSessions || {});
  const sources = sessions.length ? sessions : data ? [data] : [];
  const active = sources.some((session) => {
    const seen = timestampMillis(session.lastSeen);
    return session.isOnline === true && seen > 0 && now - seen < PRESENCE_TIMEOUT_MS;
  });
  if (active) return { active: true, label: "Active" };
  const lastSeen = Math.max(0, ...sources.map((session) => timestampMillis(session.lastSeen)));
  if (!lastSeen) return { active: false, label: "Offline" };
  const minutes = Math.floor(Math.max(0, now - lastSeen) / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const elapsed = minutes < 1 ? "just now"
    : minutes < 60 ? `${minutes} minute${minutes === 1 ? "" : "s"} ago`
    : hours < 24 ? `${hours} hour${hours === 1 ? "" : "s"} ago`
    : `${days} day${days === 1 ? "" : "s"} ago`;
  return { active: false, label: `Offline · ${elapsed}` };
}

export function receiptCoversMessage(receipt: any, createdAt: any): boolean {
  const created = timestampMillis(createdAt);
  return created > 0 && timestampMillis(receipt) >= created;
}

export function isMessageAfterDeletion(createdAt: any, deletedThrough: any): boolean {
  return timestampMillis(createdAt) > timestampMillis(deletedThrough);
}

/** Inbox membership depends on a sent message, never merely opening a chat. */
export function isConversationVisible(conversation: {
  lastMessage?: { createdAt: any };
  deletedThrough?: Record<string, any>;
}, userId: string): boolean {
  return !!conversation.lastMessage &&
    isMessageAfterDeletion(conversation.lastMessage.createdAt, conversation.deletedThrough?.[userId]);
}

export function getDirectNotificationTarget(data: {
  entityType?: unknown; parentId?: unknown; message?: unknown;
}) {
  const direct = data.entityType === "direct_message" ||
    (data.entityType === "comment" && data.message === "sent you a message");
  return direct && typeof data.parentId === "string" && data.parentId && !data.parentId.includes("/")
    ? data.parentId : null;
}

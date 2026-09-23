// utils/supportTickets.ts
//
// Help & Support tickets.
//
// Named "Help & Support" rather than Customer Service or Tech Support on
// purpose. Nobody here is a customer, and most of what students actually
// report is records or account work an administrator resolves ("my year level
// is wrong", "I can't see the BSIT server") rather than a bug a developer
// fixes. A narrow name would turn those away, and they are exactly the
// tickets worth having. The welcoming name lives in the UI; the routing lives
// in `category`.
//
// Deliberately separate from ReportManagementScreen: that reports *content* a
// student objects to, this reports *problems* with the app or their account.
// Same shape, different domain.
import Constants from "expo-constants";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { Platform } from "react-native";

import { auth, db } from "../Firebase_configure";
import { createNotification } from "./notifications";
import { getStudentDocIdFromAuthUser, getUserData } from "./rbac";

export type TicketStatus = "open" | "in_progress" | "resolved" | "closed";

export type TicketCategory =
  | "account"
  | "records"
  | "content"
  | "technical"
  | "other";

export type TicketPriority = "low" | "normal" | "high" | "urgent";

export type SupportTicket = {
  id: string;
  ticketNo: string;
  /** Auth uid of the person who filed it. */
  userId: string;
  userName: string;
  userRole: string;
  userCourse?: string | null;
  userYearLevel?: string | null;
  userStudentId?: string | null;
  category: TicketCategory;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignedTo?: string | null;
  assignedToName?: string | null;
  createdAt?: any;
  updatedAt?: any;
  lastMessageAt?: any;
  lastMessagePreview?: string | null;
  /** A staff reply is waiting to be read. Cleared when the student opens it. */
  unreadForUser?: boolean;
  /** The student has written since staff last looked. */
  unreadForStaff?: boolean;
  appVersion?: string | null;
  platform?: string | null;
  /** Screenshot attached to the original report. */
  imageUrl?: string | null;
  /** Set when the ticket was raised from a question BEA could not answer. */
  sourceQuestion?: string | null;
  /**
   * "signin-help" for a request sent from the Sign-in Help screen by someone
   * who couldn't sign in. It has no account behind it (userId is empty), so
   * it is answered by email or phone, never in the app.
   */
  source?: string | null;
  /** The email or phone number a sign-in request asked to be reached on. */
  contact?: string | null;
  /** Whether a sign-in request's ID matches a real account, and whose. */
  accountFound?: boolean | null;
  accountName?: string | null;
  accountRole?: string | null;
};

export type TicketMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorRole: string;
  /** Drives which side of the thread the bubble sits on. */
  fromStaff: boolean;
  body: string;
  createdAt?: any;
  /** Screenshot attached to this reply. */
  imageUrl?: string | null;
  /** Local-only: set while an optimistic message is still in flight. */
  pending?: boolean;
  /**
   * Local-only: the write was never confirmed by the server.
   *
   * Firestore runs with persistentLocalCache, so addDoc() resolves as soon as
   * the write reaches the local cache — a later rejection by the security
   * rules never rejects that promise. Without this flag a refused message sits
   * on "Sending…" forever and the sender is told nothing.
   */
  failed?: boolean;
};

export const TICKET_CATEGORIES: {
  value: TicketCategory;
  label: string;
  hint: string;
  icon: string;
}[] = [
  {
    value: "account",
    label: "Account & sign-in",
    hint: "Password, email, or getting into your account",
    icon: "key-outline",
  },
  {
    value: "records",
    label: "Student records",
    hint: "Wrong year level, program, name, or student ID",
    icon: "school-outline",
  },
  {
    value: "content",
    label: "Posts & moderation",
    hint: "A post was held or removed, or something needs review",
    icon: "document-text-outline",
  },
  {
    value: "technical",
    label: "Something is broken",
    hint: "The app crashed, an upload failed, a screen won't load",
    icon: "bug-outline",
  },
  {
    value: "other",
    label: "Something else",
    hint: "Anything that doesn't fit the list above",
    icon: "help-circle-outline",
  },
];

export const TICKET_STATUS_META: Record<
  TicketStatus,
  { label: string; color: string; bg: string; icon: string }
> = {
  open: { label: "Open", color: "#b26a10", bg: "#fdf1e2", icon: "ellipse-outline" },
  in_progress: { label: "In progress", color: "#1d4ed8", bg: "#e8eefc", icon: "time-outline" },
  resolved: { label: "Resolved", color: "#1f6b50", bg: "#e9f5ef", icon: "checkmark-circle-outline" },
  closed: { label: "Closed", color: "#6d4a41", bg: "#f3e7e1", icon: "lock-closed-outline" },
};

export const TICKET_PRIORITY_META: Record<
  TicketPriority,
  { label: string; color: string; bg: string }
> = {
  low: { label: "Low", color: "#6d4a41", bg: "#f3e7e1" },
  normal: { label: "Normal", color: "#8a5a10", bg: "#fdf1e2" },
  high: { label: "High", color: "#b45309", bg: "#fdecc8" },
  urgent: { label: "Urgent", color: "#a8201a", bg: "#fdecea" },
};

export const getCategoryLabel = (value?: string): string =>
  TICKET_CATEGORIES.find((item) => item.value === value)?.label || "Something else";

/** Statuses a student's ticket is still "live" in — used for the Settings badge. */
export const OPEN_TICKET_STATUSES: TicketStatus[] = ["open", "in_progress"];

const TICKET_COUNTER_PATH = ["counters", "supportTickets"] as const;

/**
 * Next human-readable ticket number, e.g. "SR-00125".
 *
 * "SR" for Support Request, matching the words the interface already uses —
 * "My requests", "Report a problem", "Support requests". A student reading
 * their number out to an administrator should not have to decode an
 * abbreviation that appears nowhere else in the app.
 *
 * A running counter rather than a random id because students quote these to
 * staff out loud and in person. The transaction is safe under contention, and
 * ticket creation is rare enough that contention is not a real concern.
 *
 * Falls back to a date-based number if the counter cannot be read or written,
 * so a rules problem can never block somebody from asking for help.
 */
async function nextTicketNumber(): Promise<string> {
  const counterRef = doc(db, TICKET_COUNTER_PATH[0], TICKET_COUNTER_PATH[1]);

  try {
    const value = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(counterRef);
      const current = snapshot.exists() ? Number(snapshot.data()?.value || 0) : 0;
      const next = current + 1;
      transaction.set(counterRef, { value: next }, { merge: true });
      return next;
    });
    return `SR-${String(value).padStart(5, "0")}`;
  } catch (error) {
    console.warn("Ticket counter unavailable, using a dated number:", error);
    const now = new Date();
    const stamp =
      `${String(now.getFullYear()).slice(2)}` +
      `${String(now.getMonth() + 1).padStart(2, "0")}` +
      `${String(now.getDate()).padStart(2, "0")}`;
    return `SR-${stamp}-${String(now.getTime() % 10000).padStart(4, "0")}`;
  }
}

export type CreateTicketInput = {
  category: TicketCategory;
  subject: string;
  description: string;
  /** Cloudinary URL of a screenshot. The single most useful thing on a bug
   *  report, and the thing a student is least likely to be asked for. */
  imageUrl?: string | null;
  /** The BEA question this was escalated from, when there is one. */
  sourceQuestion?: string | null;
};

/**
 * Files a ticket.
 *
 * Identity is read from the signed-in user's profile, never typed. Asking a
 * student to retype their name, course and year level is how tickets arrive
 * unusable — and the answers are already in Firestore.
 *
 * Priority is fixed at "normal" here and is not accepted from the caller.
 * When students can set it, everything is urgent; staff triage instead, the
 * same way the moderation queue decides its own critical lane.
 */
export async function createSupportTicket(
  input: CreateTicketInput,
): Promise<{ id: string; ticketNo: string }> {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be signed in to send a support request.");

  const subject = input.subject.trim();
  const description = input.description.trim();
  if (!subject) throw new Error("Please add a short subject.");
  if (!description) throw new Error("Please describe what happened.");

  const profile = await getUserData(user.uid).catch(() => null);
  const ticketNo = await nextTicketNumber();

  const payload = {
    ticketNo,
    userId: user.uid,
    userName:
      `${profile?.firstname || ""} ${profile?.lastname || ""}`.trim() ||
      user.displayName ||
      "Unknown user",
    userRole: String(profile?.role || "student"),
    userCourse: profile?.course || null,
    userYearLevel: (profile as any)?.yearlvl || null,
    userStudentId: profile?.studentID || getStudentDocIdFromAuthUser(user) || null,

    category: input.category,
    subject,
    description,
    sourceQuestion: input.sourceQuestion?.trim() || null,

    status: "open" as TicketStatus,
    priority: "normal" as TicketPriority,
    assignedTo: null,
    assignedToName: null,

    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastMessageAt: serverTimestamp(),
    lastMessagePreview: description.slice(0, 120),

    unreadForUser: false,
    unreadForStaff: true,

    // Captured rather than asked for — it is the first thing anyone needs for
    // a bug report and the last thing a student thinks to include.
    appVersion: Constants.expoConfig?.version || null,
    platform: Platform.OS,
    imageUrl: input.imageUrl || null,
  };

  const ref = await addDoc(collection(db, "supportTickets"), payload);
  return { id: ref.id, ticketNo };
}

const toTicket = (id: string, data: any): SupportTicket => ({
  id,
  ticketNo: String(data?.ticketNo || ""),
  userId: String(data?.userId || ""),
  userName: String(data?.userName || "Unknown user"),
  userRole: String(data?.userRole || "student"),
  userCourse: data?.userCourse ?? null,
  userYearLevel: data?.userYearLevel ?? null,
  userStudentId: data?.userStudentId ?? null,
  category: (data?.category || "other") as TicketCategory,
  subject: String(data?.subject || ""),
  description: String(data?.description || ""),
  status: (data?.status || "open") as TicketStatus,
  priority: (data?.priority || "normal") as TicketPriority,
  assignedTo: data?.assignedTo ?? null,
  assignedToName: data?.assignedToName ?? null,
  createdAt: data?.createdAt,
  updatedAt: data?.updatedAt,
  lastMessageAt: data?.lastMessageAt,
  lastMessagePreview: data?.lastMessagePreview ?? null,
  unreadForUser: data?.unreadForUser === true,
  unreadForStaff: data?.unreadForStaff === true,
  appVersion: data?.appVersion ?? null,
  platform: data?.platform ?? null,
  imageUrl: data?.imageUrl ?? null,
  sourceQuestion: data?.sourceQuestion ?? null,
  source: data?.source ?? null,
  contact: data?.contact ?? null,
  accountFound: typeof data?.accountFound === "boolean" ? data.accountFound : null,
  accountName: data?.accountName ?? null,
  accountRole: data?.accountRole ?? null,
});

/** The signed-in student's own tickets, newest activity first. */
export function subscribeToMyTickets(
  userId: string,
  onTickets: (tickets: SupportTicket[]) => void,
): () => void {
  // Ordering happens in memory: a where + orderBy on different fields would
  // need a deployed composite index, and one person's ticket list is small.
  return onSnapshot(
    query(collection(db, "supportTickets"), where("userId", "==", userId)),
    (snapshot) => {
      const rows = snapshot.docs.map((item) => toTicket(item.id, item.data()));
      rows.sort(
        (a, b) => timestampMs(b.lastMessageAt) - timestampMs(a.lastMessageAt),
      );
      onTickets(rows);
    },
    (error) => console.error("My tickets listener failed:", error),
  );
}

/** Every ticket, for the staff queue. */
export function subscribeToAllTickets(
  onTickets: (tickets: SupportTicket[]) => void,
  max = 200,
): () => void {
  return onSnapshot(
    query(
      collection(db, "supportTickets"),
      orderBy("lastMessageAt", "desc"),
      fsLimit(max),
    ),
    (snapshot) => {
      onTickets(snapshot.docs.map((item) => toTicket(item.id, item.data())));
    },
    (error) => console.error("Support queue listener failed:", error),
  );
}

export function subscribeToTicket(
  ticketId: string,
  onTicket: (ticket: SupportTicket | null) => void,
): () => void {
  return onSnapshot(
    doc(db, "supportTickets", ticketId),
    (snapshot) => {
      onTicket(snapshot.exists() ? toTicket(snapshot.id, snapshot.data()) : null);
    },
    (error) => console.error("Ticket listener failed:", error),
  );
}

export function subscribeToTicketMessages(
  ticketId: string,
  onMessages: (messages: TicketMessage[]) => void,
): () => void {
  return onSnapshot(
    query(
      collection(db, "supportTickets", ticketId, "messages"),
      orderBy("createdAt", "asc"),
    ),
    (snapshot) => {
      onMessages(
        snapshot.docs.map((item) => {
          const data = item.data() || {};
          return {
            id: item.id,
            authorId: String(data.authorId || ""),
            authorName: String(data.authorName || "Unknown"),
            authorRole: String(data.authorRole || "student"),
            fromStaff: data.fromStaff === true,
            body: String(data.body || ""),
            createdAt: data.createdAt,
            imageUrl: data.imageUrl ?? null,
          };
        }),
      );
    },
    (error) => console.error("Ticket messages listener failed:", error),
  );
}

/**
 * Adds a reply and moves the unread flag to the other side.
 *
 * A staff reply also nudges an "open" ticket to "in_progress": answering is
 * what picking it up means, and asking staff to set that by hand is a step
 * everyone forgets.
 */
export async function postTicketMessage(input: {
  ticketId: string;
  body: string;
  fromStaff: boolean;
  authorRole: string;
  imageUrl?: string | null;
  /** The student whose ticket this is, so a staff reply can notify them. */
  ticketOwnerId?: string | null;
  ticketNo?: string | null;
}): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be signed in to reply.");

  const body = input.body.trim();
  // A screenshot with no caption is a real message. This guard predates
  // attachments and used to drop image-only replies on the floor — no write,
  // no error, nothing for the caller to catch, so the bubble sat on
  // "Sending…" forever and retrying did exactly the same nothing.
  if (!body && !input.imageUrl) return;

  const profile = await getUserData(user.uid).catch(() => null);
  const authorName =
    `${profile?.firstname || ""} ${profile?.lastname || ""}`.trim() ||
    user.displayName ||
    "Unknown user";

  await addDoc(collection(db, "supportTickets", input.ticketId, "messages"), {
    authorId: user.uid,
    authorName,
    authorRole: input.authorRole,
    fromStaff: input.fromStaff,
    body,
    imageUrl: input.imageUrl || null,
    createdAt: serverTimestamp(),
  });

  const ticketUpdate: Record<string, any> = {
    updatedAt: serverTimestamp(),
    lastMessageAt: serverTimestamp(),
    lastMessagePreview: body
      ? body.slice(0, 120)
      : input.imageUrl
        ? "Sent a screenshot"
        : "",
    unreadForUser: input.fromStaff,
    unreadForStaff: !input.fromStaff,
  };

  if (input.fromStaff) {
    const current = await getDoc(doc(db, "supportTickets", input.ticketId));
    if (current.exists() && current.data()?.status === "open") {
      ticketUpdate.status = "in_progress";
    }
  }

  await updateDoc(doc(db, "supportTickets", input.ticketId), ticketUpdate);

  // A badge inside Settings only helps somebody who thinks to look. A reply
  // is the one thing in this feature the student is actually waiting for, so
  // it goes through the same notification pipeline as everything else.
  if (input.fromStaff && input.ticketOwnerId) {
    await createNotification({
      recipientId: input.ticketOwnerId,
      actor: { id: user.uid, name: authorName },
      type: "support",
      entityType: "support_ticket",
      entityId: input.ticketId,
      message: `replied to your request ${input.ticketNo || ""}`.trim(),
      preview: body,
    }).catch((error) =>
      console.warn("Support reply notification failed:", error),
    );
  }
}

/** Clears the unread marker for whichever side just opened the ticket. */
export async function markTicketRead(
  ticketId: string,
  side: "user" | "staff",
): Promise<void> {
  await updateDoc(doc(db, "supportTickets", ticketId), {
    [side === "user" ? "unreadForUser" : "unreadForStaff"]: false,
  }).catch(() => undefined);
}

export async function updateTicketStatus(
  ticketId: string,
  status: TicketStatus,
): Promise<void> {
  await updateDoc(doc(db, "supportTickets", ticketId), {
    status,
    updatedAt: serverTimestamp(),
  });
}

export async function updateTicketPriority(
  ticketId: string,
  priority: TicketPriority,
): Promise<void> {
  await updateDoc(doc(db, "supportTickets", ticketId), {
    priority,
    updatedAt: serverTimestamp(),
  });
}

export async function assignTicket(
  ticketId: string,
  assignedTo: string | null,
  assignedToName: string | null,
): Promise<void> {
  await updateDoc(doc(db, "supportTickets", ticketId), {
    assignedTo,
    assignedToName,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Live count of the signed-in student's unread staff replies.
 *
 * Filters on userId only and counts in memory. Adding `unreadForUser == true`
 * would make it two equality filters on different fields, which Firestore
 * needs a deployed composite index for — and one person's ticket list is
 * small enough that the index would buy nothing.
 */
export function subscribeToMyTicketBadge(
  userId: string,
  onCount: (count: number) => void,
): () => void {
  return onSnapshot(
    query(collection(db, "supportTickets"), where("userId", "==", userId)),
    (snapshot) => {
      onCount(
        snapshot.docs.filter((item) => item.data()?.unreadForUser === true).length,
      );
    },
    () => onCount(0),
  );
}

/** Live count of tickets waiting on staff, for the Dashboard card. */
export function subscribeToStaffTicketBadge(
  onCount: (count: number) => void,
): () => void {
  return onSnapshot(
    query(
      collection(db, "supportTickets"),
      where("unreadForStaff", "==", true),
    ),
    (snapshot) => onCount(snapshot.size),
    () => onCount(0),
  );
}

/** Shared by the list sorts above and by callers rendering relative times. */
export function timestampMs(value: any): number {
  if (!value) return 0;
  try {
    const date = value?.toDate ? value.toDate() : new Date(value);
    const ms = date.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  } catch {
    return 0;
  }
}

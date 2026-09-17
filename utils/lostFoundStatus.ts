// utils/lostFoundStatus.ts
//
// Where a Lost & Found post stands.
//
// Two of the four statuses describe what kind of post it is — somebody lost a
// thing, or somebody found one — and are chosen when the post is written. The
// other two describe how far along it is. Both kinds travel the same road:
//
//     lost  ─┐
//            ├─→ claim_pending ─→ returned ─→ (archived)
//     found ─┘
//
// "Archived" is deliberately not stored. A returned post counts as archived
// once it has been returned for LOST_FOUND_ARCHIVE_AFTER_DAYS, which means no
// scheduled job, no extra writes, and nothing that can be left half-done. The
// feed hides archived posts except when somebody filters for Returned, which
// is how resolved items stay findable without cluttering the active list.
//
// `resolvedAt` predates this file and is kept in step with "returned": the
// chatbot and the resolution detector both read it. Posts written before
// statuses existed have no `lostFoundStatus`, so theirs is derived from it.
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";

import { db } from "../Firebase_configure";
import { isStaff, type UserRole } from "./rbac";
import { timestampMs } from "./supportTickets";
import type { ThemeTokens } from "./theme";

export type LostFoundStatus = "lost" | "found" | "claim_pending" | "returned";

/** How long a returned item stays in the active list before it is archived. */
export const LOST_FOUND_ARCHIVE_AFTER_DAYS = 7;
const ARCHIVE_AFTER_MS = LOST_FOUND_ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;

type StatusInfo = {
  id: LostFoundStatus;
  label: string;
  emoji: string;
  /** What the status means, for the menu that changes it. */
  hint: string;
};

/** In the order the filter chips and the status menu show them. */
export const LOST_FOUND_STATUSES: readonly StatusInfo[] = [
  { id: "lost", label: "Lost", emoji: "🔴", hint: "Someone is looking for this item" },
  { id: "found", label: "Found", emoji: "🟢", hint: "This item was found and is waiting for its owner" },
  { id: "claim_pending", label: "Claim Pending", emoji: "🟡", hint: "Someone has come forward to claim it" },
  { id: "returned", label: "Returned", emoji: "🔵", hint: "The item is back with its owner" },
] as const;

export const getLostFoundStatusInfo = (status: LostFoundStatus): StatusInfo =>
  LOST_FOUND_STATUSES.find((item) => item.id === status) ?? LOST_FOUND_STATUSES[0];

const isStatus = (value: unknown): value is LostFoundStatus =>
  value === "lost" || value === "found" || value === "claim_pending" || value === "returned";

export type LostFoundFields = {
  flair?: string | null;
  lostFoundStatus?: unknown;
  returnedAt?: unknown;
  resolvedAt?: unknown;
};

/**
 * The status to show. A post from before statuses existed reads as returned
 * if it was resolved and as lost otherwise, which is what those posts were.
 */
export function getLostFoundStatus(post: LostFoundFields): LostFoundStatus {
  if (isStatus(post.lostFoundStatus)) return post.lostFoundStatus;
  return post.resolvedAt != null ? "returned" : "lost";
}

export const isLostFoundPost = (post: LostFoundFields) => post.flair === "lost_found";

/**
 * Returned long enough ago to leave the active list.
 *
 * `nowMs` is passed in rather than read here so a list can be filtered against
 * one moment, and so rendering stays free of clock reads.
 */
export function isLostFoundArchived(post: LostFoundFields, nowMs: number): boolean {
  if (!isLostFoundPost(post) || getLostFoundStatus(post) !== "returned") return false;
  // Older returned posts only ever had resolvedAt.
  const returnedMs = timestampMs(post.returnedAt) || timestampMs(post.resolvedAt);
  // A return that is still settling on the server has no time yet — it is as
  // recent as a return can be, so it stays in the active list.
  if (!returnedMs) return false;
  return nowMs - returnedMs >= ARCHIVE_AFTER_MS;
}

/**
 * The post's own author, or anyone on staff. Staff may change any Lost & Found
 * post: settling a disputed claim is part of moderating it.
 */
export function canUpdateLostFoundStatus(input: {
  viewerRole?: UserRole;
  viewerUserId?: string | null;
  authorUserId?: string | null;
}): boolean {
  if (!input.viewerUserId) return false;
  if (isStaff(input.viewerRole)) return true;
  return !!input.authorUserId && input.authorUserId === input.viewerUserId;
}

/** Colours for a status, from the active theme. */
export function lostFoundStatusColors(status: LostFoundStatus, c: ThemeTokens) {
  switch (status) {
    case "lost":
      return { ink: c.danger, fill: c.dangerSoft, line: c.danger };
    case "found":
      return { ink: c.success, fill: c.successSoft, line: c.success };
    case "claim_pending":
      return { ink: c.warning, fill: c.accentSoft, line: c.warning };
    case "returned":
    default:
      // No "info" wash exists in the palette; a sunken fill keeps the blue ink
      // readable in every theme without inventing one for a single badge.
      return { ink: c.info, fill: c.surfaceSunken, line: c.info };
  }
}

/**
 * Moves a post to a new status.
 *
 * Returning writes `resolvedAt` too, and leaving "returned" clears it, so the
 * chatbot and the resolution detector — which only know `resolvedAt` — agree
 * with the badge. Any pending "is this resolved?" prompt is cleared on the
 * way, since the question has now been answered by a person.
 */
export async function updateLostFoundStatus(
  postId: string,
  status: LostFoundStatus,
  actorUserId: string,
): Promise<void> {
  const returned = status === "returned";
  await updateDoc(doc(db, "posts", postId), {
    lostFoundStatus: status,
    lostFoundUpdatedAt: serverTimestamp(),
    lostFoundUpdatedBy: actorUserId,
    returnedAt: returned ? serverTimestamp() : null,
    resolvedAt: returned ? serverTimestamp() : null,
    resolutionPrompt: null,
  });
}

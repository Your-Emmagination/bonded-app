// Client façade for the push-notification pipeline.
//
// Delivery is entirely server-side and free: the writers below create a
// `notifications/{id}` Firestore document, and the Cloudflare Worker
// (cloudflare/ai-worker/src/push.js) verifies the caller, applies the
// recipient's chosen sound (userNotificationSettings.soundId), and sends via
// the free Expo Push API (https://exp.host/--/api/v2/push/send). There is no
// paid server, credit card, or billing plan involved.
//
// This module is a thin front door — the actual notification writers live in
// utils/notifications.ts and are re-exported here so callers have one import.
import { auth } from "../Firebase_configure";
import { getAiWorkerUrl } from "../utils/aiConfig";

export type NotificationType =
  | "post_like"
  | "post_comment"
  | "comment_reply"
  | "mention_post"
  | "mention_comment"
  | "announcement";

export {
  createNotification,
  upsertLikeNotification,
  removeLikeNotification,
  createMentionNotifications,
  resolveMentionRecipientIds,
} from "../utils/notifications";

/**
 * Fan a staff announcement post out to every registered device.
 *
 * The client sends only `{ postId }` plus its Firebase ID token. The Worker
 * re-checks that the caller is staff and owns an announcement-flair post,
 * gathers every Expo push token itself, and batches to Expo in groups of 100
 * — so a client can't use this to push arbitrary content to arbitrary tokens.
 *
 * Fire-and-forget: never throws into the post-publish flow.
 */
export const notifyAnnouncement = async (postId: string): Promise<void> => {
  const workerUrl = getAiWorkerUrl();
  const user = auth.currentUser;
  if (!workerUrl || !user || !postId) return;

  try {
    const idToken = await user.getIdToken();
    await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ mode: "push-announcement", postId }),
    });
  } catch (error) {
    console.warn("[notifications] announcement broadcast failed:", error);
  }
};

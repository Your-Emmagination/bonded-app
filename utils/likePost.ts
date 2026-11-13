// utils/likePost.ts
//
// A like tap on a feed post, for screens that show single posts outside Home
// (the Pinned page, a post opened from a notification). Saves through
// savePostLike (utils/postLikes.ts) — the same save Home uses, which never
// drops a quick second tap — and keeps the like notification to the author
// in step, as Home does.
import type { User } from "firebase/auth";
import { removeLikeNotification, upsertLikeNotification } from "./notifications";
import { savePostLike } from "./postLikes";

type LikedPost = { id: string; realUserId?: string; userId?: string; content?: string };

/**
 * Saves `user`'s like (`liked` true) or unlike on `post`. `onFailed` gets the
 * like state that is still saved, so the screen can put its heart back.
 */
export function likePost(
  post: LikedPost,
  user: User,
  liked: boolean,
  onFailed?: (savedLiked: boolean) => void,
): void {
  const ownerId = post.realUserId || post.userId;
  void savePostLike({
    postId: post.id,
    uid: user.uid,
    liked,
    onChanged: (nowLiked) => {
      const sync = nowLiked
        ? upsertLikeNotification({
            recipientId: ownerId,
            actor: {
              id: user.uid,
              name: user.displayName || user.email?.split("@")[0] || "Someone",
              profileImage: null,
            },
            entityType: "post",
            entityId: post.id,
            preview: post.content,
          })
        : removeLikeNotification({ recipientId: ownerId, actorId: user.uid, entityType: "post", entityId: post.id });
      sync.catch((error) => console.error("[likePost] notification sync failed:", error));
    },
    onFailed: (savedLiked, error) => {
      console.error("[likePost] like failed:", error);
      onFailed?.(savedLiked);
    },
  });
}

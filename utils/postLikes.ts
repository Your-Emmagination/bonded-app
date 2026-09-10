import {
  arrayRemove,
  arrayUnion,
  doc,
  getDoc,
  increment,
  updateDoc,
} from "firebase/firestore";
import { db } from "../Firebase_configure";

type LikeablePost = { likedBy?: string[]; likeCount?: number };

/**
 * The post with the viewer's like set to `liked` and likeCount kept in step.
 * Screens use it to show a like before Firestore confirms it.
 */
export const withViewerLike = <T extends LikeablePost>(
  post: T,
  uid: string,
  liked: boolean,
): T => {
  const likedBy = post.likedBy ?? [];
  if (likedBy.includes(uid) === liked) return post;
  return {
    ...post,
    likedBy: liked ? [...likedBy, uid] : likedBy.filter((id) => id !== uid),
    likeCount: Math.max(0, (post.likeCount ?? 0) + (liked ? 1 : -1)),
  };
};

// Per post: the like state the reader tapped last, and which posts have a save
// running. Module-level so a post liked from two screens still saves once.
const wantedLikes = new Map<string, boolean>();
const savingLikes = new Set<string>();

/** The like state the reader last tapped while a save for the post is running. */
export const getPendingPostLike = (postId: string) => wantedLikes.get(postId);

type SavePostLikeOptions = {
  postId: string;
  uid: string;
  liked: boolean;
  // Called after Firestore actually changed (for the like notification).
  onChanged?: (liked: boolean) => void;
  // Called when saving fails, with the like state that is still saved.
  onFailed?: (savedLiked: boolean, error: unknown) => void;
};

/**
 * Saves the reader's latest like tap. Taps are never dropped: a call made
 * while a save for the same post is running only records the new choice, and
 * the running save keeps going until Firestore matches the last tap.
 *
 * Only this viewer's id is added or removed, so likes other people added in
 * the meantime are never overwritten.
 */
export const savePostLike = async ({
  postId,
  uid,
  liked,
  onChanged,
  onFailed,
}: SavePostLikeOptions) => {
  wantedLikes.set(postId, liked);
  if (savingLikes.has(postId)) return;
  savingLikes.add(postId);

  const postRef = doc(db, "posts", postId);
  // What the heart showed before the first tap; restored if nothing saves.
  let savedLiked = !liked;

  try {
    while (wantedLikes.get(postId) !== savedLiked) {
      const want = wantedLikes.get(postId) === true;
      try {
        await updateDoc(postRef, {
          likedBy: want ? arrayUnion(uid) : arrayRemove(uid),
          likeCount: increment(want ? 1 : -1),
        });
        onChanged?.(want);
      } catch (error) {
        // The rules reject a like the post already has (or an unlike it
        // doesn't), which is what an out-of-date heart sends. If Firestore
        // already matches, there is nothing left to save.
        const snapshot = await getDoc(postRef);
        const likedBy: string[] = snapshot.data()?.likedBy ?? [];
        if (likedBy.includes(uid) !== want) throw error;
      }
      savedLiked = want;
    }
  } catch (error) {
    onFailed?.(savedLiked, error);
  } finally {
    savingLikes.delete(postId);
    wantedLikes.delete(postId);
  }
};

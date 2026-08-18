// app/(main)/BookmarksScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  doc,
  documentId,
  increment,
  onSnapshot,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import CommentModal from "./components/CommentModal";
import ImageZoomViewer from "./components/ImageZoomViewer";
import PostCard from "./components/PostCard";
import {
  removeLikeNotification,
  upsertLikeNotification,
} from "@/utils/notifications";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import { getStudentDocIdFromAuthUser, resolveUserRoleForAuthUser, UserRole } from "@/utils/rbac";
import { useRelativeTimeNow } from "@/utils/relativeTime";

const BOOKMARKS_RETURN_ROUTE = "/(main)/BookmarksScreen";
const CHUNK_SIZE = 10; // Firestore "in" query limit

type TaggedUser = { id: string; name: string; studentID: string };
type FileAttachment = { url: string; mimeType: string; name?: string };

type Post = {
  id: string;
  content?: string;
  imageUrl?: string;
  files?: FileAttachment[];
  link?: { url: string; title: string };
  username?: string;
  authorName?: string;
  userId?: string;
  realUserId?: string;
  isAnonymous?: boolean;
  taggedUsers?: TaggedUser[];
  createdAt?: any;
  likeCount?: number;
  commentCount?: number;
  likedBy?: string[];
  bookmarkedBy?: string[];
  role?: string;
  aiReply?: {
    text?: string;
    model?: string | null;
    generatedAtMs?: number;
    status?: string | null;
  };
  pinnedAt?: any;
  moderationStatus?: string;
};

const getTimestampValue = (timestamp: any): number => {
  if (!timestamp) return 0;
  if (typeof timestamp.toMillis === "function") return timestamp.toMillis();
  if (typeof timestamp.toDate === "function") return timestamp.toDate().getTime();
  return 0;
};

const chunkArray = <T,>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

export default function BookmarksScreen() {
  const router = useRouter();
  const relativeTimeNow = useRelativeTimeNow();

  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [currentUserRole, setCurrentUserRole] = useState<UserRole | undefined>();
  const [bookmarkedPostIds, setBookmarkedPostIds] = useState<string[]>([]);
  const [postsById, setPostsById] = useState<Record<string, Post>>({});
  const [loading, setLoading] = useState(true);

  const [commentModalPostId, setCommentModalPostId] = useState<string | null>(null);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [currentImages, setCurrentImages] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [currentImageViewerPostId, setCurrentImageViewerPostId] = useState<string | null>(null);

  const chunkListenersRef = useRef<(() => void)[]>([]);
  // Same in-flight guard as HomeScreen's handleLike — prevents a fast
  // double-tap from firing two like toggles for the same post.
  const likeInFlightRef = useRef<Set<string>>(new Set());

  // ─── Auth + role ──────────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (nextUser) {
        const role = await resolveUserRoleForAuthUser(nextUser);
        setCurrentUserRole(role as UserRole);
      } else {
        setCurrentUserRole(undefined);
      }
    });
    return unsubscribe;
  }, []);

  // ─── Live list of bookmarked post ids (from the user's own student doc) ─
  // This app has no separate "users" collection — profile docs (and now
  // bookmarks) live at students/{studentId}, keyed by uid or email prefix.
  useEffect(() => {
    if (!user) {
      setBookmarkedPostIds([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const studentDocId = getStudentDocIdFromAuthUser(user) || user.uid;
    const studentRef = doc(db, "students", studentDocId);
    const unsubscribe = onSnapshot(
      studentRef,
      (snapshot) => {
        const ids = (snapshot.data()?.bookmarkedPostIds as string[] | undefined) ?? [];
        setBookmarkedPostIds(ids);
      },
      (error) => {
        console.error("Error loading bookmarked post ids:", error);
        setLoading(false);
      },
    );
    return unsubscribe;
  }, [user]);

  // ─── Live post data for the bookmarked ids, fetched in chunks of 10 ───
  useEffect(() => {
    chunkListenersRef.current.forEach((unsubscribe) => unsubscribe());
    chunkListenersRef.current = [];

    if (bookmarkedPostIds.length === 0) {
      setPostsById({});
      setLoading(false);
      return;
    }

    const chunks = chunkArray(bookmarkedPostIds, CHUNK_SIZE);

    chunks.forEach((chunk) => {
      const q = query(collection(db, "posts"), where(documentId(), "in", chunk));
      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          setPostsById((prev) => {
            const next = { ...prev };
            // Drop ids in this chunk that no longer exist (post deleted).
            chunk.forEach((id) => {
              if (!snapshot.docs.some((docSnap) => docSnap.id === id)) {
                delete next[id];
              }
            });
            snapshot.docs.forEach((docSnap) => {
              next[docSnap.id] = { id: docSnap.id, ...docSnap.data() } as Post;
            });
            return next;
          });
          setLoading(false);
        },
        (error) => {
          console.error("Error loading bookmarked posts:", error);
          setLoading(false);
        },
      );
      chunkListenersRef.current.push(unsubscribe);
    });

    return () => {
      chunkListenersRef.current.forEach((unsubscribe) => unsubscribe());
      chunkListenersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chunk membership only needs to change when the id *set* changes
  }, [bookmarkedPostIds.join(",")]);

  const savedPosts = useMemo(() => {
    return bookmarkedPostIds
      .map((id) => postsById[id])
      .filter((post): post is Post => {
        if (!post) return false;
        // Same rule Home uses: hide pending/rejected content from normal
        // browsing surfaces. Legacy posts without moderationStatus count
        // as approved.
        const status = String(post.moderationStatus ?? "approved").toLowerCase();
        return status === "approved";
      })
      .sort((a, b) => getTimestampValue(b.createdAt) - getTimestampValue(a.createdAt));
  }, [bookmarkedPostIds, postsById]);

  // ─── Like ───────────────────────────────────────────────────────────
  const handleLike = useCallback(
    async (postId: string, currentLikedBy: string[] = []) => {
      if (!user) return;
      if (likeInFlightRef.current.has(postId)) return;
      likeInFlightRef.current.add(postId);

      const post = postsById[postId];
      const hasLiked = currentLikedBy.includes(user.uid);
      const postRef = doc(db, "posts", postId);
      const postOwnerId = post?.realUserId || post?.userId;
      const actorName = user.displayName || user.email?.split("@")[0] || "Someone";

      try {
        await updateDoc(postRef, {
          likedBy: hasLiked
            ? currentLikedBy.filter((id) => id !== user.uid)
            : [...currentLikedBy, user.uid],
          likeCount: increment(hasLiked ? -1 : 1),
        });

        if (hasLiked) {
          await removeLikeNotification({
            recipientId: postOwnerId,
            actorId: user.uid,
            entityType: "post",
            entityId: postId,
          });
        } else {
          await upsertLikeNotification({
            recipientId: postOwnerId,
            actor: { id: user.uid, name: actorName, profileImage: null },
            entityType: "post",
            entityId: postId,
            preview: post?.content,
          });
        }
      } catch (error) {
        console.error("Error liking bookmarked post:", error);
      } finally {
        likeInFlightRef.current.delete(postId);
      }
    },
    [postsById, user],
  );

  // ─── Image viewer ───────────────────────────────────────────────────
  const openImageViewer = useCallback((images: string[], startIndex: number, postId?: string) => {
    setCurrentImages(images);
    setCurrentImageIndex(startIndex);
    setCurrentImageViewerPostId(postId ?? null);
    setImageViewerVisible(true);
  }, []);

  const currentImageViewerPost = currentImageViewerPostId
    ? postsById[currentImageViewerPostId]
    : undefined;

  const handleImageViewerLike = useCallback(() => {
    if (!currentImageViewerPost) return;
    handleLike(currentImageViewerPost.id, currentImageViewerPost.likedBy || []);
  }, [currentImageViewerPost, handleLike]);

  const handleImageViewerComment = useCallback(() => {
    if (!currentImageViewerPost) return;
    setImageViewerVisible(false);
    setCommentModalPostId(currentImageViewerPost.id);
  }, [currentImageViewerPost]);

  // ─── File press (mirrors HomeScreen's handleFilePress) ────────────────
  const handleFilePress = useCallback(
    (url: string, mimeType: string) => {
      if (mimeType.startsWith("image/")) {
        openImageViewer([url], 0);
        return;
      }
      let fileUrl = url;
      if (mimeType.includes("pdf") && url.includes("cloudinary.com")) {
        fileUrl = url.replace("/upload/", "/upload/fl_attachment/");
      }
      Linking.canOpenURL(fileUrl)
        .then((supported) => {
          if (supported) Linking.openURL(fileUrl);
        })
        .catch((err) => console.error("Error opening URL:", err));
    },
    [openImageViewer],
  );

  // ─── Profile / tag navigation ───────────────────────────────────────
  const handleProfileClick = useCallback(
    (targetId?: string) => {
      if (targetId === "self") {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo: BOOKMARKS_RETURN_ROUTE },
        });
      } else if (targetId) {
        router.push(
          targetId.startsWith("/UserProfileScreen?")
            ? `${targetId}${targetId.includes("?") ? "&" : "?"}returnTo=${encodeURIComponent(BOOKMARKS_RETURN_ROUTE)}`
            : (buildUserProfileHref({ userId: targetId, returnTo: BOOKMARKS_RETURN_ROUTE }) as any),
        );
      }
    },
    [router],
  );

  const handleTagClick = useCallback(
    (taggedUserId: string) => {
      if (taggedUserId === user?.uid) {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo: BOOKMARKS_RETURN_ROUTE },
        });
      } else {
        router.push(
          buildUserProfileHref({ userId: taggedUserId, returnTo: BOOKMARKS_RETURN_ROUTE }) as any,
        );
      }
    },
    [router, user?.uid],
  );

  const getTimeAgo = useCallback(
    (timestamp: any) => {
      if (!timestamp || !timestamp.toDate) return "";
      const now = new Date(relativeTimeNow);
      const postDate = timestamp.toDate();
      const diffMs = now.getTime() - postDate.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHour = Math.floor(diffMin / 60);
      const diffDay = Math.floor(diffHour / 24);
      const diffWeek = Math.floor(diffDay / 7);

      if (diffSec < 60) return "Just now";
      if (diffMin < 60) return `${diffMin}m ago`;
      if (diffHour < 24) return `${diffHour}h ago`;
      if (diffDay < 7) return `${diffDay}d ago`;
      if (diffWeek < 4) return `${diffWeek}w ago`;

      return postDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: postDate.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
      });
    },
    [relativeTimeNow],
  );

  const renderItem = useCallback(
    ({ item }: { item: Post }) => {
      const isLiked = item.likedBy?.includes(user?.uid || "") || false;
      return (
        <PostCard
          post={item}
          isLiked={isLiked}
          currentUserRole={currentUserRole}
          currentUserId={user?.uid}
          onLike={handleLike}
          onProfileClick={handleProfileClick}
          onTagClick={handleTagClick}
          onImagePress={openImageViewer}
          onFilePress={handleFilePress}
          getTimeAgo={getTimeAgo}
          onCommentPress={(postId) => setCommentModalPostId(postId)}
        />
      );
    },
    [
      currentUserRole,
      getTimeAgo,
      handleFilePress,
      handleLike,
      handleProfileClick,
      handleTagClick,
      openImageViewer,
      user?.uid,
    ],
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          activeOpacity={0.75}
        >
          <Ionicons name="chevron-back" size={24} color="#4f1c17" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Saved Posts</Text>
        <View style={styles.backButton} />
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color="#a61f1f" />
        </View>
      ) : savedPosts.length === 0 ? (
        <View style={styles.centerState}>
          <Ionicons name="bookmark-outline" size={40} color="#c9a89c" />
          <Text style={styles.emptyTitle}>No saved posts yet</Text>
          <Text style={styles.emptySubtitle}>
            Tap the bookmark icon on a post to save it here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={savedPosts}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
        />
      )}

      {commentModalPostId && user?.uid && (
        <CommentModal
          visible={true}
          onClose={() => setCommentModalPostId(null)}
          postId={commentModalPostId}
          currentUserId={user.uid}
          currentUserRole={currentUserRole}
        />
      )}

      <ImageZoomViewer
        images={currentImages}
        startIndex={currentImageIndex}
        visible={imageViewerVisible}
        onClose={() => setImageViewerVisible(false)}
        showActions={!!currentImageViewerPost}
        likesCount={currentImageViewerPost?.likeCount ?? 0}
        commentsCount={currentImageViewerPost?.commentCount ?? 0}
        isLiked={currentImageViewerPost?.likedBy?.includes(user?.uid || "") || false}
        onLike={handleImageViewerLike}
        onComment={handleImageViewerComment}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f6f1ed" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#ead8cf",
    backgroundColor: "#fffaf7",
  },
  backButton: { width: 36, height: 36, justifyContent: "center", alignItems: "center" },
  headerTitle: { color: "#4f1c17", fontSize: 17, fontWeight: "700" },
  listContent: { paddingBottom: 24 },
  centerState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: { color: "#4f1c17", fontSize: 16, fontWeight: "700", marginTop: 4 },
  emptySubtitle: { color: "#8f6a60", fontSize: 13.5, textAlign: "center", lineHeight: 19 },
});
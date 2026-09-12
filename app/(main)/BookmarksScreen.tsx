// app/(main)/BookmarksScreen.tsx
import { useNetworkStatus } from "@/utils/networkUtils";
import {
    removeLikeNotification,
    upsertLikeNotification,
} from "@/utils/notifications";
import {
    getCachedBookmarks,
    saveCachedBookmarks,
} from "@/utils/offlineStorage";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import { getStudentDocIdFromAuthUser, resolveUserRoleForAuthUser, UserRole } from "@/utils/rbac";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged, User } from "firebase/auth";
import {
    doc,
    increment,
    onSnapshot,
    updateDoc,
} from "firebase/firestore";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    FlatList,
    Linking,
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import CommentModal from "./components/CommentModal";
import ImageZoomViewer from "./components/ImageZoomViewer";
import PostCard from "./components/PostCard";
import { FeedSkeleton } from "./components/Skeleton";

const BOOKMARKS_RETURN_ROUTE = "/(main)/BookmarksScreen";

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

type PostTypeFilter = "all" | "photo" | "file" | "link" | "text";
type SortMode = "newest" | "oldest" | "recentlySaved";
type DateRangeFilter = "all" | "today" | "week" | "month";

const POST_TYPE_OPTIONS: { value: PostTypeFilter; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: "all", label: "All", icon: "apps-outline" },
  { value: "photo", label: "Photos", icon: "image-outline" },
  { value: "file", label: "Files", icon: "document-attach-outline" },
  { value: "link", label: "Links", icon: "link-outline" },
  { value: "text", label: "Text only", icon: "text-outline" },
];

const SORT_OPTIONS: { value: SortMode; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: "recentlySaved", label: "Recently saved", icon: "bookmark-outline" },
  { value: "newest", label: "Newest post first", icon: "arrow-down-outline" },
  { value: "oldest", label: "Oldest post first", icon: "arrow-up-outline" },
];

const DATE_RANGE_OPTIONS: { value: DateRangeFilter; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

const matchesPostType = (post: Post, filter: PostTypeFilter): boolean => {
  if (filter === "all") return true;
  const hasImageFile = !!post.files?.some((file) => file.mimeType?.startsWith("image/"));
  const hasNonImageFile = !!post.files?.some((file) => !file.mimeType?.startsWith("image/"));
  const isPhoto = !!post.imageUrl || hasImageFile;
  const isFile = hasNonImageFile;
  const isLink = !!post.link?.url;

  if (filter === "photo") return isPhoto;
  if (filter === "file") return isFile;
  if (filter === "link") return isLink;
  // "text": no attachments of any kind, just written content.
  return !isPhoto && !isFile && !isLink;
};

const matchesDateRange = (post: Post, range: DateRangeFilter): boolean => {
  if (range === "all") return true;
  const createdMs = getTimestampValue(post.createdAt);
  if (!createdMs) return false;
  const now = Date.now();
  const diffMs = now - createdMs;
  if (range === "today") {
    const created = new Date(createdMs);
    const today = new Date();
    return (
      created.getFullYear() === today.getFullYear() &&
      created.getMonth() === today.getMonth() &&
      created.getDate() === today.getDate()
    );
  }
  if (range === "week") return diffMs <= 7 * 24 * 60 * 60 * 1000;
  if (range === "month") return diffMs <= 30 * 24 * 60 * 60 * 1000;
  return true;
};


export default function BookmarksScreen() {
  const router = useRouter();
  const relativeTimeNow = useRelativeTimeNow();

  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [currentUserRole, setCurrentUserRole] = useState<UserRole | undefined>();
  const [bookmarkedPostIds, setBookmarkedPostIds] = useState<string[]>([]);
  const [postsById, setPostsById] = useState<Record<string, Post>>({});
  const [loading, setLoading] = useState(true);
  const { isOffline } = useNetworkStatus();

  // ─── Hydrate cached bookmarks for instant offline viewing ───────────
  useEffect(() => {
    if (!user?.uid) return;
    let isMounted = true;
    getCachedBookmarks<Post>(user.uid).then((cached) => {
      if (isMounted && cached) {
        if (cached.bookmarkedPostIds && cached.bookmarkedPostIds.length > 0) {
          setBookmarkedPostIds((prev) => (prev.length === 0 ? cached.bookmarkedPostIds : prev));
        }
        if (cached.postsById && Object.keys(cached.postsById).length > 0) {
          setPostsById((prev) => (Object.keys(prev).length === 0 ? cached.postsById : prev));
          setLoading(false);
        }
      }
    });
    return () => {
      isMounted = false;
    };
  }, [user?.uid]);

  // ─── Automatically persist bookmarks to disk whenever updated ───────
  useEffect(() => {
    if (user?.uid && (bookmarkedPostIds.length > 0 || Object.keys(postsById).length > 0)) {
      saveCachedBookmarks(user.uid, {
        bookmarkedPostIds,
        postsById,
      });
    }
  }, [user?.uid, bookmarkedPostIds, postsById]);

  const [commentModalPostId, setCommentModalPostId] = useState<string | null>(null);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [currentImages, setCurrentImages] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [currentImageViewerPostId, setCurrentImageViewerPostId] = useState<string | null>(null);

  const [postTypeFilter, setPostTypeFilter] = useState<PostTypeFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("recentlySaved");
  const [dateRangeFilter, setDateRangeFilter] = useState<DateRangeFilter>("all");
  const [showFilterSheet, setShowFilterSheet] = useState(false);

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

  // ─── Live post data for bookmarked ids ───────────────────────────────
  // Listen to each bookmarked document directly instead of using an
  // `documentId() in [...]` collection query. The posts security rule allows
  // approved posts (plus owner/staff access), and Firestore cannot prove that
  // every arbitrary id in an `in` query will satisfy that document rule.
  // Direct document listeners are evaluated one-by-one, so approved bookmarks
  // load correctly while deleted or inaccessible items are simply skipped.
  useEffect(() => {
    chunkListenersRef.current.forEach((unsubscribe) => unsubscribe());
    chunkListenersRef.current = [];

    if (bookmarkedPostIds.length === 0) {
      setPostsById({});
      setLoading(false);
      return;
    }

    // Remove stale entries immediately when the bookmark id set changes.
    setPostsById((prev) => {
      const allowedIds = new Set(bookmarkedPostIds);
      return Object.fromEntries(
        Object.entries(prev).filter(([id]) => allowedIds.has(id)),
      ) as Record<string, Post>;
    });

    let settledCount = 0;
    const markSettled = () => {
      settledCount += 1;
      if (settledCount >= bookmarkedPostIds.length) {
        setLoading(false);
      }
    };

    bookmarkedPostIds.forEach((postId) => {
      const postRef = doc(db, "posts", postId);
      let firstResult = true;

      const unsubscribe = onSnapshot(
        postRef,
        (snapshot) => {
          setPostsById((prev) => {
            const next = { ...prev };
            if (!snapshot.exists()) {
              delete next[postId];
              return next;
            }

            next[postId] = {
              id: snapshot.id,
              ...snapshot.data(),
            } as Post;
            return next;
          });

          if (firstResult) {
            firstResult = false;
            markSettled();
          }
        },
        (error: any) => {
          // A stale bookmark may point to content the viewer can no longer
          // read (for example, content that returned to pending moderation).
          // Treat that item as unavailable instead of surfacing a LogBox error.
          setPostsById((prev) => {
            if (!(postId in prev)) return prev;
            const next = { ...prev };
            delete next[postId];
            return next;
          });

          if (error?.code !== "permission-denied" && error?.code !== "not-found") {
            console.error("Error loading bookmarked post:", error);
          }

          if (firstResult) {
            firstResult = false;
            markSettled();
          }
        },
      );

      chunkListenersRef.current.push(unsubscribe);
    });

    return () => {
      chunkListenersRef.current.forEach((unsubscribe) => unsubscribe());
      chunkListenersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listener membership only changes with bookmark ids
  }, [bookmarkedPostIds.join(",")]);

  const savedPosts = useMemo(() => {
    // bookmarkedPostIds is appended to via arrayUnion, so its array order is
    // the order things were saved in — last item is the most recently
    // bookmarked. Keep a lookup of that order for the "Recently saved" sort.
    const savedOrderIndex = new Map(bookmarkedPostIds.map((id, index) => [id, index]));

    const filtered = bookmarkedPostIds
      .map((id) => postsById[id])
      .filter((post): post is Post => {
        if (!post) return false;
        // Same rule Home uses: hide pending/rejected content from normal
        // browsing surfaces. Legacy posts without moderationStatus count
        // as approved.
        const status = String(post.moderationStatus ?? "approved").toLowerCase();
        if (status !== "approved") return false;
        if (!matchesPostType(post, postTypeFilter)) return false;
        if (!matchesDateRange(post, dateRangeFilter)) return false;
        return true;
      });

    return filtered.sort((a, b) => {
      if (sortMode === "recentlySaved") {
        return (savedOrderIndex.get(b.id) ?? 0) - (savedOrderIndex.get(a.id) ?? 0);
      }
      const diff = getTimestampValue(b.createdAt) - getTimestampValue(a.createdAt);
      return sortMode === "oldest" ? -diff : diff;
    });
  }, [bookmarkedPostIds, postsById, postTypeFilter, dateRangeFilter, sortMode]);

  const activeFilterCount =
    (postTypeFilter !== "all" ? 1 : 0) + (dateRangeFilter !== "all" ? 1 : 0);

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
        <TouchableOpacity
          style={styles.filterButton}
          onPress={() => setShowFilterSheet(true)}
          activeOpacity={0.75}
        >
          <Ionicons name="options-outline" size={22} color="#4f1c17" />
          {activeFilterCount > 0 && (
            <View style={styles.filterCountBadge}>
              <Text style={styles.filterCountBadgeText}>{activeFilterCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* Above the branches, so it also shows when nothing was saved yet. */}
      {isOffline && (
        <View style={styles.offlineStatusBar}>
          <Ionicons name="cloud-offline-outline" size={14} color="#9a3412" />
          <Text style={styles.offlineStatusText}>Offline mode</Text>
        </View>
      )}

      {/* Offline the listener never answers, so the skeleton must give way to
          whatever was saved — otherwise this spins forever. */}
      {loading && !isOffline ? (
        <FeedSkeleton count={4} />
      ) : bookmarkedPostIds.length === 0 ? (
        <View style={styles.centerState}>
          <Ionicons name="bookmark-outline" size={40} color="#c9a89c" />
          <Text style={styles.emptyTitle}>No saved posts yet</Text>
          <Text style={styles.emptySubtitle}>
            Tap the bookmark icon on a post to save it here.
          </Text>
        </View>
      ) : savedPosts.length === 0 ? (
        <View style={styles.centerState}>
          <Ionicons name="search-outline" size={40} color="#c9a89c" />
          <Text style={styles.emptyTitle}>No matches</Text>
          <Text style={styles.emptySubtitle}>
            Nothing matches this filter. Try a different type or date range.
          </Text>
          <TouchableOpacity
            style={styles.clearFiltersButton}
            onPress={() => {
              setPostTypeFilter("all");
              setDateRangeFilter("all");
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.clearFiltersButtonText}>Clear filters</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <FlatList
            initialNumToRender={6}
            maxToRenderPerBatch={6}
            windowSize={7}
            data={savedPosts}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
          />
        </View>
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

      <Modal
        visible={showFilterSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowFilterSheet(false)}
      >
        <View style={styles.sheetOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setShowFilterSheet(false)}
          />
          <View style={styles.sheetCard}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Filter &amp; sort</Text>
              <TouchableOpacity onPress={() => setShowFilterSheet(false)} hitSlop={10}>
                <Ionicons name="close" size={22} color="#8f6a60" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.sheetSectionTitle}>Post type</Text>
              <View style={styles.chipRow}>
                {POST_TYPE_OPTIONS.map((option) => {
                  const active = postTypeFilter === option.value;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => setPostTypeFilter(option.value)}
                      activeOpacity={0.8}
                    >
                      <Ionicons
                        name={option.icon}
                        size={15}
                        color={active ? "#fffaf7" : "#7d5c53"}
                      />
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.sheetSectionTitle}>Saved / posted</Text>
              <View style={styles.chipRow}>
                {DATE_RANGE_OPTIONS.map((option) => {
                  const active = dateRangeFilter === option.value;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => setDateRangeFilter(option.value)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.sheetSectionTitle}>Sort by</Text>
              <View style={styles.sortList}>
                {SORT_OPTIONS.map((option) => {
                  const active = sortMode === option.value;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[styles.sortRow, active && styles.sortRowActive]}
                      onPress={() => setSortMode(option.value)}
                      activeOpacity={0.8}
                    >
                      <Ionicons
                        name={option.icon}
                        size={18}
                        color={active ? "#5f0909" : "#7d5c53"}
                      />
                      <Text style={[styles.sortRowText, active && styles.sortRowTextActive]}>
                        {option.label}
                      </Text>
                      {active && (
                        <Ionicons name="checkmark-circle" size={18} color="#5f0909" />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>

            <TouchableOpacity
              style={styles.sheetDoneButton}
              onPress={() => setShowFilterSheet(false)}
              activeOpacity={0.85}
            >
              <Text style={styles.sheetDoneButtonText}>Show results</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  filterButton: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  filterCountBadge: {
    position: "absolute",
    top: 2,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: "#a61f1f",
    alignItems: "center",
    justifyContent: "center",
  },
  filterCountBadgeText: { color: "#fffaf7", fontSize: 10, fontWeight: "800" },
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
  clearFiltersButton: {
    marginTop: 6,
    backgroundColor: "#5f0909",
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  clearFiltersButtonText: { color: "#fffaf7", fontSize: 13.5, fontWeight: "700" },

  // ─── Filter / sort bottom sheet ─────────────────────────────────────
  sheetOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  sheetCard: {
    backgroundColor: "#f6f1ed",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 22,
    maxHeight: "80%",
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#e0cfc6",
    alignSelf: "center",
    marginBottom: 12,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sheetTitle: { color: "#4d1b17", fontSize: 18, fontWeight: "800" },
  sheetSectionTitle: {
    color: "#5f0909",
    fontSize: 13,
    fontWeight: "800",
    marginTop: 16,
    marginBottom: 10,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#ead7cf",
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: "#5f0909", borderColor: "#5f0909" },
  chipText: { color: "#7d5c53", fontSize: 13, fontWeight: "700" },
  chipTextActive: { color: "#fffaf7" },
  sortList: { gap: 8 },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#ead7cf",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  sortRowActive: { borderColor: "#5f0909", backgroundColor: "#fdf1ee" },
  sortRowText: { flex: 1, color: "#4d1b17", fontSize: 14, fontWeight: "600" },
  sortRowTextActive: { color: "#5f0909", fontWeight: "800" },
  sheetDoneButton: {
    marginTop: 18,
    backgroundColor: "#5f0909",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  sheetDoneButtonText: { color: "#fffaf7", fontSize: 15, fontWeight: "800" },
  offlineStatusBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffedd5",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#fed7aa",
    gap: 6,
  },
  offlineStatusText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#9a3412",
  },
});
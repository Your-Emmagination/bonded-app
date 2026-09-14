import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { onAuthStateChanged, type User as FirebaseUser } from "firebase/auth";
import {
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    limit,
    onSnapshot,
    orderBy,
    query,
    startAfter,
    updateDoc,
    where,
} from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    BackHandler,
    FlatList,
    Linking,
    NativeScrollEvent,
    NativeSyntheticEvent,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AlumniBadge from "./components/AlumniBadge";
import ConfirmDialog from "./components/ConfirmDialog";

import { resolveAvatarUri } from "@/utils/avatar";
import { AVATAR_SIZE_LARGE, avatarThumb } from "@/utils/cloudinaryImages";
import { getDirectChatParams } from "@/utils/directMessages";
import { useNetworkStatus } from "@/utils/networkUtils";
import {
    removeLikeNotification,
    upsertLikeNotification,
} from "@/utils/notifications";
import { getPendingPostLike, savePostLike, withViewerLike } from "@/utils/postLikes";
import {
    getCachedUserProfile,
    saveCachedUserProfile,
} from "@/utils/offlineStorage";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import {
    peekUserData,
    resolveUserRoleForAuthUser,
    type UserData,
    type UserRole,
} from "@/utils/rbac";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { auth, db } from "../../Firebase_configure";
import ImageZoomViewer from "./components/ImageZoomViewer";
import PollCard from "./components/PollCard";
import PostCard from "./components/PostCard";
import { FeedSkeleton, ProfileHeaderSkeleton } from "./components/Skeleton";

const PAGE_SIZE = 20;
const USER_PROFILE_RETURN_ROUTE = "/(main)/UserProfileScreen";

type Student = {
  id?: string;
  userId?: string;
  firstname?: string;
  lastname?: string;
  course?: string;
  yearlvl?: string;
  studentID?: string;
  email?: string;
  profileImage?: string;
  profilePic?: string | null;
  isOnline?: boolean;
  role?: string;
};

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
  moderationStatus?: string;
  flair?: string;
};

type PollOption = {
  text: string;
  votes: number;
  voters: string[];
};

type Poll = {
  id: string;
  question: string;
  options: PollOption[];
  imageUrl?: string;
  userId?: string;
  username?: string;
  userRole?: UserRole;
  isAnonymous?: boolean;
  allowMultiple: boolean;
  maxSelections: number;
  allowUsersToAddOption?: boolean;
  totalVotes: number;
  durationMs: number;
  createdAt?: any;
  expiresAt?: any;
  userVotes?: number[];
  commentCount?: number;
  moderationStatus?: string;
  flair?: string;
};

type ProfileContentFilter = "all" | "posts" | "polls";

type ProfileFeedItem =
  | { type: "post"; item: Post }
  | { type: "poll"; item: Poll };

const getProfileContentTimestamp = (value: any): number => {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (value instanceof Date) return value.getTime();
  return 0;
};

const buildStudentPreview = (
  profile: UserData | null | undefined,
): Student | null => {
  if (!profile) return null;

  return {
    userId: profile.userId,
    firstname: profile.firstname,
    lastname: profile.lastname,
    course: profile.course,
    yearlvl: profile.yearlvl,
    studentID: profile.studentID,
    email: profile.email,
    profileImage: profile.profileImage || undefined,
    isOnline: profile.isOnline,
    role: profile.role,
  };
};

const canShowProfileContent = (
  status?: string,
  isAnonymous?: boolean,
  publicUserId?: string,
) =>
  (!status || status === "approved") &&
  isAnonymous !== true &&
  publicUserId !== "anonymous";

const UserProfileScreen = () => {
  const { styles, theme } = useStyles();
  const params = useLocalSearchParams<{
    userId?: string | string[];
    profileDocId?: string | string[];
    returnTo?: string | string[];
  }>();
  const router = useRouter();
  const navigation = useNavigation();
  const relativeTimeNow = useRelativeTimeNow();
  const { isOffline } = useNetworkStatus();

  const userId = Array.isArray(params.userId) ? params.userId[0] : params.userId;
  const profileDocId = Array.isArray(params.profileDocId)
    ? params.profileDocId[0]
    : params.profileDocId;
  const returnTo = Array.isArray(params.returnTo)
    ? params.returnTo[0]
    : params.returnTo;

  const initialStudentPreview =
    buildStudentPreview(peekUserData(profileDocId || userId || null)) ||
    buildStudentPreview(peekUserData(userId || profileDocId || null));

  const [student, setStudent] = useState<Student | null>(initialStudentPreview);
  const [contentOwnerId, setContentOwnerId] = useState<string | null>(
    initialStudentPreview?.userId || userId || null,
  );
  const [loading, setLoading] = useState(!initialStudentPreview);

  useEffect(() => {
    const targetKey = userId || profileDocId;
    if (!targetKey) return;
    getCachedUserProfile<Student, Post>(targetKey).then((cached) => {
      if (cached) {
        if (cached.profile) {
          setStudent((prev) => prev || cached.profile);
          setContentOwnerId((prev) => prev || cached.profile?.userId || targetKey);
          setLoading(false);
        }
        if (cached.posts && cached.posts.length > 0) {
          setPosts((prev) => (prev.length > 0 ? prev : cached.posts));
          setContentLoading(false);
        }
      }
    });
  }, [userId, profileDocId]);

  const [viewer, setViewer] = useState<FirebaseUser | null>(auth.currentUser);
  const [viewerRole, setViewerRole] = useState<UserRole | undefined>();

  const [posts, setPosts] = useState<Post[]>([]);
  const postsRef = useRef<Post[]>(posts);
  postsRef.current = posts;

  const [polls, setPolls] = useState<Poll[]>([]);
  const [contentFilter, setContentFilter] = useState<ProfileContentFilter>("all");
  const [contentFilterOpen, setContentFilterOpen] = useState(false);
  const [contentLoading, setContentLoading] = useState(true);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);
  const [loadingMorePolls, setLoadingMorePolls] = useState(false);
  const [hasMorePosts, setHasMorePosts] = useState(true);
  const [hasMorePolls, setHasMorePolls] = useState(true);

  const studentRef = useRef<Student | null>(student);
  studentRef.current = student;
  const lastFetchedOwnerIdRef = useRef<string | null>(null);

  const lastPostDocRef = useRef<any>(null);
  const lastPollDocRef = useRef<any>(null);
  const loadedPostIdsRef = useRef<Set<string>>(new Set());
  const loadedPollIdsRef = useRef<Set<string>>(new Set());
  const pollVoteInFlightRef = useRef<Set<string>>(new Set());

  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [currentImages, setCurrentImages] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  // Single dialog state used to render every alert on this screen through
  // the app's branded ConfirmDialog instead of the bare native Alert.alert.
  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    singleAction?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const showInfo = (title: string, description?: string, onConfirm?: () => void) => {
    setDialog({
      title,
      description,
      confirmText: "OK",
      singleAction: true,
      onConfirm: () => {
        setDialog(null);
        onConfirm?.();
      },
    });
  };
  const showConfirm = (options: {
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    onConfirm: () => void;
  }) => {
    setDialog({
      ...options,
      onConfirm: () => {
        setDialog(null);
        options.onConfirm();
      },
    });
  };

  const navigateBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (returnTo) {
      router.replace(returnTo as any);
      return;
    }
    router.back();
  }, [navigation, returnTo, router]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (imageViewerVisible) {
        setImageViewerVisible(false);
        return true;
      }
      navigateBack();
      return true;
    });
    return () => subscription.remove();
  }, [imageViewerVisible, navigateBack]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setViewer(currentUser);
      if (!currentUser) {
        setViewerRole(undefined);
        return;
      }
      void resolveUserRoleForAuthUser(currentUser)
        .then((role) => setViewerRole(role as UserRole))
        .catch((error) => {
          console.error("Error resolving viewer role:", error);
          setViewerRole(undefined);
        });
    });
    return unsubscribe;
  }, []);

  const getStudentScore = useCallback(
    (candidate: Student & { id: string }) => {
      let score = 0;
      if (profileDocId && candidate.id === profileDocId) score += 20;
      if (userId && candidate.userId === userId) score += 18;
      if (userId && candidate.id === userId) score += 10;
      if (userId && candidate.studentID === userId) score += 8;
      if (resolveAvatarUri(candidate)) score += 4;
      if (candidate.firstname) score += 2;
      if (candidate.lastname) score += 2;
      if (candidate.course) score += 1;
      return score;
    },
    [profileDocId, userId],
  );

  useEffect(() => {
    if (!userId && !profileDocId) {
      navigateBack();
      return;
    }

    let active = true;
    let unsubscribeProfile: (() => void) | null = null;

    const resolveProfile = async () => {
      const candidates: Array<Student & { id: string }> = [];
      const seen = new Set<string>();

      const addCandidate = (id: string, data: Student) => {
        if (seen.has(id)) return;
        seen.add(id);
        candidates.push({ id, ...data });
      };

      const loadDocCandidate = async (id?: string | null) => {
        if (!id || seen.has(id)) return;
        const snapshot = await getDoc(doc(db, "students", id));
        if (snapshot.exists()) {
          addCandidate(snapshot.id, snapshot.data() as Student);
        }
      };

      await loadDocCandidate(profileDocId);
      await loadDocCandidate(userId);

      const fallbackQueries = [];
      if (userId) {
        fallbackQueries.push(
          query(collection(db, "students"), where("userId", "==", userId), limit(5)),
        );
        fallbackQueries.push(
          query(collection(db, "students"), where("studentID", "==", userId), limit(5)),
        );
      }
      if (profileDocId && profileDocId !== userId) {
        fallbackQueries.push(
          query(
            collection(db, "students"),
            where("studentID", "==", profileDocId),
            limit(5),
          ),
        );
      }

      for (const fallbackQuery of fallbackQueries) {
        const snapshot = await getDocs(fallbackQuery);
        snapshot.docs.forEach((studentDoc) => {
          addCandidate(studentDoc.id, studentDoc.data() as Student);
        });
      }

      if (candidates.length === 0) return null;
      candidates.sort((a, b) => getStudentScore(b) - getStudentScore(a));
      return candidates[0];
    };

    // A cached profile is already on screen at this point; don't drop back
    // into a spinner for it.
    setLoading(!initialStudentPreview && !studentRef.current);

    void resolveProfile()
      .then((candidate) => {
        if (!active) return;
        if (!candidate) {
          // Offline this lookup can't reach anyone, so keep whatever the
          // cache gave us instead of replacing it with "User not found".
          if (!isOffline || !studentRef.current) {
            setStudent(null);
            setContentOwnerId(null);
          }
          setLoading(false);
          return;
        }

        setStudent(candidate);
        setContentOwnerId(candidate.userId || userId || candidate.id);
        setLoading(false);
        const targetKey = userId || profileDocId || candidate.id;
        if (targetKey) {
          saveCachedUserProfile(targetKey, { profile: candidate, posts: postsRef.current });
        }

        unsubscribeProfile = onSnapshot(
          doc(db, "students", candidate.id),
          (snapshot) => {
            if (!active) return;
            if (!snapshot.exists()) {
              setStudent(null);
              setLoading(false);
              return;
            }

            const data = { id: snapshot.id, ...(snapshot.data() as Student) };
            setStudent(data);
            setContentOwnerId(data.userId || userId || snapshot.id);
            setLoading(false);
            if (targetKey) {
              saveCachedUserProfile(targetKey, { profile: data, posts: postsRef.current });
            }
          },
          (error) => {
            console.error("Error listening to user profile:", error);
            setLoading(false);
          },
        );
      })
      .catch((error) => {
        console.error("Error resolving user profile:", error);
        if (active) {
          setStudent((prev) => prev ?? null);
          setLoading(false);
        }
      });

    return () => {
      active = false;
      unsubscribeProfile?.();
    };
  }, [getStudentScore, isOffline, navigateBack, profileDocId, userId]);

  const fetchUserContent = useCallback(async (uid: string) => {
    if (postsRef.current.length === 0) {
      setContentLoading(true);
    }
    lastPostDocRef.current = null;
    lastPollDocRef.current = null;
    loadedPostIdsRef.current.clear();
    loadedPollIdsRef.current.clear();
    setHasMorePosts(true);
    setHasMorePolls(true);

    try {
      // Posts always store the authenticated owner in realUserId.
      // Polls store the authenticated owner in userId.
      // Keeping these as two simple queries avoids the old OR query that
      // caused Firestore to request several composite indexes and also avoids
      // searching with a student document id instead of the auth uid.
      const [postSnapshot, pollSnapshot] = await Promise.all([
        getDocs(
          query(
            collection(db, "posts"),
            where("realUserId", "==", uid),
            orderBy("createdAt", "desc"),
            limit(PAGE_SIZE),
          ),
        ),
        getDocs(
          query(
            collection(db, "polls"),
            where("userId", "==", uid),
            orderBy("createdAt", "desc"),
            limit(PAGE_SIZE),
          ),
        ),
      ]);

      const nextPosts = postSnapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }) as Post)
        .filter((item) =>
          canShowProfileContent(
            item.moderationStatus,
            item.isAnonymous,
            item.userId,
          ),
        );
      const nextPolls = pollSnapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }) as Poll)
        .filter((item) =>
          canShowProfileContent(
            item.moderationStatus,
            item.isAnonymous,
            item.userId,
          ),
        );

      loadedPostIdsRef.current = new Set(postSnapshot.docs.map((item) => item.id));
      loadedPollIdsRef.current = new Set(pollSnapshot.docs.map((item) => item.id));
      lastPostDocRef.current = postSnapshot.docs[postSnapshot.docs.length - 1] ?? null;
      lastPollDocRef.current = pollSnapshot.docs[pollSnapshot.docs.length - 1] ?? null;
      setHasMorePosts(postSnapshot.size === PAGE_SIZE);
      setHasMorePolls(pollSnapshot.size === PAGE_SIZE);
      setPosts(nextPosts);
      setPolls(nextPolls);
      const targetCacheKey = userId || profileDocId || uid;
      if (targetCacheKey) {
        saveCachedUserProfile(targetCacheKey, { profile: studentRef.current, posts: nextPosts });
      }
    } catch (error) {
      console.error("Error fetching user profile content:", error);
      setPosts((prev) => (prev.length > 0 ? prev : []));
      setPolls((prev) => (prev.length > 0 ? prev : []));
      setHasMorePosts(false);
      setHasMorePolls(false);
    } finally {
      setContentLoading(false);
    }
  }, [profileDocId, userId]);

  useEffect(() => {
    if (!contentOwnerId) {
      setPosts([]);
      setPolls([]);
      setContentLoading(false);
      lastFetchedOwnerIdRef.current = null;
      return;
    }
    if (lastFetchedOwnerIdRef.current === contentOwnerId) {
      return;
    }
    lastFetchedOwnerIdRef.current = contentOwnerId;
    void fetchUserContent(contentOwnerId);
  }, [contentOwnerId, fetchUserContent]);

  const loadMorePosts = useCallback(async () => {
    if (
      !contentOwnerId ||
      loadingMorePosts ||
      !hasMorePosts ||
      !lastPostDocRef.current
    ) {
      return;
    }

    setLoadingMorePosts(true);
    try {
      const snapshot = await getDocs(
        query(
          collection(db, "posts"),
          where("realUserId", "==", contentOwnerId),
          orderBy("createdAt", "desc"),
          startAfter(lastPostDocRef.current),
          limit(PAGE_SIZE),
        ),
      );

      const nextPosts = snapshot.docs
        .filter((item) => !loadedPostIdsRef.current.has(item.id))
        .map((item) => ({ id: item.id, ...item.data() }) as Post)
        .filter((item) =>
          canShowProfileContent(
            item.moderationStatus,
            item.isAnonymous,
            item.userId,
          ),
        );

      snapshot.docs.forEach((item) => loadedPostIdsRef.current.add(item.id));
      lastPostDocRef.current =
        snapshot.docs[snapshot.docs.length - 1] ?? lastPostDocRef.current;
      setHasMorePosts(snapshot.size === PAGE_SIZE);
      if (nextPosts.length) setPosts((previous) => [...previous, ...nextPosts]);
    } catch (error) {
      console.error("Error loading more user posts:", error);
    } finally {
      setLoadingMorePosts(false);
    }
  }, [contentOwnerId, hasMorePosts, loadingMorePosts]);

  const loadMorePolls = useCallback(async () => {
    if (
      !contentOwnerId ||
      loadingMorePolls ||
      !hasMorePolls ||
      !lastPollDocRef.current
    ) {
      return;
    }

    setLoadingMorePolls(true);
    try {
      const snapshot = await getDocs(
        query(
          collection(db, "polls"),
          where("userId", "==", contentOwnerId),
          orderBy("createdAt", "desc"),
          startAfter(lastPollDocRef.current),
          limit(PAGE_SIZE),
        ),
      );

      const nextPolls = snapshot.docs
        .filter((item) => !loadedPollIdsRef.current.has(item.id))
        .map((item) => ({ id: item.id, ...item.data() }) as Poll)
        .filter((item) =>
          canShowProfileContent(
            item.moderationStatus,
            item.isAnonymous,
            item.userId,
          ),
        );

      snapshot.docs.forEach((item) => loadedPollIdsRef.current.add(item.id));
      lastPollDocRef.current =
        snapshot.docs[snapshot.docs.length - 1] ?? lastPollDocRef.current;
      setHasMorePolls(snapshot.size === PAGE_SIZE);
      if (nextPolls.length) setPolls((previous) => [...previous, ...nextPolls]);
    } catch (error) {
      console.error("Error loading more user polls:", error);
    } finally {
      setLoadingMorePolls(false);
    }
  }, [contentOwnerId, hasMorePolls, loadingMorePolls]);

  const getTimeAgo = useCallback(
    (timestamp: any) => {
      if (!timestamp || typeof timestamp.toDate !== "function") return "";
      const now = new Date(relativeTimeNow);
      const itemDate = timestamp.toDate();
      const diffMs = now.getTime() - itemDate.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHour = Math.floor(diffMin / 60);
      const diffDay = Math.floor(diffHour / 24);

      if (diffSec < 60) return "Just now";
      if (diffMin < 60) return `${diffMin}m ago`;
      if (diffHour < 24) return `${diffHour}h ago`;
      if (diffDay < 7) return `${diffDay}d ago`;

      return itemDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: itemDate.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
      });
    },
    [relativeTimeNow],
  );

  const openImageViewer = useCallback(
    (images: string[], startIndex = 0) => {
      if (!images.length) return;
      setCurrentImages(images);
      setCurrentImageIndex(startIndex);
      setImageViewerVisible(true);
    },
    [],
  );

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

      void Linking.canOpenURL(fileUrl)
        .then((supported) => {
          if (supported) return Linking.openURL(fileUrl);
          showInfo("Cannot Open File", "Unable to open this file type on your device.");
        })
        .catch((error) => {
          console.error("Error opening profile post file:", error);
          showInfo("Error", "Failed to open file.");
        });
    },
    [openImageViewer],
  );

  const handleProfileClick = useCallback(
    (targetId?: string) => {
      if (!targetId) return;

      if (targetId === "self" || targetId === viewer?.uid) {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo: USER_PROFILE_RETURN_ROUTE },
        });
        return;
      }

      if (targetId.startsWith("/UserProfileScreen?")) {
        const separator = targetId.includes("?") ? "&" : "?";
        router.push(
          `${targetId}${separator}returnTo=${encodeURIComponent(USER_PROFILE_RETURN_ROUTE)}` as any,
        );
        return;
      }

      router.push(
        buildUserProfileHref({
          userId: targetId,
          returnTo: USER_PROFILE_RETURN_ROUTE,
        }) as any,
      );
    },
    [router, viewer?.uid],
  );

  const handleTagClick = useCallback(
    (taggedUserId: string) => {
      if (!taggedUserId) return;
      if (taggedUserId === viewer?.uid) {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo: USER_PROFILE_RETURN_ROUTE },
        });
        return;
      }
      router.push(
        buildUserProfileHref({
          userId: taggedUserId,
          returnTo: USER_PROFILE_RETURN_ROUTE,
        }) as any,
      );
    },
    [router, viewer?.uid],
  );

  const handleLike = useCallback(
    (postId: string, currentLikedBy: string[] = []) => {
      if (!viewer) return;
      if (isOffline) {
        showInfo("Offline", "You are currently offline. Liking posts is unavailable.");
        return;
      }

      const currentPost = posts.find((post) => post.id === postId);
      if (!currentPost) return;

      const uid = viewer.uid;
      const liked = !(getPendingPostLike(postId) ?? currentLikedBy.includes(uid));
      const showLike = (value: boolean) =>
        setPosts((previous) =>
          previous.map((post) =>
            post.id === postId ? withViewerLike(post, uid, value) : post,
          ),
        );

      // Show the like right away; savePostLike writes it in the background.
      showLike(liked);

      const ownerId = currentPost.realUserId || currentPost.userId;
      const actorName =
        viewer.displayName || viewer.email?.split("@")[0] || "Someone";

      void savePostLike({
        postId,
        uid,
        liked,
        onChanged: (nowLiked) => {
          const logError = (error: unknown) =>
            console.error("Error updating like notification:", error);
          if (nowLiked) {
            upsertLikeNotification({
              recipientId: ownerId,
              actor: { id: uid, name: actorName, profileImage: null },
              entityType: "post",
              entityId: postId,
              preview: currentPost.content,
            }).catch(logError);
          } else {
            removeLikeNotification({
              recipientId: ownerId,
              actorId: uid,
              entityType: "post",
              entityId: postId,
            }).catch(logError);
          }
        },
        onFailed: (savedLiked, error) => {
          console.error("Error liking profile post:", error);
          showLike(savedLiked);
          showInfo("Error", "Failed to update the like.");
        },
      });
    },
    [isOffline, posts, viewer],
  );

  const isPollExpired = useCallback((expiresAt: any) => {
    if (!expiresAt) return false;
    if (typeof expiresAt.toDate === "function") {
      return new Date() > expiresAt.toDate();
    }
    const parsed = new Date(expiresAt);
    return !Number.isNaN(parsed.getTime()) && new Date() > parsed;
  }, []);

  const handlePollVote = useCallback(
    async (pollId: string, optionIndex: number) => {
      if (!viewer) return;
      if (isOffline) {
        showInfo("Offline", "You are currently offline. Voting is unavailable.");
        return;
      }
      if (pollVoteInFlightRef.current.has(pollId)) return;
      const poll = polls.find((item) => item.id === pollId);
      if (!poll || isPollExpired(poll.expiresAt)) return;

      const existingVotes = poll.options
        .map((option, index) =>
          Array.isArray(option.voters) && option.voters.includes(viewer.uid)
            ? index
            : -1,
        )
        .filter((index) => index !== -1);

      if (!poll.allowMultiple && existingVotes.length > 0) return;
      if (existingVotes.includes(optionIndex)) return;
      if (poll.allowMultiple && existingVotes.length >= poll.maxSelections) return;

      const previousOptions = poll.options;
      const previousTotal = poll.totalVotes || 0;
      const updatedOptions = poll.options.map((option, index) => {
        const voters = Array.isArray(option.voters) ? [...option.voters] : [];
        if (index === optionIndex && !voters.includes(viewer.uid)) {
          voters.push(viewer.uid);
        }
        return { ...option, voters, votes: voters.length };
      });
      const totalVotes = updatedOptions.reduce(
        (total, option) => total + (option.votes || 0),
        0,
      );

      pollVoteInFlightRef.current.add(pollId);
      setPolls((previous) =>
        previous.map((item) =>
          item.id === pollId ? { ...item, options: updatedOptions, totalVotes } : item,
        ),
      );

      try {
        await updateDoc(doc(db, "polls", pollId), {
          options: updatedOptions,
          totalVotes,
        });
      } catch (error) {
        console.error("Error voting on profile poll:", error);
        setPolls((previous) =>
          previous.map((item) =>
            item.id === pollId
              ? { ...item, options: previousOptions, totalVotes: previousTotal }
              : item,
          ),
        );
        showInfo("Error", "Failed to vote. Please try again.");
      } finally {
        pollVoteInFlightRef.current.delete(pollId);
      }
    },
    [isOffline, isPollExpired, polls, viewer],
  );

  const addOptionToPoll = useCallback(
    async (pollId: string, text: string) => {
      if (isOffline) {
        showInfo("Offline", "You are currently offline. Adding options is unavailable.");
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) return;

      const poll = polls.find((item) => item.id === pollId);
      if (!poll || isPollExpired(poll.expiresAt)) {
        showInfo("Poll Ended", "This poll has already expired.");
        return;
      }

      const newOption: PollOption = { text: trimmed, votes: 0, voters: [] };
      const updatedOptions = [...poll.options, newOption];
      try {
        await updateDoc(doc(db, "polls", pollId), {
          options: updatedOptions,
          totalVotes: poll.totalVotes || 0,
        });
        setPolls((previous) =>
          previous.map((item) =>
            item.id === pollId ? { ...item, options: updatedOptions } : item,
          ),
        );
      } catch (error) {
        console.error("Error adding profile poll option:", error);
        showInfo("Error", "Failed to add the option.");
      }
    },
    [isPollExpired, polls],
  );

  const handleEditPoll = useCallback(
    (pollId: string) => {
      const poll = polls.find((item) => item.id === pollId);
      if (!poll || poll.userId !== viewer?.uid) {
        showInfo("Access Denied", "You can only edit your own polls.");
        return;
      }
      router.push({ pathname: "/CreatePollScreen", params: { editPollId: pollId } });
    },
    [polls, router, viewer?.uid],
  );

  const handleDeletePoll = useCallback(async (pollId: string) => {
    try {
      const commentsSnapshot = await getDocs(
        query(collection(db, "comments"), where("postId", "==", pollId)),
      );
      await Promise.all(
        commentsSnapshot.docs.map(async (commentSnapshot) => {
          const repliesSnapshot = await getDocs(
            query(collection(db, "replies"), where("commentId", "==", commentSnapshot.id)),
          );
          await Promise.all(repliesSnapshot.docs.map((replySnapshot) => deleteDoc(replySnapshot.ref)));
          await deleteDoc(commentSnapshot.ref);
        }),
      );
      await deleteDoc(doc(db, "polls", pollId));
      setPolls((previous) => previous.filter((item) => item.id !== pollId));
    } catch (error) {
      console.error("Error deleting profile poll:", error);
      showInfo("Error", "Failed to delete poll.");
    }
  }, []);

  const profileFeedItems = useMemo<ProfileFeedItem[]>(() => {
    const combined: ProfileFeedItem[] = [
      ...posts.map((item) => ({ type: "post" as const, item })),
      ...polls.map((item) => ({ type: "poll" as const, item })),
    ];

    return combined.sort(
      (first, second) =>
        getProfileContentTimestamp(second.item.createdAt) -
        getProfileContentTimestamp(first.item.createdAt),
    );
  }, [polls, posts]);

  const filteredProfileFeedItems = useMemo(
    () =>
      profileFeedItems.filter((entry) => {
        if (contentFilter === "all") return true;
        return contentFilter === "posts" ? entry.type === "post" : entry.type === "poll";
      }),
    [contentFilter, profileFeedItems],
  );

  const isLoadingMoreContent =
    (contentFilter !== "polls" && loadingMorePosts) ||
    (contentFilter !== "posts" && loadingMorePolls);

  const hasMoreFilteredContent =
    (contentFilter !== "polls" && hasMorePosts) ||
    (contentFilter !== "posts" && hasMorePolls);

  const handleLoadMoreContent = useCallback(async () => {
    const tasks: Promise<void>[] = [];

    if (contentFilter !== "polls" && hasMorePosts) {
      tasks.push(loadMorePosts());
    }
    if (contentFilter !== "posts" && hasMorePolls) {
      tasks.push(loadMorePolls());
    }

    if (tasks.length) {
      await Promise.all(tasks);
    }
  }, [
    contentFilter,
    hasMorePolls,
    hasMorePosts,
    loadMorePolls,
    loadMorePosts,
  ]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
      const isCloseToBottom =
        layoutMeasurement.height + contentOffset.y >= contentSize.height - 220;
      if (isCloseToBottom && hasMoreFilteredContent && !isLoadingMoreContent) {
        void handleLoadMoreContent();
      }
    },
    [handleLoadMoreContent, hasMoreFilteredContent, isLoadingMoreContent],
  );

  const profileImageUri = resolveAvatarUri(student || {}) || "";
  const fullName = useMemo(
    () =>
      `${student?.firstname || ""} ${student?.lastname || ""}`.trim() ||
      "Anonymous",
    [student?.firstname, student?.lastname],
  );
  const ownerRole = (student?.role?.toLowerCase() || "student") as UserRole;

  const handlePostCommentCountUpdate = useCallback((postId: string, newCount: number) => {
    setPosts((previous) =>
      previous.map((item) =>
        item.id === postId ? { ...item, commentCount: newCount } : item,
      ),
    );
  }, [setPosts]);

  const handlePollCommentCountUpdate = useCallback((pollId: string, newCount: number) => {
    setPolls((previous) =>
      previous.map((item) =>
        item.id === pollId ? { ...item, commentCount: newCount } : item,
      ),
    );
  }, []);

  const handlePollProfileClick = useCallback(
    (targetId?: string) => handleProfileClick(targetId),
    [handleProfileClick],
  );

  // The activity list only draws the posts and polls near the screen.
  const profileFeedListData = useMemo<ProfileFeedItem[]>(
    () => (contentLoading ? [] : filteredProfileFeedItems),
    [contentLoading, filteredProfileFeedItems],
  );
  const lastProfileFeedIndex = profileFeedListData.length - 1;

  const renderProfileFeedItem = useCallback(
    ({ item: entry, index }: { item: ProfileFeedItem; index: number }) => (
      <View
        style={[
          styles.feedCardGroupItem,
          index === 0 && styles.feedCardGroupItemFirst,
          index === lastProfileFeedIndex && styles.feedCardGroupItemLast,
        ]}
      >
        {entry.type === "post" ? (
          <PostCard
            post={entry.item as any}
            isLiked={entry.item.likedBy?.includes(viewer?.uid || "") || false}
            currentUserRole={viewerRole}
            currentUserId={viewer?.uid}
            onLike={handleLike}
            onProfileClick={handleProfileClick}
            onTagClick={handleTagClick}
            onImagePress={openImageViewer}
            onFilePress={handleFilePress}
            getTimeAgo={getTimeAgo}
            onCommentCountUpdate={handlePostCommentCountUpdate}
          />
        ) : (
          <PollCard
            poll={entry.item as any}
            currentUserId={viewer?.uid}
            userRole={ownerRole}
            currentUserRole={viewerRole}
            onVote={handlePollVote}
            onAddOption={addOptionToPoll}
            onEdit={handleEditPoll}
            onDelete={handleDeletePoll}
            onProfileClick={handlePollProfileClick}
            onImagePress={openImageViewer}
            getTimeAgo={getTimeAgo}
            isPollExpired={isPollExpired}
            onCommentCountUpdate={handlePollCommentCountUpdate}
          />
        )}
      </View>
    ),
    [
      addOptionToPoll,
      getTimeAgo,
      handleDeletePoll,
      handleEditPoll,
      handleFilePress,
      handleLike,
      handlePollCommentCountUpdate,
      handlePollProfileClick,
      handlePollVote,
      handlePostCommentCountUpdate,
      handleProfileClick,
      handleTagClick,
      isPollExpired,
      lastProfileFeedIndex,
      openImageViewer,
      ownerRole,
      styles.feedCardGroupItem,
      styles.feedCardGroupItemFirst,
      styles.feedCardGroupItemLast,
      viewer?.uid,
      viewerRole,
    ],
  );

  if (loading && !student) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.contentShell}>
          <View style={styles.headerShell}>
            <View style={styles.headerRow}>
              <TouchableOpacity style={styles.headerBackButton} onPress={navigateBack}>
                <Ionicons name="arrow-back" size={20} color={theme.onChrome} />
              </TouchableOpacity>
              <View style={styles.headerCopy}>
                <Text style={styles.headerTitle}>Profile</Text>
                <Text style={styles.headerSubtext}>Loading member profile</Text>
              </View>
              <View style={styles.headerBackSpacer} />
            </View>
          </View>
          <ProfileHeaderSkeleton />
        </View>
      </SafeAreaView>
    );
  }

  if (!student) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.headerShell}>
          <View style={styles.headerRow}>
            <TouchableOpacity style={styles.headerBackButton} onPress={navigateBack}>
              <Ionicons name="arrow-back" size={20} color={theme.onChrome} />
            </TouchableOpacity>
            <View style={styles.headerCopy}>
              <Text style={styles.headerTitle}>Profile</Text>
              <Text style={styles.headerSubtext}>Member not found</Text>
            </View>
            <View style={styles.headerBackSpacer} />
          </View>
        </View>
        <View style={styles.loadingState}>
          <Ionicons name="person-circle-outline" size={52} color={theme.textMuted} />
          <Text style={styles.errorText}>User not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
        <View style={styles.headerShell}>
          <View style={styles.headerRow}>
            <TouchableOpacity style={styles.headerBackButton} onPress={navigateBack}>
              <Ionicons name="arrow-back" size={20} color={theme.onChrome} />
            </TouchableOpacity>
            <View style={styles.headerCopy}>
              <Text style={styles.headerTitle}>Profile</Text>
              <Text style={styles.headerSubtext}>{fullName}</Text>
            </View>
            <View style={styles.headerBackSpacer} />
          </View>
        </View>

        {isOffline && (
          <View style={styles.offlineStatusBar}>
            <Ionicons name="cloud-offline-outline" size={14} color={theme.warning} />
            <Text style={styles.offlineStatusText}>
              Offline mode
            </Text>
          </View>
        )}

        {/* Only the posts and polls near the screen are drawn. */}
        <FlatList
          data={profileFeedListData}
          keyExtractor={(entry) => `${entry.type}:${entry.item.id}`}
          renderItem={renderProfileFeedItem}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          onScroll={handleScroll}
          scrollEventThrottle={150}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={7}
          removeClippedSubviews={false}
          ListHeaderComponentStyle={styles.activityListHeader}
          ListHeaderComponent={
            <>
              <View style={styles.profileCard}>
                <TouchableOpacity
                  activeOpacity={0.88}
                  disabled={!profileImageUri}
                  onPress={() => profileImageUri && openImageViewer([profileImageUri], 0)}
                  style={styles.avatarWrapper}
                >
                  {profileImageUri ? (
                    <Image
                      source={{ uri: avatarThumb(profileImageUri, AVATAR_SIZE_LARGE) }}
                      style={styles.profileImage}
                    />
                  ) : (
                    <View style={styles.placeholder}>
                      <Ionicons name="person" size={48} color={theme.accent} />
                    </View>
                  )}
                  <View
                    style={[
                      styles.statusBadge,
                      { backgroundColor: student.isOnline ? "#2e9d63" : theme.textMuted },
                    ]}
                  />
                </TouchableOpacity>

                <Text style={styles.profileName}>{fullName}</Text>
                <AlumniBadge yearlvl={student.yearlvl} size="md" />
                <View style={styles.statusPill}>
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: student.isOnline ? "#2e9d63" : theme.textMuted },
                    ]}
                  />
                  <Text
                    style={[
                      styles.statusText,
                      { color: student.isOnline ? "#2e9d63" : theme.textMuted },
                    ]}
                  >
                    {student.isOnline ? "Online" : "Offline"}
                  </Text>
                </View>

                {viewer?.uid && contentOwnerId && viewer.uid !== contentOwnerId && (
                  <TouchableOpacity
                    style={styles.messageButton}
                    activeOpacity={0.82}
                    onPress={() => {
                      if (!viewer?.uid || !contentOwnerId) return;
                      try {
                        router.push({
                          pathname: "/(main)/DirectChatScreen" as any,
                          params: getDirectChatParams(viewer.uid, {
                            uid: contentOwnerId, displayName: fullName,
                            profileImage: student?.profileImage || student?.profilePic || null,
                            role: student?.role, studentID: student?.studentID,
                          }),
                        });
                      } catch (err) {
                        console.error("Failed to start chat from profile:", err);
                      }
                    }}
                  >
                    <Ionicons name="chatbubble-ellipses-outline" size={18} color={theme.onChrome} />
                    <Text style={styles.messageButtonText}>Message</Text>
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.section}>
                <View style={styles.sectionTitleRow}>
                  <Ionicons name="person" size={18} color={theme.primary} />
                  <Text style={styles.sectionTitle}>Personal Information</Text>
                </View>
                <View style={styles.goldCard}>
                  <InfoRow icon="person-outline" label="Full Name" value={fullName} />
                  <View style={styles.rowDivider} />
                  <InfoRow
                    icon="shield-checkmark-outline"
                    label="Role"
                    value={student.role ? student.role.charAt(0).toUpperCase() + student.role.slice(1) : "Member"}
                  />
                </View>
              </View>

              <View style={styles.section}>
                <View style={styles.sectionTitleRow}>
                  <Ionicons name="school" size={18} color={theme.primary} />
                  <Text style={styles.sectionTitle}>Academic Information</Text>
                </View>
                <View style={styles.goldCard}>
                  <InfoRow
                    icon="school-outline"
                    label="Course / Program"
                    value={student.course || "—"}
                  />
                  <View style={styles.rowDivider} />
                  <InfoRow
                    icon="trending-up-outline"
                    label="Year Level"
                    value={student.yearlvl || "—"}
                  />
                </View>
              </View>

              <View style={[styles.section, styles.activitySection]}>
                <View style={styles.activityHeader}>
                  <View style={styles.activityTitleGroup}>
                    <View style={styles.activityIconBox}>
                      <Ionicons name="newspaper-outline" size={18} color={theme.primary} />
                    </View>
                    <View>
                      <View style={styles.activityTitleRow}>
                        <Text style={styles.activityTitle}>Activity</Text>
                        <View style={styles.countBadge}>
                          <Text style={styles.countBadgeText}>{posts.length + polls.length}</Text>
                        </View>
                      </View>
                      <Text style={styles.activitySubtitle}>
                        Posts and polls shared on campus
                      </Text>
                    </View>
                  </View>

                  <View style={styles.filterControl}>
                    <TouchableOpacity
                      style={[styles.filterButton, contentFilterOpen && styles.filterButtonOpen]}
                      activeOpacity={0.82}
                      onPress={() => setContentFilterOpen((current) => !current)}
                      accessibilityRole="button"
                      accessibilityLabel="Filter profile activity"
                    >
                      <Ionicons
                        name={
                          contentFilter === "posts"
                            ? "document-text-outline"
                            : contentFilter === "polls"
                              ? "stats-chart-outline"
                              : "layers-outline"
                        }
                        size={15}
                        color={theme.primary}
                      />
                      <Text style={styles.filterButtonText}>
                        {contentFilter === "all"
                          ? "All"
                          : contentFilter === "posts"
                            ? "Posts"
                            : "Polls"}
                      </Text>
                      <Ionicons
                        name={contentFilterOpen ? "chevron-up" : "chevron-down"}
                        size={14}
                        color={theme.textMuted}
                      />
                    </TouchableOpacity>

                    {contentFilterOpen && (
                      <View style={styles.filterMenu}>
                        {(
                          [
                            {
                              id: "all",
                              label: "All activity",
                              icon: "layers-outline",
                              count: posts.length + polls.length,
                            },
                            {
                              id: "posts",
                              label: "Posts",
                              icon: "document-text-outline",
                              count: posts.length,
                            },
                            {
                              id: "polls",
                              label: "Polls",
                              icon: "stats-chart-outline",
                              count: polls.length,
                            },
                          ] as const
                        ).map((option) => {
                          const selected = contentFilter === option.id;
                          return (
                            <TouchableOpacity
                              key={option.id}
                              style={[
                                styles.filterMenuItem,
                                selected && styles.filterMenuItemActive,
                              ]}
                              onPress={() => {
                                setContentFilter(option.id);
                                setContentFilterOpen(false);
                              }}
                            >
                              <View style={styles.filterMenuItemCopy}>
                                <Ionicons
                                  name={option.icon}
                                  size={16}
                                  color={selected ? theme.primary : theme.textMuted}
                                />
                                <Text
                                  style={[
                                    styles.filterMenuItemText,
                                    selected && styles.filterMenuItemTextActive,
                                  ]}
                                >
                                  {option.label}
                                </Text>
                              </View>
                              <View
                                style={[
                                  styles.filterMenuCount,
                                  selected && styles.filterMenuCountActive,
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.filterMenuCountText,
                                    selected && styles.filterMenuCountTextActive,
                                  ]}
                                >
                                  {option.count}
                                </Text>
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}
                  </View>
                </View>
              </View>
            </>
          }
          ListEmptyComponent={
            <View style={styles.feedListInset}>
              {contentLoading ? (
                <FeedSkeleton count={3} />
              ) : (
                <View style={styles.emptyState}>
                  <View style={styles.emptyIconCircle}>
                    <Ionicons
                      name={
                        contentFilter === "posts"
                          ? "document-text-outline"
                          : contentFilter === "polls"
                            ? "stats-chart-outline"
                            : "newspaper-outline"
                      }
                      size={28}
                      color={theme.textMuted}
                    />
                  </View>
                  <Text style={styles.emptyStateTitle}>
                    {contentFilter === "all"
                      ? "No activity yet"
                      : contentFilter === "posts"
                        ? "No approved posts yet"
                        : "No approved polls yet"}
                  </Text>
                  <Text style={styles.emptyText}>
                    {contentFilter === "all"
                      ? "Approved posts and polls will appear here."
                      : `Switch to All to see other campus activity.`}
                  </Text>
                </View>
              )}
            </View>
          }
          ListFooterComponent={
            hasMoreFilteredContent && filteredProfileFeedItems.length > 0 ? (
              <View style={styles.feedListInset}>
                <TouchableOpacity
                  style={styles.loadMoreButton}
                  onPress={() => void handleLoadMoreContent()}
                  disabled={isLoadingMoreContent}
                >
                  {isLoadingMoreContent ? (
                    <ActivityIndicator size="small" color={theme.primary} />
                  ) : (
                    <>
                      <Ionicons name="chevron-down-circle-outline" size={17} color={theme.primary} />
                      <Text style={styles.loadMoreText}>
                        Load more {contentFilter === "all" ? "activity" : contentFilter}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            ) : null
          }
        />

        <ImageZoomViewer
          images={currentImages}
          startIndex={currentImageIndex}
          visible={imageViewerVisible}
          onClose={() => setImageViewerVisible(false)}
          showActions={false}
        />
      </View>

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmText={dialog?.confirmText ?? "Confirm"}
        cancelText={dialog?.cancelText}
        destructive={dialog?.destructive ?? true}
        singleAction={dialog?.singleAction ?? false}
        onConfirm={() => dialog?.onConfirm()}
        onCancel={() => setDialog(null)}
      />
    </SafeAreaView>
  );
};

const InfoRow = ({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) => {
  const { styles, theme } = useStyles();

  return (
    <View style={styles.infoRow}>
      <View style={styles.iconBox}>
        <Ionicons name={icon} size={18} color={theme.accent} />
      </View>
      <View style={styles.infoCopy}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value}</Text>
      </View>
    </View>
  );
};

export default UserProfileScreen;

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceSunken },
  contentShell: { flex: 1, backgroundColor: c.surfaceSunken },
  headerShell: {
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: 18,
    backgroundColor: c.primary,
    borderWidth: 1,
    borderColor: c.chromeBorder,
    shadowColor: c.textPrimary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
    elevation: 3,
  },
  headerRow: { flexDirection: "row", alignItems: "center" },
  headerBackButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,250,247,0.12)",
    borderWidth: 1,
    borderColor: "rgba(240,210,194,0.3)",
  },
  headerBackSpacer: { width: 38, height: 38 },
  headerCopy: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  headerTitle: {
    color: c.surface,
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: 0.5,
  },
  headerSubtext: {
    color: c.borderStrong,
    fontSize: 12,
    textAlign: "center",
    marginTop: 2,
  },
  scrollContent: { paddingBottom: 110 },
  loadingState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 24,
  },
  loadingText: { color: c.textMuted, fontSize: 14, fontWeight: "600" },
  errorText: { color: c.textMuted, fontSize: 16, fontWeight: "600" },
  profileCard: {
    alignItems: "center",
    backgroundColor: c.surface,
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 22,
    paddingVertical: 24,
    borderRadius: 24,
    borderWidth: 1,
    borderTopWidth: 3,
    borderColor: c.border,
    borderTopColor: c.accent,
    shadowColor: c.textPrimary,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.09,
    shadowRadius: 12,
    elevation: 3,
  },
  avatarWrapper: { position: "relative", marginBottom: 12 },
  profileImage: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 3,
    borderColor: c.accent,
  },
  placeholder: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
    justifyContent: "center",
    alignItems: "center",
  },
  statusBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: c.surface,
  },
  profileName: {
    color: c.textPrimary,
    fontSize: 23,
    fontWeight: "800",
    marginBottom: 10,
    textAlign: "center",
    letterSpacing: -0.2,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontWeight: "600" },
  messageButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.primary,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 22,
    marginTop: 14,
    gap: 8,
    shadowColor: c.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
    elevation: 4,
  },
  messageButtonText: {
    color: c.surfaceRaised,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  section: { marginHorizontal: 16, marginTop: 18 },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  sectionTitle: {
    color: c.primary,
    fontWeight: "700",
    fontSize: 14,
    letterSpacing: 0.5,
  },
  countBadge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 7,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 4,
  },
  countBadgeText: { color: c.primary, fontSize: 12, fontWeight: "800" },
  goldCard: {
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.borderStrong,
    paddingHorizontal: 14,
    paddingVertical: 4,
    shadowColor: c.textPrimary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 7,
    elevation: 2,
  },
  infoRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: c.surfaceSunken,
    justifyContent: "center",
    alignItems: "center",
  },
  infoCopy: { flex: 1, marginLeft: 12 },
  infoLabel: { color: c.textMuted, fontSize: 11, fontWeight: "600" },
  infoValue: {
    color: c.textPrimary,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 2,
  },
  rowDivider: { height: 1, backgroundColor: "rgba(224,165,61,0.20)" },
  activitySection: {
    position: "relative",
    zIndex: 5,
  },
  activityHeader: {
    position: "relative",
    zIndex: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 10,
  },
  activityTitleGroup: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  activityIconBox: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  activityTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  activityTitle: {
    color: c.textPrimary,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.1,
  },
  activitySubtitle: {
    color: c.textMuted,
    fontSize: 11.5,
    marginTop: 2,
  },
  filterControl: {
    position: "relative",
    zIndex: 30,
  },
  filterButton: {
    minWidth: 88,
    height: 38,
    paddingHorizontal: 11,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  filterButtonOpen: {
    borderColor: c.accent,
    backgroundColor: c.accentSoft,
  },
  filterButtonText: {
    color: c.primary,
    fontSize: 12,
    fontWeight: "800",
  },
  filterMenu: {
    position: "absolute",
    top: 44,
    right: 0,
    width: 178,
    padding: 6,
    borderRadius: 14,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: c.textPrimary,
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.16,
    shadowRadius: 12,
    elevation: 12,
    zIndex: 50,
  },
  filterMenuItem: {
    minHeight: 42,
    borderRadius: 10,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  filterMenuItemActive: {
    backgroundColor: c.accentSoft,
  },
  filterMenuItemCopy: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  filterMenuItemText: {
    color: c.textMuted,
    fontSize: 12.5,
    fontWeight: "700",
  },
  filterMenuItemTextActive: {
    color: c.primary,
    fontWeight: "800",
  },
  filterMenuCount: {
    minWidth: 24,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
  },
  filterMenuCountActive: {
    backgroundColor: c.accentSoft,
  },
  filterMenuCountText: {
    color: c.textMuted,
    fontSize: 10.5,
    fontWeight: "800",
  },
  filterMenuCountTextActive: {
    color: c.primary,
  },
  // Keeps the header (and its activity filter menu) drawn above the list.
  activityListHeader: {
    zIndex: 20,
  },
  feedListInset: {
    marginHorizontal: 16,
  },
  // Each post or poll draws its own part of the rounded card that groups the
  // activity list, since the list draws items one at a time.
  feedCardGroupItem: {
    marginHorizontal: 16,
    overflow: "hidden",
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  feedCardGroupItemFirst: {
    borderTopWidth: 1,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  feedCardGroupItemLast: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  emptyState: {
    minHeight: 138,
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: 24,
    paddingVertical: 22,
  },
  emptyIconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 2,
  },
  emptyStateTitle: {
    color: c.primary,
    fontSize: 14.5,
    fontWeight: "800",
    textAlign: "center",
  },
  emptyText: {
    color: c.textMuted,
    fontSize: 12.5,
    lineHeight: 18,
    fontWeight: "600",
    textAlign: "center",
  },
  loadMoreButton: {
    marginTop: 12,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    borderRadius: 14,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.accent,
  },
  loadMoreText: { fontWeight: "800", color: c.primary, fontSize: 12.5 },
  offlineStatusBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.accentSoft,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: c.borderStrong,
  },
  offlineStatusText: {
    fontSize: 12,
    color: c.warning,
    fontWeight: "600",
  },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

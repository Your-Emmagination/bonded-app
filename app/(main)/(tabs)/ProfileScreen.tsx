/* eslint-disable react-hooks/exhaustive-deps */
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { useAccountSetup } from "@/contexts/AccountSetupContext";
import { profileEmail } from "@/utils/profileSetup";
import { endPresenceSession } from "@/utils/presence";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import {
    User as FirebaseUser,
    signOut,
} from "firebase/auth";
import {
    collection,
    deleteDoc,
    doc,
    getDocs,
    limit,
    onSnapshot,
    orderBy,
    query,
    updateDoc,
    where,
} from "firebase/firestore";
import DropDownPicker from "react-native-dropdown-picker";
import CommentModal from "../components/CommentModal";
import ImageZoomViewer from "../components/ImageZoomViewer";
import PostCard from "../components/PostCard";
import { FeedSkeleton } from "../components/Skeleton";

import { AVATAR_SIZE_LARGE, avatarThumb } from "@/utils/cloudinaryImages";
import { useNetworkStatus } from "@/utils/networkUtils";
import {
    removeLikeNotification,
    upsertLikeNotification,
} from "@/utils/notifications";
import { getPendingPostLike, savePostLike, withViewerLike } from "@/utils/postLikes";
import {
    getCachedMyPosts,
    getCachedMyProfile,
    saveCachedMyPosts,
    saveCachedMyProfile,
} from "@/utils/offlineStorage";
import { getProfileIdLabel } from "@/utils/profileLabels";
import {
    isPushNotificationsSupported,
    unregisterDeviceForPushNotifications,
} from "@/utils/pushNotifications";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { subscribeTabScrollToTop } from "@/utils/tabScrollEvents";
import { Image } from "expo-image";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    BackHandler,
    FlatList,
    Linking,
    Modal,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";
import ConfirmDialog, {
    type ConfirmDialogVariant,
} from "../components/ConfirmDialog";

type Student = {
  firstname?: string;
  lastname?: string;
  course?: string;
  yearlvl?: string;
  studentID?: string;
  email?: string;
  profileImage?: string;
  isOnline?: boolean;
  activeStatusEnabled?: boolean;
  role?: string;
  recoveryEmail?: string;
  recoveryEmailVerified?: boolean;
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
};

type PostSortOption = "newest" | "oldest" | "mostLiked" | "mostCommented";

const POST_SORT_OPTIONS: { key: PostSortOption; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "mostLiked", label: "Most liked" },
  { key: "mostCommented", label: "Most commented" },
];

const PROFILE_RETURN_ROUTE = "/(main)/(tabs)/ProfileScreen";

// How many of the user's own posts to load per page. Matches UserProfileScreen's
// PAGE_SIZE so both profile screens paginate post history the same way. The
// query keeps its live onSnapshot but is now bounded and grown by "Load more"
// (same limit-grow pattern as ManageModerationScreen), instead of streaming a
// year's worth of posts on every visit.
const MY_POSTS_PAGE_SIZE = 20;

const isSameCalendarDay = (timestamp: any, target: Date): boolean => {
  if (!timestamp || typeof timestamp.toDate !== "function") return false;
  const date = timestamp.toDate();
  return (
    date.getFullYear() === target.getFullYear() &&
    date.getMonth() === target.getMonth() &&
    date.getDate() === target.getDate()
  );
};

// A post's own document has no field indicating it's still awaiting
// review — that's what moderationStatus tracks. Approved (or legacy posts
// with no moderationStatus at all) are the only ones visible here, same
// rule Home and Saved Posts already use.
const isApprovedPost = (post: Post): boolean => {
  const status = post.moderationStatus;
  return !status || status === "approved";
};

const ProfileScreen = () => {
  const { styles, theme } = useStyles();
  // Includes the private record (personal email, recovery details).
  const { profileId: accountProfileId, profile: accountProfile } = useAccountSetup();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string | string[] }>();
  const { isOffline } = useNetworkStatus();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  const [profileImage, setProfileImage] = useState<string>();
  const [viewImageVisible, setViewImageVisible] = useState(false);

  // Single dialog state used to render every alert on this screen through
  // the app's branded ConfirmDialog instead of the bare native Alert.alert.
  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    variant?: ConfirmDialogVariant;
    singleAction?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const showInfo = (title: string, description?: string, onConfirm?: () => void) => {
    const t = title.toLowerCase();
    const variant: ConfirmDialogVariant = /success|updated|verified|changed|saved/.test(t)
      ? "success"
      : /error|failed|unable/.test(t)
        ? "destructive"
        : /validation|required|invalid|weak|same/.test(t)
          ? "warning"
          : "info";
    setDialog({
      title,
      description,
      variant,
      destructive: false,
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

  const myPostsListRef = useRef<FlatList<Post>>(null);

  // Tapping the Profile tab while it's already open scrolls back to the top.
  useEffect(() => {
    const subscription = subscribeTabScrollToTop("ProfileScreen", () => {
      myPostsListRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
    return () => subscription.remove();
  }, []);

  const router = useRouter();
  const navigation = useNavigation();
  const resolvedReturnTo = Array.isArray(returnTo) ? returnTo[0] : returnTo;
  const canNavigateBack = navigation.canGoBack() || !!resolvedReturnTo;

  // ─── My Posts ─────────────────────────────────────────────────────────
  // Live, so a role change is reflected without reopening the screen.
  const currentUserRole = useCurrentUserRole();
  const [myPosts, setMyPosts] = useState<Post[]>([]);
  const [myPostsLoading, setMyPostsLoading] = useState(true);
  // Fix 4: bounded, "Load more"-grown page size for the own-posts query.
  const [myPostsLimit, setMyPostsLimit] = useState(MY_POSTS_PAGE_SIZE);
  const [hasMoreMyPosts, setHasMoreMyPosts] = useState(true);
  const [loadingMoreMyPosts, setLoadingMoreMyPosts] = useState(false);
  const [postSearchQuery, setPostSearchQuery] = useState("");
  const [postSortOption, setPostSortOption] = useState<PostSortOption>("newest");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [selectedDateFilter, setSelectedDateFilter] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [commentModalPostId, setCommentModalPostId] = useState<string | null>(null);
  const [postImageViewerVisible, setPostImageViewerVisible] = useState(false);
  const [postImages, setPostImages] = useState<string[]>([]);
  const [postImageIndex, setPostImageIndex] = useState(0);
  const [postImageViewerPostId, setPostImageViewerPostId] = useState<string | null>(null);
  const relativeTimeNow = useRelativeTimeNow();

  const imageUri = useMemo(
    () => profileImage ?? student?.profileImage,
    [profileImage, student?.profileImage],
  );
  const fullName = useMemo(
    () =>
      `${student?.firstname ?? ""} ${student?.lastname ?? ""}`.trim() ||
      "Anonymous",
    [student?.firstname, student?.lastname],
  );
  const studentIdDisplay = useMemo(
    () => student?.studentID ?? user?.email?.split("@")[0] ?? "—",
    [student?.studentID, user?.email],
  );

  const profileIdLabel = useMemo(
    () => getProfileIdLabel(student?.role),
    [student?.role],
  );

  // Live listener on the signed-in user's own posts. realUserId is always
  // set to the true auth uid on creation (even for anonymous posts), so a
  // single query covers both anonymous and regular posts. Bounded to
  // myPostsLimit (grown by "Load more") so an active user's whole post
  // history isn't streamed on every visit — needs the existing
  // posts(realUserId ASC, createdAt DESC) composite index.
  useEffect(() => {
    if (!user?.uid) {
      setMyPosts([]);
      setMyPostsLoading(false);
      return;
    }

    getCachedMyPosts<Post>(user.uid).then((cached) => {
      if (cached && cached.length > 0) {
        setMyPosts(cached);
        setMyPostsLoading(false);
      }
    });

    setMyPostsLoading(true);
    const q = query(
      collection(db, "posts"),
      where("realUserId", "==", user.uid),
      orderBy("createdAt", "desc"),
      limit(myPostsLimit),
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const nextPosts = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() } as Post));
        setMyPosts(nextPosts);
        saveCachedMyPosts(user.uid, nextPosts);
        setHasMoreMyPosts(snapshot.size === myPostsLimit);
        setMyPostsLoading(false);
        setLoadingMoreMyPosts(false);
      },
      (error) => {
        console.error("Error loading your posts:", error);
        setMyPostsLoading(false);
        setLoadingMoreMyPosts(false);
      },
    );
    return unsubscribe;
  }, [user?.uid, myPostsLimit]);

  const loadMoreMyPosts = useCallback(() => {
    if (loadingMoreMyPosts || !hasMoreMyPosts) return;
    setLoadingMoreMyPosts(true);
    setMyPostsLimit((current) => current + MY_POSTS_PAGE_SIZE);
  }, [hasMoreMyPosts, loadingMoreMyPosts]);

  const approvedMyPosts = useMemo(() => myPosts.filter(isApprovedPost), [myPosts]);

  const visiblePosts = useMemo(() => {
    const trimmedQuery = postSearchQuery.trim().toLowerCase();

    const filtered = approvedMyPosts.filter((post) => {
      if (trimmedQuery && !post.content?.toLowerCase().includes(trimmedQuery)) {
        return false;
      }
      if (selectedDateFilter && !isSameCalendarDay(post.createdAt, selectedDateFilter)) {
        return false;
      }
      return true;
    });

    const getMillis = (timestamp: any) =>
      timestamp && typeof timestamp.toMillis === "function" ? timestamp.toMillis() : 0;

    const sorted = [...filtered];
    switch (postSortOption) {
      case "oldest":
        sorted.sort((a, b) => getMillis(a.createdAt) - getMillis(b.createdAt));
        break;
      case "mostLiked":
        sorted.sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0));
        break;
      case "mostCommented":
        sorted.sort((a, b) => (b.commentCount ?? 0) - (a.commentCount ?? 0));
        break;
      case "newest":
      default:
        sorted.sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt));
        break;
    }
    return sorted;
  }, [approvedMyPosts, postSearchQuery, postSortOption, selectedDateFilter]);

  const getTimeAgo = useCallback(
    (timestamp: any) => {
      if (!timestamp || typeof timestamp.toDate !== "function") return "";
      const now = new Date(relativeTimeNow);
      const postDate = timestamp.toDate();
      const diffMs = now.getTime() - postDate.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHour = Math.floor(diffMin / 60);

      if (diffSec < 60) return "Just now";
      if (diffMin < 60) return `${diffMin}m`;
      if (isSameCalendarDay(timestamp, now)) return `${diffHour}h`;

      const timePart = postDate.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });

      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (isSameCalendarDay(timestamp, yesterday)) {
        return `Yesterday at ${timePart}`;
      }

      const datePart = postDate.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      });

      if (postDate.getFullYear() === now.getFullYear()) {
        return `${datePart} at ${timePart}`;
      }

      return `${datePart}, ${postDate.getFullYear()}`;
    },
    [relativeTimeNow],
  );

  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;

    const unsubscribeAuth = auth.onAuthStateChanged((currentUser) => {
      setUser(currentUser);

      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }

      if (currentUser) {
        const email = currentUser.email ?? "";
        const studentID = accountProfileId || email.split("@")[0] || currentUser.uid;

        getCachedMyProfile<Student>(currentUser.uid).then((cached) => {
          if (cached) {
            setStudent(cached);
            setProfileImage(cached.profileImage);
          }
        });

        unsubscribeProfile = onSnapshot(
          doc(db, "students", studentID),
          (docSnapshot) => {
            if (docSnapshot.exists()) {
              const data = docSnapshot.data() as Student;
              setStudent(data);
              saveCachedMyProfile(currentUser.uid, data);
              setProfileImage(data.profileImage);
            }
          },
          (error) => {
            if (auth.currentUser) {
              console.error("Error listening to profile:", error);
            }
          },
        );
      } else {
        setStudent(null);
        setProfileImage(undefined);
      }
    });

    return () => {
      if (unsubscribeProfile) unsubscribeProfile();
      unsubscribeAuth();
    };
  }, [accountProfileId]);

  // ─── My Posts: handlers ─────────────────────────────────────────────
  const deleteCommentTree = useCallback(async (parentId: string) => {
    const commentsSnapshot = await getDocs(
      query(collection(db, "comments"), where("postId", "==", parentId)),
    );
    await Promise.all(
      commentsSnapshot.docs.map(async (commentDoc) => {
        const repliesSnapshot = await getDocs(
          query(collection(db, "replies"), where("commentId", "==", commentDoc.id)),
        );
        await Promise.all(repliesSnapshot.docs.map((replyDoc) => deleteDoc(replyDoc.ref)));
        await deleteDoc(commentDoc.ref);
      }),
    );
  }, []);

  const handleLike = useCallback(
    (postId: string, currentLikedBy: string[] = []) => {
      if (!user) return;
      if (isOffline) {
        showInfo("Offline", "You are currently offline. Liking posts is unavailable.");
        return;
      }

      const uid = user.uid;
      const liked = !(getPendingPostLike(postId) ?? currentLikedBy.includes(uid));
      const showLike = (value: boolean) =>
        setMyPosts((previous) =>
          previous.map((item) =>
            item.id === postId ? withViewerLike(item, uid, value) : item,
          ),
        );

      // Show the like right away; savePostLike writes it in the background.
      showLike(liked);

      const post = myPosts.find((p) => p.id === postId);
      const postOwnerId = post?.realUserId || post?.userId;
      const actorName = user.displayName || user.email?.split("@")[0] || "Someone";

      void savePostLike({
        postId,
        uid,
        liked,
        onChanged: (nowLiked) => {
          const logError = (error: unknown) =>
            console.error("Error syncing like notification:", error);
          if (nowLiked) {
            upsertLikeNotification({
              recipientId: postOwnerId,
              actor: { id: uid, name: actorName, profileImage: null },
              entityType: "post",
              entityId: postId,
              preview: post?.content,
            }).catch(logError);
          } else {
            removeLikeNotification({
              recipientId: postOwnerId,
              actorId: uid,
              entityType: "post",
              entityId: postId,
            }).catch(logError);
          }
        },
        onFailed: (savedLiked, error) => {
          console.error("Error liking post:", error);
          showLike(savedLiked);
          showInfo("Error", "Failed to update the like.");
        },
      });
    },
    [isOffline, myPosts, user],
  );

  const handleEditPost = useCallback(
    (postId: string) => {
      if (isOffline) {
        showInfo("Offline", "You are currently offline. Editing posts is unavailable.");
        return;
      }
      router.push({ pathname: "/CreatePostScreen", params: { editPostId: postId } });
    },
    [isOffline, router],
  );

  const handleDeletePost = useCallback(
    (postId: string) => {
      if (isOffline) {
        showInfo("Offline", "You are currently offline. Deleting posts is unavailable.");
        return;
      }
      showConfirm({
        title: "Delete Post",
        description: "This will permanently remove the post, comments, and replies.",
        confirmText: "Delete",
        cancelText: "Cancel",
        destructive: true,
        onConfirm: async () => {
          try {
            await deleteCommentTree(postId);
            await deleteDoc(doc(db, "posts", postId));
          } catch (error) {
            console.error("Error deleting post:", error);
            showInfo("Error", "Failed to delete post.");
          }
        },
      });
    },
    [deleteCommentTree],
  );

  const openPostImageViewer = useCallback(
    (images: string[], startIndex: number, postId?: string) => {
      setPostImages(images);
      setPostImageIndex(startIndex);
      setPostImageViewerPostId(postId ?? null);
      setPostImageViewerVisible(true);
    },
    [],
  );

  const handlePostFilePress = useCallback(
    (url: string, mimeType: string) => {
      if (mimeType.startsWith("image/")) {
        openPostImageViewer([url], 0);
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
    [openPostImageViewer],
  );

  const handlePostProfileClick = useCallback(
    (targetId?: string) => {
      if (!targetId || targetId === user?.uid) return; // already on own profile
      router.push(
        buildUserProfileHref({ userId: targetId, returnTo: PROFILE_RETURN_ROUTE }) as any,
      );
    },
    [router, user?.uid],
  );

  const handlePostTagClick = useCallback(
    (taggedUserId: string) => {
      if (taggedUserId === user?.uid) return;
      router.push(
        buildUserProfileHref({ userId: taggedUserId, returnTo: PROFILE_RETURN_ROUTE }) as any,
      );
    },
    [router, user?.uid],
  );

  const handleCommentPress = useCallback((postId: string) => {
    setCommentModalPostId(postId);
  }, []);

  // The My Posts list only draws the posts near the screen.
  const myPostsListData = useMemo<Post[]>(
    () => (myPostsLoading ? [] : visiblePosts),
    [myPostsLoading, visiblePosts],
  );

  const renderMyPost = useCallback(
    ({ item: post }: { item: Post }) => (
      <View style={styles.myPostsListInset}>
        <PostCard
          post={post as any}
          isLiked={post.likedBy?.includes(user?.uid || "") || false}
          currentUserRole={currentUserRole}
          currentUserId={user?.uid}
          onLike={handleLike}
          onProfileClick={handlePostProfileClick}
          onTagClick={handlePostTagClick}
          onImagePress={openPostImageViewer}
          onFilePress={handlePostFilePress}
          getTimeAgo={getTimeAgo}
          onCommentPress={handleCommentPress}
          onEdit={handleEditPost}
          onDelete={handleDeletePost}
        />
      </View>
    ),
    [
      currentUserRole,
      getTimeAgo,
      handleCommentPress,
      handleDeletePost,
      handleEditPost,
      handleLike,
      handlePostFilePress,
      handlePostProfileClick,
      handlePostTagClick,
      openPostImageViewer,
      user?.uid,
    ],
  );

  const postImageViewerPost = postImageViewerPostId
    ? myPosts.find((p) => p.id === postImageViewerPostId)
    : undefined;

  const handleDateFilterChange = useCallback((_event: any, date?: Date) => {
    setShowDatePicker(Platform.OS === "ios");
    if (date) setSelectedDateFilter(date);
  }, []);

  const updateStudent = useCallback(
    async (data: Partial<Student>) => {
      if (!student?.studentID || !auth.currentUser) return;
      if (isOffline) {
        showInfo("Offline", "You are currently offline. Changes cannot be saved until you reconnect.");
        return;
      }

      try {
        const payload: Record<string, any> = { ...data };
        if (
          payload.email?.endsWith("@student.csap") ||
          payload.email?.endsWith("@teacher.csap") ||
          payload.email?.endsWith("@admin.csap")
        ) {
          delete payload.email;
        }

        // App-wide search: keep the lowercased name fields in step with any
        // first/last name edit so the profile stays findable.
        if (typeof payload.firstname === "string") {
          payload.firstnameLower = payload.firstname.trim().toLowerCase();
        }
        if (typeof payload.lastname === "string") {
          payload.lastnameLower = payload.lastname.trim().toLowerCase();
        }

        await updateDoc(doc(db, "students", student.studentID), payload);
        if (auth.currentUser?.uid && auth.currentUser.uid !== student.studentID) {
          updateDoc(doc(db, "students", auth.currentUser.uid), payload).catch(() => {});
        }
        setStudent((prev) => (prev ? { ...prev, ...payload } : prev));
      } catch (error) {
        console.error("Error updating student:", error);
        throw error;
      }
    },
    [isOffline, student?.studentID],
  );

  const toggleOnlineStatus = useCallback(async () => {
    if (!student || !auth.currentUser) return;
    if (isOffline) {
      showInfo("Offline", "You are currently offline. Status cannot be changed.");
      return;
    }
    const newStatus = student.activeStatusEnabled === false;

    try {
      await updateStudent({ activeStatusEnabled: newStatus, isOnline: newStatus });
    } catch {
      showInfo("Error", "Failed to update status");
    }
  }, [isOffline, student, updateStudent]);

  const performLogout = useCallback(async () => {
    try {
      await endPresenceSession();

      // While request.auth.uid still matches the userPushTokens doc id — the
      // only window the rule allows the write. Detaching the device here is
      // what stops this account's notifications from ringing on the phone
      // once someone else signs in. A failure must never strand the user in a
      // half-logged-out state, so it is caught rather than awaited to throw.
      const signedInUser = auth.currentUser;
      if (signedInUser && isPushNotificationsSupported()) {
        await unregisterDeviceForPushNotifications(signedInUser).catch(
          (error) => {
            console.error("Push unregister on logout failed:", error);
          },
        );
      }

      await signOut(auth);

      if (Platform.OS === "web") {
        window.location.replace("/LoginScreen");
      } else {
        router.replace("/LoginScreen");
      }
    } catch (e: any) {
      console.error("Logout failed:", e);
      if (Platform.OS !== "web") {
        showInfo("Error", "Failed to log out. Please try again.");
      } else {
        alert("Failed to log out: " + (e.message || "Unknown error"));
      }
    }
  }, [user, router]);

  const handleLogout = useCallback(() => {
    if (Platform.OS === "web") {
      // window.confirm is a browser-native dialog, distinct from React
      // Native's Alert.alert — left as-is; ConfirmDialog is an RN component
      // and this branch only runs on web.
      if (window.confirm("Are you sure you want to log out?")) {
        performLogout();
      }
      return;
    }

    showConfirm({
      title: "Log Out",
      description: "Are you sure you want to log out?",
      confirmText: "Log Out",
      cancelText: "Cancel",
      destructive: true,
      onConfirm: performLogout,
    });
  }, [performLogout]);

  // Editing lives in its own screen now, opened from Settings. Your avatar
  // stays a shortcut to the photo tab, since that is where people reach for
  // it on their own profile.
  const openPhotoEditor = useCallback(() => {
    router.push({ pathname: "/(main)/EditProfileScreen", params: { tab: "photo" } } as any);
  }, [router]);

  const openImageViewer = useCallback(() => {
    if (imageUri) {
      setViewImageVisible(true);
    } else {
      openPhotoEditor();
    }
  }, [imageUri, openPhotoEditor]);

  const handleScreenBack = useCallback(() => {
    if (viewImageVisible) {
      setViewImageVisible(false);
      return true;
    }

    if (navigation.canGoBack()) {
      navigation.goBack();
      return true;
    }

    if (resolvedReturnTo) {
      router.replace(resolvedReturnTo as any);
      return true;
    }

    return false;
  }, [
    navigation,
    resolvedReturnTo,
    router,
    viewImageVisible,
  ]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        handleScreenBack,
      );

      return () => subscription.remove();
    }, [handleScreenBack]),
  );

  const displayEmail = profileEmail({
    email: accountProfile?.email ?? student?.email,
    recoveryEmail: accountProfile?.recoveryEmail ?? student?.recoveryEmail,
  }) || "No email added";

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
        {/* Header Block */}
        <View style={styles.headerShell}>
          <View style={styles.headerRow}>
            {canNavigateBack ? (
              <TouchableOpacity
                style={styles.headerBackButton}
                onPress={() => {
                  void handleScreenBack();
                }}
                activeOpacity={0.7}
              >
                <Ionicons name="arrow-back" size={20} color={theme.onChrome} />
              </TouchableOpacity>
            ) : (
              <View style={styles.headerBackSpacer} />
            )}

            <View style={styles.headerCopy}>
              <Text style={styles.header}>Profile</Text>
              <Text style={styles.headerSubtext}>
                Manage your account, status, and photo
              </Text>
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

        {/* Only the posts near the screen are drawn. */}
        <FlatList
          ref={myPostsListRef}
          data={myPostsListData}
          keyExtractor={(post) => post.id}
          renderItem={renderMyPost}
          contentContainerStyle={styles.scroll}
          // Comments and replies open from inside these cards, and React Native
          // still counts this list as their parent for taps: left at "never",
          // the first tap on Send only closed the keyboard.
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={7}
          ListHeaderComponent={
            <>
              {/* Profile Header Card */}
              <View style={styles.profileCard}>
                <TouchableOpacity
                  onPress={openImageViewer}
                  onLongPress={openPhotoEditor}
                  activeOpacity={0.88}
                  style={styles.avatarWrapper}
                >
                  {imageUri ? (
                    <Image source={{ uri: avatarThumb(imageUri, AVATAR_SIZE_LARGE) }} style={styles.profileImage} />
                  ) : (
                    <View style={styles.placeholder}>
                      <Ionicons name="person" size={48} color={theme.accent} />
                    </View>
                  )}
                  <View style={styles.editBadge}>
                    <Ionicons name="camera" size={14} color={theme.onAccent} />
                  </View>
                  <View
                    style={[
                      styles.statusBadge,
                      { backgroundColor: student?.isOnline ? "#00e676" : theme.textMuted },
                    ]}
                  />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.statusBtn}
                  onPress={toggleOnlineStatus}
                  activeOpacity={0.75}
                >
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: student?.isOnline ? "#00e676" : theme.textMuted },
                    ]}
                  />
                  <Text
                    style={{
                      color: student?.isOnline ? "#00e676" : theme.textMuted,
                      fontWeight: "600",
                    }}
                  >
                    {student?.isOnline ? "Online" : "Offline"}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Grouped Personal Information Card */}
    <View style={styles.section}>
      <View style={styles.sectionTitleRow}>
        <Ionicons name="person" size={18} color={theme.primary} />
        <Text style={styles.sectionTitle}>Personal Information</Text>
      </View>
      <View style={styles.goldCard}>
        <CardItemRow
          icon="person-outline"
          label="Full Name"
          value={fullName}
          isLocked={true}
        />
        <View style={styles.rowDivider} />
        {/* No lock, no chevron — edited cleanly via Edit Profile button */}
        <CardItemRow
          icon="mail-outline"
          label="Email Address"
          value={displayEmail}
          isLocked={false}
        />
      </View>
    </View>

    {/* Grouped Academic Information Card */}
    <View style={styles.section}>
      <View style={styles.sectionTitleRow}>
        <Ionicons name="school" size={18} color={theme.primary} />
        <Text style={styles.sectionTitle}>Academic Information</Text>
      </View>
      <View style={styles.goldCard}>
        <CardItemRow
          icon="school-outline"
          label="Course / Program"
          value={student?.course ?? "—"}
          isLocked={true}
        />
        <View style={styles.rowDivider} />
        {/* Locked: Year level auto-increments or managed by admin */}
        <CardItemRow
          icon="trending-up-outline"
          label="Year Level"
          value={student?.yearlvl ?? "—"}
          isLocked={true}
        />
        <View style={styles.rowDivider} />
        <CardItemRow
          icon="card-outline"
          label={profileIdLabel}
          value={studentIdDisplay}
          isLocked={true}
        />
      </View>
    </View>

              {/* Actions Section */}
              <View style={styles.section}>
                <ActionButton
                  icon="bookmark-outline"
                  text="Saved Posts"
                  onPress={() => router.push("/(main)/BookmarksScreen" as any)}
                />
                <ActionButton
                  icon="settings-outline"
                  text="Settings"
                  onPress={() => router.push("/(main)/SettingsScreen" as any)}
                />
                <ActionButton
                  icon="log-out-outline"
                  text="Log Out"
                  onPress={handleLogout}
                />
              </View>

              {/* My Posts Section */}
              <View style={styles.section}>
                <View style={styles.sectionTitleRow}>
                  <Ionicons name="grid-outline" size={18} color={theme.primary} />
                  <Text style={styles.sectionTitle}>My Posts</Text>
                </View>

                {/* Toolbar: search, sort, date filter */}
                <View style={styles.postsToolbar}>
                  <View style={styles.searchBar}>
                    <Ionicons name="search-outline" size={16} color={theme.textMuted} />
                    <TextInput
                      style={styles.searchInput}
                      placeholder="Search your posts"
                      placeholderTextColor={theme.textMuted}
                      value={postSearchQuery}
                      onChangeText={setPostSearchQuery}
                      returnKeyType="search"
                    />
                    {postSearchQuery.length > 0 && (
                      <TouchableOpacity onPress={() => setPostSearchQuery("")}>
                        <Ionicons name="close-circle" size={16} color={theme.textMuted} />
                      </TouchableOpacity>
                    )}
                  </View>

                  <View style={styles.toolbarRow}>
                    <TouchableOpacity
                      style={styles.toolbarChip}
                      onPress={() => setShowSortMenu(true)}
                      activeOpacity={0.75}
                    >
                      <Ionicons name="swap-vertical-outline" size={14} color={theme.primary} />
                      <Text style={styles.toolbarChipText}>
                        {POST_SORT_OPTIONS.find((o) => o.key === postSortOption)?.label}
                      </Text>
                      <Ionicons name="chevron-down" size={14} color={theme.primary} />
                    </TouchableOpacity>

                    {selectedDateFilter ? (
                      <View style={[styles.toolbarChip, styles.toolbarChipActive]}>
                        <Ionicons name="calendar-outline" size={14} color={theme.onPrimary} />
                        <Text style={[styles.toolbarChipText, styles.toolbarChipTextActive]}>
                          {selectedDateFilter.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })}
                        </Text>
                        <TouchableOpacity onPress={() => setSelectedDateFilter(null)}>
                          <Ionicons name="close" size={14} color={theme.onPrimary} />
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <TouchableOpacity
                        style={styles.toolbarChip}
                        onPress={() => setShowDatePicker(true)}
                        activeOpacity={0.75}
                      >
                        <Ionicons name="calendar-outline" size={14} color={theme.primary} />
                        <Text style={styles.toolbarChipText}>Date</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                {showDatePicker && (
                  <DateTimePicker
                    value={selectedDateFilter ?? new Date()}
                    mode="date"
                    display="default"
                    maximumDate={new Date()}
                    onChange={handleDateFilterChange}
                  />
                )}
              </View>
            </>
          }
          ListEmptyComponent={
            <View style={styles.myPostsListInset}>
              {myPostsLoading ? (
                <FeedSkeleton count={3} />
              ) : myPosts.length === 0 ? (
                <View style={styles.postsEmptyState}>
                  <Ionicons name="albums-outline" size={32} color={theme.textMuted} />
                  <Text style={styles.postsEmptyTitle}>You haven't posted anything yet</Text>
                </View>
              ) : approvedMyPosts.length === 0 ? (
                <View style={styles.postsEmptyState}>
                  <Ionicons name="time-outline" size={32} color={theme.textMuted} />
                  <Text style={styles.postsEmptyTitle}>
                    Your post{myPosts.length > 1 ? "s are" : " is"} awaiting moderator review
                  </Text>
                </View>
              ) : (
                <View style={styles.postsEmptyState}>
                  <Ionicons name="search-outline" size={32} color={theme.textMuted} />
                  <Text style={styles.postsEmptyTitle}>No posts match your filters</Text>
                  <TouchableOpacity
                    onPress={() => {
                      setPostSearchQuery("");
                      setSelectedDateFilter(null);
                    }}
                  >
                    <Text style={styles.postsClearFiltersText}>Clear filters</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          }
          ListFooterComponent={
            // Fix 4: page through post history instead of streaming all of it.
            !myPostsLoading && myPosts.length > 0 && hasMoreMyPosts ? (
              <View style={styles.myPostsListInset}>
                <TouchableOpacity
                  style={styles.loadMoreButton}
                  onPress={loadMoreMyPosts}
                  disabled={loadingMoreMyPosts}
                  activeOpacity={0.85}
                >
                  {loadingMoreMyPosts ? (
                    <ActivityIndicator size="small" color={theme.primary} />
                  ) : (
                    <>
                      <Ionicons name="chevron-down-circle-outline" size={17} color={theme.primary} />
                      <Text style={styles.loadMoreButtonText}>Load more</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            ) : null
          }
        />
      </View>

      {/* Sort options menu */}
      <Modal
        visible={showSortMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSortMenu(false)}
      >
        <TouchableOpacity
          style={styles.sortMenuBackdrop}
          activeOpacity={1}
          onPress={() => setShowSortMenu(false)}
        >
          <View style={styles.sortMenuCard}>
            {POST_SORT_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.key}
                style={styles.sortMenuOption}
                onPress={() => {
                  setPostSortOption(option.key);
                  setShowSortMenu(false);
                }}
              >
                <Text
                  style={[
                    styles.sortMenuOptionText,
                    postSortOption === option.key && styles.sortMenuOptionTextActive,
                  ]}
                >
                  {option.label}
                </Text>
                {postSortOption === option.key && (
                  <Ionicons name="checkmark" size={16} color={theme.success} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Comment Modal for My Posts */}
      {commentModalPostId && user?.uid && (
        <CommentModal
          visible={true}
          onClose={() => setCommentModalPostId(null)}
          postId={commentModalPostId}
          currentUserId={user.uid}
          currentUserRole={currentUserRole}
        />
      )}

      {/* Image Viewer for My Posts */}
      <ImageZoomViewer
        images={postImages}
        startIndex={postImageIndex}
        visible={postImageViewerVisible}
        onClose={() => setPostImageViewerVisible(false)}
        showActions={!!postImageViewerPost}
        likesCount={postImageViewerPost?.likeCount ?? 0}
        commentsCount={postImageViewerPost?.commentCount ?? 0}
        isLiked={postImageViewerPost?.likedBy?.includes(user?.uid || "") || false}
        onLike={() => {
          if (postImageViewerPost) {
            handleLike(postImageViewerPost.id, postImageViewerPost.likedBy || []);
          }
        }}
        onComment={() => {
          if (postImageViewerPost) {
            setPostImageViewerVisible(false);
            setCommentModalPostId(postImageViewerPost.id);
          }
        }}
      />

      {/* Edit Modal */}
      {/* Full Image Viewer Modal */}
      <ImageZoomViewer
        images={imageUri ? [imageUri] : []}
        startIndex={0}
        visible={viewImageVisible}
        onClose={() => setViewImageVisible(false)}
        showActions={false}
      />

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmText={dialog?.confirmText ?? "Confirm"}
        cancelText={dialog?.cancelText}
        destructive={dialog?.destructive ?? true}
        variant={dialog?.variant}
        singleAction={dialog?.singleAction ?? false}
        onConfirm={() => dialog?.onConfirm()}
        onCancel={() => setDialog(null)}
      />
    </SafeAreaView>
  );
};

// Updated CardItemRow Component
const CardItemRow = React.memo(
  ({
    icon,
    label,
    value,
    isLocked,
  }: {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    value: string;
    isLocked?: boolean;
  }) => {
    const { styles, theme } = useStyles();

    return (
      <View style={styles.cardItemRow}>
        <View style={styles.iconBox}>
          <Ionicons name={icon} size={18} color={theme.primary} />
        </View>
        <View style={{ marginLeft: 12, flex: 1 }}>
          <Text style={styles.infoLabel}>{label}</Text>
          <Text style={styles.infoValue}>{value}</Text>
        </View>
        {/* Shows lock if read-only/admin managed, nothing if editable via Edit Profile */}
        {isLocked && (
          <Ionicons
            name="lock-closed"
            size={16}
            color={theme.accent}
            style={{ marginLeft: 8 }}
          />
        )}
      </View>
    );
  },
);

const ActionButton = React.memo(
  ({
    icon,
    text,
    onPress,
  }: {
    icon: keyof typeof Ionicons.glyphMap;
    text: string;
    onPress: () => void;
  }) => {
    const { styles, theme } = useStyles();

    return (
      <TouchableOpacity
        style={styles.actionButton}
        onPress={onPress}
        activeOpacity={0.75}
      >
        <Ionicons name={icon} size={20} color={theme.accent} />
        <Text style={styles.actionText}>{text}</Text>
        <Ionicons
          name="chevron-forward"
          size={18}
          color={theme.textMuted}
          style={{ marginLeft: "auto" }}
        />
      </TouchableOpacity>
    );
  },
);
type YearLevelDropdownProps = {
  value: string;
  onChange: (val: string) => void;
};

const YearLevelDropdown: React.FC<YearLevelDropdownProps> = React.memo(
  ({ value, onChange }) => {
    const { styles } = useStyles();
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState([
      { label: "1st Year", value: "1st Year" },
      { label: "2nd Year", value: "2nd Year" },
      { label: "3rd Year", value: "3rd Year" },
      { label: "4th Year", value: "4th Year" },
      { label: "Graduate", value: "Graduate" },
    ]);

    return (
      <View style={{ zIndex: 1000, marginBottom: 12 }}>
        <DropDownPicker
          open={open}
          value={value}
          items={items}
          setOpen={setOpen}
          setValue={(callback) => {
            const newVal = callback(value);
            onChange(newVal);
          }}
          setItems={setItems}
          placeholder="Select Year Level"
          placeholderStyle={styles.placeholderStyle}
          style={styles.dropdown}
          dropDownContainerStyle={styles.dropdownContainer}
          textStyle={styles.dropdownText}
          arrowIconStyle={styles.arrowIcon}
          tickIconStyle={styles.tickIcon}
          listItemContainerStyle={styles.listItemContainer}
          listItemLabelStyle={styles.listItemLabel}
        />
      </View>
    );
  },
);

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceSunken },
  contentShell: { flex: 1, backgroundColor: c.surfaceSunken },
  headerShell: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 20,
    backgroundColor: c.chrome,
    borderWidth: 1,
    borderColor: c.textSecondary,

    shadowColor: c.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
  },
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
  headerBackSpacer: {
    width: 38,
    height: 38,
  },
  headerCopy: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  header: {
    color: c.onChrome,
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: 0.5,
  },
  headerSubtext: {
    color: c.onChromeMuted,
    fontSize: 12,
    textAlign: "center",
    marginTop: 2,
  },
  scroll: { paddingBottom: 60 },
  profileCard: {
    alignItems: "center",
    backgroundColor: c.chrome,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 24,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: c.accent,

    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 5,
  },
  avatarWrapper: {
    position: "relative",
    marginBottom: 12,
  },
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
    backgroundColor: c.border,
    justifyContent: "center",
    alignItems: "center",
  },
  editBadge: {
    position: "absolute",
    bottom: 2,
    right: 2,
    backgroundColor: c.accent,
    borderRadius: 16,
    width: 30,
    height: 30,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: c.primary,
  },
  statusBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: c.primary,
  },
  statusBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "rgba(255,250,247,0.12)",
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.28)",
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  section: { marginHorizontal: 16, marginTop: 20 },
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
  goldCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: c.accent,
    paddingHorizontal: 14,
    paddingVertical: 4,

    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 5,
    elevation: 3,
  },
  cardItemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
  },
  rowDivider: {
    height: 1,
    backgroundColor: "rgba(224,165,61,0.25)",
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: c.border,
    justifyContent: "center",
    alignItems: "center",
  },
  infoLabel: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
  infoValue: {
    color: c.textPrimary,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 2,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderLeftWidth: 4,
    borderLeftColor: c.accent,

    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  actionText: {
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "600",
    marginLeft: 12,
  },
  input: {
    backgroundColor: c.border,
    color: c.textPrimary,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    fontSize: 14,
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.32)",
  },
  dropdown: {
    backgroundColor: c.surface,
    borderColor: c.accent,
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 48,
  },
  dropdownContainer: {
    backgroundColor: c.surfaceSunken,
    borderColor: c.accent,
    borderWidth: 1,
    borderRadius: 10,
  },
  dropdownText: { color: c.textPrimary, fontSize: 14 },
  placeholderStyle: { color: "rgba(155,118,108,0.6)" },
  listItemContainer: { borderBottomColor: c.surface, borderBottomWidth: 0.5 },
  listItemLabel: { color: c.textPrimary },
  arrowIcon: { tintColor: c.accent } as any,
  tickIcon: { tintColor: c.accent } as any,

  // My Posts
  postsToolbar: { gap: 10, marginBottom: 12 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 40,
  },
  searchInput: { flex: 1, color: c.textPrimary, fontSize: 14 },
  toolbarRow: { flexDirection: "row", gap: 8 },
  toolbarChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  toolbarChipActive: {
    backgroundColor: c.danger,
    borderColor: c.danger,
  },
  toolbarChipText: { color: c.primary, fontSize: 12.5, fontWeight: "600" },
  toolbarChipTextActive: { color: c.onPrimary },
  postsEmptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
    gap: 8,
  },
  postsEmptyTitle: {
    color: c.textMuted,
    fontSize: 13.5,
    fontWeight: "600",
    textAlign: "center",
  },
  postsClearFiltersText: {
    color: c.danger,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 2,
  },
  myPostsListInset: { marginHorizontal: 16 },
  loadMoreButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 14,
    paddingVertical: 16,
    marginTop: 12,
  },
  loadMoreButtonText: {
    color: c.primary,
    fontSize: 13,
    fontWeight: "800",
  },
  sortMenuBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  sortMenuCard: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: c.surface,
    borderRadius: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: c.border,
  },
  sortMenuOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sortMenuOptionText: { color: c.textPrimary, fontSize: 14.5 },
  sortMenuOptionTextActive: { color: c.danger, fontWeight: "700" },
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

export default ProfileScreen;

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

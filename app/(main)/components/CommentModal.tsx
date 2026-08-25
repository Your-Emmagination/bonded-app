// Updated CommentModal.tsx 
import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  FlatList,
  Image,
  ActivityIndicator,
  BackHandler,
  Alert,
  Linking,
  Dimensions,
  KeyboardEvent ,
  Keyboard,
  Animated,
  Platform,
} from "react-native";
import { AVATAR_SIZE_SMALL, FEED_IMAGE_WIDTH, avatarThumb, feedImage } from "@/utils/cloudinaryImages";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import ReanimatedAnimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import {
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  orderBy,
  updateDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  startAfter,
  increment,
  serverTimestamp,
  deleteDoc,
  deleteField,
} from "firebase/firestore";
import { db, auth } from "../../../Firebase_configure";
import {
  createMentionNotifications,
  createNotification,
  removeLikeNotification,
  resolveMentionRecipientIds,
  upsertLikeNotification,
} from "@/utils/notifications";
import { hasAiAssistantMention, isAiAssistantId } from "@/utils/aiAssistant";
import {
  AI_REQUEST_COOLDOWN_MS,
  requestAiReplyFromWorker,
  reserveAiCooldown,
} from "@/utils/aiWorker";
import { getAiErrorMessage } from "@/utils/aiConfig";
import {
  canViewModeratedContent,
  getModerationPreviewText,
  runLocalModerationRules,
  requestModerationDecision,
  requestFirestoreModerationDecision,
  type ModerationDecision,
} from "@/utils/contentModeration";
import { resolveAvatarUri } from "@/utils/avatar";

import ReplyThread from "./ReplyThread";
import {
  canDeleteContent,
  canViewAnonymousIdentity,
  getUserData,
  getRoleColor,
  getRoleDisplayName,
  parseUserRole,
  UserRole,
} from "@/utils/rbac";

import CommentComposer from "./CommentComposer";
import AiReplyCard from "./AiReplyCard";
import ExpandableText from "./ExpandableText";
import ImageZoomViewer from "./ImageZoomViewer";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import { buildAiConversationContext, summarizeAiVisibleContent } from "@/utils/aiContext";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import ConfirmDialog from "./ConfirmDialog";
import ContentActionMenu from "./ContentActionMenu";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const KEYBOARD_COMPOSER_LIFT = Platform.OS === "android" ? 14 : 8;
const COMMENT_RETURN_ROUTE = "/(main)/(tabs)/HomeScreen";

const buildCurrentUserPreview = (authUser: typeof auth.currentUser) => {
  if (!authUser) return null;

  const displayName = authUser.displayName?.trim() || "";
  const [firstName = "", ...restName] = displayName.split(/\s+/).filter(Boolean);
  const lastName = restName.join(" ");
  const emailFallback = authUser.email?.split("@")[0]?.trim() || "User";

  return {
    uid: authUser.uid,
    userId: authUser.uid,
    firstname: firstName || emailFallback,
    lastname: lastName,
    username: displayName || emailFallback,
    role: "student",
    profileImage: null,
    profilePic: null,
  };
};

type Comment = {
  id: string;
  text: string;
  userId: string;
  realUserId?: string;
  username?: string;
  createdAt: any;
  role?: string;
  likes?: string[];
  profileImage?: string | null;
  profilePic?: string;
  isAnonymous?: boolean;
  replyCount?: number;
  files?: { url: string; mimeType: string; name?: string }[];
  link?: { url: string; title: string };
  taggedUsers?: { id: string; name: string; studentID: string }[];
  aiReply?: { text: string; model?: string | null; generatedAtMs?: number };
  moderationStatus?: string;
  moderationReasons?: string[];
  onImagePress?: (images: string[], index: number) => void;
  onLinkPress?: (url: string) => void;
  onTagClick?: (userId: string) => void;
  onFilePress?: (url: string, name: string) => void;
};

type CommentModalProps = {
  visible: boolean;
  onClose: () => void;
  postId: string;
  currentUserId?: string;
  currentUserRole?: UserRole;
  onCommentAdded?: () => void;
  initialCommentId?: string | null;
  initialReplyId?: string | null;
  autoOpenReplyThread?: boolean;
};

type SortOption = "latest" | "relevant" | "all";

const CommentItem: React.FC<{
  item: Comment;
  user: any;
  onLike: (commentId: string) => void;
  onProfileClick: (comment: Comment, profileDocId?: string | null) => void;
  onReply: (comment: Comment) => void;
  onOptionsPress: (comment: Comment, authorRole?: UserRole) => void;
  getTimeAgo: (timestamp: any) => string;
  isHighlighted?: boolean;
}> = ({
  item,
  user,
  onLike,
  onProfileClick,
  onReply,
  onOptionsPress,
  getTimeAgo,
  isHighlighted = false,
}) => {
  const [authorData, setAuthorData] = useState<any>(null);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const fetchAuthor = async () => {
      const userIdToFetch = item.realUserId || item.userId;
      if (userIdToFetch && userIdToFetch !== "anonymous") {
        try {
          const data = await getUserData(userIdToFetch);
          setAuthorData(data);
        } catch (err) {
          console.log("Error fetching author:", err);
        }
      }
    };
    fetchAuthor();
  }, [item.realUserId, item.userId]);

  const authorRole = parseUserRole(authorData?.role) ?? parseUserRole(item.role);
  const roleColor = getRoleColor(authorRole || "student");
  const roleDisplayName = getRoleDisplayName(authorRole || "student");

  const canSeeIdentity = canViewAnonymousIdentity(
    parseUserRole(user?.role),
    authorRole,
    item.isAnonymous ?? false,
  );

  const canShowEyeIcon = (item.isAnonymous ?? true) && canSeeIdentity;
  const isIdentityVisible = !item.isAnonymous || (revealed && canSeeIdentity);

  const authorFullName = authorData
    ? `${authorData.firstname || ""} ${authorData.lastname || ""}`.trim()
    : "";

  const displayName = isIdentityVisible
    ? authorFullName || item.username?.trim() || "User"
    : "Anonymous";

  const canClickProfile =
    isIdentityVisible && !!authorData?.userId && authorData.userId !== "anonymous";
  const avatarUri = resolveAvatarUri({
    profileImage: item.profileImage || authorData?.profileImage,
    profilePic: item.profilePic,
  });

  const liked = item.likes?.includes(user?.uid);

  const imageFiles = (item.files || []).filter((f) => f.mimeType.startsWith("image/") && !f.mimeType.includes("gif"));
  const gifFiles = (item.files || []).filter((f) => f.mimeType.includes("gif"));
  const docFiles = (item.files || []).filter((f) => !f.mimeType.startsWith("image/"));
  const [imageHeight, setImageHeight] = useState(200);

  useEffect(() => {
    if (imageFiles.length > 0) {
      Image.getSize(imageFiles[0].url, (w, h) => {
        const ratio = h / w;
        setImageHeight(Math.min(SCREEN_WIDTH * ratio, 500));
      }, () => setImageHeight(200));
    }
  }, [imageFiles]);

  const getFileDisplayName = (file: { url: string; mimeType: string; name?: string }) => {
    if (file.name) return file.name;
    const parts = file.url.split("/");
    const last = parts[parts.length - 1];
    const name = decodeURIComponent(last.split("?")[0]);
    return name.length > 25 ? name.slice(0, 22) + "..." : name;
  };

  return (
    <View style={[styles.commentItem, isHighlighted && styles.commentItemHighlighted]}>
      <View style={styles.commentTopRow}>
        <TouchableOpacity
          onPress={() => canClickProfile && onProfileClick(item, authorData?.studentID)}
          disabled={!canClickProfile}
        >
          <View
            style={[
              styles.avatar,
              isIdentityVisible && authorRole !== "student" && {
                borderColor: roleColor,
                borderWidth: 2,
              },
            ]}
          >
            {isIdentityVisible ? (
              avatarUri ? (
                <Image source={{ uri: avatarThumb(avatarUri, AVATAR_SIZE_SMALL) }} style={styles.avatarImage} />
              ) : (
                <Text style={[styles.avatarText, { color: roleColor }]}>
                  {(authorData?.firstname?.[0] || displayName[0] || "A").toUpperCase()}
                </Text>
              )
            ) : (
              <Ionicons name="person" size={16} color="#9b766c" />
            )}
          </View>
        </TouchableOpacity>

        <View style={{ flex: 1 }}>
          <View style={styles.nameRow}>
            <TouchableOpacity
              onPress={() => canClickProfile && onProfileClick(item, authorData?.studentID)}
              disabled={!canClickProfile}
            >
              <Text style={[styles.commentName, { color: isIdentityVisible ? roleColor : "#9b766c" }]}>
                {displayName}
              </Text>
            </TouchableOpacity>

            {isIdentityVisible && authorRole && authorRole !== "student" && (
              <View style={[styles.roleChip, { backgroundColor: roleColor + "20", borderColor: roleColor }]}>
                <Text style={[styles.roleChipText, { color: roleColor }]}>{roleDisplayName}</Text>
              </View>
            )}

            {canShowEyeIcon && (
              <TouchableOpacity onPress={() => setRevealed(!revealed)} style={styles.eyeButton}>
                <Ionicons
                  name={revealed ? "eye-off-outline" : "eye-outline"}
                  size={14}
                  color={revealed ? "#e0a53d" : "#9b766c"}
                />
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.commentRole}>{getTimeAgo(item.createdAt)}</Text>
        </View>
      </View>

      <View style={styles.commentContentContainer}>
        <ExpandableText
          text={item.text}
          textStyle={styles.commentText}
          collapsedLines={5}
          minLengthToToggle={220}
          buttonStyle={styles.seeMoreButton}
          buttonTextStyle={styles.seeMoreText}
        />
      </View>

      {gifFiles.length > 0 && (
        <View style={styles.commentGifContainer}>
          <Image source={{ uri: feedImage(gifFiles[0].url, FEED_IMAGE_WIDTH) }} style={styles.commentGif} resizeMode="cover" />
        </View>
      )}

      {imageFiles.length > 0 && (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => item.onImagePress?.(imageFiles.map(f => f.url), 0)}
          style={styles.commentImageContainer}
        >
          <Image
            source={{ uri: feedImage(imageFiles[0].url, FEED_IMAGE_WIDTH) }}
            style={[styles.commentImageFull, { height: imageHeight }]}
            resizeMode="cover"
          />
          {imageFiles.length > 1 && (
            <View style={styles.imageCountBadge}>
              <Ionicons name="images" size={14} color="#fff" />
              <Text style={styles.imageCountText}>+{imageFiles.length - 1}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {docFiles.length > 0 && (
        <View style={styles.commentDocsContainer}>
          {docFiles.map((file, idx) => (
            <TouchableOpacity
              key={idx}
              style={styles.commentDocItem}
              onPress={() => item.onFilePress?.(file.url, getFileDisplayName(file))}
            >
              <Ionicons
                name={file.mimeType.includes("pdf") ? "document-text" : "document"}
                size={16}
                color="#4f9cff"
              />
              <Text style={styles.commentDocText} numberOfLines={1}>
                {getFileDisplayName(file)}
              </Text>
              <Ionicons name="download-outline" size={14} color="#9b766c" />
            </TouchableOpacity>
          ))}
        </View>
      )}

{item.link && (
  <TouchableOpacity
    style={styles.commentLinkPreview}
    onPress={() => item.onLinkPress?.(item.link?.url ?? '')}
  >
    <Ionicons name="link" size={16} color="#4f9cff" />
    <View style={{ flex: 1, marginLeft: 8 }}>
      <Text style={styles.commentLinkTitle} numberOfLines={1}>
        {item.link?.title ?? 'Link'}
      </Text>
      <Text style={styles.commentLinkUrl} numberOfLines={1}>
        {item.link?.url ?? ''}
      </Text>
    </View>
    <Ionicons name="open-outline" size={14} color="#a0a8c0" />
  </TouchableOpacity>
)}

      {item.taggedUsers && item.taggedUsers.length > 0 && (
        <TaggedUsersDisplay taggedUsers={item.taggedUsers} onTagClick={item.onTagClick} />
      )}

      <AiReplyCard reply={item.aiReply} compact />

      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => onLike(item.id)}>
          <Ionicons
            name={liked ? "heart" : "heart-outline"}
            size={16}
            color={liked ? "#e0a53d" : "#9b766c"}
          />
          <Text style={styles.actionText}>{item.likes?.length || 0}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={() => onReply(item)}>
          <Ionicons name="chatbubble-outline" size={14} color="#9b766c" />
          <Text style={styles.actionText}>{item.replyCount || 0}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => onOptionsPress(item, authorRole)}
        >
          <Ionicons name="ellipsis-horizontal" size={16} color="#9b766c" />
        </TouchableOpacity>
      </View>
    </View>
  );
};

const TaggedUsersDisplay = ({
  taggedUsers,
  onTagClick,
}: {
  taggedUsers: { id: string; name: string; studentID: string }[];
  onTagClick?: (userId: string) => void;
}) => {
  const [expanded, setExpanded] = useState(false);

  const MAX_VISIBLE = 1;
  const visible = expanded ? taggedUsers : taggedUsers.slice(0, MAX_VISIBLE);
  const remaining = taggedUsers.length - MAX_VISIBLE;
  const hasMore = remaining > 0 && !expanded;

  return (
    <View style={styles.taggedBox}>
      <View style={styles.taggedContent}>
        <Ionicons name="people-outline" size={14} color="#e0a53d" />
        <Text style={styles.taggedLabel}>with </Text>

        {visible.map((tag, idx) => (
          <React.Fragment key={tag.id}>
            <TouchableOpacity onPress={() => onTagClick?.(tag.id)}>
              <Text style={styles.taggedName}>{tag.name}</Text>
            </TouchableOpacity>
            {(idx < visible.length - 1 || (hasMore && idx === visible.length - 1)) && (
              <Text style={styles.taggedSeparator}>, </Text>
            )}
          </React.Fragment>
        ))}

        {hasMore && (
          <TouchableOpacity onPress={() => setExpanded(true)} activeOpacity={0.7}>
            <Text style={styles.moreCount}>+{remaining} more</Text>
          </TouchableOpacity>
        )}

        {expanded && taggedUsers.length > MAX_VISIBLE && (
          <TouchableOpacity onPress={() => setExpanded(false)} style={{ marginLeft: 4 }}>
            <Text style={styles.showLessText}>Show less</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

const CommentModal: React.FC<CommentModalProps> = ({
  visible,
  onClose,
  postId,
  initialCommentId,
  initialReplyId,
  autoOpenReplyThread = false,
}) => {
  const [internalVisible, setInternalVisible] = useState(visible);
  const [comments, setComments] = useState<Comment[]>([]);
  const [displayedComments, setDisplayedComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreComments, setHasMoreComments] = useState(true);
  const lastCommentDocRef = useRef<any>(null);
  const [user, setUser] = useState<any>(() => buildCurrentUserPreview(auth.currentUser));
  const [sortBy, setSortBy] = useState<SortOption>("latest");
  const [replyModalVisible, setReplyModalVisible] = useState(false);
  const [selectedComment, setSelectedComment] = useState<Comment | null>(null);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [isNavigating, setIsNavigating] = useState(false); 
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [editingComment, setEditingComment] = useState<Comment | null>(null);
  const [editingText, setEditingText] = useState("");
  const [savingCommentEdit, setSavingCommentEdit] = useState(false);
  const [commentActionMenu, setCommentActionMenu] = useState<Comment | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    singleAction?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const relativeTimeNow = useRelativeTimeNow();
  const composerBottom = useRef(new Animated.Value(0)).current;

  const flatListRef = useRef<FlatList>(null);
  const initialReplyKeyRef = useRef<string | null>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const hiddenComposerPadding = Math.max(insets.bottom, Platform.OS === "android" ? 16 : 12);

  const translateY = useSharedValue(SCREEN_HEIGHT);
  const backdropOpacity = useSharedValue(0);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (e: KeyboardEvent) => {
        const nextHeight = Math.max(0, e.endCoordinates.height);
        setKeyboardHeight(nextHeight);
        Animated.timing(composerBottom, {
          toValue: nextHeight + KEYBOARD_COMPOSER_LIFT,
          duration: Platform.OS === "ios" ? e.duration || 250 : 220,
          useNativeDriver: false,
        }).start(({ finished }) => {
          if (finished) {
            requestAnimationFrame(() => {
              flatListRef.current?.scrollToEnd({ animated: true });
            });
          }
        });
      }
    );

    const hideSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      (e: KeyboardEvent) => {
        setKeyboardHeight(0);
        Animated.timing(composerBottom, {
          toValue: 0,
          duration: Platform.OS === "ios" ? e.duration || 250 : 180,
          useNativeDriver: false,
        }).start();
      }
    );

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [composerBottom]);

  useEffect(() => {
    setInternalVisible(visible);
  }, [visible]);

  useEffect(() => {
    if (internalVisible) {
      translateY.value = withTiming(0, { duration: 300 });
      backdropOpacity.value = withTiming(1, { duration: 300 });
    }
  }, [internalVisible]);

  const closeAndNavigate = useCallback((navigateFn?: () => void) => {
    translateY.value = withTiming(SCREEN_HEIGHT, { duration: 300 });
    backdropOpacity.value = withTiming(0, { duration: 300 }, (finished) => {
      if (finished) {
        runOnJS(setInternalVisible)(false);
        runOnJS(onClose)();
        if (navigateFn) runOnJS(navigateFn)();
      }
    });
  }, [onClose]);

  const handleClose = useCallback(() => closeAndNavigate(), [closeAndNavigate]);

  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        // Mirrors the original onMoveShouldSetPanResponder gate: only
        // capture drags that are meaningfully downward and mostly vertical.
        .activeOffsetY(10)
        .failOffsetX([-20, 20])
        .onUpdate((event) => {
          if (event.translationY > 0) {
            translateY.value = event.translationY;
            const opacity = 1 - event.translationY / SCREEN_HEIGHT;
            backdropOpacity.value = Math.max(0, opacity);
          }
        })
        .onEnd((event) => {
          // RNGH reports velocity in px/s, whereas the old PanResponder's
          // vy was roughly px/ms — 0.8 px/ms ≈ 800 px/s, same threshold.
          if (event.translationY > 150 || event.velocityY > 800) {
            runOnJS(handleClose)();
            return;
          }

          translateY.value = withSpring(0, { damping: 22, stiffness: 210 });
          backdropOpacity.value = withTiming(1, { duration: 200 });
        }),
    [handleClose],
  );

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  const modalContainerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  useEffect(() => {
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isNavigating) {
        setIsNavigating(false);
        return false;
      }
      if (internalVisible && !replyModalVisible) {
        handleClose();
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [internalVisible, replyModalVisible, isNavigating, handleClose]);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (u) => {
      setUser(buildCurrentUserPreview(u));
      if (u) {
        const userData = await getUserData(u.uid);
        setUser((currentUser: any) => ({
          ...(currentUser || buildCurrentUserPreview(u)),
          ...(userData || {}),
          uid: u.uid,
        }));
      } else {
        setUser(null);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!postId) return;
    setLoading(true);
    setHasMoreComments(true);
    lastCommentDocRef.current = null;

    const q = query(
      collection(db, "comments"),
      where("postId", "==", postId),
      orderBy("createdAt", "desc"),
      limit(20),
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      lastCommentDocRef.current = snapshot.docs[snapshot.docs.length - 1] || null;
      setHasMoreComments(snapshot.size === 20);
      const fetchedComments = (snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() })) as Comment[])
        .filter((item) => canViewModeratedContent({
          moderationStatus: item.moderationStatus,
          realUserId: item.realUserId,
          userId: item.userId,
          viewerUserId: user?.uid,
          viewerRole: user?.role,
        }));
      setComments(fetchedComments);
      setLoading(false);
    });

    return unsubscribe;
  }, [postId, user?.role, user?.uid]);

  useEffect(() => {
    let sorted = [...comments];

    switch (sortBy) {
      case "latest":
        sorted.sort((a, b) => {
          const timeA = a.createdAt?.toMillis?.() || 0;
          const timeB = b.createdAt?.toMillis?.() || 0;
          return timeB - timeA;
        });
        break;

      case "relevant":
        sorted.sort((a, b) => {
          const scoreA = (a.likes?.length || 0) + (a.replyCount || 0) * 2;
          const scoreB = (b.likes?.length || 0) + (b.replyCount || 0) * 2;
          return scoreB - scoreA;
        });
        break;

      case "all":
        sorted.sort((a, b) => {
          const timeA = a.createdAt?.toMillis?.() || 0;
          const timeB = b.createdAt?.toMillis?.() || 0;
          return timeA - timeB;
        });
        break;
    }

    if (initialCommentId) {
      const targetIndex = sorted.findIndex(
        (comment) => comment.id === initialCommentId,
      );
      if (targetIndex > 0) {
        const [targetComment] = sorted.splice(targetIndex, 1);
        sorted.unshift(targetComment);
      }
    }

    setDisplayedComments(sorted);
  }, [comments, sortBy, initialCommentId]);

  useEffect(() => {
    if (!internalVisible || !initialCommentId || !autoOpenReplyThread) {
      return;
    }

    const replyKey = `${initialCommentId}:${initialReplyId || "none"}`;
    if (initialReplyKeyRef.current === replyKey) {
      return;
    }

    const targetComment = comments.find(
      (comment) => comment.id === initialCommentId,
    );
    if (!targetComment) {
      return;
    }

    setSelectedComment(targetComment);
    setReplyModalVisible(true);
    initialReplyKeyRef.current = replyKey;
  }, [
    autoOpenReplyThread,
    comments,
    initialCommentId,
    initialReplyId,
    internalVisible,
  ]);

  useEffect(() => {
    if (!internalVisible) {
      initialReplyKeyRef.current = null;
    }
  }, [internalVisible]);

  const loadMoreComments = useCallback(async () => {
    if (loadingMore || !hasMoreComments || !lastCommentDocRef.current || !postId) return;
    setLoadingMore(true);
    try {
      const nextQuery = query(
        collection(db, "comments"),
        where("postId", "==", postId),
        orderBy("createdAt", "desc"),
        startAfter(lastCommentDocRef.current),
        limit(20),
      );
      const snapshot = await getDocs(nextQuery);
      lastCommentDocRef.current = snapshot.docs[snapshot.docs.length - 1] || lastCommentDocRef.current;
      setHasMoreComments(snapshot.size === 20);
      const nextComments = (snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() })) as Comment[])
        .filter((item) => canViewModeratedContent({
          moderationStatus: item.moderationStatus,
          realUserId: item.realUserId,
          userId: item.userId,
          viewerUserId: user?.uid,
          viewerRole: user?.role,
        }));
      setComments((current) => [...current, ...nextComments.filter((next) => !current.some((item) => item.id === next.id))]);
    } catch (error) {
      console.error("Failed to load more comments:", error);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMoreComments, loadingMore, postId, user?.role, user?.uid]);

  const handleSend = async (commentData: any) => {
    if (!user?.uid) return;

    const newComment = {
      ...commentData,
      postId,
      createdAt: serverTimestamp(),
    };
    // Fast local gate: only clearly prohibited content blocks synchronously.
    // Safe/ambiguous text is written as pending immediately; server moderation
    // continues in the background so the composer can reset without waiting.
    const localDecision = runLocalModerationRules(
      getModerationPreviewText({
        text: commentData.text,
        linkTitle: commentData.link?.title,
        fileCount: commentData.files?.length,
      }),
    );

    if (localDecision.status === "rejected") {
      setConfirmDialog({
        title: "Comment Blocked",
        description: localDecision.reasons?.[0] || "This comment violates the community guidelines.",
        confirmText: "OK",
        singleAction: true,
        destructive: true,
        onConfirm: () => setConfirmDialog(null),
      });
      return;
    }

    // Never let the client self-approve. Every comment enters Firestore as pending.
    newComment.moderationStatus = "pending";
    newComment.moderationReasons = [];
    newComment.moderatedAtMs = null;
    const commentRef = await addDoc(collection(db, "comments"), newComment);

    void (async () => {
      let moderationDecision: ModerationDecision;
      try {
      moderationDecision = await requestFirestoreModerationDecision({
        collectionName: "comments",
        documentId: commentRef.id,
        scope: "comment",
      });
    } catch (error) {
      console.warn("[Comment] Server moderation unavailable; comment remains pending:", error);
      setConfirmDialog({
        title: "Comment Pending Review",
        description: "Automatic moderation is temporarily unavailable. Your comment is waiting for moderator approval.",
        confirmText: "OK",
        singleAction: true,
        destructive: false,
        onConfirm: () => setConfirmDialog(null),
      });
      return;
    }
    if (moderationDecision.status !== "approved") {
      setConfirmDialog({
        title: moderationDecision.status === "rejected" ? "Comment Blocked" : "Comment Pending Review",
        description: moderationDecision.reasons?.[0] || (moderationDecision.status === "rejected" ? "This comment was blocked." : "This comment is waiting for moderator approval."),
        confirmText: "OK",
        singleAction: true,
        destructive: moderationDecision.status === "rejected",
        onConfirm: () => setConfirmDialog(null),
      });
      return;
    }

    await updateDoc(doc(db, "posts", postId), {
      commentCount: increment(1),
    });

    const postSnap = await getDoc(doc(db, "posts", postId));
    const postData = postSnap.exists() ? postSnap.data() : null;
    const postOwnerId = postData?.realUserId || postData?.userId;
      const actor = {
        id: user.uid,
        name: commentData.username,
        profileImage:
          commentData.isAnonymous === true
            ? null
          : resolveAvatarUri(user),
        isAnonymous: commentData.isAnonymous,
      };

    if (moderationDecision.status === "approved") {
      // Notification failures must never block the AI reply that follows —
      // wrap them so an error here is logged, not thrown out of the handler.
      try {
        await createNotification({
          recipientId: postOwnerId,
          actor,
          type: "comment",
          entityType: "comment",
          entityId: commentRef.id,
          parentId: postId,
          message: "commented on your post",
          preview: commentData.text || postData?.content,
        });

        await createMentionNotifications({
          recipientIds: await resolveMentionRecipientIds({
            taggedUserIds: (commentData.taggedUsers || [])
              .map((tag: any) => tag.id)
              .filter((tagId: string) => !isAiAssistantId(tagId)),
            actorId: user.uid,
            serverId: postData?.serverId || null,
          }),
          actor,
          entityType: "comment",
          entityId: commentRef.id,
          parentId: postId,
          message: "mentioned you in a comment",
          preview: commentData.text,
          excludeUserIds: [postOwnerId].filter(Boolean) as string[],
        });
      } catch (error) {
        console.error("Comment notifications failed:", error);
      }
    }

    const shouldTriggerAi =
      hasAiAssistantMention(commentData.text) ||
      (commentData.taggedUsers || []).some((tag: any) => isAiAssistantId(tag.id));

    if (!shouldTriggerAi) {
      return;
    }

    const cooldown = await reserveAiCooldown("comments", postId, AI_REQUEST_COOLDOWN_MS);
    if (!cooldown.allowed) {
      return;
    }

    try {
      await updateDoc(commentRef, {
        aiReply: {
          text: "",
          model: "bonded-nlp-naive-bayes-v1",
          status: "processing",
          generatedAtMs: Date.now(),
        },
      });

      const prompt =
        summarizeAiVisibleContent({
          text: commentData.text,
          username: commentData.username,
          isAnonymous: commentData.isAnonymous,
          link: commentData.link,
          files: commentData.files,
          taggedUsers: commentData.taggedUsers,
        });

      const contextMessages = [
        {
          role: "user" as const,
          name: "Thread",
          content: postData?.content?.trim()
            ? `Original post: ${postData.content.trim()}`
            : "[post without text]",
        },
        ...buildAiConversationContext(comments.slice(-8)),
        {
          role: "user" as const,
          name: commentData.username || "User",
          content: prompt,
        },
      ];

      const { reply, model } = await requestAiReplyFromWorker({
        serverId: "comments",
        channelId: postId,
        sourceMessageId: commentRef.id,
        sourceUserId: user.uid,
        prompt,
        contextMessages,
      });

      await updateDoc(commentRef, {
        aiReply: {
          text: reply,
          model,
          status: "completed",
          generatedAtMs: Date.now(),
        },
      });
    } catch (error) {
      console.error("Comment AI request failed:", error);
      await updateDoc(commentRef, {
        aiReply: deleteField(),
      }).catch(() => undefined);
      setConfirmDialog({
        title: "AI Unavailable",
        description: getAiErrorMessage(error),
        confirmText: "OK",
        singleAction: true,
        destructive: true,
        onConfirm: () => setConfirmDialog(null),
      });
    }
    })().catch((error) => {
      console.error("[Comment] Background approval finalization failed:", error);
    });
  };

  const handleLikeComment = async (commentId: string) => {
    if (!user) return;
    const commentRef = doc(db, "comments", commentId);
    const commentSnap = await getDoc(commentRef);

    if (commentSnap.exists()) {
      const commentData = commentSnap.data() as Comment;
      const existingLikes = commentData.likes || [];
      const updatedLikes = existingLikes.includes(user.uid)
        ? existingLikes.filter((uid) => uid !== user.uid)
        : [...existingLikes, user.uid];

      await updateDoc(commentRef, { likes: updatedLikes });

      const commentOwnerId = commentData.realUserId || commentData.userId;
      const actorName =
        user.firstname && user.lastname
          ? `${user.firstname} ${user.lastname}`.trim()
          : "Someone";

      if (existingLikes.includes(user.uid)) {
        await removeLikeNotification({
          recipientId: commentOwnerId,
          actorId: user.uid,
          entityType: "comment",
          entityId: commentId,
        });
      } else {
        await upsertLikeNotification({
          recipientId: commentOwnerId,
          actor: {
            id: user.uid,
            name: actorName,
            profileImage: resolveAvatarUri(user),
          },
          entityType: "comment",
          entityId: commentId,
          parentId: postId,
          preview: commentData.text,
        });
      }
    }
  };

  const handleReply = (comment: Comment) => {
    setSelectedComment(comment);
    setReplyModalVisible(true);
  };

  const decrementParentCommentCount = useCallback(async () => {
    const postRef = doc(db, "posts", postId);
    const pollRef = doc(db, "polls", postId);

    try {
      const postSnap = await getDoc(postRef);
      if (postSnap.exists()) {
        await updateDoc(postRef, {
          commentCount: increment(-1),
        });
        return;
      }

      const pollSnap = await getDoc(pollRef);
      if (pollSnap.exists()) {
        await updateDoc(pollRef, {
          commentCount: increment(-1),
        });
      }
    } catch (error) {
      console.error("Error updating parent comment count:", error);
    }
  }, [postId]);

  const handleDeleteComment = useCallback(
  async (comment: Comment) => {
    setConfirmDialog({
      title: "Delete Comment?",
      description:
        "This will permanently remove the comment and its replies.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: async () => {
        // Close the confirmation dialog immediately.
        setConfirmDialog(null);

        try {
          const repliesSnapshot = await getDocs(
            query(
              collection(db, "replies"),
              where("commentId", "==", comment.id),
            ),
          );

          await Promise.all(
            repliesSnapshot.docs.map((replyDoc) =>
              deleteDoc(replyDoc.ref),
            ),
          );

          await deleteDoc(
            doc(db, "comments", comment.id),
          );

          await decrementParentCommentCount();

          if (selectedComment?.id === comment.id) {
            setReplyModalVisible(false);
            setSelectedComment(null);
          }
        } catch (error) {
          console.error("Error deleting comment:", error);

          setConfirmDialog({
            title: "Error",
            description: "Failed to delete comment.",
            confirmText: "OK",
            singleAction: true,
            destructive: true,
            onConfirm: () => setConfirmDialog(null),
          });
        }
      },
    });
  },
  [decrementParentCommentCount, selectedComment?.id],
);

  const handleCommentOptions = useCallback(
    (comment: Comment, _authorRole?: UserRole) => {
      setCommentActionMenu(comment);
    },
    [],
  );

  const getCommentActionItems = useCallback((comment: Comment) => {
    const authorUserId = comment.realUserId || comment.userId;
    const viewerRole = parseUserRole(user?.role);
    const authorRole = parseUserRole(comment.role);
    const isOwner = authorUserId === user?.uid;
    const canDelete = canDeleteContent({
      viewerRole,
      viewerUserId: user?.uid,
      authorUserId,
      authorRole,
    });

    const actions: { label: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void; destructive?: boolean }[] = [
      {
        label: "Reply",
        icon: "chatbubble-outline",
        onPress: () => {
          setCommentActionMenu(null);
          handleReply(comment);
        },
      },
    ];

    if (isOwner) {
      actions.push({
        label: "Edit Comment",
        icon: "create-outline",
        onPress: () => {
          setCommentActionMenu(null);
          setEditingComment(comment);
          setEditingText(comment.text);
        },
      });
    }

    if (canDelete) {
      actions.push({
        label: "Delete Comment",
        icon: "trash-outline",
        destructive: true,
        onPress: () => {
          setCommentActionMenu(null);
          handleDeleteComment(comment);
        },
      });
    }

    return actions;
  }, [handleDeleteComment, handleReply, user?.role, user?.uid]);

  const handleProfileClick = useCallback((comment: Comment, profileDocId?: string | null) => {
    const isCommentAnonymous = comment.isAnonymous ?? true;
    const userIdToNavigate = comment.realUserId || comment.userId;

    if (isCommentAnonymous || !userIdToNavigate || userIdToNavigate === "anonymous") {
      return;
    }

    try {
      setIsNavigating(true);
      closeAndNavigate(() => {
        if (user && userIdToNavigate === user.uid) {
          router.push({
            pathname: "/(main)/(tabs)/ProfileScreen",
            params: { returnTo: COMMENT_RETURN_ROUTE },
          });
        } else {
          router.push(
            buildUserProfileHref({
              userId: userIdToNavigate,
              profileDocId,
              returnTo: COMMENT_RETURN_ROUTE,
            }) as any,
          );
        }
      });
    } catch (error) {
      console.log("Navigation error:", error);
      setIsNavigating(false);
    }
  }, [closeAndNavigate, user, router, setIsNavigating]);

  const handleTagClick = useCallback((taggedUserId: string) => {
    try {
      setIsNavigating(true);
      closeAndNavigate(() => {
        if (user && taggedUserId === user.uid) {
          router.push({
            pathname: "/(main)/(tabs)/ProfileScreen",
            params: { returnTo: COMMENT_RETURN_ROUTE },
          });
        } else {
          router.push(
            buildUserProfileHref({
              userId: taggedUserId,
              returnTo: COMMENT_RETURN_ROUTE,
            }) as any,
          );
        }
      });
    } catch (error) {
      console.log("Navigation error:", error);
      setIsNavigating(false);
    }
  }, [closeAndNavigate, user, router, setIsNavigating]);

  const handleLinkPress = (url: string) => {
    Linking.canOpenURL(url)
      .then((supported) => {
        if (supported) Linking.openURL(url);
        else setConfirmDialog({
          title: "Invalid Link",
          description: "Cannot open this URL",
          confirmText: "OK",
          singleAction: true,
          destructive: true,
          onConfirm: () => setConfirmDialog(null),
        });
      })
      .catch(() => setConfirmDialog({
        title: "Error",
        description: "Failed to open link",
        confirmText: "OK",
        singleAction: true,
        destructive: true,
        onConfirm: () => setConfirmDialog(null),
      }));
  };

  const handleFilePress = async (url: string, filename: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        setConfirmDialog({
          title: "Error",
          description: "Cannot open this file",
          confirmText: "OK",
          singleAction: true,
          destructive: true,
          onConfirm: () => setConfirmDialog(null),
        });
      }
    } catch (error) {
      console.error("Error opening file:", error);
      setConfirmDialog({
        title: "Error",
        description: "Failed to open file",
        confirmText: "OK",
        singleAction: true,
        destructive: true,
        onConfirm: () => setConfirmDialog(null),
      });
    }
  };

  const handleImagePress = (images: string[], startIndex: number) => {
    setSelectedImages(images);
    setSelectedImageIndex(startIndex);
    setImageViewerVisible(true);
  };

  const getTimeAgo = (timestamp: any) => {
    if (!timestamp) return "";
    const now = new Date(relativeTimeNow);
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSec < 60) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  };

  if (!internalVisible) return null;

  return (
    <>
<Modal visible={internalVisible} animationType="none" transparent onRequestClose={handleClose}>
  <GestureHandlerRootView style={styles.modalOverlay}>
    <ReanimatedAnimated.View style={[styles.backdrop, backdropAnimatedStyle]}>
      <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={handleClose} />
    </ReanimatedAnimated.View>

    <ReanimatedAnimated.View
  style={[
    styles.modalContainer,
    { paddingTop: insets.top },
    modalContainerAnimatedStyle,
  ]}
>
  <View style={{ flex: 1 }}>
    {/* ✅ Apply GestureDetector ONLY to the top handle/header zone */}
    <GestureDetector gesture={dragGesture}>
      <View style={styles.dragHandleZone}>
        <View style={styles.dragIndicatorContainer}>
          <View style={styles.dragIndicator} />
        </View>

        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            Comments ({comments.length})
          </Text>
        </View>
      </View>
    </GestureDetector>

    {/* Sort options remain outside or inside the gesture zone as needed */}
    <View style={styles.sortContainer}>
      <TouchableOpacity
        style={[
          styles.sortButton,
          sortBy === "latest" && styles.sortButtonActive,
        ]}
        onPress={() => setSortBy("latest")}
      >
        <Ionicons
          name="time-outline"
          size={14}
          color={sortBy === "latest" ? "#e0a53d" : "#9b766c"}
        />
        <Text
          style={[
            styles.sortText,
            sortBy === "latest" && styles.sortTextActive,
          ]}
        >
          Latest
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.sortButton,
          sortBy === "relevant" && styles.sortButtonActive,
        ]}
        onPress={() => setSortBy("relevant")}
      >
        <Ionicons
          name="trending-up-outline"
          size={14}
          color={sortBy === "relevant" ? "#e0a53d" : "#9b766c"}
        />
        <Text
          style={[
            styles.sortText,
            sortBy === "relevant" && styles.sortTextActive,
          ]}
        >
          Relevant
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.sortButton,
          sortBy === "all" && styles.sortButtonActive,
        ]}
        onPress={() => setSortBy("all")}
      >
        <Ionicons
          name="list-outline"
          size={14}
          color={sortBy === "all" ? "#e0a53d" : "#9b766c"}
        />
        <Text
          style={[
            styles.sortText,
            sortBy === "all" && styles.sortTextActive,
          ]}
        >
          All
        </Text>
      </TouchableOpacity>
    </View>

    {/* FlatList and Composer now scroll freely without triggering dismiss gestures */}
    <View style={styles.contentArea}>
      <FlatList
        ref={flatListRef}
        data={displayedComments}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) =>
          loading ? null : (
            <CommentItem
              item={{
                ...item,
                onImagePress: handleImagePress,
                onLinkPress: handleLinkPress,
                onTagClick: handleTagClick,
                onFilePress: handleFilePress,
              }}
              user={user}
              onLike={handleLikeComment}
              onProfileClick={handleProfileClick}
              onReply={handleReply}
              onOptionsPress={handleCommentOptions}
              getTimeAgo={getTimeAgo}
              isHighlighted={item.id === initialCommentId}
            />
          )
        }
        ListHeaderComponent={
          loading ? (
            <ActivityIndicator
              color="#e0a53d"
              style={{ marginTop: 40 }}
            />
          ) : displayedComments.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons
                name="chatbubbles-outline"
                size={48}
                color="#9b766c"
              />
              <Text style={styles.emptyText}>No comments yet</Text>
              <Text style={styles.emptySubText}>
                Be the first to comment!
              </Text>
            </View>
          ) : null
        }
        onEndReached={loadMoreComments}
        onEndReachedThreshold={0.5}
        ListFooterComponent={loadingMore ? <ActivityIndicator color="#e0a53d" style={{ marginVertical: 16 }} /> : null}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={
          Platform.OS === "ios" ? "interactive" : "on-drag"
        }
        style={{ flex: 1 }}
      />

      {user && (
        <Animated.View
          style={[
            styles.composerWrapper,
            {
              marginBottom: composerBottom,
              paddingBottom:
                keyboardHeight > 0 ? 8 : hiddenComposerPadding,
            },
          ]}
        >
          <CommentComposer
            currentUser={user}
            onSend={handleSend}
            placeholder="Write a comment..."
            autoExpand={true}
          />
        </Animated.View>
      )}
    </View>
  </View>
</ReanimatedAnimated.View>
  </GestureHandlerRootView>
</Modal>

{selectedComment && (
  <ReplyThread
    visible={replyModalVisible}
    onClose={() => {
      setReplyModalVisible(false);
      setSelectedComment(null);
    }}
    commentId={selectedComment.id}
    commentAuthor={selectedComment.isAnonymous ? "Anonymous" : selectedComment.username || "User"}
    currentUser={user}
    initialReplyId={
      selectedComment.id === initialCommentId
        ? initialReplyId || undefined
        : undefined
    }
  />
)}

<ImageZoomViewer
  images={selectedImages}
  startIndex={selectedImageIndex}
  visible={imageViewerVisible}
  onClose={() => setImageViewerVisible(false)}
/>

<ContentActionMenu
  visible={!!commentActionMenu}
  title="Comment Actions"
  actions={commentActionMenu ? getCommentActionItems(commentActionMenu) : []}
  onClose={() => setCommentActionMenu(null)}
/>

<ConfirmDialog
  visible={!!confirmDialog}
  title={confirmDialog?.title ?? ""}
  description={confirmDialog?.description}
  confirmText={confirmDialog?.confirmText ?? "Confirm"}
  cancelText={confirmDialog?.cancelText}
  destructive={confirmDialog?.destructive ?? true}
  singleAction={confirmDialog?.singleAction ?? false}
  onConfirm={() => confirmDialog?.onConfirm()}
  onCancel={() => setConfirmDialog(null)}
/>

<Modal visible={!!editingComment} transparent animationType="fade" onRequestClose={() => !savingCommentEdit && setEditingComment(null)}>
  <View style={styles.editOverlay}>
    <View style={styles.editCard}>
      <Text style={styles.editTitle}>Edit Comment</Text>
      <TextInput
        style={styles.editInput}
        value={editingText}
        onChangeText={setEditingText}
        multiline
        autoFocus
        placeholder="Write your comment..."
        placeholderTextColor="#b88f87"
        editable={!savingCommentEdit}
      />
      <View style={styles.editButtonRow}>
        <TouchableOpacity style={styles.editCancelButton} onPress={() => setEditingComment(null)} disabled={savingCommentEdit}>
          <Text style={styles.editCancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.editSaveButton}
          disabled={savingCommentEdit}
          onPress={async () => {
            const nextText = editingText.trim();
            if (!nextText || !editingComment) {
              setConfirmDialog({
                title: "Invalid Comment",
                description: "Comment text cannot be empty.",
                confirmText: "OK",
                singleAction: true,
                destructive: true,
                onConfirm: () => setConfirmDialog(null),
              });
              return;
            }
            setSavingCommentEdit(true);
            try {
              await updateDoc(doc(db, "comments", editingComment.id), { text: nextText, updatedAt: serverTimestamp() });
              setEditingComment(null);
            } catch (error) {
              console.error("Error editing comment:", error);
              setConfirmDialog({
                title: "Error",
                description: "Failed to update comment.",
                confirmText: "OK",
                singleAction: true,
                destructive: true,
                onConfirm: () => setConfirmDialog(null),
              });
            } finally {
              setSavingCommentEdit(false);
            }
          }}
        >
          {savingCommentEdit ? <ActivityIndicator color="#fff" /> : <Text style={styles.editSaveText}>Save</Text>}
        </TouchableOpacity>
      </View>
    </View>
  </View>
</Modal>
    </>
  );
};

const styles = StyleSheet.create({
  editOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 24 },
  editCard: { backgroundColor: "#fffaf7", borderRadius: 18, padding: 18, borderWidth: 1, borderColor: "#eadbd4" },
  editTitle: { color: "#4d1b17", fontSize: 18, fontWeight: "700", marginBottom: 12 },
  editInput: { minHeight: 120, maxHeight: 220, backgroundColor: "#f6f1ed", borderWidth: 1, borderColor: "#eadbd4", borderRadius: 12, padding: 12, color: "#4d1b17", textAlignVertical: "top" },
  editButtonRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  editCancelButton: { flex: 1, minHeight: 44, borderRadius: 12, backgroundColor: "#f0e7e2", alignItems: "center", justifyContent: "center" },
  editCancelText: { color: "#7a3b2e", fontWeight: "700" },
  editSaveButton: { flex: 1, minHeight: 44, borderRadius: 12, backgroundColor: "#7a0020", alignItems: "center", justifyContent: "center" },
  editSaveText: { color: "#fff", fontWeight: "700" },
  modalOverlay: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.82)" },
modalContainer: {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  height: SCREEN_HEIGHT,
  backgroundColor: "#f6f1ed",
  borderTopLeftRadius: 20,
  borderTopRightRadius: 20,
  overflow: "hidden",
  flexDirection: "column", 
},
  contentArea: {
    flex: 1,
  },
  dragIndicatorContainer: { alignItems: "center", paddingVertical: 8 },
  dragIndicator: { width: 40, height: 4, backgroundColor: "#9b766c", borderRadius: 2, opacity: 0.5 },
  header: {
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#8f3a2b",
    backgroundColor: "#5f0909",
  },
  headerTitle: { color: "#fffaf7", fontSize: 17, fontWeight: "700" },

  sortContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f0e7e2",
    backgroundColor: "#fff4ee",
  },
  sortButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  sortButtonActive: {
    backgroundColor: "rgba(224,165,61,0.16)",
    borderColor: "#e0a53d",
  },
  sortText: { color: "#9b766c", fontSize: 13, fontWeight: "600" },
  sortTextActive: { color: "#e0a53d" },

  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 80,
  },
  emptyText: { color: "#4d1b17", fontSize: 17, fontWeight: "700", marginTop: 16 },
  emptySubText: { color: "#9b766c", fontSize: 14, marginTop: 6 },
  listContent: {
    paddingBottom: 8,
  },
  composerWrapper: {
    borderTopWidth: 1,
    borderTopColor: "#f0e7e2",
    backgroundColor: "#fff4ee",
    paddingHorizontal: 12,
    paddingTop: 8,
  },

  commentItem: {
    backgroundColor: "#fffaf7",
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  commentItemHighlighted: {
    borderColor: "#e0a53d",
    shadowColor: "#e0a53d",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 3,
  },
  commentTopRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 10, gap: 12 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#f0e7e2",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: "#f0e7e2",
  },
  avatarImage: { width: "100%", height: "100%" },
  avatarText: { fontSize: 17, fontWeight: "700" },

  nameRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  commentName: { fontWeight: "700", fontSize: 15 },
  roleChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  roleChipText: { fontSize: 10, fontWeight: "700" },
  eyeButton: { padding: 4 },
  commentRole: { color: "#9b766c", fontSize: 12.5, marginTop: 3 },

  commentContentContainer: { marginTop: 4, marginBottom: 8 },
  commentText: { color: "#4d1b17", fontSize: 15, lineHeight: 21 },
  seeMoreButton: { alignSelf: "flex-start", marginTop: 4 },
  seeMoreText: { color: "#e0a53d", fontSize: 14, fontWeight: "600" },

  commentGifContainer: { marginTop: 10, marginHorizontal: -14, overflow: "hidden", borderRadius: 12 },
  commentGif: { width: "100%", height: 220, backgroundColor: "#f6f1ed" },

  commentImageContainer: { position: "relative", marginTop: 10, marginHorizontal: -14, overflow: "hidden", borderRadius: 12 },
  commentImageFull: { width: "100%", backgroundColor: "#f6f1ed" },
  imageCountBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  imageCountText: { color: "#fff", fontSize: 12, fontWeight: "bold" },

  commentDocsContainer: { marginTop: 10, gap: 8 },
  commentDocItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fffaf7",
    padding: 10,
    borderRadius: 10,
    gap: 10,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  commentDocText: { flex: 1, color: "#4d1b17", fontSize: 13 },

  commentLinkPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fffaf7",
    padding: 12,
    borderRadius: 12,
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  commentLinkTitle: { color: "#4d1b17", fontSize: 14, fontWeight: "600", marginBottom: 2 },
  commentLinkUrl: { color: "#9b766c", fontSize: 12 },

  taggedBox: {
    backgroundColor: "#fffaf7",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginVertical: 10,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  taggedContent: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 },
  taggedLabel: { color: "#9b766c", fontSize: 13 },
  taggedName: { color: "#8f3a2b", fontWeight: "600", fontSize: 13.5 },
  taggedSeparator: { color: "#9b766c", fontSize: 13 },
  moreCount: { color: "#9b766c", fontWeight: "600", fontSize: 13.5 },
  showLessText: { color: "#9b766c", fontSize: 13, fontStyle: "italic" },

  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    paddingTop: 10,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#f0e7e2",
  },
  dragHandleZone: {
  width: "100%",
  backgroundColor: "#5f0909",
},
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "#f5efeb",
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  actionText: { color: "#5f0909", fontSize: 13, fontWeight: "600" },

  imageViewerContainer: { flex: 1, backgroundColor: "#000", justifyContent: "center", alignItems: "center" },
  imageViewerClose: {
    position: "absolute",
    top: 50,
    right: 20,
    zIndex: 10,
    padding: 8,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 20,
  },
  imageViewerPage: { width: SCREEN_WIDTH, justifyContent: "center", alignItems: "center" },
  imageViewerImage: { width: "100%", height: "100%" },
  imageViewerCounter: {
    position: "absolute",
    bottom: 40,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  imageViewerCounterText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});

export default CommentModal;
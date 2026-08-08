// Updated CommentModal.tsx 
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  Dimensions,
  FlatList,
  Image,
  Keyboard,
  KeyboardEvent,
  Linking,
  Modal,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hasAiAssistantMention, isAiAssistantId } from "@/utils/aiAssistant";
import { getAiErrorMessage } from "@/utils/aiConfig";
import {
  AI_REQUEST_COOLDOWN_MS,
  requestAiReplyFromWorker,
  reserveAiCooldown,
} from "@/utils/aiWorker";
import { resolveAvatarUri } from "@/utils/avatar";
import {
  canViewModeratedContent,
  getModerationPreviewText,
  requestModerationDecision,
} from "@/utils/contentModeration";
import {
  createMentionNotifications,
  createNotification,
  removeLikeNotification,
  resolveMentionRecipientIds,
  upsertLikeNotification,
} from "@/utils/notifications";
import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "../../../Firebase_configure";

import {
  canDeleteContent,
  canViewAnonymousIdentity,
  getRoleColor,
  getRoleDisplayName,
  getUserData,
  parseUserRole,
  UserRole,
} from "@/utils/rbac";
import ReplyThread from "./ReplyThread";

import { buildAiConversationContext, summarizeAiVisibleContent } from "@/utils/aiContext";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import AiReplyCard from "./AiReplyCard";
import CommentComposer from "./CommentComposer";
import ExpandableText from "./ExpandableText";
import ImageZoomViewer from "./ImageZoomViewer";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const KEYBOARD_COMPOSER_LIFT = Platform.OS === "android" ? 14 : 8;

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

  const displayName = isIdentityVisible
    ? authorData
      ? `${authorData.firstname} ${authorData.lastname}`
      : item.username || "User"
    : "Anonymous";

  const canClickProfile =
    isIdentityVisible && !!authorData?.userId && authorData.userId !== "anonymous";
  const avatarUri = resolveAvatarUri({
    profileImage: item.profileImage || authorData?.profileImage,
    profilePic: item.profilePic,
  });

  const liked = item.likes?.includes(user?.uid);

  const imageFiles = (item.files || []).filter(
    (f) => f.mimeType.startsWith("image/") && !f.mimeType.includes("gif")
  );
  const gifFiles = (item.files || []).filter((f) => f.mimeType.includes("gif"));
  const docFiles = (item.files || []).filter((f) => !f.mimeType.startsWith("image/"));
  const [imageHeight, setImageHeight] = useState(200);

  useEffect(() => {
    if (imageFiles.length > 0) {
      Image.getSize(
        imageFiles[0].url,
        (w, h) => {
          const ratio = h / w;
          setImageHeight(Math.min(SCREEN_WIDTH * ratio, 500));
        },
        () => setImageHeight(200)
      );
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
                <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
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
          <Image source={{ uri: gifFiles[0].url }} style={styles.commentGif} resizeMode="cover" />
        </View>
      )}

      {/* Image attachment with Fullscreen Zoom Trigger */}
      {imageFiles.length > 0 && (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => item.onImagePress?.(imageFiles.map((f) => f.url), 0)}
          style={styles.commentImageContainer}
        >
          <Image
            source={{ uri: imageFiles[0].url }}
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
          onPress={() => item.onLinkPress?.(item.link?.url ?? "")}
        >
          <Ionicons name="link" size={16} color="#4f9cff" />
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={styles.commentLinkTitle} numberOfLines={1}>
              {item.link?.title ?? "Link"}
            </Text>
            <Text style={styles.commentLinkUrl} numberOfLines={1}>
              {item.link?.url ?? ""}
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
  const [user, setUser] = useState<any>(() => buildCurrentUserPreview(auth.currentUser));
  const [sortBy, setSortBy] = useState<SortOption>("latest");
  const [replyModalVisible, setReplyModalVisible] = useState(false);
  const [selectedComment, setSelectedComment] = useState<Comment | null>(null);

  // Zoom Viewer State
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  const [isNavigating, setIsNavigating] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const relativeTimeNow = useRelativeTimeNow();
  const composerBottom = useRef(new Animated.Value(0)).current;

  const flatListRef = useRef<FlatList>(null);
  const initialReplyKeyRef = useRef<string | null>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const hiddenComposerPadding = Math.max(insets.bottom, Platform.OS === "android" ? 16 : 12);

  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

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
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(backdropOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();
    }
  }, [backdropOpacity, internalVisible, translateY]);

  const closeAndNavigate = useCallback(
    (navigateFn?: () => void) => {
      Animated.parallel([
        Animated.timing(translateY, { toValue: SCREEN_HEIGHT, duration: 300, useNativeDriver: true }),
        Animated.timing(backdropOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start(() => {
        setInternalVisible(false);
        onClose();
        if (navigateFn) navigateFn();
      });
    },
    [backdropOpacity, onClose, translateY]
  );

  const handleClose = useCallback(() => closeAndNavigate(), [closeAndNavigate]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        const isDraggingDown = gestureState.dy > 10;
        const isVertical = Math.abs(gestureState.dy) > Math.abs(gestureState.dx) * 2;
        return isDraggingDown && isVertical;
      },
      onPanResponderGrant: () => {},
      onPanResponderMove: (evt, gestureState) => {
        if (gestureState.dy > 0) {
          translateY.setValue(gestureState.dy);
          const opacity = 1 - gestureState.dy / SCREEN_HEIGHT;
          backdropOpacity.setValue(Math.max(0, opacity));
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (gestureState.dy > 150 || gestureState.vy > 0.8) {
          handleClose();
        } else {
          Animated.parallel([
            Animated.spring(translateY, {
              toValue: 0,
              useNativeDriver: true,
              tension: 65,
              friction: 10,
            }),
            Animated.timing(backdropOpacity, {
              toValue: 1,
              duration: 200,
              useNativeDriver: true,
            }),
          ]).start();
        }
      },
    })
  ).current;

  useEffect(() => {
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isNavigating) {
        setIsNavigating(false);
        return false;
      }
      if (internalVisible && !replyModalVisible && !imageViewerVisible) {
        handleClose();
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [internalVisible, replyModalVisible, imageViewerVisible, isNavigating, handleClose]);

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
    const q = query(
      collection(db, "comments"),
      where("postId", "==", postId),
      orderBy("createdAt", "asc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedComments = (snapshot.docs
        .map((d) => ({
          id: d.id,
          ...d.data(),
        })) as Comment[]).filter((item) =>
        canViewModeratedContent({
          moderationStatus: item.moderationStatus,
          realUserId: item.realUserId,
          userId: item.userId,
          viewerUserId: user?.uid,
          viewerRole: user?.role,
        })
      );
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
      const targetIndex = sorted.findIndex((comment) => comment.id === initialCommentId);
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

    const targetComment = comments.find((comment) => comment.id === initialCommentId);
    if (!targetComment) {
      return;
    }

    setSelectedComment(targetComment);
    setReplyModalVisible(true);
    initialReplyKeyRef.current = replyKey;
  }, [autoOpenReplyThread, comments, initialCommentId, initialReplyId, internalVisible]);

  useEffect(() => {
    if (!internalVisible) {
      initialReplyKeyRef.current = null;
    }
  }, [internalVisible]);

  const handleSend = async (commentData: any) => {
    if (!user?.uid) return;

    const newComment = {
      ...commentData,
      postId,
      createdAt: serverTimestamp(),
    };
    const moderationDecision = await requestModerationDecision({
      text: getModerationPreviewText({
        text: commentData.text,
        linkTitle: commentData.link?.title,
        fileCount: commentData.files?.length,
      }),
      scope: "comment",
      serverId: postId,
      channelId: postId,
      authorId: user.uid,
      authorRole: user.role,
    });
    newComment.moderationStatus = moderationDecision.status;
    newComment.moderationReasons = moderationDecision.reasons;
    newComment.moderatedAtMs = Date.now();

    const commentRef = await addDoc(collection(db, "comments"), newComment);
    await updateDoc(doc(db, "posts", postId), {
      commentCount: increment(1),
    });

    const postSnap = await getDoc(doc(db, "posts", postId));
    const postData = postSnap.exists() ? postSnap.data() : null;
    const postOwnerId = postData?.realUserId || postData?.userId;
    const actor = {
      id: user.uid,
      name: commentData.username,
      profileImage: commentData.isAnonymous === true ? null : resolveAvatarUri(user),
      isAnonymous: commentData.isAnonymous,
    };

    if (moderationDecision.status !== "pending") {
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
    }

    const shouldTriggerAi =
      hasAiAssistantMention(commentData.text) ||
      (commentData.taggedUsers || []).some((tag: any) => isAiAssistantId(tag.id));

    if (!shouldTriggerAi || moderationDecision.status === "pending") {
      if (moderationDecision.status === "pending") {
        Alert.alert(
          "Comment Pending Review",
          "This comment was flagged and is waiting for moderator approval."
        );
      }
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
          status: "generating",
          generatedAtMs: Date.now(),
        },
      });

      const prompt = summarizeAiVisibleContent({
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
      Alert.alert("AI Unavailable", getAiErrorMessage(error));
    }
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
        await updateDoc(postRef, { commentCount: increment(-1) });
        return;
      }

      const pollSnap = await getDoc(pollRef);
      if (pollSnap.exists()) {
        await updateDoc(pollRef, { commentCount: increment(-1) });
      }
    } catch (error) {
      console.error("Error updating parent comment count:", error);
    }
  }, [postId]);

  const handleDeleteComment = useCallback(
    async (comment: Comment) => {
      Alert.alert("Delete Comment", "This will permanently remove the comment and its replies.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const repliesSnapshot = await getDocs(
                query(collection(db, "replies"), where("commentId", "==", comment.id))
              );

              await Promise.all(repliesSnapshot.docs.map((replyDoc) => deleteDoc(replyDoc.ref)));
              await deleteDoc(doc(db, "comments", comment.id));
              await decrementParentCommentCount();

              if (selectedComment?.id === comment.id) {
                setReplyModalVisible(false);
                setSelectedComment(null);
              }
            } catch (error) {
              console.error("Error deleting comment:", error);
              Alert.alert("Error", "Failed to delete comment.");
            }
          },
        },
      ]);
    },
    [decrementParentCommentCount, selectedComment?.id]
  );

  const handleCommentOptions = useCallback(
    (comment: Comment, authorRole?: UserRole) => {
      const authorUserId = comment.realUserId || comment.userId;
      const viewerRole = parseUserRole(user?.role);
      const canDelete = canDeleteContent({
        viewerRole,
        viewerUserId: user?.uid,
        authorUserId,
        authorRole,
      });

      const options: {
        text: string;
        style?: "cancel" | "default" | "destructive";
        onPress?: () => void;
      }[] = [
        {
          text: "Reply",
          onPress: () => handleReply(comment),
        },
      ];

      if (canDelete) {
        options.push({
          text: "Delete",
          style: "destructive",
          onPress: () => handleDeleteComment(comment),
        });
      }

      Alert.alert("Comment Options", undefined, [
        ...options,
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [handleDeleteComment, user?.role, user?.uid]
  );

  const handleProfileClick = useCallback(
    (comment: Comment, profileDocId?: string | null) => {
      if (comment.isAnonymous) return;
      const targetUserId = comment.realUserId || comment.userId;
      if (!targetUserId || targetUserId === "anonymous") return;

      setIsNavigating(true);
      closeAndNavigate(() => {
        router.push(
          buildUserProfileHref({
            userId: targetUserId,
            studentID: profileDocId,
          })
        );
      });
    },
    [closeAndNavigate, router]
  );

  const handleImagePress = useCallback((images: string[], index: number = 0) => {
    setSelectedImages(images);
    setSelectedImageIndex(index);
    setImageViewerVisible(true);
  }, []);

  const handleLinkPress = useCallback((url: string) => {
    if (url) Linking.openURL(url).catch(() => Alert.alert("Error", "Cannot open URL"));
  }, []);

  const handleTagClick = useCallback(
    (taggedUserId: string) => {
      if (!taggedUserId) return;
      setIsNavigating(true);
      closeAndNavigate(() => {
        router.push(buildUserProfileHref({ userId: taggedUserId }));
      });
    },
    [closeAndNavigate, router]
  );

  const handleFilePress = useCallback((url: string) => {
    if (url) Linking.openURL(url).catch(() => Alert.alert("Error", "Cannot download file"));
  }, []);

  const getTimeAgo = useCallback(
    (timestamp: any) => {
      if (!timestamp) return "Just now";
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      const seconds = Math.floor((relativeTimeNow - date.getTime()) / 1000);
      if (seconds < 60) return "Just now";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      if (days < 7) return `${days}d ago`;
      return date.toLocaleDateString();
    },
    [relativeTimeNow]
  );

  if (!internalVisible) return null;

  return (
    <Modal transparent visible={internalVisible} animationType="none" onRequestClose={handleClose}>
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <TouchableOpacity style={{ flex: 1 }} onPress={handleClose} activeOpacity={1} />
      </Animated.View>

      <Animated.View
        style={[styles.modalContainer, { transform: [{ translateY }] }]}
        {...panResponder.panHandlers}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.dragIndicator} />
          <View style={styles.headerTop}>
            <Text style={styles.headerTitle}>Comments</Text>
            <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color="#fff" />
            </TouchableOpacity>
          </View>

          {/* Sort Tabs */}
          <View style={styles.sortRow}>
            {(["latest", "relevant", "all"] as SortOption[]).map((option) => (
              <TouchableOpacity
                key={option}
                onPress={() => setSortBy(option)}
                style={[styles.sortTab, sortBy === option && styles.activeSortTab]}
              >
                <Text style={[styles.sortTabText, sortBy === option && styles.activeSortTabText]}>
                  {option.charAt(0).toUpperCase() + option.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Comment List */}
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#e0a53d" />
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={displayedComments}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
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
            )}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Ionicons name="chatbubbles-outline" size={48} color="#9b766c" />
                <Text style={styles.emptyText}>No comments yet</Text>
                <Text style={styles.emptySubtext}>Be the first to share your thoughts!</Text>
              </View>
            }
          />
        )}

        {/* Floating Composer */}
        <Animated.View
          style={[
            styles.composerWrapper,
            {
              bottom: composerBottom,
              paddingBottom: keyboardHeight > 0 ? 0 : hiddenComposerPadding,
            },
          ]}
        >
          <CommentComposer onSend={handleSend} user={user} postId={postId} />
        </Animated.View>
      </Animated.View>

      {/* Reply Thread Modal */}
      {selectedComment && (
        <ReplyThread
          visible={replyModalVisible}
          onClose={() => {
            setReplyModalVisible(false);
            setSelectedComment(null);
          }}
          commentId={selectedComment.id}
          commentAuthorId={selectedComment.realUserId || selectedComment.userId}
          commentText={selectedComment.text}
          commentAuthorName={selectedComment.username}
          commentAuthorRole={selectedComment.role}
          commentAuthorAvatar={resolveAvatarUri(selectedComment)}
          commentIsAnonymous={selectedComment.isAnonymous}
          initialReplyId={initialReplyId}
          onImagePress={handleImagePress}
          onLinkPress={handleLinkPress}
          onTagClick={handleTagClick}
          onFilePress={handleFilePress}
        />
      )}

      {/* Fullscreen Shared Image Zoom Modal */}
      <ImageZoomViewer
        images={selectedImages}
        startIndex={selectedImageIndex}
        visible={imageViewerVisible}
        onClose={() => setImageViewerVisible(false)}
      />
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
  modalContainer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: SCREEN_HEIGHT * 0.85,
    backgroundColor: "#1f1b18",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: "hidden",
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#2c2623",
  },
  dragIndicator: {
    width: 36,
    height: 4,
    backgroundColor: "#403632",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 8,
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#fff",
  },
  closeBtn: {
    padding: 4,
  },
  sortRow: {
    flexDirection: "row",
    gap: 8,
  },
  sortTab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: "#2c2623",
  },
  activeSortTab: {
    backgroundColor: "#e0a53d",
  },
  sortTabText: {
    color: "#9b766c",
    fontSize: 12,
    fontWeight: "600",
  },
  activeSortTabText: {
    color: "#fff",
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  listContent: {
    padding: 16,
    paddingBottom: 100,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
  },
  emptyText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
    marginTop: 12,
  },
  emptySubtext: {
    color: "#9b766c",
    fontSize: 14,
    marginTop: 4,
  },
  commentItem: {
    marginBottom: 16,
    backgroundColor: "#27211e",
    borderRadius: 12,
    padding: 12,
  },
  commentItemHighlighted: {
    borderWidth: 1,
    borderColor: "#e0a53d",
  },
  commentTopRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#362e2a",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
    overflow: "hidden",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarText: {
    fontWeight: "bold",
    fontSize: 14,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  commentName: {
    fontWeight: "bold",
    fontSize: 14,
  },
  roleChip: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  roleChipText: {
    fontSize: 10,
    fontWeight: "bold",
  },
  eyeButton: {
    padding: 2,
  },
  commentRole: {
    color: "#9b766c",
    fontSize: 11,
  },
  commentContentContainer: {
    marginVertical: 4,
  },
  commentText: {
    color: "#fff",
    fontSize: 14,
    lineHeight: 20,
  },
  seeMoreButton: {
    marginTop: 4,
  },
  seeMoreText: {
    color: "#e0a53d",
    fontSize: 12,
    fontWeight: "600",
  },
  commentGifContainer: {
    marginTop: 8,
    borderRadius: 8,
    overflow: "hidden",
    maxHeight: 200,
  },
  commentGif: {
    width: "100%",
    height: 180,
  },
  commentImageContainer: {
    marginTop: 8,
    borderRadius: 8,
    overflow: "hidden",
    position: "relative",
  },
  commentImageFull: {
    width: "100%",
    borderRadius: 8,
  },
  imageCountBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  imageCountText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "bold",
  },
  commentDocsContainer: {
    marginTop: 8,
    gap: 6,
  },
  commentDocItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1f1b18",
    padding: 8,
    borderRadius: 8,
    gap: 8,
  },
  commentDocText: {
    color: "#fff",
    fontSize: 12,
    flex: 1,
  },
  commentLinkPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1f1b18",
    padding: 8,
    borderRadius: 8,
    marginTop: 8,
  },
  commentLinkTitle: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  commentLinkUrl: {
    color: "#9b766c",
    fontSize: 10,
  },
  taggedBox: {
    marginTop: 6,
  },
  taggedContent: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
  },
  taggedLabel: {
    color: "#9b766c",
    fontSize: 12,
  },
  taggedName: {
    color: "#e0a53d",
    fontSize: 12,
    fontWeight: "600",
  },
  taggedSeparator: {
    color: "#9b766c",
    fontSize: 12,
  },
  moreCount: {
    color: "#e0a53d",
    fontSize: 12,
    fontWeight: "600",
  },
  showLessText: {
    color: "#9b766c",
    fontSize: 12,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    gap: 16,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  actionText: {
    color: "#9b766c",
    fontSize: 12,
  },
  composerWrapper: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: "#1f1b18",
    borderTopWidth: 1,
    borderTopColor: "#2c2623",
  },
});

export default CommentModal;
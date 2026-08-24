import { hasAiAssistantMention, isAiAssistantId } from "@/utils/aiAssistant";
import { getAiErrorMessage } from "@/utils/aiConfig";
import {
  buildAiConversationContext,
  summarizeAiVisibleContent,
} from "@/utils/aiContext";
import {
  AI_REQUEST_COOLDOWN_MS,
  requestAiReplyFromWorker,
  reserveAiCooldown,
} from "@/utils/aiWorker";
import { resolveAvatarUri } from "@/utils/avatar";
import ConfirmDialog from "./ConfirmDialog";
import {
  AVATAR_SIZE_SMALL,
  FEED_IMAGE_WIDTH,
  avatarThumb,
  feedImage,
} from "@/utils/cloudinaryImages";
import {
  canViewModeratedContent,
  getModerationPreviewText,
  runLocalModerationRules,
  requestModerationDecision,
  requestFirestoreModerationDecision,
  type ModerationDecision,
} from "@/utils/contentModeration";
import {
  createMentionNotifications,
  createNotification,
  removeLikeNotification,
  resolveMentionRecipientIds,
  upsertLikeNotification,
} from "@/utils/notifications";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import {
  canDeleteContent,
  canViewAnonymousIdentity,
  getRoleColor,
  getRoleDisplayName,
  getUserData,
  parseUserRole,
  UserRole,
} from "@/utils/rbac";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  startAfter,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  BackHandler,
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
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { db } from "../../../Firebase_configure";
import AiReplyCard from "./AiReplyCard";
import CommentComposer from "./CommentComposer";
import ExpandableText from "./ExpandableText";
import ImageZoomViewer from "./ImageZoomViewer";

const REPLY_RETURN_ROUTE = "/(main)/(tabs)/HomeScreen";

const KEYBOARD_COMPOSER_LIFT = Platform.OS === "android" ? 14 : 8;

type Reply = {
  id: string;
  text: string;
  userId: string;
  realUserId?: string;
  username?: string;
  createdAt: any;
  role?: string;
  profileImage?: string | null;
  profilePic?: string;
  isAnonymous?: boolean;
  commentId: string;
  files?: {
    url: string;
    mimeType: string;
    name?: string;
  }[];
  link?: {
    url: string;
    title: string;
  };
  taggedUsers?: {
    id: string;
    name: string;
    studentID: string;
  }[];
  likeCount?: number;
  likedBy?: string[];
  seenBy?: string[];
  replyingTo?: {
    id: string;
    name: string;
    text: string;
  };
  aiReply?: {
    text: string;
    model?: string | null;
    generatedAtMs?: number;
    status?: "generating" | "completed";
  };
  moderationStatus?: string;
  moderationReasons?: string[];
};

type ReplyThreadProps = {
  visible: boolean;
  onClose: () => void;
  commentId: string;
  commentAuthor: string;
  currentUser: any;
  initialReplyId?: string;
};

function getAuthorRole(authorData: any, itemRole?: string) {
  return authorData?.role || itemRole || "student";
}

const ReplyBubble: React.FC<{
  item: Reply;
  currentUser: any;
  prevItem?: Reply;
  nextItem?: Reply;
  onLike: (id: string, likedBy: string[]) => void;
  onReplyClick: (id: string, name: string, text: string) => void;
  onReplyReferencePress: (replyId?: string | null) => void;
  onLongPress: (item: Reply, authorRole?: UserRole) => void;
  onOptionsPress: (item: Reply, authorRole?: UserRole) => void;
  onProfileClick: (item: Reply, profileDocId?: string | null) => void;
  onTagClick: (userId: string) => void;
  onLinkPress: (url: string) => void;
  onFilePress: (url: string) => void;
  onImagePress: (images: string[], index: number) => void;
  getTimeAgo: (ts: any) => string;
  getFileDisplayName: (f: {
    url: string;
    mimeType: string;
    name?: string;
  }) => string;
  isHighlighted?: boolean;
}> = ({
  item,
  currentUser,
  prevItem,
  nextItem,
  onLike,
  onReplyClick,
  onReplyReferencePress,
  onLongPress,
  onOptionsPress,
  onProfileClick,
  onTagClick,
  onLinkPress,
  onFilePress,
  onImagePress,
  getTimeAgo,
  getFileDisplayName,
  isHighlighted = false,
}) => {
  const [authorData, setAuthorData] = useState<any>(null);
  const [revealed, setRevealed] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;

  const isCurrentUser =
    (item.realUserId && item.realUserId === currentUser?.uid) ||
    item.userId === currentUser?.uid;

  const isAnon = item.isAnonymous ?? false;

  const isSameSenderAsPrev =
    !!prevItem &&
    (prevItem.realUserId || prevItem.userId) ===
      (item.realUserId || item.userId) &&
    prevItem.isAnonymous === item.isAnonymous;

  const isSameSenderAsNext =
    !!nextItem &&
    (nextItem.realUserId || nextItem.userId) ===
      (item.realUserId || item.userId) &&
    nextItem.isAnonymous === item.isAnonymous;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  useEffect(() => {
    let cancelled = false;

    const fetchAuthor = async () => {
      const uid = item.realUserId || item.userId;

      if (!uid || uid === "anonymous") {
        return;
      }

      try {
        const data = await getUserData(uid);

        if (!cancelled) {
          setAuthorData(data);
        }
      } catch {
        // Ignore profile lookup failures.
      }
    };

    fetchAuthor();

    return () => {
      cancelled = true;
    };
  }, [item.realUserId, item.userId]);

  const authorRole = parseUserRole(getAuthorRole(authorData, item.role));
  const roleColor = getRoleColor(authorRole || "student");
  const roleDisplayName = getRoleDisplayName(authorRole || "student");
  const isPrivileged = !!authorRole && authorRole !== "student";

  const canReveal = canViewAnonymousIdentity(
    parseUserRole(currentUser?.role),
    authorRole,
    isAnon,
  );

  const isIdentityVisible = !isAnon || (revealed && canReveal);

  const displayName = isIdentityVisible
    ? authorData
      ? `${authorData.firstname || ""} ${authorData.lastname || ""}`.trim() ||
        item.username ||
        "User"
      : item.username || "User"
    : "Anonymous";

  const initial = isIdentityVisible
    ? (
        authorData?.firstname?.[0] ||
        displayName[0] ||
        "A"
      ).toUpperCase()
    : "?";

  const isLiked = (item.likedBy || []).includes(currentUser?.uid || "");

  const imageFiles = (item.files || []).filter(
    (f) =>
      f.mimeType.startsWith("image/") && !f.mimeType.includes("gif"),
  );

  const gifFiles = (item.files || []).filter((f) =>
    f.mimeType.includes("gif"),
  );

  const docFiles = (item.files || []).filter(
    (f) => !f.mimeType.startsWith("image/"),
  );

  const taggedUsers = item.taggedUsers ?? [];

  const avatarUri = resolveAvatarUri({
    profileImage: item.profileImage || authorData?.profileImage,
    profilePic: item.profilePic,
  });

  const showHeader = !isSameSenderAsPrev;
  const showAvatar = !isCurrentUser && !isSameSenderAsNext;

  return (
    <Animated.View
      style={[
        styles.messageRow,
        isCurrentUser
          ? styles.messageRowRight
          : styles.messageRowLeft,
        { opacity: fadeAnim },
        isSameSenderAsPrev
          ? { marginTop: 2 }
          : { marginTop: 10 },
      ]}
    >
      {!isCurrentUser && (
        <View style={styles.avatarColumn}>
          {showAvatar ? (
            <TouchableOpacity
              onPress={() =>
                onProfileClick(item, authorData?.studentID)
              }
              disabled={!isIdentityVisible}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.avatar,
                  isIdentityVisible && isPrivileged
                    ? {
                        borderColor: roleColor,
                        borderWidth: 2,
                      }
                    : {
                        borderColor: "#f0e7e2",
                        borderWidth: 1,
                      },
                ]}
              >
                {isIdentityVisible && avatarUri ? (
                  <Image
                    source={{
                      uri: avatarThumb(
                        avatarUri,
                        AVATAR_SIZE_SMALL,
                      ),
                    }}
                    style={styles.avatarImg}
                  />
                ) : isIdentityVisible ? (
                  <Text
                    style={[
                      styles.avatarInitial,
                      { color: roleColor },
                    ]}
                  >
                    {initial}
                  </Text>
                ) : (
                  <Ionicons
                    name="person"
                    size={13}
                    color="#9b766c"
                  />
                )}
              </View>
            </TouchableOpacity>
          ) : (
            <View style={styles.avatarPlaceholder} />
          )}
        </View>
      )}

      <View
        style={[
          styles.bubbleWrapper,
          isCurrentUser
            ? styles.bubbleWrapperRight
            : styles.bubbleWrapperLeft,
          isHighlighted && styles.highlightedBubbleWrapper,
        ]}
      >
        {!isCurrentUser && showHeader && (
          <View style={styles.senderRow}>
            <TouchableOpacity
              onPress={() =>
                onProfileClick(item, authorData?.studentID)
              }
              disabled={!isIdentityVisible}
            >
              <Text
                style={[
                  styles.senderName,
                  {
                    color: isIdentityVisible
                      ? roleColor
                      : "#9b766c",
                  },
                ]}
              >
                {displayName}
              </Text>
            </TouchableOpacity>

            {isIdentityVisible && isPrivileged && (
              <View
                style={[
                  styles.roleChip,
                  {
                    backgroundColor: roleColor + "22",
                    borderColor: roleColor,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.roleChipText,
                    { color: roleColor },
                  ]}
                >
                  {roleDisplayName}
                </Text>
              </View>
            )}

            {canReveal && (
              <TouchableOpacity
                onPress={() => setRevealed((value) => !value)}
                style={styles.eyeBtn}
              >
                <Ionicons
                  name={
                    revealed
                      ? "eye-off-outline"
                      : "eye-outline"
                  }
                  size={13}
                  color={
                    revealed
                      ? "#e0a53d"
                      : "#9b766c"
                  }
                />
              </TouchableOpacity>
            )}
          </View>
        )}

        {item.replyingTo && (
          <TouchableOpacity
            activeOpacity={0.82}
            onPress={() =>
              onReplyReferencePress(item.replyingTo?.id)
            }
            style={[
              styles.replyPreview,
              isCurrentUser && styles.replyPreviewRight,
            ]}
          >
            <View style={styles.replyPreviewBar} />

            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.replyPreviewAuthor,
                  isCurrentUser && {
                    color: "#f0c879",
                  },
                ]}
              >
                {item.replyingTo.name}
              </Text>

              <Text
                style={[
                  styles.replyPreviewText,
                  isCurrentUser && {
                    color: "#ffffff99",
                  },
                ]}
                numberOfLines={2}
              >
                {item.replyingTo.text || "Message"}
              </Text>
            </View>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          onLongPress={() => onLongPress(item, authorRole)}
          delayLongPress={350}
          activeOpacity={0.88}
          style={[
            styles.bubble,
            isCurrentUser
              ? styles.bubbleRight
              : styles.bubbleLeft,
          ]}
        >
          {!!item.text && (
            <ExpandableText
              text={item.text}
              textStyle={[
                styles.bubbleText,
                isCurrentUser && styles.bubbleTextRight,
              ]}
              collapsedLines={5}
              minLengthToToggle={220}
              buttonTextStyle={[
                styles.replyToggleText,
                isCurrentUser &&
                  styles.replyToggleTextRight,
              ]}
            />
          )}

          {gifFiles.length > 0 && (
            <View style={styles.gifContainer}>
              <Image
                source={{
                  uri: feedImage(
                    gifFiles[0].url,
                    FEED_IMAGE_WIDTH,
                  ),
                }}
                style={styles.gifImage}
                resizeMode="cover"
              />
            </View>
          )}

          {imageFiles.length > 0 && (
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() =>
                onImagePress(
                  imageFiles.map((f) => f.url),
                  0,
                )
              }
              style={styles.imageContainer}
            >
              <Image
                source={{
                  uri: feedImage(
                    imageFiles[0].url,
                    FEED_IMAGE_WIDTH,
                  ),
                }}
                style={styles.imagePreview}
                resizeMode="cover"
              />

              {imageFiles.length > 1 && (
                <View style={styles.imageCountBadge}>
                  <Text style={styles.imageCountText}>
                    +{imageFiles.length - 1}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          )}

          {docFiles.length > 0 && (
            <View style={styles.docsContainer}>
              {docFiles.map((file, idx) => (
                <TouchableOpacity
                  key={`${file.url}-${idx}`}
                  style={[
                    styles.docItem,
                    isCurrentUser &&
                      styles.docItemRight,
                  ]}
                  onPress={() =>
                    onFilePress(file.url)
                  }
                >
                  <Ionicons
                    name={
                      file.mimeType.includes("pdf")
                        ? "document-text"
                        : "document"
                    }
                    size={14}
                    color={
                      isCurrentUser
                        ? "#fff"
                        : "#4f9cff"
                    }
                  />

                  <Text
                    style={[
                      styles.docText,
                      isCurrentUser && {
                        color: "#fff",
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {getFileDisplayName(file)}
                  </Text>

                  <Ionicons
                    name="download-outline"
                    size={12}
                    color={
                      isCurrentUser
                        ? "#ffffff99"
                        : "#9b766c"
                    }
                  />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {item.link && (
            <TouchableOpacity
              style={[
                styles.linkPreview,
                isCurrentUser &&
                  styles.linkPreviewRight,
              ]}
              onPress={() =>
                onLinkPress(item.link?.url ?? "")
              }
            >
              <Ionicons
                name="link"
                size={13}
                color={
                  isCurrentUser
                    ? "#fff"
                    : "#4f9cff"
                }
              />

              <View
                style={{
                  flex: 1,
                  marginLeft: 6,
                }}
              >
                <Text
                  style={[
                    styles.linkTitle,
                    isCurrentUser && {
                      color: "#fff",
                    },
                  ]}
                  numberOfLines={1}
                >
                  {item.link?.title ?? "Link"}
                </Text>

                <Text
                  style={[
                    styles.linkUrl,
                    isCurrentUser && {
                      color: "#ffffff99",
                    },
                  ]}
                  numberOfLines={1}
                >
                  {item.link?.url ?? ""}
                </Text>
              </View>

              <Ionicons
                name="open-outline"
                size={11}
                color={
                  isCurrentUser
                    ? "#ffffff99"
                    : "#9b766c"
                }
              />
            </TouchableOpacity>
          )}

          {taggedUsers.length > 0 && (
            <View
              style={[
                styles.taggedRow,
                isCurrentUser &&
                  styles.taggedRowRight,
              ]}
            >
              <Ionicons
                name="people-outline"
                size={11}
                color={
                  isCurrentUser
                    ? "#f0c879"
                    : "#e0a53d"
                }
              />

              <Text
                style={[
                  styles.taggedWith,
                  isCurrentUser && {
                    color: "#f0c879",
                  },
                ]}
              >
                with{" "}
              </Text>

              <View style={styles.taggedNames}>
                {taggedUsers.map((tag, idx) => (
                  <React.Fragment key={tag.id}>
                    <TouchableOpacity
                      onPress={() =>
                        onTagClick(tag.id)
                      }
                    >
                      <Text
                        style={[
                          styles.taggedName,
                          isCurrentUser && {
                            color: "#fff",
                          },
                        ]}
                      >
                        {tag.name}
                      </Text>
                    </TouchableOpacity>

                    {idx <
                      taggedUsers.length - 1 && (
                      <Text
                        style={[
                          styles.taggedWith,
                          isCurrentUser && {
                            color: "#f0c879",
                          },
                        ]}
                      >
                        ,{" "}
                      </Text>
                    )}
                  </React.Fragment>
                ))}
              </View>
            </View>
          )}
        </TouchableOpacity>

        <View
          style={[
            styles.bubbleFooter,
            isCurrentUser &&
              styles.bubbleFooterRight,
          ]}
        >
          <Text
            style={[
              styles.timeText,
              isCurrentUser &&
                styles.timeTextRight,
            ]}
          >
            {getTimeAgo(item.createdAt)}
          </Text>

          <View style={styles.footerActions}>
            <TouchableOpacity
              onPress={() =>
                onLike(
                  item.id,
                  item.likedBy || [],
                )
              }
              style={styles.footerAction}
            >
              <Ionicons
                name={
                  isLiked
                    ? "heart"
                    : "heart-outline"
                }
                size={13}
                color={
                  isLiked
                    ? "#e0a53d"
                    : "#8f3a2b"
                }
              />

              {(item.likeCount || 0) > 0 && (
                <Text
                  style={
                    styles.footerActionText
                  }
                >
                  {item.likeCount}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() =>
                onReplyClick(
                  item.id,
                  displayName,
                  item.text || "",
                )
              }
              style={styles.footerAction}
            >
              <Ionicons
                name="return-down-forward-outline"
                size={13}
                color="#8f3a2b"
              />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() =>
                onOptionsPress(
                  item,
                  authorRole,
                )
              }
              style={styles.footerAction}
            >
              <Ionicons
                name="ellipsis-horizontal"
                size={13}
                color="#8f3a2b"
              />
            </TouchableOpacity>
          </View>
        </View>

        <AiReplyCard
          reply={item.aiReply}
          compact
        />
      </View>
    </Animated.View>
  );
};

const ReplyThread: React.FC<ReplyThreadProps> = ({
  visible,
  onClose,
  commentId,
  commentAuthor,
  currentUser,
  initialReplyId,
}) => {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [confirmDialog, setConfirmDialog] =
    useState<{
      title: string;
      description?: string;
      confirmText?: string;
      cancelText?: string;
      destructive?: boolean;
      singleAction?: boolean;
      onConfirm: () => void;
    } | null>(null);

  const [loading, setLoading] =
    useState(true);

  // Reply pagination state
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreReplies, setHasMoreReplies] = useState(true);
  const lastReplyDocRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);

  const [imageViewerVisible, setImageViewerVisible] =
    useState(false);

  const [selectedImages, setSelectedImages] =
    useState<string[]>([]);

  const [selectedImageIndex, setSelectedImageIndex] =
    useState(0);

  const [showSeenModal, setShowSeenModal] =
    useState(false);

  const [showReplyActions, setShowReplyActions] =
    useState(false);

  const [selectedActionReply, setSelectedActionReply] =
    useState<Reply | null>(null);

  const [editingReplyId, setEditingReplyId] =
    useState<string | null>(null);

  const [editingReplyText, setEditingReplyText] =
    useState("");

  const [savingEdit, setSavingEdit] =
    useState(false);

  const [selectedReplySeenBy, setSelectedReplySeenBy] =
    useState<string[]>([]);

  const [replyingTo, setReplyingTo] =
    useState<{
      id: string;
      name: string;
      text: string;
    } | null>(null);

  const [keyboardHeight, setKeyboardHeight] =
    useState(0);

  const [highlightedReplyId, setHighlightedReplyId] =
    useState<string | null>(
      initialReplyId || null,
    );

  const relativeTimeNow =
    useRelativeTimeNow();

  const insets = useSafeAreaInsets();
  const flatListRef =
    useRef<FlatList>(null);

  const focusedInitialReplyRef =
    useRef(false);

  const highlightTimeoutRef =
    useRef<ReturnType<
      typeof setTimeout
    > | null>(null);

  const composerBottom =
    useRef(new Animated.Value(0)).current;

  const replyActionsTranslateY =
    useRef(new Animated.Value(0)).current;

  const router = useRouter();

  const hiddenComposerPadding =
    Math.max(
      insets.bottom,
      Platform.OS === "android"
        ? 16
        : 12,
    );

  const scrollToBottom =
    useCallback(() => {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({
          animated: true,
        });
      }, 100);
    }, []);

  const highlightReply =
    useCallback((replyId: string) => {
      setHighlightedReplyId(replyId);

      if (highlightTimeoutRef.current) {
        clearTimeout(
          highlightTimeoutRef.current,
        );
      }

      highlightTimeoutRef.current =
        setTimeout(() => {
          setHighlightedReplyId(
            (current) =>
              current === replyId
                ? null
                : current,
          );

          highlightTimeoutRef.current =
            null;
        }, 2200);
    }, []);

  const navigateToReply =
    useCallback(
      (replyId?: string | null) => {
        if (!replyId) return;

        const replyIndex =
          replies.findIndex(
            (reply) =>
              reply.id === replyId,
          );

        if (replyIndex < 0) return;

        highlightReply(replyId);

        setTimeout(() => {
          flatListRef.current?.scrollToIndex(
            {
              index: replyIndex,
              animated: true,
              viewPosition: 0.5,
            },
          );
        }, 100);
      },
      [highlightReply, replies],
    );

  useEffect(() => {
    const backHandler =
      BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          if (visible) {
            onClose();
            return true;
          }

          return false;
        },
      );

    return () =>
      backHandler.remove();
  }, [visible, onClose]);

  useEffect(() => {
    const showSub =
      Keyboard.addListener(
        Platform.OS === "ios"
          ? "keyboardWillShow"
          : "keyboardDidShow",
        (e: KeyboardEvent) => {
          const nextHeight =
            Math.max(
              0,
              e.endCoordinates.height,
            );

          setKeyboardHeight(
            nextHeight,
          );

          Animated.timing(
            composerBottom,
            {
              toValue:
                nextHeight +
                KEYBOARD_COMPOSER_LIFT,
              duration:
                Platform.OS === "ios"
                  ? e.duration || 250
                  : 220,
              useNativeDriver: false,
            },
          ).start(({ finished }) => {
            if (finished) {
              scrollToBottom();
            }
          });
        },
      );

    const hideSub =
      Keyboard.addListener(
        Platform.OS === "ios"
          ? "keyboardWillHide"
          : "keyboardDidHide",
        (e: KeyboardEvent) => {
          setKeyboardHeight(0);

          Animated.timing(
            composerBottom,
            {
              toValue: 0,
              duration:
                Platform.OS === "ios"
                  ? e.duration || 250
                  : 180,
              useNativeDriver: false,
            },
          ).start();
        },
      );

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [
    composerBottom,
    scrollToBottom,
  ]);

  useEffect(() => {
    if (!commentId) return;

    setLoading(true);

    lastReplyDocRef.current = null;
    setHasMoreReplies(true);

    const q = query(
      collection(db, "replies"),
      where("commentId", "==", commentId),
      orderBy("createdAt", "desc"),
      limit(20),
    );

    const unsubscribe = onSnapshot(
      q,
      async (snapshot) => {
        const fetched =
          snapshot.docs
            .map(
              (d) =>
                ({
                  id: d.id,
                  ...d.data(),
                }) as Reply,
            )
            .filter((item) =>
              canViewModeratedContent({
                moderationStatus:
                  item.moderationStatus,
                realUserId:
                  item.realUserId,
                userId:
                  item.userId,
                viewerUserId:
                  currentUser?.uid,
                viewerRole:
                  currentUser?.role,
              }),
            );

        lastReplyDocRef.current = snapshot.docs[snapshot.docs.length - 1] || null;
        setHasMoreReplies(snapshot.size === 20);
        setReplies(fetched.reverse());
        setLoading(false);

        if (currentUser?.uid) {
          const unseenReplies =
            fetched.filter(
              (reply) =>
                !reply.seenBy?.includes(
                  currentUser.uid,
                ),
            );

          for (const reply of unseenReplies) {
            try {
              await updateDoc(
                doc(
                  db,
                  "replies",
                  reply.id,
                ),
                {
                  seenBy: arrayUnion(
                    currentUser.uid,
                  ),
                },
              );
            } catch {
              // Ignore read receipt failures.
            }
          }
        }
      },
    );

    return unsubscribe;
  }, [
    commentId,
    currentUser?.role,
    currentUser?.uid,
  ]);

  useEffect(() => {
    if (
      !loading &&
      replies.length > 0
    ) {
      if (initialReplyId) {
        if (
          !focusedInitialReplyRef.current
        ) {
          focusedInitialReplyRef.current =
            true;

          navigateToReply(
            initialReplyId,
          );
        }
      } else {
        scrollToBottom();
      }
    }
  }, [
    initialReplyId,
    loading,
    navigateToReply,
    replies,
    scrollToBottom,
  ]);

  useEffect(() => {
    if (!visible) {
      focusedInitialReplyRef.current =
        false;

      setHighlightedReplyId(null);

      if (
        highlightTimeoutRef.current
      ) {
        clearTimeout(
          highlightTimeoutRef.current,
        );

        highlightTimeoutRef.current =
          null;
      }

      setReplyingTo(null);
      setEditingReplyId(null);
      setEditingReplyText("");
      setShowReplyActions(false);
      setSelectedActionReply(null);

      replyActionsTranslateY.setValue(0);
    }
  }, [
    visible,
    replyActionsTranslateY,
  ]);

  const closeReplyActions =
    useCallback(() => {
      Animated.spring(
        replyActionsTranslateY,
        {
          toValue: 0,
          useNativeDriver: true,
        },
      ).start();

      setShowReplyActions(false);
      setSelectedActionReply(null);
    }, [replyActionsTranslateY]);

  const replyActionsPanResponder =
    useRef(
      PanResponder.create({
        onStartShouldSetPanResponder:
          () => true,

        onMoveShouldSetPanResponder: (
          _,
          gestureState,
        ) => {
          return gestureState.dy > 5;
        },

        onPanResponderMove: (
          _,
          gestureState,
        ) => {
          if (gestureState.dy > 0) {
            replyActionsTranslateY.setValue(
              gestureState.dy,
            );
          }
        },

        onPanResponderRelease: (
          _,
          gestureState,
        ) => {
          if (
            gestureState.dy > 120 ||
            gestureState.vy > 0.5
          ) {
            Animated.timing(
              replyActionsTranslateY,
              {
                toValue: 300,
                duration: 180,
                useNativeDriver: true,
              },
            ).start(() => {
              closeReplyActions();
              replyActionsTranslateY.setValue(
                0,
              );
            });
          } else {
            Animated.spring(
              replyActionsTranslateY,
              {
                toValue: 0,
                useNativeDriver: true,
                bounciness: 4,
              },
            ).start();
          }
        },

        onPanResponderTerminate: () => {
          Animated.spring(
            replyActionsTranslateY,
            {
              toValue: 0,
              useNativeDriver: true,
            },
          ).start();
        },
      }),
    ).current;

  const loadMoreReplies = useCallback(async () => {
    if (loadingMore || !hasMoreReplies || !lastReplyDocRef.current || !commentId) return;
    setLoadingMore(true);
    try {
      const nextQuery = query(
        collection(db, "replies"),
        where("commentId", "==", commentId),
        orderBy("createdAt", "desc"),
        startAfter(lastReplyDocRef.current),
        limit(20),
      );
      const snapshot = await getDocs(nextQuery);
      if (snapshot.docs.length > 0) {
        lastReplyDocRef.current = snapshot.docs[snapshot.docs.length - 1];
      }
      setHasMoreReplies(snapshot.size === 20);
      const nextReplies = snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Reply))
        .filter((item) => canViewModeratedContent({
          moderationStatus: item.moderationStatus,
          realUserId: item.realUserId,
          userId: item.userId,
          viewerUserId: currentUser?.uid,
          viewerRole: currentUser?.role,
        })).reverse();
      setReplies((current) => [...nextReplies.filter((next) => !current.some((item) => item.id === next.id)), ...current]);
    } catch (error) {
      console.error("Failed to load more replies:", error);
    } finally {
      setLoadingMore(false);
    }
  }, [commentId, currentUser?.role, currentUser?.uid, hasMoreReplies, loadingMore]);

  const handleSendReply =
    async (replyData: any) => {
      if (!currentUser) return;

      const newReply: any = {
        ...replyData,
        commentId,
        createdAt:
          serverTimestamp(),
        likeCount: 0,
        likedBy: [],
        seenBy: [
          currentUser.uid,
        ],
        ...(replyingTo && {
          replyingTo,
        }),
      };

      // Fast local gate: only clearly prohibited content blocks synchronously.
      // Safe/ambiguous text is written as pending immediately; server moderation
      // continues in the background so the reply composer can reset promptly.
      const localDecision = runLocalModerationRules(
        getModerationPreviewText({
          text: replyData.text,
          linkTitle: replyData.link?.title,
          fileCount: replyData.files?.length,
        }),
      );

      if (localDecision.status === "rejected") {
        setConfirmDialog({
          title: "Reply Blocked",
          description: localDecision.reasons?.[0] || "This reply violates the community guidelines.",
          confirmText: "OK",
          singleAction: true,
          destructive: true,
          onConfirm: () => setConfirmDialog(null),
        });
        return;
      }

      newReply.moderationStatus = "pending";
      newReply.moderationReasons = [];
      newReply.moderationModel = null;
      newReply.moderationRuleSource = null;
      newReply.moderatedAtMs = null;

      const replyRef = await addDoc(collection(db, "replies"), newReply);

      void (async () => {
        let moderationDecision: ModerationDecision;
        try {
        moderationDecision = await requestFirestoreModerationDecision({
          collectionName: "replies",
          documentId: replyRef.id,
          scope: "reply",
        });
      } catch (error) {
        console.warn("[Reply] Server moderation unavailable; reply remains pending:", error);
        setConfirmDialog({
          title: "Reply Pending Review",
          description: "Automatic moderation is temporarily unavailable. Your reply is waiting for moderator approval.",
          confirmText: "OK",
          singleAction: true,
          destructive: false,
          onConfirm: () => setConfirmDialog(null),
        });
        return;
      }

      if (moderationDecision.status !== "approved") {
        setConfirmDialog({
          title: moderationDecision.status === "rejected" ? "Reply Blocked" : "Reply Pending Review",
          description: moderationDecision.reasons?.[0] || (moderationDecision.status === "rejected" ? "This reply was blocked." : "This reply is waiting for moderator approval."),
          confirmText: "OK",
          singleAction: true,
          destructive: moderationDecision.status === "rejected",
          onConfirm: () => setConfirmDialog(null),
        });
        setReplyingTo(null);
        return;
      }

      await updateDoc(
        doc(
          db,
          "comments",
          commentId,
        ),
        {
          replyCount:
            increment(1),
        },
      );

      const commentSnap =
        await getDoc(
          doc(
            db,
            "comments",
            commentId,
          ),
        );

      const commentData =
        commentSnap.exists()
          ? commentSnap.data()
          : null;

      const commentOwnerId =
        commentData?.realUserId ||
        commentData?.userId;

      const replyingToReply =
        replyingTo
          ? replies.find(
              (reply) =>
                reply.id ===
                replyingTo.id,
            )
          : undefined;

      const replyingToOwnerId =
        replyingToReply?.realUserId ||
        replyingToReply?.userId;

      const actor = {
        id: currentUser.uid,
        name:
          replyData.username ||
          "Someone",
        profileImage:
          replyData.isAnonymous === true
            ? null
            : resolveAvatarUri(
                currentUser,
              ),
        isAnonymous:
          replyData.isAnonymous,
      };

      if (
        moderationDecision.status ===
        "approved"
      ) {
        if (
          commentOwnerId &&
          commentOwnerId !==
            currentUser.uid
        ) {
          await createNotification({
            recipientId:
              commentOwnerId,
            actor,
            type: "reply",
            entityType:
              "reply",
            entityId:
              replyRef.id,
            parentId:
              commentId,
            message:
              "replied to your comment",
            preview:
              replyData.text ||
              commentData?.text,
          });
        }

        if (
          replyingToOwnerId &&
          replyingToOwnerId !==
            commentOwnerId &&
          replyingToOwnerId !==
            currentUser.uid
        ) {
          await createNotification({
            recipientId:
              replyingToOwnerId,
            actor,
            type: "reply",
            entityType:
              "reply",
            entityId:
              replyRef.id,
            parentId:
              commentId,
            message:
              "replied to your reply",
            preview:
              replyData.text ||
              replyingToReply?.text,
          });
        }

        await createMentionNotifications({
          recipientIds:
            await resolveMentionRecipientIds(
              {
                taggedUserIds: (
                  replyData.taggedUsers ||
                  []
                )
                  .map(
                    (tag: any) =>
                      tag.id,
                  )
                  .filter(
                    (
                      tagId: string,
                    ) =>
                      !isAiAssistantId(
                        tagId,
                      ),
                  ),
                actorId:
                  currentUser.uid,
                serverId:
                  commentData?.postId ||
                  null,
              },
            ),
          actor,
          entityType:
            "reply",
          entityId:
            replyRef.id,
          parentId:
            commentId,
          message:
            "mentioned you in a reply",
          preview:
            replyData.text,
          excludeUserIds: [
            commentOwnerId,
            replyingToOwnerId,
          ].filter(
            Boolean,
          ) as string[],
        });
      }

      const shouldTriggerAi =
        hasAiAssistantMention(
          replyData.text,
        ) ||
        (
          replyData.taggedUsers ||
          []
        ).some(
          (tag: any) =>
            isAiAssistantId(
              tag.id,
            ),
        );

      if (!shouldTriggerAi) {
        setReplyingTo(null);
        scrollToBottom();
        return;
      }

      const cooldown =
        await reserveAiCooldown(
          "replies",
          commentId,
          AI_REQUEST_COOLDOWN_MS,
        );

      if (!cooldown.allowed) {
        setReplyingTo(null);
        scrollToBottom();
        return;
      }

      try {
        await updateDoc(
          replyRef,
          {
            aiReply: {
              text: "",
              status:
                "generating",
              generatedAtMs:
                Date.now(),
            },
          },
        );

        const prompt =
          summarizeAiVisibleContent({
            text:
              replyData.text,
            username:
              replyData.username,
            isAnonymous:
              replyData.isAnonymous,
            link:
              replyData.link,
            files:
              replyData.files,
            taggedUsers:
              replyData.taggedUsers,
            replyingTo,
          });

        const contextMessages =
          [
            {
              role: "user" as const,
              name: "Comment",
              content:
                commentData?.text?.trim()
                  ? `Parent comment: ${commentData.text.trim()}`
                  : "[comment without text]",
            },

            ...buildAiConversationContext(
              replies.slice(-8),
            ),

            {
              role: "user" as const,
              name:
                replyData.username ||
                "User",
              content: prompt,
            },
          ];

        const {
          reply,
          model,
        } =
          await requestAiReplyFromWorker(
            {
              serverId:
                "replies",
              channelId:
                commentId,
              sourceMessageId:
                replyRef.id,
              sourceUserId:
                currentUser.uid,
              prompt,
              contextMessages,
            },
          );

        await updateDoc(
          replyRef,
          {
            aiReply: {
              text: reply,
              model,
              status:
                "completed",
              generatedAtMs:
                Date.now(),
            },
          },
        );
      } catch (error) {
        console.error(
          "Reply AI request failed:",
          error,
        );

        await updateDoc(
          replyRef,
          {
            aiReply:
              deleteField(),
          },
        ).catch(
          () => undefined,
        );

        setConfirmDialog({
          title:
            "AI Unavailable",
          description:
            getAiErrorMessage(
              error,
            ),
          confirmText:
            "OK",
          singleAction:
            true,
          destructive:
            true,
          onConfirm: () =>
            setConfirmDialog(
              null,
            ),
        });
      }

        })().catch((error) => {
          console.error("[Reply] Background approval finalization failed:", error);
        });

      setReplyingTo(null);
      scrollToBottom();
    };

  const handleLikeReply =
    async (
      replyId: string,
      likedBy: string[],
    ) => {
      if (!currentUser?.uid)
        return;

      const replyRef = doc(
        db,
        "replies",
        replyId,
      );

      const isLiked =
        likedBy.includes(
          currentUser.uid,
        );

      const replyData =
        replies.find(
          (reply) =>
            reply.id === replyId,
        );

      const replyOwnerId =
        replyData?.realUserId ||
        replyData?.userId;

      const actorName =
        currentUser.firstname &&
        currentUser.lastname
          ? `${currentUser.firstname} ${currentUser.lastname}`.trim()
          : "Someone";

      if (!replyOwnerId) {
        return;
      }

      try {
        if (isLiked) {
          await updateDoc(
            replyRef,
            {
              likedBy:
                arrayRemove(
                  currentUser.uid,
                ),
              likeCount:
                increment(-1),
            },
          );

          if (
            replyOwnerId !==
            currentUser.uid
          ) {
            await removeLikeNotification({
              recipientId:
                replyOwnerId,
              actorId:
                currentUser.uid,
              entityType:
                "reply",
              entityId:
                replyId,
            });
          }
        } else {
          await updateDoc(
            replyRef,
            {
              likedBy:
                arrayUnion(
                  currentUser.uid,
                ),
              likeCount:
                increment(1),
            },
          );

          if (
            replyOwnerId !==
            currentUser.uid
          ) {
            await upsertLikeNotification({
              recipientId:
                replyOwnerId,
              actor: {
                id: currentUser.uid,
                name: actorName,
                profileImage:
                  resolveAvatarUri(
                    currentUser,
                  ),
              },
              entityType:
                "reply",
              entityId:
                replyId,
              parentId:
                commentId,
              preview:
                replyData?.text,
            });
          }
        }
      } catch (error) {
        console.error(
          "Failed to update reply like:",
          error,
        );
      }
    };

  const handleDeleteReply =
    async (replyId: string) => {
      setConfirmDialog({
        title:
          "Delete Reply",
        description:
          "Are you sure?",
        confirmText:
          "Delete",
        cancelText:
          "Cancel",
        destructive:
          true,
        onConfirm:
          async () => {
            setConfirmDialog(
              null,
            );

            try {
              await deleteDoc(
                doc(
                  db,
                  "replies",
                  replyId,
                ),
              );

              await updateDoc(
                doc(
                  db,
                  "comments",
                  commentId,
                ),
                {
                  replyCount:
                    increment(-1),
                },
              );
            } catch {
              setConfirmDialog({
                title:
                  "Error",
                description:
                  "Failed to delete",
                confirmText:
                  "OK",
                singleAction:
                  true,
                destructive:
                  true,
                onConfirm: () =>
                  setConfirmDialog(
                    null,
                  ),
              });
            }
          },
      });
    };

  const submitReport =
    async (
      replyId: string,
      reason: string,
    ) => {
      if (!currentUser?.uid)
        return;

      const targetReply = replies.find((reply) => reply.id === replyId);
      const replyOwnerId = targetReply?.realUserId || targetReply?.userId;
      if (replyOwnerId === currentUser.uid) {
        setConfirmDialog({
          title: "Report unavailable",
          description: "You cannot report your own reply.",
          confirmText: "Done",
          singleAction: true,
          destructive: true,
          onConfirm: () => setConfirmDialog(null),
        });
        return;
      }

      try {
        await addDoc(
          collection(
            db,
            "reports",
          ),
          {
            contentType:
              "reply",
            contentId:
              replyId,
            reportedBy:
              currentUser.uid,
            reason,
            createdAt:
              serverTimestamp(),
            status:
              "pending",
          },
        );

        setConfirmDialog({
          title:
            "Reported",
          description:
            "Thank you for your report",
          confirmText:
            "OK",
          singleAction:
            true,
          destructive:
            false,
          onConfirm: () =>
            setConfirmDialog(
              null,
            ),
        });
      } catch {
        setConfirmDialog({
          title:
            "Error",
          description:
            "Failed to report",
          confirmText:
            "OK",
          singleAction:
            true,
          destructive:
            true,
          onConfirm: () =>
            setConfirmDialog(
              null,
            ),
        });
      }
    };

  const handleReportReply =
    (replyId: string) => {
      closeReplyActions();

      setConfirmDialog({
        title: "Report reply?",
        description: "This reply will be sent to the moderation team for review.",
        confirmText: "Send report",
        destructive: true,
        onConfirm: () => submitReport(replyId, "inappropriate"),
      });
    };

  const canManageReply =
    (
      reply: Reply,
      authorRole?: ReturnType<
        typeof parseUserRole
      >,
    ) => {
      const authorUserId =
        reply.realUserId ||
        reply.userId;

      return canDeleteContent({
        viewerRole:
          parseUserRole(
            currentUser?.role,
          ),
        viewerUserId:
          currentUser?.uid,
        authorUserId,
        authorRole,
      });
    };

  const openReplyActions =
    (
      reply: Reply,
      authorRole?: ReturnType<
        typeof parseUserRole
      >,
    ) => {
      replyActionsTranslateY.setValue(
        0,
      );

      setSelectedActionReply({
        ...reply,
        role:
          authorRole ||
          reply.role,
      });

      setShowReplyActions(
        true,
      );
    };

  const startEditReply =
    (reply: Reply) => {
      closeReplyActions();

      setEditingReplyId(
        reply.id,
      );

      setEditingReplyText(
        reply.text || "",
      );
    };

  const cancelEditReply =
    () => {
      if (savingEdit)
        return;

      setEditingReplyId(null);
      setEditingReplyText("");
    };

  const saveEditedReply =
    async () => {
      if (
        !editingReplyId ||
        !currentUser
      ) {
        return;
      }

      const trimmedText =
        editingReplyText.trim();

      if (!trimmedText) {
        setConfirmDialog({
          title:
            "Cannot Save Reply",
          description:
            "Reply text cannot be empty.",
          confirmText:
            "OK",
          singleAction:
            true,
          destructive:
            false,
          onConfirm: () =>
            setConfirmDialog(
              null,
            ),
        });

        return;
      }

      const existingReply =
        replies.find(
          (reply) =>
            reply.id ===
            editingReplyId,
        );

      if (!existingReply) {
        cancelEditReply();
        return;
      }

      setSavingEdit(true);

      try {
        const moderationDecision =
          await requestModerationDecision(
            {
              text:
                getModerationPreviewText(
                  {
                    text:
                      trimmedText,
                  },
                ),
              scope:
                "reply",
              serverId:
                commentId,
              channelId:
                commentId,
              authorId:
                currentUser.uid,
              authorRole:
                currentUser.role,
            },
          );

        await updateDoc(
          doc(
            db,
            "replies",
            editingReplyId,
          ),
          {
            text: trimmedText,
            moderationStatus:
              moderationDecision.status,
            moderationReasons:
              moderationDecision.reasons,
            moderationModel:
              moderationDecision.model ??
              null,
            moderationRuleSource:
              moderationDecision.ruleSource ??
              null,
            moderatedAtMs:
              Date.now(),
            aiReply:
              deleteField(),
          },
        );

        setEditingReplyId(
          null,
        );

        setEditingReplyText(
          "",
        );

        if (
          moderationDecision.status ===
          "pending"
        ) {
          setConfirmDialog({
            title:
              "Reply Pending Review",
            description:
              "Your edited reply was flagged and is waiting for moderator approval.",
            confirmText:
              "OK",
            singleAction:
              true,
            destructive:
              false,
            onConfirm: () =>
              setConfirmDialog(
                null,
              ),
          });
        } else {
          setConfirmDialog({
            title:
              "Reply Updated",
            description:
              "Your reply has been updated successfully.",
            confirmText:
              "Done",
            singleAction:
              true,
            destructive:
              false,
            onConfirm: () =>
              setConfirmDialog(
                null,
              ),
          });
        }
      } catch (error) {
        console.error(
          "Failed to edit reply:",
          error,
        );

        setConfirmDialog({
          title:
            "Error",
          description:
            "Failed to update the reply. Please try again.",
          confirmText:
            "OK",
          singleAction:
            true,
          destructive:
            true,
          onConfirm: () =>
            setConfirmDialog(
              null,
            ),
        });
      } finally {
        setSavingEdit(false);
      }
    };

  const handleLongPress =
    (
      reply: Reply,
      authorRole?: ReturnType<
        typeof parseUserRole
      >,
    ) => {
      openReplyActions(
        reply,
        authorRole,
      );
    };

  const handleProfileClick =
    useCallback(
      (
        reply: Reply,
        profileDocId?: string | null,
      ) => {
        const isAnon =
          reply.isAnonymous ??
          false;

        const uid =
          reply.realUserId ||
          reply.userId;

        if (
          isAnon ||
          !uid ||
          uid === "anonymous"
        ) {
          return;
        }

        try {
          if (
            currentUser &&
            uid === currentUser.uid
          ) {
            router.push({
              pathname:
                "/(main)/(tabs)/ProfileScreen",
              params: {
                returnTo:
                  REPLY_RETURN_ROUTE,
              },
            });
          } else {
            router.push(
              buildUserProfileHref({
                userId: uid,
                profileDocId,
                returnTo:
                  REPLY_RETURN_ROUTE,
              }) as any,
            );
          }
        } catch {
          // Ignore navigation errors.
        }
      },
      [currentUser, router],
    );

  const handleTagClick =
    useCallback(
      (taggedUserId: string) => {
        try {
          if (
            currentUser &&
            taggedUserId ===
              currentUser.uid
          ) {
            router.push({
              pathname:
                "/(main)/(tabs)/ProfileScreen",
              params: {
                returnTo:
                  REPLY_RETURN_ROUTE,
              },
            });
          } else {
            router.push(
              buildUserProfileHref({
                userId:
                  taggedUserId,
                returnTo:
                  REPLY_RETURN_ROUTE,
              }) as any,
            );
          }
        } catch {
          // Ignore navigation errors.
        }
      },
      [currentUser, router],
    );

  const handleLinkPress =
    (url: string) => {
      if (!url.trim()) {
        setConfirmDialog({
          title:
            "Invalid Link",
          description:
            "This link is empty.",
          confirmText:
            "OK",
          singleAction:
            true,
          destructive:
            true,
          onConfirm: () =>
            setConfirmDialog(
              null,
            ),
        });

        return;
      }

      Linking.canOpenURL(url)
        .then((ok) => {
          if (ok) {
            return Linking.openURL(
              url,
            );
          }

          setConfirmDialog({
            title:
              "Invalid Link",
            description:
              "Cannot open this URL",
            confirmText:
              "OK",
            singleAction:
              true,
            destructive:
              true,
            onConfirm: () =>
              setConfirmDialog(
                null,
              ),
          });

          return undefined;
        })
        .catch(() =>
          setConfirmDialog({
            title:
              "Error",
            description:
              "Failed to open link",
            confirmText:
              "OK",
            singleAction:
              true,
            destructive:
              true,
            onConfirm: () =>
              setConfirmDialog(
                null,
              ),
          }),
        );
    };

  const handleFilePress =
    async (url: string) => {
      try {
        const ok =
          await Linking.canOpenURL(
            url,
          );

        if (ok) {
          await Linking.openURL(
            url,
          );
        } else {
          setConfirmDialog({
            title:
              "Error",
            description:
              "Cannot open this file",
            confirmText:
              "OK",
            singleAction:
              true,
            destructive:
              true,
            onConfirm: () =>
              setConfirmDialog(
                null,
              ),
          });
        }
      } catch {
        setConfirmDialog({
          title:
            "Error",
          description:
            "Failed to open file",
          confirmText:
            "OK",
          singleAction:
            true,
          destructive:
            true,
          onConfirm: () =>
            setConfirmDialog(
              null,
            ),
        });
      }
    };

  const handleImagePress =
    (
      images: string[],
      startIndex: number,
    ) => {
      setSelectedImages(
        images,
      );

      setSelectedImageIndex(
        startIndex,
      );

      setImageViewerVisible(
        true,
      );
    };

  const getFileDisplayName =
    (file: {
      url: string;
      mimeType: string;
      name?: string;
    }) => {
      if (file.name) {
        return file.name;
      }

      const parts =
        file.url.split("/");

      const last =
        parts[parts.length - 1];

      const name =
        decodeURIComponent(
          last.split("?")[0],
        );

      return name.length > 28
        ? `${name.slice(0, 25)}...`
        : name;
    };

  const getTimeAgo =
    (timestamp: any) => {
      if (!timestamp) {
        return "";
      }

      const now =
        new Date(
          relativeTimeNow,
        );

      const date =
        timestamp.toDate
          ? timestamp.toDate()
          : new Date(timestamp);

      const diffSec = Math.floor(
        (now.getTime() -
          date.getTime()) /
          1000,
      );

      if (diffSec < 60) {
        return "Just now";
      }

      if (diffSec < 3600) {
        return `${Math.floor(
          diffSec / 60,
        )}m ago`;
      }

      if (diffSec < 86400) {
        return `${Math.floor(
          diffSec / 3600,
        )}h ago`;
      }

      return `${Math.floor(
        diffSec / 86400,
      )}d ago`;
    };

  const shouldShowDateSeparator =
    (
      item: Reply,
      prev?: Reply,
    ) => {
      if (!prev) {
        return true;
      }

      if (
        !item.createdAt ||
        !prev.createdAt
      ) {
        return false;
      }

      const dateA =
        item.createdAt.toDate
          ? item.createdAt.toDate()
          : new Date(
              item.createdAt,
            );

      const dateB =
        prev.createdAt.toDate
          ? prev.createdAt.toDate()
          : new Date(
              prev.createdAt,
            );

      return (
        dateA.toDateString() !==
        dateB.toDateString()
      );
    };

  const formatDateHeader =
    (timestamp: any) => {
      if (!timestamp) {
        return "";
      }

      const date =
        timestamp.toDate
          ? timestamp.toDate()
          : new Date(timestamp);

      const now =
        new Date(
          relativeTimeNow,
        );

      const diffDays =
        Math.floor(
          (now.getTime() -
            date.getTime()) /
            86400000,
        );

      if (diffDays === 0) {
        return "Today";
      }

      if (diffDays === 1) {
        return "Yesterday";
      }

      return date.toLocaleDateString(
        undefined,
        {
          month: "long",
          day: "numeric",
          year:
            diffDays > 365
              ? "numeric"
              : undefined,
        },
      );
    };

  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        onRequestClose={onClose}
      >
        <View style={styles.screen}>
          <View
            style={[
              styles.header,
              {
                paddingTop:
                  insets.top + 10,
              },
            ]}
          >
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{
                top: 16,
                bottom: 16,
                left: 16,
                right: 16,
              }}
              style={styles.backBtn}
            >
              <Ionicons
                name="arrow-back"
                size={24}
                color="#e0a53d"
              />
            </TouchableOpacity>

            <View
              style={styles.headerCenter}
            >
              <Text
                style={
                  styles.headerTitle
                }
              >
                Replies
              </Text>

              <Text
                style={
                  styles.headerSub
                }
              >
                to{" "}
                <Text
                  style={{
                    color:
                      "#e0a53d",
                    fontWeight:
                      "700",
                  }}
                >
                  {commentAuthor}
                </Text>
                {"  ·  "}
                <Text
                  style={{
                    color:
                      "#f0d2c2",
                  }}
                >
                  {replies.length}{" "}
                  {replies.length ===
                  1
                    ? "reply"
                    : "replies"}
                </Text>
              </Text>
            </View>

            <View
              style={{
                width: 40,
              }}
            />
          </View>

          {loading ? (
            <View
              style={styles.centered}
            >
              <ActivityIndicator
                color="#e0a53d"
                size="large"
              />
            </View>
          ) : replies.length ===
            0 ? (
            <View
              style={styles.centered}
            >
              <Ionicons
                name="chatbubbles-outline"
                size={52}
                color="#f0e7e2"
              />

              <Text
                style={
                  styles.emptyTitle
                }
              >
                No replies yet
              </Text>

              <Text
                style={
                  styles.emptySub
                }
              >
                Be the first to reply!
              </Text>
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={replies}
              onStartReached={loadMoreReplies}
              onStartReachedThreshold={0.5}
              ListHeaderComponent={loadingMore ? <ActivityIndicator color="#e0a53d" style={{ marginVertical: 16 }} /> : null}
              keyExtractor={(item) =>
                item.id
              }
              renderItem={({
                item,
                index,
              }) => {
                const prev =
                  index > 0
                    ? replies[
                        index - 1
                      ]
                    : undefined;

                const next =
                  index <
                  replies.length - 1
                    ? replies[
                        index + 1
                      ]
                    : undefined;

                const showDate =
                  shouldShowDateSeparator(
                    item,
                    prev,
                  );

                return (
                  <React.Fragment
                    key={item.id}
                  >
                    {showDate && (
                      <View
                        style={
                          styles.dateSeparator
                        }
                      >
                        <View
                          style={
                            styles.dateLine
                          }
                        />

                        <Text
                          style={
                            styles.dateLabel
                          }
                        >
                          {formatDateHeader(
                            item.createdAt,
                          )}
                        </Text>

                        <View
                          style={
                            styles.dateLine
                          }
                        />
                      </View>
                    )}

                    <ReplyBubble
                      item={item}
                      currentUser={
                        currentUser
                      }
                      prevItem={
                        prev
                      }
                      nextItem={
                        next
                      }
                      onLike={
                        handleLikeReply
                      }
                      onReplyClick={(
                        id,
                        name,
                        text,
                      ) =>
                        setReplyingTo(
                          {
                            id,
                            name,
                            text,
                          },
                        )
                      }
                      onReplyReferencePress={
                        navigateToReply
                      }
                      onLongPress={
                        handleLongPress
                      }
                      onOptionsPress={
                        openReplyActions
                      }
                      onProfileClick={
                        handleProfileClick
                      }
                      onTagClick={
                        handleTagClick
                      }
                      onLinkPress={
                        handleLinkPress
                      }
                      onFilePress={
                        handleFilePress
                      }
                      onImagePress={
                        handleImagePress
                      }
                      getTimeAgo={
                        getTimeAgo
                      }
                      getFileDisplayName={
                        getFileDisplayName
                      }
                      isHighlighted={
                        item.id ===
                        highlightedReplyId
                      }
                    />
                  </React.Fragment>
                );
              }}
              contentContainerStyle={
                styles.listContent
              }
              showsVerticalScrollIndicator={
                false
              }
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={
                Platform.OS === "ios"
                  ? "interactive"
                  : "on-drag"
              }
              onContentSizeChange={() => {
                if (!initialReplyId) {
                  scrollToBottom();
                }
              }}
              onScrollToIndexFailed={(
                info,
              ) => {
                flatListRef.current?.scrollToOffset(
                  {
                    offset: Math.max(
                      0,
                      info.averageItemLength *
                        info.index,
                    ),
                    animated: true,
                  },
                );

                setTimeout(() => {
                  flatListRef.current?.scrollToIndex(
                    {
                      index:
                        info.index,
                      animated:
                        true,
                      viewPosition:
                        0.5,
                    },
                  );
                }, 250);
              }}
            />
          )}

          {currentUser && (
            <Animated.View
              style={[
                styles.composerWrapper,
                {
                  marginBottom:
                    composerBottom,
                  paddingBottom:
                    keyboardHeight >
                    0
                      ? 8
                      : hiddenComposerPadding,
                },
              ]}
            >
              <CommentComposer
                currentUser={
                  currentUser
                }
                onSend={
                  handleSendReply
                }
                placeholder="Reply..."
                replyingTo={
                  replyingTo
                }
                onCancelReply={() =>
                  setReplyingTo(
                    null,
                  )
                }
              />
            </Animated.View>
          )}
        </View>
      </Modal>

      <Modal
        visible={showReplyActions}
        transparent
        animationType="fade"
        onRequestClose={
          closeReplyActions
        }
      >
        <View
          style={styles.actionOverlay}
        >
          <TouchableOpacity
            style={
              StyleSheet.absoluteFill
            }
            activeOpacity={1}
            onPress={
              closeReplyActions
            }
          />

          <Animated.View
            style={[
              styles.actionSheet,
              {
                transform: [
                  {
                    translateY:
                      replyActionsTranslateY,
                  },
                ],
              },
            ]}
            {...replyActionsPanResponder.panHandlers}
          >
            <View
              style={
                styles.actionSheetHandle
              }
            />

            <Text
              style={
                styles.actionSheetTitle
              }
            >
              Reply Actions
            </Text>

            {selectedActionReply && (
              <>
                <TouchableOpacity
                  style={
                    styles.actionMenuItem
                  }
                  activeOpacity={0.75}
                  onPress={() => {
                    const reply =
                      selectedActionReply;

                    closeReplyActions();

                    const uid =
                      reply.realUserId ||
                      reply.userId;

                    const name =
                      !reply.isAnonymous &&
                      uid &&
                      uid !==
                        "anonymous"
                        ? reply.username ||
                          "User"
                        : "Anonymous";

                    setReplyingTo({
                      id: reply.id,
                      name,
                      text:
                        reply.text ||
                        "",
                    });
                  }}
                >
                  <View
                    style={
                      styles.actionMenuItemIcon
                    }
                  >
                    <Ionicons
                      name="return-down-forward-outline"
                      size={20}
                      color="#8f6a60"
                    />
                  </View>

                  <Text
                    style={
                      styles.actionMenuItemText
                    }
                  >
                    Reply
                  </Text>
                </TouchableOpacity>

                {canManageReply(
                  selectedActionReply,
                  parseUserRole(
                    selectedActionReply.role,
                  ),
                ) && (
                  <TouchableOpacity
                    style={
                      styles.actionMenuItem
                    }
                    activeOpacity={
                      0.75
                    }
                    onPress={() =>
                      startEditReply(
                        selectedActionReply,
                      )
                    }
                  >
                    <View
                      style={
                        styles.actionMenuItemIcon
                      }
                    >
                      <Ionicons
                        name="create-outline"
                        size={20}
                        color="#8f6a60"
                      />
                    </View>

                    <Text
                      style={
                        styles.actionMenuItemText
                      }
                    >
                      Edit Reply
                    </Text>
                  </TouchableOpacity>
                )}

                {(
                  selectedActionReply.realUserId ||
                  selectedActionReply.userId
                ) !==
                  currentUser?.uid && (
                  <TouchableOpacity
                    style={
                      styles.actionMenuItem
                    }
                    activeOpacity={
                      0.75
                    }
                    onPress={() =>
                      handleReportReply(
                        selectedActionReply.id,
                      )
                    }
                  >
                    <View
                      style={
                        styles.actionMenuItemIcon
                      }
                    >
                      <Ionicons
                        name="flag-outline"
                        size={20}
                        color="#8f6a60"
                      />
                    </View>

                    <Text
                      style={
                        styles.actionMenuItemText
                      }
                    >
                      Report Reply
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={
                    styles.actionMenuItem
                  }
                  activeOpacity={0.75}
                  onPress={() => {
                    const seenBy =
                      selectedActionReply.seenBy ||
                      [];

                    closeReplyActions();

                    setSelectedReplySeenBy(
                      seenBy,
                    );

                    setShowSeenModal(
                      true,
                    );
                  }}
                >
                  <View
                    style={
                      styles.actionMenuItemIcon
                    }
                  >
                    <Ionicons
                      name="eye-outline"
                      size={20}
                      color="#8f6a60"
                    />
                  </View>

                  <Text
                    style={
                      styles.actionMenuItemText
                    }
                  >
                    Seen by
                  </Text>
                </TouchableOpacity>

                {canManageReply(
                  selectedActionReply,
                  parseUserRole(
                    selectedActionReply.role,
                  ),
                ) && (
                  <TouchableOpacity
                    style={[
                      styles.actionMenuItem,
                      styles.actionMenuItemDanger,
                    ]}
                    activeOpacity={
                      0.75
                    }
                    onPress={() => {
                      const replyId =
                        selectedActionReply.id;

                      closeReplyActions();

                      handleDeleteReply(
                        replyId,
                      );
                    }}
                  >
                    <View
                      style={[
                        styles.actionMenuItemIcon,
                        styles.actionMenuItemIconDanger,
                      ]}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={20}
                        color="#c62828"
                      />
                    </View>

                    <Text
                      style={[
                        styles.actionMenuItemText,
                        styles.actionMenuItemTextDanger,
                      ]}
                    >
                      Delete Reply
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={
                    styles.actionMenuItem
                  }
                  activeOpacity={0.75}
                  onPress={
                    closeReplyActions
                  }
                >
                  <View
                    style={
                      styles.actionMenuItemIcon
                    }
                  >
                    <Ionicons
                      name="close-outline"
                      size={20}
                      color="#8f6a60"
                    />
                  </View>

                  <Text
                    style={
                      styles.actionMenuItemText
                    }
                  >
                    Cancel
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </Animated.View>
        </View>
      </Modal>

      <Modal
        visible={
          !!editingReplyId
        }
        transparent
        animationType="fade"
        onRequestClose={
          cancelEditReply
        }
      >
        <View
          style={styles.editOverlay}
        >
          <View
            style={styles.editSheet}
          >
            <View
              style={styles.editHeader}
            >
              <Text
                style={
                  styles.editTitle
                }
              >
                Edit Reply
              </Text>

              <TouchableOpacity
                onPress={
                  cancelEditReply
                }
                disabled={
                  savingEdit
                }
                hitSlop={{
                  top: 10,
                  bottom: 10,
                  left: 10,
                  right: 10,
                }}
              >
                <Ionicons
                  name="close"
                  size={22}
                  color="#9b766c"
                />
              </TouchableOpacity>
            </View>

            <TextInput
              value={
                editingReplyText
              }
              onChangeText={
                setEditingReplyText
              }
              multiline
              autoFocus
              editable={
                !savingEdit
              }
              placeholder="Write your reply..."
              placeholderTextColor="#b79d93"
              style={
                styles.editInput
              }
              textAlignVertical="top"
            />

            <View
              style={
                styles.editFooter
              }
            >
              <TouchableOpacity
                style={
                  styles.editCancelButton
                }
                onPress={
                  cancelEditReply
                }
                disabled={
                  savingEdit
                }
              >
                <Text
                  style={
                    styles.editCancelText
                  }
                >
                  Cancel
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.editSaveButton,
                  savingEdit &&
                    styles.editSaveButtonDisabled,
                ]}
                onPress={
                  saveEditedReply
                }
                disabled={
                  savingEdit
                }
              >
                {savingEdit ? (
                  <ActivityIndicator
                    size="small"
                    color="#fff"
                  />
                ) : (
                  <Text
                    style={
                      styles.editSaveText
                    }
                  >
                    Done
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showSeenModal}
        transparent
        animationType="fade"
        onRequestClose={() =>
          setShowSeenModal(
            false,
          )
        }
      >
        <TouchableOpacity
          style={styles.overlayDark}
          activeOpacity={1}
          onPress={() =>
            setShowSeenModal(
              false,
            )
          }
        >
          <View
            style={styles.seenSheet}
            onStartShouldSetResponder={() =>
              true
            }
          >
            <View
              style={styles.seenHeader}
            >
              <Text
                style={
                  styles.seenTitle
                }
              >
                Seen by (
                {
                  selectedReplySeenBy.length
                }
                )
              </Text>

              <TouchableOpacity
                onPress={() =>
                  setShowSeenModal(
                    false,
                  )
                }
              >
                <Ionicons
                  name="close"
                  size={22}
                  color="#9b766c"
                />
              </TouchableOpacity>
            </View>

            {selectedReplySeenBy.length ===
            0 ? (
              <View
                style={
                  styles.centered
                }
              >
                <Ionicons
                  name="eye-off-outline"
                  size={42}
                  color="#f0e7e2"
                />

                <Text
                  style={
                    styles.emptySub
                  }
                >
                  No views yet
                </Text>
              </View>
            ) : (
              <FlatList
                data={
                  selectedReplySeenBy
                }
                keyExtractor={(id) =>
                  id
                }
                renderItem={({
                  item: uid,
                }) => (
                  <View
                    style={
                      styles.seenRow
                    }
                  >
                    <View
                      style={
                        styles.seenAvatar
                      }
                    >
                      <Text
                        style={
                          styles.seenAvatarText
                        }
                      >
                        {uid[0]?.toUpperCase()}
                      </Text>
                    </View>

                    <Text
                      style={
                        styles.seenName
                      }
                    >
                      User{" "}
                      {uid.slice(
                        0,
                        8,
                      )}
                      …
                    </Text>
                  </View>
                )}
              />
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      <ImageZoomViewer
        images={
          selectedImages
        }
        startIndex={
          selectedImageIndex
        }
        visible={
          imageViewerVisible
        }
        onClose={() =>
          setImageViewerVisible(
            false,
          )
        }
      />

      <ConfirmDialog
        visible={
          !!confirmDialog
        }
        title={
          confirmDialog?.title ??
          ""
        }
        description={
          confirmDialog?.description
        }
        confirmText={
          confirmDialog?.confirmText
        }
        cancelText={
          confirmDialog?.cancelText
        }
        destructive={
          confirmDialog?.destructive ??
          false
        }
        singleAction={
          confirmDialog?.singleAction ??
          false
        }
        onConfirm={() =>
          confirmDialog?.onConfirm()
        }
        onCancel={() =>
          setConfirmDialog(
            null,
          )
        }
      />
    </>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#f6f1ed",
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#8f3a2b",
    backgroundColor: "#5f0909",
  },

  backBtn: {
    padding: 4,
    marginRight: 4,
  },

  headerCenter: {
    flex: 1,
    alignItems: "center",
  },

  headerTitle: {
    color: "#fffaf7",
    fontSize: 17,
    fontWeight: "700",
  },

  headerSub: {
    color: "#f0d2c2",
    fontSize: 12.5,
    marginTop: 2,
  },

  listContent: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    flexGrow: 1,
  },

  dateSeparator: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 14,
    paddingHorizontal: 8,
    gap: 8,
  },

  dateLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#c78c7d",
  },

  dateLabel: {
    color: "#5f0909",
    fontSize: 11.5,
    fontWeight: "600",
    paddingHorizontal: 6,
    backgroundColor: "#f4e7df",
    borderRadius: 8,
    overflow: "hidden",
    paddingVertical: 3,
    borderWidth: 1,
    borderColor:
      "rgba(95,9,9,0.12)",
  },

  messageRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 4,
  },

  messageRowLeft: {
    justifyContent: "flex-start",
  },

  messageRowRight: {
    justifyContent: "flex-end",
  },

  avatarColumn: {
    width: 36,
    marginRight: 8,
    alignItems: "center",
  },

  avatarPlaceholder: {
    width: 36,
  },

  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#fffaf7",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },

  avatarImg: {
    width: "100%",
    height: "100%",
  },

  avatarInitial: {
    fontSize: 14,
    fontWeight: "700",
  },

  bubbleWrapper: {
    maxWidth: "76%",
    flexShrink: 1,
  },

  bubbleWrapperLeft: {
    alignItems: "flex-start",
  },

  bubbleWrapperRight: {
    alignItems: "flex-end",
  },

  highlightedBubbleWrapper: {
    shadowColor: "#e0a53d",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 3,
  },

  senderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
    paddingHorizontal: 2,
  },

  senderName: {
    fontSize: 12.5,
    fontWeight: "700",
  },

  roleChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },

  roleChipText: {
    fontSize: 9.5,
    fontWeight: "700",
  },

  eyeBtn: {
    padding: 2,
  },

  replyPreview: {
    flexDirection: "row",
    backgroundColor: "#fff4ee",
    borderRadius: 10,
    padding: 8,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: "#e8d3b2",
  },

  replyPreviewRight: {
    backgroundColor: "#8f3a2b",
  },

  replyPreviewBar: {
    width: 3,
    backgroundColor: "#e0a53d",
    borderRadius: 2,
    marginRight: 8,
  },

  replyPreviewAuthor: {
    color: "#5f0909",
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 2,
  },

  replyPreviewText: {
    color: "#9b766c",
    fontSize: 12,
    lineHeight: 16,
  },

  bubble: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minWidth: 60,
  },

  bubbleLeft: {
    backgroundColor: "#fffaf7",
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },

  bubbleRight: {
    backgroundColor: "#e0a53d",
    borderBottomRightRadius: 4,
  },

  bubbleText: {
    color: "#4d1b17",
    fontSize: 15,
    lineHeight: 21,
  },

  bubbleTextRight: {
    color: "#fff",
  },

  replyToggleText: {
    color: "#8f3a2b",
    fontSize: 13,
    fontWeight: "700",
  },

  replyToggleTextRight: {
    color: "#fff7cc",
  },

  gifContainer: {
    marginTop: 6,
    borderRadius: 12,
    overflow: "hidden",
  },

  gifImage: {
    width: 220,
    height: 160,
    backgroundColor: "#f6f1ed",
  },

  imageContainer: {
    marginTop: 6,
    borderRadius: 12,
    overflow: "hidden",
    position: "relative",
  },

  imagePreview: {
    width: 220,
    height: 160,
    backgroundColor: "#f6f1ed",
  },

  imageCountBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor:
      "rgba(0,0,0,0.7)",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },

  imageCountText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },

  docsContainer: {
    marginTop: 6,
    gap: 5,
  },

  docItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#f0e7e2",
    padding: 8,
    borderRadius: 9,
  },

  docItemRight: {
    backgroundColor:
      "rgba(255,255,255,0.18)",
  },

  docText: {
    flex: 1,
    color: "#4d1b17",
    fontSize: 12,
  },

  linkPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f0e7e2",
    padding: 9,
    borderRadius: 10,
    marginTop: 6,
    gap: 6,
  },

  linkPreviewRight: {
    backgroundColor:
      "rgba(255,255,255,0.18)",
    borderColor:
      "rgba(255,255,255,0.2)",
  },

  linkTitle: {
    color: "#4d1b17",
    fontSize: 12.5,
    fontWeight: "600",
    marginBottom: 1,
  },

  linkUrl: {
    color: "#9b766c",
    fontSize: 11,
  },

  taggedRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 3,
    marginTop: 7,
    backgroundColor: "#f0e7e2",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },

  taggedRowRight: {
    backgroundColor:
      "rgba(255,255,255,0.18)",
  },

  taggedWith: {
    color: "#9b766c",
    fontSize: 11,
  },

  taggedNames: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
  },

  taggedName: {
    color: "#ff8ab2",
    fontWeight: "600",
    fontSize: 11.5,
  },

  bubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
    paddingHorizontal: 2,
  },

  bubbleFooterRight: {
    justifyContent: "flex-end",
  },

  timeText: {
    color: "#9b766c",
    fontSize: 11,
  },

  timeTextRight: {
    color: "#9b766c",
  },

  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },

  footerAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "#f5efeb",
    borderWidth: 1,
    borderColor: "#e8d3b2",
  },

  footerActionText: {
    color: "#5f0909",
    fontSize: 11,
    fontWeight: "600",
  },

  composerWrapper: {
    borderTopWidth: 1,
    borderTopColor: "#e8d3b2",
    backgroundColor: "#fff4ee",
    paddingHorizontal: 12,
    paddingTop: 8,
  },

  actionOverlay: {
    flex: 1,
    backgroundColor:
      "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },

  actionSheet: {
    backgroundColor: "#fffaf7",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 18,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },

  actionSheetHandle: {
    width: 42,
    height: 4,
    borderRadius: 999,
    backgroundColor: "#d9c5bc",
    alignSelf: "center",
    marginBottom: 12,
  },

  actionSheetTitle: {
    color: "#4d1b17",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 8,
  },

  actionMenuItem: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderRadius: 12,
    marginTop: 4,
    backgroundColor: "#fff4ee",
    borderWidth: 1,
    borderColor: "#f0e0d7",
  },

  actionMenuItemDanger: {
    backgroundColor: "#fff5f5",
    borderColor: "#f1d2d2",
  },

  actionMenuItemIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f4e7df",
    marginRight: 11,
  },

  actionMenuItemIconDanger: {
    backgroundColor: "#fde7e7",
  },

  actionMenuItemText: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "600",
  },

  actionMenuItemTextDanger: {
    color: "#c62828",
  },

  editOverlay: {
    flex: 1,
    backgroundColor:
      "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },

  editSheet: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: "#fffaf7",
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: "#ead8cf",
  },

  editHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },

  editTitle: {
    color: "#4d1b17",
    fontSize: 17,
    fontWeight: "700",
  },

  editInput: {
    minHeight: 130,
    maxHeight: 240,
    borderWidth: 1,
    borderColor: "#e2cfc6",
    borderRadius: 14,
    backgroundColor: "#fff4ee",
    color: "#4d1b17",
    fontSize: 15,
    lineHeight: 21,
    paddingHorizontal: 13,
    paddingVertical: 12,
  },

  editFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 12,
  },

  editCancelButton: {
    minWidth: 90,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d9c5bc",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },

  editCancelText: {
    color: "#6d4b43",
    fontSize: 14,
    fontWeight: "700",
  },

  editSaveButton: {
    minWidth: 90,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#8f3a2b",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },

  editSaveButtonDisabled: {
    opacity: 0.65,
  },

  editSaveText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },

  overlayDark: {
    flex: 1,
    backgroundColor:
      "rgba(0,0,0,0.82)",
    justifyContent: "center",
    alignItems: "center",
  },

  seenSheet: {
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    width: "86%",
    maxHeight: "60%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },

  seenHeader: {
    flexDirection: "row",
    justifyContent:
      "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#f0e7e2",
  },

  seenTitle: {
    color: "#4d1b17",
    fontSize: 16,
    fontWeight: "700",
  },

  seenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f0e7e2",
  },

  seenAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#f0e7e2",
    justifyContent: "center",
    alignItems: "center",
  },

  seenAvatarText: {
    color: "#ff8ab2",
    fontWeight: "700",
    fontSize: 14,
  },

  seenName: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "500",
  },

  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 40,
  },

  emptyTitle: {
    color: "#4d1b17",
    fontSize: 17,
    fontWeight: "700",
    marginTop: 14,
  },

  emptySub: {
    color: "#9b766c",
    fontSize: 13.5,
    marginTop: 6,
  },
});

export default ReplyThread;

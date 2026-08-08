/* eslint-disable no-empty-pattern */
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  FlatList,
  Image,
  Keyboard,
  KeyboardEvent,
  Linking,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { db } from "../../../Firebase_configure";
import {
  createMentionNotifications,
  createNotification,
  removeLikeNotification,
  resolveMentionRecipientIds,
  upsertLikeNotification,
} from "@/utils/notifications";
import { hasAiAssistantMention, isAiAssistantId } from "@/utils/aiAssistant";
import { getAiErrorMessage } from "@/utils/aiConfig";
import {
  AI_REQUEST_COOLDOWN_MS,
  requestAiReplyFromWorker,
  reserveAiCooldown,
} from "@/utils/aiWorker";
import {
  canViewModeratedContent,
  getModerationPreviewText,
  requestModerationDecision,
} from "@/utils/contentModeration";
import { resolveAvatarUri } from "@/utils/avatar";
import {
  canDeleteContent,
  canViewAnonymousIdentity,
  getRoleColor,
  getRoleDisplayName,
  getUserData,
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
  files?: { url: string; mimeType: string; name?: string }[];
  link?: { url: string; title: string };
  taggedUsers?: { id: string; name: string; studentID: string }[];
  likeCount?: number;
  likedBy?: string[];
  seenBy?: string[];
  replyingTo?: { id: string; name: string; text: string };
  aiReply?: { text: string; model?: string | null; generatedAtMs?: number };
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
  onFilePress: (url: string, name: string) => void;
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
    prevItem &&
    (prevItem.realUserId || prevItem.userId) ===
      (item.realUserId || item.userId) &&
    prevItem.isAnonymous === item.isAnonymous;
  const isSameSenderAsNext =
    nextItem &&
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
    const fetchAuthor = async () => {
      const uid = item.realUserId || item.userId;
      if (uid && uid !== "anonymous") {
        try {
          const data = await getUserData(uid);
          setAuthorData(data);
        } catch {}
      }
    };
    fetchAuthor();
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
      ? `${authorData.firstname} ${authorData.lastname}`
      : item.username || "User"
    : "Anonymous";

  const initial = isIdentityVisible
    ? (authorData?.firstname?.[0] || displayName[0] || "A").toUpperCase()
    : "?";

  const isLiked = (item.likedBy || []).includes(currentUser?.uid || "");

  const imageFiles = (item.files || []).filter(
    (f) => f.mimeType.startsWith("image/") && !f.mimeType.includes("gif"),
  );
  const gifFiles = (item.files || []).filter((f) => f.mimeType.includes("gif"));
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
        isCurrentUser ? styles.messageRowRight : styles.messageRowLeft,
        { opacity: fadeAnim },
        isSameSenderAsPrev ? { marginTop: 2 } : { marginTop: 10 },
      ]}
    >
      {!isCurrentUser && (
        <View style={styles.avatarColumn}>
          {showAvatar ? (
            <TouchableOpacity
              onPress={() => onProfileClick(item, authorData?.studentID)}
              disabled={!isIdentityVisible}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.avatar,
                  isIdentityVisible && isPrivileged
                    ? { borderColor: roleColor, borderWidth: 2 }
                    : { borderColor: "#f0e7e2", borderWidth: 1 },
                ]}
              >
                {isIdentityVisible && avatarUri ? (
                  <Image
                    source={{ uri: avatarUri }}
                    style={styles.avatarImg}
                  />
                ) : isIdentityVisible ? (
                  <Text style={[styles.avatarInitial, { color: roleColor }]}>
                    {initial}
                  </Text>
                ) : (
                  <Ionicons name="person" size={13} color="#9b766c" />
                )}
              </View>
            </TouchableOpacity>
          ) : (
            <View style={styles.avatarPlaceholder} />
          )}
        </View>
      )}

      {/* Bubble */}
      <TouchableOpacity
        onLongPress={() => onLongPress(item, authorRole)}
        activeOpacity={0.88}
        style={[
          styles.bubbleWrapper,
          isCurrentUser ? styles.bubbleWrapperRight : styles.bubbleWrapperLeft,
          isHighlighted && styles.highlightedBubbleWrapper,
        ]}
      >
        {/* Sender name + role chip — only show on first in group, only for others */}
        {!isCurrentUser && showHeader && (
          <View style={styles.senderRow}>
            <TouchableOpacity
              onPress={() => onProfileClick(item, authorData?.studentID)}
              disabled={!isIdentityVisible}
            >
              <Text
                style={[
                  styles.senderName,
                  { color: isIdentityVisible ? roleColor : "#9b766c" },
                ]}
              >
                {displayName}
              </Text>
            </TouchableOpacity>

            {isIdentityVisible && isPrivileged && (
              <View
                style={[
                  styles.roleChip,
                  { backgroundColor: roleColor + "22", borderColor: roleColor },
                ]}
              >
                <Text style={[styles.roleChipText, { color: roleColor }]}>
                  {roleDisplayName}
                </Text>
              </View>
            )}

            {canReveal && (
              <TouchableOpacity
                onPress={() => setRevealed(!revealed)}
                style={styles.eyeBtn}
              >
                <Ionicons
                  name={revealed ? "eye-off-outline" : "eye-outline"}
                  size={13}
                  color={revealed ? "#e0a53d" : "#9b766c"}
                />
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Reply-to preview */}
        {item.replyingTo && (
          <TouchableOpacity
            activeOpacity={0.82}
            onPress={() => onReplyReferencePress(item.replyingTo?.id)}
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
                  isCurrentUser && { color: "#f0c879" },
                ]}
              >
                {item.replyingTo.name}
              </Text>
              <Text
                style={[
                  styles.replyPreviewText,
                  isCurrentUser && { color: "#ffffff99" },
                ]}
                numberOfLines={2}
              >
                {item.replyingTo.text || "Message"}
              </Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Bubble body */}
        <View
          style={[
            styles.bubble,
            isCurrentUser ? styles.bubbleRight : styles.bubbleLeft,
          ]}
        >
          {/* Text */}
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
                isCurrentUser && styles.replyToggleTextRight,
              ]}
            />
          )}

          {/* GIF */}
          {gifFiles.length > 0 && (
            <View style={styles.gifContainer}>
              <Image
                source={{ uri: gifFiles[0].url }}
                style={styles.gifImage}
                resizeMode="cover"
              />
            </View>
          )}

          {/* Images */}
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
                source={{ uri: imageFiles[0].url }}
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

          {/* Docs */}
          {docFiles.length > 0 && (
            <View style={styles.docsContainer}>
              {docFiles.map((file, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={[styles.docItem, isCurrentUser && styles.docItemRight]}
                  onPress={() =>
                    onFilePress(file.url, getFileDisplayName(file))
                  }
                >
                  <Ionicons
                    name={
                      file.mimeType.includes("pdf")
                        ? "document-text"
                        : "document"
                    }
                    size={14}
                    color={isCurrentUser ? "#fff" : "#4f9cff"}
                  />
                  <Text
                    style={[styles.docText, isCurrentUser && { color: "#fff" }]}
                    numberOfLines={1}
                  >
                    {getFileDisplayName(file)}
                  </Text>
                  <Ionicons
                    name="download-outline"
                    size={12}
                    color={isCurrentUser ? "#ffffff99" : "#9b766c"}
                  />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Link */}
          {item.link && (
            <TouchableOpacity
              style={[
                styles.linkPreview,
                isCurrentUser && styles.linkPreviewRight,
              ]}
              onPress={() => onLinkPress(item.link?.url ?? "")}
            >
              <Ionicons
                name="link"
                size={13}
                color={isCurrentUser ? "#fff" : "#4f9cff"}
              />
              <View style={{ flex: 1, marginLeft: 6 }}>
                <Text
                  style={[styles.linkTitle, isCurrentUser && { color: "#fff" }]}
                  numberOfLines={1}
                >
                  {item.link?.title ?? "Link"}
                </Text>
                <Text
                  style={[
                    styles.linkUrl,
                    isCurrentUser && { color: "#ffffff99" },
                  ]}
                  numberOfLines={1}
                >
                  {item.link?.url ?? ""}
                </Text>
              </View>
              <Ionicons
                name="open-outline"
                size={11}
                color={isCurrentUser ? "#ffffff99" : "#9b766c"}
              />
            </TouchableOpacity>
          )}

          {/* Tagged users */}
          {taggedUsers.length > 0 && (
            <View
              style={[styles.taggedRow, isCurrentUser && styles.taggedRowRight]}
            >
              <Ionicons
                name="people-outline"
                size={11}
                color={isCurrentUser ? "#f0c879" : "#e0a53d"}
              />
              <Text
                style={[
                  styles.taggedWith,
                  isCurrentUser && { color: "#f0c879" },
                ]}
              >
                with{" "}
              </Text>
              <View style={styles.taggedNames}>
                {taggedUsers.map((tag, idx) => (
                  <React.Fragment key={tag.id}>
                    <TouchableOpacity onPress={() => onTagClick(tag.id)}>
                      <Text
                        style={[
                          styles.taggedName,
                          isCurrentUser && { color: "#fff" },
                        ]}
                      >
                        {tag.name}
                      </Text>
                    </TouchableOpacity>
                    {idx < taggedUsers.length - 1 && (
                      <Text
                        style={[
                          styles.taggedWith,
                          isCurrentUser && { color: "#f0c879" },
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
        </View>

        {/* Footer: time + actions */}
        <View
          style={[
            styles.bubbleFooter,
            isCurrentUser && styles.bubbleFooterRight,
          ]}
        >
          <Text
            style={[styles.timeText, isCurrentUser && styles.timeTextRight]}
          >
            {getTimeAgo(item.createdAt)}
          </Text>

          <View style={styles.footerActions}>
            <TouchableOpacity
              onPress={() => onLike(item.id, item.likedBy || [])}
              style={styles.footerAction}
            >
              <Ionicons
                name={isLiked ? "heart" : "heart-outline"}
                size={13}
                color={isLiked ? "#e0a53d" : "#8f3a2b"}
              />
              {(item.likeCount || 0) > 0 && (
                <Text style={styles.footerActionText}>{item.likeCount}</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() =>
                onReplyClick(item.id, displayName, item.text || "")
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
              onPress={() => onOptionsPress(item, authorRole)}
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

        <AiReplyCard reply={item.aiReply} compact />
      </TouchableOpacity>
    </Animated.View>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────
const ReplyThread: React.FC<ReplyThreadProps> = ({
  visible,
  onClose,
  commentId,
  commentAuthor,
  currentUser,
  initialReplyId,
}) => {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [showSeenModal, setShowSeenModal] = useState(false);
  const [selectedReplySeenBy, setSelectedReplySeenBy] = useState<string[]>([]);
  const [replyingTo, setReplyingTo] = useState<{
    id: string;
    name: string;
    text: string;
  } | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [highlightedReplyId, setHighlightedReplyId] = useState<string | null>(
    initialReplyId || null,
  );
  const [] = useState<{ [uid: string]: any }>({});
  const relativeTimeNow = useRelativeTimeNow();

  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList>(null);
  const focusedInitialReplyRef = useRef(false);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerBottom = useRef(new Animated.Value(0)).current;
  const router = useRouter();
  const hiddenComposerPadding = Math.max(
    insets.bottom,
    Platform.OS === "android" ? 16 : 12,
  );

  // Scroll to bottom when new message arrives
  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, []);

  const highlightReply = useCallback((replyId: string) => {
    setHighlightedReplyId(replyId);
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedReplyId((current) => (current === replyId ? null : current));
      highlightTimeoutRef.current = null;
    }, 2200);
  }, []);

  const navigateToReply = useCallback(
    (replyId?: string | null) => {
      if (!replyId) return;
      const replyIndex = replies.findIndex((reply) => reply.id === replyId);
      if (replyIndex < 0) return;

      highlightReply(replyId);

      setTimeout(() => {
        flatListRef.current?.scrollToIndex({
          index: replyIndex,
          animated: true,
          viewPosition: 0.5,
        });
      }, 100);
    },
    [highlightReply, replies],
  );

  useEffect(() => {
    const backHandler = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (visible) {
          onClose();
          return true;
        }
        return false;
      },
    );
    return () => backHandler.remove();
  }, [visible, onClose]);

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
            scrollToBottom();
          }
        });
      },
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
      },
    );

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [composerBottom, scrollToBottom]);

  useEffect(() => {
    if (!commentId) return;
    const q = query(
      collection(db, "replies"),
      where("commentId", "==", commentId),
      orderBy("createdAt", "asc"),
    );

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const fetched = (snapshot.docs
        .map((d) => ({
          id: d.id,
          ...d.data(),
        })) as Reply[])
        .filter((item) =>
          canViewModeratedContent({
            moderationStatus: item.moderationStatus,
            realUserId: item.realUserId,
            userId: item.userId,
            viewerUserId: currentUser?.uid,
            viewerRole: currentUser?.role,
          }),
        );
      setReplies(fetched);
      setLoading(false);

      // Mark as seen
      if (currentUser?.uid) {
        for (const reply of fetched) {
          if (!reply.seenBy?.includes(currentUser.uid)) {
            try {
              await updateDoc(doc(db, "replies", reply.id), {
                seenBy: arrayUnion(currentUser.uid),
              });
            } catch {}
          }
        }
      }
    });

    return unsubscribe;
  }, [commentId, currentUser?.role, currentUser?.uid]);

  // Scroll to bottom when replies load for the first time
  useEffect(() => {
    if (!loading && replies.length > 0) {
      if (initialReplyId) {
        focusedInitialReplyRef.current = true;
        navigateToReply(initialReplyId);
      } else {
        scrollToBottom();
      }
    }
  }, [initialReplyId, loading, navigateToReply, replies, scrollToBottom]);

  useEffect(() => {
    if (!visible) {
      focusedInitialReplyRef.current = false;
      setHighlightedReplyId(null);
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
    }
  }, [visible]);

  const handleSendReply = async (replyData: any) => {
    if (!currentUser) return;

    const newReply = {
      ...replyData,
      commentId,
      createdAt: serverTimestamp(),
      likeCount: 0,
      likedBy: [],
      seenBy: [currentUser.uid],
      ...(replyingTo && { replyingTo }),
    };
    const moderationDecision = await requestModerationDecision({
      text: getModerationPreviewText({
        text: replyData.text,
        linkTitle: replyData.link?.title,
        fileCount: replyData.files?.length,
      }),
      scope: "reply",
      serverId: commentId,
      channelId: commentId,
      authorId: currentUser.uid,
      authorRole: currentUser.role,
    });
    newReply.moderationStatus = moderationDecision.status;
    newReply.moderationReasons = moderationDecision.reasons;
    newReply.moderatedAtMs = Date.now();
    const replyRef = await addDoc(collection(db, "replies"), newReply);
    await updateDoc(doc(db, "comments", commentId), {
      replyCount: (replies.length || 0) + 1,
    });

    const commentSnap = await getDoc(doc(db, "comments", commentId));
    const commentData = commentSnap.exists() ? commentSnap.data() : null;
    const commentOwnerId = commentData?.realUserId || commentData?.userId;
    const replyingToReply = replyingTo
      ? replies.find((reply) => reply.id === replyingTo.id)
      : undefined;
    const replyingToOwnerId =
      replyingToReply?.realUserId || replyingToReply?.userId;
    const actor = {
      id: currentUser.uid,
      name: replyData.username,
      profileImage:
        replyData.isAnonymous === true
          ? null
          : resolveAvatarUri(currentUser),
      isAnonymous: replyData.isAnonymous,
    };

    if (moderationDecision.status !== "pending") {
      await createNotification({
        recipientId: commentOwnerId,
        actor,
        type: "reply",
        entityType: "reply",
        entityId: replyRef.id,
        parentId: commentId,
        message: "replied to your comment",
        preview: replyData.text || commentData?.text,
      });

      if (replyingToOwnerId && replyingToOwnerId !== commentOwnerId) {
        await createNotification({
          recipientId: replyingToOwnerId,
          actor,
          type: "reply",
          entityType: "reply",
          entityId: replyRef.id,
          parentId: commentId,
          message: "replied to your reply",
          preview: replyData.text || replyingToReply?.text,
        });
      }

      await createMentionNotifications({
        recipientIds: await resolveMentionRecipientIds({
          taggedUserIds: (replyData.taggedUsers || [])
            .map((tag: any) => tag.id)
            .filter((tagId: string) => !isAiAssistantId(tagId)),
          actorId: currentUser.uid,
          serverId: commentData?.postId || null,
        }),
        actor,
        entityType: "reply",
        entityId: replyRef.id,
        parentId: commentId,
        message: "mentioned you in a reply",
        preview: replyData.text,
        excludeUserIds: [commentOwnerId, replyingToOwnerId].filter(
          Boolean,
        ) as string[],
      });
    }

    const shouldTriggerAi =
      hasAiAssistantMention(replyData.text) ||
      (replyData.taggedUsers || []).some((tag: any) => isAiAssistantId(tag.id));

    if (!shouldTriggerAi || moderationDecision.status === "pending") {
      if (moderationDecision.status === "pending") {
        Alert.alert(
          "Reply Pending Review",
          "This reply was flagged and is waiting for moderator approval.",
        );
      }
      setReplyingTo(null);
      scrollToBottom();
      return;
    }

    const cooldown = await reserveAiCooldown("replies", commentId, AI_REQUEST_COOLDOWN_MS);
    if (!cooldown.allowed) {
      setReplyingTo(null);
      scrollToBottom();
      return;
    }

    try {
      await updateDoc(replyRef, {
        aiReply: {
          text: "",
          status: "generating",
          generatedAtMs: Date.now(),
        },
      });

      const prompt =
        summarizeAiVisibleContent({
          text: replyData.text,
          username: replyData.username,
          isAnonymous: replyData.isAnonymous,
          link: replyData.link,
          files: replyData.files,
          taggedUsers: replyData.taggedUsers,
          replyingTo,
        });
      const contextMessages = [
        {
          role: "user" as const,
          name: "Comment",
          content: commentData?.text?.trim()
            ? `Parent comment: ${commentData.text.trim()}`
            : "[comment without text]",
        },
        ...buildAiConversationContext(replies.slice(-8)),
        {
          role: "user" as const,
          name: replyData.username || "User",
          content: prompt,
        },
      ];

      const { reply, model } = await requestAiReplyFromWorker({
        serverId: "replies",
        channelId: commentId,
        sourceMessageId: replyRef.id,
        sourceUserId: currentUser.uid,
        prompt,
        contextMessages,
      });

      await updateDoc(replyRef, {
        aiReply: {
          text: reply,
          model,
          status: "completed",
          generatedAtMs: Date.now(),
        },
      });
    } catch (error) {
      console.error("Reply AI request failed:", error);
      await updateDoc(replyRef, {
        aiReply: deleteField(),
      }).catch(() => undefined);
      Alert.alert("AI Unavailable", getAiErrorMessage(error));
    }

    setReplyingTo(null);
    scrollToBottom();
  };

  const handleLikeReply = async (replyId: string, likedBy: string[]) => {
    if (!currentUser?.uid) return;
    const replyRef = doc(db, "replies", replyId);
    const isLiked = likedBy.includes(currentUser.uid);
    const replyData = replies.find((reply) => reply.id === replyId);
    const replyOwnerId = replyData?.realUserId || replyData?.userId;
    const actorName =
      currentUser.firstname && currentUser.lastname
        ? `${currentUser.firstname} ${currentUser.lastname}`.trim()
        : "Someone";

    try {
      if (isLiked) {
        await updateDoc(replyRef, {
          likedBy: arrayRemove(currentUser.uid),
          likeCount: Math.max(0, likedBy.length - 1),
        });

        await removeLikeNotification({
          recipientId: replyOwnerId,
          actorId: currentUser.uid,
          entityType: "reply",
          entityId: replyId,
        });
      } else {
        await updateDoc(replyRef, {
          likedBy: arrayUnion(currentUser.uid),
          likeCount: likedBy.length + 1,
        });

        await upsertLikeNotification({
          recipientId: replyOwnerId,
          actor: {
            id: currentUser.uid,
            name: actorName,
            profileImage: resolveAvatarUri(currentUser),
          },
          entityType: "reply",
          entityId: replyId,
          parentId: commentId,
          preview: replyData?.text,
        });
      }
    } catch {}
  };

  const handleDeleteReply = async (replyId: string) => {
    Alert.alert("Delete Reply", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteDoc(doc(db, "replies", replyId));
            await updateDoc(doc(db, "comments", commentId), {
              replyCount: increment(-1),
            });
          } catch {
            Alert.alert("Error", "Failed to delete");
          }
        },
      },
    ]);
  };

  const handleReportReply = (replyId: string) => {
    Alert.alert("Report Reply", "Select a reason:", [
      { text: "Cancel", style: "cancel" },
      { text: "Spam", onPress: () => submitReport(replyId, "spam") },
      {
        text: "Harassment",
        onPress: () => submitReport(replyId, "harassment"),
      },
      {
        text: "Inappropriate",
        onPress: () => submitReport(replyId, "inappropriate"),
      },
    ]);
  };

  const submitReport = async (replyId: string, reason: string) => {
    try {
      await addDoc(collection(db, "reports"), {
        contentType: "reply",
        contentId: replyId,
        reportedBy: currentUser.uid,
        reason,
        createdAt: serverTimestamp(),
        status: "pending",
      });
      Alert.alert("Reported", "Thank you for your report");
    } catch {
      Alert.alert("Error", "Failed to report");
    }
  };

  const handleLongPress = (reply: Reply, authorRole?: ReturnType<typeof parseUserRole>) => {
    const authorUserId = reply.realUserId || reply.userId;
    const isOwner = authorUserId === currentUser?.uid;
    const canDelete = canDeleteContent({
      viewerRole: parseUserRole(currentUser?.role),
      viewerUserId: currentUser?.uid,
      authorUserId,
      authorRole,
    });

    const options: { text: string; style?: any; onPress: () => void }[] = [
      {
        text: "Reply",
        onPress: () => {
          const uid = reply.realUserId || reply.userId;
          const name =
            !reply.isAnonymous && uid && uid !== "anonymous"
              ? reply.username || "User"
              : "Anonymous";
          setReplyingTo({ id: reply.id, name, text: reply.text || "" });
        },
      },
    ];

    if (!isOwner) {
      options.push({
        text: "Report",
        onPress: () => handleReportReply(reply.id),
      });
    }

    options.push({
      text: "Seen by",
      onPress: () => {
        setSelectedReplySeenBy(reply.seenBy || []);
        setShowSeenModal(true);
      },
    });

    if (canDelete) {
      options.push({
        text: "Delete",
        style: "destructive",
        onPress: () => handleDeleteReply(reply.id),
      });
    }

    Alert.alert("Options", undefined, [
      ...options,
      { text: "Cancel", style: "cancel", onPress: () => {} },
    ]);
  };

  const handleProfileClick = useCallback(
    (reply: Reply, profileDocId?: string | null) => {
      const isAnon = reply.isAnonymous ?? false;
      const uid = reply.realUserId || reply.userId;
      if (isAnon || !uid || uid === "anonymous") return;
      try {
        if (currentUser && uid === currentUser.uid) {
          router.push({
            pathname: "/(main)/(tabs)/ProfileScreen",
            params: { returnTo: REPLY_RETURN_ROUTE },
          });
        } else {
          router.push(
            buildUserProfileHref({
              userId: uid,
              profileDocId,
              returnTo: REPLY_RETURN_ROUTE,
            }) as any,
          );
        }
      } catch {}
    },
    [currentUser, router],
  );

  const handleTagClick = useCallback(
    (taggedUserId: string) => {
      try {
        if (currentUser && taggedUserId === currentUser.uid) {
          router.push({
            pathname: "/(main)/(tabs)/ProfileScreen",
            params: { returnTo: REPLY_RETURN_ROUTE },
          });
        } else {
          router.push(
            buildUserProfileHref({
              userId: taggedUserId,
              returnTo: REPLY_RETURN_ROUTE,
            }) as any,
          );
        }
      } catch {}
    },
    [currentUser, router],
  );

  const handleLinkPress = (url: string) => {
    Linking.canOpenURL(url)
      .then((ok) => {
        if (ok) Linking.openURL(url);
        else Alert.alert("Invalid Link", "Cannot open this URL");
      })
      .catch(() => Alert.alert("Error", "Failed to open link"));
  };

  const handleFilePress = async (url: string, filename: string) => {
    try {
      const ok = await Linking.canOpenURL(url);
      if (ok) await Linking.openURL(url);
      else Alert.alert("Error", "Cannot open this file");
    } catch {
      Alert.alert("Error", "Failed to open file");
    }
  };

  const handleImagePress = (images: string[], startIndex: number) => {
    setSelectedImages(images);
    setSelectedImageIndex(startIndex);
    setImageViewerVisible(true);
  };

  const getFileDisplayName = (file: {
    url: string;
    mimeType: string;
    name?: string;
  }) => {
    if (file.name) return file.name;
    const parts = file.url.split("/");
    const last = parts[parts.length - 1];
    const name = decodeURIComponent(last.split("?")[0]);
    return name.length > 28 ? name.slice(0, 25) + "..." : name;
  };

  const getTimeAgo = (timestamp: any) => {
    if (!timestamp) return "";
    const now = new Date(relativeTimeNow);
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSec < 60) return "Just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  };

  // Date separator logic
  const shouldShowDateSeparator = (item: Reply, prev?: Reply) => {
    if (!prev) return true;
    if (!item.createdAt || !prev.createdAt) return false;
    const dateA = item.createdAt.toDate
      ? item.createdAt.toDate()
      : new Date(item.createdAt);
    const dateB = prev.createdAt.toDate
      ? prev.createdAt.toDate()
      : new Date(prev.createdAt);
    return dateA.toDateString() !== dateB.toDateString();
  };

  const formatDateHeader = (timestamp: any) => {
    if (!timestamp) return "";
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date(relativeTimeNow);
    const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    return date.toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: diffDays > 365 ? "numeric" : undefined,
    });
  };

  return (
    <>
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={styles.screen}>
          {/* ── Header ── */}
          <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
              style={styles.backBtn}
            >
              <Ionicons name="arrow-back" size={24} color="#e0a53d" />
            </TouchableOpacity>

            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle}>Replies</Text>
              <Text style={styles.headerSub}>
                to{" "}
                <Text style={{ color: "#e0a53d", fontWeight: "700" }}>
                  {commentAuthor}
                </Text>
                {"  ·  "}
                <Text style={{ color: "#f0d2c2" }}>
                  {replies.length} {replies.length === 1 ? "reply" : "replies"}
                </Text>
              </Text>
            </View>

            <View style={{ width: 40 }} />
          </View>

          {/* ── Body ── */}
          {loading ? (
            <View style={styles.centered}>
              <ActivityIndicator color="#e0a53d" size="large" />
            </View>
          ) : replies.length === 0 ? (
            <View style={styles.centered}>
              <Ionicons name="chatbubbles-outline" size={52} color="#f0e7e2" />
              <Text style={styles.emptyTitle}>No replies yet</Text>
              <Text style={styles.emptySub}>Be the first to reply!</Text>
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={replies}
              keyExtractor={(item) => item.id}
              renderItem={({ item, index }) => {
                const prev = index > 0 ? replies[index - 1] : undefined;
                const next =
                  index < replies.length - 1 ? replies[index + 1] : undefined;
                const showDate = shouldShowDateSeparator(item, prev);
                return (
                  <>
                    {showDate && (
                      <View style={styles.dateSeparator}>
                        <View style={styles.dateLine} />
                        <Text style={styles.dateLabel}>
                          {formatDateHeader(item.createdAt)}
                        </Text>
                        <View style={styles.dateLine} />
                      </View>
                    )}
                    <ReplyBubble
                      item={item}
                      currentUser={currentUser}
                      prevItem={prev}
                      nextItem={next}
                      onLike={handleLikeReply}
                      onReplyClick={(id, name, text) =>
                        setReplyingTo({ id, name, text })
                      }
                      onReplyReferencePress={navigateToReply}
                      onLongPress={handleLongPress}
                      onOptionsPress={handleLongPress}
                      onProfileClick={handleProfileClick}
                      onTagClick={handleTagClick}
                      onLinkPress={handleLinkPress}
                      onFilePress={handleFilePress}
                      onImagePress={handleImagePress}
                      getTimeAgo={getTimeAgo}
                      getFileDisplayName={getFileDisplayName}
                      isHighlighted={item.id === highlightedReplyId}
                    />
                  </>
                );
              }}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={
                Platform.OS === "ios" ? "interactive" : "on-drag"
              }
              onContentSizeChange={() => {
                if (!initialReplyId) {
                  scrollToBottom();
                }
              }}
              onScrollToIndexFailed={(info) => {
                flatListRef.current?.scrollToOffset({
                  offset: Math.max(0, info.averageItemLength * info.index),
                  animated: true,
                });
                setTimeout(() => {
                  flatListRef.current?.scrollToIndex({
                    index: info.index,
                    animated: true,
                    viewPosition: 0.5,
                  });
                }, 250);
              }}
            />
          )}

          {/* ── Composer ── */}
          {currentUser && (
            <Animated.View
              style={[
                styles.composerWrapper,
                {
                  marginBottom: composerBottom,
                  paddingBottom: keyboardHeight > 0 ? 8 : hiddenComposerPadding,
                },
              ]}
            >
              <CommentComposer
                currentUser={currentUser}
                onSend={handleSendReply}
                placeholder="Reply..."
                replyingTo={replyingTo}
                onCancelReply={() => setReplyingTo(null)}
              />
            </Animated.View>
          )}
        </View>
      </Modal>

      {/* ── Seen-by modal ── */}
      <Modal
        visible={showSeenModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSeenModal(false)}
      >
        <TouchableOpacity
          style={styles.overlayDark}
          activeOpacity={1}
          onPress={() => setShowSeenModal(false)}
        >
          <View style={styles.seenSheet} onStartShouldSetResponder={() => true}>
            <View style={styles.seenHeader}>
              <Text style={styles.seenTitle}>
                Seen by ({selectedReplySeenBy.length})
              </Text>
              <TouchableOpacity onPress={() => setShowSeenModal(false)}>
                <Ionicons name="close" size={22} color="#9b766c" />
              </TouchableOpacity>
            </View>
            {selectedReplySeenBy.length === 0 ? (
              <View style={styles.centered}>
                <Ionicons name="eye-off-outline" size={42} color="#f0e7e2" />
                <Text style={styles.emptySub}>No views yet</Text>
              </View>
            ) : (
              <FlatList
                data={selectedReplySeenBy}
                keyExtractor={(id) => id}
                renderItem={({ item: uid }) => (
                  <View style={styles.seenRow}>
                    <View style={styles.seenAvatar}>
                      <Text style={styles.seenAvatarText}>
                        {uid[0]?.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.seenName}>User {uid.slice(0, 8)}…</Text>
                  </View>
                )}
              />
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Image viewer ── */}
      <ImageZoomViewer
        images={selectedImages}
        startIndex={selectedImageIndex}
        visible={imageViewerVisible}
        onClose={() => setImageViewerVisible(false)}
      />
    </>
  );
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f6f1ed" },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#8f3a2b",
    backgroundColor: "#5f0909",
  },
  backBtn: { padding: 4, marginRight: 4 },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle: { color: "#fffaf7", fontSize: 17, fontWeight: "700" },
  headerSub: { color: "#f0d2c2", fontSize: 12.5, marginTop: 2 },

  // List
  listContent: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    flexGrow: 1,
  },

  // Date separator
  dateSeparator: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 14,
    paddingHorizontal: 8,
    gap: 8,
  },
  dateLine: { flex: 1, height: 1, backgroundColor: "#c78c7d" },
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
    borderColor: "rgba(95,9,9,0.12)",
  },

  // Message row
  messageRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 4,
  },
  messageRowLeft: { justifyContent: "flex-start" },
  messageRowRight: { justifyContent: "flex-end" },

  // Avatar
  avatarColumn: { width: 36, marginRight: 8, alignItems: "center" },
  avatarPlaceholder: { width: 36 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#fffaf7",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInitial: { fontSize: 14, fontWeight: "700" },

  // Bubble wrapper
  bubbleWrapper: { maxWidth: "76%", flexShrink: 1 },
  bubbleWrapperLeft: { alignItems: "flex-start" },
  bubbleWrapperRight: { alignItems: "flex-end" },
  highlightedBubbleWrapper: {
    shadowColor: "#e0a53d",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 3,
  },

  // Sender row
  senderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  senderName: { fontSize: 12.5, fontWeight: "700" },
  roleChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  roleChipText: { fontSize: 9.5, fontWeight: "700" },
  eyeBtn: { padding: 2 },

  // Reply preview
  replyPreview: {
    flexDirection: "row",
    backgroundColor: "#fff4ee",
    borderRadius: 10,
    padding: 8,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: "#e8d3b2",
  },
  replyPreviewRight: { backgroundColor: "#8f3a2b" },
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
  replyPreviewText: { color: "#9b766c", fontSize: 12, lineHeight: 16 },

  // Bubble
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
  bubbleText: { color: "#4d1b17", fontSize: 15, lineHeight: 21 },
  bubbleTextRight: { color: "#fff" },
  replyToggleText: { color: "#8f3a2b", fontSize: 13, fontWeight: "700" },
  replyToggleTextRight: { color: "#fff7cc" },

  // GIF
  gifContainer: { marginTop: 6, borderRadius: 12, overflow: "hidden" },
  gifImage: { width: 220, height: 160, backgroundColor: "#f6f1ed" },

  // Image
  imageContainer: {
    marginTop: 6,
    borderRadius: 12,
    overflow: "hidden",
    position: "relative",
  },
  imagePreview: { width: 220, height: 160, backgroundColor: "#f6f1ed" },
  imageCountBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: "rgba(0,0,0,0.7)",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  imageCountText: { color: "#fff", fontSize: 11, fontWeight: "700" },

  // Docs
  docsContainer: { marginTop: 6, gap: 5 },
  docItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#f0e7e2",
    padding: 8,
    borderRadius: 9,
  },
  docItemRight: { backgroundColor: "rgba(255,255,255,0.18)" },
  docText: { flex: 1, color: "#4d1b17", fontSize: 12 },

  // Link
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
    backgroundColor: "rgba(255,255,255,0.18)",
    borderColor: "rgba(255,255,255,0.2)",
  },
  linkTitle: {
    color: "#4d1b17",
    fontSize: 12.5,
    fontWeight: "600",
    marginBottom: 1,
  },
  linkUrl: { color: "#9b766c", fontSize: 11 },

  // Tagged
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
  taggedRowRight: { backgroundColor: "rgba(255,255,255,0.18)" },
  taggedWith: { color: "#9b766c", fontSize: 11 },
  taggedNames: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  taggedName: { color: "#ff8ab2", fontWeight: "600", fontSize: 11.5 },

  // Footer
  bubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
    paddingHorizontal: 2,
  },
  bubbleFooterRight: { justifyContent: "flex-end" },
  timeText: { color: "#9b766c", fontSize: 11 },
  timeTextRight: { color: "#9b766c" },
  footerActions: { flexDirection: "row", alignItems: "center", gap: 12 },
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
  footerActionText: { color: "#5f0909", fontSize: 11, fontWeight: "600" },

  // Composer wrapper
  composerWrapper: {
    borderTopWidth: 1,
    borderTopColor: "#e8d3b2",
    backgroundColor: "#fff4ee",
    paddingHorizontal: 12,
    paddingTop: 8,
  },

  // Seen modal
  overlayDark: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.82)",
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
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#f0e7e2",
  },
  seenTitle: { color: "#4d1b17", fontSize: 16, fontWeight: "700" },
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
  seenAvatarText: { color: "#ff8ab2", fontWeight: "700", fontSize: 14 },
  seenName: { color: "#4d1b17", fontSize: 14, fontWeight: "500" },

  // Centered (empty / loading)
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
  emptySub: { color: "#9b766c", fontSize: 13.5, marginTop: 6 },

});

export default ReplyThread;

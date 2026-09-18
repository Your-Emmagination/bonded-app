// app/(main)/DirectChatScreen.tsx
import { auth, db } from "@/Firebase_configure";
import { resolveAvatarUri } from "@/utils/avatar";
import { AVATAR_SIZE_SMALL, avatarThumb, feedImage, videoThumb } from "@/utils/cloudinaryImages";
import { readLastUploadSize, uploadToCloudinary } from "@/utils/cloudinaryUpload";
import {
    DEFAULT_THEME_COLOR,
    DIRECT_MESSAGE_PAGE_SIZE,
    createDirectMessageId,
    deleteDirectMessage,
    editDirectMessage,
    getDirectMessageContext,
    searchDirectMessageHistory,
    DirectConversation,
    DirectFileAttachment,
    DirectMessage,
    getDirectConversationId,
    markConversationAsSeen,
    MESSENGER_THEMES,
    sendDirectMessage,
    subscribeToDirectMessages,
    subscribeToUserConversations,
    toggleDirectMessageReaction,
    toggleMuteConversation,
    togglePinDirectMessage,
    updateConversationNickname,
    updateConversationTheme,
} from "@/utils/directMessages";
import { getFileIconDetails } from "@/utils/fileTypeHelper";
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { DraftAttachment, insertEmojiInDraft, MESSAGE_MAX_LENGTH, prepareDraftAttachment, TextSelection } from "@/utils/messageComposer";
import { replyPreviewMedia, replyPreviewText } from "@/utils/replyPreview";
import { dismissConversationNotifications } from "@/utils/pushNotifications";
import { getRoleColor, getRoleDisplayName, getUserDataByAuthUser, parseUserRole, subscribeToStudentProfile, type UserData } from "@/utils/rbac";
import { getTimeAgo, useRelativeTimeNow } from "@/utils/relativeTime";
import { getPresenceState, isMessageAfterDeletion, receiptCoversMessage, timestampMillis } from "@/utils/messengerState";
import { formatChatTimeLabel, sameDay } from "@/utils/chatTime";
import { messageLinks, splitMessageLinks } from "@/utils/chatLinks";
import { findBlockedLink } from "@/utils/externalLinks";
import { useDirectTyping } from "@/utils/directTyping";
import { useAppActive, useUserPresence } from "@/utils/presence";
import { useNetworkStatus } from "@/utils/networkUtils";
import {
    getCachedDirectMessages,
    saveCachedDirectMessages,
} from "@/utils/offlineStorage";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { pickUploadDocuments } from "@/utils/uploadAttachments";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { doc, onSnapshot, Timestamp } from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    BackHandler,
    Dimensions,
    FlatList,
    Keyboard,
    KeyboardAvoidingView,
    Linking,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import ReanimatedAnimated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
} from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import ChatEmojiPicker from "./components/ChatEmojiPicker";
import MessageImage from "./components/MessageImage";
import ExternalLinkDialog, { prepareExternalLink } from "./components/ExternalLinkDialog";
import ChatGifPicker from "./components/ChatGifPicker";
import ChatTypingIndicator from "./components/ChatTypingIndicator";
import ImageZoomViewer from "./components/ImageZoomViewer";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

// Width of a photo inside a bubble. Replaces the old hardcoded 220x160, which
// was the same on every device and cropped whatever did not fit. Height now
// follows the image's own ratio — see components/MessageImage.
const CHAT_MEDIA_WIDTH = Math.min(260, SCREEN_WIDTH * 0.62);

const EMOJI_REACTIONS = ["❤️", "😆", "😮", "😢", "😡", "👍"];

// Double-tap to react, matching ServerChannelScreen. The reveal-timestamp tap
// is held for this long so a fast second tap can cancel it and react instead;
// without the delay the two gestures fight and the first tap always wins.
const DOUBLE_TAP_MS = 260;
const DEFAULT_REACTION = "❤️";
/** A gap this long between two messages earns its own time label. */
const TIME_LABEL_GAP_MS = 15 * 60 * 1000;

/**
 * Whether a message opens a new stretch of the conversation: the first one
 * loaded, the first of a new day, or one after a long pause.
 */
function needsTimeLabel(message: DirectMessage, older: DirectMessage | undefined): boolean {
  const current = timestampMillis(message.createdAt);
  if (!current) return false;
  if (!older) return true;
  const previous = timestampMillis(older.createdAt);
  if (!previous) return false;
  return (
    !sameDay(new Date(previous), new Date(current)) ||
    current - previous >= TIME_LABEL_GAP_MS
  );
}

/* ==================== MESSAGE BUBBLE (MEMOIZED FOR 60-120 FPS) ==================== */
interface DirectMessageBubbleProps {
  item: DirectMessage;
  isOwn: boolean;
  themeColor: string;
  recipientAvatar?: string | null;
  recipientName: string;
  showAvatar: boolean;
  /** Show Sending / Sent / Delivered under this message. */
  showStatus: boolean;
  /** This is the newest of your messages the other person has read. */
  showSeenAvatar: boolean;
  /** A centred time label above the message, when it starts a new stretch. */
  timeLabel: string | null;
  isDelivered: boolean;
  isPending: boolean;
  isHighlighted: boolean;
  revealedTimestamp: boolean;
  nowMs: number;
  onLongPress: (message: DirectMessage, pageY?: number) => void;
  onReactionPress: (message: DirectMessage, emoji: string) => void;
  onOpenImage: (url: string) => void;
  onToggleReveal: (id: string) => void;
  onSwipeReply: (messageId: string) => void;
  onJumpToMessage: (messageId: string) => void;
  /** Routes every link through the confirmation dialog. */
  onOpenLink: (url: string, label?: string) => void;
}

const DirectMessageBubbleComponent: React.FC<DirectMessageBubbleProps> = ({
  item,
  isOwn,
  themeColor,
  recipientAvatar,
  recipientName,
  showAvatar,
  showStatus,
  showSeenAvatar,
  timeLabel,
  isDelivered,
  isPending,
  isHighlighted,
  revealedTimestamp,
  nowMs,
  onLongPress,
  onReactionPress,
  onOpenImage,
  onToggleReveal,
  onSwipeReply,
  onJumpToMessage,
  onOpenLink,
}) => {
  // The bubble is memoised and lives at module level, so it reads the palette
  // itself. Note this is the app's appearance — the per-conversation
  // `themeColor` that tints your own bubbles is separate and unaffected.
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const messageId = item.id;
  const swipeX = useSharedValue(0);
  const swipeDir = isOwn ? -1 : 1;
  const SWIPE_REPLY_THRESHOLD = 40;

  const panGesture = useMemo(() => {
    return Gesture.Pan()
      .enabled(!item.deleted)
      .activeOffsetX(isOwn ? [-14, 9999] : [-9999, 14])
      .failOffsetY([-12, 12])
      .onUpdate((e) => {
        const dx = e.translationX * swipeDir;
        swipeX.set(dx > 0 ? Math.min(dx, 65) : 0);
      })
      .onEnd((e) => {
        const dx = e.translationX * swipeDir;
        if (dx > SWIPE_REPLY_THRESHOLD) {
          runOnJS(onSwipeReply)(messageId);
        }
        swipeX.set(0);
      })
      .onFinalize(() => { swipeX.set(0); });
  }, [isOwn, item.deleted, messageId, onSwipeReply, swipeDir, swipeX]);

  const rowSwipeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: swipeX.value * swipeDir }],
  }));

  const reactionEntries = useMemo(() => {
    if (!item.reactions) return [];
    return Object.entries(item.reactions).filter(([, uids]) => uids && uids.length > 0);
  }, [item.reactions]);

  const reactionCount = useMemo(() => {
    return reactionEntries.reduce((sum, [, uids]) => sum + (uids?.length || 0), 0);
  }, [reactionEntries]);

  const images = useMemo(() => {
    return (item.files || []).filter((f) => f.mimeType.startsWith("image/"));
  }, [item.files]);

  const docs = useMemo(() => {
    return (item.files || []).filter((f) => !f.mimeType.startsWith("image/"));
  }, [item.files]);

  // Same pattern the server channel already uses: one tap reveals the time,
  // two hearts the message. A stray timer is cleared on unmount so a bubble
  // recycled out of the list cannot fire a reveal for a different message.
  const lastTapRef = useRef(0);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    },
    [],
  );

  const handleBubbleTap = useCallback(() => {
    // A deleted message has nothing to react to.
    if (item.deleted) {
      onToggleReveal(item.id);
      return;
    }

    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      onReactionPress(item, DEFAULT_REACTION);
      return;
    }

    lastTapRef.current = now;
    revealTimerRef.current = setTimeout(() => {
      revealTimerRef.current = null;
      onToggleReveal(item.id);
    }, DOUBLE_TAP_MS);
  }, [item, onReactionPress, onToggleReveal]);

  return (
    <>
    {!!timeLabel && (
      <Text style={styles.timeLabel} accessibilityRole="header">
        {timeLabel}
      </Text>
    )}
    <View style={[styles.bubbleContainer, isOwn ? styles.bubbleContainerOwn : styles.bubbleContainerOther, reactionEntries.length > 0 && styles.bubbleContainerWithReactions]}>
      {!isOwn && showAvatar && <View style={styles.incomingAvatarWrap}>
        {recipientAvatar ? <Image source={{ uri: avatarThumb(recipientAvatar, 28) }} style={styles.incomingAvatar} />
          : <View style={[styles.incomingAvatar, styles.chatAvatarFallback]}><Text style={styles.chatAvatarInitial}>{recipientName[0]?.toUpperCase() || "?"}</Text></View>}
      </View>}
      {revealedTimestamp && (
        <Text style={styles.revealedTimeText}>{getTimeAgo(item.createdAt, nowMs)}</Text>
      )}

      <GestureDetector gesture={panGesture}>
        <ReanimatedAnimated.View style={rowSwipeStyle}>
          {/* Messenger puts the reply marker OUTSIDE the bubble as one small
              line — "You replied to Khen" — and leaves the bubble itself
              alone. The quoted snippet used to sit inside the bubble, which
              is what stretched a reply to a photo: the bubble had to hold a
              quote box, a thumbnail and the photo. Tapping still jumps to the
              original, so nothing is lost by not re-drawing it here. */}
          {item.replyTo && !item.deleted && (
            <Pressable
              style={[styles.replyLabelRow, isOwn && styles.replyLabelRowOwn]}
              accessibilityRole="button"
              accessibilityLabel="Go to original message"
              onPress={(event) => {
                event.stopPropagation();
                onJumpToMessage(item.replyTo!.id);
              }}
            >
              <Ionicons name="arrow-undo" size={12} color={theme.textMuted} />
              <Text style={styles.replyLabelText} numberOfLines={1}>
                {isOwn
                  ? item.replyTo.senderName === recipientName
                    ? `You replied to ${recipientName}`
                    : "You replied to yourself"
                  : item.replyTo.senderName === recipientName
                    ? `${recipientName} replied to themselves`
                    : `${recipientName} replied to you`}
              </Text>
            </Pressable>
          )}

          {item.replyTo && !item.deleted && (
            <Pressable
              style={[styles.replyEcho, isOwn && styles.replyEchoOwn]}
              accessibilityRole="button"
              accessibilityLabel={`Replying to: ${item.replyTo.preview}`}
              onPress={(event) => {
                event.stopPropagation();
                onJumpToMessage(item.replyTo!.id);
              }}
            >
              {!!item.replyTo.mediaUrl && (
                <Image
                  source={{
                    uri:
                      item.replyTo.mediaType === "video"
                        ? videoThumb(item.replyTo.mediaUrl, 64)
                        : feedImage(item.replyTo.mediaUrl, 64),
                  }}
                  style={styles.replyEchoThumb}
                  contentFit="cover"
                  recyclingKey={`${item.id}:replyThumb`}
                />
              )}
              <Text style={styles.replyEchoText} numberOfLines={1}>
                {item.replyTo.preview}
              </Text>
            </Pressable>
          )}
          <Pressable
            onLongPress={(event) => {
              if (!item.deleted) {
                const pageY = event.nativeEvent?.pageY;
                onLongPress(item, pageY);
              }
            }}
            onPress={handleBubbleTap}
            delayLongPress={260}
            style={[
              styles.bubbleBox,
              isOwn
                ? [styles.bubbleBoxOwn, { backgroundColor: themeColor }]
                : styles.bubbleBoxOther,
              isHighlighted && styles.bubbleHighlighted,
              item.deleted && styles.bubbleBoxDeleted,
            ]}
          >
            {/* Forwarded Tag */}
            {item.forwarded && !item.deleted && (
              <View style={styles.forwardedHeaderRow}>
                <Ionicons name="arrow-redo" size={12} color={isOwn ? "rgba(255,255,255,0.8)" : theme.textMuted} />
                <Text style={[styles.forwardedTagText, isOwn && styles.forwardedTagTextOwn]}>
                  Forwarded {item.forwardedFrom?.senderName ? `from ${item.forwardedFrom.senderName}` : ""}
                </Text>
              </View>
            )}

            {/* Attached Images */}
            {images.length > 0 && (
              <View style={styles.imageGrid}>
                {images.map((img, idx) => (
                  <TouchableOpacity
                    key={`${img.url}_${idx}`}
                    onPress={() => onOpenImage(img.url)}
                    activeOpacity={0.88}
                  >
                    <MessageImage
                      uri={img.url}
                      width={CHAT_MEDIA_WIDTH}
                      sourceWidth={img.width}
                      sourceHeight={img.height}
                      recyclingKey={`${item.id}:${img.url}`}
                    />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Document attachments */}
            {docs.map((docItem, idx) => {
              const details = getFileIconDetails(docItem.mimeType, docItem.name);
              return (
                <TouchableOpacity
                  key={`${docItem.url}_${idx}`}
                  style={[styles.docChip, isOwn && styles.docChipOwn]}
                  onPress={() => onOpenLink(docItem.url)}
                >
                  <Ionicons name={details.icon as any} size={20} color={isOwn ? "#fff" : details.color} />
                  <Text style={[styles.docChipText, isOwn && styles.docChipTextOwn]} numberOfLines={1}>
                    {docItem.name || "Attachment"}
                  </Text>
                </TouchableOpacity>
              );
            })}

            {/* Message Text */}
            {item.deleted ? (
              <View style={styles.deletedRow}>
                <Ionicons name="ban-outline" size={12} color={theme.textMuted} />
                <Text style={styles.deletedText}>Message deleted</Text>
              </View>
            ) : !!item.text && (
              <Text style={[styles.messageText, isOwn && styles.messageTextOwn]}>
                {splitMessageLinks(item.text).map((part, index) => part.url
                  ? <Text key={index} style={{ textDecorationLine: "underline", fontWeight: "600" }} accessibilityRole="link"
                    onPress={(event) => { event.stopPropagation(); onOpenLink(part.url!); }}>{part.text}</Text>
                  : part.text)}
              </Text>
            )}
            {item.edited && !item.deleted && <Text style={[styles.editedLabel, isOwn && { color: "rgba(255,255,255,0.75)" }]}>Edited</Text>}

            {/* Shared link snapshot */}
            {item.link && !item.deleted && (
              <TouchableOpacity
                style={[styles.linkPreviewBox, isOwn && styles.linkPreviewBoxOwn]}
                onPress={() => onOpenLink(item.link!.url, item.link!.title)}
              >
                <Ionicons name="link-outline" size={14} color={isOwn ? "#fff" : "#1d4ed8"} />
                <Text style={[styles.linkPreviewText, isOwn && styles.linkPreviewTextOwn]} numberOfLines={1}>
                  {item.link.title || item.link.url}
                </Text>
              </TouchableOpacity>
            )}
          </Pressable>
        </ReanimatedAnimated.View>
      </GestureDetector>

      {/* Reaction Badges (Messenger corner pill) */}
      {!item.deleted && reactionEntries.length > 0 && (
        <View style={[styles.reactionsRow, isOwn ? styles.reactionsRowOwn : styles.reactionsRowOther]}>
          <TouchableOpacity
            style={styles.reactionPill}
            onPress={() => {
              const currentUid = auth.currentUser?.uid || "";
              const ownReaction = reactionEntries.find(([, uids]) => uids.includes(currentUid));
              const emojiToToggle = ownReaction ? ownReaction[0] : reactionEntries[0][0];
              onReactionPress(item, emojiToToggle);
            }}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Reactions"
          >
            <View style={styles.reactionEmojisStack}>
              {reactionEntries.slice(0, 3).map(([emoji]) => (
                <Text key={emoji} style={styles.reactionEmojiText}>{emoji}</Text>
              ))}
            </View>
            {reactionCount > 1 && (
              <Text style={styles.reactionCountText}>{reactionCount}</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Pin Badge */}
      {item.pinned && (
        <View style={[styles.pinnedMarker, isOwn && { alignSelf: "flex-end" }]}>
          <Ionicons name="pin" size={11} color={theme.accent} />
          <Text style={styles.pinnedMarkerText}>Pinned</Text>
        </View>
      )}

      {/* Messenger's receipts: the other person's small photo sits under the
          newest of your messages they have read, and Sending / Sent /
          Delivered sits under your latest one until they read it. */}
      {isOwn && (showSeenAvatar || showStatus) && (
        <View
          style={styles.statusRow}
          accessible
          accessibilityLabel={
            showSeenAvatar
              ? `Seen by ${recipientName}`
              : isPending
                ? "Sending"
                : isDelivered
                  ? "Delivered"
                  : "Sent"
          }
        >
          {showSeenAvatar ? (
            recipientAvatar ? (
              <Image
                source={{ uri: avatarThumb(recipientAvatar, 28) }}
                style={styles.seenAvatar}
              />
            ) : (
              <View style={[styles.seenAvatar, styles.seenAvatarFallback]}>
                <Ionicons name="person" size={9} color={theme.surface} />
              </View>
            )
          ) : (
            <Text style={styles.statusText}>
              {isPending ? "Sending…" : isDelivered ? "Delivered" : "Sent"}
            </Text>
          )}
        </View>
      )}
    </View>
    </>
  );
};

const DirectMessageBubble = React.memo(DirectMessageBubbleComponent);

/* ==================== MAIN DIRECT CHAT SCREEN ==================== */
export default function DirectChatScreen() {
  const params = useLocalSearchParams<{ conversationId: string }>();
  return <DirectChatContent key={params.conversationId || ""} />;
}

function DirectChatContent() {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    conversationId: string;
    recipientId?: string;
    recipientName?: string;
    recipientAvatar?: string;
    recipientRole?: string;
    recipientStudentID?: string;
  }>();

  const conversationId = params.conversationId || "";
  const currentUserId = auth.currentUser?.uid || "";
  const nowMs = useRelativeTimeNow();
  const appActive = useAppActive();
  const { isOffline } = useNetworkStatus();
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));

  const [conversation, setConversation] = useState<DirectConversation | null>(null);
  const [loadedMessages, setMessages] = useState<DirectMessage[]>([]);
  // Messages painted locally the instant Send is tapped, before the server
  // has them. Each carries the id its real row will be written under.
  const [pendingMessages, setPendingMessages] = useState<DirectMessage[]>([]);
  const hasConversation = !!conversation;
  const cutoffSeconds = conversation?.deletedThrough?.[currentUserId]?.seconds || 0;
  const cutoffNanoseconds = conversation?.deletedThrough?.[currentUserId]?.nanoseconds || 0;
  const historyCutoff = useMemo(() => cutoffSeconds ? new Timestamp(cutoffSeconds, cutoffNanoseconds) : undefined,
    [cutoffSeconds, cutoffNanoseconds]);
  const messages = useMemo(() => {
    const visible = loadedMessages.filter((message) =>
      isMessageAfterDeletion(message.createdAt, historyCutoff));
    if (pendingMessages.length === 0) return visible;
    // The optimistic copy vanishes the moment the real row arrives under the
    // same id, so a sent message is never drawn twice.
    const known = new Set(visible.map((message) => message.id));
    const stillPending = pendingMessages.filter((message) => !known.has(message.id));
    return stillPending.length ? [...visible, ...stillPending] : visible;
  }, [loadedMessages, historyCutoff, pendingMessages]);
  const pendingIds = useMemo(
    () => new Set(pendingMessages.map((message) => message.id)),
    [pendingMessages],
  );

  // Optimistic copies are dropped in the message subscription below, where
  // the server rows actually arrive. Doing it in an effect that watches the
  // list instead would cost an extra render pass on every snapshot.
  const [loading, setLoading] = useState(true);
  const [messageLimit, setMessageLimit] = useState(DIRECT_MESSAGE_PAGE_SIZE);
  const [historyAnchor, setHistoryAnchor] = useState<Timestamp | undefined>();
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const [jumpHighlight, setJumpHighlight] = useState<string | null>(null);
  const [jumping, setJumping] = useState(false);
  const jumpVersion = useRef(0);
  const scrollRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollAttempts = useRef(0);
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [draftAttachment, setDraftAttachment] = useState<DraftAttachment | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const pickerInFlight = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [visibleMessageIds, setVisibleMessageIds] = useState<string[]>([]);
  const sendInFlight = useRef(false);
  const viewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 50, minimumViewTime: 500 }), []);
  const pendingSend = useRef<{ key: string; id: string } | null>(null);
  // The sender's own profile was re-fetched on every single send, putting a
  // storage round-trip in front of each write. It changes rarely, so it is
  // resolved once and reused.
  const myProfileRef = useRef<UserData | null>(null);
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: { item: DirectMessage }[] }) => {
    setVisibleMessageIds(viewableItems.map(({ item }) => item.id));
  }, []);

  // Warm the profile before the first send so even that one skips the fetch.
  useEffect(() => {
    let active = true;
    void getUserDataByAuthUser(auth.currentUser)
      .then((profile) => {
        if (active && profile) myProfileRef.current = profile;
      })
      .catch(() => {
        // A failure here costs nothing: handleSend falls back to fetching.
      });
    return () => {
      active = false;
    };
  }, []);

  const [inputText, setInputText] = useState("");
  const [editingMessage, setEditingMessage] = useState<DirectMessage | null>(null);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");
  const editInFlight = useRef(false);
  const [gifPickerVisible, setGifPickerVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [isSending, setIsSending] = useState(false);
  // A send in flight must NOT disable the composer. Disabling a focused
  // TextInput on Android blurs it and drops the keyboard, which is why the
  // keyboard closed after every message. sendInFlight already blocks double
  // sends, so only the send button itself needs to go inert.
  const composerBusy = isPicking || savingEdit;
  const sendDisabled = composerBusy || isSending;
  const inputRef = useRef<TextInput>(null);
  const selectionRef = useRef<TextSelection>({ start: 0, end: 0 });
  const [selectionOverride, setSelectionOverride] = useState<TextSelection | undefined>();
  const [emojiPickerVisible, setEmojiPickerVisible] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  const [revealedTimestampId, setRevealedTimestampId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<DirectMessage | null>(null);

  // In-chat Search State
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [searchMatches, setSearchMatches] = useState<DirectMessage[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");

  // Settings / Info Sheet State
  const [infoSheetVisible, setInfoSheetVisible] = useState(false);
  const [mediaTab, setMediaTab] = useState<"media" | "files" | "links">("media");

  // Long press / Action Menu State
  const [actionMenuTarget, setActionMenuTarget] = useState<DirectMessage | null>(null);
  const [pendingLink, setPendingLink] = useState<ReturnType<typeof prepareExternalLink>>(null);

  // Every link tapped in this screen goes through here. Trusted destinations
  // open immediately; everything else shows where it really leads first.
  const handleOpenLink = useCallback((url: string, label?: string) => {
    setPendingLink(prepareExternalLink(url, label));
  }, []);
  const [actionMenuY, setActionMenuY] = useState<number>(300);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [reactionPickerTarget, setReactionPickerTarget] = useState<DirectMessage | null>(null);

  // Forward Modal State
  const [forwardTarget, setForwardTarget] = useState<DirectMessage | null>(null);
  const [otherConversations, setOtherConversations] = useState<DirectConversation[]>([]);
  const [forwardSentMap, setForwardSentMap] = useState<Record<string, boolean>>({});

  // Nickname Edit Modal State
  const [nicknameModalVisible, setNicknameModalVisible] = useState(false);
  const [editingNickname, setEditingNickname] = useState("");

  // Full-screen image viewer
  const [viewerImage, setViewerImage] = useState<string | null>(null);

  const listRef = useRef<FlatList>(null);
  const deletionVersion = useRef("");

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => {
      setKeyboardVisible(true);
      setEmojiPickerVisible(false);
    });
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useFocusEffect(useCallback(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!emojiPickerVisible) return false;
      setEmojiPickerVisible(false);
      return true;
    });
    return () => back.remove();
  }, [emojiPickerVisible]));

  const toggleEmojiPicker = useCallback(() => {
    if (emojiPickerVisible) {
      setEmojiPickerVisible(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      inputRef.current?.blur();
      Keyboard.dismiss();
      setEmojiPickerVisible(true);
    }
  }, [emojiPickerVisible]);

  // Recipient info
  const recipientId = useMemo(() => {
    if (params.recipientId) return params.recipientId;
    if (conversation) {
      return conversation.participants.find((p) => p !== currentUserId) || "";
    }
    return "";
  }, [params.recipientId, conversation, currentUserId]);

  const recipientDetail = conversation?.participantDetails?.[recipientId];

  // participantDetails is a copy taken when the conversation was created, so
  // it shows whatever picture and name the other person had that day. This
  // follows their profile document and overrides the stale copy below.
  const [liveRecipient, setLiveRecipient] = useState<UserData | null>(null);

  useEffect(() => {
    const documentId =
      recipientDetail?.studentID || params.recipientStudentID || recipientId;
    if (!documentId) return;
    return subscribeToStudentProfile(documentId, setLiveRecipient);
  }, [recipientDetail?.studentID, params.recipientStudentID, recipientId]);
  const recipientPresence = useUserPresence(recipientId, recipientDetail?.studentID || params.recipientStudentID);
  const activity = getPresenceState(recipientPresence, nowMs);
  const recipientNickname = conversation?.nicknames?.[recipientId];
  const displayName = recipientNickname || recipientDetail?.displayName || params.recipientName || "Chat";
  const liveName = liveRecipient
    ? `${liveRecipient.firstname || ""} ${liveRecipient.lastname || ""}`.trim()
    : "";
  const realName = liveName || recipientDetail?.displayName || params.recipientName || "";
  // Live first, stored copy second, route parameter last: the first renders
  // correctly, the others render instantly.
  const recipientAvatar =
    resolveAvatarUri(liveRecipient) ||
    recipientDetail?.profileImage ||
    params.recipientAvatar ||
    null;
  const role = parseUserRole(
    liveRecipient?.role || recipientDetail?.role || params.recipientRole,
  );
  const roleColor = getRoleColor(role || "student");
  const themeColor = conversation?.themeColor || DEFAULT_THEME_COLOR;
  const quickEmoji = conversation?.quickEmoji || "👍";
  const isMuted = (conversation?.mutedBy || []).includes(currentUserId);
  const { isTyping, onTextChanged, stopTyping } = useDirectTyping(conversationId, currentUserId, recipientId,
    focused && appActive && !isOffline && !conversationError);
  const handleInsertEmoji = useCallback((emoji: string) => {
    const next = insertEmojiInDraft(editingMessage ? editText : inputText, emoji, selectionRef.current);
    if (!next) return;
    selectionRef.current = next.selection;
    if (editingMessage) setEditText(next.text); else setInputText(next.text);
    onTextChanged(next.text);
    setSelectionOverride(next.selection);
  }, [inputText, editingMessage, editText, onTextChanged]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => { jumpVersion.current++; clearTimeout(scrollRetry.current); }, []);
  useEffect(() => {
    if (!jumpHighlight) return;
    const timer = setTimeout(() => setJumpHighlight(null), 2200);
    return () => clearTimeout(timer);
  }, [jumpHighlight]);
  const copyContent = useCallback(async (text: string, label: string) => {
    setActionMenuTarget(null);
    try { await Clipboard.setStringAsync(text); setNotice(`${label} copied`); }
    catch { setNotice("Could not copy. Please try again."); }
  }, []);
  const handleJumpToMessage = useCallback(async (messageId: string) => {
    const version = ++jumpVersion.current;
    setJumping(true);
    setPendingJump(null);
    clearTimeout(scrollRetry.current);
    try {
      if (!messagesRef.current.some((message) => message.id === messageId)) {
        const context = await getDirectMessageContext(conversationId, messageId, historyCutoff);
        if (version !== jumpVersion.current) return;
        setHistoryAnchor(context.through);
        setMessageLimit(DIRECT_MESSAGE_PAGE_SIZE);
      }
      if (version === jumpVersion.current) setPendingJump(messageId);
    } catch (error) {
      if (version === jumpVersion.current) {
        setNotice(error instanceof Error ? error.message : "Could not load this message.");
        setJumping(false);
      }
    }
  }, [conversationId, historyCutoff]);
  useEffect(() => {
    if (!pendingJump) return;
    const timer = setTimeout(() => {
      setPendingJump(null); setJumping(false);
      setNotice("This message could not be shown. Please try again.");
    }, 15000);
    return () => clearTimeout(timer);
  }, [pendingJump]);
  useEffect(() => {
    if (!pendingJump) return;
    const index = messages.findIndex((message) => message.id === pendingJump);
    if (index < 0) return;
    const frame = requestAnimationFrame(() => {
      scrollAttempts.current = 0;
      listRef.current?.scrollToIndex({ index: messages.length - 1 - index, animated: false, viewPosition: 0.5 });
      setJumpHighlight(pendingJump); setPendingJump(null); setJumping(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, pendingJump]);
  const backToLatest = useCallback(() => {
    jumpVersion.current++;
    setPendingJump(null); setJumping(false); setHistoryAnchor(undefined);
    setMessageLimit(DIRECT_MESSAGE_PAGE_SIZE);
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }));
  }, []);
  const saveEdit = useCallback(async () => {
    if (!editingMessage || editInFlight.current || !editText.trim()) return;
    if (isOffline) { setEditError("Reconnect to save your edit."); return; }
    editInFlight.current = true; setSavingEdit(true); setEditError(""); stopTyping();
    try {
      await editDirectMessage(conversationId, editingMessage.id, currentUserId, editText);
      setEditingMessage(null); setSelectionOverride(undefined); setNotice("Message updated");
    } catch (error) { setEditError(error instanceof Error ? error.message : "Could not save. Please try again."); }
    finally { editInFlight.current = false; setSavingEdit(false); }
  }, [conversationId, currentUserId, editText, editingMessage, isOffline, stopTyping]);

  // Subscribe to conversation doc
  useEffect(() => {
    if (!conversationId) return;
    const convRef = doc(db, "directConversations", conversationId);
    const unsubscribe = onSnapshot(convRef, (snap) => {
      const data = snap.exists() ? { id: snap.id, ...(snap.data() as Omit<DirectConversation, "id">) } : null;
      const cutoff = data?.deletedThrough?.[currentUserId];
      const nextDeletionVersion = cutoff ? `${cutoff.seconds}:${cutoff.nanoseconds}` : "";
      if (deletionVersion.current !== nextDeletionVersion) {
        deletionVersion.current = nextDeletionVersion;
        // Deletion on another device also closes any currently displayed old content.
        setReplyingTo(null);
        setEditingMessage(null);
        setHistoryAnchor(undefined);
        setSearchMatches([]);
        jumpVersion.current++;
        setPendingJump(null);
        setJumping(false);
        setActionMenuTarget(null);
        setForwardTarget(null);
        setViewerImage(null);
        setSearchQuery("");
        setCurrentMatchIndex(0);
        setMessageLimit(DIRECT_MESSAGE_PAGE_SIZE);
        setLoadingOlder(false);
      }
      setConversation(data);
      const validDraft = !!params.recipientId && params.recipientId !== currentUserId &&
        getDirectConversationId(currentUserId, params.recipientId) === conversationId;
      setConversationError(snap.exists() || validDraft ? null : "This conversation is unavailable.");
      if (!snap.exists()) {
        setMessages([]);
        setMessageError(null);
        setLoading(false);
      }
    }, () => {
      setConversationError("Unable to load this conversation. Please try again.");
      setLoading(false);
    });
    return () => unsubscribe();
  }, [conversationId, currentUserId, params.recipientId, retryCount]);

  // Subscribe to messages
  useEffect(() => {
    if (!conversationId || !hasConversation) return;

    // Saved messages first, so an already-opened chat isn't blank offline.
    let active = true;
    getCachedDirectMessages<DirectMessage>(conversationId).then((cached) => {
      if (!active || cached.length === 0) return;
      setMessages((prev) => (prev.length === 0 ? cached : prev));
      setLoading(false);
    });

    const unsubscribe = subscribeToDirectMessages(conversationId, (msgList) => {
      setMessages(msgList);
      // The real row has landed, so its optimistic twin can go.
      setPendingMessages((prev) => {
        if (prev.length === 0) return prev;
        const known = new Set(msgList.map((message) => message.id));
        const next = prev.filter((message) => !known.has(message.id));
        return next.length === prev.length ? prev : next;
      });
      setMessageError(null);
      setLoading(false);
      setLoadingOlder(false);
      void saveCachedDirectMessages(conversationId, msgList);
    }, messageLimit, () => {
      setLoading(false);
      setLoadingOlder(false);
      setMessageError("Messages could not be loaded. Check your connection and retry.");
      setJumping(false); setPendingJump(null);
    }, historyCutoff, historyAnchor);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [conversationId, hasConversation, historyCutoff, historyAnchor, messageLimit, retryCount]);

  // Looking at the chat clears its tray notifications, so a conversation the
  // user has just read stops showing rows for messages already seen. Runs
  // regardless of connectivity: the tray is local.
  const loadedCount = loadedMessages.length;
  useEffect(() => {
    if (!focused || !conversationId || loadedCount === 0) return;
    void dismissConversationNotifications(conversationId);
  }, [focused, conversationId, loadedCount]);

  useEffect(() => {
    if (!focused || !appActive || isOffline || !currentUserId || messageError || conversationError) return;
    // A pending bubble has a client-side date and no server row yet, so it
    // must never drive a read receipt.
    const visible = messages.filter(
      (message) => visibleMessageIds.includes(message.id) && !pendingIds.has(message.id),
    );
    if (!visible.length) return;
    void markConversationAsSeen(conversationId, currentUserId, visible)
      .catch((error) => console.warn("[DirectChatScreen] Read receipt failed:", error));
  }, [focused, appActive, isOffline, currentUserId, conversationId, messages, visibleMessageIds, messageError, conversationError, pendingIds]);

  // Search all visible history, including pages that have never been loaded in the list.
  const historyVersion = `${timestampMillis(conversation?.lastMessage?.createdAt)}:${timestampMillis(conversation?.contentUpdatedAt)}:${conversation?.lastMessage?.text || ""}`;
  useEffect(() => {
    const controller = new AbortController();
    // Reset results when replacing the external history query; this effect never depends on those results.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearchMatches([]); setCurrentMatchIndex(0); setSearchError("");
    if (!isSearching || !searchQuery.trim() || !hasConversation) { setSearchLoading(false); return; }
    setSearchLoading(true);
    const timer = setTimeout(() => {
      void searchDirectMessageHistory(conversationId, searchQuery, historyCutoff, controller.signal).then((matches) => {
        if (controller.signal.aborted) return;
        setSearchMatches(matches);
        if (matches[0]) void handleJumpToMessage(matches[0].id);
      }).catch(() => { if (!controller.signal.aborted) setSearchError("Search failed. Check your connection and tap to retry."); })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 350);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [conversationId, hasConversation, historyCutoff, historyVersion, isSearching, searchQuery, retryCount, handleJumpToMessage]);

  const activeHighlightedMessageId = useMemo(() => {
    if (!isSearching || searchMatches.length === 0) return jumpHighlight;
    const match = searchMatches[currentMatchIndex];
    return match ? match.id : null;
  }, [searchMatches, currentMatchIndex, isSearching, jumpHighlight]);

  const handleNextSearchMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    const next = (currentMatchIndex + 1) % searchMatches.length;
    setCurrentMatchIndex(next);
    const targetMsg = searchMatches[next];
    if (targetMsg) void handleJumpToMessage(targetMsg.id);
  }, [searchMatches, currentMatchIndex, handleJumpToMessage]);

  const handlePrevSearchMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    const prev = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    setCurrentMatchIndex(prev);
    const targetMsg = searchMatches[prev];
    if (targetMsg) void handleJumpToMessage(targetMsg.id);
  }, [searchMatches, currentMatchIndex, handleJumpToMessage]);

  // Subscribe to user conversations when forward modal is open
  useEffect(() => {
    if (!forwardTarget || !currentUserId) return;
    const unsub = subscribeToUserConversations(currentUserId, (convs) => {
      setOtherConversations(convs);
    }, { includeArchived: true });
    return () => unsub();
  }, [forwardTarget, currentUserId]);

  // Send message handler
  const handleSend = useCallback(
    async (customText?: string) => {
      const textToSend = customText !== undefined ? customText : inputText;
      const attachment = customText === undefined ? draftAttachment : null;

      if (!textToSend.trim() && !attachment) return;
      if (!conversationId || !currentUserId || sendInFlight.current || pickerInFlight.current) return;

      // Direct messages are never read by moderation and never seen by staff,
      // and that should stay true. The only thing checked here is the domain
      // of any link: no message text is inspected, nothing is recorded, and
      // only an outright blocked host stops the send. A phishing or adult
      // link sent privately reaches somebody who trusts the sender, which is
      // exactly why the narrowest possible check still earns its place.
      const blockedLink = findBlockedLink(
        splitMessageLinks(textToSend).flatMap((part) => (part.url ? [part.url] : [])),
      );
      if (blockedLink) {
        Alert.alert(
          "This link can't be sent",
          `Links to ${blockedLink.host} aren't allowed on BondED. Remove it to send your message.`,
        );
        return;
      }
      if (isOffline) {
        Alert.alert("You’re offline", "Your message is still here. Reconnect to send it.");
        return;
      }

      sendInFlight.current = true;
      stopTyping();
      setIsSending(true);
      const key = JSON.stringify([conversationId, textToSend, attachment?.uri, replyingTo?.id]);
      if (pendingSend.current?.key !== key) pendingSend.current = { key, id: createDirectMessageId(conversationId) };

      // Empty the composer now rather than after the upload + send round-trip,
      // so the message visibly "leaves" on tap. Everything cleared here is
      // captured first and restored in the catch, keeping the existing
      // "your draft is still here" behaviour when a send fails.
      const activeReplyingTo = replyingTo;
      const previousSelection = selectionRef.current;
      if (customText === undefined) {
        setDraftAttachment(null);
        setInputText("");
        selectionRef.current = { start: 0, end: 0 };
        setSelectionOverride(undefined);
        // Messenger keeps the keyboard up after sending, so focus goes
        // straight back to the composer the user just emptied.
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      setReplyingTo(null);

      // Paint the bubble now rather than after the round-trip, the way
      // Messenger does. It uses the id the real message will be written
      // under, so the echo replaces it instead of duplicating it.
      const optimisticId = pendingSend.current.id;
      const replyPreviewForBubble = activeReplyingTo
        ? replyPreviewMedia(activeReplyingTo)
        : undefined;
      setPendingMessages((prev) => [
        ...prev.filter((message) => message.id !== optimisticId),
        {
          id: optimisticId,
          conversationId,
          senderId: currentUserId,
          senderName:
            `${myProfileRef.current?.firstname || ""} ${myProfileRef.current?.lastname || ""}`.trim() ||
            auth.currentUser?.displayName ||
            "You",
          senderAvatar: resolveAvatarUri(myProfileRef.current),
          senderRole: myProfileRef.current?.role || "student",
          text: textToSend.trim(),
          // The local file shows immediately; the uploaded URL replaces it
          // when the real row arrives.
          files: attachment
            ? [{
                url: attachment.uploaded?.url ?? attachment.uri,
                mimeType: attachment.mimeType,
                name: attachment.name,
              }]
            : [],
          ...(activeReplyingTo
            ? {
                replyTo: {
                  id: activeReplyingTo.id,
                  senderName: activeReplyingTo.senderName,
                  preview: replyPreviewText(activeReplyingTo).slice(0, 100),
                  ...(replyPreviewForBubble
                    ? {
                        mediaUrl: replyPreviewForBubble.url,
                        mediaType: replyPreviewForBubble.type,
                      }
                    : {}),
                },
              }
            : {}),
          status: "sent",
          seenBy: {},
          reactions: {},
          pinned: false,
          createdAt: new Date(),
        },
      ]);

      let uploading = false;
      let restorableAttachment = attachment;
      try {
        const filesToSend: DirectFileAttachment[] = [];
        if (attachment) {
          uploading = !attachment.uploaded;
          setIsUploading(uploading);
          // The third argument reports the uploaded image's pixel size, so the
          // bubble is the right shape on first paint instead of settling into
          // it after the image loads.
          const uploaded = await prepareDraftAttachment(
            attachment,
            uploadToCloudinary,
            readLastUploadSize,
          );
          filesToSend.push(uploaded);
          // The draft is already cleared, so remember the uploaded result here
          // instead — a retry after a failed send then skips the re-upload.
          restorableAttachment = { ...attachment, uploaded };
          uploading = false;
          setIsUploading(false);
        }
        const currentUserProfile =
          myProfileRef.current ?? (await getUserDataByAuthUser(auth.currentUser));
        myProfileRef.current = currentUserProfile;
        const myDisplayName =
          currentUserProfile?.firstname && currentUserProfile?.lastname
            ? `${currentUserProfile.firstname} ${currentUserProfile.lastname}`.trim()
            : auth.currentUser?.displayName || "User";

        const replyMedia = activeReplyingTo
          ? replyPreviewMedia(activeReplyingTo)
          : undefined;
        const replyPayload = activeReplyingTo
          ? {
              id: activeReplyingTo.id,
              senderName: activeReplyingTo.senderName,
              preview: replyPreviewText(activeReplyingTo).slice(0, 100),
              ...(replyMedia
                ? { mediaUrl: replyMedia.url, mediaType: replyMedia.type }
                : {}),
            }
          : undefined;

        await sendDirectMessage({
          conversationId,
          sender: {
            uid: currentUserId,
            displayName: myDisplayName,
            profileImage: resolveAvatarUri(currentUserProfile),
            role: currentUserProfile?.role || "student",
            studentID: currentUserProfile?.studentID || "",
          },
          recipient: {
            uid: recipientId, displayName: realName || displayName, profileImage: recipientAvatar,
            role: role || "student", studentID: recipientDetail?.studentID || params.recipientStudentID || "",
          },
          text: textToSend,
          files: filesToSend,
          replyTo: replyPayload,
          recipients: conversation?.participants || [recipientId],
          messageId: pendingSend.current.id,
        });
        pendingSend.current = null;
        backToLatest();

        // Scroll to bottom
        requestAnimationFrame(() => {
          listRef.current?.scrollToOffset({ offset: 0, animated: true });
        });
      } catch (err) {
        console.error("[DirectChatScreen] sendDirectMessage failed:", err);
        // The send failed, so the optimistic bubble has to go — the draft is
        // restored below and the user sends again.
        setPendingMessages((prev) => prev.filter((message) => message.id !== optimisticId));
        // Put the composer back exactly as the user left it.
        if (customText === undefined) {
          setInputText(textToSend);
          setDraftAttachment(restorableAttachment);
          selectionRef.current = previousSelection;
          setSelectionOverride(previousSelection);
        }
        setReplyingTo(activeReplyingTo);
        Alert.alert(uploading ? "Upload failed" : "Failed to send", "Your draft is still here. Check your connection and tap Send to try again.");
      } finally {
        sendInFlight.current = false;
        setIsUploading(false);
        setIsSending(false);
      }
    },
    [conversationId, currentUserId, inputText, draftAttachment, isOffline, replyingTo, conversation,
      recipientId, realName, displayName, recipientAvatar, role, recipientDetail, params.recipientStudentID, stopTyping, backToLatest],
  );

  // Camera and gallery both stage a photo for review before Send uploads it.
  const handlePickPhoto = useCallback(async (source: "camera" | "gallery") => {
    if (sendInFlight.current || pickerInFlight.current) return;
    pickerInFlight.current = true;
    setIsPicking(true);
    setEmojiPickerVisible(false);
    Keyboard.dismiss();
    try {
      if (source === "camera" && Platform.OS !== "web") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert("Camera access needed", "Allow camera access to take a photo for this conversation.", [
            { text: "Cancel", style: "cancel" },
            ...(!permission.canAskAgain ? [{ text: "Open settings", onPress: () => {
              void Linking.openSettings().catch(() => Alert.alert("Open device settings", "Enable camera access for this app in your phone settings."));
            } }] : []),
          ]);
          return;
        }
      }
      const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.8 };
      const res = source === "camera"
        ? await ImagePicker.launchCameraAsync({ ...options, cameraType: ImagePicker.CameraType.back })
        : await ImagePicker.launchImageLibraryAsync(options);
      if (res.canceled || !res.assets[0]?.uri) return;

      const asset = res.assets[0];
      setDraftAttachment({
        uri: asset.uri,
        name: asset.fileName || "Photo",
        mimeType: asset.mimeType || "image/jpeg",
        source,
      });
    } catch (e) {
      console.warn("[DirectChatScreen] Photo picker failed:", e);
      Alert.alert(source === "camera" ? "Camera unavailable" : "Could not open photos", "Please try again and check that this app has permission to access your photos or camera.");
    } finally {
      pickerInFlight.current = false;
      setIsPicking(false);
    }
  }, []);

  // Pick Document
  const handlePickDocument = useCallback(async () => {
    if (sendInFlight.current || pickerInFlight.current) return;
    pickerInFlight.current = true;
    setIsPicking(true);
    setEmojiPickerVisible(false);
    Keyboard.dismiss();
    try {
      const res = await pickUploadDocuments({
        type: "*/*",
      });
      if (res.canceled || !res.assets[0]?.uri) return;

      const asset = res.assets[0];
      setDraftAttachment({
        uri: asset.uri,
        mimeType: asset.mimeType || "application/octet-stream",
        name: asset.name || "File",
        source: "file",
      });
    } catch (e) {
      console.warn("[DirectChatScreen] Document picker failed:", e);
      Alert.alert("Could not open files", "Please try selecting your file again.");
    } finally {
      pickerInFlight.current = false;
      setIsPicking(false);
    }
  }, []);

  // Emoji reaction handler
  const handleReactionPress = useCallback(
    (msg: DirectMessage, emoji: string) => {
      // Nothing awaits this, so without a catch a rules refusal surfaces as a
      // bare unhandled FirebaseError. EMOJI_REACTIONS above must stay in step
      // with validReactions() in firestore.rules — when they drifted, two of
      // the six buttons were refused and this was the only symptom.
      void toggleDirectMessageReaction(
        conversationId, msg.id, currentUserId, emoji, msg.reactions,
      ).catch((error) => console.warn("Reaction not saved:", error?.message || error));
    },
    [conversationId, currentUserId],
  );

  // Swipe to reply handler
  const handleSwipeReply = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (msg && !msg.deleted && !composerBusy) {
        setEditingMessage(null);
        setSelectionOverride(undefined);
        setReplyingTo(msg);
        setEmojiPickerVisible(false);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    },
    [messages, composerBusy],
  );

  // Pin / Unpin
  const handleTogglePin = useCallback(
    (msg: DirectMessage) => {
      const nextPinState = !msg.pinned;
      void togglePinDirectMessage(conversationId, msg.id, nextPinState, currentUserId);
      setActionMenuTarget(null);
    },
    [conversationId, currentUserId],
  );

  // Delete message
  const handleDeleteMessage = useCallback(
    (msg: DirectMessage) => {
      Alert.alert("Delete message", "Are you sure you want to delete this message?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
               await deleteDirectMessage(conversationId, msg);
              setActionMenuTarget(null);
            } catch (e) {
              console.warn("Delete failed:", e);
            }
          },
        },
      ]);
    },
    [conversationId],
  );

  // Pinned messages list for banner and sheet
  const pinnedMessages = useMemo(() => {
    return messages.filter((m) => m.pinned);
  }, [messages]);

  const latestPinnedMessage = useMemo(() => {
    return pinnedMessages[pinnedMessages.length - 1] || null;
  }, [pinnedMessages]);

  // Media, Files, Links gallery list
  const galleryItems = useMemo(() => {
    const media: { id: string; url: string; name?: string }[] = [];
    const files: { id: string; url: string; name: string; mimeType: string }[] = [];
    const links: { id: string; url: string; title: string }[] = [];

    for (const m of messages) {
      if (m.deleted) continue;
      for (const f of m.files || []) {
        if (f.mimeType.startsWith("image/")) {
          media.push({ id: m.id, url: f.url, name: f.name });
        } else {
          files.push({ id: m.id, url: f.url, name: f.name || "File", mimeType: f.mimeType });
        }
      }
      if (m.link) {
        links.push({ id: m.id, url: m.link.url, title: m.link.title || m.link.url });
      }
    }
    return { media, files, links };
  }, [messages]);

  // Last own message detection for Sent/Delivered/Seen
  const lastOwnMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].senderId === currentUserId) return messages[i].id;
    }
    return null;
  }, [messages, currentUserId]);

  // Receipts only mean something while the conversation ends on your side:
  // once they have replied, their reply already says they read it.
  const lastMessageIsOwn =
    messages.length > 0 && messages[messages.length - 1].senderId === currentUserId;

  // The newest of your trailing messages that the other person has read —
  // where Messenger puts their photo. Walking back stops at their last
  // message, so a photo never appears above something they wrote.
  const recipientLastRead = recipientId ? conversation?.lastReadAt?.[recipientId] : null;
  const seenMessageId = useMemo(() => {
    if (!recipientLastRead) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.senderId !== currentUserId) return null;
      if (pendingIds.has(message.id)) continue;
      if (receiptCoversMessage(recipientLastRead, message.createdAt)) return message.id;
    }
    return null;
  }, [messages, currentUserId, recipientLastRead, pendingIds]);

  return (
    <KeyboardAvoidingView style={styles.container} behavior="padding" enabled={Platform.OS !== "web"}>
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      {/* ==================== HEADER ==================== */}
      {isSearching ? (
        <View style={styles.searchHeader}>
          <TouchableOpacity onPress={() => setIsSearching(false)} style={styles.headerBackBtn}>
            <Ionicons name="arrow-back" size={24} color={theme.primary} />
          </TouchableOpacity>
          <TextInput
            style={styles.searchHeaderInput}
            placeholder="Search in conversation..."
            placeholderTextColor="#af928b"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
          {searchMatches.length > 0 && (
            <View style={styles.searchControlsRow}>
              <Text style={styles.searchMatchCount}>
                {currentMatchIndex + 1}/{searchMatches.length}
              </Text>
              <TouchableOpacity onPress={handlePrevSearchMatch} style={styles.searchNavBtn}>
                <Ionicons name="chevron-up" size={20} color={theme.primary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleNextSearchMatch} style={styles.searchNavBtn}>
                <Ionicons name="chevron-down" size={20} color={theme.primary} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      ) : (
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBackBtn}>
            <Ionicons name="arrow-back" size={24} color={theme.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.headerProfileSection}
            onPress={() => setInfoSheetVisible(true)}
            activeOpacity={0.8}
          >
            <View style={styles.headerAvatarWrap}>
              {recipientAvatar ? (
                <Image
                  source={{ uri: avatarThumb(recipientAvatar, AVATAR_SIZE_SMALL) }}
                  style={styles.headerAvatar}
                  contentFit="cover"
                />
              ) : (
                <View style={[styles.avatarPlaceholderSmall, { backgroundColor: roleColor + "25" }]}>
                  <Text style={[styles.avatarInitialsSmall, { color: roleColor }]}>
                    {(displayName[0] || "U").toUpperCase()}
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.headerNameCol}>
              <View style={styles.headerNameRow}>
                <Text style={styles.headerDisplayName} numberOfLines={1}>
                  {displayName}
                </Text>
                {role && role !== "student" && (
                  <View style={[styles.roleChip, { backgroundColor: roleColor + "18", borderColor: roleColor }]}>
                    <Text style={[styles.roleChipText, { color: roleColor }]}>
                      {getRoleDisplayName(role)}
                    </Text>
                  </View>
                )}
              </View>
              <View style={styles.activityRow} accessibilityLabel={activity.label}>
                <View style={[styles.activityDot, { backgroundColor: activity.active ? "#2e9d63" : "#a58e87" }]} />
                <Text style={[styles.headerSubstatus, activity.active && { color: "#2e9d63" }]} numberOfLines={1}>
                  {activity.label}
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <View style={styles.headerActions}>
            <TouchableOpacity onPress={() => setIsSearching(true)} style={styles.headerActionBtn}>
              <Ionicons name="search" size={20} color={theme.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setInfoSheetVisible(true)} style={styles.headerActionBtn}>
              <Ionicons name="information-circle-outline" size={22} color={theme.primary} />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ==================== PINNED BANNER ==================== */}
      {latestPinnedMessage && (
        <TouchableOpacity
          style={styles.pinnedBanner}
          onPress={() => handleJumpToMessage(latestPinnedMessage.id)}
          activeOpacity={0.85}
        >
          <Ionicons name="pin" size={14} color={theme.accent} />
          <Text style={styles.pinnedBannerText} numberOfLines={1}>
            <Text style={{ fontWeight: "700" }}>Pinned: </Text>
            {latestPinnedMessage.text || "Attached content"}
          </Text>
          <Ionicons name="arrow-down" size={14} color={theme.textMuted} />
        </TouchableOpacity>
      )}

      {/* ==================== MESSAGES LIST ==================== */}
      <View style={{ flex: 1, minHeight: 0 }}>
        {(messageError || conversationError) && (
          <TouchableOpacity style={{ padding: 12 }} onPress={() => setRetryCount((value) => value + 1)}>
            <Text style={{ color: theme.primary, textAlign: "center" }}>{messageError || conversationError} Tap to retry.</Text>
          </TouchableOpacity>
        )}
        {isOffline && <Text style={{ padding: 8, textAlign: "center", color: theme.textMuted }}>Offline · Reconnect to send messages</Text>}
        {loading && !isOffline ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={themeColor} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            data={[...messages].reverse()}
            inverted
            maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
              if (++scrollAttempts.current <= 4) {
                clearTimeout(scrollRetry.current);
                scrollRetry.current = setTimeout(() => {
                  if (index < messagesRef.current.length) listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
                }, 160);
              }
            }}
            ListFooterComponent={
              <View style={styles.startHeaderWrapper}>
                {messages.length >= messageLimit && (
                  <TouchableOpacity disabled={loadingOlder} style={{ padding: 14, alignItems: "center" }} onPress={() => {
                    setLoadingOlder(true);
                    setMessageLimit((value) => value + DIRECT_MESSAGE_PAGE_SIZE);
                  }}>
                    <Text style={{ color: themeColor }}>{loadingOlder ? "Loading…" : "Load older messages"}</Text>
                  </TouchableOpacity>
                )}

                {/* Messenger Conversation Start Header */}
                <View style={styles.startHeaderContainer}>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => {
                      if (recipientId) {
                        router.push({
                          pathname: "/(main)/UserProfileScreen",
                          params: { userId: recipientId },
                        });
                      }
                    }}
                    style={styles.startAvatarWrap}
                  >
                    {recipientAvatar ? (
                      <Image
                        source={{ uri: avatarThumb(recipientAvatar, 96) }}
                        style={styles.startAvatar}
                        contentFit="cover"
                      />
                    ) : (
                      <View style={[styles.startAvatar, styles.startAvatarFallback, { backgroundColor: roleColor + "20" }]}>
                        <Text style={[styles.startAvatarInitial, { color: roleColor }]}>
                          {displayName[0]?.toUpperCase() || "?"}
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>

                  <Text style={styles.startDisplayName}>{displayName}</Text>
                  {realName && realName !== displayName && (
                    <Text style={styles.startRealName}>{realName}</Text>
                  )}

                  {/* Role Badge */}
                  <View style={[styles.startRoleBadge, { backgroundColor: roleColor + "18", borderColor: roleColor + "35" }]}>
                    <Text style={[styles.startRoleText, { color: roleColor }]}>
                      {getRoleDisplayName(role || "student").toUpperCase()}
                    </Text>
                  </View>

                  <Text style={styles.startSubtitle}>You’re connected on Bonded</Text>
                  <Text style={styles.startCaption}>
                    Direct messages between you and {displayName} are private.
                  </Text>

                  {/* Interactive Wave to say hi button (Messenger iconic feature) */}
                  {messages.length <= 2 && (
                    <TouchableOpacity
                      style={[styles.waveBtn, { backgroundColor: themeColor + "15", borderColor: themeColor + "35" }]}
                      onPress={() => void handleSend("👋")}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel={`Wave to ${displayName}`}
                    >
                      <Text style={styles.waveIcon}>👋</Text>
                      <Text style={[styles.waveText, { color: themeColor }]}>
                        Wave to {displayName.split(" ")[0] || "say hi"}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            }
            keyExtractor={(item) => item.id}
            contentContainerStyle={[styles.messagesList, { paddingBottom: 16 }]}
            windowSize={7}
            initialNumToRender={14}
            maxToRenderPerBatch={10}
            updateCellsBatchingPeriod={30}
            removeClippedSubviews={Platform.OS === "android"}
            renderItem={({ item, index }) => {
              const isOwn = item.senderId === currentUserId;
              const newer = messages[messages.length - index];
              const older = messages[messages.length - 2 - index];
              const showAvatar = !newer || newer.senderId !== item.senderId || timestampMillis(newer.createdAt) - timestampMillis(item.createdAt) > 300000;
              const isLatestOwn = item.id === lastOwnMessageId;
              return (
                <DirectMessageBubble
                  item={item}
                  isOwn={isOwn}
                  themeColor={themeColor}
                  recipientAvatar={recipientAvatar}
                  recipientName={displayName}
                  showAvatar={showAvatar}
                  isPending={pendingIds.has(item.id)}
                  showSeenAvatar={item.id === seenMessageId}
                  showStatus={isLatestOwn && lastMessageIsOwn && item.id !== seenMessageId}
                  timeLabel={
                    needsTimeLabel(item, older)
                      ? formatChatTimeLabel(timestampMillis(item.createdAt), nowMs)
                      : null
                  }
                  isDelivered={receiptCoversMessage(conversation?.lastDeliveredAt?.[recipientId], item.createdAt)}
                  isHighlighted={item.id === activeHighlightedMessageId}
                  revealedTimestamp={revealedTimestampId === item.id}
                  nowMs={nowMs}
                  onLongPress={(targetMsg, pageY) => {
                    Keyboard.dismiss();
                    setActionMenuTarget(targetMsg);
                    setMoreMenuOpen(false);
                    if (typeof pageY === "number") {
                      setActionMenuY(pageY);
                    }
                  }}
                  onOpenLink={handleOpenLink}
                  onReactionPress={handleReactionPress}
                  onOpenImage={setViewerImage}
                  onToggleReveal={(id) => setRevealedTimestampId((prev) => (prev === id ? null : id))}
                  onSwipeReply={handleSwipeReply}
                  onJumpToMessage={(id) => { Keyboard.dismiss(); void handleJumpToMessage(id); }}
                />
              );
            }}
          />
        )}

        {/* ==================== SWIPE REPLY BANNER ==================== */}
        {isSearching && !!searchQuery.trim() && <Pressable disabled={!searchError} onPress={() => setRetryCount((value) => value + 1)} style={styles.chatNotice}>
          <Text style={styles.chatNoticeText}>{searchLoading ? "Searching all messages..." : searchError || (searchMatches.length ? `${searchMatches.length} matches` : "No matches in your history")}</Text>
        </Pressable>}
        {jumping && <Text style={styles.chatNoticeText}>Loading message...</Text>}
        {!!historyAnchor && <Pressable onPress={backToLatest} style={styles.chatNotice} accessibilityRole="button"><Text style={{ color: themeColor, fontWeight: "600" }}>Back to latest messages ↓</Text></Pressable>}
        {!!notice && <View style={styles.chatNotice}><Text style={styles.chatNoticeText} accessibilityLiveRegion="polite">{notice}</Text></View>}
        {isTyping && <ChatTypingIndicator name={displayName} avatar={recipientAvatar} />}
        {editingMessage && <View style={styles.replyBanner}>
          <Ionicons name="create-outline" size={20} color={themeColor} />
          <View style={{ flex: 1, paddingHorizontal: 10 }}>
            <Text style={styles.replyBannerSender}>Edit message</Text>
            <Text style={styles.replyBannerText} numberOfLines={2}>{editError || "Your original draft will be here when you finish."}</Text>
          </View>
          <Pressable disabled={savingEdit} style={{ padding: 10 }} onPress={() => { setEditingMessage(null); setSelectionOverride(undefined); stopTyping(); }}><Text style={{ color: themeColor }}>Cancel</Text></Pressable>
        </View>}
        {replyingTo && !editingMessage && (
          <View style={styles.replyBanner}>
            <View style={[styles.replyBannerBar, { backgroundColor: themeColor }]} />
            <Pressable style={{ flex: 1 }} onPress={() => { Keyboard.dismiss(); void handleJumpToMessage(replyingTo.id); }} accessibilityLabel="Go to original message" accessibilityRole="button">
              <Text style={styles.replyBannerSender} numberOfLines={1}>
                {/* Replying to your own message named you back at yourself.
                    replyingTo is the message, so the sender is known here. */}
                {replyingTo.senderId === currentUserId
                  ? "Replying to yourself"
                  : `Replying to ${replyingTo.senderName}`}
              </Text>
              <Text style={styles.replyBannerText} numberOfLines={1}>
                {replyPreviewText(replyingTo)}
              </Text>
            </Pressable>
            <TouchableOpacity disabled={composerBusy} onPress={() => setReplyingTo(null)} style={{ padding: 4 }}>
              <Ionicons name="close" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
        )}

        {/* ==================== COMPOSER ==================== */}
        {draftAttachment && !editingMessage && (
          <View style={styles.attachmentPreview}>
            {draftAttachment.mimeType.startsWith("image/") ? (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Preview selected image"
                disabled={composerBusy} onPress={() => setViewerImage(draftAttachment.uri)}>
                <Image source={{ uri: draftAttachment.uri }} style={styles.attachmentThumbnail} contentFit="cover" />
              </TouchableOpacity>
            ) : (
              <View style={[styles.attachmentThumbnail, styles.attachmentFileIcon]}>
                <Ionicons name="document-text-outline" size={28} color={themeColor} />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={styles.attachmentName}>{draftAttachment.name}</Text>
              <Text style={styles.attachmentStatus} accessibilityLiveRegion="polite">
                {isUploading ? "Uploading…" : isSending ? "Sending…" : "Ready to send"}
              </Text>
              {draftAttachment.source === "camera" && !isSending && (
                <TouchableOpacity disabled={composerBusy} onPress={() => void handlePickPhoto("camera")}
                  accessibilityRole="button" accessibilityLabel="Retake photo" style={styles.retakeButton}>
                  <Text style={{ color: themeColor, fontWeight: "600" }}>Retake</Text>
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity disabled={composerBusy} onPress={() => setDraftAttachment(null)}
              accessibilityRole="button" accessibilityLabel="Remove attachment" style={styles.removeAttachmentButton}>
              <Ionicons name="close-circle" size={24} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
        )}
        <View style={[styles.composerWrap, { paddingBottom: keyboardVisible || emojiPickerVisible ? 8 : Math.max(insets.bottom, 10) }]}>
          <TouchableOpacity disabled={composerBusy || !!editingMessage} onPress={() => void handlePickPhoto("camera")} style={styles.composerAttachBtn}
            accessibilityRole="button" accessibilityLabel="Take a photo">
            <Ionicons name="camera-outline" size={23} color={theme.primary} />
          </TouchableOpacity>

          <TouchableOpacity disabled={composerBusy || !!editingMessage} onPress={() => void handlePickPhoto("gallery")} style={styles.composerAttachBtn}
            accessibilityRole="button" accessibilityLabel="Choose a photo">
            <Ionicons name="image-outline" size={23} color={theme.primary} />
          </TouchableOpacity>

          <TouchableOpacity disabled={composerBusy || !!editingMessage} onPress={handlePickDocument} style={styles.composerAttachBtn}
            accessibilityRole="button" accessibilityLabel="Attach a file">
            <Ionicons name="attach-outline" size={23} color={theme.primary} />
          </TouchableOpacity>

          <View style={styles.composerInputWrap}>
            <TextInput
              ref={inputRef}
              style={styles.composerTextInput}
              accessibilityLabel="Message"
              placeholder="Message..."
              placeholderTextColor="#af928b"
              value={editingMessage ? editText : inputText}
              onChangeText={(text) => {
                if (editingMessage) setEditText(text); else setInputText(text);
                onTextChanged(text); setSelectionOverride(undefined);
              }}
              selection={selectionOverride}
              onSelectionChange={({ nativeEvent }) => {
                if (!emojiPickerVisible) {
                  selectionRef.current = nativeEvent.selection;
                  setSelectionOverride(undefined);
                }
              }}
              onFocus={() => setEmojiPickerVisible(false)}
              multiline
              editable={!composerBusy}
              maxLength={MESSAGE_MAX_LENGTH}
            />
            <TouchableOpacity disabled={composerBusy} onPress={toggleEmojiPicker} style={styles.composerSmileyBtn}
              accessibilityRole="button" accessibilityLabel={emojiPickerVisible ? "Show keyboard" : "Choose emoji"}
              accessibilityState={{ expanded: emojiPickerVisible }}>
              <Ionicons name={emojiPickerVisible ? "keypad-outline" : "happy-outline"} size={23} color={themeColor} />
            </TouchableOpacity>
          </View>

          {editingMessage || inputText.trim().length > 0 || draftAttachment || isSending ? (
            <TouchableOpacity
              onPress={() => editingMessage ? void saveEdit() : void handleSend()}
              style={[styles.composerSendBtn, { backgroundColor: themeColor }]}
              disabled={sendDisabled || (!!editingMessage && !editText.trim())}
              accessibilityRole="button"
              accessibilityLabel={editingMessage ? "Save edit" : isSending ? "Sending message" : "Send message"}
              accessibilityState={{ disabled: composerBusy, busy: isSending }}
            >
              {isSending || savingEdit ? <ActivityIndicator size="small" color="#fff" /> : editingMessage ? <Text style={{ color: "#fff", fontWeight: "700", fontSize: 11 }}>Save</Text> : <Ionicons name="arrow-up" size={20} color="#fff" />}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => void handleSend(quickEmoji)}
              style={styles.composerEmojiBtn}
              disabled={composerBusy}
              accessibilityRole="button"
              accessibilityLabel={`Send ${quickEmoji}`}
            >
              <Text style={{ fontSize: 24 }}>{quickEmoji}</Text>
            </TouchableOpacity>
          )}
        </View>
        {emojiPickerVisible && !keyboardVisible && (
          <ChatEmojiPicker onSelect={handleInsertEmoji} onClose={() => setEmojiPickerVisible(false)}
            onOpenGifs={editingMessage ? undefined : () => { stopTyping(); setEmojiPickerVisible(false); setGifPickerVisible(true); }}
            disabled={composerBusy} color={themeColor} bottomInset={insets.bottom} />
        )}
      </View>

      {gifPickerVisible && <ChatGifPicker color={themeColor} onClose={() => setGifPickerVisible(false)} onSelect={(gif) => {
        setDraftAttachment({ uri: gif.url, name: gif.title, mimeType: "image/gif", source: "gif",
          uploaded: { url: gif.url, name: gif.title, mimeType: "image/gif" } });
        setGifPickerVisible(false);
      }} />}

      {/* ==================== MESSENGER ACTION & REACTION MODAL ==================== */}
      <Modal
        visible={!!actionMenuTarget}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setActionMenuTarget(null);
          setMoreMenuOpen(false);
        }}
      >
        <Pressable
          style={styles.actionModalOverlay}
          onPress={() => {
            setActionMenuTarget(null);
            setMoreMenuOpen(false);
          }}
        >
          {actionMenuTarget && (
            <View
              style={[
                styles.actionFloatingArea,
                {
                  top: Math.max(
                    insets.top + 24,
                    Math.min(actionMenuY - 140, SCREEN_HEIGHT - 360)
                  ),
                },
              ]}
              onStartShouldSetResponder={() => true}
            >
              {/* Messenger Floating Reaction Pill */}
              <View style={styles.floatingReactionPill}>
                {EMOJI_REACTIONS.map((emoji) => {
                  const hasReacted = (actionMenuTarget.reactions?.[emoji] || []).includes(currentUserId);
                  return (
                    <TouchableOpacity
                      key={emoji}
                      onPress={() => {
                        handleReactionPress(actionMenuTarget, emoji);
                        setActionMenuTarget(null);
                        setMoreMenuOpen(false);
                      }}
                      activeOpacity={0.7}
                      style={[
                        styles.reactionPillEmojiBtn,
                        hasReacted && styles.reactionPillEmojiBtnActive,
                      ]}
                    >
                      <Text style={styles.floatingEmojiText}>{emoji}</Text>
                    </TouchableOpacity>
                  );
                })}
                {/* Plus button for full emoji reaction picker */}
                <TouchableOpacity
                  style={styles.reactionPillPlusBtn}
                  activeOpacity={0.7}
                  onPress={() => {
                    const target = actionMenuTarget;
                    setActionMenuTarget(null);
                    setMoreMenuOpen(false);
                    setReactionPickerTarget(target);
                  }}
                >
                  <Ionicons name="add" size={20} color="#e4e6eb" />
                </TouchableOpacity>
              </View>

              {/* Focused Message Bubble Preview */}
              <View
                style={[
                  styles.focusedBubbleWrap,
                  actionMenuTarget.senderId === currentUserId
                    ? styles.focusedBubbleWrapOwn
                    : styles.focusedBubbleWrapOther,
                ]}
              >
                {actionMenuTarget.senderId !== currentUserId && (
                  <View style={styles.focusedAvatarWrap}>
                    {recipientAvatar ? (
                      <Image
                        source={{ uri: avatarThumb(recipientAvatar, 28) }}
                        style={styles.incomingAvatar}
                      />
                    ) : (
                      <View style={[styles.incomingAvatar, styles.chatAvatarFallback]}>
                        <Text style={styles.chatAvatarInitial}>
                          {displayName[0]?.toUpperCase() || "?"}
                        </Text>
                      </View>
                    )}
                  </View>
                )}
                <View
                  style={[
                    styles.bubbleBox,
                    actionMenuTarget.senderId === currentUserId
                      ? [styles.bubbleBoxOwn, { backgroundColor: themeColor }]
                      : styles.bubbleBoxOther,
                  ]}
                >
                  {!!actionMenuTarget.replyTo && (
                    <View style={[styles.replyQuoteWrap, actionMenuTarget.senderId === currentUserId && styles.replyQuoteWrapOwn]}>
                      <View style={[styles.replyQuoteBar, { backgroundColor: actionMenuTarget.senderId === currentUserId ? "#fff" : themeColor }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.replyQuoteSender, actionMenuTarget.senderId === currentUserId && styles.replyQuoteTextOwn]} numberOfLines={1}>
                          {actionMenuTarget.replyTo.senderName}
                        </Text>
                        <Text style={[styles.replyQuotePreview, actionMenuTarget.senderId === currentUserId && styles.replyQuoteTextOwn]} numberOfLines={1}>
                          {actionMenuTarget.replyTo.preview}
                        </Text>
                      </View>
                    </View>
                  )}
                  {!!actionMenuTarget.text && (
                    <Text
                      style={[
                        styles.messageText,
                        actionMenuTarget.senderId === currentUserId && styles.messageTextOwn,
                      ]}
                    >
                      {actionMenuTarget.text}
                    </Text>
                  )}
                </View>
              </View>
            </View>
          )}

          {/* Expanded "More" Menu Sheet if user tapped More */}
          {moreMenuOpen && actionMenuTarget && (
            <View
              style={[styles.moreMenuSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}
              onStartShouldSetResponder={() => true}
            >
              <View style={styles.moreMenuHandle} />
              {actionMenuTarget.senderId === currentUserId &&
                !!actionMenuTarget.text &&
                !actionMenuTarget.deleted && (
                  <TouchableOpacity
                    style={styles.moreMenuRow}
                    disabled={composerBusy}
                    onPress={() => {
                      setEditingMessage(actionMenuTarget);
                      setEditText(actionMenuTarget.text);
                      setEditError("");
                      selectionRef.current = {
                        start: actionMenuTarget.text.length,
                        end: actionMenuTarget.text.length,
                      };
                      setSelectionOverride(selectionRef.current);
                      setActionMenuTarget(null);
                      setMoreMenuOpen(false);
                      setEmojiPickerVisible(false);
                      requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                  >
                    <Ionicons name="create-outline" size={20} color="#e4e6eb" />
                    <Text style={styles.moreMenuRowText}>Edit message</Text>
                  </TouchableOpacity>
                )}

              <TouchableOpacity
                style={styles.moreMenuRow}
                onPress={() => {
                  handleTogglePin(actionMenuTarget);
                  setActionMenuTarget(null);
                  setMoreMenuOpen(false);
                }}
              >
                <Ionicons
                  name={actionMenuTarget.pinned ? "pin" : "pin-outline"}
                  size={20}
                  color={theme.accent}
                />
                <Text style={styles.moreMenuRowText}>
                  {actionMenuTarget.pinned ? "Unpin message" : "Pin message"}
                </Text>
              </TouchableOpacity>

              {messageLinks(actionMenuTarget).map((link) => (
                <TouchableOpacity
                  key={link}
                  style={styles.moreMenuRow}
                  onPress={() => {
                    void copyContent(link, "Link");
                    setActionMenuTarget(null);
                    setMoreMenuOpen(false);
                  }}
                >
                  <Ionicons name="link-outline" size={20} color="#3b82f6" />
                  <Text style={styles.moreMenuRowText} numberOfLines={1}>
                    Copy link
                  </Text>
                </TouchableOpacity>
              ))}

              {actionMenuTarget.senderId === currentUserId && (
                <TouchableOpacity
                  style={[styles.moreMenuRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.12)" }]}
                  onPress={() => {
                    const target = actionMenuTarget;
                    setActionMenuTarget(null);
                    setMoreMenuOpen(false);
                    handleDeleteMessage(target);
                  }}
                >
                  <Ionicons name="trash-outline" size={20} color="#ef4444" />
                  <Text style={[styles.moreMenuRowText, { color: "#ef4444" }]}>
                    Delete message
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Messenger Bottom Action Bar (Reply / Copy / Forward / More) */}
          {actionMenuTarget && !moreMenuOpen && (
            <View
              style={[
                styles.messengerBottomBar,
                { paddingBottom: Math.max(insets.bottom, 14) },
              ]}
              onStartShouldSetResponder={() => true}
            >
              <TouchableOpacity
                style={styles.messengerActionBtn}
                onPress={() => {
                  handleSwipeReply(actionMenuTarget.id);
                  setActionMenuTarget(null);
                  setMoreMenuOpen(false);
                }}
              >
                <Ionicons name="arrow-undo" size={22} color="#3b82f6" />
                <Text style={styles.messengerActionLabel}>Reply</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.messengerActionBtn}
                onPress={() => {
                  void copyContent(actionMenuTarget.text, "Message");
                  setActionMenuTarget(null);
                  setMoreMenuOpen(false);
                }}
              >
                <Ionicons name="copy-outline" size={22} color="#3b82f6" />
                <Text style={styles.messengerActionLabel}>Copy</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.messengerActionBtn}
                onPress={() => {
                  setForwardTarget(actionMenuTarget);
                  setActionMenuTarget(null);
                  setMoreMenuOpen(false);
                }}
              >
                <Ionicons name="arrow-redo-outline" size={22} color="#3b82f6" />
                <Text style={styles.messengerActionLabel}>Forward</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.messengerActionBtn}
                onPress={() => setMoreMenuOpen(true)}
              >
                <Ionicons name="ellipsis-horizontal" size={22} color="#3b82f6" />
                <Text style={styles.messengerActionLabel}>More</Text>
              </TouchableOpacity>
            </View>
          )}
        </Pressable>
      </Modal>

      {/* Full Emoji Picker for Reactions */}
      {!!reactionPickerTarget && (
        <Modal
          visible={true}
          transparent
          animationType="slide"
          onRequestClose={() => setReactionPickerTarget(null)}
        >
          <Pressable
            style={styles.actionModalOverlay}
            onPress={() => setReactionPickerTarget(null)}
          >
            <View
              style={[
                styles.reactionPickerSheet,
                { paddingBottom: Math.max(insets.bottom, 12) },
              ]}
              onStartShouldSetResponder={() => true}
            >
              <ChatEmojiPicker
                onSelect={(emoji) => {
                  if (reactionPickerTarget) {
                    handleReactionPress(reactionPickerTarget, emoji);
                    setReactionPickerTarget(null);
                  }
                }}
                onClose={() => setReactionPickerTarget(null)}
                disabled={false}
                color={themeColor}
                bottomInset={insets.bottom}
              />
            </View>
          </Pressable>
        </Modal>
      )}

      {/* ==================== CONVERSATION INFO & SETTINGS SHEET ==================== */}
      <Modal
        visible={infoSheetVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setInfoSheetVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Conversation Details</Text>
            <TouchableOpacity onPress={() => setInfoSheetVisible(false)} style={{ padding: 6 }}>
              <Ionicons name="close" size={24} color={theme.primary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {/* Participant Hero */}
            <View style={styles.infoHero}>
              {recipientAvatar ? (
                <Image
                  source={{ uri: avatarThumb(recipientAvatar, 80) }}
                  style={styles.infoHeroAvatar}
                  contentFit="cover"
                />
              ) : (
                <View style={[styles.infoHeroAvatarPlaceholder, { backgroundColor: roleColor + "25" }]}>
                  <Text style={[styles.infoHeroAvatarInitials, { color: roleColor }]}>
                    {(displayName[0] || "U").toUpperCase()}
                  </Text>
                </View>
              )}
              <Text style={styles.infoHeroName}>{displayName}</Text>
              {recipientNickname && (
                <Text style={styles.infoHeroRealName}>{realName}</Text>
              )}
            </View>

            {/* Customization Settings */}
            <Text style={styles.sectionHeader}>Customization</Text>
            {!hasConversation && <Text style={styles.galleryEmptyText}>Send a message to customize this chat.</Text>}

            {/* Theme Picker */}
            <View style={styles.settingCard}>
              <Text style={styles.settingTitle}>Chat Theme</Text>
              <View style={styles.themePaletteRow}>
                {MESSENGER_THEMES.map((t) => (
                  <TouchableOpacity
                    key={t.id}
                    disabled={!hasConversation}
                    style={[
                      styles.themeCircle,
                      { backgroundColor: t.color },
                      themeColor === t.color && styles.themeCircleActive,
                    ]}
                    onPress={() => void updateConversationTheme(conversationId, t.color)}
                  >
                    {themeColor === t.color && <Ionicons name="checkmark" size={16} color="#fff" />}
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Edit Nickname */}
            <TouchableOpacity
              style={styles.actionSettingRow}
              disabled={!hasConversation}
              onPress={() => {
                setEditingNickname(recipientNickname || "");
                setNicknameModalVisible(true);
              }}
            >
              <View style={styles.actionSettingLeft}>
                <Ionicons name="text-outline" size={20} color={theme.primary} />
                <Text style={styles.actionSettingTitle}>Edit Nicknames</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
            </TouchableOpacity>

            {/* Notification Mute */}
            <View style={styles.actionSettingRow}>
              <View style={styles.actionSettingLeft}>
                <Ionicons
                  name={isMuted ? "notifications-off-outline" : "notifications-outline"}
                  size={20}
                  color={theme.primary}
                />
                <Text style={styles.actionSettingTitle}>Mute Notifications</Text>
              </View>
              <TouchableOpacity
                disabled={!hasConversation}
                onPress={() => void toggleMuteConversation(conversationId, currentUserId, !isMuted)}
                style={[styles.toggleBtn, isMuted && styles.toggleBtnActive]}
              >
                <Text style={[styles.toggleBtnText, isMuted && styles.toggleBtnTextActive]}>
                  {isMuted ? "Muted" : "Unmuted"}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Shared Media, Files, and Links */}
            <Text style={[styles.sectionHeader, { marginTop: 24 }]}>Shared Content</Text>

            <View style={styles.galleryTabsRow}>
              <TouchableOpacity
                style={[styles.galleryTab, mediaTab === "media" && styles.galleryTabActive]}
                onPress={() => setMediaTab("media")}
              >
                <Text style={[styles.galleryTabText, mediaTab === "media" && styles.galleryTabTextActive]}>
                  Media ({galleryItems.media.length})
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.galleryTab, mediaTab === "files" && styles.galleryTabActive]}
                onPress={() => setMediaTab("files")}
              >
                <Text style={[styles.galleryTabText, mediaTab === "files" && styles.galleryTabTextActive]}>
                  Files ({galleryItems.files.length})
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.galleryTab, mediaTab === "links" && styles.galleryTabActive]}
                onPress={() => setMediaTab("links")}
              >
                <Text style={[styles.galleryTabText, mediaTab === "links" && styles.galleryTabTextActive]}>
                  Links ({galleryItems.links.length})
                </Text>
              </TouchableOpacity>
            </View>

            {mediaTab === "media" && (
              <View style={styles.mediaGrid}>
                {galleryItems.media.map((item, idx) => (
                  <TouchableOpacity
                    key={`${item.id}_${idx}`}
                    onPress={() => setViewerImage(item.url)}
                    style={styles.mediaTile}
                  >
                    <Image source={{ uri: item.url }} style={styles.mediaTileImg} contentFit="cover" />
                  </TouchableOpacity>
                ))}
                {galleryItems.media.length === 0 && (
                  <Text style={styles.galleryEmptyText}>No media shared yet</Text>
                )}
              </View>
            )}

            {mediaTab === "files" && (
              <View style={styles.filesList}>
                {galleryItems.files.map((item, idx) => {
                  const details = getFileIconDetails(item.mimeType, item.name);
                  return (
                    <TouchableOpacity
                      key={`${item.id}_${idx}`}
                      style={styles.fileRow}
                      onPress={() => Linking.openURL(item.url).catch(() => null)}
                    >
                      <Ionicons name={details.icon as any} size={22} color={details.color} />
                      <Text style={styles.fileRowText} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Ionicons name="download-outline" size={18} color={theme.textMuted} />
                    </TouchableOpacity>
                  );
                })}
                {galleryItems.files.length === 0 && (
                  <Text style={styles.galleryEmptyText}>No files shared yet</Text>
                )}
              </View>
            )}

            {mediaTab === "links" && (
              <View style={styles.filesList}>
                {galleryItems.links.map((item, idx) => (
                  <TouchableOpacity
                    key={`${item.id}_${idx}`}
                    style={styles.fileRow}
                    onPress={() => Linking.openURL(item.url).catch(() => null)}
                  >
                    <Ionicons name="link-outline" size={20} color="#1d4ed8" />
                    <Text style={styles.fileRowText} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Ionicons name="open-outline" size={16} color={theme.textMuted} />
                  </TouchableOpacity>
                ))}
                {galleryItems.links.length === 0 && (
                  <Text style={styles.galleryEmptyText}>No links shared yet</Text>
                )}
              </View>
            )}

            {/* Pinned Messages Section */}
            <Text style={[styles.sectionHeader, { marginTop: 24 }]}>
              Pinned Messages ({pinnedMessages.length})
            </Text>
            {pinnedMessages.map((pMsg) => (
              <View key={pMsg.id} style={styles.pinnedItemCard}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pinnedItemSender}>{pMsg.senderName}</Text>
                  <Text style={styles.pinnedItemText} numberOfLines={2}>
                    {pMsg.text || "Attachment"}
                  </Text>
                </View>
                <View style={styles.pinnedItemActions}>
                  <TouchableOpacity
                    onPress={() => {
                      setInfoSheetVisible(false);
                      handleJumpToMessage(pMsg.id);
                    }}
                    style={styles.pinnedJumpBtn}
                  >
                    <Text style={styles.pinnedJumpBtnText}>Jump</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => void togglePinDirectMessage(conversationId, pMsg.id, false, currentUserId)}
                    style={styles.pinnedUnpinBtn}
                  >
                    <Ionicons name="close" size={16} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            {pinnedMessages.length === 0 && (
              <Text style={styles.galleryEmptyText}>No pinned messages</Text>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* ==================== EDIT NICKNAME MODAL ==================== */}
      <Modal
        visible={nicknameModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setNicknameModalVisible(false)}
      >
        {/* actionModalOverlay is shared with the action menu, which positions
            itself absolutely and must not be centred — so this uses its own
            centred overlay rather than changing the shared one. */}
        <KeyboardAvoidingView
          style={styles.centeredModalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.nicknameModalCard}>
            <Text style={styles.nicknameModalTitle}>Edit Nickname</Text>
            <Text style={styles.nicknameModalSubtitle}>
              Set a nickname for {realName}. Only participants in this chat will see it.
            </Text>
            <TextInput
              style={styles.nicknameInput}
              placeholder="Enter nickname..."
              placeholderTextColor="#af928b"
              value={editingNickname}
              onChangeText={setEditingNickname}
              autoFocus
            />
            <View style={styles.nicknameModalButtons}>
              <TouchableOpacity
                onPress={() => setNicknameModalVisible(false)}
                style={styles.nicknameCancelBtn}
              >
                <Text style={styles.nicknameCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  await updateConversationNickname(conversationId, recipientId, editingNickname);
                  setNicknameModalVisible(false);
                }}
                style={[styles.nicknameSaveBtn, { backgroundColor: themeColor }]}
              >
                <Text style={styles.nicknameSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ==================== FORWARD MODAL ==================== */}
      <Modal
        visible={!!forwardTarget}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setForwardTarget(null)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Forward Message</Text>
            <TouchableOpacity onPress={() => setForwardTarget(null)} style={{ padding: 6 }}>
              <Ionicons name="close" size={24} color={theme.primary} />
            </TouchableOpacity>
          </View>

          {forwardTarget && (
            <View style={styles.forwardSnippetCard}>
              <View style={[styles.forwardSnippetBar, { backgroundColor: themeColor }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.forwardSnippetSender}>{forwardTarget.senderName}</Text>
                <Text style={styles.forwardSnippetText} numberOfLines={2}>
                  {forwardTarget.text || (forwardTarget.files?.length ? "Attachment" : "")}
                </Text>
              </View>
            </View>
          )}

          <FlatList
            data={otherConversations.filter((c) => c.id !== conversationId)}
            keyExtractor={(c) => c.id}
            contentContainerStyle={{ padding: 16 }}
            renderItem={({ item }) => {
              const otherId = item.participants.find((p) => p !== currentUserId) || "";
              const detail = item.participantDetails?.[otherId];
              const name = item.nicknames?.[otherId] || detail?.displayName || "User";
              const isSent = forwardSentMap[item.id];

              return (
                <View style={styles.forwardRow}>
                  <View style={styles.forwardRowLeft}>
                    {detail?.profileImage ? (
                      <Image
                        source={{ uri: avatarThumb(detail.profileImage, AVATAR_SIZE_SMALL) }}
                        style={styles.headerAvatar}
                      />
                    ) : (
                      <View style={[styles.avatarPlaceholderSmall, { backgroundColor: "#8f211722" }]}>
                        <Text style={styles.avatarInitialsSmall}>{(name[0] || "U").toUpperCase()}</Text>
                      </View>
                    )}
                    <Text style={styles.forwardRowName} numberOfLines={1}>
                      {name}
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={[styles.forwardSendBtn, isSent && styles.forwardSendBtnSent]}
                    disabled={isSent}
                    onPress={async () => {
                      if (!forwardTarget) return;
                      try {
                        const myProfile = await getUserDataByAuthUser(auth.currentUser);
                        const myName =
                          myProfile?.firstname && myProfile?.lastname
                            ? `${myProfile.firstname} ${myProfile.lastname}`.trim()
                            : auth.currentUser?.displayName || "User";

                        await sendDirectMessage({
                          conversationId: item.id,
                          sender: {
                            uid: currentUserId,
                            displayName: myName,
                            profileImage: resolveAvatarUri(myProfile),
                            role: myProfile?.role || "student",
                          },
                          text: forwardTarget.text,
                          files: forwardTarget.files,
                          forwarded: true,
                          forwardedFrom: {
                            senderName: forwardTarget.senderName,
                            preview: forwardTarget.text.slice(0, 100),
                          },
                          recipients: item.participants,
                        });

                        setForwardSentMap((prev) => ({ ...prev, [item.id]: true }));
                      } catch (e) {
                        console.warn("Forward error:", e);
                      }
                    }}
                  >
                    <Text style={[styles.forwardSendBtnText, isSent && styles.forwardSendBtnTextSent]}>
                      {isSent ? "Sent" : "Send"}
                    </Text>
                  </TouchableOpacity>
                </View>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.galleryEmptyText}>No other conversations available to forward</Text>
            }
          />
        </SafeAreaView>
      </Modal>

      {/* Image Viewer */}
      <ImageZoomViewer
        images={viewerImage ? [viewerImage] : []}
        startIndex={0}
        visible={!!viewerImage}
        showActions={false}
        onClose={() => setViewerImage(null)}
      />
      <ExternalLinkDialog link={pendingLink} onClose={() => setPendingLink(null)} />
    </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

/* ==================== STYLES ==================== */
const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  activityRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  activityDot: { width: 7, height: 7, borderRadius: 4 },
  container: {
    flex: 1,
    backgroundColor: c.surface,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
    backgroundColor: c.surface,
  },
  headerBackBtn: {
    padding: 6,
    marginRight: 4,
  },
  headerProfileSection: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  headerAvatarWrap: {
    marginRight: 10,
  },
  headerAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
  },
  avatarPlaceholderSmall: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarInitialsSmall: {
    fontSize: 16,
    fontWeight: "700",
  },
  headerNameCol: {
    flex: 1,
  },
  headerNameRow: {
    flexDirection: "row",
    alignItems: "center",
    // Lets the name shrink instead of pushing the role chip off the header.
    minWidth: 0,
  },
  headerDisplayName: {
    fontSize: 15.5,
    fontWeight: "800",
    color: c.textPrimary,
    marginRight: 6,
    flexShrink: 1,
  },
  headerSubstatus: {
    fontSize: 11.5,
    color: c.textMuted,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  headerActionBtn: {
    padding: 6,
  },

  /* Search Header */
  searchHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  searchHeaderInput: {
    flex: 1,
    fontSize: 15,
    color: c.textPrimary,
    paddingHorizontal: 8,
  },
  searchControlsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  searchMatchCount: {
    fontSize: 12,
    color: c.textMuted,
    fontWeight: "600",
  },
  searchNavBtn: {
    padding: 4,
  },

  /* Role chip */
  roleChip: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    // Never squashed and never pushed out — the name shrinks instead.
    flexShrink: 0,
  },
  roleChipText: {
    fontSize: 9.5,
    fontWeight: "800",
    textTransform: "uppercase",
  },

  /* Pinned Banner */
  pinnedBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(224, 165, 61, 0.12)",
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(224, 165, 61, 0.25)",
    gap: 8,
  },
  pinnedBannerText: {
    flex: 1,
    fontSize: 12.5,
    color: "#5f3d05",
  },

  /* Messages list */
  messagesList: {
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },

  /* Bubble Styles */
  bubbleContainer: {
    marginVertical: 3,
    maxWidth: "82%",
  },
  bubbleContainerOwn: {
    alignSelf: "flex-end",
  },
  bubbleContainerOther: {
    alignSelf: "flex-start",
    marginLeft: 34,
    maxWidth: "78%",
  },
  incomingAvatarWrap: { position: "absolute", left: -34, bottom: 0 },
  incomingAvatar: { width: 28, height: 28, borderRadius: 14 },
  chatAvatarFallback: { alignItems: "center", justifyContent: "center", backgroundColor: c.border },
  chatAvatarInitial: { fontSize: 12, fontWeight: "600", color: c.primary },
  editedLabel: { fontSize: 10, color: c.textMuted, marginTop: 4 },
  chatNotice: { padding: 9, alignItems: "center", backgroundColor: c.surfaceSunken },
  chatNoticeText: { fontSize: 12, color: c.textMuted, textAlign: "center" },
  revealedTimeText: {
    fontSize: 10.5,
    color: c.textMuted,
    textAlign: "center",
    marginVertical: 4,
  },
  bubbleBox: {
    borderRadius: 18,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  bubbleBoxOwn: {
    borderBottomRightRadius: 4,
    alignSelf: "flex-end",
  },
  bubbleBoxOther: {
    backgroundColor: c.surfaceSunken,
    borderBottomLeftRadius: 4,
    alignSelf: "flex-start",
  },
  // A deleted message keeps its place in the thread but stops looking like
  // one: no bubble, no colour, just a small grey note.
  bubbleBoxDeleted: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  deletedRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  deletedText: {
    color: c.textMuted,
    fontSize: 12.5,
    fontStyle: "italic",
  },
  bubbleHighlighted: {
    borderWidth: 2,
    borderColor: c.accent,
  },
  messageText: {
    fontSize: 15,
    color: c.textPrimary,
    lineHeight: 20.5,
  },
  messageTextOwn: {
    color: c.onPrimary,
  },

  /* Forwarded Tag */
  forwardedHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  forwardedTagText: {
    fontSize: 11,
    color: c.textMuted,
    fontStyle: "italic",
  },
  forwardedTagTextOwn: {
    color: "rgba(255,255,255,0.85)",
  },

  /* Quoted Reply */
  replyQuoteWrap: {
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.06)",
    borderRadius: 8,
    padding: 6,
    marginBottom: 6,
    gap: 8,
    // The bubble is sized by its content, and a flexible child measures as
    // zero — without this the quote's text collapses next to a short
    // message and only the bar shows.
    minWidth: 150,
  },
  // One small line above the bubble, the way Messenger marks a reply.
  replyLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 3,
    paddingHorizontal: 4,
  },
  replyLabelRowOwn: { justifyContent: "flex-end" },
  // The quoted message, muted and sitting above the reply the way Messenger
  // shows it. Outside the bubble, so it never changes the bubble's width.
  replyEcho: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    alignSelf: "flex-start",
    maxWidth: "100%",
    backgroundColor: c.surfaceSunken,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 3,
  },
  replyEchoOwn: { alignSelf: "flex-end" },
  replyEchoText: {
    color: c.textMuted,
    fontSize: 12.5,
    flexShrink: 1,
  },
  replyEchoThumb: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.08)",
  },
  replyLabelText: {
    color: c.textMuted,
    fontSize: 11.5,
    fontWeight: "600",
    flexShrink: 1,
  },
  replyQuoteWrapOwn: {
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  replyQuoteBar: {
    width: 3,
    borderRadius: 1.5,
  },
  replyQuoteSender: {
    fontSize: 11,
    fontWeight: "700",
    color: c.primary,
    marginBottom: 1,
  },
  replyQuotePreview: {
    fontSize: 12,
    color: c.textSecondary,
  },
  replyQuoteTextOwn: {
    color: c.onPrimary,
  },

  /* Images in Bubble */
  imageGrid: {
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 4,
  },


  /* Doc attachment */
  docChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.06)",
    padding: 8,
    borderRadius: 10,
    gap: 8,
    marginBottom: 4,
  },
  docChipOwn: {
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  docChipText: {
    fontSize: 13,
    color: c.textPrimary,
    fontWeight: "600",
    flex: 1,
  },
  docChipTextOwn: {
    color: "#fff",
  },

  /* Link preview */
  linkPreviewBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  linkPreviewBoxOwn: {
    opacity: 0.9,
  },
  linkPreviewText: {
    fontSize: 12.5,
    color: "#1d4ed8",
    textDecorationLine: "underline",
  },
  linkPreviewTextOwn: {
    color: "#fff",
  },

  /* Bubble Container spacing when reactions attached */
  bubbleContainerWithReactions: {
    marginBottom: 12,
  },

  /* Reactions (Messenger corner pill badge) */
  reactionsRow: {
    position: "absolute",
    bottom: -9,
    zIndex: 4,
  },
  reactionsRowOwn: {
    right: 4,
  },
  reactionsRowOther: {
    left: 4,
  },
  reactionPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    borderRadius: 14,
    paddingHorizontal: 6,
    paddingVertical: 2,
    gap: 3,
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 2.5,
  },
  reactionEmojisStack: {
    flexDirection: "row",
    alignItems: "center",
  },
  reactionEmojiText: {
    fontSize: 13,
  },
  reactionCountText: {
    fontSize: 11,
    fontWeight: "700",
    color: c.textMuted,
    marginLeft: 1,
  },

  /* Pinned Marker */
  pinnedMarker: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 2,
  },
  pinnedMarkerText: {
    fontSize: 10,
    color: c.accent,
    fontWeight: "700",
  },

  /* Sent / Delivered / Seen Status */
  statusRow: {
    alignSelf: "flex-end",
    marginTop: 2,
    marginRight: 2,
  },
  statusText: {
    fontSize: 10,
    color: c.textMuted,
    fontWeight: "600",
  },
  seenAvatar: { width: 14, height: 14, borderRadius: 7 },
  seenAvatarFallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.textMuted,
  },
  timeLabel: {
    alignSelf: "center",
    marginTop: 14,
    marginBottom: 6,
    fontSize: 11.5,
    fontWeight: "600",
    color: c.textMuted,
  },

  /* Reply Banner */
  replyBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surfaceSunken,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    gap: 8,
  },
  replyBannerBar: {
    width: 3,
    height: 30,
    borderRadius: 1.5,
  },
  replyBannerSender: {
    fontSize: 12,
    fontWeight: "700",
    color: c.primary,
  },
  replyBannerText: {
    fontSize: 12.5,
    color: c.textMuted,
  },

  /* Composer */
  composerWrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingTop: 8,
    backgroundColor: c.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    gap: 4,
  },
  composerAttachBtn: {
    width: 32,
    height: 44,
    borderRadius: 19,
    justifyContent: "center",
    alignItems: "center",
  },
  composerInputWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-end",
    backgroundColor: "rgba(143, 33, 23, 0.06)",
    borderRadius: 20,
    paddingLeft: 12,
    paddingRight: 2,
  },
  composerTextInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    maxHeight: 120,
    paddingVertical: 12,
    fontSize: 15,
    color: c.textPrimary,
    lineHeight: 20,
  },
  composerSmileyBtn: { width: 36, height: 44, alignItems: "center", justifyContent: "center" },
  composerSendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    marginBottom: 3,
    justifyContent: "center",
    alignItems: "center",
  },
  composerEmojiBtn: {
    width: 38,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  attachmentPreview: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 8, backgroundColor: c.surfaceSunken,
  },
  attachmentThumbnail: { width: 68, height: 68, borderRadius: 10 },
  attachmentFileIcon: { backgroundColor: c.surface, alignItems: "center", justifyContent: "center" },
  attachmentName: { fontSize: 13, fontWeight: "600", color: c.textPrimary },
  attachmentStatus: { fontSize: 12, color: c.textMuted, marginTop: 3 },
  retakeButton: { alignSelf: "flex-start", paddingVertical: 7, paddingRight: 12 },
  removeAttachmentButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },

  /* ==================== MESSENGER ACTION MODAL & REACTION PILL ==================== */
  actionModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
  },
  // Same dim, but centred — for dialogs rather than the anchored action menu.
  centeredModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  actionFloatingArea: {
    position: "absolute",
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  floatingReactionPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#242526",
    borderRadius: 30,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.15)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 8,
    marginBottom: 10,
  },
  reactionPillEmojiBtn: {
    padding: 6,
    borderRadius: 20,
  },
  reactionPillEmojiBtnActive: {
    backgroundColor: "rgba(255, 255, 255, 0.2)",
  },
  floatingEmojiText: {
    fontSize: 26,
  },
  reactionPillPlusBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 2,
  },
  focusedBubbleWrap: {
    maxWidth: "85%",
  },
  focusedBubbleWrapOwn: {
    alignSelf: "flex-end",
  },
  focusedBubbleWrapOther: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  focusedAvatarWrap: {
    marginBottom: 2,
  },
  messengerBottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#1e1e22",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255, 255, 255, 0.12)",
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    paddingTop: 10,
  },
  messengerActionBtn: {
    alignItems: "center",
    justifyContent: "center",
    minWidth: 64,
    gap: 3,
  },
  messengerActionLabel: {
    fontSize: 12,
    color: "#e4e6eb",
    fontWeight: "500",
  },
  moreMenuSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#1e1e22",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 10,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255, 255, 255, 0.14)",
  },
  moreMenuHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    alignSelf: "center",
    marginBottom: 10,
  },
  moreMenuRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 13,
    gap: 14,
  },
  moreMenuRowText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#e4e6eb",
    flex: 1,
  },
  reactionPickerSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: c.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: "hidden",
  },

  /* ==================== MESSENGER CONVERSATION START HEADER ==================== */
  startHeaderWrapper: {
    paddingBottom: 16,
  },
  startHeaderContainer: {
    alignItems: "center",
    paddingVertical: 20,
    paddingHorizontal: 20,
  },
  startAvatarWrap: {
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  startAvatar: {
    width: 90,
    height: 90,
    borderRadius: 45,
  },
  startAvatarFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  startAvatarInitial: {
    fontSize: 34,
    fontWeight: "700",
  },
  startDisplayName: {
    fontSize: 20,
    fontWeight: "800",
    color: c.textPrimary,
    textAlign: "center",
    marginBottom: 2,
  },
  startRealName: {
    fontSize: 13,
    color: c.textMuted,
    marginBottom: 6,
  },
  startRoleBadge: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 2,
    marginTop: 4,
    marginBottom: 10,
  },
  startRoleText: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  startSubtitle: {
    fontSize: 14,
    fontWeight: "700",
    color: c.textPrimary,
    marginTop: 2,
  },
  startCaption: {
    fontSize: 12,
    color: c.textMuted,
    textAlign: "center",
    marginTop: 3,
    maxWidth: 260,
    lineHeight: 16,
  },
  waveBtn: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 9,
    marginTop: 16,
    gap: 8,
  },
  waveIcon: {
    fontSize: 20,
  },
  waveText: {
    fontSize: 14,
    fontWeight: "700",
  },

  /* Info / Settings Sheet */
  modalContainer: {
    flex: 1,
    backgroundColor: c.surface,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: c.textPrimary,
  },
  infoHero: {
    alignItems: "center",
    marginVertical: 16,
  },
  infoHeroAvatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    marginBottom: 10,
  },
  infoHeroAvatarPlaceholder: {
    width: 84,
    height: 84,
    borderRadius: 42,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 10,
  },
  infoHeroAvatarInitials: {
    fontSize: 32,
    fontWeight: "700",
  },
  infoHeroName: {
    fontSize: 20,
    fontWeight: "800",
    color: c.textPrimary,
    marginBottom: 2,
  },
  infoHeroRealName: {
    fontSize: 14,
    color: c.textMuted,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "800",
    color: c.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
    marginLeft: 4,
  },
  settingCard: {
    backgroundColor: c.surfaceSunken,
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
  },
  settingTitle: {
    fontSize: 14.5,
    fontWeight: "700",
    color: c.textPrimary,
    marginBottom: 10,
  },
  themePaletteRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  themeCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: "center",
    alignItems: "center",
  },
  themeCircleActive: {
    borderWidth: 2.5,
    borderColor: c.surface,
    transform: [{ scale: 1.15 }],
  },
  actionSettingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: c.surfaceSunken,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 16,
    marginBottom: 10,
  },
  actionSettingLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  actionSettingTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: c.textPrimary,
  },
  toggleBtn: {
    backgroundColor: "rgba(143, 33, 23, 0.12)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  toggleBtnActive: {
    backgroundColor: c.primary,
  },
  toggleBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: c.primary,
  },
  toggleBtnTextActive: {
    color: c.onPrimary,
  },

  /* Gallery Tabs */
  galleryTabsRow: {
    flexDirection: "row",
    backgroundColor: c.surfaceSunken,
    borderRadius: 12,
    padding: 3,
    marginBottom: 12,
  },
  galleryTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: 9,
  },
  galleryTabActive: {
    backgroundColor: c.surface,
  },
  galleryTabText: {
    fontSize: 12.5,
    fontWeight: "600",
    color: c.textMuted,
  },
  galleryTabTextActive: {
    color: c.primary,
    fontWeight: "800",
  },
  mediaGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  mediaTile: {
    width: (SCREEN_WIDTH - 48) / 3,
    height: (SCREEN_WIDTH - 48) / 3,
    borderRadius: 10,
    overflow: "hidden",
  },
  mediaTileImg: {
    width: "100%",
    height: "100%",
  },
  filesList: {
    gap: 8,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surfaceSunken,
    padding: 12,
    borderRadius: 12,
    gap: 10,
  },
  fileRowText: {
    flex: 1,
    fontSize: 14,
    color: c.textPrimary,
    fontWeight: "600",
  },
  galleryEmptyText: {
    textAlign: "center",
    color: c.textMuted,
    fontSize: 13,
    paddingVertical: 16,
  },

  /* Pinned Items in sheet */
  pinnedItemCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surfaceSunken,
    padding: 12,
    borderRadius: 14,
    marginBottom: 8,
    gap: 10,
  },
  pinnedItemSender: {
    fontSize: 12,
    fontWeight: "700",
    color: c.primary,
    marginBottom: 2,
  },
  pinnedItemText: {
    fontSize: 13.5,
    color: c.textPrimary,
  },
  pinnedItemActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pinnedJumpBtn: {
    backgroundColor: "rgba(143, 33, 23, 0.12)",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },
  pinnedJumpBtnText: {
    fontSize: 11.5,
    fontWeight: "700",
    color: c.primary,
  },
  pinnedUnpinBtn: {
    padding: 4,
  },

  /* Nickname Modal */
  nicknameModalCard: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: c.surface,
    borderRadius: 20,
    padding: 20,
  },
  nicknameModalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: c.textPrimary,
    marginBottom: 6,
  },
  nicknameModalSubtitle: {
    fontSize: 13,
    color: c.textMuted,
    lineHeight: 18,
    marginBottom: 16,
  },
  nicknameInput: {
    backgroundColor: "rgba(143, 33, 23, 0.06)",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: c.textPrimary,
    marginBottom: 16,
  },
  nicknameModalButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },
  nicknameCancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  nicknameCancelText: {
    fontSize: 14,
    fontWeight: "600",
    color: c.textMuted,
  },
  nicknameSaveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
  },
  nicknameSaveText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
  },

  /* Forward Modal Styles */
  forwardSnippetCard: {
    flexDirection: "row",
    backgroundColor: c.surfaceSunken,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 12,
    padding: 10,
    gap: 10,
  },
  forwardSnippetBar: {
    width: 3.5,
    borderRadius: 2,
  },
  forwardSnippetSender: {
    fontSize: 12,
    fontWeight: "700",
    color: c.primary,
    marginBottom: 2,
  },
  forwardSnippetText: {
    fontSize: 13,
    color: c.textPrimary,
  },
  forwardRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  forwardRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
    marginRight: 12,
  },
  forwardRowName: {
    fontSize: 15,
    fontWeight: "600",
    color: c.textPrimary,
    flex: 1,
  },
  forwardSendBtn: {
    backgroundColor: c.primary,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 14,
  },
  forwardSendBtnSent: {
    backgroundColor: "#22c55e",
  },
  forwardSendBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  forwardSendBtnTextSent: {
    color: "#fff",
  },
});

import { AI_ASSISTANT_ID, AI_ASSISTANT_NAME, isAiAssistantId } from "@/utils/aiAssistant";
import { anonymousName, getMyAnonymousHandle } from "@/utils/anonymousHandle";
import { getAiErrorMessage } from "@/utils/aiConfig";
import {
    AI_REQUEST_COOLDOWN_MS,
    getAiContextLimit,
    requestAiReplyFromWorker,
    reserveAiCooldown,
    type AiContextMessage,
} from "@/utils/aiWorker";
import { resolveAvatarUri } from "@/utils/avatar";
import { formatChatTimeLabel, sameDay as isSameCalendarDay } from "@/utils/chatTime";
import { splitMessageLinks } from "@/utils/chatLinks";
import { AVATAR_SIZE_SMALL, avatarThumb, FEED_IMAGE_WIDTH, feedImage, videoThumb } from "@/utils/cloudinaryImages";
import { requestServerDrawerReopen } from "@/utils/communityNavigation";
import {
    buildChannelAccess,
    CHANNEL_TYPE_OPTIONS,
    deleteChannelFromSections,
    getChannelDefaultEmoji,
    getChannelIcon,
    isStaffChannel,
    isStaffOnlyChannel,
    resolveChannelType,
    updateChannelInSections,
    type ChannelType
} from "@/utils/communityServers";
import { markCommunityChannelViewed } from "@/utils/communityUnread";
import {
    canViewModeratedContent,
    initialModerationFields,
    moderateNewContent,
    requestFirestoreModerationDecision,
} from "@/utils/contentModeration";
import { localCopyOf, prepareComposerAttachments, type ComposerAttachments } from "@/utils/composerUploads";
import {
  appendUserPollOption,
  buildChannelPoll,
  nextPollAnswer,
  pollIsClosed,
  pollMessageText,
  tallyPoll,
  type ChannelPoll,
  type PollDraft,
  type PollVoters,
} from "@/utils/channelPolls";
import SafetyDialog from "./components/SafetyDialog";
import { getFileIconDetails } from "@/utils/fileTypeHelper";
import { useNetworkStatus } from "@/utils/networkUtils";
import { createMentionNotifications, resolveMentionRecipientIds } from "@/utils/notifications";
import {
    fetchChannelMuterIds,
    setChannelMuted as writeChannelMute,
} from "@/utils/notificationSettings";
import {
    getCachedChannelMessages,
    saveCachedChannelMessages,
} from "@/utils/offlineStorage";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import { canReportContent, getUserDataByAuthUser, isStaff, normalizeUserRole, peekUserData } from "@/utils/rbac";
import { replyPreviewMedia, replyPreviewText } from "@/utils/replyPreview";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { canNavigateToTaggedUser, manualTaggedUsers, splitTaggedMentions } from "@/utils/taggedUsers";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { onAuthStateChanged, User } from "firebase/auth";
import {
    addDoc,
    arrayRemove,
    arrayUnion,
    collection,
    deleteDoc,
    deleteField,
    doc,
    FieldPath,
    onSnapshot,
    query,
    runTransaction,
    serverTimestamp,
    setDoc,
    updateDoc,
    where,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated,
    BackHandler,
    Dimensions,
    FlatList,
    InteractionManager,
    Keyboard,
    KeyboardEvent,
    Linking,
    Modal,
    Platform,
    Pressable,
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
    withSequence,
    withSpring,
    withTiming,
} from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import MessageImage from "./components/MessageImage";
import BeaOrb from "./components/BeaOrb";
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import ServerMessageComposer from "./components/ServerMessageComposer";
import ChannelPollCard from "./components/ChannelPollCard";
import ChannelPollSheet from "./components/ChannelPollSheet";
import ConfirmDialog from "./components/ConfirmDialog";
import { showAppToast } from "@/utils/toastEvents";
import DragToCloseSheet from "./components/DragToCloseSheet";
import FileAttachmentCard from "./components/FileAttachmentCard";
import ExpandableText from "./components/ExpandableText";
import ImageZoomViewer from "./components/ImageZoomViewer";
import ExternalLinkDialog, { prepareExternalLink } from "./components/ExternalLinkDialog";
import { ChatSkeleton } from "./components/Skeleton";

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get("window");

// Concrete pixel width for image/GIF attachments in a message bubble. A
// percentage width ("100%") collapses to a 1–2px sliver here: the bubble is
// alignSelf:"flex-start" with no fixed width, so its width is derived from its
// content — and a percentage-width child contributes nothing to that
// intrinsic size, leaving only the bubble's padding + border. This is the
// content wrap's maxWidth (SCREEN_WIDTH * 0.74) minus the bubble's
// paddingHorizontal (14 * 2) and borderWidth (1 * 2).
const MESSAGE_MEDIA_WIDTH = Math.round(SCREEN_WIDTH * 0.74 - 30);
// Link and manual-tag rows need a real width. Leaving their width intrinsic
// creates a Yoga measurement cycle (content-sized bubble -> flex child ->
// content-sized bubble) that can resolve to only a few pixels on Android.
const MESSAGE_DETAIL_CARD_WIDTH = Math.min(260, Math.round(SCREEN_WIDTH * 0.62));

type TaggedUser = {
  id: string;
  name: string;
  studentID: string;
};

type ThreadMessage = {
  id: string;
  text: string;
  userId: string;
  realUserId?: string;
  username?: string;
  role?: string;
  profileImage?: string | null;
  profilePic?: string | null;
  isAnonymous?: boolean;
  // width/height are the original's pixel size when the sender's client
  // recorded it at upload, so the bubble can be shaped to the picture rather
  // than cropping it into a fixed box. Absent on older messages, which are
  // measured as they load instead.
  files?: {
    url: string;
    mimeType: string;
    name?: string;
    size?: number;
    width?: number | null;
    height?: number | null;
  }[];
  link?: { url: string; title: string };
  taggedUsers?: TaggedUser[];
  /** IDs represented inline with @. Other taggedUsers render as "with …". */
  mentionedUserIds?: string[];
  createdAt?: any;
  serverId?: string | null;
  channelId?: string | null;
  aiAssistant?: boolean;
  aiSourceMessageId?: string | null;
  aiStatus?: string | null;
  moderationStatus?: string;
  moderationReasons?: string[];
  // Only on the copy of your own message shown while its attachments upload.
  // Never saved; the real message replaces it under the same id.
  sending?: boolean;
  // Feature 3: emoji -> list of user IDs who reacted with it. Written by any
  // server member via a nested-field update (see handleSetReaction).
  reactions?: Record<string, string[]>;
  // Feature 4: reference to the message this one is replying to, with a
  // snapshot of the original so the quoted preview renders without a lookup.
  replyTo?: { id: string; senderName: string; preview: string; mediaUrl?: string; mediaType?: "image" | "video" };
  // Task 3: pin state. `pinnedBy`/`pinnedByName` record who pinned it so the
  // pinned-messages view can show "by whom" without a profile lookup. Only a
  // server owner/creator or app-wide staff can write these (see firestore.rules).
  pinned?: boolean;
  pinnedAt?: any;
  pinnedBy?: string | null;
  pinnedByName?: string | null;
  // A poll in the channel, and everyone's answers. See utils/channelPolls.ts.
  poll?: ChannelPoll;
  pollVoters?: PollVoters;
  // Task 4A: set when the author edits the text after sending; drives the
  // small "(edited)" marker on the bubble.
  editedAt?: any;
  forwarded?: boolean;
  isForwarded?: boolean;
  forwardedFrom?: {
    senderName: string;
    channelId?: string | null;
    channelName?: string | null;
    serverId?: string | null;
    serverName?: string | null;
  };
};

// How far a bubble must be dragged sideways (or how fast flicked) to arm a
// reply. Kept modest so it's easy to trigger without fighting the list scroll.
const SWIPE_REPLY_DISTANCE = 56;
const SWIPE_REPLY_VELOCITY = 700;

// Feature 5: read receipts. Each member keeps one channelReads/{channelId}_{uid}
// doc recording how far they've read, with name/avatar denormalised so the
// read strip renders without a profile lookup.
type ChannelRead = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  lastReadAtMs: number;
};
// The read write is debounced to at most one per this interval per visit.
const READ_WRITE_MIN_INTERVAL_MS = 4000;
const MAX_READ_AVATARS = 3;
// Stable empty array so bubbles with no readers keep bailing out of React.memo.
const EMPTY_READERS: ChannelRead[] = [];

// Messenger's small default reaction set — a quick row on long-press, not a
// full emoji keyboard. ❤️ is also the default for a double-tap.
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const DEFAULT_REACTION = "❤️";
// Two taps within this window count as a double-tap (quick heart) rather than
// two single taps; the single-tap action is held for this long so the second
// tap can cancel it.
const DOUBLE_TAP_MS = 260;

/**
 * The themed stylesheet for this screen.
 *
 * Nine components here render chrome, and each is memoised at module level,
 * so they read the palette themselves rather than being handed a styles
 * object that would change identity on every render.
 */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // Both, because chrome needs the stylesheet and icon tints need the raw
  // tokens — two hooks per component would be the same work twice.
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

// A user has at most one reaction per message (Messenger-style). Returns the
// emoji they're currently reacting with on this message, or null.
const getMyReaction = (
  message: Pick<ThreadMessage, "reactions"> | undefined,
  uid: string | undefined,
) => {
  if (!uid || !message?.reactions) return null;
  for (const [emoji, ids] of Object.entries(message.reactions)) {
    if ((ids || []).includes(uid)) return emoji;
  }
  return null;
};

const AnimatedPressable = ReanimatedAnimated.createAnimatedComponent(Pressable);

// Highest reaction total we've already played the "pop" for on a given
// message id. Keyed by id so the pill doesn't re-pop every time its bubble
// is recycled back into view by the FlatList — only on a real new reaction.
const reactionPopSeen = new Map<string, number>();

// Small scale-bounce when a reaction is first added to a message, or the
// total goes up. Same spring-overshoot idea as the like button, quicker
// because the element is smaller.
function ReactionPill({
  emojis,
  total,
  mine,
  messageId,
  onPress,
}: {
  emojis: string;
  total: number;
  mine: boolean;
  messageId: string;
  onPress: () => void;
}) {
  const { styles, theme } = useStyles();
  const scale = useSharedValue(1);

  useEffect(() => {
    const seen = reactionPopSeen.get(messageId) ?? 0;
    if (total > seen) {
      reactionPopSeen.set(messageId, total);
      scale.value = withSequence(
        withTiming(1.16, { duration: 90 }),
        withSpring(1, { damping: 9, stiffness: 420 }),
      );
    }
  }, [messageId, total, scale]);

  const popStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPress={onPress}
      style={[
        styles.reactionPill,
        mine && styles.reactionPillMine,
        popStyle,
      ]}
    >
      <Text style={styles.reactionPillEmoji}>{emojis}</Text>
      <Text
        style={[styles.reactionPillCount, mine && styles.reactionPillCountMine]}
      >
        {total}
      </Text>
    </AnimatedPressable>
  );
}

// Feature 6: typing indicators. Each typing user keeps one
// typingIndicators/{channelId}_{uid} doc with a refreshed updatedAt. Writes are
// debounced hard — one on start, a refresh at most every TYPING_REFRESH_MS while
// still typing, and a delete once the user has been idle for TYPING_IDLE_MS,
// sends, or leaves. Subscribers also ignore any doc older than TYPING_STALE_MS
// so a crashed/backgrounded client never leaves a stuck "typing…".
const TYPING_REFRESH_MS = 3000;
const TYPING_IDLE_MS = 3000;
const TYPING_STALE_MS = 6000;

type TypingUser = {
  userId: string;
  name: string;
  updatedAtMs: number;
};
// Stable empty array so the composer keeps bailing out of React.memo when nobody
// is typing.
const EMPTY_TYPING: TypingUser[] = [];

// "Alex is typing…", "Alex and Sam are typing…", "Alex and 3 others are typing…"
const typingSentence = (names: string[]) => {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names[0]} and ${names.length - 1} others are typing`;
};

type RouteParams = {
  serverId?: string | string[];
  channelId?: string | string[];
  serverName?: string | string[];
  channelLabel?: string | string[];
  serverAccent?: string | string[];
};

const getSingleParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const buildCurrentUserPreview = (authUser: User | null) => {
  if (!authUser) return null;

  const displayName = authUser.displayName?.trim() || "";
  const [firstName = "", ...restName] = displayName.split(/\s+/).filter(Boolean);
  const lastName = restName.join(" ");
  const emailFallback = authUser.email?.split("@")[0]?.trim() || "You";

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

function getTimeAgo(timestamp: any, nowMs = Date.now()) {
  if (!timestamp?.toDate) return "";
  const now = new Date(nowMs);
  const createdAt = timestamp.toDate();
  const diffMs = now.getTime() - createdAt.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);

  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHour < 24) return `${diffHour}h`;
  return createdAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// Tap-to-reveal absolute timestamp, matching Messenger mobile's two-tier
// format: a message from today shows the time only ("2:45 PM"); a message
// from any earlier day prepends a short date ("Mar 5, 2:45 PM").
function formatRevealTimestamp(timestamp: any, nowMs = Date.now()) {
  if (!timestamp?.toDate) return "";
  const date = timestamp.toDate();
  const now = new Date(nowMs);
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return time;
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

// Consecutive messages from the same sender sent within this window collapse
// into one visual group (single avatar + name on the last bubble, tighter
// spacing between). Kept to a few minutes — the same "one burst of typing"
// idea getTimeAgo works in — so a follow-up reply an hour later still gets
// its own avatar and name.
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

// Task 4A: how long after sending a message its author may still edit it.
// Editing exists for the "fix a typo / take back something I just posted"
// case, not for silently rewriting a message other people may have already
// read, replied to, or reacted to. 15 minutes keeps it to that intent;
// after that the honest options are a follow-up correction or delete. The
// same window is enforced in firestore.rules so a modified client can't
// reach back further.
const EDIT_WINDOW_MS = 15 * 60 * 1000;

const isWithinEditWindow = (message?: ThreadMessage) => {
  const ms = message?.createdAt?.toMillis?.();
  // No resolved server timestamp yet == just sent, so still editable.
  return typeof ms === "number" ? Date.now() - ms < EDIT_WINDOW_MS : true;
};

// Sort key for the channel's messages. A message whose server timestamp hasn't
// resolved yet was just sent, so it goes last.
const getMessageSortMs = (message: ThreadMessage) =>
  message.createdAt?.toMillis?.() ?? Number.POSITIVE_INFINITY;

// Task 5: the single source of truth for how a message's attachments are
// bucketed. MessageBubbleComponent's render and the Media/Files gallery both
// call these, so the two views can never classify the same file differently.
type MessageFile = NonNullable<ThreadMessage["files"]>[number];
const isGifFile = (file: MessageFile) => file.mimeType.includes("gif");
const isImageFile = (file: MessageFile) =>
  file.mimeType.startsWith("image/") && !file.mimeType.includes("gif");
const messageImageFiles = (message: Pick<ThreadMessage, "files">) =>
  (message.files || []).filter(isImageFile);
const messageGifFiles = (message: Pick<ThreadMessage, "files">) =>
  (message.files || []).filter(isGifFile);
const messageDocFiles = (message: Pick<ThreadMessage, "files">) =>
  (message.files || []).filter((file) => !file.mimeType.startsWith("image/"));

// Task 5: how many gallery rows to show per "Load more" tap. The full channel
// history is already in memory (see the messages subscription), so this is
// purely about keeping the list light on first open — same simple limit +
// "Load more" tier as ManageModerationScreen.
const GALLERY_PAGE_SIZE = 30;
// Minimum query length before the in-channel search actually filters.
const SEARCH_MIN_CHARS = 2;

type GalleryTab = "media" | "files" | "links";
type ContentTab = GalleryTab | "search";

type GalleryEntry = {
  key: string;
  messageId: string;
  createdAtMs: number;
  senderName: string;
  // What tapping the entry opens — same Linking.openURL(url) the bubble uses.
  url: string;
  isImage: boolean;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
};

// Reuse getTimeAgo's exact formatting for a plain millisecond value (gallery
// entries carry a number, not a Firestore Timestamp).
const msTimeAgo = (ms: number, nowMs: number) =>
  ms ? getTimeAgo({ toDate: () => new Date(ms) }, nowMs) : "";

/** "1 photo", "3 photos". */
const countLabel = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A gap this long between two messages earns its own time label, as in DMs. */
const TIME_LABEL_GAP_MS = 15 * 60 * 1000;

const messageMillis = (message?: ThreadMessage): number =>
  message?.createdAt?.toMillis?.() ?? 0;

/**
 * Whether a message opens a new stretch of the channel — the first one
 * loaded, the first of a new day, or one after a long pause — and so gets a
 * time label above it, the way DMs and Messenger show it.
 */
function needsTimeLabel(message: ThreadMessage, older: ThreadMessage | undefined): boolean {
  const current = messageMillis(message);
  if (!current) return false;
  if (!older) return true;
  const previous = messageMillis(older);
  if (!previous) return false;
  return (
    !isSameCalendarDay(new Date(previous), new Date(current)) ||
    current - previous >= TIME_LABEL_GAP_MS
  );
}

const isSameSenderRun = (a?: ThreadMessage, b?: ThreadMessage) => {
  if (!a || !b) return false;
  if ((a.realUserId || a.userId) !== (b.realUserId || b.userId)) return false;
  // An anonymous message and a named one from the same account read as
  // different senders in the UI, so they must not group together.
  if (!!a.isAnonymous !== !!b.isAnonymous) return false;
  const aMs = a.createdAt?.toMillis?.();
  const bMs = b.createdAt?.toMillis?.();
  if (!aMs || !bMs) return false;
  return Math.abs(bMs - aMs) <= MESSAGE_GROUP_WINDOW_MS;
};

const formatCooldownLabel = (remainingMs: number) => {
  const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
};

const summarizeThreadMessage = (message: Partial<ThreadMessage>) => {
  const parts: string[] = [];
  const text = message.text?.trim();
  if (text) parts.push(text);
  if (message.link?.url) {
    parts.push(`[shared a link: ${message.link.title || message.link.url}]`);
  }
  if (message.files?.length) {
    parts.push(
      `[shared ${message.files.length} attachment${message.files.length === 1 ? "" : "s"}]`,
    );
  }
  // Don't include the AI assistant itself in "Tagged users" — tagging it is
  // just how this flow gets triggered, and echoing "Tagged users: Bonded AI"
  // back into the prompt adds noise that can push short messages (e.g. "bye",
  // "how are you") below the classifier's confidence threshold.
  const otherTaggedUsers = (message.taggedUsers || []).filter(
    (tag) => !isAiAssistantId(tag.id),
  );
  if (otherTaggedUsers.length) {
    parts.push(`Tagged users: ${otherTaggedUsers.map((tag) => tag.name).join(", ")}`);
  }
  return parts.join("\n").trim() || "[empty message]";
};

const buildAiContextMessages = (
  threadMessages: ThreadMessage[],
  pendingMessage: Partial<ThreadMessage>,
) => {
  const recentMessages = [
    ...threadMessages.slice(-getAiContextLimit() + 1),
    {
      ...pendingMessage,
      id: "pending-ai-request",
    } as ThreadMessage,
  ];

  return recentMessages.map(
    (message): AiContextMessage => ({
      role: isAiAssistantId(message.realUserId || message.userId) ? "assistant" : "user",
      name: message.isAnonymous ? anonymousName(message) : message.username || "User",
      content: summarizeThreadMessage(message),
    }),
  );
};

// Feature 6: Messenger-style three-dot "typing…" animation. A single looped
// RN Animated driver staggered across the three dots — cheap, non-worklet, and
// self-cleaning on unmount.
function TypingDots({ color }: { color: string }) {
  const { styles, theme } = useStyles();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 3,
        duration: 900,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);

  return (
    <View style={styles.typingDotsRow}>
      {[0, 1, 2].map((index) => (
        <Animated.View
          key={index}
          style={[
            styles.typingDot,
            {
              backgroundColor: color,
              opacity: progress.interpolate({
                inputRange: [index, index + 0.5, index + 1, 3],
                outputRange: [0.3, 1, 0.3, 0.3],
                extrapolate: "clamp",
              }),
              transform: [
                {
                  translateY: progress.interpolate({
                    inputRange: [index, index + 0.5, index + 1, 3],
                    outputRange: [0, -3, 0, 0],
                    extrapolate: "clamp",
                  }),
                },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

/**
 * Under a bubble: "Sending…" while it sends, or its exact time once tapped.
 * The time of day is the label above a new stretch of messages, as in DMs.
 */
const MessageTimestamp = React.memo(function MessageTimestamp({
  createdAt,
  nowMs: propNowMs,
  revealed,
  isOwnMessage,
  sending,
}: {
  createdAt: any;
  nowMs?: number;
  revealed: boolean;
  isOwnMessage: boolean;
  sending?: boolean;
}) {
  const { styles, theme } = useStyles();
  const hookNowMs = useRelativeTimeNow();
  const nowMs = propNowMs ?? hookNowMs;

  if (sending) {
    return (
      <Text style={[styles.messageMeta, isOwnMessage && styles.messageMetaOwn]}>
        Sending…
      </Text>
    );
  }

  if (revealed) {
    return (
      <Text
        style={[
          styles.messageMeta,
          styles.messageMetaRevealed,
          isOwnMessage && styles.messageMetaOwn,
        ]}
      >
        {formatRevealTimestamp(createdAt, nowMs)}
      </Text>
    );
  }

  return null;
});

function MessageBubbleComponent({
  item,
  isOwnMessage,
  accent,
  onProfilePress,
  nowMs,
  isGroupStart,
  isGroupEnd,
  revealed,
  onToggleReveal,
  currentUserId,
  onLongPress,
  onSetReaction,
  onSwipeReply,
  onReplyPress,
  onOpenImage,
  onOpenUrl,
  readers,
  pinned,
  showFullText,
  timeLabel,
  canVotePolls,
  onPollVote,
  onAddPollOption,
  liveAvatarUri,
  isStaffViewer,
}: {
  item: ThreadMessage;
  isOwnMessage: boolean;
  accent: string;
  onProfilePress: (userId?: string, isAnonymous?: boolean) => void;
  // Tap an attachment image/GIF to open the zoom + save viewer.
  onOpenImage: (urls: string[], index: number) => void;
  onOpenUrl: (url: string, label?: string) => void;
  nowMs?: number;
  // Message grouping: a "group" is a run of consecutive same-sender messages
  // close together in time. Start = first of the run, end = last of the run.
  isGroupStart: boolean;
  isGroupEnd: boolean;
  // Feature 1: this bubble's tap-to-reveal timestamp is currently showing.
  revealed: boolean;
  onToggleReveal: (messageId: string) => void;
  // Feature 3: reactions.
  currentUserId?: string;
  onLongPress: (messageId: string) => void;
  onSetReaction: (messageId: string, emoji: string) => void;
  // Feature 4: swipe the bubble sideways to reply to it.
  onSwipeReply: (messageId: string) => void;
  onReplyPress: (messageId: string) => void;
  // Feature 5: members whose read position lands on this message.
  readers: ChannelRead[];
  // Task 3: this message is pinned in the channel — show the badge to everyone.
  pinned: boolean;
  // Rules, announcements and pinned messages are there to be read in full.
  showFullText: boolean;
  // Shown centred above the message when it opens a new stretch.
  timeLabel: string | null;
  // Polls: members and staff vote; the screen saves the answer.
  canVotePolls: boolean;
  onPollVote: (messageId: string, optionId: string) => void;
  onAddPollOption: (messageId: string, text: string) => Promise<string | null>;
  liveAvatarUri?: string | null;
  isStaffViewer?: boolean;
}) {
  const { styles, theme } = useStyles();
  const [tagsExpanded, setTagsExpanded] = useState(false);
  // Task 5: shared classification (also used by the Media/Files gallery).
  const imageFiles = messageImageFiles(item);
  const gifFiles = messageGifFiles(item);
  const docs = messageDocFiles(item);
  // Anonymous channel messages must never reuse the writer's live/cached
  // profile photo. The document already stores null avatar fields, but the
  // live profile cache is keyed by realUserId and could otherwise reveal it.
  const avatarUri = item.isAnonymous
    ? null
    : liveAvatarUri || resolveAvatarUri(item);
  // Your message while its photos upload: shown, but there is nothing saved
  // yet to react to, reply to or open.
  const sending = item.sending === true;
  // A B.E.A. reply still being written. It is saved as "processing"; older
  // ones said "generating". Only the second was recognised before, so the
  // waiting state never showed.
  const aiThinking =
    item.aiAssistant === true &&
    !item.text &&
    (item.aiStatus === "processing" || item.aiStatus === "generating");
  const bubbleStyle = [
    styles.messageBubble,
    isOwnMessage && [styles.messageBubbleOwn, { backgroundColor: accent }],
    sending && styles.messageSending,
  ];
  // Avatar + name appear once per group, on the last (bottom) bubble; the
  // earlier bubbles in the group keep an empty avatar-width spacer so their
  // content stays aligned with the rest of the run.
  const showAvatar = !isOwnMessage && isGroupEnd;
  const showName = !isOwnMessage && isGroupEnd;
  // Photos and GIFs sit under the bubble on their own, rounded, with no frame
  // of the chat colour around them. A message that is only a picture has no
  // bubble at all.
  const photoFiles = [...gifFiles, ...imageFiles];
  const manualTags = manualTaggedUsers(
    item.text,
    item.taggedUsers,
    item.mentionedUserIds,
  );
  const visibleManualTags = tagsExpanded ? manualTags : manualTags.slice(0, 1);
  const hiddenManualTagCount = Math.max(0, manualTags.length - 1);
  const bubbleHasContent =
    !!(item.forwarded || item.isForwarded) ||
    pinned ||
    !!item.text ||
    !!item.editedAt ||
    !!aiThinking ||
    docs.length > 0 ||
    !!item.link ||
    manualTags.length > 0;
  // Reactions still holding at least one user — empty arrays are left behind
  // by arrayRemove and shouldn't count.
  const reactionEntries = Object.entries(item.reactions || {})
    .map(([emoji, ids]) => ({ emoji, ids: ids || [] }))
    .filter((entry) => entry.ids.length > 0);
  const myReaction = getMyReaction(item, currentUserId);
  const reactionSummary = reactionEntries.map((entry) => entry.emoji).slice(0, 4);
  const reactionTotal = reactionEntries.reduce(
    (sum, entry) => sum + entry.ids.length,
    0,
  );

  // Distinguish a single tap (reveal timestamp) from a double tap (quick
  // heart). The reveal is held for DOUBLE_TAP_MS so a fast second tap can
  // cancel it; a stray timer is cleared on unmount.
  const lastTapRef = useRef(0);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    },
    [],
  );
  const handleBubbleTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      onSetReaction(item.id, DEFAULT_REACTION);
      return;
    }
    lastTapRef.current = now;
    revealTimerRef.current = setTimeout(() => {
      revealTimerRef.current = null;
      onToggleReveal(item.id);
    }, DOUBLE_TAP_MS);
  };

  // Feature 4: drag the bubble toward its "outer" edge to reply — right for
  // other people's (left-aligned) messages, left for your own (right-aligned)
  // ones, matching Telegram/WhatsApp. failOffsetY yields to the list's
  // vertical scroll; activeOffsetX means a clear horizontal drag is required.
  const messageId = item.id;
  const swipeX = useSharedValue(0);
  const swipeDir = isOwnMessage ? -1 : 1;
  const replyGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!sending)
        .activeOffsetX(isOwnMessage ? [-14, 9999] : [-9999, 14])
        .failOffsetY([-12, 12])
        .onUpdate((event) => {
          const dx = event.translationX * swipeDir;
          swipeX.value = dx > 0 ? Math.min(dx, SWIPE_REPLY_DISTANCE + 20) : 0;
        })
        .onEnd((event) => {
          const dx = event.translationX * swipeDir;
          if (dx > SWIPE_REPLY_DISTANCE || event.velocityX * swipeDir > SWIPE_REPLY_VELOCITY) {
            runOnJS(onSwipeReply)(messageId);
          }
          // Snap straight back, like Messenger — no spring overshoot.
          swipeX.value = 0;
        }),
    [isOwnMessage, messageId, onSwipeReply, sending, swipeDir, swipeX],
  );
  const rowSwipeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: swipeX.value * swipeDir }],
  }));
  const replyHintStyle = useAnimatedStyle(() => ({
    opacity: Math.min(swipeX.value / SWIPE_REPLY_DISTANCE, 1),
  }));

  return (
    <View>
    {!!timeLabel && (
      <Text style={styles.timeLabel} accessibilityRole="header">
        {timeLabel}
      </Text>
    )}
    <GestureDetector gesture={replyGesture}>
    <ReanimatedAnimated.View
      style={[
        styles.messageRow,
        isOwnMessage ? styles.messageRowOwn : styles.messageRowOther,
        // Tight gap while still inside a group; full gap once the group ends.
        !isGroupEnd && styles.messageRowGrouped,
        rowSwipeStyle,
      ]}
    >
      <ReanimatedAnimated.View
        style={[
          styles.replyHint,
          isOwnMessage ? styles.replyHintOwn : styles.replyHintOther,
          replyHintStyle,
        ]}
        pointerEvents="none"
      >
        <Ionicons name="arrow-undo" size={16} color={theme.textSecondary} />
      </ReanimatedAnimated.View>

      {!isOwnMessage &&
        (showAvatar && item.aiAssistant ? (
          // B.E.A.'s own face, thinking while its reply is being written. It
          // has no profile to open, so it isn't a button.
          <View style={styles.avatarWrap}>
            <BeaOrb size={34} mood={aiThinking ? "thinking" : "idle"} animated={aiThinking} />
          </View>
        ) : showAvatar ? (
          <TouchableOpacity
            onPress={() => onProfilePress(item.realUserId || item.userId, item.isAnonymous)}
            disabled={item.isAnonymous}
            style={styles.avatarWrap}
          >
            <View style={styles.avatar}>
              {item.isAnonymous ? (
                <Ionicons name="person" size={16} color={theme.textMuted} />
              ) : avatarUri ? (
                <Image
                  source={{ uri: avatarThumb(avatarUri, AVATAR_SIZE_SMALL) }}
                  style={styles.avatarImage}
                  recyclingKey={item.id}
                />
              ) : (
                <Text style={styles.avatarText}>
                  {(item.username?.[0] || "A").toUpperCase()}
                </Text>
              )}
            </View>
          </TouchableOpacity>
        ) : (
          <View style={[styles.avatarWrap, styles.avatarSpacer]} />
        ))}

      <View style={styles.messageContentWrap}>
          {/* Same one-line marker Messenger uses, outside the bubble — see
              DirectChatScreen. Keeping the quote inside meant a reply to a
              photo had to hold a quote box, a thumbnail and the photo, which
              is what stretched the bubble. Tap still jumps to the original. */}
          {item.replyTo && (
            <View
              style={[styles.replyLabelRow, isOwnMessage && styles.replyLabelRowOwn]}
            >
              <Ionicons name="arrow-undo" size={12} color={theme.textMuted} />
              <Text style={styles.replyLabelText} numberOfLines={1}>
                {/* Replying to your own message should say so, rather than
                    naming you back at yourself. Matched against the message
                    author, since a channel has many people in it. */}
                {item.replyTo.senderName === item.username
                  ? isOwnMessage
                    ? "You replied to yourself"
                    : `${item.username || "Someone"} replied to themselves`
                  : isOwnMessage
                    ? `You replied to ${item.replyTo.senderName}`
                    : `${item.username || "Someone"} replied to ${item.replyTo.senderName}`}
              </Text>
            </View>
          )}

          {/* What was replied to. The label alone says somebody replied but
              not to what, which is no use in a busy channel. Muted, outside
              the bubble so it cannot change the bubble's width. */}
          {item.replyTo && (
            <Pressable
              style={[styles.replyEcho, isOwnMessage && styles.replyEchoOwn]}
              onPress={() => onReplyPress(item.replyTo!.id)}
              accessibilityRole="button"
              accessibilityLabel="Go to the original message"
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
        {/* The message itself — its bubble and photos — with the reaction
            sitting on its bottom corner, as in DMs and Messenger. */}
        <View
          style={[
            styles.messageBody,
            isOwnMessage && styles.messageBodyOwn,
            reactionEntries.length > 0 && styles.messageBodyWithReaction,
          ]}
        >
        {bubbleHasContent && (
        <Pressable
          style={bubbleStyle}
          onPress={handleBubbleTap}
          onLongPress={() => onLongPress(item.id)}
          delayLongPress={250}
          disabled={sending}
        >
          {pinned && (
            // Task 3: pinned badge — shown to everyone so students spot pinned
            // content (syllabus, deadlines, rules) while scrolling normally.
            <View style={styles.pinnedTag}>
              <Ionicons
                name="pin"
                size={11}
                color={isOwnMessage ? theme.surface : accent}
              />
              <Text
                style={[styles.pinnedTagText, isOwnMessage && styles.pinnedTagTextOwn]}
              >
                Pinned
              </Text>
            </View>
          )}
          {(item.forwarded || item.isForwarded) && (
            <View style={styles.forwardedRow}>
              <Ionicons
                name="arrow-redo"
                size={12}
                color={isOwnMessage ? "rgba(255,250,247,0.75)" : "#8f766e"}
              />
              <Text
                style={[
                  styles.forwardedText,
                  isOwnMessage && styles.forwardedTextOwn,
                ]}
              >
                Forwarded
              </Text>
            </View>
          )}
          {showName && (
            <Text style={styles.messageAuthor}>
              {item.isAnonymous
                ? anonymousName(item, { isYou: isOwnMessage && isStaffViewer })
                : item.username || "User"}
            </Text>
          )}
          {item.poll ? (
            <ChannelPollCard
              poll={item.poll}
              voters={item.pollVoters}
              currentUserId={currentUserId}
              nowMs={nowMs ?? 0}
              canVote={canVotePolls && !sending}
              onVote={(optionId) => onPollVote(item.id, optionId)}
              onAddOption={(text) => onAddPollOption(item.id, text)}
              accent={accent}
            />
          ) : !!item.text && (
            <ExpandableText
              text={item.text}
              textStyle={[styles.messageText, isOwnMessage && styles.messageTextOwn]}
              renderText={(value) =>
                splitMessageLinks(value).map((part, index) =>
                  part.url ? (
                    <Text
                      key={`${part.url}:${index}`}
                      style={[styles.messageLink, isOwnMessage && styles.messageLinkOwn]}
                      accessibilityRole="link"
                      onPress={() => onOpenUrl(part.url!, part.text)}
                      onLongPress={() => onLongPress(item.id)}
                    >
                      {part.text}
                    </Text>
                  ) : splitTaggedMentions(
                      part.text,
                      item.taggedUsers,
                      item.mentionedUserIds,
                    ).map((piece, pieceIndex) => {
                      const navigable = canNavigateToTaggedUser(piece.taggedUser?.id);
                      return piece.taggedUser ? (
                        <Text
                          key={`mention:${index}:${pieceIndex}`}
                          style={[
                            styles.messageMention,
                            isOwnMessage && styles.messageMentionOwn,
                          ]}
                          onPress={
                            navigable
                              ? () => onProfilePress(piece.taggedUser!.id, false)
                              : undefined
                          }
                          accessibilityRole={navigable ? "link" : undefined}
                        >
                          {piece.text}
                        </Text>
                      ) : (
                        <React.Fragment key={`text:${index}:${pieceIndex}`}>
                          {piece.text}
                        </React.Fragment>
                      );
                    }),
                )
              }
              // Chat reads top to bottom, so messages show in full, as in
              // Messenger or Discord; only a huge paste is cut, so it can't
              // take over the channel.
              collapsedLines={15}
              collapsible={!showFullText}
              buttonTextStyle={[
                styles.messageToggleText,
                isOwnMessage && styles.messageToggleTextOwn,
              ]}
            />
          )}

          {item.editedAt && (
            // Task 4A: small marker so an edit is never silent. Grouping-
            // independent, so it sits inside the bubble rather than in the
            // once-per-group meta line below.
            <Text
              style={[styles.editedTag, isOwnMessage && styles.editedTagOwn]}
            >
              (edited)
            </Text>
          )}

          {aiThinking ? (
            <View style={styles.aiPendingRow}>
              <ActivityIndicator size="small" color={isOwnMessage ? theme.surface : "#8f2117"} />
              <Text style={[styles.aiPendingText, isOwnMessage && styles.aiPendingTextOwn]}>
                {AI_ASSISTANT_NAME} is generating...
              </Text>
            </View>
          ) : null}

          {docs.map((file) => (
            <FileAttachmentCard
              key={file.url}
              file={file}
              onPress={() => Linking.openURL(file.url).catch(() => null)}
              onLongPress={() => onLongPress(item.id)}
              disabled={sending}
            />
          ))}

          {item.link && (
            <TouchableOpacity
              style={styles.linkCard}
              onPress={() => onOpenUrl(item.link?.url || "", item.link?.title)}
              onLongPress={() => onLongPress(item.id)}
              delayLongPress={250}
              disabled={sending}
              activeOpacity={0.82}
              accessibilityRole="link"
              accessibilityLabel={`${item.link.title || "Link"}. Hold for message actions.`}
            >
              <Ionicons
                name="link-outline"
                size={16}
                color={isOwnMessage ? theme.surface : theme.primary}
              />
              <View style={styles.linkCopy}>
                {!!item.link.title?.trim() && item.link.title.trim() !== item.link.url && (
                  <Text
                    style={[styles.linkTitle, isOwnMessage && styles.linkTitleOwn]}
                    numberOfLines={1}
                  >
                    {item.link.title.trim()}
                  </Text>
                )}
                <Text
                  style={[styles.linkUrl, isOwnMessage && styles.linkUrlOwn]}
                >
                  {item.link.url}
                </Text>
              </View>
            </TouchableOpacity>
          )}

          {manualTags.length > 0 && (
            <View style={styles.tagCard}>
              <View style={styles.tagRow}>
                <Ionicons
                  name="people-outline"
                  size={13}
                  color={isOwnMessage ? theme.surface : "#a86fff"}
                />
                <Text style={[styles.tagText, isOwnMessage && styles.tagTextOwn]}>with </Text>
                {visibleManualTags.map((tag, index) => {
                  const navigable = canNavigateToTaggedUser(tag.id);
                  return (
                    <React.Fragment key={tag.id}>
                      {index > 0 && (
                        <Text style={[styles.tagText, isOwnMessage && styles.tagTextOwn]}>, </Text>
                      )}
                      <TouchableOpacity
                        onPress={navigable ? () => onProfilePress(tag.id, false) : undefined}
                        disabled={!navigable}
                        hitSlop={6}
                        accessibilityRole={navigable ? "link" : undefined}
                      >
                        <Text style={[styles.tagText, isOwnMessage && styles.tagTextOwn]}>
                          {tag.name}
                        </Text>
                      </TouchableOpacity>
                    </React.Fragment>
                  );
                })}
                {hiddenManualTagCount > 0 && !tagsExpanded && (
                  <TouchableOpacity onPress={() => setTagsExpanded(true)} hitSlop={8}>
                    <Text style={[styles.tagMore, isOwnMessage && styles.tagTextOwn]}>
                      See {hiddenManualTagCount} more
                    </Text>
                  </TouchableOpacity>
                )}
                {tagsExpanded && manualTags.length > 1 && (
                  <TouchableOpacity onPress={() => setTagsExpanded(false)} hitSlop={8}>
                    <Text style={[styles.tagMore, isOwnMessage && styles.tagTextOwn]}>See less</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </Pressable>
        )}

        {/* A picture on its own still says who sent it. */}
        {!bubbleHasContent && showName && photoFiles.length > 0 && (
          <Text style={[styles.messageAuthor, styles.photoAuthor]}>
            {item.isAnonymous
              ? anonymousName(item, { isYou: isOwnMessage && isStaffViewer })
              : item.username || "User"}
          </Text>
        )}

        {photoFiles.length > 0 && (
          <View style={[styles.photoStack, isOwnMessage && styles.photoStackOwn]}>
            {photoFiles.map((file, index, all) => (
              <Pressable
                key={file.url}
                onPress={() => onOpenImage(all.map((entry) => entry.url), index)}
                // Hold to react, tap to open — the picture carries both now
                // that there may be no bubble around it.
                onLongPress={() => onLongPress(item.id)}
                delayLongPress={250}
                disabled={sending}
                accessibilityRole="button"
                accessibilityLabel={`${file.mimeType.includes("gif") ? "GIF" : "Image"}. Hold for message actions.`}
                style={({ pressed }) => [styles.photoItem, pressed && styles.messageImagePressed]}
              >
                <MessageImage
                  uri={feedImage(file.url, FEED_IMAGE_WIDTH) || file.url}
                  width={MESSAGE_MEDIA_WIDTH}
                  sourceWidth={file.width}
                  sourceHeight={file.height}
                  recyclingKey={`${item.id}:${file.url}`}
                  placeholderUri={localCopyOf(file.url)}
                />
              </Pressable>
            ))}
          </View>
        )}

        {reactionEntries.length > 0 && (
          // One compact pill (Messenger-style): the distinct emojis + a total
          // count. Tapping it removes your reaction if you have one, or adds
          // the default heart if you don't. Pops on a new reaction.
          <View
            style={[
              styles.reactionCorner,
              isOwnMessage ? styles.reactionCornerOwn : styles.reactionCornerOther,
            ]}
          >
            <ReactionPill
              emojis={reactionSummary.join("")}
              total={reactionTotal}
              mine={!!myReaction}
              messageId={item.id}
              onPress={() => onSetReaction(item.id, myReaction ?? DEFAULT_REACTION)}
            />
          </View>
        )}
        </View>

        <MessageTimestamp
          createdAt={item.createdAt}
          nowMs={nowMs}
          revealed={revealed}
          isOwnMessage={isOwnMessage}
          sending={sending}
        />

        {readers.length > 0 && (
          // Feature 5: small stacked avatars for members who've read up to
          // approximately here (group-chat style, not a 1:1 checkmark).
          <View
            style={[
              styles.readStrip,
              isOwnMessage ? styles.readStripOwn : styles.readStripOther,
            ]}
          >
            {readers.slice(0, MAX_READ_AVATARS).map((reader, index) => (
              <View
                key={reader.userId}
                style={[styles.readAvatar, index > 0 && styles.readAvatarStacked]}
              >
                {reader.avatarUrl ? (
                  <Image
                    source={{ uri: avatarThumb(reader.avatarUrl, AVATAR_SIZE_SMALL) }}
                    style={styles.readAvatarImage}
                  />
                ) : (
                  <Text style={styles.readAvatarText}>
                    {(reader.name?.[0] || "U").toUpperCase()}
                  </Text>
                )}
              </View>
            ))}
            {readers.length > MAX_READ_AVATARS && (
              <Text style={styles.readOverflow}>
                +{readers.length - MAX_READ_AVATARS}
              </Text>
            )}
          </View>
        )}
      </View>
    </ReanimatedAnimated.View>
    </GestureDetector>
    </View>
  );
}

// Memoized so a Firestore snapshot update that adds/changes one message
// doesn't force every visible bubble to re-render — only the ones whose
// props actually changed (same shallow-comparison bail-out React.memo
// already does for any component, applied here since message lists are
// exactly the case it helps most).
const MessageBubble = React.memo(MessageBubbleComponent);

// Task 3: one row in the "Pinned messages" sheet. Tapping the body opens the
// pinned content directly (attachment / link / full text); the side button
// jumps to the message in the main thread. Memoized like MessageBubble since a
// channel could accumulate many pins.
function pinnedRowIcon(message: ThreadMessage) {
  const file = (message.files || [])[0];
  if (file) {
    if (file.mimeType.includes("pdf")) return "document-text-outline" as const;
    if (file.mimeType.startsWith("image/")) return "image-outline" as const;
    return "document-outline" as const;
  }
  if (message.link?.url) return "link-outline" as const;
  return "chatbubble-ellipses-outline" as const;
}

function PinnedMessageRowComponent({
  item,
  accent,
  nowMs,
  onOpenContent,
  onJumpToMessage,
  liveAvatarUri,
  isOwn,
  isStaffViewer,
}: {
  item: ThreadMessage;
  accent: string;
  nowMs: number;
  onOpenContent: (messageId: string) => void;
  onJumpToMessage: (messageId: string) => void;
  liveAvatarUri?: string | null;
  isOwn?: boolean;
  isStaffViewer?: boolean;
}) {
  const { styles, theme } = useStyles();
  const avatarUri = liveAvatarUri || resolveAvatarUri(item);
  const senderName = item.isAnonymous
    ? anonymousName(item, { isYou: isOwn && isStaffViewer })
    : item.username || "User";
  const file = (item.files || [])[0];
  const previewText = file
    ? file.name || "Attachment"
    : item.link?.url
      ? item.link.title || item.link.url
      : replyPreviewText(item);
  const pinnedAgo = getTimeAgo(item.pinnedAt, nowMs);
  const pinnedBy = item.pinnedByName || "staff";

  return (
    <View style={styles.pinnedRow}>
      <Pressable
        style={styles.pinnedRowMain}
        onPress={() => onJumpToMessage(item.id)}
        accessibilityLabel="Jump to message in thread"
      >
        <View style={styles.pinnedAvatar}>
          {avatarUri ? (
            <Image
              source={{ uri: avatarThumb(avatarUri, AVATAR_SIZE_SMALL) }}
              style={styles.pinnedAvatarImage}
            />
          ) : (
            <Text style={styles.pinnedAvatarText}>
              {(senderName[0] || "U").toUpperCase()}
            </Text>
          )}
        </View>
        <View style={styles.pinnedRowBody}>
          <Text style={styles.pinnedSender} numberOfLines={1}>
            {senderName}
          </Text>
          <View style={styles.pinnedPreviewRow}>
            <Ionicons name={pinnedRowIcon(item)} size={13} color={accent} />
            <Text style={styles.pinnedPreview} numberOfLines={2}>
              {previewText}
            </Text>
          </View>
          <Text style={styles.pinnedMeta} numberOfLines={1}>
            Pinned {pinnedAgo ? `${pinnedAgo} ` : ""}by {pinnedBy}
          </Text>
        </View>
      </Pressable>
      <Pressable
        style={styles.pinnedJumpButton}
        onPress={() => onJumpToMessage(item.id)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel="Jump to message in thread"
      >
        <Ionicons name="arrow-forward" size={16} color={theme.textSecondary} />
      </Pressable>
    </View>
  );
}
const PinnedMessageRow = React.memo(PinnedMessageRowComponent);

// Task 5: one row in the Files / Links gallery tabs (Media uses the tile
// below). Tapping opens the attachment/link the same way the bubble does.
function GalleryListRowComponent({
  entry,
  accent,
  nowMs,
  onOpen,
}: {
  entry: GalleryEntry;
  accent: string;
  nowMs: number;
  onOpen: (url: string) => void;
}) {
  const { styles, theme } = useStyles();
  const ago = msTimeAgo(entry.createdAtMs, nowMs);
  return (
    <Pressable style={styles.galleryRow} onPress={() => onOpen(entry.url)}>
      <View style={styles.galleryRowIcon}>
        <Ionicons name={entry.icon} size={18} color={accent} />
      </View>
      <View style={styles.galleryRowBody}>
        <Text style={styles.galleryRowTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        <Text style={styles.galleryRowMeta} numberOfLines={1}>
          {[entry.subtitle, entry.senderName, ago].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <Ionicons name="open-outline" size={16} color={theme.textSecondary} />
    </Pressable>
  );
}
const GalleryListRow = React.memo(GalleryListRowComponent);

// Task 5: one image/gif tile in the Media grid.
function GalleryMediaTileComponent({
  entry,
  onOpen,
}: {
  entry: GalleryEntry;
  onOpen: (url: string) => void;
}) {
  const { styles, theme } = useStyles();
  return (
    <Pressable style={styles.mediaTile} onPress={() => onOpen(entry.url)}>
      <Image
        source={{ uri: feedImage(entry.url, FEED_IMAGE_WIDTH) }}
        style={styles.mediaTileImage}
        contentFit="cover"
      />
    </Pressable>
  );
}
const GalleryMediaTile = React.memo(GalleryMediaTileComponent);

// Task 5: one hit in the in-channel search results. Tapping jumps to the
// message in the main thread.
function SearchResultRowComponent({
  item,
  accent,
  nowMs,
  onJump,
  isOwn,
  isStaffViewer,
}: {
  item: ThreadMessage;
  accent: string;
  nowMs: number;
  onJump: (messageId: string) => void;
  isOwn?: boolean;
  isStaffViewer?: boolean;
}) {
  const { styles, theme } = useStyles();
  const senderName = item.isAnonymous
    ? anonymousName(item, { isYou: isOwn && isStaffViewer })
    : item.username || "User";
  return (
    <Pressable style={styles.galleryRow} onPress={() => onJump(item.id)}>
      <View style={styles.galleryRowIcon}>
        <Ionicons name="chatbubble-ellipses-outline" size={18} color={accent} />
      </View>
      <View style={styles.galleryRowBody}>
        <Text style={styles.galleryRowTitle} numberOfLines={1}>
          {[senderName, getTimeAgo(item.createdAt, nowMs)].filter(Boolean).join(" · ")}
        </Text>
        <Text style={styles.searchResultSnippet} numberOfLines={2}>
          {item.text}
        </Text>
      </View>
      <Ionicons name="arrow-forward" size={16} color={theme.textSecondary} />
    </Pressable>
  );
}
const SearchResultRow = React.memo(SearchResultRowComponent);

export default function ServerChannelScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { serverId, channelId, serverName, channelLabel, serverAccent } =
    useLocalSearchParams<RouteParams>();

  const resolvedServerId = getSingleParam(serverId) || null;
  const resolvedChannelId = getSingleParam(channelId) || null;
  const resolvedServerName = getSingleParam(serverName) || "Server";
  const resolvedChannelLabel = getSingleParam(channelLabel) || "general";
  const resolvedServerAccent = getSingleParam(serverAccent) || theme.primary;
  const relativeTimeNow = useRelativeTimeNow();

  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [currentUserProfile, setCurrentUserProfile] = useState<any>(
    () => buildCurrentUserPreview(auth.currentUser),
  );
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  // Your messages whose attachments are still uploading, shown until the
  // saved message arrives under the same id.
  const [sendingMessages, setSendingMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const { isOffline } = useNetworkStatus();

  // Task 3: this server's owner/creator, used to decide who may pin messages.
  // Mirrors the communityServers update/delete rule (isStaff || createdBy ||
  // ownerId) rather than introducing a new authority concept.
  const [serverMeta, setServerMeta] = useState<{
    createdBy?: string;
    ownerId?: string;
  } | null>(null);
  // Task 3: the "Pinned messages" sheet is open.
  const [pinnedListVisible, setPinnedListVisible] = useState(false);
  // Task 4B: has THIS user muted THIS channel's notifications. Per-user only —
  // never affects anyone else's notifications, membership, or ability to
  // read/post here.
  const [channelMuted, setChannelMuted] = useState(false);
  // Task 5: the "channel content" sheet (Media / Files / Links / Search).
  const [contentSheetVisible, setContentSheetVisible] = useState(false);
  // Stable, so the sheets' drag gesture isn't rebuilt on every render.
  const closePinnedList = useCallback(() => setPinnedListVisible(false), []);
  const closeContentSheet = useCallback(() => setContentSheetVisible(false), []);
  const [contentTab, setContentTab] = useState<ContentTab>("media");
  const [galleryVisibleCount, setGalleryVisibleCount] = useState(GALLERY_PAGE_SIZE);
  const [searchQuery, setSearchQuery] = useState("");

  // Fullscreen image viewer (pinch-zoom + save to gallery). Opened from an
  // attachment in a bubble or from the Media gallery grid.
  const [imageViewer, setImageViewer] = useState<{
    images: string[];
    index: number;
  } | null>(null);
  const openImageViewer = useCallback((urls: string[], index: number) => {
    const images = urls.filter(Boolean);
    if (images.length === 0) return;
    setImageViewer({
      images,
      index: Math.min(Math.max(index, 0), images.length - 1),
    });
  }, []);
  const closeImageViewer = useCallback(() => setImageViewer(null), []);

  // Feature 5: everyone's read position in this channel (own row excluded).
  const [reads, setReads] = useState<ChannelRead[]>([]);
  const lastReadWriteAtRef = useRef(0);
  const lastReadWrittenMsRef = useRef(0);
  const pendingReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Feature 6: other members currently typing here (own row excluded, stale
  // docs filtered client-side).
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  // true once we've written the "start" doc for the current typing burst.
  const typingActiveRef = useRef(false);
  // When we last wrote/refreshed our typing doc, so keystrokes only refresh it
  // every TYPING_REFRESH_MS.
  const lastTypingWriteAtRef = useRef(0);
  // Fires TYPING_IDLE_MS after the last keystroke to clear our typing doc.
  const typingIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Forward Message state
  const [forwardModalVisible, setForwardModalVisible] = useState(false);
  const [forwardTargetMessage, setForwardTargetMessage] = useState<ThreadMessage | null>(null);
  const [forwardSearchQuery, setForwardSearchQuery] = useState("");
  const [forwardStatusMap, setForwardStatusMap] = useState<Record<string, "sending" | "sent" | "error">>({});
  const [allServers, setAllServers] = useState<any[]>([]);
  const [myMemberships, setMyMemberships] = useState<string[]>([]);
  const [currentServerData, setCurrentServerData] = useState<any>(null);

  // Single dialog state used to render alerts on this screen through the
  // app's branded ConfirmDialog instead of the bare native Alert.alert.
  // (The self-harm safety notice has a dialog of its own — see
  // components/SafetyDialog.)
  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    singleAction?: boolean;
    onConfirm: () => void;
  } | null>(null);
  // Self-harm gets its own dialog instead of the generic one — see
  // components/SafetyDialog.
  const [safetyVisible, setSafetyVisible] = useState(false);
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
  const listRef = useRef<FlatList<ThreadMessage>>(null);
  const isNearBottomRef = useRef(true);
  const isInitialLoadRef = useRef(true);
  const userScrolledUpRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Reanimated keeps the keyboard lift on the UI thread, so opening the
  // keyboard doesn't wait for JavaScript work.
  const composerBottom = useSharedValue(0);
  const composerAnimatedStyle = useAnimatedStyle(() => ({
    marginBottom: composerBottom.value,
  }));

  const translateY = useSharedValue(SCREEN_HEIGHT);
  const overlayOpacity = useSharedValue(0);

  const closeToDrawer = useCallback(() => {
    translateY.value = withTiming(SCREEN_HEIGHT, { duration: 240 });
    overlayOpacity.value = withTiming(0, { duration: 200 }, (finished) => {
      if (finished) {
        runOnJS(requestServerDrawerReopen)();
        runOnJS(router.back)();
      }
    });
  }, [router]);

  useEffect(() => {
    translateY.value = withTiming(0, { duration: 280 });
    overlayOpacity.value = withTiming(1, { duration: 220 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount, same as the original PanResponder-based version
  }, []);

  useEffect(() => {
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      closeToDrawer();
      return true;
    });
    return () => backHandler.remove();
  }, [closeToDrawer]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setCurrentUserProfile((currentProfile: any) => {
        if (!nextUser) return null;
        if (currentProfile?.uid === nextUser.uid) {
          return currentProfile;
        }
        return buildCurrentUserPreview(nextUser);
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user?.uid || isOffline) return;

    // Load initial profile via getUserDataByAuthUser
    getUserDataByAuthUser(user)
      .then((profile) => {
        if (profile) {
          setCurrentUserProfile({
            ...(buildCurrentUserPreview(user) || {}),
            ...profile,
            uid: user.uid,
            profilePic: profile.profileImage || null,
          });
        }
      })
      .catch((error) => {
        console.error("Error fetching current user profile:", error);
      });

    // Real-time listener on student document so role changes (e.g. assigned moderator) update live
    const emailPrefix = user.email?.split("@")[0]?.trim();
    const docIds = Array.from(new Set([emailPrefix, user.uid].filter(Boolean) as string[]));
    const unsubs = docIds.map((docId) =>
      onSnapshot(
        doc(db, "students", docId),
        (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            const liveRole = normalizeUserRole(data.role);
            const incomingImg = data.profileImage || data.profilePic;
            setCurrentUserProfile((prev: any) => ({
              ...(prev || {}),
              ...data,
              role: liveRole,
              uid: user.uid,
              profileImage: incomingImg || prev?.profileImage || null,
              profilePic: incomingImg || prev?.profilePic || null,
            }));
          }
        },
        (err) => console.warn("Live user profile listener warning:", err),
      ),
    );

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [isOffline, user]);

  // Task 3: track this server's owner/creator so pin permission can mirror the
  // communityServers rule. One tiny doc; a listener keeps it correct across a
  // rare ownership transfer.
  useEffect(() => {
    if (!resolvedServerId) return;
    const unsubscribe = onSnapshot(
      doc(db, "communityServers", resolvedServerId),
      (snapshot) => {
        const data = snapshot.data();
        setServerMeta(
          data ? { createdBy: (data as any).createdBy, ownerId: (data as any).ownerId } : null,
        );
        setCurrentServerData(data || null);
      },
      (error) => console.error("Error loading server metadata:", error),
    );
    return unsubscribe;
  }, [resolvedServerId]);

  const currentChannel = useMemo(() => {
    if (!currentServerData?.sections) return null;
    for (const section of currentServerData.sections) {
      const found = (section.channels || []).find(
        (ch: any) => ch.id === resolvedChannelId || ch.label === resolvedChannelLabel,
      );
      if (found) return found;
    }
    return null;
  }, [currentServerData?.sections, resolvedChannelId, resolvedChannelLabel]);

  const channelType: ChannelType = useMemo(
    () =>
      resolveChannelType(
        currentChannel ?? { id: resolvedChannelId || "", label: resolvedChannelLabel || "" },
      ),
    [currentChannel, resolvedChannelId, resolvedChannelLabel],
  );

  // Read-only and Rules: staff and the owner post; students read, react, forward.
  const isStaffOnly = channelType === "rules" || channelType === "announcement";
  const userIsStaff = ["admin", "moderator", "teacher"].includes(currentUserProfile?.role || "");
  const userIsOwner =
    currentServerData?.ownerId === user?.uid || currentServerData?.createdBy === user?.uid;
  // Staff only: its messages are kept apart from everyone else's, and a
  // student can't open it, even from an old link or a notification.
  const staffChannelHere = channelType === "staff";
  const messageCollection = staffChannelHere ? "communityStaffMessages" : "communityThreadMessages";
  const staffChannelBlocked = staffChannelHere && !!currentUserProfile && !userIsStaff;
  const canPostInChannel = staffChannelHere
    ? userIsStaff
    : !isStaffOnly || userIsStaff || userIsOwner;
  const canManageChannel = userIsStaff || userIsOwner;

  useEffect(() => {
    if (!resolvedServerId || !resolvedChannelId) return;
    // Staff only: nothing to load until we know this is staff, and never
    // for a student (the rules would refuse it anyway).
    if (staffChannelHere && !userIsStaff) return;

    let isMounted = true;
    getCachedChannelMessages<ThreadMessage>(resolvedServerId, resolvedChannelId).then((cached) => {
      if (isMounted && cached && cached.length > 0) {
        setMessages((prev) => (prev.length === 0 ? cached : prev));
        setLoading(false);
      }
    });

    // Only this channel's messages instead of every community message in the
    // app. Equality-only filters need no composite index, so there is nothing
    // to deploy; the list is sorted by time on the phone below.
    const messagesQuery = query(
      collection(db, messageCollection),
      where("serverId", "==", resolvedServerId),
      where("channelId", "==", resolvedChannelId),
    );

    const unsubscribe = onSnapshot(
      messagesQuery,
      (snapshot) => {
        if (__DEV__) console.log(`[ServerChannel] messages loaded for this channel: ${snapshot.size}`);
        const nextMessages = snapshot.docs
          .map(
            (item) =>
              ({
                id: item.id,
                ...item.data(),
              }) as ThreadMessage,
          )
          .filter((item) =>
            canViewModeratedContent({
              moderationStatus: item.moderationStatus,
              realUserId: item.realUserId,
              userId: item.userId,
              viewerUserId: user?.uid,
              viewerRole: currentUserProfile?.role,
            }),
          )
          .sort((a, b) => getMessageSortMs(a) - getMessageSortMs(b) || 0);
        setMessages(nextMessages);
        // A saved message takes over from the copy shown while it uploaded.
        const savedIds = new Set(snapshot.docs.map((item) => item.id));
        setSendingMessages((prev) =>
          prev.some((message) => savedIds.has(message.id))
            ? prev.filter((message) => !savedIds.has(message.id))
            : prev,
        );
        setLoading(false);
        saveCachedChannelMessages(resolvedServerId, resolvedChannelId, nextMessages);
      },
      (error) => {
        console.error("Error loading thread messages:", error);
        setLoading(false);
      },
    );

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [currentUserProfile?.role, messageCollection, resolvedChannelId, resolvedServerId, staffChannelHere, user?.uid, userIsStaff]);


  const [editChannelModalVisible, setEditChannelModalVisible] = useState(false);
  const [editChannelName, setEditChannelName] = useState("");
  const [editChannelType, setEditChannelType] = useState<ChannelType>("text");
  const [editChannelEmoji, setEditChannelEmoji] = useState("💬");
  const [editChannelHint, setEditChannelHint] = useState("");

  const handleOpenEditChannel = useCallback(() => {
    setEditChannelName(resolvedChannelLabel || currentChannel?.label || "channel");
    setEditChannelType(channelType);
    setEditChannelEmoji(currentChannel?.emoji || getChannelDefaultEmoji(channelType));
    setEditChannelHint(currentChannel?.hint || "");
    setEditChannelModalVisible(true);
  }, [channelType, currentChannel?.emoji, currentChannel?.hint, currentChannel?.label, resolvedChannelLabel]);

  const handleSaveChannelChanges = useCallback(async () => {
    if (!resolvedServerId || !resolvedChannelId || !editChannelName.trim()) return;
    try {
      const nextSections = updateChannelInSections(
        currentServerData?.sections,
        resolvedServerId,
        resolvedChannelId,
        {
          label: editChannelName.trim(),
          channelType: editChannelType,
          emoji: editChannelEmoji.trim() || getChannelDefaultEmoji(editChannelType),
          hint: editChannelHint.trim(),
        },
      );
      await updateDoc(doc(db, "communityServers", resolvedServerId), {
        sections: nextSections,
        // Each channel's type, for the database rules.
        channelAccess: buildChannelAccess(nextSections),
        updatedAt: serverTimestamp(),
      });
      setEditChannelModalVisible(false);
    } catch (err) {
      console.error("Failed to update channel:", err);
      showInfo("Couldn't save the channel", "Check your connection and try again.");
    }
  }, [currentServerData?.sections, editChannelEmoji, editChannelHint, editChannelName, editChannelType, resolvedChannelId, resolvedServerId]);

  const handleDeleteCurrentChannel = useCallback(() => {
    if (!resolvedServerId || !resolvedChannelId) return;
    showConfirm({
      title: `Delete #${resolvedChannelLabel}?`,
      description: "Everything posted in this channel goes with it. This can't be undone.",
      confirmText: "Delete channel",
      cancelText: "Cancel",
      destructive: true,
      onConfirm: async () => {
        try {
          const nextSections = deleteChannelFromSections(
            currentServerData?.sections,
            resolvedServerId,
            resolvedChannelId,
          );
          await updateDoc(doc(db, "communityServers", resolvedServerId), {
            sections: nextSections,
            channelAccess: buildChannelAccess(nextSections),
            updatedAt: serverTimestamp(),
          });
          setEditChannelModalVisible(false);
          closeToDrawer();
          showAppToast({ message: `#${resolvedChannelLabel} deleted` });
        } catch (err) {
          console.error("Failed to delete channel:", err);
          showInfo("Couldn't delete the channel", "Check your connection and try again.");
        }
      },
    });
  }, [closeToDrawer, currentServerData?.sections, resolvedChannelId, resolvedChannelLabel, resolvedServerId]);

  // Load servers and user memberships when Forward Modal is visible
  useEffect(() => {
    if (!forwardModalVisible || !user?.uid) return;

    const unsubServers = onSnapshot(
      collection(db, "communityServers"),
      (snap) => {
        setAllServers(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      (err) => console.warn("Failed to load servers for forward modal:", err),
    );

    const unsubMemberships = onSnapshot(
      query(
        collection(db, "communityServerMemberships"),
        where("userId", "==", user.uid),
        where("status", "==", "joined"),
      ),
      (snap) => {
        setMyMemberships(snap.docs.map((d) => (d.data() as any).serverId));
      },
      (err) => console.warn("Failed to load memberships for forward modal:", err),
    );

    return () => {
      unsubServers();
      unsubMemberships();
    };
  }, [forwardModalVisible, user?.uid]);

  const forwardDestinations = useMemo(() => {
    const isStaffViewer = isStaff(currentUserProfile?.role);
    const list: {
      serverId: string;
      serverName: string;
      channelId: string;
      channelName: string;
      channelEmoji?: string;
      isCurrentServer: boolean;
      staffChannel?: boolean;
    }[] = [];

    // First, add all channels from current server
    if (resolvedServerId) {
      const currentSections = currentServerData?.sections || [];
      if (currentSections.length > 0) {
        for (const sec of currentSections) {
          for (const ch of sec.channels || []) {
            if (!isStaffViewer && isStaffOnlyChannel(ch)) continue;
            list.push({
              serverId: resolvedServerId,
              serverName: resolvedServerName,
              channelId: ch.id,
              channelName: ch.label || ch.id,
              channelEmoji: ch.emoji,
              isCurrentServer: true,
              staffChannel: isStaffChannel(ch),
            });
          }
        }
      } else {
        list.push({
          serverId: resolvedServerId,
          serverName: resolvedServerName,
          channelId: resolvedChannelId || `${resolvedServerId}_general`,
          channelName: resolvedChannelLabel || "general",
          isCurrentServer: true,
        });
      }
    }

    // Next, add channels from other joined servers
    for (const server of allServers) {
      if (server.isDeleted || server.id === resolvedServerId) continue;
      const isJoined = myMemberships.includes(server.id) || isStaffViewer;
      if (!isJoined) continue;

      const sections = server.sections || [];
      if (sections.length === 0) {
        list.push({
          serverId: server.id,
          serverName: server.name || "Server",
          channelId: `${server.id}_general`,
          channelName: "general",
          isCurrentServer: false,
        });
      } else {
        for (const sec of sections) {
          for (const ch of sec.channels || []) {
            if (!isStaffViewer && isStaffOnlyChannel(ch)) continue;
            list.push({
              serverId: server.id,
              serverName: server.name || "Server",
              channelId: ch.id,
              channelName: ch.label || ch.id,
              channelEmoji: ch.emoji,
              isCurrentServer: false,
              staffChannel: isStaffChannel(ch),
            });
          }
        }
      }
    }

    return list;
  }, [
    allServers,
    currentServerData?.sections,
    currentUserProfile?.role,
    myMemberships,
    resolvedChannelId,
    resolvedChannelLabel,
    resolvedServerId,
    resolvedServerName,
  ]);

  const filteredForwardDestinations = useMemo(() => {
    if (!forwardSearchQuery.trim()) return forwardDestinations;
    const q = forwardSearchQuery.trim().toLowerCase();
    return forwardDestinations.filter(
      (d) =>
        d.channelName.toLowerCase().includes(q) ||
        d.serverName.toLowerCase().includes(q),
    );
  }, [forwardDestinations, forwardSearchQuery]);

  const handleForwardToChannel = useCallback(
    async (dest: {
      serverId: string;
      serverName: string;
      channelId: string;
      channelName: string;
      staffChannel?: boolean;
    }) => {
      if (!user?.uid || !forwardTargetMessage) return;
      if (isOffline) {
        showInfo("No Connection", "You need internet access to forward messages.");
        return;
      }

      setForwardStatusMap((prev) => ({ ...prev, [dest.channelId]: "sending" }));

      try {
        const forwardPayload = {
          text: forwardTargetMessage.text || "",
          files: forwardTargetMessage.files || [],
          link: forwardTargetMessage.link || null,
          userId: user.uid,
          realUserId: user.uid,
          username:
            `${currentUserProfile?.firstname || ""} ${currentUserProfile?.lastname || ""}`.trim() ||
            String(currentUserProfile?.username || user.displayName || "").trim() ||
            "User",
          role: currentUserProfile?.role || "student",
          profilePic: resolveAvatarUri(currentUserProfile),
          profileImage: resolveAvatarUri(currentUserProfile),
          isAnonymous: false,
          serverId: dest.serverId,
          channelId: dest.channelId,
          createdAt: serverTimestamp(),
          // Only staff can reach a Staff only channel, and staff messages
          // skip the moderation queue.
          moderationStatus: dest.staffChannel ? "approved" : "pending",
          moderationReasons: [],
          moderatedAtMs: null,
          forwarded: true,
          isForwarded: true,
          forwardedFrom: {
            senderName: forwardTargetMessage.isAnonymous
              ? anonymousName(forwardTargetMessage)
              : forwardTargetMessage.username || "User",
            channelId: resolvedChannelId,
            channelName: resolvedChannelLabel,
            serverId: resolvedServerId,
            serverName: resolvedServerName,
          },
        };

        const docRef = await addDoc(
          collection(db, dest.staffChannel ? "communityStaffMessages" : "communityThreadMessages"),
          forwardPayload,
        );
        if (!dest.staffChannel) {
          requestFirestoreModerationDecision({
            collectionName: "communityThreadMessages",
            documentId: docRef.id,
            scope: "thread",
          }).catch((err) => {
            console.warn("[ServerChannel] Moderation trigger on forward failed:", err);
          });
        }

        setForwardStatusMap((prev) => ({ ...prev, [dest.channelId]: "sent" }));
      } catch (error: any) {
        console.error("Error forwarding message:", error);
        setForwardStatusMap((prev) => ({ ...prev, [dest.channelId]: "error" }));
        showInfo(
          "Forward Failed",
          error?.message || "Could not forward message to this channel.",
        );
      }
    },
    [
      currentUserProfile,
      forwardTargetMessage,
      isOffline,
      resolvedChannelId,
      resolvedChannelLabel,
      resolvedServerId,
      resolvedServerName,
      user?.displayName,
      user?.uid,
    ],
  );

  // Task 4B: watch this user's own mute doc for this channel (also picks up a
  // toggle made on another device).
  useEffect(() => {
    if (!resolvedChannelId || !user?.uid) return;
    const currentUid = user.uid;
    let unsub: (() => void) | undefined;
    const task = InteractionManager.runAfterInteractions(() => {
      unsub = onSnapshot(
        doc(db, "channelMutes", `${resolvedChannelId}_${currentUid}`),
        (snapshot) => setChannelMuted(snapshot.exists()),
        (error) => console.error("Error loading channel mute:", error),
      );
    });
    return () => {
      task.cancel();
      if (unsub) unsub();
    };
  }, [resolvedChannelId, user?.uid]);

  // Feature 5: subscribe to everyone's channelReads doc for this channel.
  useEffect(() => {
    if (!resolvedChannelId) return;
    const currentUid = user?.uid;
    let unsub: (() => void) | undefined;
    const task = InteractionManager.runAfterInteractions(() => {
      unsub = onSnapshot(
        query(
          collection(db, "channelReads"),
          where("channelId", "==", resolvedChannelId),
        ),
        (snapshot) => {
          setReads(
            snapshot.docs
              .map((entry) => entry.data() as Partial<ChannelRead>)
              .filter(
                (entry): entry is ChannelRead =>
                  typeof entry.userId === "string" &&
                  typeof entry.lastReadAtMs === "number" &&
                  entry.userId !== currentUid,
              ),
          );
        },
        (error) => console.error("Error loading read receipts:", error),
      );
    });
    return () => {
      task.cancel();
      if (unsub) unsub();
    };
  }, [resolvedChannelId, user?.uid]);

  // Feature 6: subscribe to everyone's typingIndicators doc for this channel.
  // Own row is dropped here; staleness is filtered at render time.
  useEffect(() => {
    if (!resolvedChannelId) return;
    const currentUid = user?.uid;
    let unsub: (() => void) | undefined;
    const task = InteractionManager.runAfterInteractions(() => {
      unsub = onSnapshot(
        query(
          collection(db, "typingIndicators"),
          where("channelId", "==", resolvedChannelId),
        ),
        (snapshot) => {
          setTypingUsers(
            snapshot.docs
              .map((entry) => {
                const data = entry.data() as {
                  userId?: string;
                  name?: string;
                  updatedAt?: { toMillis?: () => number } | null;
                };
                return {
                  userId: data.userId,
                  name: data.name,
                  // A just-created doc has a null server timestamp locally; treat
                  // it as fresh until the real value lands.
                  updatedAtMs: data.updatedAt?.toMillis?.() ?? Date.now(),
                };
              })
              .filter(
                (entry): entry is TypingUser =>
                  typeof entry.userId === "string" &&
                  typeof entry.name === "string" &&
                  entry.userId !== currentUid,
              ),
          );
        },
        (error) => console.error("Error loading typing indicators:", error),
      );
    });
    return () => {
      task.cancel();
      if (unsub) unsub();
    };
  }, [resolvedChannelId, user?.uid]);

  // Re-render every couple of seconds while someone is typing so a stale doc
  // (crashed / backgrounded client) drops off after TYPING_STALE_MS even with
  // no new snapshot. Idle otherwise.
  const [typingNowMs, setTypingNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (typingUsers.length === 0) return;
    const id = setInterval(() => setTypingNowMs(Date.now()), 2000);
    return () => clearInterval(id);
  }, [typingUsers.length]);

  const typingNames = useMemo(
    () =>
      typingUsers
        .filter((entry) => typingNowMs - entry.updatedAtMs < TYPING_STALE_MS)
        .map((entry) => entry.name),
    [typingUsers, typingNowMs],
  );

  // Feature 5: record how far this member has read, debounced to one write per
  // READ_WRITE_MIN_INTERVAL_MS per visit. Skips entirely when already caught
  // up. A trailing timer covers the "kept scrolling during the cooldown" case
  // and is cleared on unmount.
  const markRead = useCallback(
    (newestMs: number) => {
      const uid = user?.uid;
      if (
        !uid ||
        !resolvedServerId ||
        !resolvedChannelId ||
        isOffline ||
        !newestMs ||
        newestMs <= lastReadWrittenMsRef.current
      ) {
        return;
      }
      const write = (ms: number) => {
        lastReadWrittenMsRef.current = ms;
        lastReadWriteAtRef.current = Date.now();
        setDoc(
          doc(db, "channelReads", `${resolvedChannelId}_${uid}`),
          {
            serverId: resolvedServerId,
            channelId: resolvedChannelId,
            userId: uid,
            name:
              currentUserProfile?.firstname || currentUserProfile?.username || "Someone",
            avatarUrl: resolveAvatarUri(currentUserProfile) || null,
            lastReadAtMs: ms,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        ).catch((error) => console.error("Failed to write read receipt:", error));
      };
      const sinceLast = Date.now() - lastReadWriteAtRef.current;
      if (sinceLast >= READ_WRITE_MIN_INTERVAL_MS) {
        write(newestMs);
      } else if (!pendingReadTimerRef.current) {
        pendingReadTimerRef.current = setTimeout(() => {
          pendingReadTimerRef.current = null;
          write(newestMs);
        }, READ_WRITE_MIN_INTERVAL_MS - sinceLast);
      }
    },
    [
      currentUserProfile,
      isOffline,
      resolvedChannelId,
      resolvedServerId,
      user?.uid,
    ],
  );

  useEffect(
    () => () => {
      if (pendingReadTimerRef.current) clearTimeout(pendingReadTimerRef.current);
    },
    [],
  );

  // Feature 6: clear our typingIndicators doc. Safe to call unconditionally —
  // it no-ops when we weren't marked typing, and swallows the delete error for
  // an already-absent doc.
  const stopTyping = useCallback(() => {
    if (typingIdleTimerRef.current) {
      clearTimeout(typingIdleTimerRef.current);
      typingIdleTimerRef.current = null;
    }
    if (!typingActiveRef.current) return;
    typingActiveRef.current = false;
    lastTypingWriteAtRef.current = 0;
    const uid = user?.uid;
    if (!uid || !resolvedChannelId) return;
    deleteDoc(doc(db, "typingIndicators", `${resolvedChannelId}_${uid}`)).catch(
      () => {},
    );
  }, [resolvedChannelId, user?.uid]);

  // Feature 6: called by the composer as the user types. Writes one "start"
  // doc, refreshes it at most every TYPING_REFRESH_MS, and arms a trailing
  // timer to clear it once the user has been idle for TYPING_IDLE_MS.
  const handleTyping = useCallback(
    (isTyping: boolean) => {
      const uid = user?.uid;
      if (!uid || !resolvedServerId || !resolvedChannelId || isOffline) return;

      if (!isTyping) {
        stopTyping();
        return;
      }

      const now = Date.now();
      if (!typingActiveRef.current || now - lastTypingWriteAtRef.current >= TYPING_REFRESH_MS) {
        typingActiveRef.current = true;
        lastTypingWriteAtRef.current = now;
        setDoc(doc(db, "typingIndicators", `${resolvedChannelId}_${uid}`), {
          serverId: resolvedServerId,
          channelId: resolvedChannelId,
          userId: uid,
          name:
            currentUserProfile?.firstname || currentUserProfile?.username || "Someone",
          updatedAt: serverTimestamp(),
        }).catch((error) => console.error("Failed to write typing indicator:", error));
      }

      if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
      typingIdleTimerRef.current = setTimeout(stopTyping, TYPING_IDLE_MS);
    },
    [
      currentUserProfile,
      isOffline,
      resolvedChannelId,
      resolvedServerId,
      stopTyping,
      user?.uid,
    ],
  );

  // Feature 6: stop typing on unmount (leaving the channel).
  useEffect(() => stopTyping, [stopTyping]);

  // Reset scroll tracking and ensure we land at the latest messages when channel changes
  useEffect(() => {
    isInitialLoadRef.current = true;
    userScrolledUpRef.current = false;
    isNearBottomRef.current = true;
    setShowScrollToBottom(false);

    const timer = setTimeout(() => {
      if (!userScrolledUpRef.current) {
        listRef.current?.scrollToEnd({ animated: false });
      }
      isInitialLoadRef.current = false;
    }, 600);
    return () => clearTimeout(timer);
  }, [resolvedChannelId]);

  const handleScrollBeginDrag = useCallback(() => {
    userScrolledUpRef.current = true;
    isInitialLoadRef.current = false;
  }, []);

  const handleContentSizeChange = useCallback(() => {
    if (isInitialLoadRef.current) {
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }
    if (isNearBottomRef.current && !userScrolledUpRef.current) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    userScrolledUpRef.current = false;
    isNearBottomRef.current = true;
    setShowScrollToBottom(false);
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  useEffect(() => {
    if (!messages.length) return;
    if (isInitialLoadRef.current || (isNearBottomRef.current && !userScrolledUpRef.current)) {
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: !isInitialLoadRef.current });
      });
    }
  }, [messages.length]);

  useEffect(() => {
    if (!resolvedServerId || !resolvedChannelId || messages.length === 0) return;

    const latestMessage = messages[messages.length - 1];
    const latestCreatedAtMs = latestMessage?.createdAt?.toMillis?.() || Date.now();

    markCommunityChannelViewed(
      resolvedServerId,
      resolvedChannelId,
      latestCreatedAtMs,
    ).catch((error) => {
      console.error("Error marking channel as viewed:", error);
    });

    // Feature 5: viewing the channel while messages arrive counts as reading
    // them; the debounce inside markRead keeps this from being a write storm.
    markRead(latestCreatedAtMs);
  }, [markRead, messages, resolvedChannelId, resolvedServerId]);

  useEffect(() => {
    const scrollToEndIfNearBottom = () => {
      if (isNearBottomRef.current || !userScrolledUpRef.current) {
        requestAnimationFrame(() => {
          listRef.current?.scrollToEnd({ animated: true });
        });
      }
    };

    const showSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (event: KeyboardEvent) => {
        composerBottom.value = withTiming(
          Math.max(0, event.endCoordinates.height),
          { duration: Platform.OS === "ios" ? event.duration || 250 : 220 },
          (finished) => {
            if (finished) runOnJS(scrollToEndIfNearBottom)();
          },
        );
      },
    );

    const hideSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      (event: KeyboardEvent) => {
        composerBottom.value = withTiming(0, {
          duration: Platform.OS === "ios" ? event.duration || 250 : 180,
        });
      },
    );

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [composerBottom]);

  const handleProfilePress = useCallback(
    (targetUserId?: string, isAnonymous?: boolean) => {
      if (!targetUserId || isAnonymous || targetUserId === "anonymous") return;
      const returnTo = `/ServerChannelScreen?serverId=${encodeURIComponent(resolvedServerId || "")}&channelId=${encodeURIComponent(resolvedChannelId || "")}&serverName=${encodeURIComponent(resolvedServerName || "")}&channelLabel=${encodeURIComponent(resolvedChannelLabel || "")}&serverAccent=${encodeURIComponent(resolvedServerAccent || "")}`;
      if (user?.uid === targetUserId) {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo },
        });
        return;
      }
      router.push(
        buildUserProfileHref({
          userId: targetUserId,
          returnTo,
        }) as any,
      );
    },
    [
      resolvedChannelId,
      resolvedChannelLabel,
      resolvedServerAccent,
      resolvedServerId,
      resolvedServerName,
      router,
      user?.uid,
    ],
  );

  // Feature 1: only one message shows its tap-to-reveal timestamp at a time —
  // tapping another message moves the reveal, tapping the same one clears it.
  const [revealedMessageId, setRevealedMessageId] = useState<string | null>(null);
  const handleToggleReveal = useCallback((messageId: string) => {
    setRevealedMessageId((current) => (current === messageId ? null : messageId));
  }, []);

  // Feature 3: long-press opens the emoji picker for that message.
  const [reactionTargetId, setReactionTargetId] = useState<string | null>(null);
  const handleOpenReactionPicker = useCallback((messageId: string) => {
    setReactionTargetId(messageId);
  }, []);
  // The message the long-press menu currently targets — used by the reaction
  // picker card for the pin / edit / delete actions.
  const reactionTargetMessage = useMemo(
    () => messages.find((entry) => entry.id === reactionTargetId),
    [messages, reactionTargetId],
  );
  const reactionTargetIsOwn =
    !!reactionTargetMessage &&
    (reactionTargetMessage.realUserId || reactionTargetMessage.userId) === user?.uid;
  const canDeleteReactionTarget =
    !!reactionTargetMessage &&
    (reactionTargetIsOwn ||
      (isStaff(currentUserProfile?.role) &&
        normalizeUserRole(reactionTargetMessage.role) === "student" &&
        reactionTargetMessage.aiAssistant !== true));

  // Authors can edit/delete their own message. Admins, moderators and teachers
  // can also delete student-authored channel messages (including replies) as
  // a moderation action. Delete stays a hard delete, matching other content.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const openMessageEditor = useCallback((message: ThreadMessage) => {
    setEditingText(message.text || "");
    setEditingMessageId(message.id);
  }, []);
  const cancelMessageEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditingText("");
  }, []);

  const saveMessageEdit = useCallback(async () => {
    const id = editingMessageId;
    if (!id) return;
    const next = editingText.trim();
    const original = messages.find((entry) => entry.id === id);
    if (!next) {
      showInfo(
        "Message can't be empty",
        "Delete the message instead if you want to remove it.",
      );
      return;
    }
    if (original && original.text === next) {
      cancelMessageEdit();
      return;
    }
    setSavingEdit(true);
    try {
      await updateDoc(doc(db, messageCollection, id), {
        text: next,
        editedAt: serverTimestamp(),
      });
      cancelMessageEdit();
    } catch (error) {
      console.error("Failed to edit message:", error);
      showInfo("Couldn't save edit", "Something went wrong. Please try again.");
    } finally {
      setSavingEdit(false);
    }
  }, [cancelMessageEdit, editingMessageId, editingText, messageCollection, messages]);

  const confirmDeleteMessage = useCallback((message: ThreadMessage) => {
    const isOwn = (message.realUserId || message.userId) === user?.uid;
    const contentLabel = message.replyTo ? "reply" : "message";
    const authorName = message.isAnonymous
      ? anonymousName(message)
      : message.username || "this student";
    showConfirm({
      title: `Delete ${contentLabel}?`,
      description: isOwn
        ? `This removes your ${contentLabel} for everyone in the channel. This can't be undone.`
        : `This removes ${authorName}'s ${contentLabel} for everyone in the channel. This can't be undone.`,
      confirmText: "Delete",
      cancelText: "Cancel",
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, messageCollection, message.id));
          setReplyingTo((current) => (current?.id === message.id ? null : current));
        } catch (error) {
          console.error("Failed to delete message:", error);
          showInfo("Couldn't delete", "Something went wrong. Please try again.");
        }
      },
    });
  }, [messageCollection, user?.uid]);

  // Reporting is a student-only tool: staff never report, and only a
  // student's message or an anonymous one can be reported — the same rule
  // posts, polls and replies use, and the one the Firestore rules enforce.
  const canReportMessage = useCallback(
    (message?: ThreadMessage) =>
      !!message &&
      canReportContent(
        currentUserProfile?.role,
        message.role,
        message.isAnonymous === true,
      ) &&
      (message.realUserId || message.userId) !== user?.uid,
    [currentUserProfile?.role, user?.uid],
  );

  const confirmReportMessage = useCallback(
    (message: ThreadMessage) => {
      showConfirm({
        title: "Report message?",
        description:
          "This message will be sent to the moderation team for review.",
        confirmText: "Send report",
        cancelText: "Cancel",
        destructive: true,
        onConfirm: async () => {
          if (!user?.uid || !canReportMessage(message)) return;
          try {
            await addDoc(collection(db, "reports"), {
              contentType: "message",
              contentId: message.id,
              reportedBy: user.uid,
              reason: "inappropriate",
              createdAt: serverTimestamp(),
              status: "pending",
            });
            showInfo("Reported", "Thank you for your report.");
          } catch (error) {
            console.error("Failed to report message:", error);
            showInfo(
              "Couldn't report",
              "Something went wrong. Please try again.",
            );
          }
        },
      });
    },
    [canReportMessage, user?.uid],
  );

  // Task 4B: mute / unmute this channel's notifications for yourself. Optimistic
  // so the header icon flips instantly; reverts if the write fails. Does not
  // touch membership or posting — only whether mention notifications get
  // created for you from this channel.
  const handleToggleChannelMute = useCallback(async () => {
    const uid = user?.uid;
    if (!uid || !resolvedServerId || !resolvedChannelId) return;
    const next = !channelMuted;
    setChannelMuted(next);
    try {
      await writeChannelMute({
        userId: uid,
        serverId: resolvedServerId,
        channelId: resolvedChannelId,
        muted: next,
      });
    } catch (error) {
      setChannelMuted(!next);
      console.error("Failed to toggle channel mute:", error);
      showInfo("Couldn't update", "Something went wrong. Please try again.");
    }
  }, [channelMuted, resolvedChannelId, resolvedServerId, user?.uid]);

  // Sets the current user's reaction on a message to `emoji`, Messenger-style:
  // one reaction per user. Picking the emoji you already have clears it;
  // picking a different one swaps in a single write. Nested-field updates
  // (reactions.<emoji>) with arrayUnion/arrayRemove keep concurrent reactors
  // from clobbering each other's map and keep `reactions` the only key in
  // affectedKeys() for the Firestore rule.
  const handleSetReaction = useCallback(
    async (messageId: string, emoji: string) => {
      const uid = user?.uid;
      if (!uid) return;
      const message = messages.find((entry) => entry.id === messageId);
      const current = getMyReaction(message, uid);
      const ref = doc(db, messageCollection, messageId);
      try {
        if (current === emoji) {
          await updateDoc(ref, new FieldPath("reactions", emoji), arrayRemove(uid));
        } else if (current) {
          await updateDoc(
            ref,
            new FieldPath("reactions", current),
            arrayRemove(uid),
            new FieldPath("reactions", emoji),
            arrayUnion(uid),
          );
        } else {
          await updateDoc(ref, new FieldPath("reactions", emoji), arrayUnion(uid));
        }
      } catch (error) {
        console.error("Failed to set reaction:", error);
      }
    },
    [messageCollection, messages, user?.uid],
  );

  // A Collaborative channel lets any member pin, so we need to know whether
  // this person has joined the server. One small doc.
  const [isJoinedMember, setIsJoinedMember] = useState(false);
  useEffect(() => {
    if (!resolvedServerId || !user?.uid) return;
    return onSnapshot(
      doc(db, "communityServerMemberships", `${resolvedServerId}_${user.uid}`),
      (snapshot) => setIsJoinedMember(snapshot.exists() && snapshot.data()?.status === "joined"),
      () => setIsJoinedMember(false),
    );
  }, [resolvedServerId, user?.uid]);

  // Task 3: who may pin/unpin in this channel — the server's creator/owner or
  // any app-wide staff member, exactly mirroring the communityServers rule.
  // The Firestore rule enforces the same check; this only drives the UI.
  const canPinMessages = useMemo(() => {
    const uid = user?.uid;
    if (!uid) return false;
    return (
      isStaff(currentUserProfile?.role) ||
      serverMeta?.createdBy === uid ||
      serverMeta?.ownerId === uid ||
      // A Collaborative channel is a shared board: any member may pin.
      (channelType === "media" && isJoinedMember)
    );
  }, [channelType, currentUserProfile?.role, isJoinedMember, serverMeta?.createdBy, serverMeta?.ownerId, user?.uid]);

  // Task 3: everything currently pinned here, newest pin first. Derived from
  // the same messages subscription, so the pinned view updates in real time.
  const pinnedMessages = useMemo(
    () =>
      messages
        .filter((entry) => entry.pinned === true)
        .sort(
          (a, b) =>
            (b.pinnedAt?.toMillis?.() ?? 0) - (a.pinnedAt?.toMillis?.() ?? 0),
        ),
    [messages],
  );

  // Task 3: toggle a message's pin. Writes only the pin fields so it satisfies
  // the narrowly-scoped Firestore rule branch. pinnedByName is denormalised so
  // the pinned view shows "by whom" without a profile lookup.
  const handleTogglePin = useCallback(
    async (messageId: string) => {
      if (!canPinMessages || !user?.uid) return;
      const message = messages.find((entry) => entry.id === messageId);
      if (!message) return;
      const ref = doc(db, messageCollection, messageId);
      try {
        if (message.pinned) {
          await updateDoc(ref, {
            pinned: false,
            pinnedAt: null,
            pinnedBy: null,
            pinnedByName: null,
          });
        } else {
          await updateDoc(ref, {
            pinned: true,
            pinnedAt: serverTimestamp(),
            pinnedBy: user.uid,
            pinnedByName:
              currentUserProfile?.firstname ||
              currentUserProfile?.username ||
              "Staff",
          });
        }
      } catch (error) {
        console.error("Failed to toggle pin:", error);
        showInfo(
          "Couldn't update pin",
          "Something went wrong. Please try again.",
        );
      }
    },
    [canPinMessages, currentUserProfile, messageCollection, messages, user?.uid],
  );

  // Polls: members and staff may vote, even where they can't post.
  const canVotePolls = isJoinedMember || userIsStaff;

  // Your answer after a tap, saved under your own id only; taking every
  // answer back removes your entry.
  const handlePollVote = useCallback(
    async (messageId: string, optionId: string) => {
      const uid = user?.uid;
      if (!uid) return;
      const message = messages.find((entry) => entry.id === messageId);
      if (!message?.poll || pollIsClosed(message.poll, Date.now())) return;
      const { mine } = tallyPoll(message.poll, message.pollVoters, uid);
      const next = nextPollAnswer(message.poll, mine, optionId);
      try {
        await updateDoc(
          doc(db, messageCollection, messageId),
          new FieldPath("pollVoters", uid),
          next.length ? next : deleteField(),
        );
      } catch (error) {
        console.warn("[ServerChannel] Vote not saved:", error);
        showInfo("Vote not saved", "Check your connection and try again.");
      }
    },
    [messageCollection, messages, user?.uid],
  );

  const handleAddPollOption = useCallback(
    async (messageId: string, text: string): Promise<string | null> => {
      const uid = user?.uid;
      if (!uid) return "Sign in to add an option.";
      const messageRef = doc(db, messageCollection, messageId);
      const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

      try {
        await runTransaction(db, async (transaction) => {
          const snapshot = await transaction.get(messageRef);
          if (!snapshot.exists()) throw new Error("This poll is no longer available.");
          const poll = snapshot.data()?.poll as ChannelPoll | undefined;
          if (!poll) throw new Error("This poll is no longer available.");
          if (pollIsClosed(poll, Date.now())) throw new Error("This poll has ended.");
          const nextPoll = appendUserPollOption(poll, uid, text, suffix);
          transaction.update(messageRef, { poll: nextPoll });
        });
        return null;
      } catch (error: any) {
        const message = String(error?.message || "");
        const expected = [
          "not accepting new options",
          "Write an option first",
          "Keep the option under",
          "already has",
          "already in the poll",
          "no longer available",
          "poll has ended",
        ].find((part) => message.toLowerCase().includes(part.toLowerCase()));
        if (expected) return message;
        console.warn("[ServerChannel] Poll option not added:", error);
        return "Couldn't add the option. Check your connection and try again.";
      }
    },
    [messageCollection, user?.uid],
  );

  const confirmEndPoll = useCallback(
    (messageId: string) => {
      showConfirm({
        title: "End this poll?",
        description: "Nobody can vote once it ends. The results stay in the channel.",
        confirmText: "End poll",
        cancelText: "Cancel",
        destructive: false,
        onConfirm: async () => {
          try {
            await updateDoc(doc(db, messageCollection, messageId), "poll.closesAt", serverTimestamp());
          } catch (error) {
            console.warn("[ServerChannel] Couldn't end the poll:", error);
            showInfo("Couldn't end the poll", "Check your connection and try again.");
          }
        },
      });
    },
    [messageCollection],
  );

  // Task 3: open a pinned item's content straight from the sheet — the actual
  // point of the feature. Attachment or link opens externally; a text-only
  // pin shows its full text in the branded dialog.
  const handleOpenPinnedContent = useCallback(
    (messageId: string) => {
      const message = messages.find((entry) => entry.id === messageId);
      if (!message) return;
      const file = (message.files || [])[0];
      if (file?.url) {
        Linking.openURL(file.url).catch(() => null);
        return;
      }
      if (message.link?.url) {
        Linking.openURL(message.link.url).catch(() => null);
        return;
      }
      showInfo(
        message.isAnonymous ? anonymousName(message) : message.username || "Pinned message",
        message.text?.trim() || "This message has no text.",
      );
    },
    [messages],
  );

  // Task 3: nice-to-have — close the open sheet and scroll the main thread to
  // the target message. onScrollToIndexFailed (on the list) covers rows that
  // aren't measured yet. Also used by Task 5 search results.
  const handleJumpToMessage = useCallback(
    (messageId: string) => {
      const index = messages.findIndex((entry) => entry.id === messageId);
      if (index < 0) return;
      setPinnedListVisible(false);
      setContentSheetVisible(false);
      requestAnimationFrame(() => {
        try {
          listRef.current?.scrollToIndex({
            index,
            animated: true,
            viewPosition: 0.3,
          });
        } catch {
          // ignore — onScrollToIndexFailed handles the retry
        }
      });
    },
    [messages],
  );

  const [pendingExternalLink, setPendingExternalLink] = useState<
    ReturnType<typeof prepareExternalLink>
  >(null);

  // Typed and attached links use the same domain-first safety screen as DMs.
  const handleOpenUrl = useCallback((url: string, label?: string) => {
    if (url) setPendingExternalLink(prepareExternalLink(url, label));
  }, []);

  // Task 5: flatten the (already fully loaded) channel history into per-item
  // gallery entries, newest first. Reuses the shared file classification so a
  // file lands in the same bucket here as it renders in the bubble.
  const galleryEntries = useMemo(() => {
    const media: GalleryEntry[] = [];
    const files: GalleryEntry[] = [];
    const links: GalleryEntry[] = [];
    const isStaffUser = isStaff(currentUserProfile?.role);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      const createdAtMs = message.createdAt?.toMillis?.() ?? 0;
      const isOwnMsg = (message.realUserId || message.userId) === user?.uid;
      const senderName = message.isAnonymous
        ? anonymousName(message, { isYou: isOwnMsg && isStaffUser })
        : message.username || "User";
      [...messageGifFiles(message), ...messageImageFiles(message)].forEach(
        (file) => {
          media.push({
            key: `${message.id}:m:${file.url}`,
            messageId: message.id,
            createdAtMs,
            senderName,
            url: file.url,
            isImage: true,
            title: file.name || "Image",
            subtitle: "",
            icon: "image-outline",
          });
        },
      );
      messageDocFiles(message).forEach((file) => {
        const details = getFileIconDetails(file.mimeType, file.name);
        files.push({
          key: `${message.id}:f:${file.url}`,
          messageId: message.id,
          createdAtMs,
          senderName,
          url: file.url,
          isImage: false,
          title: file.name || "Attachment",
          subtitle: details.badge,
          icon: details.icon as any,
        });
      });
      if (message.link?.url) {
        links.push({
          key: `${message.id}:l`,
          messageId: message.id,
          createdAtMs,
          senderName,
          url: message.link.url,
          isImage: false,
          title: message.link.title || "Link",
          subtitle: message.link.url,
          icon: "link-outline",
        });
      }
      splitMessageLinks(message.text || "")
        .filter((part) => part.url && part.url !== message.link?.url)
        .forEach((part, linkIndex) => {
          links.push({
            key: `${message.id}:text-link:${linkIndex}`,
            messageId: message.id,
            createdAtMs,
            senderName,
            url: part.url!,
            isImage: false,
            title: part.text,
            subtitle: part.url!,
            icon: "link-outline",
          });
        });
    }
    return { media, files, links };
  }, [currentUserProfile?.role, messages, user?.uid]);

  const activeGalleryEntries =
    contentTab === "files"
      ? galleryEntries.files
      : contentTab === "links"
        ? galleryEntries.links
        : galleryEntries.media;

  // Task 5 Feature B: client-side filter over the messages currently loaded
  // into this screen. The messages subscription today loads the channel's full
  // history, so this currently searches everything — but the "loaded messages"
  // framing in the UI stays honest if that subscription is ever capped with a
  // limit(). No server-side text index is built (out of scope for this task).
  const searchResults = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (needle.length < SEARCH_MIN_CHARS) return [];
    const hits: ThreadMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if ((messages[i].text || "").toLowerCase().includes(needle)) {
        hits.push(messages[i]);
      }
    }
    return hits;
  }, [messages, searchQuery]);

  const openContentSheet = useCallback(() => {
    setContentTab("media");
    setGalleryVisibleCount(GALLERY_PAGE_SIZE);
    setSearchQuery("");
    setContentSheetVisible(true);
  }, []);

  const selectContentTab = useCallback((tab: ContentTab) => {
    setContentTab(tab);
    setGalleryVisibleCount(GALLERY_PAGE_SIZE);
  }, []);

  // Media tiles open the fullscreen zoom/save viewer, seeded with every image
  // in the Media tab so you can swipe between them. Files/links still just open.
  const handleOpenMediaTile = useCallback(
    (url: string) => {
      const mediaUrls = galleryEntries.media.map((entry) => entry.url);
      const index = mediaUrls.indexOf(url);
      openImageViewer(mediaUrls, index < 0 ? 0 : index);
    },
    [galleryEntries.media, openImageViewer],
  );

  const renderGalleryItem = useCallback(
    ({ item }: { item: GalleryEntry }) =>
      contentTab === "media" ? (
        <GalleryMediaTile entry={item} onOpen={handleOpenMediaTile} />
      ) : (
        <GalleryListRow
          entry={item}
          accent={resolvedServerAccent}
          nowMs={relativeTimeNow}
          onOpen={handleOpenUrl}
        />
      ),
    [
      contentTab,
      handleOpenMediaTile,
      handleOpenUrl,
      relativeTimeNow,
      resolvedServerAccent,
    ],
  );

  const renderSearchItem = useCallback(
    ({ item }: { item: ThreadMessage }) => (
      <SearchResultRow
        item={item}
        accent={resolvedServerAccent}
        nowMs={relativeTimeNow}
        onJump={handleJumpToMessage}
        isOwn={(item.realUserId || item.userId) === user?.uid}
        isStaffViewer={isStaff(currentUserProfile?.role)}
      />
    ),
    [currentUserProfile?.role, handleJumpToMessage, relativeTimeNow, resolvedServerAccent, user?.uid],
  );

  // Feature 4: the message currently being replied to (snapshot only), shown
  // in the bar above the composer and attached to the next send.
  const [replyingTo, setReplyingTo] = useState<{
    id: string;
    senderName: string;
    preview: string;
    mediaUrl?: string;
    mediaType?: "image" | "video";
    /** Set when replying to your own message, so the bar can say "yourself". */
    isOwn?: boolean;
  } | null>(null);
  const handleSwipeReply = useCallback(
    (messageId: string) => {
      const message = messages.find((entry) => entry.id === messageId);
      if (!message) return;
      const isOwnMsg = (message.realUserId || message.userId) === user?.uid;
      const isStaffUser = isStaff(currentUserProfile?.role);
      const media = replyPreviewMedia(message);
      setReplyingTo({
        id: message.id,
        isOwn: isOwnMsg,
        senderName: message.isAnonymous
          ? anonymousName(message, { isYou: isOwnMsg && isStaffUser })
          : message.username || "User",
        preview: replyPreviewText(message).slice(0, 140),
        ...(media ? { mediaUrl: media.url, mediaType: media.type } : {}),
      });
    },
    [currentUserProfile?.role, messages, user?.uid],
  );
  const clearReply = useCallback(() => setReplyingTo(null), []);

  // Feature 5: place each reader's avatar under the newest message they've
  // read — i.e. the last message whose createdAt is <= their lastReadAtMs.
  const readsByMessageId = useMemo(() => {
    const map = new Map<string, ChannelRead[]>();
    if (reads.length === 0 || messages.length === 0) return map;
    for (const reader of reads) {
      let targetId: string | null = null;
      for (const message of messages) {
        const ms = message.createdAt?.toMillis?.();
        if (typeof ms === "number" && ms <= reader.lastReadAtMs) targetId = message.id;
        else break;
      }
      if (targetId) {
        const list = map.get(targetId);
        if (list) list.push(reader);
        else map.set(targetId, [reader]);
      }
    }
    return map;
  }, [reads, messages]);

  const userAvatarMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of reads) {
      if (r.userId && r.avatarUrl) {
        map.set(r.userId, r.avatarUrl);
      }
    }
    return map;
  }, [reads]);

  // What the list shows: the channel, then any of your messages still
  // uploading in it. They are the newest, so they go at the bottom.
  const displayedMessages = useMemo(() => {
    const stillSending = sendingMessages.filter(
      (message) =>
        message.serverId === resolvedServerId &&
        message.channelId === resolvedChannelId &&
        !messages.some((saved) => saved.id === message.id),
    );
    return stillSending.length > 0 ? [...messages, ...stillSending] : messages;
  }, [messages, resolvedChannelId, resolvedServerId, sendingMessages]);

  // Stable function reference for FlatList's renderItem, paired with
  // MessageBubble now being React.memo'd above. Previously this was an
  // inline arrow function passed directly in JSX, which gets a new
  // identity every render — that's harmless on its own, but it meant the
  // memoized MessageBubble had no way to bail out of re-rendering when an
  // unrelated part of this screen re-rendered (e.g. relativeTimeNow
  // ticking, or an unrelated state update), since a fresh render function
  // was always producing new element instances for every row regardless.
  const renderMessageItem = useCallback(
    ({ item, index }: { item: ThreadMessage; index: number }) => {
      // Grouping only needs the immediate neighbours: this bubble starts a
      // group if the previous message isn't part of the same run, and ends
      // one if the next message isn't.
      const older = displayedMessages[index - 1];
      const newer = displayedMessages[index + 1];
      const timeLabel = needsTimeLabel(item, older)
        ? formatChatTimeLabel(messageMillis(item), relativeTimeNow)
        : null;
      // A time label always starts a new group, so a name and avatar never
      // straddle it.
      const groupedWithPrev = !timeLabel && isSameSenderRun(older, item);
      const groupedWithNext =
        !(newer && needsTimeLabel(newer, item)) && isSameSenderRun(item, newer);
      const authorId = item.realUserId || item.userId;
      const isOwn = authorId === user?.uid;
      // Do not even resolve an anonymous writer's cached profile image. The
      // bubble renders the same generic person icon as comments and replies.
      const liveAvatar = item.isAnonymous
        ? null
        : isOwn
          ? resolveAvatarUri(currentUserProfile)
          : (userAvatarMap.get(authorId) || peekUserData(authorId)?.profileImage || null);
      return (
        <MessageBubble
          item={item}
          isOwnMessage={(item.realUserId || item.userId) === user?.uid}
          accent={resolvedServerAccent}
          onProfilePress={handleProfilePress}
          nowMs={relativeTimeNow}
          isGroupStart={!groupedWithPrev}
          isGroupEnd={!groupedWithNext}
          revealed={item.id === revealedMessageId}
          onToggleReveal={handleToggleReveal}
          currentUserId={user?.uid}
          onLongPress={handleOpenReactionPicker}
          onSetReaction={handleSetReaction}
          onSwipeReply={handleSwipeReply}
          onReplyPress={handleJumpToMessage}
          onOpenImage={openImageViewer}
          onOpenUrl={handleOpenUrl}
          readers={readsByMessageId.get(item.id) ?? EMPTY_READERS}
          pinned={item.pinned === true}
          showFullText={isStaffOnly || item.pinned === true}
          timeLabel={timeLabel}
          canVotePolls={canVotePolls}
          onPollVote={handlePollVote}
          onAddPollOption={handleAddPollOption}
          liveAvatarUri={liveAvatar}
          isStaffViewer={isStaff(currentUserProfile?.role)}
        />
      );
    },
    [
      displayedMessages,
      readsByMessageId,
      currentUserProfile,
      userAvatarMap,
      handleProfilePress,
      handleToggleReveal,
      handleOpenReactionPicker,
      handleSetReaction,
      handleSwipeReply,
      handleJumpToMessage,
      openImageViewer,
      handleOpenUrl,
      isStaffOnly,
      canVotePolls,
      handlePollVote,
      handleAddPollOption,
      relativeTimeNow,
      resolvedServerAccent,
      revealedMessageId,
      user?.uid,
    ],
  );

  // Task 3: renderItem for the "Pinned messages" sheet, paired with the
  // React.memo'd PinnedMessageRow.
  const renderPinnedItem = useCallback(
    ({ item }: { item: ThreadMessage }) => {
      const authorId = item.realUserId || item.userId;
      const isOwn = authorId === user?.uid;
      const liveAvatar = isOwn
        ? resolveAvatarUri(currentUserProfile)
        : (userAvatarMap.get(authorId) || peekUserData(authorId)?.profileImage || null);
      return (
        <PinnedMessageRow
          item={item}
          accent={resolvedServerAccent}
          nowMs={relativeTimeNow}
          onOpenContent={handleOpenPinnedContent}
          onJumpToMessage={handleJumpToMessage}
          liveAvatarUri={liveAvatar}
          isOwn={isOwn}
          isStaffViewer={isStaff(currentUserProfile?.role)}
        />
      );
    },
    [
      currentUserProfile,
      handleJumpToMessage,
      handleOpenPinnedContent,
      relativeTimeNow,
      resolvedServerAccent,
      user?.uid,
      userAvatarMap,
    ],
  );

  const handleSend = useCallback(
    async (messageData: any, attachments: ComposerAttachments) => {
      if (!user?.uid || !resolvedServerId || !resolvedChannelId) return false;
      if (isOffline) {
        showInfo("No Connection", "You need internet access to send a message.");
        return false;
      }

      // Nobody is anonymous in a Staff only channel.
      const isAnon = messageData.isAnonymous === true && !staffChannelHere;
      const isStaffUser = isStaff(currentUserProfile?.role);
      const authorUsername = isAnon
        ? (isStaffUser ? "Anonymous (You)" : "Anonymous")
        : (messageData.username || currentUserProfile?.firstname || "Someone");

      // Anonymous messages carry the writer's permanent anonymous name.
      const anonymousHandle = isAnon ? await getMyAnonymousHandle() : null;
      const draftPayload = {
        ...messageData,
        userId: user.uid,
        realUserId: user.uid,
        isAnonymous: isAnon,
        ...(anonymousHandle ? { anonymousHandle } : {}),
        username: isAnon ? anonymousHandle || "Anonymous" : authorUsername,
        profilePic:
          isAnon ? null : resolveAvatarUri(messageData) || resolveAvatarUri(currentUserProfile),
        profileImage:
          isAnon ? null : resolveAvatarUri(messageData) || resolveAvatarUri(currentUserProfile),
        serverId: resolvedServerId,
        channelId: resolvedChannelId,
        createdAt: serverTimestamp(),
        // Students' messages start pending for the Worker; staff messages
        // start approved, since the Worker would only approve them unread.
        ...initialModerationFields(isStaffUser),
        // Feature 4: attach the reply snapshot if one is active. The create
        // rule allows extra fields, so no rules change is needed here.
        ...(replyingTo ? { replyTo: replyingTo } : {}),
      };
      // B.E.A. writes its replies where everyone's messages live, so it
      // doesn't answer in a Staff only channel.
      const shouldTriggerAi =
        !staffChannelHere &&
        (messageData.taggedUsers || []).some((tag: TaggedUser) => isAiAssistantId(tag.id));

      // Clear the reply bar now; it comes back if the message can't be saved.
      const activeReplyingTo = replyingTo;
      setReplyingTo(null);

      // The id is picked up front, so the copy shown while attachments upload
      // and the saved message are the same row.
      const messageRef = doc(collection(db, messageCollection));
      const undoSend = () => {
        setSendingMessages((prev) => prev.filter((message) => message.id !== messageRef.id));
        setReplyingTo(activeReplyingTo);
      };

      // Feature 6: sending ends the current typing burst.
      stopTyping();
      userScrolledUpRef.current = false;
      isNearBottomRef.current = true;
      setShowScrollToBottom(false);
      if (attachments.local.length > 0) {
        // Text on its own already appears at once from Firestore's local
        // write. Photos would wait for their upload, so show them from the
        // phone meanwhile.
        setSendingMessages((prev) => [
          ...prev,
          {
            ...draftPayload,
            id: messageRef.id,
            files: attachments.local,
            createdAt: new Date(),
            sending: true,
          },
        ]);
      }

      const files = await attachments.upload().catch((error) => {
        undoSend();
        throw error;
      });
      const payload = { ...draftPayload, files };
      await setDoc(messageRef, payload).catch((error) => {
        undoSend();
        throw error;
      });
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });

      // The message is saved, so the composer can clear and take the next one
      // now. Moderation, mention notifications and the AI reply still run for
      // every message, exactly as before; they just no longer hold up the text
      // box.
      void (async () => {
        let moderationDecision;
        try {
          // Staff messages (every one in a Staff only channel) skip the queue.
          moderationDecision = await moderateNewContent(isStaffUser || staffChannelHere, {
            collectionName: "communityThreadMessages",
            documentId: messageRef.id,
            scope: "thread",
          });
        } catch (error) {
          console.warn("[ServerChannel] OpenModeration unavailable; message remains pending:", error);
          showInfo(
            "Message Pending Review",
            "Automatic moderation is temporarily unavailable. Your message will remain hidden until a reviewer checks it.",
          );
          return;
        }

        if (moderationDecision.selfHarm === true) {
          setSafetyVisible(true);
          return;
        }
        const mentionRecipientIds = (messageData.taggedUsers || [])
          .map((tag: TaggedUser) => tag.id)
          .filter((recipientId: string) => !isAiAssistantId(recipientId));

        if (moderationDecision.status === "approved") {
          // Mention notifications are a "nice to have" side effect of this send,
          // not something the AI reply should depend on. If notifying a tagged
          // student fails for any reason, we log it and move on — previously an
          // error here would throw out of handleSend entirely, silently
          // skipping the AI-trigger check below it whenever @ai was tagged
          // alongside a real student.
          try {
            const mentionTargets = await resolveMentionRecipientIds({
              taggedUserIds: mentionRecipientIds,
              actorId: user.uid,
              serverId: resolvedServerId,
            });
            // Task 4B: drop anyone who has muted this channel — no notification
            // doc is created for them, which stops both the in-app entry and
            // the push it would trigger. Purely per-recipient; everyone else
            // still gets notified normally.
            const muterIds = await fetchChannelMuterIds(
              resolvedChannelId,
              mentionTargets,
            );
            await createMentionNotifications({
              recipientIds: mentionTargets.filter((id) => !muterIds.has(id)),
              actor: {
                id: user.uid,
                name: messageData.username || currentUserProfile?.firstname || "Someone",
                profileImage:
                  messageData.isAnonymous === true
                    ? null
                    : resolveAvatarUri(currentUserProfile),
                isAnonymous: messageData.isAnonymous,
              },
              // Not "comment": this is a channel message, and filing it as a
              // comment made the push read "mentioned you in a comment" while
              // discarding the channel name written just below.
              entityType: "thread_message",
              entityId: messageRef.id,
              parentId: resolvedServerId,
              // Without the channel, a tapped mention can only find the server
              // and has nowhere to open.
              channelId: resolvedChannelId,
              message: `mentioned you in #${resolvedChannelLabel}`,
              preview: messageData.text,
            });
          } catch (error) {
            console.error("Mention notification failed:", error);
          }
        }

        if (!shouldTriggerAi || moderationDecision.status === "pending") {
          if (moderationDecision.status === "pending") {
            showInfo(
              "Message Pending Review",
              "This message was flagged and is waiting for reviewer approval.",
            );
          }
          return;
        }

        const contextMessages = buildAiContextMessages(messages, {
          ...payload,
          username: messageData.username,
        });
        const aiPrompt = summarizeThreadMessage(payload);

        void (async () => {
          const cooldown = await reserveAiCooldown(
            resolvedServerId,
            resolvedChannelId,
            AI_REQUEST_COOLDOWN_MS,
          );

          if (!cooldown.allowed) {
            showInfo(
              "AI Cooling Down",
              `${AI_ASSISTANT_NAME} can be called again in ${formatCooldownLabel(cooldown.remainingMs)}.`,
            );
            return;
          }

          const pendingReplyRef = await addDoc(collection(db, "communityThreadMessages"), {
            text: "",
            userId: AI_ASSISTANT_ID,
            realUserId: AI_ASSISTANT_ID,
            username: AI_ASSISTANT_NAME,
            role: "assistant",
            profileImage: null,
            profilePic: null,
            isAnonymous: false,
            taggedUsers: [],
            files: [],
            link: null,
            serverId: resolvedServerId,
            channelId: resolvedChannelId,
            aiAssistant: true,
            aiStatus: "processing",
            aiSourceMessageId: messageRef.id,
            moderationStatus: "approved",
            moderationReasons: [],
            createdAt: serverTimestamp(),
          });

          const { reply } = await requestAiReplyFromWorker({
            serverId: resolvedServerId,
            channelId: resolvedChannelId,
            sourceMessageId: messageRef.id,
            sourceUserId: user.uid,
            prompt: aiPrompt,
            contextMessages,
          });

          await updateDoc(doc(db, "communityThreadMessages", pendingReplyRef.id), {
            text: reply,
            aiStatus: "completed",
          });
        })().catch((error) => {
          console.error("AI assistant request failed:", error);
          showInfo(
            "AI Unavailable",
            getAiErrorMessage(error),
          );
        });
      })().catch((error) => {
        console.error("[ServerChannel] After-send steps failed:", error);
      });

      return true;
    },
    [
      currentUserProfile?.firstname,
      currentUserProfile?.profileImage,
      currentUserProfile?.profilePic,
      currentUserProfile?.role,
      isOffline,
      messages,
      replyingTo,
      resolvedChannelId,
      resolvedChannelLabel,
      resolvedServerId,
      messageCollection,
      staffChannelHere,
      stopTyping,
      user?.uid,
    ],
  );

  // A poll is posted like any message — same moderation, same storage for
  // the channel — with the poll attached and no answers yet.
  const [pollSheetOpen, setPollSheetOpen] = useState(false);
  const handleCreatePoll = useCallback(
    async (draft: PollDraft) => {
      const poll = buildChannelPoll(draft, Date.now());
      const name =
        `${currentUserProfile?.firstname || ""} ${currentUserProfile?.lastname || ""}`.trim() ||
        String(currentUserProfile?.username || user?.displayName || "").trim() ||
        "User";
      const sent = await handleSend(
        {
          text: pollMessageText(poll),
          username: name,
          role: currentUserProfile?.role || "student",
          isAnonymous: false,
          taggedUsers: [],
          poll,
          pollVoters: {},
        },
        prepareComposerAttachments([], null),
      );
      return sent !== false;
    },
    [currentUserProfile, handleSend, user?.displayName],
  );

  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        // Mirrors the original onMoveShouldSetPanResponder gate: only
        // capture drags that are meaningfully downward and more vertical
        // than horizontal, so horizontal scrolling/swiping elsewhere isn't
        // affected.
        .activeOffsetY(12)
        .failOffsetX([-20, 20])
        .onUpdate((event) => {
          if (event.translationY > 0) {
            translateY.value = event.translationY;
            overlayOpacity.value = Math.max(0.4, 1 - event.translationY / SCREEN_HEIGHT);
          }
        })
        .onEnd((event) => {
          // RNGH reports velocity in px/s, whereas the old PanResponder's
          // vy was roughly px/ms — 0.8 px/ms ≈ 800 px/s, same threshold.
          if (event.translationY > 130 || event.velocityY > 800) {
            runOnJS(closeToDrawer)();
            return;
          }

          translateY.value = withSpring(0, { damping: 20, stiffness: 220 });
          overlayOpacity.value = withTiming(1, { duration: 180 });
        }),
    [closeToDrawer],
  );

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View style={styles.root}>
      <ReanimatedAnimated.View style={[styles.backdrop, backdropAnimatedStyle]} />
      <ReanimatedAnimated.View
        style={[
          styles.sheet,
          {
            paddingTop: insets.top,
            paddingBottom: Math.max(insets.bottom, 12),
          },
          sheetAnimatedStyle,
        ]}
      >
        <SafeAreaView style={styles.container} edges={["left", "right"]}>
          <GestureDetector gesture={dragGesture}>
            <View style={styles.dragZone}>
              <View style={styles.dragHandle} />
              <Text style={styles.dragText}>Swipe down to return to the drawer</Text>
            </View>
          </GestureDetector>

          <View style={[styles.header, { borderBottomColor: `${resolvedServerAccent}55` }]}>
            <View style={styles.headerCopy}>
              <Text style={styles.serverName} numberOfLines={1}>{resolvedServerName}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Ionicons
                  name={getChannelIcon(channelType) as any}
                  size={15}
                  color={resolvedServerAccent}
                />
                <Text style={styles.channelName} numberOfLines={1}>#{resolvedChannelLabel}</Text>
                {(isStaffOnly || staffChannelHere) && (
                  <Ionicons name="lock-closed" size={12} color={theme.textMuted} />
                )}
              </View>
            </View>

            <View style={styles.headerActions}>
              {/* Task 5: media / files / links gallery + in-channel search. */}
              <TouchableOpacity
                style={[styles.headerIconButton, { borderColor: `${resolvedServerAccent}55` }]}
                onPress={openContentSheet}
                activeOpacity={0.82}
                accessibilityLabel="Browse channel media, files, links and search"
              >
                <Ionicons name="albums-outline" size={17} color={resolvedServerAccent} />
              </TouchableOpacity>

              {/* Task 3: open the list of everything pinned in this channel. */}
              <TouchableOpacity
                style={[styles.headerIconButton, { borderColor: `${resolvedServerAccent}55` }]}
                onPress={() => setPinnedListVisible(true)}
                activeOpacity={0.82}
                accessibilityLabel="View pinned messages"
              >
                <Ionicons name="pin" size={17} color={resolvedServerAccent} />
                {pinnedMessages.length > 0 && (
                  <View style={[styles.headerIconBadge, { backgroundColor: resolvedServerAccent }]}>
                    <Text style={styles.headerIconBadgeText}>
                      {pinnedMessages.length > 99 ? "99+" : pinnedMessages.length}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>

              {/* Task 4B: mute / unmute this channel's notifications for me. */}
              <TouchableOpacity
                style={[styles.headerIconButton, { borderColor: `${resolvedServerAccent}55` }]}
                onPress={handleToggleChannelMute}
                activeOpacity={0.82}
                accessibilityLabel={
                  channelMuted ? "Unmute this channel" : "Mute this channel"
                }
              >
                <Ionicons
                  name={channelMuted ? "notifications-off" : "notifications-outline"}
                  size={17}
                  color={channelMuted ? theme.textMuted : resolvedServerAccent}
                />
              </TouchableOpacity>

              {canManageChannel && (
                <TouchableOpacity
                  style={[styles.headerIconButton, { borderColor: `${resolvedServerAccent}55` }]}
                  onPress={handleOpenEditChannel}
                  activeOpacity={0.82}
                  accessibilityLabel="Edit channel settings"
                >
                  <Ionicons name="settings-outline" size={17} color={resolvedServerAccent} />
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={[styles.closeButton, { backgroundColor: resolvedServerAccent }]}
                onPress={closeToDrawer}
                activeOpacity={0.82}
              >
                <Ionicons name="close" size={18} color={theme.onPrimary} />
              </TouchableOpacity>
            </View>
          </View>
          {isOffline && (
            <View style={styles.offlineStatusBar}>
              <Ionicons name="cloud-offline-outline" size={14} color="#9a3412" />
              <Text style={styles.offlineStatusText}>
                Offline mode
              </Text>
            </View>
          )}
          {/* Collaborative: what's been shared, one tap from the Files & Media view. */}
          {channelType === "media" && !staffChannelBlocked && (
            <TouchableOpacity
              style={[styles.sharedFilesBar, { borderColor: `${resolvedServerAccent}40` }]}
              onPress={openContentSheet}
              activeOpacity={0.82}
              accessibilityRole="button"
              accessibilityLabel="Open shared files"
            >
              <Ionicons name="folder-open-outline" size={16} color={resolvedServerAccent} />
              <Text style={styles.sharedFilesText} numberOfLines={1}>
                {countLabel(galleryEntries.media.length, "photo")} ·{" "}
                {countLabel(galleryEntries.files.length, "file")} ·{" "}
                {countLabel(galleryEntries.links.length, "link")}
              </Text>
              <Text style={[styles.sharedFilesOpen, { color: resolvedServerAccent }]}>Open</Text>
            </TouchableOpacity>
          )}
          {staffChannelBlocked ? (
            <View style={styles.noAccess}>
              <Ionicons name="lock-closed-outline" size={40} color={theme.textMuted} />
              <Text style={styles.noAccessTitle}>Staff only</Text>
              <Text style={styles.noAccessText}>
                This channel is for admins, moderators and teachers.
              </Text>
            </View>
          ) : (
          <FlatList
            ref={listRef}
            data={displayedMessages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessageItem}
            // Same virtualization approach as HomeScreen's feed: message
            // bubbles can include images/attachments, so keep the render
            // window modest rather than RN's default (~21 screens) and let
            // far-off-screen rows unmount on Android to free memory.
            initialNumToRender={14}
            maxToRenderPerBatch={8}
            windowSize={5}
            updateCellsBatchingPeriod={30}
            removeClippedSubviews={Platform.OS === "android"}
            contentContainerStyle={[
              styles.listContent,
              // Center the real empty state ("Kick off #channel"), but let the
              // loading skeleton sit top-aligned like real messages would.
              displayedMessages.length === 0 && (!loading || isOffline) && styles.emptyListContent,
            ]}
            ListEmptyComponent={
              loading && !isOffline ? (
                <ChatSkeleton count={7} />
              ) : (
                <View style={styles.emptyState}>
                  <Ionicons
                    name="sparkles-outline"
                    size={56}
                    color={resolvedServerAccent}
                  />
                  <Text style={styles.emptyTitle}>Kick off #{resolvedChannelLabel}</Text>
                </View>
              )
            }
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={100}
            onScrollBeginDrag={handleScrollBeginDrag}
            onContentSizeChange={handleContentSizeChange}
            onScroll={(event) => {
              const { layoutMeasurement, contentOffset, contentSize } =
                event.nativeEvent;
              const distanceFromBottom =
                contentSize.height - contentOffset.y - layoutMeasurement.height;

              const nearBottom = distanceFromBottom < 100;
              isNearBottomRef.current = nearBottom;

              if (nearBottom) {
                userScrolledUpRef.current = false;
                setShowScrollToBottom(false);
                const newestMs =
                  messages[messages.length - 1]?.createdAt?.toMillis?.() ?? 0;
                if (newestMs) markRead(newestMs);
              } else if (distanceFromBottom > 200 && userScrolledUpRef.current) {
                setShowScrollToBottom(true);
              }
            }}
            onScrollToIndexFailed={(info) => {
              // Task 3: "jump to pinned message" can target a row that isn't
              // measured yet. Approximate the offset, then settle exactly.
              listRef.current?.scrollToOffset({
                offset: info.averageItemLength * info.index,
                animated: true,
              });
              setTimeout(() => {
                try {
                  listRef.current?.scrollToIndex({
                    index: info.index,
                    animated: true,
                    viewPosition: 0.3,
                  });
                } catch {
                  // give up quietly — the approximate offset above is close enough
                }
              }, 280);
            }}
          />
          )}

          {showScrollToBottom && !staffChannelBlocked && (
            <TouchableOpacity
              style={[
                styles.scrollToBottomBtn,
                // The reply bar grows the composer, and at the fixed offset
                // this button landed on top of it.
                replyingTo && styles.scrollToBottomBtnRaised,
              ]}
              onPress={scrollToBottom}
              activeOpacity={0.85}
              accessibilityLabel="Scroll to latest messages"
            >
              <Ionicons name="chevron-down" size={20} color={theme.primary} />
            </TouchableOpacity>
          )}

          {typingNames.length > 0 && (
            // Feature 6: small animated "X is typing…" line, between the last
            // message and the composer, Messenger-style.
            <View style={styles.typingIndicator}>
              <TypingDots color={resolvedServerAccent} />
              <Text style={styles.typingIndicatorText} numberOfLines={1}>
                {typingSentence(typingNames)}
              </Text>
            </View>
          )}

          {currentUserProfile && !staffChannelBlocked && (
            canPostInChannel ? (
              <ReanimatedAnimated.View style={[styles.composerShell, composerAnimatedStyle]}>
                {staffChannelHere && (
                  <View style={styles.staffChannelNote}>
                    <Ionicons name="lock-closed" size={12} color={theme.textMuted} />
                    <Text style={styles.staffChannelNoteText}>Only staff can see this channel.</Text>
                  </View>
                )}
                {replyingTo && (
                  // Feature 4: "replying to …" bar. X clears it.
                  <View style={styles.replyBar}>
                    <View style={[styles.replyQuoteBar, { backgroundColor: resolvedServerAccent }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.replyBarName} numberOfLines={1}>
                        {replyingTo.isOwn
                          ? "Replying to yourself"
                          : `Replying to ${replyingTo.senderName}`}
                      </Text>
                      <Text style={styles.replyBarPreview} numberOfLines={1}>
                        {replyingTo.preview}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={clearReply}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      accessibilityLabel="Cancel reply"
                    >
                      <Ionicons name="close" size={18} color={theme.textSecondary} />
                    </TouchableOpacity>
                  </View>
                )}
                <ServerMessageComposer
                  currentUser={currentUserProfile}
                  onSend={handleSend}
                  onTypingChange={handleTyping}
                  placeholder={`Message #${resolvedChannelLabel}`}
                  staffOnly={staffChannelHere}
                  onCreatePoll={() => setPollSheetOpen(true)}
                  replyingTo={
                    replyingTo
                      ? {
                          id: replyingTo.id,
                          name: replyingTo.isOwn ? "yourself" : replyingTo.senderName,
                          text: replyingTo.preview,
                        }
                      : null
                  }
                  onCancelReply={clearReply}
                  showReplyBar={false}
                />
              </ReanimatedAnimated.View>
            ) : (
              <View style={styles.readOnlyBanner}>
                <View style={[styles.readOnlyIconWrap, { backgroundColor: `${resolvedServerAccent}18` }]}>
                  <Ionicons name="lock-closed" size={16} color={resolvedServerAccent} />
                </View>
                <Text style={styles.readOnlyText}>
                  Only staff can post in #{resolvedChannelLabel}. You can react to messages and forward them.
                </Text>
              </View>
            )
          )}
        </SafeAreaView>
      </ReanimatedAnimated.View>

      <ChannelPollSheet
        visible={pollSheetOpen}
        channelLabel={resolvedChannelLabel || "channel"}
        accent={resolvedServerAccent}
        onClose={() => setPollSheetOpen(false)}
        onSubmit={handleCreatePoll}
      />

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

      <SafetyDialog
        visible={safetyVisible}
        onClose={() => setSafetyVisible(false)}
        contentLabel="message"
      />

      {/* Feature 3: reaction picker — a small centred popover of the default
          emoji set, opened by long-pressing a message. The emoji you're
          already reacting with is highlighted; tapping it again clears it.
          Task 3 adds a Pin / Unpin row; Task 4A adds Edit / Delete for the
          message's own author. Tap outside to close. */}
      <Modal
        visible={!!reactionTargetId}
        transparent
        animationType="fade"
        onRequestClose={() => setReactionTargetId(null)}
      >
        <Pressable
          style={styles.reactionPickerOverlay}
          onPress={() => setReactionTargetId(null)}
        >
          <View style={styles.reactionPickerCard}>
            <View style={styles.reactionPickerEmojiRow}>
              {REACTION_EMOJIS.map((emoji) => {
                const active =
                  getMyReaction(reactionTargetMessage, user?.uid) === emoji;
                return (
                  <Pressable
                    key={emoji}
                    style={[
                      styles.reactionPickerButton,
                      active && styles.reactionPickerButtonActive,
                    ]}
                    onPress={() => {
                      if (reactionTargetId) handleSetReaction(reactionTargetId, emoji);
                      setReactionTargetId(null);
                    }}
                  >
                    <Text style={styles.reactionPickerEmoji}>{emoji}</Text>
                  </Pressable>
                );
              })}
            </View>

            {reactionTargetMessage && (
              <Pressable
                style={styles.reactionPickerAction}
                onPress={() => {
                  const targetId = reactionTargetMessage.id;
                  setReactionTargetId(null);
                  setTimeout(() => handleSwipeReply(targetId), 180);
                }}
              >
                <Ionicons name="arrow-undo-outline" size={17} color={theme.primary} />
                <Text style={styles.reactionPickerActionText}>Reply</Text>
              </Pressable>
            )}

            {canPinMessages && reactionTargetId && (
              <Pressable
                style={styles.reactionPickerAction}
                onPress={() => {
                  handleTogglePin(reactionTargetId);
                  setReactionTargetId(null);
                }}
              >
                <Ionicons
                  name={reactionTargetMessage?.pinned ? "pin" : "pin-outline"}
                  size={17}
                  color={theme.primary}
                />
                <Text style={styles.reactionPickerActionText}>
                  {reactionTargetMessage?.pinned ? "Unpin message" : "Pin message"}
                </Text>
              </Pressable>
            )}

            {reactionTargetMessage?.poll &&
              !pollIsClosed(reactionTargetMessage.poll, relativeTimeNow) &&
              ((reactionTargetMessage.realUserId || reactionTargetMessage.userId) === user?.uid ||
                canManageChannel) && (
                <Pressable
                  style={styles.reactionPickerAction}
                  onPress={() => {
                    const targetId = reactionTargetMessage.id;
                    setReactionTargetId(null);
                    setTimeout(() => confirmEndPoll(targetId), 180);
                  }}
                >
                  <Ionicons name="stop-circle-outline" size={17} color={theme.primary} />
                  <Text style={styles.reactionPickerActionText}>End poll now</Text>
                </Pressable>
              )}

            {/* A forwarded copy would lose the poll, so polls aren't forwarded. */}
            {reactionTargetMessage && !reactionTargetMessage.poll && (
              <Pressable
                style={styles.reactionPickerAction}
                onPress={() => {
                  const target = reactionTargetMessage;
                  setReactionTargetId(null);
                  setTimeout(() => {
                    setForwardTargetMessage(target);
                    setForwardSearchQuery("");
                    setForwardStatusMap({});
                    setForwardModalVisible(true);
                  }, 180);
                }}
              >
                <Ionicons name="arrow-redo-outline" size={17} color={theme.primary} />
                <Text style={styles.reactionPickerActionText}>Forward message</Text>
              </Pressable>
            )}

            {canReportMessage(reactionTargetMessage) && (
              <Pressable
                style={styles.reactionPickerAction}
                onPress={() => {
                  const target = reactionTargetMessage;
                  setReactionTargetId(null);
                  // Let this modal dismiss before the confirm dialog opens.
                  setTimeout(() => {
                    if (target) confirmReportMessage(target);
                  }, 180);
                }}
              >
                <Ionicons name="flag-outline" size={17} color="#a12a1a" />
                <Text
                  style={[styles.reactionPickerActionText, styles.reactionPickerActionDanger]}
                >
                  Report message
                </Text>
              </Pressable>
            )}

            {reactionTargetMessage && reactionTargetIsOwn && (
                <>
                  {isWithinEditWindow(reactionTargetMessage) && !reactionTargetMessage.poll && (
                    <Pressable
                      style={styles.reactionPickerAction}
                      onPress={() => {
                        const target = reactionTargetMessage;
                        setReactionTargetId(null);
                        // Defer so this modal dismisses before the editor
                        // modal presents (iOS drops an overlapping present).
                        setTimeout(() => openMessageEditor(target), 180);
                      }}
                    >
                      <Ionicons name="create-outline" size={17} color={theme.primary} />
                      <Text style={styles.reactionPickerActionText}>Edit message</Text>
                    </Pressable>
                  )}
                  <Pressable
                    style={styles.reactionPickerAction}
                    onPress={() => {
                      const target = reactionTargetMessage;
                      setReactionTargetId(null);
                      // Let this (transparent) modal finish dismissing before
                      // presenting the ConfirmDialog modal — presenting one
                      // while another is mid-dismiss can be dropped on iOS.
                      setTimeout(() => confirmDeleteMessage(target), 180);
                    }}
                  >
                    <Ionicons name="trash-outline" size={17} color="#a12a1a" />
                    <Text
                      style={[styles.reactionPickerActionText, styles.reactionPickerActionDanger]}
                    >
                      {reactionTargetMessage.replyTo ? "Delete reply" : "Delete message"}
                    </Text>
                  </Pressable>
                </>
              )}

            {reactionTargetMessage && canDeleteReactionTarget && !reactionTargetIsOwn && (
              <Pressable
                style={styles.reactionPickerAction}
                onPress={() => {
                  const target = reactionTargetMessage;
                  setReactionTargetId(null);
                  // Let this modal dismiss before presenting ConfirmDialog.
                  setTimeout(() => confirmDeleteMessage(target), 180);
                }}
              >
                <Ionicons name="trash-outline" size={17} color="#a12a1a" />
                <Text
                  style={[styles.reactionPickerActionText, styles.reactionPickerActionDanger]}
                >
                  {reactionTargetMessage.replyTo ? "Delete reply" : "Delete message"}
                </Text>
              </Pressable>
            )}
          </View>
        </Pressable>
      </Modal>

      {/* Task 4A: inline text editor for your own message. A focused text box
          styled like the composer, prefilled with the current text. Text-only
          — attachments/links on the message are left untouched. */}
      <Modal
        visible={!!editingMessageId}
        transparent
        animationType="fade"
        onRequestClose={cancelMessageEdit}
      >
        <View style={styles.editOverlay}>
          <View style={styles.editCard}>
            <Text style={styles.editTitle}>Edit message</Text>
            <TextInput
              style={styles.editInput}
              value={editingText}
              onChangeText={setEditingText}
              multiline
              autoFocus
              placeholder="Message"
              placeholderTextColor="#b9a49b"
              maxLength={4000}
            />
            <View style={styles.editActions}>
              <TouchableOpacity
                style={styles.editButtonGhost}
                onPress={cancelMessageEdit}
                activeOpacity={0.82}
              >
                <Text style={styles.editButtonGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.editButtonPrimary, savingEdit && styles.editButtonDisabled]}
                onPress={saveMessageEdit}
                activeOpacity={0.82}
                disabled={savingEdit}
              >
                <Text style={styles.editButtonPrimaryText}>
                  {savingEdit ? "Saving…" : "Save"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Task 3: Pinned messages sheet — everything currently pinned in this
          channel, newest first, with a tap-to-open action and a jump-to-thread
          button. Virtualized since a channel can accumulate many pins. */}
      <DragToCloseSheet
        visible={pinnedListVisible}
        onClose={closePinnedList}
        handleColor={theme.textMuted}
        closeLabel="Close pinned messages"
        sheetStyle={[
          styles.pinnedSheet,
          styles.draggableSheet,
          { paddingBottom: Math.max(insets.bottom, 16) },
        ]}
        header={
          <View style={styles.pinnedSheetHeader}>
            <Ionicons name="pin" size={16} color={resolvedServerAccent} />
            <Text style={styles.pinnedSheetTitle} numberOfLines={1}>
              Pinned in #{resolvedChannelLabel}
            </Text>
            <TouchableOpacity
              onPress={() => setPinnedListVisible(false)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityLabel="Close pinned messages"
            >
              <Ionicons name="close" size={20} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>
        }
      >
        <FlatList
          data={pinnedMessages}
          keyExtractor={(item) => item.id}
          renderItem={renderPinnedItem}
          // Bounded height so the list scrolls inside the auto-height sheet
          // rather than pushing it past its maxHeight.
          style={styles.pinnedList}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={9}
          removeClippedSubviews={Platform.OS === "android"}
          contentContainerStyle={
            pinnedMessages.length === 0
              ? styles.pinnedEmptyContent
              : styles.pinnedListContent
          }
          ListEmptyComponent={
            <View style={styles.pinnedEmptyState}>
              <Ionicons name="pin-outline" size={40} color="#c9b0a8" />
              <Text style={styles.pinnedEmptyText}>Nothing pinned yet</Text>
            </View>
          }
          showsVerticalScrollIndicator={false}
        />
      </DragToCloseSheet>

      {/* Task 5: channel content sheet — Media / Files / Links gallery (auto,
          from every message ever shared here) plus a lightweight in-channel
          search over the messages currently loaded. */}
      <DragToCloseSheet
        visible={contentSheetVisible}
        onClose={closeContentSheet}
        handleColor={theme.textMuted}
        closeLabel="Close channel media"
        sheetStyle={[
          styles.pinnedSheet,
          styles.draggableSheet,
          { paddingBottom: Math.max(insets.bottom, 16) },
        ]}
        header={
          <View style={styles.pinnedSheetHeader}>
            <Ionicons name="albums-outline" size={16} color={resolvedServerAccent} />
            <Text style={styles.pinnedSheetTitle} numberOfLines={1}>
              #{resolvedChannelLabel}
            </Text>
            <TouchableOpacity
              onPress={() => setContentSheetVisible(false)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={20} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>
        }
      >

        <View style={styles.segmentRow}>
          {(
            [
              ["media", "Media"],
              ["files", "Files"],
              ["links", "Links"],
              ["search", "Search"],
            ] as [ContentTab, string][]
          ).map(([tab, label]) => (
            <TouchableOpacity
              key={tab}
              style={[styles.segment, contentTab === tab && styles.segmentActive]}
              onPress={() => selectContentTab(tab)}
              activeOpacity={0.85}
            >
              <Text
                style={[
                  styles.segmentText,
                  contentTab === tab && styles.segmentTextActive,
                ]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {contentTab === "search" ? (
          <>
            <View style={styles.searchInputWrap}>
              <Ionicons name="search" size={16} color={theme.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search this channel"
                placeholderTextColor="#b9a49b"
                autoFocus
                returnKeyType="search"
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity
                  onPress={() => setSearchQuery("")}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close-circle" size={16} color="#b9a49b" />
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.searchScopeNote}>
              Searching messages loaded in this channel — not the full history.
            </Text>
            <FlatList
              key="search"
              data={searchResults}
              keyExtractor={(item) => item.id}
              renderItem={renderSearchItem}
              style={styles.galleryList}
              initialNumToRender={12}
              maxToRenderPerBatch={10}
              windowSize={9}
              removeClippedSubviews={Platform.OS === "android"}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={
                searchResults.length === 0
                  ? styles.pinnedEmptyContent
                  : styles.pinnedListContent
              }
              ListEmptyComponent={
                <View style={styles.contentEmptyState}>
                  <Ionicons
                    name="search-outline"
                    size={56}
                    color="#c9b0a8"
                  />
                  <Text style={styles.contentEmptyText}>
                    {searchQuery.trim().length < SEARCH_MIN_CHARS
                      ? "Type at least two characters to search."
                      : "No matches in the loaded messages."}
                  </Text>
                </View>
              }
              showsVerticalScrollIndicator={false}
            />
          </>
        ) : (
          <FlatList
            key={contentTab}
            data={activeGalleryEntries.slice(0, galleryVisibleCount)}
            keyExtractor={(item) => item.key}
            renderItem={renderGalleryItem}
            style={styles.galleryList}
            numColumns={contentTab === "media" ? 3 : 1}
            initialNumToRender={contentTab === "media" ? 18 : 12}
            maxToRenderPerBatch={contentTab === "media" ? 18 : 10}
            windowSize={9}
            removeClippedSubviews={Platform.OS === "android"}
            contentContainerStyle={
              activeGalleryEntries.length === 0
                ? styles.pinnedEmptyContent
                : styles.pinnedListContent
            }
            ListEmptyComponent={
              <View style={styles.contentEmptyState}>
                <Ionicons name="albums-outline" size={40} color="#c9b0a8" />
                <Text style={styles.contentEmptyText}>
                  {contentTab === "media"
                    ? "No photos or GIFs shared here yet."
                    : contentTab === "files"
                      ? "No files shared here yet."
                      : "No links shared here yet."}
                </Text>
              </View>
            }
            ListFooterComponent={
              galleryVisibleCount < activeGalleryEntries.length ? (
                <TouchableOpacity
                  style={styles.loadMoreButton}
                  onPress={() =>
                    setGalleryVisibleCount((count) => count + GALLERY_PAGE_SIZE)
                  }
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name="chevron-down-circle-outline"
                    size={17}
                    color={theme.primary}
                  />
                  <Text style={styles.loadMoreText}>Load more</Text>
                </TouchableOpacity>
              ) : (
                <View style={{ height: 16 }} />
              )
            }
            showsVerticalScrollIndicator={false}
          />
        )}
      </DragToCloseSheet>

      {/* ── Channel Settings / Edit Modal ─────────────────────────────── */}
      <Modal
        visible={editChannelModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setEditChannelModalVisible(false)}
      >
        <View style={styles.channelSettingsModalOverlay}>
          <View style={styles.channelSettingsModalCard}>
            <View style={styles.channelSettingsModalHeader}>
              <View>
                <Text style={styles.channelSettingsModalTitle}>Edit Channel</Text>
                <Text style={styles.channelSettingsModalSubtitle}>#{resolvedChannelLabel}</Text>
              </View>
              <TouchableOpacity
                onPress={() => setEditChannelModalVisible(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.channelSettingsFieldLabel}>Channel Type</Text>
            <View style={styles.channelSettingsTypeGrid}>
              {CHANNEL_TYPE_OPTIONS.filter((option) =>
                // A channel can't move into or out of Staff only: its messages
                // are kept apart, so they'd be left behind, or left where
                // students could reach them.
                staffChannelHere ? option.type === "staff" : option.type !== "staff",
              ).map(({ type: typeKey, title, icon: iconName, emoji: defaultEmoji, hint }) => {
                const isSelected = editChannelType === typeKey;
                return (
                  <TouchableOpacity
                    key={typeKey}
                    style={[
                      styles.channelSettingsTypeCard,
                      isSelected && {
                        borderColor: resolvedServerAccent || theme.primary,
                        backgroundColor: `${resolvedServerAccent || theme.primary}14`,
                      },
                    ]}
                    onPress={() => {
                      setEditChannelType(typeKey as ChannelType);
                      setEditChannelEmoji(defaultEmoji);
                    }}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name={iconName as any}
                      size={18}
                      color={isSelected ? resolvedServerAccent || theme.primary : "#7d3b30"}
                    />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <Text
                        style={[
                          styles.channelSettingsTypeTitle,
                          isSelected && { color: resolvedServerAccent || theme.primary, fontWeight: "700" },
                        ]}
                      >
                        {title}
                      </Text>
                      <Text style={styles.channelSettingsTypeHint} numberOfLines={1}>
                        {hint}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.channelSettingsFieldLabel}>Channel Name</Text>
            <TextInput
              style={styles.channelSettingsInput}
              value={editChannelName}
              onChangeText={setEditChannelName}
              placeholder="channel-name"
              placeholderTextColor="#b89a92"
            />

            <Text style={styles.channelSettingsFieldLabel}>Channel Emoji</Text>
            <TextInput
              style={styles.channelSettingsInput}
              value={editChannelEmoji}
              onChangeText={setEditChannelEmoji}
              placeholder="💬"
              placeholderTextColor="#b89a92"
              maxLength={3}
            />

            <Text style={styles.channelSettingsFieldLabel}>Channel Description</Text>
            <TextInput
              style={[styles.channelSettingsInput, styles.channelSettingsInputMulti]}
              value={editChannelHint}
              onChangeText={setEditChannelHint}
              placeholder="What is this channel for?"
              placeholderTextColor="#b89a92"
              multiline
            />

            <TouchableOpacity
              style={styles.channelSettingsDeleteBtn}
              onPress={handleDeleteCurrentChannel}
              activeOpacity={0.82}
            >
              <Ionicons name="trash-outline" size={16} color="#c0392b" />
              <Text style={styles.channelSettingsDeleteBtnText}>Delete Channel</Text>
            </TouchableOpacity>

            <View style={styles.channelSettingsModalActions}>
              <TouchableOpacity
                style={styles.channelSettingsCancelBtn}
                onPress={() => setEditChannelModalVisible(false)}
              >
                <Text style={styles.channelSettingsCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.channelSettingsSaveBtn, { backgroundColor: resolvedServerAccent || theme.primary }]}
                onPress={handleSaveChannelChanges}
                disabled={!editChannelName.trim()}
              >
                <Text style={styles.channelSettingsSaveText}>Save Changes</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Messenger-style Forward Message Modal */}
      <Modal
        visible={forwardModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setForwardModalVisible(false)}
      >
        <View style={styles.forwardModalOverlay}>
          <Pressable
            style={styles.forwardModalBackdrop}
            onPress={() => setForwardModalVisible(false)}
          />
          <View style={[styles.forwardModalCard, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.forwardModalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.forwardModalTitle}>Forward Message</Text>
                <Text style={styles.forwardModalSubtitle}>Send to other channels or servers</Text>
              </View>
              <TouchableOpacity
                onPress={() => setForwardModalVisible(false)}
                style={styles.forwardModalCloseBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close" size={22} color={theme.textMuted} />
              </TouchableOpacity>
            </View>

            {/* Snippet Preview */}
            {forwardTargetMessage && (
              <View style={styles.forwardSnippetCard}>
                <View style={styles.forwardSnippetAccent} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.forwardSnippetAuthor}>
                    {forwardTargetMessage.isAnonymous
                      ? (((forwardTargetMessage.realUserId || forwardTargetMessage.userId) === user?.uid && isStaff(currentUserProfile?.role))
                          ? "Anonymous (You)"
                          : "Anonymous")
                      : forwardTargetMessage.username || "User"}
                  </Text>
                  {!!forwardTargetMessage.text && (
                    <Text style={styles.forwardSnippetText} numberOfLines={2}>
                      {forwardTargetMessage.text}
                    </Text>
                  )}
                  {!!forwardTargetMessage.files?.length && (
                    <View style={styles.forwardSnippetMetaRow}>
                      <Ionicons name="attach" size={13} color={theme.accent} />
                      <Text style={styles.forwardSnippetMetaText}>
                        {forwardTargetMessage.files.length} attachment
                        {forwardTargetMessage.files.length > 1 ? "s" : ""}
                      </Text>
                    </View>
                  )}
                  {!!forwardTargetMessage.link && (
                    <View style={styles.forwardSnippetMetaRow}>
                      <Ionicons name="link" size={13} color="#4f9cff" />
                      <Text style={styles.forwardSnippetMetaText} numberOfLines={1}>
                        {forwardTargetMessage.link.title || forwardTargetMessage.link.url}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            )}

            {/* Search Input */}
            <View style={styles.forwardSearchContainer}>
              <Ionicons name="search" size={17} color={theme.textMuted} />
              <TextInput
                style={styles.forwardSearchInput}
                placeholder="Search channels or servers..."
                placeholderTextColor={theme.textMuted}
                value={forwardSearchQuery}
                onChangeText={setForwardSearchQuery}
                autoCapitalize="none"
              />
              {!!forwardSearchQuery && (
                <TouchableOpacity onPress={() => setForwardSearchQuery("")}>
                  <Ionicons name="close-circle" size={17} color={theme.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            {/* Destinations List */}
            <FlatList
              data={filteredForwardDestinations}
              keyExtractor={(item) => `${item.serverId}_${item.channelId}`}
              renderItem={({ item }) => {
                const status = forwardStatusMap[item.channelId];
                return (
                  <View style={styles.forwardDestRow}>
                    <View style={styles.forwardDestIconWrap}>
                      <Text style={styles.forwardDestEmoji}>
                        {item.channelEmoji || "#"}
                      </Text>
                    </View>
                    <View style={styles.forwardDestInfo}>
                      <Text style={styles.forwardDestName} numberOfLines={1}>
                        #{item.channelName}
                      </Text>
                      <Text style={styles.forwardDestServer} numberOfLines={1}>
                        {item.serverName}
                        {item.isCurrentServer ? " (This server)" : ""}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.forwardSendBtn,
                        status === "sent" && styles.forwardSendBtnSent,
                        status === "sending" && styles.forwardSendBtnSending,
                      ]}
                      onPress={() => handleForwardToChannel(item)}
                      disabled={status === "sending" || status === "sent"}
                      activeOpacity={0.8}
                    >
                      {status === "sending" ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : status === "sent" ? (
                        <View style={styles.forwardSentContent}>
                          <Ionicons name="checkmark" size={15} color="#fff" />
                          <Text style={styles.forwardSentText}>Sent</Text>
                        </View>
                      ) : (
                        <View style={styles.forwardSendContent}>
                          <Ionicons name="arrow-redo" size={14} color="#fff" />
                          <Text style={styles.forwardSendText}>Forward</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  </View>
                );
              }}
              ListEmptyComponent={
                <View style={styles.forwardEmptyContainer}>
                  <Ionicons name="chatbubbles-outline" size={36} color="#c9b0a8" />
                  <Text style={styles.forwardEmptyText}>
                    {forwardSearchQuery ? "No matching channels found" : "No channels available"}
                  </Text>
                </View>
              }
              style={styles.forwardList}
              contentContainerStyle={{ paddingBottom: 12 }}
            />
          </View>
        </View>
      </Modal>

      <ImageZoomViewer
        visible={imageViewer !== null}
        images={imageViewer?.images ?? []}
        startIndex={imageViewer?.index ?? 0}
        onClose={closeImageViewer}
        showActions={false}
      />
      <ExternalLinkDialog
        link={pendingExternalLink}
        onClose={() => setPendingExternalLink(null)}
      />
    </View>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "transparent",
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(8, 2, 2, 0.55)",
  },
  sheet: {
    flex: 1,
    backgroundColor: c.surfaceSunken,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: "hidden",
  },
  container: {
    flex: 1,
    backgroundColor: c.surfaceSunken,
  },
  dragZone: {
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 10,
  },
  dragHandle: {
    width: 44,
    height: 5,
    borderRadius: 999,
    backgroundColor: c.textMuted,
  },
  dragText: {
    marginTop: 6,
    color: c.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
  },
  headerCopy: {
    flex: 1,
    paddingRight: 12,
  },
  serverName: {
    color: c.textPrimary,
    fontSize: 18,
    fontWeight: "800",
  },
  channelName: {
    color: c.textMuted,
    fontSize: 13,
    marginTop: 4,
    fontWeight: "600",
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  // Task 3: header button cluster (pinned-messages toggle + close).
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surface,
    borderWidth: 1,
  },
  headerIconBadge: {
    position: "absolute",
    top: -3,
    right: -3,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: c.surfaceSunken,
  },
  headerIconBadgeText: {
    color: c.onPrimary,
    fontSize: 10,
    fontWeight: "800",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 24,
  },
  emptyListContent: {
    flexGrow: 1,
    justifyContent: "center",
  },
  scrollToBottomBtn: {
    position: "absolute",
    right: 16,
    bottom: 78,
    width: 38,
    height: 38,
    borderRadius: 19,
    // Neutral rather than the server accent. It used to be the same gold as
    // the send button, two circles of the same weight a few points apart, so
    // a glance could not tell them apart. Keeping the accent for sending only
    // lets the colour mean one thing.
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
    zIndex: 20,
  },
  // Clears the "Replying to …" bar, which adds roughly this much height.
  scrollToBottomBtnRaised: {
    bottom: 128,
  },
  messageRow: {
    marginBottom: 16,
    flexDirection: "row",
    alignItems: "flex-end",
  },
  messageRowOwn: {
    justifyContent: "flex-end",
  },
  messageRowOther: {
    justifyContent: "flex-start",
  },
  // Applied to every bubble in a group except the last, so grouped messages
  // sit close together and the full 14px gap only separates senders.
  messageRowGrouped: {
    marginBottom: 3,
  },
  avatarWrap: {
    marginRight: 8,
    // Pinned to the same width as avatarSpacer below. It previously had none
    // and sized to its child, so anything unexpected in the avatar column
    // stole width from the message beside it.
    width: 34,
  },
  // Empty stand-in that keeps non-last grouped bubbles aligned with the one
  // that actually shows the avatar.
  avatarSpacer: {
    width: 34,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.borderStrong,
    overflow: "hidden",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarText: {
    color: c.primary,
    fontSize: 13,
    fontWeight: "800",
  },
  // One small line above the bubble marking a reply, the way Messenger does.
  replyLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 3,
    paddingHorizontal: 4,
  },
  replyLabelRowOwn: { justifyContent: "flex-end" },
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
  replyEchoText: { color: c.textMuted, fontSize: 12.5, flexShrink: 1 },
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
  messageContentWrap: {
    width: SCREEN_WIDTH * 0.74,
    maxWidth: SCREEN_WIDTH * 0.74,
    // maxWidth caps the widest this may get; these stop it being crushed to
    // nothing when a sibling in the row measures wider than expected. Without
    // them the bubble could collapse to a few pixels and the text wrapped one
    // character per line, which is what made messages look stretched
    // vertically. minWidth: 0 is what actually lets the text wrap normally
    // inside a flex row.
    flexShrink: 1,
    minWidth: 0,
  },
  messageBubble: {
    // Size to content and stay left-aligned — without this the bubble would
    // stretch to whatever the widest sibling below it is (e.g. a reaction
    // pill), which made own-message bubbles look "stretched".
    alignSelf: "flex-start",
    maxWidth: "100%",
    backgroundColor: c.surface,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  messageBubbleOwn: {
    alignSelf: "flex-end",
    borderColor: "transparent",
    borderBottomRightRadius: 8,
  },
  messageSending: {
    opacity: 0.6,
  },
  messageAuthor: {
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
  },
  messageText: {
    color: c.textPrimary,
    fontSize: 15,
    lineHeight: 20,
  },
  messageTextOwn: {
    color: c.onPrimary,
  },
  messageLink: {
    color: "#2563eb",
    fontWeight: "700",
    textDecorationLine: "underline",
  },
  messageLinkOwn: {
    color: c.onPrimary,
  },
  messageMention: {
    color: c.isDark ? "#93C5FD" : "#2563EB",
    fontWeight: "700",
  },
  messageMentionOwn: { color: "#BFDBFE" },
  // Task 4A: "(edited)" marker under the text of an edited message.
  editedTag: {
    marginTop: 3,
    color: c.textMuted,
    fontSize: 11,
    fontStyle: "italic",
  },
  editedTagOwn: {
    color: c.onPrimary,
  },
  // Task 3: "Pinned" badge shown at the top of a pinned message's bubble.
  pinnedTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 6,
  },
  pinnedTagText: {
    color: c.textSecondary,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  pinnedTagTextOwn: {
    color: c.onPrimary,
  },
  messageToggleText: {
    color: c.textSecondary,
    fontSize: 13,
    fontWeight: "700",
  },
  messageToggleTextOwn: {
    color: c.accentSoft,
  },
  aiPendingRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  aiPendingText: {
    marginLeft: 8,
    color: c.textSecondary,
    fontSize: 12.5,
    fontWeight: "600",
  },
  aiPendingTextOwn: {
    color: c.onPrimary,
  },
  forwardedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  forwardedText: {
    fontSize: 11,
    fontStyle: "italic",
    fontWeight: "500",
    color: c.textMuted,
  },
  forwardedTextOwn: {
    color: "rgba(255,250,247,0.75)",
  },
  // Only spacing now — the size comes from the image's own ratio. The old
  // fixed 180pt height with a cover fit is what cropped photos top and bottom.
  messageImageSpacing: {
    marginTop: 10,
  },
  photoStack: {
    alignSelf: "flex-start",
    gap: 4,
    marginTop: 4,
  },
  photoStackOwn: {
    alignSelf: "flex-end",
  },
  photoItem: {
    borderRadius: 16,
    overflow: "hidden",
  },
  photoAuthor: {
    marginBottom: 2,
  },
  messageImagePressed: {
    opacity: 0.85,
  },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginTop: 10,
    backgroundColor: "rgba(255,250,247,0.18)",
  },
  fileChipText: {
    flex: 1,
    color: c.primary,
    fontSize: 12.5,
    fontWeight: "600",
  },
  fileChipTextOwn: {
    color: c.onPrimary,
  },
  linkCard: {
    width: MESSAGE_DETAIL_CARD_WIDTH,
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    padding: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,250,247,0.18)",
  },
  linkCopy: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  linkTitle: {
    color: c.primary,
    fontSize: 13,
    fontWeight: "700",
  },
  linkTitleOwn: {
    color: c.onPrimary,
  },
  linkUrl: {
    color: c.textMuted,
    fontSize: 11.5,
    marginTop: 2,
    lineHeight: 16,
  },
  linkUrlOwn: {
    color: "rgba(255,250,247,0.82)",
  },
  tagCard: {
    width: MESSAGE_DETAIL_CARD_WIDTH,
    maxWidth: "100%",
    marginTop: 10,
  },
  tagRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  tagText: {
    color: c.textSecondary,
    fontSize: 12.5,
    fontWeight: "600",
    flexShrink: 1,
    minWidth: 0,
  },
  tagTextOwn: {
    color: c.onPrimary,
  },
  tagMore: { color: c.textMuted, fontSize: 12, fontWeight: "700" },
  tagExpandedList: {
    marginTop: 7,
    marginLeft: 20,
    paddingTop: 7,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.borderStrong,
  },
  tagExpandedListOwn: { borderTopColor: "rgba(255,255,255,0.25)" },
  tagExpandedName: { color: c.textSecondary, fontSize: 12.5, fontWeight: "600" },
  messageMeta: {
    color: c.textMuted,
    fontSize: 11.5,
    marginTop: 5,
    marginLeft: 4,
  },
  messageMetaOwn: {
    textAlign: "right",
    marginRight: 4,
  },
  messageMetaRevealed: {
    color: c.textSecondary,
    fontWeight: "600",
  },
  // Feature 4: swipe-to-reply.
  replyHint: {
    position: "absolute",
    bottom: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
  },
  replyHintOther: {
    left: 0,
  },
  replyHintOwn: {
    right: 0,
  },
  replyQuoteBar: {
    width: 3,
    borderRadius: 2,
    alignSelf: "stretch",
  },
  replyBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    marginBottom: 6,
  },
  replyBarName: {
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: "800",
  },
  replyBarPreview: {
    color: c.textMuted,
    fontSize: 12.5,
    marginTop: 1,
  },
  // Feature 6: typing indicator line above the composer.
  typingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 4,
  },
  typingIndicatorText: {
    flex: 1,
    color: c.textMuted,
    fontSize: 12,
    fontStyle: "italic",
  },
  typingDotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  typingDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  // Feature 5: read-receipt avatar stack.
  readStrip: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 3,
  },
  readStripOther: {
    marginLeft: 6,
  },
  readStripOwn: {
    alignSelf: "flex-end",
    marginRight: 4,
  },
  readAvatar: {
    width: 15,
    height: 15,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.borderStrong,
    borderWidth: 1,
    borderColor: c.surface,
    overflow: "hidden",
  },
  readAvatarStacked: {
    marginLeft: -6,
  },
  readAvatarImage: {
    width: "100%",
    height: "100%",
  },
  readAvatarText: {
    color: c.primary,
    fontSize: 8,
    fontWeight: "800",
  },
  readOverflow: {
    marginLeft: 4,
    color: c.textMuted,
    fontSize: 10.5,
    fontWeight: "700",
  },
  // One compact pill (not a wrapping row), so it can't stretch the bubble.
  // The time above a new stretch of messages, as in DMs.
  timeLabel: {
    alignSelf: "center",
    marginTop: 16,
    marginBottom: 6,
    fontSize: 11.5,
    fontWeight: "600",
    color: c.textMuted,
  },
  // The bubble and its photos, as one box the reaction can sit on.
  messageBody: {
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  messageBodyOwn: {
    alignSelf: "flex-end",
  },
  // Room below for the reaction hanging off the corner.
  messageBodyWithReaction: {
    marginBottom: 12,
  },
  reactionCorner: {
    position: "absolute",
    bottom: -12,
    zIndex: 4,
  },
  reactionCornerOwn: {
    right: 6,
  },
  reactionCornerOther: {
    left: 6,
  },
  reactionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: c.surfaceRaised,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 2.5,
    elevation: 2,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  reactionPillMine: {
    backgroundColor: c.accentSoft,
    borderColor: c.accent,
  },
  reactionPillEmoji: {
    fontSize: 12,
  },
  reactionPillCount: {
    fontSize: 11,
    fontWeight: "700",
    color: c.textSecondary,
  },
  reactionPillCountMine: {
    color: c.primary,
  },
  reactionPickerOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10,2,2,0.45)",
  },
  reactionPickerCard: {
    // Task 3: was a plain emoji row; now a column so the Pin action can sit
    // beneath the emoji row.
    alignItems: "stretch",
    gap: 4,
    backgroundColor: c.surface,
    borderRadius: 26,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: c.accentSoft,
  },
  reactionPickerEmojiRow: {
    flexDirection: "row",
    gap: 4,
  },
  // Shared style for the stacked actions below the emoji row (pin / edit /
  // delete). Each is a full-width row with a hairline divider above it.
  reactionPickerAction: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 2,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: c.accentSoft,
  },
  reactionPickerActionText: {
    color: c.primary,
    fontSize: 14,
    fontWeight: "700",
  },
  reactionPickerActionDanger: {
    color: "#a12a1a",
  },
  reactionPickerButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
  },
  reactionPickerButtonActive: {
    backgroundColor: c.accentSoft,
  },
  reactionPickerEmoji: {
    fontSize: 24,
  },
  emptyState: {
    alignItems: "center",
    paddingHorizontal: 20,
  },
  emptyTitle: {
    marginTop: 16,
    color: c.textPrimary,
    fontSize: 20,
    fontWeight: "800",
  },
  emptyText: {
    marginTop: 8,
    color: c.textMuted,
    textAlign: "center",
    lineHeight: 20,
  },
  composerShell: {
    borderTopWidth: 0,
    borderTopColor: c.borderStrong,
    backgroundColor: c.surface,
    paddingHorizontal: 8,
    paddingTop: 0,
    paddingBottom: Platform.OS === "android" ? 8 : 0,
  },
  // Task 3: Pinned messages sheet.
  pinnedSheet: {
    backgroundColor: c.surfaceSunken,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  pinnedList: {
    maxHeight: SCREEN_HEIGHT * 0.58,
  },
  // DragToCloseSheet draws the handle, with its own space above it.
  draggableSheet: {
    paddingTop: 0,
  },
  pinnedSheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  pinnedSheetTitle: {
    flex: 1,
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "800",
  },
  pinnedListContent: {
    paddingVertical: 6,
  },
  pinnedEmptyContent: {
    flexGrow: 1,
    justifyContent: "center",
  },
  pinnedEmptyState: {
    alignItems: "center",
    paddingVertical: 32,
    gap: 10,
  },
  pinnedEmptyText: {
    color: c.textMuted,
    fontSize: 14,
    fontWeight: "600",
  },
  pinnedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  pinnedRowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  pinnedRowBody: {
    flex: 1,
  },
  pinnedAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.borderStrong,
    overflow: "hidden",
  },
  pinnedAvatarImage: {
    width: "100%",
    height: "100%",
  },
  pinnedAvatarText: {
    color: c.primary,
    fontSize: 13,
    fontWeight: "800",
  },
  pinnedSender: {
    color: c.textPrimary,
    fontSize: 13.5,
    fontWeight: "800",
  },
  pinnedPreviewRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: 2,
  },
  pinnedPreview: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 16,
  },
  pinnedMeta: {
    marginTop: 4,
    color: c.textMuted,
    fontSize: 11.5,
    fontWeight: "600",
  },
  pinnedJumpButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  // Task 4A: edit-message dialog.
  editOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10,2,2,0.45)",
    paddingHorizontal: 20,
  },
  editCard: {
    width: "100%",
    backgroundColor: c.surface,
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: c.accentSoft,
  },
  editTitle: {
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 10,
  },
  editInput: {
    minHeight: 88,
    maxHeight: 200,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    backgroundColor: c.surface,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    color: c.textPrimary,
    fontSize: 15,
    lineHeight: 20,
    textAlignVertical: "top",
  },
  editActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 16,
  },
  editButtonGhost: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  editButtonGhostText: {
    color: c.textSecondary,
    fontSize: 14,
    fontWeight: "700",
  },
  editButtonPrimary: {
    paddingVertical: 9,
    paddingHorizontal: 20,
    borderRadius: 999,
    backgroundColor: c.primary,
  },
  editButtonPrimaryText: {
    color: c.onPrimary,
    fontSize: 14,
    fontWeight: "800",
  },
  editButtonDisabled: {
    opacity: 0.6,
  },
  // Task 5: channel content sheet (Media / Files / Links / Search).
  segmentRow: {
    flexDirection: "row",
    gap: 6,
    paddingVertical: 10,
  },
  segment: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: c.border,
  },
  segmentActive: {
    backgroundColor: c.primary,
  },
  segmentText: {
    color: c.textMuted,
    fontSize: 12.5,
    fontWeight: "800",
  },
  segmentTextActive: {
    color: c.onPrimary,
  },
  galleryList: {
    maxHeight: SCREEN_HEIGHT * 0.56,
  },
  // Fixed 1/3 width + padding gutter — a lone tile on the last row stays a
  // third wide instead of stretching (the classic RN numColumns pitfall).
  mediaTile: {
    width: "33.333%",
    aspectRatio: 1,
    padding: 3,
  },
  mediaTileImage: {
    width: "100%",
    height: "100%",
    borderRadius: 12,
    backgroundColor: c.surfaceSunken,
  },
  galleryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  galleryRowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  galleryRowBody: {
    flex: 1,
  },
  galleryRowTitle: {
    color: c.textPrimary,
    fontSize: 13.5,
    fontWeight: "700",
  },
  galleryRowMeta: {
    marginTop: 2,
    color: c.textMuted,
    fontSize: 11.5,
  },
  searchInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 10 : 4,
  },
  searchInput: {
    flex: 1,
    color: c.textPrimary,
    fontSize: 14,
    padding: 0,
  },
  searchScopeNote: {
    marginTop: 8,
    marginBottom: 2,
    color: c.textMuted,
    fontSize: 11.5,
    fontStyle: "italic",
  },
  searchResultSnippet: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 16,
  },
  contentEmptyState: {
    alignItems: "center",
    paddingVertical: 32,
    gap: 10,
  },
  contentEmptyText: {
    color: c.textMuted,
    fontSize: 13.5,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 20,
  },
  loadMoreButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    paddingVertical: 16,
    marginTop: 8,
  },
  loadMoreText: {
    color: c.primary,
    fontSize: 13,
    fontWeight: "800",
  },
  forwardModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  forwardModalBackdrop: {
    ...StyleSheet.absoluteFill,
  },
  forwardModalCard: {
    backgroundColor: c.surfaceSunken,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: SCREEN_HEIGHT * 0.82,
    minHeight: 380,
    paddingHorizontal: 16,
    paddingTop: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 8,
  },
  forwardModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  forwardModalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: c.primary,
  },
  forwardModalSubtitle: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 2,
  },
  forwardModalCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: c.border,
    alignItems: "center",
    justifyContent: "center",
  },
  forwardSnippetCard: {
    flexDirection: "row",
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: c.border,
    gap: 8,
  },
  forwardSnippetAccent: {
    width: 3,
    backgroundColor: c.accent,
    borderRadius: 2,
  },
  forwardSnippetAuthor: {
    fontSize: 12.5,
    fontWeight: "700",
    color: c.primary,
    marginBottom: 2,
  },
  forwardSnippetText: {
    fontSize: 12,
    color: c.textMuted,
    lineHeight: 16,
  },
  forwardSnippetMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  forwardSnippetMetaText: {
    fontSize: 11,
    color: c.textSecondary,
    fontWeight: "500",
  },
  forwardSearchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surface,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: c.borderStrong,
    gap: 8,
    marginBottom: 12,
  },
  forwardSearchInput: {
    flex: 1,
    fontSize: 13.5,
    color: c.textPrimary,
    padding: 0,
  },
  forwardList: {
    flex: 1,
  },
  forwardDestRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 12,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  forwardDestIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: c.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
  },
  forwardDestEmoji: {
    fontSize: 16,
    fontWeight: "700",
    color: c.primary,
  },
  forwardDestInfo: {
    flex: 1,
  },
  forwardDestName: {
    fontSize: 14,
    fontWeight: "700",
    color: c.textPrimary,
  },
  forwardDestServer: {
    fontSize: 11.5,
    color: c.textMuted,
    marginTop: 2,
  },
  forwardSendBtn: {
    backgroundColor: c.primary,
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    minWidth: 78,
  },
  forwardSendBtnSending: {
    opacity: 0.7,
  },
  forwardSendBtnSent: {
    backgroundColor: "#27ae60",
  },
  forwardSendContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  forwardSendText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  forwardSentContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  forwardSentText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  forwardEmptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
    gap: 8,
  },
  forwardEmptyText: {
    fontSize: 13,
    color: c.textMuted,
    textAlign: "center",
  },
  // Collaborative: counts of what's been shared, opening Files & Media.
  sharedFilesBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 2,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: c.surface,
  },
  sharedFilesText: { flex: 1, color: c.textSecondary, fontSize: 12.5, fontWeight: "600" },
  sharedFilesOpen: { fontSize: 12.5, fontWeight: "800" },
  // A student who reaches a Staff only channel.
  noAccess: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 8 },
  noAccessTitle: { color: c.textPrimary, fontSize: 16, fontWeight: "800" },
  noAccessText: { color: c.textMuted, fontSize: 13.5, textAlign: "center", lineHeight: 20 },
  staffChannelNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingTop: 6,
  },
  staffChannelNoteText: { color: c.textMuted, fontSize: 11.5, fontWeight: "600" },
  readOnlyBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surface,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: c.border,
    gap: 12,
  },
  readOnlyIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  readOnlyText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 16,
  },
  channelSettingsModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  channelSettingsModalCard: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: c.surface,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: c.border,
  },
  channelSettingsModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  channelSettingsModalTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: c.textPrimary,
  },
  channelSettingsModalSubtitle: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 2,
  },
  channelSettingsFieldLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: c.primary,
    marginBottom: 5,
    marginTop: 8,
  },
  channelSettingsTypeGrid: {
    gap: 7,
    marginBottom: 8,
  },
  channelSettingsTypeCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 8,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surfaceRaised,
  },
  channelSettingsTypeTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: c.textPrimary,
  },
  channelSettingsTypeHint: {
    fontSize: 10.5,
    color: c.textMuted,
  },
  channelSettingsInput: {
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: c.textPrimary,
  },
  channelSettingsInputMulti: {
    minHeight: 52,
    textAlignVertical: "top",
  },
  channelSettingsDeleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.dangerSoft,
    backgroundColor: c.dangerSoft,
    marginTop: 12,
  },
  channelSettingsDeleteBtnText: {
    color: "#c0392b",
    fontSize: 13,
    fontWeight: "700",
  },
  channelSettingsModalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 16,
  },
  channelSettingsCancelBtn: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 18,
    backgroundColor: c.border,
  },
  channelSettingsCancelText: {
    color: c.primary,
    fontSize: 13,
    fontWeight: "700",
  },
  channelSettingsSaveBtn: {
    paddingVertical: 9,
    paddingHorizontal: 20,
    borderRadius: 18,
  },
  channelSettingsSaveText: {
    color: c.onPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
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

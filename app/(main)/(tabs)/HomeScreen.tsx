// HomeScreen.tsx
import { resolveAvatarUri } from "@/utils/avatar";
import { AVATAR_SIZE_SMALL, avatarThumb } from "@/utils/cloudinaryImages";
import { consumeServerDrawerReopenRequest } from "@/utils/communityNavigation";
import {
  appendThreadToSections,
  buildChannelAccess,
  buildCommunityServers,
  channelAccessKey,
  isStaffRole,
  deleteChannelFromSections,
  makeCustomCommunityServerDraft,
  updateChannelInSections,
  type ChannelType,
  type RemoteCommunityServerRecord,
  type ServerJoinRequestRecord,
  type ServerMembershipRecord,
} from "@/utils/communityServers";
import {
  getCommunityChannelKey,
  readCommunityChannelLastSeenMap,
  type CommunityChannelLastSeenMap,
} from "@/utils/communityUnread";
import {
  getDirectChatParams,
  subscribeToTotalUnreadMessages,
} from "@/utils/directMessages";
import { subscribeHomeFeedScrollToTop } from "@/utils/homeFeedEvents";
import { getPresenceState, PRESENCE_TIMEOUT_MS, type PresenceData } from "@/utils/messengerState";
import { useAppActive } from "@/utils/presence";
import { matchesEventAudience } from "@/utils/eventAudience";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { useNetworkStatus } from "@/utils/networkUtils";
import { showAppToast } from "@/utils/toastEvents";
import {
  createNotification,
  createServerRemovalNotification,
  removeLikeNotification,
  upsertLikeNotification,
} from "@/utils/notifications";
import {
  getCachedFeed,
  getCachedMyProfile,
  getCachedServers,
  saveCachedFeed,
  saveCachedServers,
} from "@/utils/offlineStorage";
import { normalizePostFlair, POST_FLAIRS, type PostFlairId } from "@/utils/postFlairs";
import { getPendingPostLike, savePostLike, withViewerLike } from "@/utils/postLikes";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import {
  getStudentDocIdFromAuthUser,
  getUserDataByAuthUser,
  subscribeToUserDataUpdates,
} from "@/utils/rbac";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  FlatList,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";
import AnnouncementCarousel, { AnnouncementItem } from "../components/AnnouncementCarousel";
import BeaOrb from "../components/BeaOrb";
import CommentModal from "../components/CommentModal";
import ConfirmDialog, { type ConfirmDialogVariant } from "../components/ConfirmDialog";
import HomeSearchProvider, {
  HomeSearchBar,
  HomeSearchPanel,
  type SearchResult,
} from "../components/HomeSearchOverlay";
import ImageZoomViewer from "../components/ImageZoomViewer";
import PollCard from "../components/PollCard";
import PostCard from "../components/PostCard";
import ServerDrawer, {
  ServerEditPatch,
  ServerMemberPreview,
} from "../components/ServerDrawer";
import { FeedSkeleton } from "../components/Skeleton";
import LiveCard from "../components/LiveCard";
import { useThemeColors } from "@/contexts/ThemeContext";
import { type LiveStream } from "@/utils/liveStreams";
import { useActiveLiveStreams } from "@/utils/useActiveLiveStreams";
import {
  getLostFoundStatus,
  isLostFoundArchived,
  LOST_FOUND_STATUSES,
  lostFoundStatusColors,
  type LostFoundStatus,
} from "@/utils/lostFoundStatus";
import type { ThemeTokens } from "@/utils/theme";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
// Width of one card in the horizontal "Trending this week" scroller.
const TRENDING_CARD_WIDTH = Math.min(320, Math.round(SCREEN_WIDTH * 0.82));
const SELECTED_SERVER_KEY = "bonded.selectedCommunityServer";
/** The local date on which B.E.A.'s brief was last closed; it stays hidden that day. */
const HOME_BRIEF_HIDDEN_KEY = "bonded.homeBrief.hiddenOn";
const DEFAULT_CHANNEL_KEY = "general";
const HOME_RETURN_ROUTE = "/(main)/(tabs)/HomeScreen";
// Unread channel badges only count messages from this many recent days, so
// Home doesn't download a community's whole message history on every connect.
const COMMUNITY_UNREAD_WINDOW_DAYS = 14;



type TaggedUser = {
  id: string;
  name: string;
  studentID: string;
};

type FileAttachment = {
  url: string;
  mimeType: string;
};

type Post = {
  id: string;
  content?: string;
  imageUrl?: string;
  files?: FileAttachment[];
  link?: { url: string; title: string };
  username?: string;
  userId?: string;
  realUserId?: string;
  isAnonymous?: boolean;
  taggedUsers?: TaggedUser[];
  createdAt?: any;
  likeCount?: number;
  commentCount?: number;
  likedBy?: string[];
  bookmarkedBy?: string[];
  serverId?: string | null;
  channelId?: string | null;
  pinnedAt?: any;
  pinnedBy?: string | null;
  pinExpiresAt?: any;
  targetDate?: any;
  targetDateLabel?: string | null;
  aiReply?: { text: string; model?: string | null; generatedAtMs?: number; status?: string | null };
  moderationStatus?: string;
  moderatedAtMs?: number;
  moderationReasons?: string[];
  flair?: string;
  lostFoundStatus?: string;
  returnedAt?: any;
  resolvedAt?: any;
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
  isAnonymous?: boolean;
  allowMultiple: boolean;
  maxSelections: number;
  allowUsersToAddOption?: boolean;
  totalVotes: number;
  durationMs: number;
  createdAt?: any;
  expiresAt?: any;
  pinnedAt?: any;
  pinnedBy?: string | null;
  pinExpiresAt?: any;
  userVotes?: number[];
  commentCount?: number;
  serverId?: string | null;
  channelId?: string | null;
  moderationStatus?: string;
  moderatedAtMs?: number;
  moderationReasons?: string[];
  flair?: string;
};

export type PostFeedItem = Post & { type: "post" };
export type PollFeedItem = Poll & { type: "poll" };
export type FeedItem = PostFeedItem | PollFeedItem;

export type SearchableStudent = {
  id: string;
  userId?: string;
  firstname: string;
  lastname: string;
  studentID?: string;
  course?: string;
  profileImage?: string | null;
  role?: string;
  isOnline?: boolean;
  lastSeen?: any;
  // What Messenger reads to decide who is active; see onlineRoster.
  activeStatusEnabled?: boolean;
  presenceSessions?: PresenceData["presenceSessions"];
};

type CommunityThreadMessageLite = {
  id: string;
  serverId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  createdAt?: any;
};

type NotificationRouteParams = {
  notificationKey?: string | string[];
  notificationPostId?: string | string[];
  notificationPollId?: string | string[];
  notificationCommentId?: string | string[];
  notificationReplyId?: string | string[];
  notificationOpenReply?: string | string[];
};

type NotificationTarget = {
  key: string;
  postId?: string;
  pollId?: string;
  commentId?: string;
  replyId?: string;
  openReplyThread: boolean;
};

const getSingleParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const getTimestampValue = (value: any) => value?.toMillis?.() || 0;

/** Local YYYY-MM-DD, the format event dates are stored in. */
const localDateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;

const countOf = (count: number, one: string, many: string) =>
  `${count > 99 ? "99+" : count} ${count === 1 ? one : many}`;

type BriefItem = {
  id: "events" | "announcements" | "messages" | "live";
  emoji: string;
  label: string;
  onPress: () => void;
};

const isSameCalendarDay = (timestamp: any, target: Date): boolean => {
  if (!timestamp || typeof timestamp.toDate !== "function") return false;

  const date = timestamp.toDate();

  return (
    date.getFullYear() === target.getFullYear() &&
    date.getMonth() === target.getMonth() &&
    date.getDate() === target.getDate()
  );
};

const areStringArraysEqual = (first: string[] = [], second: string[] = []) =>
  first.length === second.length &&
  first.every((value, index) => value === second[index]);

const areTaggedUsersEqual = (
  first: TaggedUser[] = [],
  second: TaggedUser[] = [],
) =>
  first.length === second.length &&
  first.every(
    (value, index) =>
      value.id === second[index]?.id &&
      value.name === second[index]?.name &&
      value.studentID === second[index]?.studentID,
  );

const areFilesEqual = (
  first: FileAttachment[] = [],
  second: FileAttachment[] = [],
) =>
  first.length === second.length &&
  first.every(
    (value, index) =>
      value.url === second[index]?.url &&
      value.mimeType === second[index]?.mimeType,
  );

const arePollOptionsEqual = (
  first: PollOption[] = [],
  second: PollOption[] = [],
) =>
  first.length === second.length &&
  first.every(
    (value, index) =>
      value.text === second[index]?.text &&
      value.votes === second[index]?.votes &&
      areStringArraysEqual(value.voters || [], second[index]?.voters || []),
  );

const areFeedItemsEquivalent = (first: FeedItem, second: FeedItem) => {
  if (first.type !== second.type || first.id !== second.id) return false;

  if (first.type === "post" && second.type === "post") {
    return (
      first.content === second.content &&
      first.imageUrl === second.imageUrl &&
      first.username === second.username &&
      first.userId === second.userId &&
      first.realUserId === second.realUserId &&
      first.isAnonymous === second.isAnonymous &&
      normalizePostFlair(first.flair) === normalizePostFlair(second.flair) &&
      String(first.moderationStatus ?? "approved").toLowerCase() ===
        String(second.moderationStatus ?? "approved").toLowerCase() &&
      areStringArraysEqual(first.moderationReasons || [], second.moderationReasons || []) &&
      first.moderatedAtMs === second.moderatedAtMs &&
      first.likeCount === second.likeCount &&
      first.commentCount === second.commentCount &&
      getTimestampValue(first.createdAt) ===
        getTimestampValue(second.createdAt) &&
      areStringArraysEqual(first.likedBy || [], second.likedBy || []) &&
      areStringArraysEqual(first.bookmarkedBy || [], second.bookmarkedBy || []) &&
      areTaggedUsersEqual(
        first.taggedUsers || [],
        second.taggedUsers || [],
      ) &&
      areFilesEqual(first.files || [], second.files || []) &&
      first.link?.url === second.link?.url &&
      first.link?.title === second.link?.title &&
      first.aiReply?.text === second.aiReply?.text &&
      first.aiReply?.model === second.aiReply?.model &&
      first.aiReply?.generatedAtMs === second.aiReply?.generatedAtMs &&
      first.aiReply?.status === second.aiReply?.status &&
      getTimestampValue(first.pinnedAt) === getTimestampValue(second.pinnedAt)
    );
  }

  if (first.type === "poll" && second.type === "poll") {
    return (
      first.question === second.question &&
      first.imageUrl === second.imageUrl &&
      first.userId === second.userId &&
      first.username === second.username &&
      first.isAnonymous === second.isAnonymous &&
      normalizePostFlair(first.flair) === normalizePostFlair(second.flair) &&
      String(first.moderationStatus ?? "approved").toLowerCase() ===
        String(second.moderationStatus ?? "approved").toLowerCase() &&
      areStringArraysEqual(first.moderationReasons || [], second.moderationReasons || []) &&
      first.moderatedAtMs === second.moderatedAtMs &&
      first.allowMultiple === second.allowMultiple &&
      first.maxSelections === second.maxSelections &&
      first.allowUsersToAddOption === second.allowUsersToAddOption &&
      first.totalVotes === second.totalVotes &&
      first.durationMs === second.durationMs &&
      first.commentCount === second.commentCount &&
      getTimestampValue(first.createdAt) ===
        getTimestampValue(second.createdAt) &&
      getTimestampValue(first.expiresAt) ===
        getTimestampValue(second.expiresAt) &&
      getTimestampValue(first.pinnedAt) === getTimestampValue(second.pinnedAt) &&
      getTimestampValue(first.pinExpiresAt) === getTimestampValue(second.pinExpiresAt) &&
      arePollOptionsEqual(first.options || [], second.options || [])
    );
  }

  return false;
};

// Both feed listeners watch this many documents, and loadMoreFeed pages in
// the same size. The two must stay equal: itemsBelowLiveWindow tells a full
// window (there is older content beyond it) from a partial one (there is not)
// by comparing the snapshot size against this.
const FEED_PAGE_SIZE = 20;

/**
 * The already-loaded items that sit *below* a listener's live window.
 *
 * Each listener only ever sees the newest FEED_PAGE_SIZE documents, so its
 * snapshot cannot contain anything loadMoreFeed paged in underneath. Rebuilding
 * the feed from the snapshot alone therefore drops every page the reader had
 * scrolled into — one like on a recent post would rewind the whole feed. These
 * are the items that must survive that rebuild.
 *
 * Membership is decided by the window's oldest timestamp rather than by "was
 * it missing from the snapshot", so a document that was deleted, or pushed out
 * of the window by newer arrivals, is still resolved correctly: a deletion
 * lets the window refill from below and drop its floor past the removed item,
 * while an item pushed out by newer posts falls under the floor and is kept.
 */
const itemsBelowLiveWindow = (
  previousItems: FeedItem[],
  type: FeedItem["type"],
  windowItems: FeedItem[],
): FeedItem[] => {
  // A partial window means the collection fits inside it — nothing is older.
  if (windowItems.length < FEED_PAGE_SIZE) return [];

  const windowFloor = getTimestampValue(
    windowItems[windowItems.length - 1].createdAt,
  );
  if (!windowFloor) return [];

  const windowIds = new Set(windowItems.map((item) => item.id));
  return previousItems.filter(
    (item) =>
      item.type === type &&
      !windowIds.has(item.id) &&
      getTimestampValue(item.createdAt) < windowFloor,
  );
};

const mergeFeedItemsByIdentity = (
  previousItems: FeedItem[],
  nextItems: FeedItem[],
) => {
  const previousItemsMap = new Map(
    previousItems.map((item) => [`${item.type}:${item.id}`, item]),
  );
  return nextItems.map((item) => {
    const existingItem = previousItemsMap.get(`${item.type}:${item.id}`);
    return existingItem && areFeedItemsEquivalent(existingItem, item)
      ? existingItem
      : item;
  });
};

export const isPostPinActive = (
  post: { pinnedAt?: any; pinExpiresAt?: any },
  nowMs: number = Date.now(),
): boolean => {
  if (!post.pinnedAt) return false;
  if (!post.pinExpiresAt) return true;
  const expiresMs = getTimestampValue(post.pinExpiresAt);
  return expiresMs > 0 ? nowMs < expiresMs : true;
};

const sortFeedItems = (items: FeedItem[]) => {
  const nowMs = Date.now();
  return [...items].sort(
    (first, second) => {
      // Pinned posts and pinned polls share the top of the feed.
      const firstPinned =
        (first.type === "post" || first.type === "poll") && isPostPinActive(first, nowMs)
          ? getTimestampValue(first.pinnedAt)
          : 0;
      const secondPinned =
        (second.type === "post" || second.type === "poll") && isPostPinActive(second, nowMs)
          ? getTimestampValue(second.pinnedAt)
          : 0;

      if (firstPinned || secondPinned) {
        if (!firstPinned) return 1;
        if (!secondPinned) return -1;
        if (secondPinned !== firstPinned) return secondPinned - firstPinned;
      }

      return getTimestampValue(second.createdAt) - getTimestampValue(first.createdAt);
    },
  );
};

const isGlobalFeedItem = (item: FeedItem) => !item.serverId;

/**
 * Whether an item is eligible to appear on Home right now.
 *
 * IMPORTANT: Home is never the moderation-review surface. Pending and
 * rejected content must stay out of Home even when the viewer is an
 * admin/teacher/moderator. Staff review pending content from the Moderation
 * Queue instead. Legacy documents without a moderationStatus are treated as
 * approved for backward compatibility.
 *
 * Shared by the rendered list and by the new-posts pill's count, so the pill
 * can never promise items that would be filtered out on arrival.
 */
type LostFoundFeedFields = {
  flair?: string | null;
  lostFoundStatus?: unknown;
  returnedAt?: unknown;
  resolvedAt?: unknown;
};

/**
 * Whether a feed item should show under the current filters.
 *
 * `lostFoundFilter` only means anything while the flair filter is Lost &
 * Found. `archiveNowMs` turns on archiving: returned Lost & Found items drop
 * out of the list after a week — except under the Returned filter, which is
 * precisely how somebody finds them again. Callers that leave it out (the
 * trending and staging calculations) keep their behaviour unchanged.
 */
/** The Home filter chips: everything, only polls, or posts with one flair. */
type FeedFilter = "all" | "polls" | PostFlairId;

const isDisplayableFeedItem = (
  item: FeedItem,
  flairFilter: FeedFilter,
  lostFoundFilter: "all" | LostFoundStatus = "all",
  archiveNowMs?: number,
) => {
  if (!isGlobalFeedItem(item)) return false;

  const status = String(item.moderationStatus ?? "approved").toLowerCase();
  if (status !== "approved") return false;

  const showingReturned =
    flairFilter === "lost_found" && lostFoundFilter === "returned";
  if (
    archiveNowMs !== undefined &&
    !showingReturned &&
    isLostFoundArchived(item as LostFoundFeedFields, archiveNowMs)
  ) {
    return false;
  }

  if (flairFilter === "all") return true;

  // Polls have no flair: they have their own chip, and the flair chips are
  // for posts. Posts with no flair (or a retired one) count as Discussion.
  if (flairFilter === "polls") return item.type === "poll";
  if (item.type === "poll") return false;
  if (normalizePostFlair(item.flair) !== flairFilter) return false;

  if (flairFilter === "lost_found" && lostFoundFilter !== "all") {
    return getLostFoundStatus(item as LostFoundFeedFields) === lostFoundFilter;
  }
  return true;
};

// A post the signed-in user just wrote always goes straight in — nobody wants
// to tap a pill to see their own post.
const isOwnFeedItem = (item: FeedItem, uid: string | undefined) => {
  if (!uid) return false;
  if (item.userId === uid) return true;
  // Anonymous posts keep the author on realUserId; polls have no such field.
  return item.type === "post" && item.realUserId === uid;
};

// How close to the top counts as "reading the newest". Inside this, arrivals
// merge silently the way X does; past it they wait behind the pill.
const FEED_TOP_MERGE_OFFSET = 240;

// Which feed cards are scrolled into view, kept outside React state. When the
// visible set changes, only the cards whose own visibility flipped re-render.
// Holding it in HomeScreen state re-rendered the whole screen and every mounted
// card on each viewability change, leaving the list no time to draw new rows
// during a fast scroll.
const createFeedVisibilityStore = () => {
  let visibleIds = new Set<string>();
  const listeners = new Set<() => void>();

  return {
    setVisibleIds(next: Set<string>) {
      visibleIds = next;
      listeners.forEach((listener) => listener());
    },
    isVisible(id: string) {
      return visibleIds.has(id);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

type FeedVisibilityStore = ReturnType<typeof createFeedVisibilityStore>;

type FeedPostCardProps = Omit<ComponentProps<typeof PostCard>, "videoCardVisible"> & {
  visibilityStore: FeedVisibilityStore;
  // True while search results cover the feed, so hidden videos stay paused.
  videosPaused: boolean;
};

// PostCard with its own subscription to the visibility store, so a card
// scrolling in or out of view re-renders by itself.
const FeedPostCard = memo(function FeedPostCard({
  visibilityStore,
  videosPaused,
  ...cardProps
}: FeedPostCardProps) {
  const postId = cardProps.post.id;
  const isOnScreen = useSyncExternalStore(visibilityStore.subscribe, () =>
    visibilityStore.isVisible(postId),
  );

  return <PostCard {...cardProps} videoCardVisible={!videosPaused && isOnScreen} />;
});

// ── Campus Presence ──────────────────────────────────────────────────────────

/** Campus Presence only lists people seen in the last day. */
const PRESENCE_RECENT_MS = 24 * 60 * 60 * 1000;
/** How often Home re-checks the online count while the panel is closed. */
const PRESENCE_POLL_MS = 60 * 1000;

/** One profile as Campus Presence reads it: who, and when last seen. */
type PresenceRecord = SearchableStudent & { accountLocked?: boolean };

function toPresenceRecord(id: string, data: Record<string, any>): PresenceRecord {
  return {
    id,
    userId: data.userId ? String(data.userId) : undefined,
    firstname: String(data.firstname || ""),
    lastname: String(data.lastname || ""),
    studentID: data.studentID ? String(data.studentID) : undefined,
    course: data.course ? String(data.course) : undefined,
    profileImage: data.profileImage || null,
    role: data.role ? String(data.role) : undefined,
    isOnline: data.isOnline === true,
    lastSeen: data.lastSeen,
    activeStatusEnabled: data.activeStatusEnabled,
    presenceSessions: data.presenceSessions,
    accountLocked: data.accountLocked === true,
  };
}

/**
 * Names and photos for search, mentions and the server drawer, read once.
 * Every open app writes its "online" heartbeat to these same profiles every
 * 30 seconds, so listening to them live re-downloaded a profile — and
 * redrew all of Home — for every person online, twice a minute. Who's
 * online comes from Campus Presence's own, much smaller queries instead.
 */
async function fetchSearchableStudents(): Promise<SearchableStudent[]> {
  const snapshot = await getDocs(collection(db, "students"));
  return snapshot.docs.map((item) => {
    const data = item.data();
    return {
      id: item.id,
      userId: data.userId ? String(data.userId) : undefined,
      firstname: String(data.firstname || ""),
      lastname: String(data.lastname || ""),
      studentID: data.studentID ? String(data.studentID) : undefined,
      course: data.course ? String(data.course) : undefined,
      profileImage: data.profileImage || null,
      role: data.role ? String(data.role) : undefined,
    };
  });
}

type CampusPresenceStudent = PresenceRecord & { isOnline: boolean };

type CampusPresenceRowProps = {
  student: CampusPresenceStudent;
  styles: ReturnType<typeof makeStyles>;
  theme: ThemeTokens;
  /** A label above this row, where the list moves from active to recent. */
  section: "online" | "recent" | null;
  showDivider: boolean;
  onlineCount: number;
  lastSeenLabel: string;
  canMessage: boolean;
  onOpenProfile: (student: CampusPresenceStudent) => void;
  onMessage: (student: CampusPresenceStudent) => void;
};

/**
 * One person in Campus Presence. The row opens their profile; the chat button
 * beside it opens a DM, and only that — it never also opens the profile.
 *
 * Online is said in words as well as green, so it doesn't rest on colour.
 */
const CampusPresenceRow = memo(function CampusPresenceRow({
  student,
  styles,
  theme,
  section,
  showDivider,
  onlineCount,
  lastSeenLabel,
  canMessage,
  onOpenProfile,
  onMessage,
}: CampusPresenceRowProps) {
  const fullName = `${student.firstname} ${student.lastname}`.trim() || "Student";
  const online = student.isOnline;
  const detail = student.course || student.role || "Campus member";

  return (
    <>
      {section && (
        <View style={styles.presenceSection}>
          <Text style={styles.presenceSectionText}>
            {section === "online" ? "Active now" : "Active in the last 24 hours"}
          </Text>
          {section === "online" && (
            <View style={styles.presenceSectionCount}>
              <Text style={[styles.presenceSectionCountText, styles.presenceOnlineInk]}>
                {onlineCount}
              </Text>
            </View>
          )}
        </View>
      )}

      <Pressable
        onPress={() => onOpenProfile(student)}
        style={({ pressed }) => [styles.presenceRow, pressed && styles.presenceRowPressed]}
        accessibilityRole="button"
        accessibilityLabel={`${fullName}, ${detail}, ${online ? "online" : `last active ${lastSeenLabel}`}`}
        accessibilityHint="Opens their profile"
      >
        {showDivider && <View style={styles.presenceDivider} />}

        <View style={styles.presenceAvatarWrap}>
          <View style={styles.presenceAvatar}>
            {student.profileImage ? (
              <Image
                source={{ uri: avatarThumb(student.profileImage, AVATAR_SIZE_SMALL) }}
                style={styles.presenceAvatarImage}
                contentFit="cover"
                recyclingKey={student.id}
              />
            ) : (
              <Text style={styles.presenceAvatarText}>
                {(student.firstname?.[0] || fullName[0] || "S").toUpperCase()}
              </Text>
            )}
          </View>
          {online && <View style={styles.presenceAvatarDot} />}
        </View>

        <View style={styles.presenceCopy}>
          <Text
            style={[styles.presenceName, !online && styles.presenceNameIdle]}
            numberOfLines={1}
          >
            {fullName}
          </Text>
          <Text style={styles.presenceDetail} numberOfLines={1}>
            {detail}
          </Text>
          <View style={styles.presenceStatusRow}>
            {online ? (
              <>
                <View style={styles.presenceOnlinePill}>
                  <View style={styles.presenceOnlinePillDot} />
                  <Text style={[styles.presenceOnlinePillText, styles.presenceOnlineInk]}>
                    Online
                  </Text>
                </View>
              </>
            ) : (
              <>
                <Ionicons name="time-outline" size={12} color={theme.textMuted} />
                <Text style={styles.presenceLastSeen} numberOfLines={1}>
                  {lastSeenLabel}
                </Text>
              </>
            )}
          </View>
        </View>

        {canMessage && (
          <Pressable
            onPress={() => onMessage(student)}
            hitSlop={6}
            style={({ pressed }) => [
              styles.presenceMessageButton,
              pressed && styles.presenceMessageButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Message ${fullName}`}
          >
            <Ionicons name="chatbubble-ellipses-outline" size={19} color={theme.primary} />
          </Pressable>
        )}
      </Pressable>
    </>
  );
});

/**
 * Campus Presence's card, easing up into place as it opens. The modal fades
 * the backdrop; this only adds a short lift, so nothing waits on it.
 */
function PresencePanelEntrance({
  style,
  children,
}: {
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) });
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.4 + 0.6 * progress.value,
    transform: [
      { translateY: 12 * (1 - progress.value) },
      { scale: 0.97 + 0.03 * progress.value },
    ],
  }));

  return <Reanimated.View style={[style, animatedStyle]}>{children}</Reanimated.View>;
}

// ─────────────────────────────────────────────────────────────────────────────

const HomeScreen = () => {
  // Rebuilt only when the palette changes. Named `theme` rather than `colors`
  // because several screens already bind `colors` to a per-item palette, and
  // shadowing that is a silent bug rather than a loud one.
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const insets = useSafeAreaInsets();
  const [user, setUser] = useState<User | null>(null);
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [selectedFlairFilter, setSelectedFlairFilter] = useState<FeedFilter>("all");
  // The status chips under Lost & Found. Only consulted while that flair is
  // the filter, and reset whenever the flair changes.
  const [lostFoundFilter, setLostFoundFilter] = useState<"all" | LostFoundStatus>("all");
  // Archiving is measured in days, so the clock behind it only needs to move
  // hourly (and when the app comes back to the foreground).
  const archiveNowMs = useRelativeTimeNow(60 * 60 * 1000);

  // Live arrivals held back from the list while the reader is scrolled away
  // from the top. Each listener owns its own half and rebuilds it from every
  // snapshot, so an edit refreshes the staged copy and a deletion drops it
  // without any extra bookkeeping.
  const [stagedPosts, setStagedPosts] = useState<PostFeedItem[]>([]);
  const [stagedPolls, setStagedPolls] = useState<PollFeedItem[]>([]);
  // Staging must not swallow the very first page — there is nothing on screen
  // yet for an arrival to disturb.
  const hasHydratedPostsRef = useRef(false);
  const hasHydratedPollsRef = useRef(false);
  const isNearFeedTopRef = useRef(true);
  // Ids each listener put into the feed on its latest snapshot. feedItemsRef
  // only catches up after the next render, so a snapshot that lands before
  // then would otherwise mistake posts already on screen for new arrivals.
  const lastLivePostIdsRef = useRef<Set<string>>(new Set());
  const lastLivePollIdsRef = useRef<Set<string>>(new Set());
  // "Trending this week" — a bounded date-range query picks WHICH posts are
  // trending (by engagement), then a live listener on just those doc ids keeps
  // their like/comment/bookmark state current so interacting with a trending
  // card updates it immediately, same as the main feed. Empty ids = hidden.
  const [trendingPostIds, setTrendingPostIds] = useState<string[]>([]);
  const [trendingPosts, setTrendingPosts] = useState<PostFeedItem[]>([]);

  // Single dialog state used to render every alert on this screen through
  // the app's branded ConfirmDialog instead of the bare native Alert.alert.
  // showInfo() covers single-button "OK" messages; showConfirm() covers
  // Cancel/Confirm pairs (deletes, leaving a server, etc.).
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
  const showInfo = (title: string, description?: string, onConfirm?: () => void, variant?: ConfirmDialogVariant) =>
    setDialog({
      title,
      description,
      variant,
      confirmText: "OK",
      singleAction: true,
      onConfirm: () => {
        setDialog(null);
        onConfirm?.();
      },
    });
  const showConfirm = (options: {
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    onConfirm: () => void;
  }) =>
    setDialog({
      ...options,
      onConfirm: () => {
        setDialog(null);
        options.onConfirm();
      },
    });

  // Mirrors feedItems for callbacks (handleLike, handlePollVote) that need to
  // read the current feed without depending on the array itself — feedItems
  // gets a new reference on every realtime Firestore update, and depending
  // on it directly would recreate those callbacks (and therefore bust
  // React.memo on every visible PostCard/PollCard) on every such update,
  // not just when the user interacts.
  const feedItemsRef = useRef<FeedItem[]>([]);
  useEffect(() => {
    feedItemsRef.current = feedItems;
  }, [feedItems]);

  const [fabMenuVisible, setFabMenuVisible] = useState(false);
  const [serverDrawerVisible, setServerDrawerVisible] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(false);
  // Set by HomeSearchProvider while search results cover the feed.
  const [searchResultsVisible, setSearchResultsVisible] = useState(false);
  // Live: this was fetched once and guarded against refetching, so a role
  // change never reached the feed until the app was restarted.
  const currentUserRole = useCurrentUserRole();
  const [currentUserProfile, setCurrentUserProfile] = useState<any>(null);
  const [remoteServers, setRemoteServers] = useState<
    RemoteCommunityServerRecord[]
  >([]);
  const [serverMemberships, setServerMemberships] = useState<
    ServerMembershipRecord[]
  >([]);
  const [serverJoinRequests, setServerJoinRequests] = useState<
    ServerJoinRequestRecord[]
  >([]);
  const [communityThreadMessages, setCommunityThreadMessages] = useState<
    CommunityThreadMessageLite[]
  >([]);
  const [channelLastSeenMap, setChannelLastSeenMap] =
    useState<CommunityChannelLastSeenMap>({});
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [userRoles, setUserRoles] = useState<{ [key: string]: string }>({});
  const [searchableStudents, setSearchableStudents] = useState<
    SearchableStudent[]
  >([]);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [currentImages, setCurrentImages] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [currentImageViewerPostId, setCurrentImageViewerPostId] = useState<
    string | null
  >(null);
  const [onlineUsersModalVisible, setOnlineUsersModalVisible] = useState(false);
  // Campus Presence. Closed: who was seen in the last 90 seconds, checked
  // once a minute for the count. Open: everyone seen in the last day, live.
  const [onlineNowRecords, setOnlineNowRecords] = useState<PresenceRecord[]>([]);
  const [panelPresence, setPanelPresence] = useState<PresenceRecord[] | null>(null);
  // Upcoming feeds the calendar badge; today feeds B.E.A.'s brief.
  const [eventCounts, setEventCounts] = useState({ upcoming: 0, today: 0 });
  const upcomingEventsCount = eventCounts.upcoming;
  // Whether B.E.A.'s brief in the welcome card was closed today. null until
  // the saved choice has been read, and shown meanwhile.
  const [briefHidden, setBriefHidden] = useState<boolean | null>(null);
  const [totalUnreadMessages, setTotalUnreadMessages] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [highlightedPostId, setHighlightedPostId] = useState<string | null>(
    null,
  );
  const [notificationModalPostId, setNotificationModalPostId] = useState<
    string | null
  >(null);
  const [notificationModalCommentId, setNotificationModalCommentId] = useState<
    string | null
  >(null);
  const [notificationModalReplyId, setNotificationModalReplyId] = useState<
    string | null
  >(null);
  const [notificationModalOpenReply, setNotificationModalOpenReply] =
    useState(false);
  const [pendingNotificationTarget, setPendingNotificationTarget] =
    useState<NotificationTarget | null>(null);
  const notificationPostFetchesRef = useRef(new Set<string>());
  const notificationPollFetchesRef = useRef(new Set<string>());
  const pendingNotificationPostIdRef = useRef<string | undefined>(undefined);
  const pendingNotificationPollIdRef = useRef<string | undefined>(undefined);
  const [handledNotificationKey, setHandledNotificationKey] = useState<
    string | null
  >(null);
  const [highlightedFeedKey, setHighlightedFeedKey] = useState<string | null>(
    null,
  );
  const stripUndefined = useCallback((value: Record<string, unknown>) => {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
    );
  }, []);

  const fabTranslateY = useRef(new Animated.Value(0)).current;
  const fabRotation = useRef(new Animated.Value(0)).current;
  const menuScale = useRef(new Animated.Value(0)).current;
  const scrollY = useRef(0);
  const scrollDirectionRef = useRef<"up" | "down">("up");
  const menuOpacity = useRef(new Animated.Value(0)).current;
  const menuTranslateY = useRef(new Animated.Value(0)).current;

  // Welcome-card micro animations: a one-time entrance plus a very subtle
  // floating decoration loop. Only opacity and transforms are animated so the
  // native driver can keep this lightweight. B.E.A. animates itself.
  const welcomeOpacity = useRef(new Animated.Value(0)).current;
  const welcomeTranslateY = useRef(new Animated.Value(12)).current;
  const welcomeCopyOpacity = useRef(new Animated.Value(0)).current;
  const welcomeCopyTranslateY = useRef(new Animated.Value(6)).current;
  const welcomeFloat = useRef(new Animated.Value(0)).current;

  const feedListRef = useRef<FlatList<FeedItem>>(null);
  const router = useRouter();

  // Part A: which feed cards are currently scrolled into view — drives
  // X-style muted autoplay for feed videos (combined with screen focus
  // inside PostCard). FlatList requires these two to be stable references.
  const [feedVisibilityStore] = useState(createFeedVisibilityStore);
  const feedViewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
    // Short so a video's audio cuts almost as soon as it scrolls past 50%
    // (X-style), while still filtering out items that only flick through the
    // viewport during a fast scroll.
    minimumViewTime: 50,
  }).current;
  const onFeedViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: { key: string }[] }) => {
      feedVisibilityStore.setVisibleIds(new Set(viewableItems.map((entry) => entry.key)));
    },
  ).current;

  useEffect(() => {
    const entrance = Animated.sequence([
      Animated.parallel([
        Animated.timing(welcomeOpacity, {
          toValue: 1,
          duration: 420,
          useNativeDriver: true,
        }),
        Animated.spring(welcomeTranslateY, {
          toValue: 0,
          friction: 8,
          tension: 55,
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(welcomeCopyOpacity, {
          toValue: 1,
          duration: 260,
          useNativeDriver: true,
        }),
        Animated.timing(welcomeCopyTranslateY, {
          toValue: 0,
          duration: 260,
          useNativeDriver: true,
        }),
      ]),
    ]);

    const floatingDecoration = Animated.loop(
      Animated.sequence([
        Animated.timing(welcomeFloat, {
          toValue: 1,
          duration: 2800,
          useNativeDriver: true,
        }),
        Animated.timing(welcomeFloat, {
          toValue: 0,
          duration: 2800,
          useNativeDriver: true,
        }),
      ]),
    );

    entrance.start();
    floatingDecoration.start();

    return () => {
      entrance.stop();
      floatingDecoration.stop();
    };
  }, [
    welcomeCopyOpacity,
    welcomeCopyTranslateY,
    welcomeFloat,
    welcomeOpacity,
    welcomeTranslateY,
  ]);

  const {
    notificationKey,
    notificationPostId,
    notificationPollId,
    notificationCommentId,
    notificationReplyId,
    notificationOpenReply,
  } = useLocalSearchParams<NotificationRouteParams>();

  const unreadChannelCounts = useMemo(() => {
    const counts: Record<string, number> = {};

    communityThreadMessages.forEach((message) => {
      if (!message.serverId || !message.channelId) return;
      if (message.userId && user?.uid && message.userId === user.uid) return;

      const createdAtMs = getTimestampValue(message.createdAt);
      const channelKey = getCommunityChannelKey(message.serverId, message.channelId);
      const lastSeenMs = channelLastSeenMap[channelKey] || 0;

      if (createdAtMs > lastSeenMs) {
        counts[channelKey] = (counts[channelKey] || 0) + 1;
      }
    });

    return counts;
  }, [channelLastSeenMap, communityThreadMessages, user?.uid]);

const communityServers = useMemo(() => {
    const isStaffViewer = ["admin", "teacher", "moderator"].includes(
      currentUserRole || "",
    );
    return buildCommunityServers({
      userProfile: currentUserProfile,
      userRole: currentUserRole,
      currentUserId: user?.uid,
      remoteServers,
      memberships: serverMemberships,
      joinRequests: serverJoinRequests,
    }).map((server) => {
      const isPublicServer = server.isPublic === true;
      const hasMembership = server.membershipState === "joined";

      return {
        ...server,
        sections: (server.sections || []).map((section) => ({
          ...section,
          channels: (section.channels || []).map((channel) => {
            const unreadCount =
              unreadChannelCounts[getCommunityChannelKey(server.id, channel.id)] || 0;
            return {
              ...channel,
              unread: unreadCount > 0,
              unreadCount,
            };
          }),
        })),
        visibleToCurrentUser: isPublicServer || hasMembership || isStaffViewer,
        defaultChannelId: "general",
      };
    }).filter((server) => server.visibleToCurrentUser);
  }, [
    unreadChannelCounts,
    currentUserProfile,
    currentUserRole,
    remoteServers,
    serverJoinRequests,
    serverMemberships,
    user?.uid,
  ]);

const selectedServer = useMemo(() => {
    if (!selectedServerId) return null;
    return communityServers.find((server) => server.id === selectedServerId) || null;
  }, [communityServers, selectedServerId]);

  const selectedServerChannels = useMemo(() => {
    if (!selectedServer) return [];

    const allChannels = (Array.isArray(selectedServer.sections)
      ? selectedServer.sections
      : []
    ).flatMap((section) => section.channels ?? []);

    return allChannels;
  }, [selectedServer]);

const selectedChannel = useMemo(() => {
    if (!selectedServer) return null;

    const channels = selectedServerChannels;

    // Priority 1: Explicitly selected channel
    if (selectedChannelId) {
      const found = channels.find((ch) => ch.id === selectedChannelId);
      if (found) return found;
    }

    // Priority 2: Default to "general"
    const generalChannel = channels.find((ch) => ch.id === DEFAULT_CHANNEL_KEY);
    if (generalChannel) return generalChannel;

    // Fallback (should rarely happen)
    return channels[0] || null;
  }, [selectedChannelId, selectedServer, selectedServerChannels]);

  // ── Edge-swipe navigation: HomeScreen → ServerDrawer ────────────────────
  // Swiping in from the left edge opens the same ServerDrawer panel as the
  // header menu button — reuses the identical "pick a default server if
  // none selected yet" logic so behavior is consistent everywhere.
  const openServerDrawer = useCallback(() => {
    if (!selectedServerId) {
      const nextServer =
        communityServers.find((server) => server.membershipState === "joined") ||
        communityServers[0] ||
        null;
      if (nextServer) {
        setSelectedServerId(nextServer.id);
      }
    }
    setServerDrawerVisible(true);
  }, [communityServers, selectedServerId]);

  // communityServers is live Firestore data and gets a new array reference
  // on nearly every snapshot update, which would otherwise force
  // openServerDrawer — and therefore panGesture below — to be rebuilt
  // constantly. Rebuilding the Pan gesture while a touch is in progress
  // makes RNGH detach and reattach the native recognizer mid-swipe, which
  // is a real source of dropped frames / stutter. Routing through a ref
  // lets the gesture object stay 100% stable for the component's lifetime
  // while still always calling the latest openServerDrawer.
  const openServerDrawerRef = useRef(openServerDrawer);
  useEffect(() => {
    openServerDrawerRef.current = openServerDrawer;
  }, [openServerDrawer]);
  const triggerOpenServerDrawer = useCallback(() => {
    openServerDrawerRef.current();
  }, []);

  // Constructed exactly once — never recreated on re-render, so the native
  // gesture recognizer is registered a single time for the screen's whole
  // lifetime and can't be interrupted mid-touch.
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 0, width: 32 }) // Activation zone limited to the left screen edge (~32px)
        .activeOffsetX(20) // Requires an intentful rightward drag before the gesture activates
        .failOffsetY([-15, 15]) // Yields to vertical scrolling immediately
        .maxPointers(1)
        .onEnd((event) => {
          const isDraggedRight = event.translationX > 60;
          const isFlickedRight = event.velocityX > 350;

          if (isDraggedRight || isFlickedRight) {
            runOnJS(triggerOpenServerDrawer)();
          }
        }),
    [],
    // eslint-disable-line react-hooks/exhaustive-deps -- intentionally empty: gesture must stay stable, see comment above
  );

  const visibleFeedItems = useMemo(
    () =>
      feedItems.filter((item) =>
        isDisplayableFeedItem(item, selectedFlairFilter, lostFoundFilter, archiveNowMs),
      ),
    [feedItems, selectedFlairFilter, lostFoundFilter, archiveNowMs],
  );

  // Only the staged items the reader would actually get, so the pill's count
  // matches what appears when they tap it.
  const stagedFeedCount = useMemo(
    () =>
      [...stagedPosts, ...stagedPolls].filter((item) =>
        isDisplayableFeedItem(item, selectedFlairFilter, lostFoundFilter, archiveNowMs),
      ).length,
    [stagedPosts, stagedPolls, selectedFlairFilter, lostFoundFilter, archiveNowMs],
  );
  const hasStagedFeedItems = stagedFeedCount > 0;

  const newPostsPillAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!hasStagedFeedItems) return;
    newPostsPillAnim.setValue(0);
    Animated.spring(newPostsPillAnim, {
      toValue: 1,
      friction: 7,
      tension: 60,
      useNativeDriver: true,
    }).start();
  }, [hasStagedFeedItems, newPostsPillAnim]);

  /**
   * Release the staged arrivals and jump to the top — the pill's action, and
   * also what the Home tab button and pull-to-refresh do implicitly.
   *
   * Merges against feedItemsRef rather than a setFeedItems updater so the
   * mirror is advanced in the same tick: the listeners decide what to stage by
   * reading that mirror, and a snapshot landing before the next render would
   * otherwise re-stage everything just released.
   */
  const flushStagedFeedItems = useCallback(
    (options?: { scrollToTop?: boolean }) => {
      const staged: FeedItem[] = [...stagedPosts, ...stagedPolls];

      if (staged.length > 0) {
        const stagedKeys = new Set(
          staged.map((item) => `${item.type}:${item.id}`),
        );
        const merged = sortFeedItems([
          ...staged,
          ...feedItemsRef.current.filter(
            (item) => !stagedKeys.has(`${item.type}:${item.id}`),
          ),
        ]);
        feedItemsRef.current = merged;
        setFeedItems(merged);
      }

      setStagedPosts([]);
      setStagedPolls([]);
      isNearFeedTopRef.current = true;

      if (options?.scrollToTop !== false) {
        feedListRef.current?.scrollToOffset({ offset: 0, animated: true });
      }
    },
    [stagedPolls, stagedPosts],
  );

  const activeAnnouncements = useMemo(() => {
    const nowMs = Date.now();
    return feedItems
      .filter((item): item is PostFeedItem => {
        if (item.type !== "post") return false;
        if (!isGlobalFeedItem(item)) return false;
        const status = String(item.moderationStatus ?? "approved").toLowerCase();
        if (status !== "approved") return false;
        const isAnnouncement = normalizePostFlair(item.flair) === "announcement";
        const isPinned = isPostPinActive(item, nowMs);
        return isAnnouncement && isPinned;
      })
      .sort((a, b) => {
        const aExpires = getTimestampValue(a.pinExpiresAt || a.targetDate);
        const bExpires = getTimestampValue(b.pinExpiresAt || b.targetDate);
        if (aExpires && bExpires) return aExpires - bExpires;
        if (aExpires) return -1;
        if (bExpires) return 1;
        return getTimestampValue(b.createdAt) - getTimestampValue(a.createdAt);
      });
  }, [feedItems]);

  const selectedServerJoinRequests = useMemo(
    () =>
      serverJoinRequests.filter(
        (request) =>
          request.serverId === selectedServerId && request.status === "pending",
      ),
    [selectedServerId, serverJoinRequests],
  );

  const relativeTimeNow = useRelativeTimeNow();

  // Who is online right now, by Messenger's rule. From the panel's live list
  // while it's open, otherwise from the minute-by-minute check.
  const activePresenceRecords = useMemo(() => {
    const source = onlineUsersModalVisible && panelPresence ? panelPresence : onlineNowRecords;
    return source.filter(
      (record) => record.accountLocked !== true && getPresenceState(record, relativeTimeNow).active,
    );
  }, [onlineNowRecords, onlineUsersModalVisible, panelPresence, relativeTimeNow]);
  const onlinePresenceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const record of activePresenceRecords) {
      ids.add(record.id);
      if (record.userId) ids.add(record.userId);
    }
    return ids;
  }, [activePresenceRecords]);

  const searchableStudentsMap = useMemo(() => {
    const map = new Map<string, SearchableStudent>();
    for (const student of searchableStudents) {
      if (student.userId) map.set(student.userId, student);
      if (student.id) map.set(student.id, student);
    }
    return map;
  }, [searchableStudents]);

  const selectedServerMembers = useMemo<ServerMemberPreview[]>(() => {
    if (!serverDrawerVisible || !selectedServerId) return [];

    const membershipUserIds = serverMemberships
      .filter(
        (membership) =>
          membership.serverId === selectedServerId &&
          membership.status !== "removed",
      )
      .map((membership) => membership.userId);

    if (selectedServer?.ownerId) {
      membershipUserIds.push(selectedServer.ownerId);
    }

    const uniqueMembershipUserIds = Array.from(new Set(membershipUserIds.filter(Boolean)));

    return uniqueMembershipUserIds
      .map((memberId) => {
        const matchedStudent = searchableStudentsMap.get(memberId);

        return {
          id: matchedStudent?.id || memberId,
          userId: matchedStudent?.userId || memberId,
          profileDocId: matchedStudent?.id || null,
          name:
            matchedStudent?.firstname || matchedStudent?.lastname
              ? `${matchedStudent?.firstname || ""} ${matchedStudent?.lastname || ""}`.trim()
              : memberId,
          role: matchedStudent?.role || null,
          course: matchedStudent?.course || null,
          avatarUri: matchedStudent ? resolveAvatarUri(matchedStudent) : null,
          isOnline: onlinePresenceIds.has(memberId),
        } satisfies ServerMemberPreview;
      })
      .sort((first, second) => first.name.localeCompare(second.name));
  }, [onlinePresenceIds, searchableStudentsMap, selectedServer?.ownerId, selectedServerId, serverDrawerVisible, serverMemberships]);

  // Everybody a manager could add to the open server: every student account
  // that isn't already a member, and not the manager themselves. Only built
  // while the drawer is open on a server this person manages.
  const selectedServerCanManage = selectedServer?.canManage === true;
  const addableServerMembers = useMemo<ServerMemberPreview[]>(() => {
    if (!serverDrawerVisible || !selectedServerCanManage) return [];
    const memberIds = new Set<string>();
    for (const member of selectedServerMembers) {
      memberIds.add(member.id);
      if (member.userId) memberIds.add(member.userId);
    }
    return searchableStudents
      .filter((student) => {
        const uid = student.userId || student.id;
        return !!uid && uid !== user?.uid && !memberIds.has(uid) && !memberIds.has(student.id);
      })
      .map((student) => ({
        id: student.id,
        userId: student.userId || student.id,
        profileDocId: student.id,
        name:
          `${student.firstname} ${student.lastname}`.trim() || student.studentID || "Student",
        role: student.role || null,
        course: student.course || null,
        studentID: student.studentID || null,
        avatarUri: resolveAvatarUri(student),
      }))
      .sort((first, second) => first.name.localeCompare(second.name));
  }, [searchableStudents, selectedServerCanManage, selectedServerMembers, serverDrawerVisible, user?.uid]);

  const listenersSetup = useRef(false);
  const unsubscribePostsRef = useRef<(() => void) | null>(null);
  const unsubscribePollsRef = useRef<(() => void) | null>(null);
  const lastPostDocRef = useRef<any>(null);
  const lastPollDocRef = useRef<any>(null);
  // Set once loadMoreFeed has paged past a listener's window. From then on the
  // listener must leave the cursor alone, or it would rewind to the window's
  // last document and the next page would re-request what the feed already has.
  const postsPaginatedRef = useRef(false);
  const pollsPaginatedRef = useRef(false);
  const loadedPostIdsRef = useRef<Set<string>>(new Set());
  const loadedPollIdsRef = useRef<Set<string>>(new Set());
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMorePosts, setHasMorePosts] = useState(true);
  const [hasMorePolls, setHasMorePolls] = useState(true);

  const { isOffline } = useNetworkStatus();

  // ── Auth listener
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

  const handleEditPost = useCallback((postId: string) => {
    const target = feedItemsRef.current?.find((item: any) => item.type === "post" && item.id === postId) as any;
    if (target && (target.realUserId || target.userId) !== user?.uid) {
      showInfo("Access Denied", "You can only edit your own posts.");
      return;
    }
    router.push({ pathname: "/CreatePostScreen", params: { editPostId: postId } });
  }, [router, user?.uid]);

  const handleEditPoll = useCallback((pollId: string) => {
    const target = feedItemsRef.current.find(
      (item): item is PollFeedItem => item.type === "poll" && item.id === pollId,
    );
    if (target && target.userId !== user?.uid) {
      showInfo("Access Denied", "You can only edit your own polls.");
      return;
    }
    router.push({ pathname: "/CreatePollScreen", params: { editPollId: pollId } });
  }, [router, user?.uid]);

  const handleDeletePost = useCallback(
    async (postId: string) => {
      if (isOffline) {
        showInfo("No Connection", "Cannot delete posts while offline.");
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
    [deleteCommentTree, isOffline],
  );

  const handleDeletePoll = useCallback(
    async (pollId: string) => {
      if (isOffline) {
        showInfo("No Connection", "Cannot delete polls while offline.");
        return;
      }

      try {
        await deleteCommentTree(pollId);
        await deleteDoc(doc(db, "polls", pollId));
        setFeedItems((current) =>
          current.filter((item) => !(item.type === "poll" && item.id === pollId)),
        );
      } catch (error) {
        console.error("Error deleting poll:", error);
        showInfo("Error", "Failed to delete poll.");
      }
    },
    [deleteCommentTree, isOffline],
  );

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return unsubscribe;
  }, []);

  // ── Load cached feed items for instant cold-start & offline viewing
  useEffect(() => {
    let isMounted = true;
    getCachedFeed<FeedItem>().then((cached) => {
      if (isMounted && cached && cached.length > 0) {
        setFeedItems((prev) => (prev.length === 0 ? cached : prev));
        setIsLoading(false);
      }
    });
    return () => {
      isMounted = false;
    };
  }, []);

  // ── Automatically persist feed items to disk cache whenever updated
  useEffect(() => {
    if (feedItems.length > 0) {
      saveCachedFeed(feedItems);
    }
  }, [feedItems]);

  // ── Load cached servers for current user for instant offline viewing
  useEffect(() => {
    if (!user?.uid) return;
    let isMounted = true;
    getCachedServers<RemoteCommunityServerRecord, ServerMembershipRecord>(user.uid).then((cached) => {
      if (isMounted && cached) {
        if (cached.servers && cached.servers.length > 0) {
          setRemoteServers((prev) => (prev.length === 0 ? cached.servers : prev));
        }
        if (cached.memberships && cached.memberships.length > 0) {
          setServerMemberships((prev) => (prev.length === 0 ? cached.memberships : prev));
        }
      }
    });
    return () => {
      isMounted = false;
    };
  }, [user?.uid]);

  // ── Automatically persist servers and memberships to disk cache whenever updated
  useEffect(() => {
    if (user?.uid && (remoteServers.length > 0 || serverMemberships.length > 0)) {
      saveCachedServers(user.uid, {
        servers: remoteServers,
        memberships: serverMemberships,
      });
    }
  }, [user?.uid, remoteServers, serverMemberships]);

  // ── Load persisted community preferences
  useEffect(() => {
    const loadCommunityPreferences = async () => {
      try {
        const storedServerId = await AsyncStorage.getItem(SELECTED_SERVER_KEY);
        if (storedServerId) setSelectedServerId(storedServerId);
      } catch (error) {
        console.error("Error loading community spaces:", error);
      }
    };
    loadCommunityPreferences();
  }, []);

  // ── Persist admin servers

  // ── Persist selected server
  // ── Persist selected server (debounced to eliminate storage I/O during rapid tapping)
  useEffect(() => {
    if (selectedServerId) {
      AsyncStorage.setItem(SELECTED_SERVER_KEY, selectedServerId).catch((error) =>
        console.error("Error saving selected server:", error),
      );
      return;
    }
    const timer = setTimeout(() => {
      if (selectedServerId) {
        AsyncStorage.setItem(SELECTED_SERVER_KEY, selectedServerId).catch((error) =>
          console.error("Error saving selected server:", error),
        );
      } else {
        AsyncStorage.removeItem(SELECTED_SERVER_KEY).catch((error) =>
          console.error("Error clearing selected server:", error),
        );
      }
    }, 400);

    AsyncStorage.removeItem(SELECTED_SERVER_KEY).catch((error) =>
      console.error("Error clearing selected server:", error),
    );
    return () => clearTimeout(timer);
  }, [selectedServerId]);

  // ── Sync selected server when server list changes
  useEffect(() => {
    setSelectedServerId((currentId) => {
      if (
        currentId &&
        communityServers.some((server) => server.id === currentId)
      ) {
        return currentId;
      }
      const joinedServer =
        communityServers.find((server) => server.membershipState === "joined") ||
        communityServers[0] ||
        null;
      return joinedServer?.id || null;
    });
  }, [communityServers]);

  // ── Sync selected channel when server changes
  useEffect(() => {
    if (!selectedServer) {
      setSelectedChannelId(null);
      return;
    }
    setSelectedChannelId((currentId) => {
      if (
        currentId &&
        selectedServerChannels.some((channel) => channel.id === currentId)
      ) {
        return currentId;
      }
      return selectedServerChannels[0]?.id || DEFAULT_CHANNEL_KEY;
    });
  }, [selectedServer, selectedServerChannels]);

  const exitServerView = useCallback(() => {
    setServerDrawerVisible(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (consumeServerDrawerReopenRequest()) {
        setServerDrawerVisible(true);
      }
    }, []),
  );

  useEffect(() => {
    const subscription = subscribeHomeFeedScrollToTop(() => {
      flushStagedFeedItems({ scrollToTop: false });
      feedListRef.current?.scrollToOffset({ offset: 0, animated: true });
      setHighlightedPostId(null);
      setHighlightedFeedKey(null);
      if (!searchExpanded) {
        setRefreshing(true);
        setTimeout(() => setRefreshing(false), 500);
      }
    });

    return () => subscription.remove();
  }, [flushStagedFeedItems, searchExpanded]);

  // ── Upcoming events count, and how many of them are today
  useEffect(() => {
    if (!user || isOffline) {
      setEventCounts({ upcoming: 0, today: 0 });
      return;
    }
    // Local, like the stored dates. The UTC date is still yesterday until
    // 8 AM in the Philippines, which counted yesterday's events as upcoming.
    const today = localDateKey(new Date());
    const q = query(
      collection(db, "events"),
      where("date", ">=", today),
      orderBy("date", "asc"),
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      // Drafts and archived events aren't on anyone's calendar, so they must
      // not inflate this badge. Filtered here rather than in the query: an
      // equality filter on status alongside the date range would need a
      // composite index, and these documents are already fetched. Events
      // written before `status` existed count as published.
      const upcoming = snapshot.docs.filter((eventDoc) => {
        const data = eventDoc.data();
        // Parts are counted through their main event, or a week with seven
        // sessions would read as seven upcoming events.
        return (
          (data.status ?? "published") === "published" &&
          !data.parentEventId &&
          // Cancelled events stay on the calendar, but they are not something
          // to count down to.
          data.cancelled !== true &&
          // Another program's event is not this student's news. Staff, who
          // have no program, still see the whole campus.
          matchesEventAudience(data.forPrograms, {
            course: currentUserProfile?.course,
            isStaff: currentUserRole !== "student",
          })
        );
      });
      setEventCounts({
        upcoming: upcoming.length,
        today: upcoming.filter((eventDoc) => eventDoc.data().date === today).length,
      });
    });
    return unsubscribe;
  }, [user, isOffline, currentUserProfile?.course, currentUserRole]);

  // ── Direct messages unread badge listener
  useEffect(() => {
    if (!user?.uid || isOffline) {
      setTotalUnreadMessages(0);
      return;
    }
    const unsubscribe = subscribeToTotalUnreadMessages(user.uid, (unreadCount) => {
      setTotalUnreadMessages(unreadCount);
    });
    return unsubscribe;
  }, [user?.uid, isOffline]);

  // ── Fetch current user profile (the role comes from useCurrentUserRole)
  useEffect(() => {
    const fetchCurrentUserProfile = async () => {
      if (user?.uid && !isOffline && !currentUserProfile) {
        try {
          setCurrentUserProfile(await getUserDataByAuthUser(user));
        } catch (error) {
          console.error("Error fetching profile:", error);
        }
      }
    };
    fetchCurrentUserProfile();
  }, [user, isOffline, currentUserProfile]);

  // Fast path: the profile this phone saved last time, so the greeting and
  // the avatar are right the moment Home opens. It used to apply only when
  // the saved copy had a photo — so anyone without one waited on the network
  // and was greeted as "there" — and not at all offline, which is exactly
  // when a saved copy matters most.
  useEffect(() => {
    if (!user?.uid) return;
    const uid = user.uid;
    getCachedMyProfile<any>(uid)
      .then((cached) => {
        if (!cached) return;
        setCurrentUserProfile((prev: any) => {
          // Anything the network already delivered is newer than the cache.
          const merged = { ...cached, ...(prev || {}) };
          const image = merged.profileImage || merged.profilePic || null;
          return { ...merged, uid, userId: uid, profileImage: image, profilePic: image };
        });
      })
      .catch(() => {});
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid || isOffline) return;

    // Initial load
    getUserDataByAuthUser(user)
      .then((profile) => {
        if (profile) setCurrentUserProfile(profile);
      })
      .catch((error) => {
        console.error("Error fetching current user profile:", error);
      });

    // Real-time listener on student document so role changes and profile photo update live
    const emailPrefix = user.email?.split("@")[0]?.trim();
    const docIds = Array.from(new Set([emailPrefix, user.uid].filter(Boolean) as string[]));
    const unsubs = docIds.map((docId) =>
      onSnapshot(
        doc(db, "students", docId),
        (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            const incomingImg = data.profileImage || data.profilePic;
            setCurrentUserProfile((prev: any) => ({
              ...(prev || {}),
              ...data,
              uid: user.uid,
              userId: user.uid,
              profileImage: incomingImg || prev?.profileImage || null,
              profilePic: incomingImg || prev?.profilePic || null,
            }));
          }
        },
        (err) => console.warn("Live user profile listener warning in HomeScreen:", err),
      ),
    );

    const unsubscribeCache = subscribeToUserDataUpdates((updatedId, updatedData) => {
      if (updatedId === user.uid) {
        setCurrentUserProfile((prev: any) => (prev ? { ...prev, ...updatedData } : prev));
      }
    });

    return () => {
      unsubs.forEach((unsub) => unsub());
      unsubscribeCache();
    };
  }, [user?.uid, isOffline]);

  useEffect(() => {
    if (!user || isOffline) {
      setSearchableStudents([]);
      return;
    }

    let cancelled = false;
    fetchSearchableStudents()
      .then((students) => {
        if (!cancelled) setSearchableStudents(students);
      })
      .catch((error) => {
        console.error("Error loading searchable students:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [isOffline, user]);

  // The header's online count, while the panel is closed: one small query a
  // minute for whoever checked in during the last 90 seconds, and only while
  // Home is on screen with the app open.
  const presenceFocused = useIsFocused();
  const presenceAppActive = useAppActive();
  useEffect(() => {
    if (!user || isOffline || !presenceFocused || !presenceAppActive || onlineUsersModalVisible) {
      return;
    }
    let cancelled = false;
    const check = () => {
      getDocs(
        query(
          collection(db, "students"),
          where("lastSeen", ">=", Timestamp.fromMillis(Date.now() - PRESENCE_TIMEOUT_MS)),
        ),
      )
        .then((snapshot) => {
          if (!cancelled) {
            setOnlineNowRecords(snapshot.docs.map((item) => toPresenceRecord(item.id, item.data())));
          }
        })
        .catch((error) => console.warn("[presence] Online check failed:", error));
    };
    check();
    const timer = setInterval(check, PRESENCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isOffline, onlineUsersModalVisible, presenceAppActive, presenceFocused, user]);

  // The panel itself: everyone seen in the last day, live while it's open.
  useEffect(() => {
    if (!onlineUsersModalVisible || !user || isOffline) return;
    return onSnapshot(
      query(
        collection(db, "students"),
        where("lastSeen", ">=", Timestamp.fromMillis(Date.now() - PRESENCE_RECENT_MS)),
      ),
      (snapshot) => {
        setPanelPresence(snapshot.docs.map((item) => toPresenceRecord(item.id, item.data())));
      },
      (error) => {
        console.warn("[presence] Campus Presence failed:", error);
        setPanelPresence([]);
      },
    );
  }, [isOffline, onlineUsersModalVisible, user]);

  useEffect(() => {
    if (!user?.uid) {
      setRemoteServers([]);
      setServerMemberships([]);
      setServerJoinRequests([]);
      setCommunityThreadMessages([]);
      return;
    }
    if (isOffline) {
      return;
    }

    const unsubscribeServers = onSnapshot(
      collection(db, "communityServers"),
      (snapshot) => {
        setRemoteServers(
          snapshot.docs.map(
            (item) =>
              ({
                id: item.id,
                ...item.data(),
              }) as RemoteCommunityServerRecord,
          ),
        );
      },
      (error) => {
        console.error("Error loading community servers:", error);
      },
    );

    const unsubscribeMemberships = onSnapshot(
      collection(db, "communityServerMemberships"),
      (snapshot) => {
        setServerMemberships(
          snapshot.docs.map(
            (item) =>
              ({
                serverId: String(item.data()?.serverId || ""),
                userId: String(item.data()?.userId || ""),
                status: String(item.data()?.status || "joined"),
              }) as ServerMembershipRecord,
          ),
        );
      },
      (error) => {
        console.error("Error loading server memberships:", error);
      },
    );

    const unsubscribeJoinRequests = onSnapshot(
      collection(db, "communityServerJoinRequests"),
      (snapshot) => {
        setServerJoinRequests(
          snapshot.docs.map(
            (item) =>
              ({
                serverId: String(item.data()?.serverId || ""),
                userId: String(item.data()?.userId || ""),
                status: String(item.data()?.status || "pending"),
                requestedByRole: item.data()?.requestedByRole
                  ? String(item.data()?.requestedByRole)
                  : undefined,
                requesterName: item.data()?.requesterName
                  ? String(item.data()?.requesterName)
                  : undefined,
                course: item.data()?.course
                  ? String(item.data()?.course)
                  : undefined,
                yearLevel: item.data()?.yearLevel
                  ? String(item.data()?.yearLevel)
                  : undefined,
              }) as ServerJoinRequestRecord,
          ),
        );
      },
      (error) => {
        console.error("Error loading join requests:", error);
      },
    );

    return () => {
      unsubscribeServers();
      unsubscribeMemberships();
      unsubscribeJoinRequests();
    };
  }, [isOffline, user?.uid]);

  // Unread badges only need messages from servers this user is allowed to
  // read — the ones they joined plus public servers — which is exactly what
  // the Firestore rules allow. Staff can read every server, so they keep one
  // unscoped listener. The key is a string so the listeners are only rebuilt
  // when the set of servers actually changes.
  // Servers made before channel types were saved for the database have no
  // list yet (the rules then fall back to the old check by name), and one
  // edited from an older app version may be out of date. Staff and owners
  // fill it in, once per change, when their servers load.
  const channelAccessSyncedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!user?.uid || isOffline) return;
    const viewerIsStaff = isStaffRole(currentUserRole);
    for (const server of remoteServers) {
      if (server.recordType === "aiMemory" || server.isDeleted) continue;
      if (!Array.isArray(server.sections) || server.sections.length === 0) continue;
      const canWrite =
        viewerIsStaff || server.ownerId === user.uid || server.createdBy === user.uid;
      if (!canWrite) continue;
      const wanted = buildChannelAccess(server.sections);
      const wantedKey = channelAccessKey(wanted);
      if (channelAccessKey(server.channelAccess) === wantedKey) continue;
      const attempt = `${server.id}:${wantedKey}`;
      if (channelAccessSyncedRef.current.has(attempt)) continue;
      channelAccessSyncedRef.current.add(attempt);
      updateDoc(doc(db, "communityServers", server.id), { channelAccess: wanted }).catch((error) =>
        console.warn("[channels] Couldn't save channel types:", error),
      );
    }
  }, [currentUserRole, isOffline, remoteServers, user?.uid]);

  const unreadMessageServerKey = useMemo(() => {
    const isStaffViewer = ["admin", "teacher", "moderator"].includes(
      currentUserRole || "",
    );
    if (isStaffViewer) return "*";
    const joinedServerIds = new Set(
      serverMemberships
        .filter(
          (membership) =>
            membership.userId === user?.uid && membership.status === "joined",
        )
        .map((membership) => membership.serverId),
    );
    return remoteServers
      .filter(
        (server) =>
          server.isDeleted !== true &&
          (server.isPublic === true || joinedServerIds.has(server.id)),
      )
      .map((server) => server.id)
      .sort()
      .join(",");
  }, [currentUserRole, remoteServers, serverMemberships, user?.uid]);

  useEffect(() => {
    if (!user?.uid || isOffline) return;

    const readableServerIds =
      unreadMessageServerKey === "*"
        ? null
        : unreadMessageServerKey.split(",").filter(Boolean);
    if (readableServerIds && readableServerIds.length === 0) {
      setCommunityThreadMessages([]);
      return;
    }

    const since = Timestamp.fromMillis(
      Date.now() - COMMUNITY_UNREAD_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    // Firestore allows at most 30 values in an "in" filter.
    const serverIdChunks: (string[] | null)[] = readableServerIds
      ? Array.from(
          { length: Math.ceil(readableServerIds.length / 30) },
          (_, index) => readableServerIds.slice(index * 30, index * 30 + 30),
        )
      : [null];
    const messagesByChunk = new Map<number, CommunityThreadMessageLite[]>();

    const unsubscribers = serverIdChunks.map((chunkIds, chunkIndex) =>
      onSnapshot(
        chunkIds
          ? query(
              collection(db, "communityThreadMessages"),
              where("serverId", "in", chunkIds),
              where("createdAt", ">", since),
              orderBy("createdAt", "asc"),
            )
          : query(
              collection(db, "communityThreadMessages"),
              where("createdAt", ">", since),
              orderBy("createdAt", "asc"),
            ),
        (snapshot) => {
          if (__DEV__)
            console.log(
              `[Home] community messages loaded: ${snapshot.size}`,
            );
          messagesByChunk.set(
            chunkIndex,
            snapshot.docs.map(
              (item) =>
                ({
                  id: item.id,
                  serverId: item.data()?.serverId ? String(item.data()?.serverId) : null,
                  channelId: item.data()?.channelId ? String(item.data()?.channelId) : null,
                  userId: item.data()?.userId ? String(item.data()?.userId) : null,
                  createdAt: item.data()?.createdAt,
                }) as CommunityThreadMessageLite,
            ),
          );
          setCommunityThreadMessages(
            Array.from(messagesByChunk.values()).flat(),
          );
        },
        (error) => {
          console.error("Error loading community thread messages:", error);
        },
      ),
    );

    // Staff only channels keep their messages apart; staff count them too.
    if (readableServerIds === null) {
      unsubscribers.push(
        onSnapshot(
          query(
            collection(db, "communityStaffMessages"),
            where("createdAt", ">", since),
            orderBy("createdAt", "asc"),
          ),
          (snapshot) => {
            messagesByChunk.set(
              -1,
              snapshot.docs.map(
                (item) =>
                  ({
                    id: item.id,
                    serverId: item.data()?.serverId ? String(item.data()?.serverId) : null,
                    channelId: item.data()?.channelId ? String(item.data()?.channelId) : null,
                    userId: item.data()?.userId ? String(item.data()?.userId) : null,
                    createdAt: item.data()?.createdAt,
                  }) as CommunityThreadMessageLite,
              ),
            );
            setCommunityThreadMessages(Array.from(messagesByChunk.values()).flat());
          },
          (error) => console.warn("Error loading staff channel messages:", error),
        ),
      );
    }

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [isOffline, unreadMessageServerKey, user?.uid]);

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      readCommunityChannelLastSeenMap()
        .then((value) => {
          if (isActive) {
            setChannelLastSeenMap(value);
          }
        })
        .catch((error) => {
          console.error("Error loading channel last-seen state:", error);
        });

      return () => {
        isActive = false;
      };
    }, []),
  );

  // ── Notification params → pending target
  useEffect(() => {
    const key = getSingleParam(notificationKey);
    if (!key) return;
    const targetPostId = getSingleParam(notificationPostId);
    const targetPollId = getSingleParam(notificationPollId);
    if (targetPostId || targetPollId) {
      setSelectedFlairFilter("all");
    }
    setPendingNotificationTarget({
      key,
      postId: targetPostId,
      pollId: targetPollId,
      commentId: getSingleParam(notificationCommentId),
      replyId: getSingleParam(notificationReplyId),
      openReplyThread: getSingleParam(notificationOpenReply) === "1",
    });
  }, [
    notificationCommentId,
    notificationKey,
    notificationOpenReply,
    notificationPollId,
    notificationPostId,
    notificationReplyId,
  ]);

  useEffect(() => {
    pendingNotificationPostIdRef.current = pendingNotificationTarget?.postId;
  }, [pendingNotificationTarget?.postId]);

  useEffect(() => {
    pendingNotificationPollIdRef.current = pendingNotificationTarget?.pollId;
  }, [pendingNotificationTarget?.pollId]);

  // ── Resolve postId from commentId when missing
  useEffect(() => {
    if (
      !pendingNotificationTarget ||
      pendingNotificationTarget.postId ||
      !pendingNotificationTarget.commentId
    ) {
      return;
    }

    let isCancelled = false;
    const resolvePostId = async () => {
      try {
        const commentSnap = await getDoc(
          doc(db, "comments", pendingNotificationTarget.commentId!),
        );
        if (!commentSnap.exists() || isCancelled) return;
        const commentData = commentSnap.data() as { postId?: string };
        if (commentData.postId) {
          setPendingNotificationTarget((current) =>
            current?.key === pendingNotificationTarget.key
              ? { ...current, postId: commentData.postId }
              : current,
          );
        }
      } catch (error) {
        console.error("Error resolving notification target:", error);
      }
    };

    resolvePostId();
    return () => {
      isCancelled = true;
    };
  }, [pendingNotificationTarget]);

  // The live feed initially contains only the newest page. Fetch a notification's
  // post directly so older likes/comments/replies/mentions can still open it.
  useEffect(() => {
    const postId = pendingNotificationTarget?.postId;
    if (
      !postId ||
      loadedPostIdsRef.current.has(postId) ||
      notificationPostFetchesRef.current.has(postId)
    ) {
      return;
    }

    notificationPostFetchesRef.current.add(postId);
    let isCancelled = false;

    getDoc(doc(db, "posts", postId))
      .then((postSnap) => {
        if (!postSnap.exists() || isCancelled) return;
        const fetchedPost: PostFeedItem = {
          type: "post",
          id: postSnap.id,
          likeCount: 0,
          commentCount: 0,
          likedBy: [],
          ...(postSnap.data() as Omit<Post, "id">),
        };
        loadedPostIdsRef.current.add(fetchedPost.id);
        setFeedItems((current) =>
          sortFeedItems(
            mergeFeedItemsByIdentity(current, [
              ...current.filter(
                (item) => !(item.type === "post" && item.id === fetchedPost.id),
              ),
              fetchedPost,
            ]),
          ),
        );
      })
      .catch((error) => {
        console.error("Error loading older notification post:", error);
        notificationPostFetchesRef.current.delete(postId);
      });

    return () => {
      isCancelled = true;
    };
  }, [pendingNotificationTarget?.postId]);

  // Keep an approved poll reachable even when it is older than the first
  // realtime page loaded by Home.
  useEffect(() => {
    const pollId = pendingNotificationTarget?.pollId;
    if (
      !pollId ||
      loadedPollIdsRef.current.has(pollId) ||
      notificationPollFetchesRef.current.has(pollId)
    ) {
      return;
    }

    notificationPollFetchesRef.current.add(pollId);
    let isCancelled = false;

    getDoc(doc(db, "polls", pollId))
      .then((pollSnapshot) => {
        if (!pollSnapshot.exists() || isCancelled) return;
        const fetchedPoll: PollFeedItem = {
          type: "poll",
          id: pollSnapshot.id,
          ...(pollSnapshot.data() as Omit<Poll, "id">),
        };
        loadedPollIdsRef.current.add(fetchedPoll.id);
        setFeedItems((current) =>
          sortFeedItems(
            mergeFeedItemsByIdentity(current, [
              ...current.filter(
                (item) => !(item.type === "poll" && item.id === fetchedPoll.id),
              ),
              fetchedPoll,
            ]),
          ),
        );
      })
      .catch((error) => {
        console.error("Error loading older notification poll:", error);
        notificationPollFetchesRef.current.delete(pollId);
      });

    return () => {
      isCancelled = true;
    };
  }, [pendingNotificationTarget?.pollId]);

  const fetchUserRole = useCallback(
    async (userId: string) => {
      if (!auth.currentUser || userRoles[userId] || isOffline) return;
      try {
        const userDoc = await getDoc(doc(db, "students", userId));
        if (userDoc.exists()) {
          const role = userDoc.data()?.role || "student";
          setUserRoles((prev) => ({ ...prev, [userId]: role }));
        }
      } catch (error: any) {
        if (auth.currentUser) console.error("Error fetching user role:", error);
      }
    },
    [userRoles, isOffline],
  );

  // ── Feed listeners (set up once)
  useEffect(() => {
    if (!user || !auth.currentUser || isOffline || listenersSetup.current) {
      if (isOffline) return;
      if (!user && feedItems.length > 0) setFeedItems([]);
      return;
    }

    if (__DEV__) console.log("🔥 Setting up feed listeners");
    listenersSetup.current = true;
    setIsLoading(true);

    lastPostDocRef.current = null;
    lastPollDocRef.current = null;
    postsPaginatedRef.current = false;
    pollsPaginatedRef.current = false;
    hasHydratedPostsRef.current = false;
    hasHydratedPollsRef.current = false;
    lastLivePostIdsRef.current.clear();
    lastLivePollIdsRef.current.clear();
    setStagedPosts([]);
    setStagedPolls([]);
    loadedPostIdsRef.current.clear();
    loadedPollIdsRef.current.clear();
    setHasMorePosts(true);
    setHasMorePolls(true);

    const qPosts = query(
      collection(db, "posts"),
      orderBy("createdAt", "desc"),
      limit(FEED_PAGE_SIZE),
    );
    unsubscribePostsRef.current = onSnapshot(
      qPosts,
      (snapshot) => {
        if (!auth.currentUser) return;
        const fetchedPosts: PostFeedItem[] = snapshot.docs.map((d) => ({
          type: "post" as const,
          id: d.id,
          likeCount: 0,
          commentCount: 0,
          likedBy: [],
          ...d.data(),
        }));
        snapshot.docs.forEach((d) => loadedPostIdsRef.current.add(d.id));
        if (!postsPaginatedRef.current) {
          lastPostDocRef.current =
            snapshot.docs[snapshot.docs.length - 1] ?? null;
          setHasMorePosts(snapshot.size === FEED_PAGE_SIZE);
        }

        fetchedPosts.forEach((post) => {
          if (post.type === "post" && !post.isAnonymous && post.userId) {
            fetchUserRole(post.userId);
          }
        });

        // Hold back anything the reader has not seen while they are scrolled
        // away from the top: injecting it would grow the list above the
        // viewport and slide the post they are reading out from under them.
        // Computed from feedItemsRef (not inside the updater below) so this
        // stays a pure read — setFeedItems updaters must not have effects.
        // "Already seen" has to mean already VISIBLE, not merely present.
        // This query returns pending posts too, and they sit in the list
        // unrendered; counting those as seen is why a post approved while
        // the reader was scrolled down used to slip in with no pill.
        const visiblePostIds = new Set([
          ...feedItemsRef.current
            .filter(
              (item) =>
                item.type === "post" && isDisplayableFeedItem(item, "all"),
            )
            .map((item) => item.id),
          ...lastLivePostIdsRef.current,
        ]);
        const shouldStagePosts =
          hasHydratedPostsRef.current && !isNearFeedTopRef.current;
        const livePosts: PostFeedItem[] = [];
        const heldPosts: PostFeedItem[] = [];
        fetchedPosts.forEach((post) => {
          if (
            shouldStagePosts &&
            isDisplayableFeedItem(post, "all") &&
            !visiblePostIds.has(post.id) &&
            !isOwnFeedItem(post, auth.currentUser?.uid)
          ) {
            heldPosts.push(post);
          } else {
            livePosts.push(post);
          }
        });
        // Same reason: a pending post merged into the list quietly must not
        // be remembered as seen, or its approval would go unannounced.
        lastLivePostIdsRef.current = new Set(
          livePosts
            .filter((post) => isDisplayableFeedItem(post, "all"))
            .map((post) => post.id),
        );
        setStagedPosts((current) =>
          current.length === 0 && heldPosts.length === 0 ? current : heldPosts,
        );
        // Before the first snapshot, the only posts in the list are the
        // offline copy from last time. They are not pages this listener
        // loaded: loadMoreFeed does not know them, and would page the same
        // posts in again as duplicates. So the first snapshot replaces them.
        const isFirstPostsSnapshot = !hasHydratedPostsRef.current;
        hasHydratedPostsRef.current = true;

        setFeedItems((prev) => {
          const polls = prev.filter((item) => item.type === "poll");
          const notificationPostId = pendingNotificationPostIdRef.current;
          const notificationPost = notificationPostId
            ? prev.find(
                (item): item is PostFeedItem =>
                  item.type === "post" && item.id === notificationPostId,
              )
            : undefined;
          // The snapshot is only the newest page; everything loadMoreFeed
          // appended below it has to be carried across or the feed collapses
          // back to one page under the reader. The floor is measured against
          // the whole window (fetchedPosts), not just the part being shown,
          // so staging cannot shift it.
          const olderPosts = isFirstPostsSnapshot
            ? []
            : itemsBelowLiveWindow(prev, "post", fetchedPosts);
          const knownPostIds = new Set(
            [...livePosts, ...olderPosts].map((post) => post.id),
          );
          const posts =
            notificationPost && !knownPostIds.has(notificationPost.id)
              ? [...livePosts, ...olderPosts, notificationPost]
              : [...livePosts, ...olderPosts];
          return mergeFeedItemsByIdentity(
            prev,
            sortFeedItems([...posts, ...polls]),
          );
        });
        setIsLoading(false);
      },
      (error) => {
        if (auth.currentUser) console.error("Error fetching posts:", error);
        setIsLoading(false);
      },
    );

    const qPolls = query(
      collection(db, "polls"),
      orderBy("createdAt", "desc"),
      limit(FEED_PAGE_SIZE),
    );
    unsubscribePollsRef.current = onSnapshot(
      qPolls,
      (snapshot) => {
        if (!auth.currentUser) return;
        const fetchedPolls: PollFeedItem[] = snapshot.docs.map((d) => {
          const pollData = d.data() as Omit<Poll, "id">;
          return {
            type: "poll" as const,
            id: d.id,
            ...pollData,
          };
        });
        snapshot.docs.forEach((d) => loadedPollIdsRef.current.add(d.id));
        if (!pollsPaginatedRef.current) {
          lastPollDocRef.current =
            snapshot.docs[snapshot.docs.length - 1] ?? null;
          setHasMorePolls(snapshot.size === FEED_PAGE_SIZE);
        }

        fetchedPolls.forEach((poll) => {
          if (poll.type === "poll" && !poll.isAnonymous && poll.userId) {
            fetchUserRole(poll.userId);
          }
        });

        // Same rule as posts above: only what the reader can actually see
        // counts as already seen.
        const visiblePollIds = new Set([
          ...feedItemsRef.current
            .filter(
              (item) =>
                item.type === "poll" && isDisplayableFeedItem(item, "all"),
            )
            .map((item) => item.id),
          ...lastLivePollIdsRef.current,
        ]);
        const shouldStagePolls =
          hasHydratedPollsRef.current && !isNearFeedTopRef.current;
        const livePolls: PollFeedItem[] = [];
        const heldPolls: PollFeedItem[] = [];
        fetchedPolls.forEach((poll) => {
          if (
            shouldStagePolls &&
            isDisplayableFeedItem(poll, "all") &&
            !visiblePollIds.has(poll.id) &&
            !isOwnFeedItem(poll, auth.currentUser?.uid)
          ) {
            heldPolls.push(poll);
          } else {
            livePolls.push(poll);
          }
        });
        lastLivePollIdsRef.current = new Set(
          livePolls
            .filter((poll) => isDisplayableFeedItem(poll, "all"))
            .map((poll) => poll.id),
        );
        setStagedPolls((current) =>
          current.length === 0 && heldPolls.length === 0 ? current : heldPolls,
        );
        // As for posts: the first snapshot replaces the offline copy.
        const isFirstPollsSnapshot = !hasHydratedPollsRef.current;
        hasHydratedPollsRef.current = true;

        setFeedItems((prev) => {
          const posts = prev.filter((item) => item.type === "post");
          const notificationPollId = pendingNotificationPollIdRef.current;
          const notificationPoll = notificationPollId
            ? prev.find(
                (item): item is PollFeedItem =>
                  item.type === "poll" && item.id === notificationPollId,
              )
            : undefined;
          const olderPolls = isFirstPollsSnapshot
            ? []
            : itemsBelowLiveWindow(prev, "poll", fetchedPolls);
          const knownPollIds = new Set(
            [...livePolls, ...olderPolls].map((poll) => poll.id),
          );
          const polls =
            notificationPoll && !knownPollIds.has(notificationPoll.id)
              ? [...livePolls, ...olderPolls, notificationPoll]
              : [...livePolls, ...olderPolls];
          return mergeFeedItemsByIdentity(
            prev,
            sortFeedItems([...posts, ...polls]),
          );
        });
      },
      (error) => {
        if (auth.currentUser) console.error("Error fetching polls:", error);
      },
    );

    return undefined;
  }, [user, isOffline, fetchUserRole, feedItems.length]);

  const loadMoreFeed = useCallback(async () => {
    if (isOffline || isLoadingMore || (!hasMorePosts && !hasMorePolls)) return;

    setIsLoadingMore(true);
    try {
      const [postsSnapshot, pollsSnapshot] = await Promise.all([
        hasMorePosts && lastPostDocRef.current
          ? getDocs(
              query(
                collection(db, "posts"),
                orderBy("createdAt", "desc"),
                startAfter(lastPostDocRef.current),
                limit(FEED_PAGE_SIZE),
              ),
            )
          : Promise.resolve(null),
        hasMorePolls && lastPollDocRef.current
          ? getDocs(
              query(
                collection(db, "polls"),
                orderBy("createdAt", "desc"),
                startAfter(lastPollDocRef.current),
                limit(FEED_PAGE_SIZE),
              ),
            )
          : Promise.resolve(null),
      ]);

      const morePosts: PostFeedItem[] = postsSnapshot
        ? postsSnapshot.docs
            .filter((d) => !loadedPostIdsRef.current.has(d.id))
            .map((d) => ({
              type: "post" as const,
              id: d.id,
              likeCount: 0,
              commentCount: 0,
              likedBy: [],
              ...d.data(),
            }))
        : [];
      const morePolls: PollFeedItem[] = pollsSnapshot
        ? pollsSnapshot.docs
            .filter((d) => !loadedPollIdsRef.current.has(d.id))
            .map((d) => ({
              type: "poll" as const,
              id: d.id,
              ...(d.data() as Omit<Poll, "id">),
            }))
        : [];

      postsSnapshot?.docs.forEach((d) => loadedPostIdsRef.current.add(d.id));
      pollsSnapshot?.docs.forEach((d) => loadedPollIdsRef.current.add(d.id));
      if (postsSnapshot) {
        lastPostDocRef.current = postsSnapshot.docs[postsSnapshot.docs.length - 1] ?? lastPostDocRef.current;
        setHasMorePosts(postsSnapshot.size === FEED_PAGE_SIZE);
        postsPaginatedRef.current = true;
      }
      if (pollsSnapshot) {
        lastPollDocRef.current = pollsSnapshot.docs[pollsSnapshot.docs.length - 1] ?? lastPollDocRef.current;
        setHasMorePolls(pollsSnapshot.size === FEED_PAGE_SIZE);
        pollsPaginatedRef.current = true;
      }

      morePosts.forEach((post) => {
        if (!post.isAnonymous && post.userId) fetchUserRole(post.userId);
      });
      morePolls.forEach((poll) => {
        if (!poll.isAnonymous && poll.userId) fetchUserRole(poll.userId);
      });

      if (morePosts.length || morePolls.length) {
        // Anything already in the list is replaced by the fresh copy rather
        // than joined by it: the same key twice makes the list show a post
        // twice (and React warn about it).
        const incomingKeys = new Set(
          [...morePosts, ...morePolls].map((item) => `${item.type}:${item.id}`),
        );
        setFeedItems((prev) =>
          sortFeedItems([
            ...prev.filter((item) => !incomingKeys.has(`${item.type}:${item.id}`)),
            ...morePosts,
            ...morePolls,
          ]),
        );
      }
    } catch (error) {
      console.error("Error loading more feed items:", error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [fetchUserRole, hasMorePolls, hasMorePosts, isLoadingMore, isOffline]);

  // ── Cleanup on logout
  useEffect(() => {
    if (!user && listenersSetup.current) {
      if (__DEV__) console.log("🧹 Cleaning up feed listeners");
      if (unsubscribePostsRef.current) unsubscribePostsRef.current();
      if (unsubscribePollsRef.current) unsubscribePollsRef.current();
      listenersSetup.current = false;
      lastPostDocRef.current = null;
      lastPollDocRef.current = null;
      postsPaginatedRef.current = false;
      pollsPaginatedRef.current = false;
      hasHydratedPostsRef.current = false;
      hasHydratedPollsRef.current = false;
      lastLivePostIdsRef.current.clear();
      lastLivePollIdsRef.current.clear();
      // The feed is emptied below, so the next account starts at the top.
      isNearFeedTopRef.current = true;
      setStagedPosts([]);
      setStagedPolls([]);
      loadedPostIdsRef.current.clear();
      loadedPollIdsRef.current.clear();
      setHasMorePosts(true);
      setHasMorePolls(true);
      setFeedItems([]);
    }
  }, [user]);

  const onRefresh = useCallback(async () => {
    if (isOffline) {
      showInfo(
        "No Connection",
        "Please check your internet connection and try again.",
      );
      return;
    }
    setRefreshing(true);
    fetchSearchableStudents()
      .then(setSearchableStudents)
      .catch(() => undefined);
    try {
      const qPosts = query(
        collection(db, "posts"),
        orderBy("createdAt", "desc"),
        limit(FEED_PAGE_SIZE),
      );
      const qPolls = query(
        collection(db, "polls"),
        orderBy("createdAt", "desc"),
        limit(FEED_PAGE_SIZE),
      );

      const [postsSnapshot, pollsSnapshot] = await Promise.all([
        getDocs(qPosts),
        getDocs(qPolls),
      ]);

      const fetchedPosts: PostFeedItem[] = postsSnapshot.docs.map((d) => ({
        type: "post" as const,
        id: d.id,
        likeCount: 0,
        commentCount: 0,
        likedBy: [],
        ...d.data(),
      }));

      const fetchedPolls: PollFeedItem[] = pollsSnapshot.docs.map((d) => ({
        type: "poll" as const,
        id: d.id,
        ...(d.data() as Omit<Poll, "id">),
      }));

      loadedPostIdsRef.current.clear();
      postsSnapshot.docs.forEach((d) => loadedPostIdsRef.current.add(d.id));
      lastPostDocRef.current =
        postsSnapshot.docs[postsSnapshot.docs.length - 1] ?? null;
      setHasMorePosts(postsSnapshot.size === FEED_PAGE_SIZE);
      // Refresh drops back to a single window, so the cursor is the listener's
      // again until the reader pages further down.
      postsPaginatedRef.current = false;

      loadedPollIdsRef.current.clear();
      pollsSnapshot.docs.forEach((d) => loadedPollIdsRef.current.add(d.id));
      lastPollDocRef.current =
        pollsSnapshot.docs[pollsSnapshot.docs.length - 1] ?? null;
      setHasMorePolls(pollsSnapshot.size === FEED_PAGE_SIZE);
      pollsPaginatedRef.current = false;

      fetchedPosts.forEach((post) => {
        if (!post.isAnonymous && post.userId) fetchUserRole(post.userId);
      });
      fetchedPolls.forEach((poll) => {
        if (!poll.isAnonymous && poll.userId) fetchUserRole(poll.userId);
      });

      setStagedPosts([]);
      setStagedPolls([]);
      isNearFeedTopRef.current = true;

      setFeedItems((prev) => {
        const sorted = sortFeedItems([...fetchedPosts, ...fetchedPolls]);
        return mergeFeedItemsByIdentity(prev, sorted);
      });
    } catch (error) {
      console.error("Error refreshing feed:", error);
    } finally {
      setRefreshing(false);
    }
  }, [fetchUserRole, isOffline]);

  const isPollExpired = useCallback((expiresAt: any) => {
    if (!expiresAt || !expiresAt.toDate) return false;
    return new Date() > expiresAt.toDate();
  }, []);

  const handleLike = useCallback(
    (postId: string, currentLikedBy: string[] = []) => {
      if (!user) return;
      if (isOffline) {
        showInfo("No Connection", "Cannot like posts while offline.");
        return;
      }

      const uid = user.uid;
      const liked = !(getPendingPostLike(postId) ?? currentLikedBy.includes(uid));
      const showLike = (value: boolean) => {
        setFeedItems((previous) =>
          previous.map((item) =>
            item.type === "post" && item.id === postId
              ? withViewerLike(item, uid, value)
              : item,
          ),
        );
        setTrendingPosts((previous) =>
          previous.map((item) =>
            item.id === postId ? withViewerLike(item, uid, value) : item,
          ),
        );
      };

      // Show the like right away; savePostLike writes it in the background.
      showLike(liked);

      const actorName =
        currentUserProfile?.firstname && currentUserProfile?.lastname
          ? `${currentUserProfile.firstname} ${currentUserProfile.lastname}`.trim()
          : user.displayName || user.email?.split("@")[0] || "Someone";

      void savePostLike({
        postId,
        uid,
        liked,
        onChanged: (nowLiked) => {
          const syncNotification = async () => {
            let post: Partial<PostFeedItem> | undefined = feedItemsRef.current.find(
              (item): item is PostFeedItem =>
                item.type === "post" && item.id === postId,
            );
            if (!post) {
              const postSnap = await getDoc(doc(db, "posts", postId));
              post = postSnap.data() as Partial<PostFeedItem> | undefined;
            }
            const postOwnerId = post?.realUserId || post?.userId;

            if (nowLiked) {
              await upsertLikeNotification({
                recipientId: postOwnerId,
                actor: {
                  id: uid,
                  name: actorName,
                  profileImage: currentUserProfile?.profileImage || null,
                },
                entityType: "post",
                entityId: postId,
                preview: post?.content,
              });
            } else {
              await removeLikeNotification({
                recipientId: postOwnerId,
                actorId: uid,
                entityType: "post",
                entityId: postId,
              });
            }
          };
          syncNotification().catch((error) =>
            console.error("Error syncing like notification:", error),
          );
        },
        onFailed: (savedLiked, error) => {
          console.error("Error updating like:", error);
          showLike(savedLiked);
          showInfo("Error", "Failed to like post. Please try again.");
        },
      });
    },
    [currentUserProfile, isOffline, user],
  );

  // ── Scroll to post or poll from notification
  useEffect(() => {
    if (!pendingNotificationTarget?.key) return;
    if (handledNotificationKey === pendingNotificationTarget.key) {
      return;
    }

    if (pendingNotificationTarget.pollId) {
      const pollIndex = visibleFeedItems.findIndex(
        (item) =>
          item.type === "poll" && item.id === pendingNotificationTarget.pollId,
      );
      if (pollIndex < 0) return;

      feedListRef.current?.scrollToIndex({
        index: pollIndex,
        animated: true,
        viewPosition: 0.15,
      });
      const highlightedPollKey = `poll:${pendingNotificationTarget.pollId}`;
      setHighlightedFeedKey(highlightedPollKey);
      setTimeout(() => {
        setHighlightedFeedKey((current) =>
          current === highlightedPollKey ? null : current,
        );
      }, 3500);
      setHandledNotificationKey(pendingNotificationTarget.key);
      return;
    }

    if (!pendingNotificationTarget.postId) return;

    const targetPost = feedItems.find(
      (item) =>
        item.type === "post" && item.id === pendingNotificationTarget.postId,
    );
    if (!targetPost) return;

    if (targetPost.serverId && targetPost.channelId) {
      router.push({
        pathname: "/ServerChannelScreen",
        params: {
          serverId: targetPost.serverId,
          channelId: targetPost.channelId,
        },
      });
      setHandledNotificationKey(pendingNotificationTarget.key);
      return;
    }

    const postIndex = visibleFeedItems.findIndex(
      (item) =>
        item.type === "post" && item.id === pendingNotificationTarget.postId,
    );
    if (postIndex < 0) return;

    feedListRef.current?.scrollToIndex({
      index: postIndex,
      animated: true,
      viewPosition: 0.15,
    });

    setHighlightedPostId(pendingNotificationTarget.postId);
    setTimeout(() => setHighlightedPostId(null), 3500);

    if (pendingNotificationTarget.commentId) {
      setNotificationModalPostId(pendingNotificationTarget.postId);
      setNotificationModalCommentId(pendingNotificationTarget.commentId);
      setNotificationModalReplyId(
        pendingNotificationTarget.replyId || null,
      );
      setNotificationModalOpenReply(
        pendingNotificationTarget.openReplyThread,
      );
    }

    setHandledNotificationKey(pendingNotificationTarget.key);
  }, [
    feedItems,
    handledNotificationKey,
    pendingNotificationTarget,
    router,
    visibleFeedItems,
  ]);

  const handlePollVote = useCallback(
    async (pollId: string, optionIndex: number) => {
      if (!user) return;
      if (isOffline) {
        showInfo("No Connection", "Cannot vote while offline.");
        return;
      }

      const pollRef = doc(db, "polls", pollId);
      const poll = feedItemsRef.current.find(
        (item): item is PollFeedItem =>
          item.id === pollId && item.type === "poll",
      );
      if (!poll) return;

      const userVotes = poll.options
        .map((opt, idx) => (opt.voters?.includes(user.uid) ? idx : -1))
        .filter((idx) => idx !== -1);

      const expired = isPollExpired(poll.expiresAt);
      if (expired) return;
      if (!poll.allowMultiple && userVotes.length > 0) return;
      if (userVotes.includes(optionIndex)) return;
      if (poll.allowMultiple && userVotes.length >= poll.maxSelections) return;

      try {
        const updatedOptions: PollOption[] = poll.options.map((opt, idx) => {
          const voters = Array.isArray(opt.voters) ? [...opt.voters] : [];
          if (idx === optionIndex && !voters.includes(user.uid)) {
            voters.push(user.uid);
          }
          return { ...opt, voters, votes: voters.length };
        });

        const totalVotes = updatedOptions.reduce(
          (s, o) => s + (o.votes || 0),
          0,
        );
        await updateDoc(pollRef, { options: updatedOptions, totalVotes });
      } catch (error) {
        console.error("Error voting on poll:", error);
        showInfo("Error", "Failed to vote. Please try again.");
      }
    },
    [isOffline, isPollExpired, user],
  );

  const addOptionToPoll = useCallback(
    async (pollId: string, text: string) => {
      try {
        if (!text.trim()) {
          showInfo("Error", "Option cannot be empty.");
          return;
        }

        const pollRef = doc(db, "polls", pollId);
        const pollSnap = await getDoc(pollRef);

        if (!pollSnap.exists()) {
          showInfo("Error", "Poll not found.");
          return;
        }

        const poll = pollSnap.data() as Poll;
        if (isPollExpired(poll.expiresAt)) {
          showInfo("Error", "This poll has already expired.");
          return;
        }

        const newOption: PollOption = {
          text: text.trim(),
          votes: 0,
          voters: [],
        };
        const updatedOptions = [...poll.options, newOption];
        const totalVotes = updatedOptions.reduce(
          (sum, opt) => sum + (opt.votes || 0),
          0,
        );
        await updateDoc(pollRef, { options: updatedOptions, totalVotes });
        showInfo("Success", "Option added! You can vote for it manually.", undefined, "success");
      } catch (error) {
        console.error("Error adding option:", error);
        showInfo("Error", "Failed to add option. Please try again.");
      }
    },
    [isPollExpired],
  );

  // ── FAB
  const toggleFabMenu = () => {
    if (fabMenuVisible) {
      Animated.parallel([
        Animated.timing(menuScale, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(menuOpacity, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(fabRotation, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start(() => setFabMenuVisible(false));
    } else {
      setFabMenuVisible(true);
      menuScale.setValue(0.3);
      menuOpacity.setValue(0);
      Animated.parallel([
        Animated.timing(menuScale, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(menuOpacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(fabRotation, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
    }
  };

  const handleScroll = (event: any) => {
    const currentOffsetY = event.nativeEvent.contentOffset.y;
    const delta = currentOffsetY - scrollY.current;

    // Animate only when the direction actually changes. `delta > 5` holds on
    // nearly every event of a continuous scroll, so these timings used to be
    // restarted many times a second while the list was trying to draw rows.
    if (delta > 5 && scrollDirectionRef.current !== "down") {
      scrollDirectionRef.current = "down";
      Animated.parallel([
        Animated.timing(fabTranslateY, {
          toValue: 150,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(menuTranslateY, {
          toValue: 150,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(menuOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }

    if (delta < -5 && scrollDirectionRef.current !== "up") {
      scrollDirectionRef.current = "up";
      Animated.parallel([
        Animated.timing(fabTranslateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(menuTranslateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(menuOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }

    // Drives the pill: inside FEED_TOP_MERGE_OFFSET the reader is looking at
    // the newest posts, so arrivals can merge without disturbing anything.
    isNearFeedTopRef.current = currentOffsetY <= FEED_TOP_MERGE_OFFSET;
    scrollY.current = currentOffsetY;
  };

  const openSearchExperience = useCallback(() => {
    setSearchExpanded(true);
  }, []);

  // The search state itself lives in HomeSearchProvider, which clears it
  // whenever search closes.
  const closeSearchExperience = useCallback(() => {
    setSearchExpanded(false);
  }, []);

  const closeServerDrawer = useCallback(() => {
    setServerDrawerVisible(false);
  }, []);

  const handleSelectServer = useCallback((serverId: string) => {
    setSelectedServerId(serverId);
  }, []);

const handleSelectChannel = useCallback(
    (channelId: string) => {
      setSelectedChannelId(channelId);

      const server = communityServers.find((item) => item.id === selectedServerId);
      if (!server) return;

      const channel = server.sections
        ?.flatMap((section) => section.channels ?? [])
        .find((item) => item.id === channelId);

      if (!channel) return;

      // Check access for non-public servers
      if (server.isPublic !== true && server.membershipState !== "joined") {
        showInfo(
          "Access Denied",
          "This server requires approval or membership to access."
        );
        return;
      }

      setServerDrawerVisible(false);

      router.push({
        pathname: "/ServerChannelScreen",
        params: {
          serverId: server.id,
          channelId: channel.id,
          serverName: server.name,
          serverAccent: server.accent,
          channelLabel: channel.label,
        },
      });
    },
    [communityServers, router, selectedServerId]
  );

  // ── Create server (admin only — guard also in ServerDrawer via canCreateServer)
  const handleCreateServer = useCallback(
    async (
      name: string,
      description?: string,
      accent?: string,
      isPublic?: boolean,
      emoji?: string,
      logoUri?: string,
      titleColor?: string,
      titleSize?: number,
      titleAlign?: "left" | "center" | "right",
      titleEdge?: "none" | "subtle" | "strong",
      titleStroke?: "none" | "subtle" | "medium" | "strong",
      titleStrokeColor?: string,
      titleStrokeSize?: number,
      descriptionSize?: number,
    ) => {
      if (!user?.uid) return;
      if (isOffline) {
        showInfo("No Connection", "You need internet access to create a server.");
        return;
      }

      const nextServer = makeCustomCommunityServerDraft(
        name,
        description,
        accent,
        emoji,
      );

      await setDoc(doc(db, "communityServers", nextServer.id), stripUndefined({
        ...nextServer,
        channelAccess: buildChannelAccess(nextServer.sections),
        // App-wide search: lowercased name for the prefix-range query.
        nameLower: (name || nextServer.name || "").trim().toLowerCase(),
        description: description?.trim() || "",
        accent: accent || nextServer.accent,
        emoji: emoji || nextServer.emoji,
        logoUri: logoUri || null,
        titleColor: titleColor || theme.surface,
        titleSize: titleSize || 22,
        titleAlign: titleAlign || "left",
        titleEdge: titleEdge || "none",
        titleStroke: titleStroke || "none",
        titleStrokeColor: titleStrokeColor || "#000000",
        titleStrokeSize: titleStrokeSize ?? 0,
        descriptionSize: descriptionSize || 13,
        isPublic: isPublic ?? true,
        requiresApproval: true,
        createdBy: user.uid,
        ownerId: user.uid,
        memberCount: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }));

      await setDoc(
        doc(db, "communityServerMemberships", `${nextServer.id}_${user.uid}`),
        {
          serverId: nextServer.id,
          userId: user.uid,
          status: "joined",
          joinedAt: serverTimestamp(),
        },
      );

      setSelectedServerId(nextServer.id);
    },
    [isOffline, stripUndefined, user?.uid],
  );

  // ── Edit server (admin only)
  const handleEditServer = useCallback(
    async (serverId: string, patch: Partial<ServerEditPatch>) => {
      if (isOffline) {
        showInfo("No Connection", "You need internet access to update this server.");
        return;
      }

      const updatePayload: Record<string, unknown> = {
        updatedAt: serverTimestamp(),
      };

      if (patch.name !== undefined) {
        updatePayload.name = patch.name.trim();
        // App-wide search: keep the lowercased name in step with edits.
        updatePayload.nameLower = patch.name.trim().toLowerCase();
      }
      if (patch.description !== undefined) {
        updatePayload.description = patch.description.trim();
      }
      if (patch.accent !== undefined) updatePayload.accent = patch.accent;
      if (patch.isPublic !== undefined) updatePayload.isPublic = patch.isPublic;
      if (patch.logoUri !== undefined) updatePayload.logoUri = patch.logoUri;
      if (patch.titleColor !== undefined) updatePayload.titleColor = patch.titleColor;
      if (patch.titleSize !== undefined) updatePayload.titleSize = patch.titleSize;
      if (patch.titleAlign !== undefined) updatePayload.titleAlign = patch.titleAlign;
      if (patch.titleEdge !== undefined) {
       updatePayload.titleEdge = patch.titleEdge;
      }
      if (patch.titleStroke !== undefined) {
      updatePayload.titleStroke = patch.titleStroke;
      }
      if (patch.titleStrokeColor !== undefined) {
      updatePayload.titleStrokeColor = patch.titleStrokeColor;
      }
      if (patch.titleStrokeSize !== undefined) {
        updatePayload.titleStrokeSize = patch.titleStrokeSize;
      }
      if (patch.descriptionSize !== undefined) {
      updatePayload.descriptionSize = patch.descriptionSize;
      }
      if ((patch as { emoji?: string }).emoji !== undefined) {
        updatePayload.emoji = (patch as { emoji?: string }).emoji;
      }

      await setDoc(doc(db, "communityServers", serverId), updatePayload, {
        merge: true,
      });
    },
    [isOffline],
  );

  // ── Delete server (admin only)
  const handleDeleteServer = useCallback(
    async (serverId: string) => {
      if (isOffline) {
        showInfo("No Connection", "You need internet access to delete this server.");
        return;
      }

      await setDoc(
        doc(db, "communityServers", serverId),
        {
          isDeleted: true,
          deletedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setSelectedServerId((current) => (current === serverId ? null : current));
    },
    [isOffline],
  );

  // Task 6: a teacher/moderator managing a server asks an admin to delete it,
  // instead of the unilateral soft-delete above. Mirrors handleRequestJoin's
  // setDoc-merge shape; the server stays live until an admin approves.
  const handleRequestServerDeletion = useCallback(
    async (serverId: string, reason: string) => {
      if (!user?.uid) return;
      if (isOffline) {
        showInfo("No Connection", "You need internet access to send this request.");
        return;
      }

      const server = remoteServers.find((item) => item.id === serverId);
      const requesterName =
        currentUserProfile?.firstname && currentUserProfile?.lastname
          ? `${currentUserProfile.firstname} ${currentUserProfile.lastname}`.trim()
          : user.displayName || user.email?.split("@")[0] || "A teacher";

      const requestRef = doc(
        db,
        "communityServerDeletionRequests",
        `${serverId}_${user.uid}`,
      );
      // Re-submitting after a previous rejection: clear the old (resolved)
      // request first so this is a clean create, not an update the rule
      // deliberately doesn't allow the requester to make.
      await deleteDoc(requestRef).catch(() => undefined);
      await setDoc(requestRef, {
        serverId,
        serverName: server?.name || "this server",
        requestedBy: user.uid,
        requesterName,
        reason: reason || null,
        status: "pending",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      showInfo(
        "Request Sent",
        "An admin will review your request to delete this server. It stays active until then.",
        undefined,
        "success",
      );
    },
    [
      currentUserProfile?.firstname,
      currentUserProfile?.lastname,
      isOffline,
      remoteServers,
      user?.displayName,
      user?.uid,
    ],
  );

  const handleCreateThread = useCallback(
    async (
      serverId: string,
      label: string,
      emoji = "💬",
      description?: string,
      channelType: ChannelType = "text",
    ) => {
      if (isOffline) {
        showInfo("No Connection", "You need internet access to create a channel.");
        return;
      }

      const server = remoteServers.find((item) => item.id === serverId);
      if (!server) return;

      const nextSections = appendThreadToSections(
        server.sections,
        serverId,
        label,
        emoji,
        description,
        channelType,
      );

      // The channel list and each channel's type, saved together; the
      // database rules read the types to decide who may post. Replaced whole,
      // so a deleted channel leaves nothing behind.
      await setDoc(
        doc(db, "communityServers", serverId),
        {
          sections: nextSections,
          channelAccess: buildChannelAccess(nextSections),
          updatedAt: serverTimestamp(),
        },
        { mergeFields: ["sections", "channelAccess", "updatedAt"] },
      );
    },
    [isOffline, remoteServers],
  );

  const handleEditChannel = useCallback(
    async (
      serverId: string,
      channelId: string,
      updates: {
        label?: string;
        emoji?: string;
        hint?: string;
        channelType?: ChannelType;
      },
    ) => {
      if (isOffline) {
        showInfo("No Connection", "You need internet access to edit a channel.");
        return;
      }

      const server = remoteServers.find((item) => item.id === serverId);
      if (!server) return;

      const nextSections = updateChannelInSections(
        server.sections,
        serverId,
        channelId,
        updates,
      );

      // The channel list and each channel's type, saved together; the
      // database rules read the types to decide who may post. Replaced whole,
      // so a deleted channel leaves nothing behind.
      await setDoc(
        doc(db, "communityServers", serverId),
        {
          sections: nextSections,
          channelAccess: buildChannelAccess(nextSections),
          updatedAt: serverTimestamp(),
        },
        { mergeFields: ["sections", "channelAccess", "updatedAt"] },
      );
    },
    [isOffline, remoteServers],
  );

  const handleDeleteChannel = useCallback(
    async (serverId: string, channelId: string) => {
      if (isOffline) {
        showInfo("No Connection", "You need internet access to delete a channel.");
        return;
      }

      const server = remoteServers.find((item) => item.id === serverId);
      if (!server) return;

      const nextSections = deleteChannelFromSections(
        server.sections,
        serverId,
        channelId,
      );

      // The channel list and each channel's type, saved together; the
      // database rules read the types to decide who may post. Replaced whole,
      // so a deleted channel leaves nothing behind.
      await setDoc(
        doc(db, "communityServers", serverId),
        {
          sections: nextSections,
          channelAccess: buildChannelAccess(nextSections),
          updatedAt: serverTimestamp(),
        },
        { mergeFields: ["sections", "channelAccess", "updatedAt"] },
      );

      if (selectedChannelId === channelId) {
        const remaining = nextSections.flatMap((s) => s.channels);
        setSelectedChannelId(remaining[0]?.id || null);
      }
    },
    [isOffline, remoteServers, selectedChannelId],
  );

  const handleRequestJoin = useCallback(
    async (serverId: string) => {
      if (!user?.uid) return;
      if (isOffline) {
        showInfo("No Connection", "You need internet access to request access.");
        return;
      }

      const requesterName =
        currentUserProfile?.firstname && currentUserProfile?.lastname
          ? `${currentUserProfile.firstname} ${currentUserProfile.lastname}`.trim()
          : user.displayName || user.email?.split("@")[0] || "Student";

      await setDoc(
        doc(db, "communityServerJoinRequests", `${serverId}_${user.uid}`),
        {
          serverId,
          userId: user.uid,
          status: "pending",
          requestedByRole: currentUserRole || "student",
          requesterName,
          course: currentUserProfile?.course || null,
          yearLevel: currentUserProfile?.yearlvl || null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      showInfo(
        "Request Sent",
        "A teacher, moderator, or admin can approve your request.",
        undefined,
        "success",
      );
    },
    [
      currentUserProfile?.course,
      currentUserProfile?.firstname,
      currentUserProfile?.lastname,
      currentUserRole,
      isOffline,
      user?.displayName,
      user?.email,
      user?.uid,
    ],
  );

  const handleTogglePinnedPost = useCallback(
    async (postId: string, shouldPin: boolean) => {
      if (!user?.uid) return;
      if (!["admin", "teacher", "moderator"].includes(currentUserRole || "")) {
        return;
      }

      const existingPost = feedItemsRef.current.find(
        (item): item is PostFeedItem => item.type === "post" && item.id === postId,
      );
      const previousPinnedAt = existingPost?.pinnedAt ?? null;
      const previousPinnedBy = existingPost?.pinnedBy ?? null;

      try {
        setFeedItems((currentItems) =>
          sortFeedItems(
            currentItems.map((item) =>
              item.type === "post" && item.id === postId
                ? {
                    ...item,
                    pinnedAt: shouldPin
                      ? {
                          toMillis: () => Date.now(),
                        }
                      : null,
                    pinnedBy: shouldPin ? user.uid : null,
                    ...(!shouldPin
                      ? { pinExpiresAt: null, targetDate: null, targetDateLabel: null }
                      : {}),
                  }
                : item,
            ),
          ),
        );

        const updatePayload: Record<string, any> = {
          pinnedAt: shouldPin ? serverTimestamp() : null,
          pinnedBy: shouldPin ? user.uid : null,
        };
        if (!shouldPin) {
          updatePayload.pinExpiresAt = null;
          updatePayload.targetDate = null;
          updatePayload.targetDateLabel = null;
        }

        await updateDoc(doc(db, "posts", postId), updatePayload);
      } catch (error) {
        console.error("Error updating pinned post:", error);
        setFeedItems((currentItems) =>
          sortFeedItems(
            currentItems.map((item) =>
              item.type === "post" && item.id === postId
                ? {
                    ...item,
                    pinnedAt: previousPinnedAt,
                    pinnedBy: previousPinnedBy,
                  }
                : item,
            ),
          ),
        );
        showInfo("Error", "Failed to update the pinned post.");
      }
    },
    [currentUserRole, user?.uid],
  );

  // The same as pinning a post: staff only, optimistic, rolled back on error.
  const handleTogglePinnedPoll = useCallback(
    async (pollId: string, shouldPin: boolean) => {
      if (!user?.uid) return;
      if (!["admin", "teacher", "moderator"].includes(currentUserRole || "")) {
        return;
      }

      const existingPoll = feedItemsRef.current.find(
        (item): item is PollFeedItem => item.type === "poll" && item.id === pollId,
      );
      const previousPinnedAt = existingPoll?.pinnedAt ?? null;
      const previousPinnedBy = existingPoll?.pinnedBy ?? null;

      try {
        setFeedItems((currentItems) =>
          sortFeedItems(
            currentItems.map((item) =>
              item.type === "poll" && item.id === pollId
                ? {
                    ...item,
                    pinnedAt: shouldPin ? { toMillis: () => Date.now() } : null,
                    pinnedBy: shouldPin ? user.uid : null,
                    ...(!shouldPin ? { pinExpiresAt: null } : {}),
                  }
                : item,
            ),
          ),
        );

        await updateDoc(doc(db, "polls", pollId), {
          pinnedAt: shouldPin ? serverTimestamp() : null,
          pinnedBy: shouldPin ? user.uid : null,
          ...(!shouldPin ? { pinExpiresAt: null } : {}),
        });
        showAppToast({ message: shouldPin ? "Poll pinned to the top of the feed" : "Poll unpinned" });
      } catch (error) {
        console.error("Error updating pinned poll:", error);
        setFeedItems((currentItems) =>
          sortFeedItems(
            currentItems.map((item) =>
              item.type === "poll" && item.id === pollId
                ? { ...item, pinnedAt: previousPinnedAt, pinnedBy: previousPinnedBy }
                : item,
            ),
          ),
        );
        showInfo("Error", "Failed to update the pinned poll.");
      }
    },
    [currentUserRole, user?.uid],
  );

  const handleApproveJoinRequest = useCallback(
    async (serverId: string, targetUserId: string) => {
      if (!user?.uid) return;
      if (isOffline) {
        showInfo("No Connection", "You need internet access to approve requests.");
        return;
      }

      const approverJoined = serverMemberships.some(
        (membership) =>
          membership.serverId === serverId &&
          membership.userId === user.uid &&
          membership.status !== "removed",
      );
      const canApprove =
        currentUserRole === "admin" ||
        (["teacher", "moderator"].includes(currentUserRole || "") && approverJoined);

      if (!canApprove) {
        showInfo(
          "Approval Restricted",
          "Join this server first before approving requests.",
        );
        return;
      }

      const membershipRef = doc(
        db,
        "communityServerMemberships",
        `${serverId}_${targetUserId}`,
      );
      const membershipSnap = await getDoc(membershipRef);

      if (!membershipSnap.exists()) {
        await setDoc(membershipRef, {
          serverId,
          userId: targetUserId,
          status: "joined",
          joinedAt: serverTimestamp(),
          approvedBy: user.uid,
        });
        await updateDoc(doc(db, "communityServers", serverId), {
          memberCount: increment(1),
          updatedAt: serverTimestamp(),
        });
      }

      await setDoc(
        doc(db, "communityServerJoinRequests", `${serverId}_${targetUserId}`),
        {
          serverId,
          userId: targetUserId,
          status: "approved",
          approvedBy: user.uid,
          approvedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    },
    [currentUserRole, isOffline, serverMemberships, user?.uid],
  );

  const handleRejectJoinRequest = useCallback(
    async (serverId: string, targetUserId: string) => {
      if (!user?.uid) return;
      if (isOffline) {
        showInfo("No Connection", "You need internet access to reject requests.");
        return;
      }

      const approverJoined = serverMemberships.some(
        (membership) =>
          membership.serverId === serverId &&
          membership.userId === user.uid &&
          membership.status !== "removed",
      );
      const canReject =
        currentUserRole === "admin" ||
        (["teacher", "moderator"].includes(currentUserRole || "") && approverJoined);

      if (!canReject) {
        showInfo(
          "Approval Restricted",
          "Join this server first before rejecting requests.",
        );
        return;
      }

      await setDoc(
        doc(db, "communityServerJoinRequests", `${serverId}_${targetUserId}`),
        {
          serverId,
          userId: targetUserId,
          status: "rejected",
          rejectedBy: user.uid,
          rejectedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    },
    [currentUserRole, isOffline, serverMemberships, user?.uid],
  );

  const handleLeaveServer = useCallback(
    async (serverId: string) => {
      if (!user?.uid) return;
      if (currentUserRole === "admin") {
        showInfo("Unavailable", "Admins cannot leave servers.");
        return;
      }
      if (isOffline) {
        showInfo("No Connection", "You need internet access to leave this server.");
        return;
      }

      showConfirm({
        title: "Leave Server",
        description: "You will lose access to this server until you join again.",
        confirmText: "Leave",
        cancelText: "Cancel",
        destructive: true,
        onConfirm: async () => {
          const membershipRef = doc(
            db,
            "communityServerMemberships",
            `${serverId}_${user.uid}`,
          );
          const membershipSnap = await getDoc(membershipRef);

          if (membershipSnap.exists() && membershipSnap.data()?.status !== "removed") {
            await setDoc(
              membershipRef,
              {
                serverId,
                userId: user.uid,
                status: "removed",
                removedAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              },
              { merge: true },
            );

            await updateDoc(doc(db, "communityServers", serverId), {
              memberCount: increment(-1),
              updatedAt: serverTimestamp(),
            });
          }

          if (selectedServerId === serverId) {
            exitServerView();
          }
        },
      });
    },
    [currentUserRole, exitServerView, isOffline, selectedServerId, user?.uid],
  );

  // ── Adding and removing members ──────────────────────────────────────────
  // How anybody gets into a private server: students can't see one to ask,
  // so its managers add them. Works on public servers too, as a shortcut past
  // approving requests one at a time. Same people as approval: admins, the
  // owner, and teachers or moderators who have joined.
  const handleAddServerMembers = useCallback(
    async (serverId: string, userIds: string[]): Promise<boolean> => {
      if (!user?.uid) return false;
      if (isOffline) {
        showInfo("No Connection", "You need internet access to add members.");
        return false;
      }
      const server = communityServers.find((item) => item.id === serverId);
      if (!server?.canManage) {
        showInfo("Not Allowed", "Only this server's managers can add members.");
        return false;
      }

      const alreadyIn = new Set(
        serverMemberships
          .filter((membership) => membership.serverId === serverId && membership.status !== "removed")
          .map((membership) => membership.userId),
      );
      const toAdd = [...new Set(userIds)].filter((id) => id && !alreadyIn.has(id));
      if (toAdd.length === 0) return true;

      const askedToJoin = new Set(
        serverJoinRequests
          .filter((request) => request.serverId === serverId)
          .map((request) => request.userId),
      );

      const batch = writeBatch(db);
      for (const memberId of toAdd) {
        batch.set(
          doc(db, "communityServerMemberships", `${serverId}_${memberId}`),
          {
            serverId,
            userId: memberId,
            status: "joined",
            joinedAt: serverTimestamp(),
            approvedBy: user.uid,
            addedBy: user.uid,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
        // Adding somebody answers the request they sent, so it doesn't sit
        // in Join Requests afterwards.
        if (askedToJoin.has(memberId)) {
          batch.set(
            doc(db, "communityServerJoinRequests", `${serverId}_${memberId}`),
            {
              status: "approved",
              approvedBy: user.uid,
              approvedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        }
      }

      try {
        await batch.commit();
      } catch (error) {
        console.error("Adding server members failed:", error);
        showInfo("Could Not Add Members", "Check your connection and try again.");
        return false;
      }

      // Separate from the batch: a built-in server has no document of its
      // own to count on, and that must not undo the memberships above.
      updateDoc(doc(db, "communityServers", serverId), {
        memberCount: increment(toAdd.length),
        updatedAt: serverTimestamp(),
      }).catch(() => undefined);

      // Each person is told where they were added; tapping it opens the
      // server's general channel.
      const channels = (server.sections || []).flatMap((section) => section.channels || []);
      const entryChannel =
        channels.find((channel) => channel.id === `${serverId}_general` || channel.label === "general") ||
        channels[0];
      const actorName =
        `${currentUserProfile?.firstname || ""} ${currentUserProfile?.lastname || ""}`.trim() ||
        user.displayName ||
        "A staff member";
      toAdd.forEach((memberId) => {
        createNotification({
          recipientId: memberId,
          actor: {
            id: user.uid,
            name: actorName,
            profileImage: resolveAvatarUri(currentUserProfile),
          },
          type: "activity",
          entityType: "thread_message",
          entityId: serverId,
          parentId: serverId,
          channelId: entryChannel?.id ?? null,
          message: `added you to ${server.name}`,
          preview: `Added you to ${server.name}`,
        }).catch((error) => console.warn("Member-added notification failed:", error));
      });

      showInfo(
        toAdd.length === 1 ? "Member Added" : "Members Added",
        `${toAdd.length === 1 ? "1 person was" : `${toAdd.length} people were`} added to ${server.name}.`,
        undefined,
        "success",
      );
      return true;
    },
    [
      communityServers,
      currentUserProfile,
      isOffline,
      serverJoinRequests,
      serverMemberships,
      user?.displayName,
      user?.uid,
    ],
  );

  const handleRemoveServerMember = useCallback(
    async (serverId: string, memberId: string) => {
      if (!user?.uid) return;
      if (isOffline) {
        showInfo("No Connection", "You need internet access to remove members.");
        return;
      }
      const server = communityServers.find((item) => item.id === serverId);
      if (!server?.canManage) {
        showInfo("Not Allowed", "Only this server's managers can remove members.");
        return;
      }
      if (memberId === user.uid) {
        showInfo("Use Leave Server", "To leave this server yourself, use Leave Server.");
        return;
      }
      if (memberId === server.ownerId) {
        showInfo("Not Allowed", "The server's owner can't be removed.");
        return;
      }
      const wasMember = serverMemberships.some(
        (membership) =>
          membership.serverId === serverId &&
          membership.userId === memberId &&
          membership.status !== "removed",
      );
      if (!wasMember) return;

      try {
        await setDoc(
          doc(db, "communityServerMemberships", `${serverId}_${memberId}`),
          {
            serverId,
            userId: memberId,
            status: "removed",
            removedAt: serverTimestamp(),
            removedBy: user.uid,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      } catch (error) {
        console.error("Removing server member failed:", error);
        showInfo("Could Not Remove", "Check your connection and try again.");
        return;
      }
      updateDoc(doc(db, "communityServers", serverId), {
        memberCount: increment(-1),
        updatedAt: serverTimestamp(),
      }).catch(() => undefined);
      // Otherwise the server just disappears from their list with no word why.
      createServerRemovalNotification({
        recipientId: memberId,
        remover: {
          id: user.uid,
          name:
            `${currentUserProfile?.firstname || ""} ${currentUserProfile?.lastname || ""}`.trim() ||
            user.displayName ||
            "A server manager",
          profileImage: resolveAvatarUri(currentUserProfile),
        },
        serverName: server.name,
      }).catch((error) => console.warn("Member-removed notification failed:", error));
    },
    [communityServers, currentUserProfile, isOffline, serverMemberships, user],
  );

  const handleMenuAction = (action: string) => {
    if (isOffline) {
      showInfo("No Connection", "Cannot create posts while offline.");
      return;
    }
    toggleFabMenu();

    if (action === "create") {
      router.push("/CreatePostScreen");
    } else if (action === "polls") {
      router.push("/CreatePollScreen");
    } else if (action === "live") {
      // Streams belong to the campus feed, not to a server channel, so no
      // server context is carried across.
      router.push("/GoLiveScreen");
    }
  };

  const handleProfileClick = useCallback(
    (userId?: string, isAnonymous?: boolean, profileDocId?: string) => {
      if (isAnonymous || (!userId && !profileDocId) || userId === "anonymous") return;
      const ownProfileTargets = new Set(
        [
          user?.uid,
          getStudentDocIdFromAuthUser(user),
          currentUserProfile?.studentID,
          currentUserProfile?.userId,
        ].filter(Boolean) as string[],
      );
      const resolvedTargetId = userId || profileDocId;

      if (resolvedTargetId && ownProfileTargets.has(resolvedTargetId)) {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo: HOME_RETURN_ROUTE },
        });
      } else {
        router.push(
          buildUserProfileHref({
            userId: userId || undefined,
            profileDocId: profileDocId || undefined,
            returnTo: HOME_RETURN_ROUTE,
          }) as any,
        );
      }
    },
    [currentUserProfile?.studentID, router, user],
  );

  const handleOpenUserProfileFromDrawer = useCallback(
    (userId?: string, profileDocId?: string) => {
      handleProfileClick(userId, false, profileDocId);
    },
    [handleProfileClick],
  );

  const openImageViewer = useCallback(
    (images: string[], startIndex: number, postId?: string) => {
      setCurrentImages(images);
      setCurrentImageIndex(startIndex);
      setCurrentImageViewerPostId(postId ?? null);
      setImageViewerVisible(true);
    },
    [],
  );

  // Looked up live (not snapshotted at open-time) so the fullscreen viewer's
  // like/comment counts and heart state always reflect the same data the
  // feed itself is showing — including changes made from the feed while the
  // viewer is open.
  const currentImageViewerPost = useMemo(
    () =>
      currentImageViewerPostId
        ? feedItems.find(
            (item): item is PostFeedItem =>
              item.type === "post" && item.id === currentImageViewerPostId,
          )
        : undefined,
    [feedItems, currentImageViewerPostId],
  );

  const handleImageViewerLike = useCallback(() => {
    if (!currentImageViewerPost) return;
    handleLike(currentImageViewerPost.id, currentImageViewerPost.likedBy || []);
  }, [currentImageViewerPost, handleLike]);

  const handleImageViewerComment = useCallback(() => {
    if (!currentImageViewerPost) return;
    setImageViewerVisible(false);
    // Reuses the same CommentModal instance/state already wired up for
    // notification deep-links (see "Comment Modal (from notification)"
    // below) instead of mounting a second CommentModal.
    setNotificationModalPostId(currentImageViewerPost.id);
    setNotificationModalCommentId(null);
    setNotificationModalReplyId(null);
    setNotificationModalOpenReply(false);
  }, [currentImageViewerPost]);

  // Stable reference so PostCard's React.memo isn't defeated by a fresh
  // inline closure on every renderFeedItem call (all useState setters are
  // stable, so no deps are needed).
  const handleFeedCommentPress = useCallback((postId: string) => {
    setNotificationModalPostId(postId);
    setNotificationModalCommentId(null);
    setNotificationModalReplyId(null);
    setNotificationModalOpenReply(false);
  }, []);

  const handleFilePress = useCallback(
    (url: string, mimeType: string) => {
      if (mimeType.startsWith("image/")) {
        openImageViewer([url], 0);
      } else {
        let fileUrl = url;
        if (mimeType.includes("pdf") && url.includes("cloudinary.com")) {
          fileUrl = url.replace("/upload/", "/upload/fl_attachment/");
        }
        Linking.canOpenURL(fileUrl)
          .then((supported) => {
            if (supported) {
              Linking.openURL(fileUrl);
            } else {
              showInfo(
                "Cannot Open File",
                "Unable to open this file type on your device.",
              );
            }
          })
          .catch((err) => {
            console.error("Error opening URL:", err);
            showInfo("Error", "Failed to open file. Please try again.");
          });
      }
    },
    [openImageViewer],
  );

  const handlePostCardProfileClick = useCallback(
    (targetId?: string) => {
      if (targetId === "self") {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo: HOME_RETURN_ROUTE },
        });
      } else if (targetId) {
        router.push(
          targetId.startsWith("/UserProfileScreen?")
            ? `${targetId}${targetId.includes("?") ? "&" : "?"}returnTo=${encodeURIComponent(HOME_RETURN_ROUTE)}`
            : (buildUserProfileHref({ userId: targetId, returnTo: HOME_RETURN_ROUTE }) as any),
        );
      }
    },
    [router],
  );

  const handlePostCardTagClick = useCallback(
    (taggedUserId: string) => {
      if (taggedUserId === user?.uid) {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo: HOME_RETURN_ROUTE },
        });
      } else {
        router.push(
          buildUserProfileHref({ userId: taggedUserId, returnTo: HOME_RETURN_ROUTE }) as any,
        );
      }
    },
    [router, user?.uid],
  );

  // Opens a result tapped in HomeSearchProvider. Returns false when the item
  // is no longer in the feed, so search stays open and the query isn't saved.
  const openSearchResult = useCallback(
    (result: SearchResult) => {
      if (result.kind === "person") {
        closeSearchExperience();

        const ownProfileTargets = new Set(
          [
            user?.uid,
            getStudentDocIdFromAuthUser(user),
            currentUserProfile?.studentID,
            currentUserProfile?.userId,
          ].filter(Boolean) as string[],
        );
        const targetUserId = result.userId || result.sourceId;
        const targetProfileDocId = result.profileDocId;

        if (
          ownProfileTargets.has(targetUserId) ||
          (!!targetProfileDocId && ownProfileTargets.has(targetProfileDocId))
        ) {
          router.push({
            pathname: "/(main)/(tabs)/ProfileScreen",
            params: { returnTo: HOME_RETURN_ROUTE },
          });
        } else {
          router.push(
            buildUserProfileHref({
              userId: targetUserId,
              profileDocId: targetProfileDocId,
              returnTo: HOME_RETURN_ROUTE,
            }) as any,
          );
        }
        return true;
      }

      const index = visibleFeedItems.findIndex(
        (item) => item.type === result.kind && item.id === result.sourceId,
      );
      if (index < 0) {
        showInfo("Not Found", "That item is no longer available in Home.");
        return false;
      }

      closeSearchExperience();
      setHighlightedFeedKey(result.id);
      setTimeout(() => setHighlightedFeedKey(null), 3500);
      setTimeout(() => {
        feedListRef.current?.scrollToIndex({
          index,
          animated: true,
          viewPosition: 0.18,
        });
      }, 150);
      return true;
    },
    [
      closeSearchExperience,
      currentUserProfile?.studentID,
      currentUserProfile?.userId,
      router,
      user,
      visibleFeedItems,
    ],
  );

  const rotation = fabRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "135deg"],
  });

  // Keep Home post timestamps identical to ProfileScreen's "My Posts"
  // Facebook-style display:
  // Just now -> Xm -> Xh -> Yesterday at h:mm AM/PM ->
  // Month day at h:mm AM/PM -> Month day, year.
  const getTimeAgo = useCallback((timestamp: any) => {
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
  }, [relativeTimeNow]);

  const formatLastSeen = useCallback((timestamp: any) => {
    if (!timestamp?.toDate) return "No recent activity";

    const now = relativeTimeNow;
    const seenAt = timestamp.toDate().getTime();
    const diffMs = now - seenAt;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
    if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
    if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;

    return timestamp.toDate().toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }, [relativeTimeNow]);

  // You aren't in your own list or count: alone, it used to say "1 online".
  const presenceViewerIds = useMemo(
    () =>
      new Set(
        [user?.uid, getStudentDocIdFromAuthUser(user), currentUserProfile?.studentID].filter(
          Boolean,
        ) as string[],
      ),
    [currentUserProfile?.studentID, user],
  );
  const isOtherPresence = useCallback(
    (record: PresenceRecord) =>
      !presenceViewerIds.has(record.id) && !presenceViewerIds.has(record.userId || ""),
    [presenceViewerIds],
  );

  // Online means what Messenger means by it: a phone that checked in within
  // the last 90 seconds, from someone who hasn't turned Active Status off.
  // The list is only people seen in the last day, not the whole campus.
  // Left out: you, locked accounts, and anyone with Active Status off —
  // listing them under "active in the last 24 hours" would say what they
  // chose to hide.
  const onlineRoster = useMemo<CampusPresenceStudent[]>(
    () =>
      (panelPresence ?? [])
        .filter(
          (record) =>
            isOtherPresence(record) &&
            record.accountLocked !== true &&
            record.activeStatusEnabled !== false,
        )
        .map((record) => ({
          ...record,
          isOnline: getPresenceState(record, relativeTimeNow).active,
        }))
        .sort((first, second) => {
          if (first.isOnline !== second.isOnline) {
            return first.isOnline ? -1 : 1;
          }
          return getTimestampValue(second.lastSeen) - getTimestampValue(first.lastSeen);
        }),
    [isOtherPresence, panelPresence, relativeTimeNow],
  );

  // The header's number and the panel's green rows come from the same
  // records while it's open, so they agree.
  const onlineUsersCount = useMemo(
    () => activePresenceRecords.filter(isOtherPresence).length,
    [activePresenceRecords, isOtherPresence],
  );

  const closeCampusPresence = useCallback(() => setOnlineUsersModalVisible(false), []);

  const openPresenceProfile = useCallback(
    (student: CampusPresenceStudent) => {
      setOnlineUsersModalVisible(false);
      // Both ids, so the profile opens without searching for the person.
      handleProfileClick(student.userId, false, student.id);
    },
    [handleProfileClick],
  );

  const presenceViewerUid = user?.uid;
  const messageFromPresence = useCallback(
    (student: CampusPresenceStudent) => {
      if (!presenceViewerUid) return;
      setOnlineUsersModalVisible(false);
      const targetUid = student.userId || student.id;
      const fullName = `${student.firstname} ${student.lastname}`.trim() || "Student";
      try {
        router.push({
          pathname: "/(main)/DirectChatScreen" as any,
          params: getDirectChatParams(presenceViewerUid, {
            uid: targetUid, displayName: fullName,
            profileImage: student.profileImage || null, role: student.role,
          }),
        });
      } catch (err) {
        console.error("Failed to start chat from online modal:", err);
      }
    },
    [router, presenceViewerUid],
  );

  const renderPresenceRow = useCallback(
    ({ item, index }: { item: CampusPresenceStudent; index: number }) => {
      const previous = onlineRoster[index - 1];
      // Section labels where the list changes from active to recent.
      const section = item.isOnline
        ? index === 0
          ? "online"
          : null
        : index === 0 || previous?.isOnline
          ? "recent"
          : null;
      return (
        <CampusPresenceRow
          student={item}
          styles={styles}
          theme={theme}
          section={section}
          showDivider={index > 0 && !section}
          onlineCount={onlineUsersCount}
          lastSeenLabel={item.isOnline ? "" : formatLastSeen(item.lastSeen)}
          canMessage={!!presenceViewerUid && (item.userId || item.id) !== presenceViewerUid}
          onOpenProfile={openPresenceProfile}
          onMessage={messageFromPresence}
        />
      );
    },
    [
      formatLastSeen,
      messageFromPresence,
      onlineRoster,
      onlineUsersCount,
      openPresenceProfile,
      presenceViewerUid,
      styles,
      theme,
    ],
  );

  const handleFlairFilterPress = useCallback(
    (flairId: FeedFilter) => {
      // Only change the feed filter. Do not programmatically move the
      // horizontal flair row; it should stay exactly where the user left it.
      setSelectedFlairFilter(flairId);
      // A status chosen under Lost & Found means nothing under another flair,
      // and coming back to a forgotten "Returned" would look like an empty
      // feed.
      setLostFoundFilter("all");
    },
    [],
  );

  // "Trending this week": the most engaged-with APPROVED posts from the last
  // 7 days. One bounded date-range read (not the whole history), scored and
  // sorted in memory — no denormalised score field or Cloud Function.
  const fetchTrendingPosts = useCallback(async () => {
    if (!auth.currentUser) return;
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const snapshot = await getDocs(
        query(
          collection(db, "posts"),
          where("moderationStatus", "==", "approved"),
          where("createdAt", ">=", since),
          orderBy("createdAt", "desc"),
          limit(60),
        ),
      );

      const scored = snapshot.docs.map((d) => {
        const data = d.data() as any;
        const likeCount = data.likeCount ?? 0;
        const commentCount = data.commentCount ?? 0;
        // Weight a comment as 2x a like: commenting takes more effort than a
        // tap, so it's the stronger signal that a post actually landed.
        const score = likeCount + commentCount * 2;
        return {
          score,
          post: {
            type: "post" as const,
            id: d.id,
            likeCount: 0,
            commentCount: 0,
            likedBy: [],
            ...data,
          } as PostFeedItem,
        };
      });

      scored.sort((a, b) => b.score - a.score);
      const top = scored
        .filter((entry) => entry.score > 0)
        .slice(0, 5)
        .map((entry) => entry.post);

      // Fewer than 3 recently-engaged posts isn't real "trending" signal —
      // hide the section rather than pad it with flat content.
      const nextTop = top.length >= 3 ? top : [];
      const nextIds = nextTop.map((entry) => entry.id);

      // Seed the cards immediately from this snapshot; the live listener below
      // then takes over their like/comment/bookmark state.
      setTrendingPosts(nextTop);
      setTrendingPostIds((previous) =>
        previous.length === nextIds.length &&
        previous.every((id, index) => id === nextIds[index])
          ? previous
          : nextIds,
      );
    } catch (error) {
      console.error("Error loading trending posts:", error);
      setTrendingPosts([]);
      setTrendingPostIds([]);
    }
  }, []);

  // Live state for the currently-trending posts: interacting with a trending
  // card (like / comment / bookmark) now updates it in place instead of
  // staying frozen until the next screen focus.
  useEffect(() => {
    if (trendingPostIds.length === 0) {
      setTrendingPosts([]);
      return;
    }

    const unsubscribe = onSnapshot(
      query(
        collection(db, "posts"),
        where(documentId(), "in", trendingPostIds.slice(0, 10)),
      ),
      (snapshot) => {
        const byId = new Map(
          snapshot.docs.map((docSnapshot) => [
            docSnapshot.id,
            {
              type: "post" as const,
              id: docSnapshot.id,
              likeCount: 0,
              commentCount: 0,
              likedBy: [],
              ...(docSnapshot.data() as any),
            } as PostFeedItem,
          ]),
        );
        setTrendingPosts(
          trendingPostIds
            .map((id) => byId.get(id))
            .filter((post): post is PostFeedItem => {
              if (!post) return false;
              const status = String(
                post.moderationStatus ?? "approved",
              ).toLowerCase();
              return status === "approved";
            }),
        );
      },
      (error) => {
        console.error("Error watching trending posts:", error);
      },
    );

    return unsubscribe;
  }, [trendingPostIds]);

  // Refresh on focus (fresh each time you land on Home) and once auth
  // resolves on first launch.
  useFocusEffect(
    useCallback(() => {
      fetchTrendingPosts();
    }, [fetchTrendingPosts]),
  );
  useEffect(() => {
    if (user) fetchTrendingPosts();
  }, [user, fetchTrendingPosts]);

  const renderTrendingPost = useCallback(
    ({ item }: { item: PostFeedItem }) => {
      const isLiked = item.likedBy?.includes(user?.uid || "") || false;
      return (
        <View style={styles.trendingCardWrap}>
          <PostCard
            compact
            post={item as any}
            isLiked={isLiked}
            currentUserRole={currentUserRole}
            currentUserId={user?.uid}
            onLike={handleLike}
            onDelete={handleDeletePost}
            onEdit={handleEditPost}
            canPin={["admin", "teacher", "moderator"].includes(currentUserRole || "")}
            onTogglePin={handleTogglePinnedPost}
            onProfileClick={handlePostCardProfileClick}
            onTagClick={handlePostCardTagClick}
            onImagePress={openImageViewer}
            onFilePress={handleFilePress}
            getTimeAgo={getTimeAgo}
            onCommentPress={handleFeedCommentPress}
          />
        </View>
      );
    },
    [
      currentUserRole,
      getTimeAgo,
      handleDeletePost,
      handleEditPost,
      handleFeedCommentPress,
      handleFilePress,
      handleLike,
      handlePostCardProfileClick,
      handlePostCardTagClick,
      handleTogglePinnedPost,
      openImageViewer,
      user?.uid,
    ],
  );

  const handleAnnouncementCardPress = useCallback(
    (announcement: AnnouncementItem) => {
      const targetIndex = visibleFeedItems.findIndex(
        (item) => item.type === "post" && item.id === announcement.id,
      );
      if (targetIndex >= 0 && feedListRef.current) {
        try {
          feedListRef.current.scrollToIndex({
            index: targetIndex,
            animated: true,
            viewPosition: 0.1,
          });
        } catch {
          feedListRef.current.scrollToOffset({ offset: 350, animated: true });
        }
      }
    },
    [visibleFeedItems],
  );

  // Whoever is broadcasting right now. Live sits above everything else in
  // the header because it is the only thing on this screen that stops being
  // true while you look at it.
  // Only lives whose host is still there; one left behind by a crashed app
  // drops out on its own.
  const activeStreams = useActiveLiveStreams();

  const openLiveStream = useCallback(
    (stream: LiveStream) => {
      router.push({
        pathname: "/(main)/LiveStreamScreen",
        params: { streamId: stream.id },
      } as any);
    },
    [router],
  );

  // ── B.E.A.'s brief in the welcome card
  // Only counts Home already listens to, so it costs no extra reads.
  const homeFocused = useIsFocused();

  // Read on every visit to Home, so a brief closed yesterday is back today
  // even if the app stayed open overnight.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      AsyncStorage.getItem(HOME_BRIEF_HIDDEN_KEY)
        .then((hiddenOn) => {
          if (active) setBriefHidden(hiddenOn === localDateKey(new Date()));
        })
        .catch(() => {
          if (active) setBriefHidden(false);
        });
      return () => {
        active = false;
      };
    }, []),
  );

  const hideBrief = useCallback(() => {
    setBriefHidden(true);
    AsyncStorage.setItem(HOME_BRIEF_HIDDEN_KEY, localDateKey(new Date())).catch((error) =>
      console.error("Error saving the hidden brief:", error),
    );
  }, []);

  // Tapping B.E.A. brings a closed brief back.
  const handleWelcomeOrbPress = useCallback(() => {
    if (!briefHidden) return;
    setBriefHidden(false);
    AsyncStorage.removeItem(HOME_BRIEF_HIDDEN_KEY).catch(() => undefined);
  }, [briefHidden]);

  const openBeaChat = useCallback(() => {
    router.navigate("/(main)/(tabs)/AiChatScreen");
  }, [router]);

  // Each item opens what it names, and only items with something in them
  // appear. Events today win over events later on.
  const briefItems = useMemo<BriefItem[]>(() => {
    const items: BriefItem[] = [];
    if (eventCounts.today > 0 || eventCounts.upcoming > 0) {
      items.push({
        id: "events",
        emoji: "📅",
        label:
          eventCounts.today > 0
            ? `${countOf(eventCounts.today, "event", "events")} today`
            : countOf(eventCounts.upcoming, "upcoming event", "upcoming events"),
        onPress: () => router.push("/EventCalendarScreen"),
      });
    }
    if (activeAnnouncements.length > 0) {
      items.push({
        id: "announcements",
        emoji: "📢",
        label: countOf(activeAnnouncements.length, "announcement", "announcements"),
        onPress: () => handleAnnouncementCardPress(activeAnnouncements[0]),
      });
    }
    if (totalUnreadMessages > 0) {
      items.push({
        id: "messages",
        emoji: "💬",
        label: countOf(totalUnreadMessages, "unread message", "unread messages"),
        onPress: () => router.push("/(main)/MessagesScreen" as any),
      });
    }
    if (activeStreams.length > 0) {
      items.push({
        id: "live",
        emoji: "",
        label: `${activeStreams.length} live now`,
        onPress: () => openLiveStream(activeStreams[0]),
      });
    }
    return items;
  }, [
    activeAnnouncements,
    activeStreams,
    eventCounts,
    handleAnnouncementCardPress,
    openLiveStream,
    router,
    totalUnreadMessages,
  ]);

  const renderFeedHeader = useCallback(() => {
    const displayNameParts =
      user?.displayName?.trim().split(/\s+/).filter(Boolean) || [];
    // No name yet means no name, not "there": it reads as a mistake the
    // moment the real one replaces it.
    const lastName =
      currentUserProfile?.lastname?.trim() ||
      displayNameParts[displayNameParts.length - 1] ||
      "";
    // Offline, every count reads zero, which would wrongly say "caught up".
    const showBrief = !briefHidden && !isOffline;

    return (
      <>
      <Animated.View
        style={[
          styles.feedWelcome,
          {
            opacity: welcomeOpacity,
            transform: [{ translateY: welcomeTranslateY }],
          },
        ]}
      >
        <View style={styles.feedWelcomeAccent} />

        <Animated.View
          pointerEvents="none"
          style={[
            styles.feedWelcomeGlowGold,
            {
              transform: [
                {
                  translateY: welcomeFloat.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, -5],
                  }),
                },
              ],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.feedWelcomeGlowMaroon,
            {
              transform: [
                {
                  translateY: welcomeFloat.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, 4],
                  }),
                },
              ],
            },
          ]}
        />

        <View style={styles.feedWelcomeCopy}>
          <View style={styles.feedWelcomeRow}>
            {/* Smiles and hops when something is waiting; a tap makes it
                react, and brings back a brief that was closed. */}
            <BeaOrb
              size={50}
              mood={showBrief && briefItems.length > 0 ? "happy" : "idle"}
              animated={homeFocused}
              onPress={handleWelcomeOrbPress}
              accessibilityLabel={
                briefHidden ? "B.E.A. Shows today's brief again" : "B.E.A."
              }
            />
            <Animated.View
              style={[
                styles.feedWelcomeHeading,
                {
                  opacity: welcomeCopyOpacity,
                  transform: [{ translateY: welcomeCopyTranslateY }],
                },
              ]}
            >
              <View style={styles.feedEyebrowPill}>
                <Text style={styles.feedEyebrow}>CAMPUS COMMUNITY</Text>
              </View>
              <Text style={styles.feedWelcomeTitle}>
                {lastName ? `Good day, ${lastName} 👋` : "Good day 👋"}
              </Text>
            </Animated.View>
          </View>

          <Animated.View
            style={{
              opacity: welcomeCopyOpacity,
              transform: [{ translateY: welcomeCopyTranslateY }],
            }}
          >
            {!showBrief ? (
              <Text style={styles.feedWelcomeSubtitle}>
                Stay connected with campus news, events, conversations, and student updates.
              </Text>
            ) : briefItems.length > 0 ? (
              <>
                <Text style={styles.briefLabel}>HERE’S YOUR DAY</Text>
                <View style={styles.briefChips}>
                  {briefItems.map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={[styles.briefChip, item.id === "live" && styles.briefChipLive]}
                      onPress={item.onPress}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel={item.label}
                    >
                      {item.id === "live" ? (
                        <View style={styles.briefLiveDot} />
                      ) : (
                        <Text style={styles.briefChipEmoji}>{item.emoji}</Text>
                      )}
                      <Text style={styles.briefChipText}>{item.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : (
              <View style={styles.briefCaughtUp}>
                <Text style={styles.briefCaughtUpTitle}>You’re all caught up.</Text>
                <Text style={styles.briefCaughtUpText}>
                  No events, announcements or unread messages waiting for you.
                </Text>
              </View>
            )}
          </Animated.View>
        </View>

        {showBrief && (
          <TouchableOpacity
            style={styles.briefDismiss}
            onPress={hideBrief}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Hide today's brief until tomorrow"
          >
            <Ionicons name="close" size={14} color={theme.textMuted} />
          </TouchableOpacity>
        )}
      </Animated.View>

      {activeStreams.length > 0 && (
        <View style={styles.liveSection}>
          {activeStreams.map((stream) => (
            <LiveCard key={stream.id} stream={stream} onPress={openLiveStream} />
          ))}
        </View>
      )}

      {activeAnnouncements.length > 0 && (
        <AnnouncementCarousel
          announcements={activeAnnouncements}
          onPressAnnouncement={handleAnnouncementCardPress}
        />
      )}

      {trendingPosts.length >= 3 && (
        <View style={styles.trendingSection}>
          <View style={styles.trendingHeaderRow}>
            <Ionicons name="flame" size={16} color="#a61f1f" />
            <Text style={styles.trendingTitle}>Trending this week</Text>
          </View>
          <FlatList
            horizontal
            data={trendingPosts}
            keyExtractor={(item) => `trending-${item.id}`}
            renderItem={renderTrendingPost}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.trendingListContent}
            snapToInterval={TRENDING_CARD_WIDTH + 12}
            snapToAlignment="start"
            disableIntervalMomentum={true}
            decelerationRate="fast"
          />
        </View>
      )}

      <View style={styles.flairFilterSection}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.flairFilterContent}
        >
          <TouchableOpacity
            style={[
              styles.flairFilterChip,
              selectedFlairFilter === "all" && styles.flairFilterChipActive,
            ]}
            onPress={() => handleFlairFilterPress("all")}
          >
            <Text
              style={[
                styles.flairFilterText,
                selectedFlairFilter === "all" &&
                  styles.flairFilterTextActive,
              ]}
            >
              All
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.flairFilterChip,
              selectedFlairFilter === "polls" && styles.flairFilterChipActive,
            ]}
            onPress={() => handleFlairFilterPress("polls")}
          >
            <Text style={styles.flairFilterEmoji}>📊</Text>
            <Text
              style={[
                styles.flairFilterText,
                selectedFlairFilter === "polls" && styles.flairFilterTextActive,
              ]}
            >
              Polls
            </Text>
          </TouchableOpacity>

          {POST_FLAIRS.map((flair) => {
            const active = selectedFlairFilter === flair.id;
            return (
              <TouchableOpacity
                key={flair.id}
                style={[
                  styles.flairFilterChip,
                  active && styles.flairFilterChipActive,
                ]}
                onPress={() => handleFlairFilterPress(flair.id)}
              >
                <Text style={styles.flairFilterEmoji}>{flair.emoji}</Text>
                <Text
                  style={[
                    styles.flairFilterText,
                    active && styles.flairFilterTextActive,
                  ]}
                >
                  {flair.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {selectedFlairFilter === "lost_found" && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={[styles.flairFilterContent, styles.lostFoundFilterContent]}
          >
            {(["all", ...LOST_FOUND_STATUSES.map((item) => item.id)] as const).map(
              (statusId) => {
                const active = lostFoundFilter === statusId;
                const info = LOST_FOUND_STATUSES.find((item) => item.id === statusId);
                const tones = info ? lostFoundStatusColors(info.id, theme) : null;
                return (
                  <TouchableOpacity
                    key={statusId}
                    style={[
                      styles.lostFoundFilterChip,
                      active &&
                        (tones
                          ? { backgroundColor: tones.fill, borderColor: tones.line }
                          : styles.flairFilterChipActive),
                    ]}
                    onPress={() => setLostFoundFilter(statusId)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    {info && <Text style={styles.flairFilterEmoji}>{info.emoji}</Text>}
                    <Text
                      style={[
                        styles.flairFilterText,
                        active &&
                          (tones ? { color: tones.ink } : styles.flairFilterTextActive),
                      ]}
                    >
                      {info ? info.label : "All"}
                    </Text>
                  </TouchableOpacity>
                );
              },
            )}
          </ScrollView>
        )}
      </View>
      </>
    );
  }, [
    activeAnnouncements,
    activeStreams,
    openLiveStream,
    styles,
    theme,
    briefHidden,
    briefItems,
    currentUserProfile?.lastname,
    handleAnnouncementCardPress,
    handleFlairFilterPress,
    handleWelcomeOrbPress,
    hideBrief,
    homeFocused,
    isOffline,
    lostFoundFilter,
    onlineUsersCount,
    renderTrendingPost,
    selectedFlairFilter,
    trendingPosts,
    user?.displayName,
  ]);

  // Built once and reused instead of calling renderFeedHeader() inline in the
  // FlatList props, which rebuilt the welcome card, announcements, trending row
  // and flair chips every time anything on Home re-rendered. Now it only
  // rebuilds when one of renderFeedHeader's own inputs changes.
  const feedHeader = useMemo(() => renderFeedHeader(), [renderFeedHeader]);

  const renderFeedItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      if (item.type === "post") {
        const post = item as Post;
        const isLiked = post.likedBy?.includes(user?.uid || "") || false;
        
        return (
          <FeedPostCard
            post={post}
            isLiked={isLiked}
            isHighlighted={
              highlightedPostId === post.id || highlightedFeedKey === `post:${post.id}`
            }
            currentUserRole={currentUserRole}
            currentUserId={user?.uid}
            onLike={handleLike}
            onDelete={handleDeletePost}
            onEdit={handleEditPost}
            canPin={["admin", "teacher", "moderator"].includes(currentUserRole || "")}
            onTogglePin={handleTogglePinnedPost}
            onProfileClick={handlePostCardProfileClick}
            onTagClick={handlePostCardTagClick}
            onImagePress={openImageViewer}
            onFilePress={handleFilePress}
            getTimeAgo={getTimeAgo}
            // Ensure comment modal triggers directly from PostCard
            onCommentPress={handleFeedCommentPress}
            // Part A: X-style muted autoplay only for the card in view,
            // held off while search results cover the feed.
            visibilityStore={feedVisibilityStore}
            videosPaused={searchResultsVisible}
          />
        );
      }

      const poll = item as Poll;
      const userRole = userRoles[poll.userId || ""];
      return (
        <PollCard
          poll={poll}
          isHighlighted={highlightedFeedKey === `poll:${poll.id}`}
          onImagePress={openImageViewer}
          currentUserRole={currentUserRole}
          userRole={userRole}
          currentUserId={user?.uid}
          onVote={handlePollVote}
          onAddOption={addOptionToPoll}
          onDelete={handleDeletePoll}
          onEdit={handleEditPoll}
          onTogglePin={handleTogglePinnedPoll}
          onProfileClick={handleProfileClick}
          getTimeAgo={getTimeAgo}
          isPollExpired={isPollExpired}
        />
      );
    },
    [
      addOptionToPoll,
      currentUserRole,
      feedVisibilityStore,
      getTimeAgo,
      handleFeedCommentPress,
      handleFilePress,
      handleLike,
      handleDeletePoll,
      handleEditPoll,
      handleTogglePinnedPoll,
      handleDeletePost,
      handleEditPost,
      handleTogglePinnedPost,
      handlePollVote,
      handlePostCardProfileClick,
      handlePostCardTagClick,
      handleProfileClick,
      highlightedFeedKey,
      highlightedPostId,
      isPollExpired,
      openImageViewer,
      searchResultsVisible,
      user?.uid,
      userRoles,
    ],
  );

const renderEmptyState = () => {
  if (isLoading && !isOffline) {
    return <FeedSkeleton count={5} />;
  }

  if (isOffline && feedItems.length === 0) {
    return (
      <View style={styles.emptySearchState}>   {/* Reuse the nice empty style */}
        <Ionicons name="cloud-offline" size={58} color={theme.textMuted} />
        <Text style={styles.emptyTitle}>No Connection</Text>
        <Text style={styles.emptySubtitle}>
          Please check your internet connection
        </Text>
      </View>
    );
  }

  if (!isLoading && visibleFeedItems.length === 0) {
    return (
      <View style={styles.emptySearchState}>
        <Ionicons name="chatbubbles-outline" size={58} color={theme.textMuted} />
        <Text style={styles.emptyTitle}>No posts yet</Text>
        <Text style={styles.emptySubtitle}>
          Be the first to share something on the Home feed
        </Text>
      </View>
    );
  }

  return null;
};

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

return (
    <GestureDetector gesture={panGesture}>
      <SafeAreaView style={styles.container}>
      <HomeSearchProvider
        expanded={searchExpanded}
        visibleFeedItems={visibleFeedItems}
        searchableStudents={searchableStudents}
        renderFeedItem={renderFeedItem}
        onOpenResult={openSearchResult}
        onClose={closeSearchExperience}
        onResultsVisibleChange={setSearchResultsVisible}
      >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        {searchExpanded ? (
          <HomeSearchBar onOpenServerDrawer={openServerDrawer} />
        ) : (
          <>
            <View style={styles.headerLeft}>
              <TouchableOpacity
                style={styles.headerIconButton}
                activeOpacity={0.82}
                onPress={openServerDrawer}
              >
                <Ionicons name="menu" size={22} color={theme.onChrome} />
              </TouchableOpacity>
              {/* Search the feed — people, posts and polls in view. */}
              <TouchableOpacity
                style={styles.calendarButton}
                activeOpacity={0.82}
                onPress={openSearchExperience}
                accessibilityLabel="Search"
              >
                {/* A plain, bold magnifier in the header colour on the gold
                    circle — read at a glance, like the other header buttons. */}
                <Ionicons name="search" size={21} color={theme.chrome} />
              </TouchableOpacity>
            </View>

            <Text style={styles.headerTitle}>HOME</Text>

            <View style={styles.headerIcons}>
              <TouchableOpacity
                style={styles.onlineUsersContainer}
                activeOpacity={0.82}
                onPress={() => setOnlineUsersModalVisible(true)}
              >
                <View style={styles.onlineDot} />
                <Text style={styles.onlineUsersText}>{onlineUsersCount}</Text>
              </TouchableOpacity>
               <TouchableOpacity
                style={styles.calendarButton}
                onPress={() => router.push("/(main)/MessagesScreen" as any)}
                accessibilityLabel="Messages"
              >
                <Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.onAccent} />
                {totalUnreadMessages > 0 && (
                  <View style={styles.eventBadge}>
                    <Text style={styles.eventBadgeText}>
                      {totalUnreadMessages > 99 ? "99+" : totalUnreadMessages}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.calendarButton}
                onPress={() => router.push("/EventCalendarScreen")}
              >
                <Ionicons name="calendar-outline" size={22} color={theme.onAccent} />
                {upcomingEventsCount > 0 && (
                  <View style={styles.eventBadge}>
                    <Text style={styles.eventBadgeText}>
                      {upcomingEventsCount > 99 ? "99+" : upcomingEventsCount}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>

              
            </View>
          </>
        )}
      </View>

      {/* ── Feed ────────────────────────────────────────────────────────── */}
      <View style={styles.contentArea}>
          <View style={{ flex: 1 }}>
            {isOffline && visibleFeedItems.length > 0 && (
              <View style={styles.offlineStatusBar}>
                <Ionicons name="cloud-offline-outline" size={15} color="#9a3412" />
                <Text style={styles.offlineStatusText}>
                  Offline mode
                </Text>
              </View>
            )}
            <FlatList
            ref={feedListRef}
            data={visibleFeedItems}
            renderItem={renderFeedItem}
            keyExtractor={(item) => item.id}
            // Comments and replies open from inside these cards, and React Native
            // still counts this list as their parent for taps: left at "never",
            // the first tap on Send only closed the keyboard.
            keyboardShouldPersistTaps="handled"
            onScroll={handleScroll}
            onViewableItemsChanged={onFeedViewableItemsChanged}
            viewabilityConfig={feedViewabilityConfig}
            onEndReached={loadMoreFeed}
            // Prefetch the next page well before the bottom (~1.5 viewport
            // heights of content still below) so scrolling stays seamless —
            // loadMoreFeed already guards against overlapping requests.
            onEndReachedThreshold={1.5}
            scrollEventThrottle={16}
            // Facebook-style scrolling: once a post is rendered it stays
            // mounted, so scrolling back up never re-mounts a PostCard (which
            // would re-fetch the author, reload images, and recreate video
            // players — the "loading" flash on scroll-up). removeClippedSubviews
            // is off for the same reason, and the window is wide enough that
            // rows just outside the viewport are already rendered, not blank.
            initialNumToRender={8}
            maxToRenderPerBatch={10}
            windowSize={21}
            updateCellsBatchingPeriod={50}
            removeClippedSubviews={false}
            contentContainerStyle={
              visibleFeedItems.length === 0
                ? styles.emptyListContent
                : styles.flatListContent
            }
            ListEmptyComponent={renderEmptyState}
            ListFooterComponent={
              isLoadingMore ? (
                <View style={styles.feedFooter}>
                  <ActivityIndicator size="small" color={theme.accent} />
                </View>
              ) : visibleFeedItems.length > 0 &&
                !hasMorePosts &&
                !hasMorePolls ? (
                // Otherwise the list simply stops and the reader cannot tell
                // "you have seen everything" from "still loading" or "broken".
                <View style={styles.feedEnd}>
                  <BeaOrb size={72} mood="happy" animated={homeFocused} tappable />
                  <Text style={styles.feedEndTitle}>That’s everything for now</Text>
                  <Text style={styles.feedEndText}>
                    Check back later for new posts, or ask B.E.A. about anything on campus.
                  </Text>
                  <TouchableOpacity
                    style={styles.feedEndButton}
                    onPress={openBeaChat}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                  >
                    <Ionicons name="sparkles" size={15} color={theme.primary} />
                    <Text style={styles.feedEndButtonText}>Ask B.E.A. something</Text>
                  </TouchableOpacity>
                </View>
              ) : null
            }
            ListHeaderComponent={feedHeader}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                colors={[theme.accent]}
                tintColor={theme.accent}
                title={isOffline ? "Offline" : "Refreshing feed..."}
                titleColor={theme.accent}
              />
            }
            onScrollToIndexFailed={(info) => {
              feedListRef.current?.scrollToOffset({
                offset: Math.max(0, info.averageItemLength * info.index),
                animated: true,
              });
              setTimeout(() => {
                feedListRef.current?.scrollToIndex({
                  index: info.index,
                  animated: true,
                  viewPosition: 0.15,
                });
              }, 250);
            }}
          />
          {hasStagedFeedItems && (
            <Animated.View
              pointerEvents="box-none"
              style={[
                styles.newPostsPillWrap,
                {
                  opacity: newPostsPillAnim,
                  transform: [
                    {
                      translateY: newPostsPillAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-28, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <TouchableOpacity
                style={styles.newPostsPill}
                onPress={() => flushStagedFeedItems()}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`Show ${stagedFeedCount} new ${
                  stagedFeedCount === 1 ? "post" : "posts"
                }`}
              >
                <Ionicons name="arrow-up" size={14} color={theme.onPrimary} />
                <Text style={styles.newPostsPillText}>
                  {stagedFeedCount === 1
                    ? "1 new post"
                    : `${stagedFeedCount} new posts`}
                </Text>
              </TouchableOpacity>
            </Animated.View>
          )}
          </View>

        {searchExpanded ? <HomeSearchPanel /> : null}
      </View>
      </HomeSearchProvider>

      <Modal
        visible={onlineUsersModalVisible}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeCampusPresence}
      >
        <View style={styles.presenceOverlay}>
          {/* Tapping outside the card closes it. Not announced separately:
              the close button says the same thing. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={closeCampusPresence}
            accessible={false}
          />
          <PresencePanelEntrance style={styles.presenceCard}>
            <View style={styles.presenceHeader}>
              <View style={styles.presenceHeaderIcon}>
                <Ionicons name="people" size={20} color={theme.primary} />
              </View>
              <View style={styles.presenceHeaderCopy}>
                <Text style={styles.presenceTitle} accessibilityRole="header">
                  Campus Presence
                </Text>
                <View style={styles.presenceLiveRow}>
                  <View style={styles.presenceLiveDotRing}>
                    <View style={styles.presenceLiveDot} />
                  </View>
                  <Text style={styles.presenceSubtitle} numberOfLines={1}>
                    <Text style={[styles.presenceSubtitleCount, styles.presenceOnlineInk]}>
                      {onlineUsersCount}
                    </Text>
                    {" online right now"}
                  </Text>
                </View>
              </View>
              <Pressable
                onPress={closeCampusPresence}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.presenceClose,
                  pressed && styles.presenceClosePressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Close Campus Presence"
              >
                <Ionicons name="close" size={20} color={theme.textSecondary} />
              </Pressable>
            </View>

            <FlatList
              data={onlineRoster}
              keyExtractor={(item) => item.id}
              renderItem={renderPresenceRow}
              style={styles.presenceList}
              contentContainerStyle={[
                styles.presenceListContent,
                onlineRoster.length === 0 && styles.presenceListEmpty,
              ]}
              showsVerticalScrollIndicator={false}
              initialNumToRender={12}
              maxToRenderPerBatch={12}
              windowSize={7}
              ListEmptyComponent={
                panelPresence === null ? (
                  <ActivityIndicator color={theme.accent} style={{ marginVertical: 24 }} />
                ) : (
                  <View style={styles.presenceEmpty}>
                    <View style={styles.presenceEmptyIcon}>
                      <Ionicons name="people-outline" size={24} color={theme.textMuted} />
                    </View>
                    <Text style={styles.presenceEmptyText}>
                      No one else has been active in the last 24 hours
                    </Text>
                  </View>
                )
              }
            />
          </PresencePanelEntrance>
        </View>
      </Modal>

      {/* ── Server Drawer ────────────────────────────────────────────────── */}
     {/* ── Minimalistic Search Modal ───────────────────────────────────────────── */}

      <ServerDrawer
        visible={serverDrawerVisible}
        onClose={closeServerDrawer}
        currentUserRole={currentUserRole}
        servers={communityServers}
        selectedServerId={selectedServer?.id}
        selectedChannelId={selectedChannel?.id}
        onExitServerView={exitServerView}
        canCreateServer={currentUserRole === "admin"}
        onSelectServer={handleSelectServer}
        onSelectChannel={handleSelectChannel}
        onCreateServer={handleCreateServer}
        onEditServer={handleEditServer}
        onDeleteServer={handleDeleteServer}
        onRequestServerDeletion={handleRequestServerDeletion}
        onCreateThread={handleCreateThread}
        onEditChannel={handleEditChannel}
        onDeleteChannel={handleDeleteChannel}
        onRequestJoin={handleRequestJoin}
        onApproveJoinRequest={handleApproveJoinRequest}
        onRejectJoinRequest={handleRejectJoinRequest}
        onOpenUserProfile={handleOpenUserProfileFromDrawer}
        onLeaveServer={handleLeaveServer}
        pendingJoinRequests={selectedServerJoinRequests}
        serverMembers={selectedServerMembers}
        addableMembers={addableServerMembers}
        onAddMembers={handleAddServerMembers}
        onRemoveMember={handleRemoveServerMember}
        currentUserId={user?.uid ?? null}
      />

      {/* ── Image Viewer Modal ───────────────────────────────────────────── */}
      <ImageZoomViewer
        images={currentImages}
        startIndex={currentImageIndex}
        visible={imageViewerVisible}
        onClose={() => setImageViewerVisible(false)}
        showActions={!!currentImageViewerPost}
        likesCount={currentImageViewerPost?.likeCount ?? 0}
        commentsCount={currentImageViewerPost?.commentCount ?? 0}
        isLiked={
          currentImageViewerPost?.likedBy?.includes(user?.uid || "") || false
        }
        onLike={handleImageViewerLike}
        onComment={handleImageViewerComment}
      />

      {/* ── FAB Menu ────────────────────────────────────────────────────── */}
      {fabMenuVisible && (
        <Animated.View
          style={[
            styles.fabMenuContainer,
            {
              bottom: Math.max(insets.bottom + 140, 155),
              transform: [{ translateY: menuTranslateY }],
              opacity: menuOpacity,
            },
          ]}
          pointerEvents="box-none"
        >
          {[
            {
              label: "Create",
              icon: "create-outline" as const,
              action: "create",
            },
            {
              label: "Polls",
              icon: "bar-chart-outline" as const,
              action: "polls",
            },
            {
              label: "Live",
              icon: "videocam-outline" as const,
              action: "live",
            },
          ].map((item, index) => (
            <Animated.View
              key={item.action}
              style={[
                styles.menuItemContainer,
                {
                  transform: [
                    {
                      scale: menuScale.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.7, 1],
                      }),
                    },
                    {
                      translateY: menuScale.interpolate({
                        inputRange: [0, 1],
                        outputRange: [20 + index * 15, 0],
                      }),
                    },
                  ],
                  opacity: menuScale.interpolate({
                    inputRange: [0, 0.5, 1],
                    outputRange: [0, 0.6, 1],
                  }),
                },
              ]}
            >
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => handleMenuAction(item.action)}
                activeOpacity={0.7}
              >
                <Ionicons name={item.icon} size={20} color="#fff" />
                <Text style={styles.menuText}>{item.label}</Text>
              </TouchableOpacity>
            </Animated.View>
          ))}
        </Animated.View>
      )}

      {/* ── FAB Button ──────────────────────────────────────────────────── */}
      <Animated.View
        style={[
          styles.fabContainer,
          {
            bottom: Math.max(insets.bottom + 68, 80),
            transform: [{ translateY: fabTranslateY }],
          },
        ]}
      >
        <TouchableOpacity
          style={styles.fab}
          onPress={toggleFabMenu}
          activeOpacity={0.8}
        >
          <Animated.View
            style={{ transform: [{ rotate: rotation }], width: 28, height: 28 }}
          >
            <Ionicons name="add" size={28} color={theme.primary} />
          </Animated.View>
        </TouchableOpacity>
      </Animated.View>

      {/* ── Comment Modal (from notification) ───────────────────────────── */}
      {!!notificationModalPostId && (
        <CommentModal
          visible={true}
          onClose={() => {
            setNotificationModalPostId(null);
            setNotificationModalCommentId(null);
            setNotificationModalReplyId(null);
            setNotificationModalOpenReply(false);
          }}
          postId={notificationModalPostId}
          currentUserId={user?.uid}
          currentUserRole={currentUserRole}
          initialCommentId={notificationModalCommentId}
          initialReplyId={notificationModalReplyId}
          autoOpenReplyThread={notificationModalOpenReply}
        />
      )}

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
    </GestureDetector>
  );
};

export default HomeScreen;

// ─── Final Improved Styles ─────────────────────────────────────────────────────

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  liveSection: { borderTopWidth: 1, borderTopColor: c.border },
  container: { 
    flex: 1, 
    backgroundColor: c.chrome 
  },

  /* ====================== FEED WELCOME ====================== */
  feedWelcome: {
    position: "relative",
    overflow: "hidden",
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 10,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 22,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: c.textPrimary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
  },
  feedWelcomeAccent: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: c.accent,
    opacity: 0.9,
  },
  feedWelcomeGlowGold: {
    position: "absolute",
    width: 112,
    height: 112,
    borderRadius: 56,
    right: -34,
    top: -40,
    backgroundColor: c.accentSoft,
    opacity: 0.2,
  },
  feedWelcomeGlowMaroon: {
    position: "absolute",
    width: 76,
    height: 76,
    borderRadius: 38,
    right: 26,
    bottom: -40,
    backgroundColor: c.primary,
    opacity: 0.06,
  },
  feedWelcomeCopy: {
    width: "100%",
    zIndex: 1,
  },
  feedWelcomeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  feedWelcomeHeading: {
    flex: 1,
    alignItems: "flex-start",
    gap: 5,
    // Clear of the close button in the corner.
    paddingRight: 22,
  },
  feedEyebrowPill: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.accentSoft,
  },
  feedEyebrow: {
    color: c.accent,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.05,
  },
  feedWelcomeTitle: {
    color: c.primary,
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 24,
    letterSpacing: -0.2,
  },
  feedWelcomeSubtitle: {
    color: c.textMuted,
    fontSize: 13.25,
    lineHeight: 20,
    marginTop: 12,
    maxWidth: 520,
  },
  briefDismiss: {
    position: "absolute",
    top: 12,
    right: 12,
    zIndex: 2,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
  },
  briefLabel: {
    color: c.textMuted,
    fontSize: 10.5,
    fontWeight: "800",
    letterSpacing: 0.7,
    marginTop: 16,
  },
  briefChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
    marginTop: 8,
  },
  briefChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  briefChipLive: {
    borderColor: c.danger,
  },
  briefLiveDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: c.danger,
  },
  briefChipEmoji: {
    fontSize: 13,
  },
  briefChipText: {
    color: c.textPrimary,
    fontSize: 12.5,
    fontWeight: "700",
  },
  briefCaughtUp: {
    marginTop: 12,
  },
  briefCaughtUpTitle: {
    color: c.textPrimary,
    fontSize: 13.5,
    fontWeight: "800",
  },
  briefCaughtUpText: {
    color: c.textMuted,
    fontSize: 12.5,
    lineHeight: 16,
    marginTop: 2,
  },
  // "Trending this week" band — visually distinct from the vertical feed:
  // its own tinted strip with a header and a horizontal card scroller.
  trendingSection: {
    backgroundColor: c.surfaceSunken,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: c.border,
    paddingTop: 12,
    paddingBottom: 16,
    marginBottom: 10,
  },
  trendingHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  trendingTitle: {
    color: c.primary,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  trendingListContent: { paddingHorizontal: 14, gap: 12 },
  trendingCardWrap: {
    width: TRENDING_CARD_WIDTH,
    // Generous backstop so the strip height stays sane on an unusually tall
    // card — the compact card's clamps keep normal cards well under this, so
    // the like/comment row is never clipped.
    maxHeight: 460,
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    overflow: "hidden",
  },
  flairFilterSection: { marginBottom: 10 },
  flairFilterContent: { paddingHorizontal: 14, gap: 8, paddingRight: 22 },
  lostFoundFilterContent: { marginTop: 8 },
  lostFoundFilterChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 16, backgroundColor: c.surfaceSunken, borderWidth: 1, borderColor: c.border },
  flairFilterChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  flairFilterChipActive: { backgroundColor: c.primary, borderColor: c.primary },
  flairFilterEmoji: { fontSize: 13 },
  flairFilterText: { color: c.textSecondary, fontSize: 12, fontWeight: "800" },
  flairFilterTextActive: { color: c.onPrimary },

  /* ====================== HEADER ====================== */
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.chromeBorder,
    backgroundColor: c.chrome,
  },
  edgeSwipeArea: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 26,
    zIndex: 20,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    minWidth: 68,
  },
  headerIconButton: {
    justifyContent: "center",
    alignItems: "center",
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: c.onChrome,
    letterSpacing: 0.8,
  },
  headerIcons: {
    flexDirection: "row",
    gap: 16,
    alignItems: "center",
  },
  onlineUsersContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.border,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 6,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  onlineDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: c.textSecondary,
  },
  onlineUsersText: {
    color: c.primary,
    fontSize: 13.5,
    fontWeight: "700",
  },
  presenceOverlay: {
    flex: 1,
    backgroundColor: c.scrim,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  presenceCard: {
    width: "100%",
    maxWidth: 440,
    maxHeight: "78%",
    backgroundColor: c.surface,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: c.border,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: c.isDark ? 0.45 : 0.16,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  presenceHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.borderStrong,
  },
  presenceHeaderIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  presenceHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  presenceTitle: {
    color: c.textPrimary,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  presenceLiveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 4,
  },
  presenceLiveDotRing: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: c.successSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  presenceLiveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: c.success,
  },
  presenceSubtitle: {
    flexShrink: 1,
    color: c.textMuted,
    fontSize: 13,
    fontWeight: "500",
  },
  presenceSubtitleCount: {
    fontWeight: "800",
  },
  // Green words on a pale green wash. The light palettes need a deeper
  // green than their accent to stay readable at this size.
  presenceOnlineInk: {
    color: c.isDark ? c.success : "#17663a",
  },
  presenceClose: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: c.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
  },
  presenceClosePressed: {
    backgroundColor: c.borderStrong,
  },
  presenceList: {
    flexGrow: 0,
    flexShrink: 1,
  },
  presenceListContent: {
    paddingTop: 4,
    paddingBottom: 16,
  },
  presenceListEmpty: {
    flexGrow: 1,
  },
  presenceSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 6,
  },
  presenceSectionText: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  presenceSectionCount: {
    minWidth: 22,
    height: 18,
    paddingHorizontal: 6,
    borderRadius: 9,
    backgroundColor: c.successSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  presenceSectionCountText: {
    fontSize: 11,
    fontWeight: "800",
  },
  presenceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 16,
  },
  presenceRowPressed: {
    backgroundColor: c.surfaceSunken,
  },
  // Starts after the avatar (10 padding + 50 avatar + 12 gap), so the photos
  // read as one column rather than boxed rows.
  presenceDivider: {
    position: "absolute",
    top: 0,
    left: 72,
    right: 10,
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.borderStrong,
  },
  presenceAvatarWrap: {
    width: 50,
    height: 50,
  },
  presenceAvatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  presenceAvatarImage: {
    width: "100%",
    height: "100%",
  },
  presenceAvatarText: {
    color: c.primary,
    fontSize: 18,
    fontWeight: "800",
  },
  // The ring is the card's own colour, so the dot stays visible on any photo.
  presenceAvatarDot: {
    position: "absolute",
    right: 0,
    bottom: 1,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: c.success,
    borderWidth: 2.5,
    borderColor: c.surface,
  },
  presenceCopy: {
    flex: 1,
    minWidth: 0,
  },
  presenceName: {
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "700",
  },
  presenceNameIdle: {
    color: c.textSecondary,
    fontWeight: "600",
  },
  presenceDetail: {
    color: c.textMuted,
    fontSize: 12.5,
    marginTop: 1,
  },
  presenceStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 5,
  },
  presenceOnlinePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: c.successSoft,
  },
  presenceOnlinePillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.success,
  },
  presenceOnlinePillText: {
    fontSize: 11,
    fontWeight: "800",
  },
  presenceLastSeen: {
    flexShrink: 1,
    color: c.textMuted,
    fontSize: 11.5,
  },
  presenceMessageButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  presenceMessageButtonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.96 }],
  },
  presenceEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 32,
  },
  presenceEmptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: c.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
  },
  presenceEmptyText: {
    color: c.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  calendarButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: c.accent,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: c.accent,
    position: "relative",
  },
  eventBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: c.surfaceSunken,
    borderRadius: 12,
    minWidth: 22,
    height: 22,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: c.primary,
  },
  eventBadgeText: {
    color: c.primary,
    fontSize: 11.5,
    fontWeight: "bold",
  },

  /* ====================== SEARCH ====================== */
  contentArea: {
    flex: 1,
    backgroundColor: c.surfaceSunken,
  },

  /* Recent Searches */
  recentSection: {
    marginVertical: 8,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  sectionTitle: {
    color: c.textPrimary,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  clearAllText: {
    color: c.primary,
    fontSize: 13.5,
    fontWeight: "700",
  },
  chipContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  recentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fff",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: c.border,
  },
  recentChipText: {
    color: c.primary,
    fontSize: 14,
    fontWeight: "600",
  },

  emptySearchState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
    paddingHorizontal: 20,
  },
  emptyTitle: {
    color: c.primary,
    fontSize: 18,
    fontWeight: "800",
    marginTop: 16,
    textAlign: "center",
  },
  emptySubtitle: {
    color: c.textMuted,
    fontSize: 14.5,
    lineHeight: 20,
    marginTop: 8,
    textAlign: "center",
  },


/* ====================== EMPTY STATES ====================== */
emptyStateContainer: {
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: 120,
  backgroundColor: c.surfaceSunken,
},
emptyStateTitle: {
  color: c.primary,
  fontSize: 18,
  fontWeight: "700",
  marginTop: 16,
  textAlign: "center",
},
emptyStateText: {
  color: c.textMuted,
  fontSize: 15,
  textAlign: "center",
  lineHeight: 22,
  marginTop: 8,
},

  /* FAB */
  fabContainer: {
    position: "absolute",
    right: 20,
    zIndex: 100,
  },
  fab: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: c.accent,
    justifyContent: "center",
    alignItems: "center",
    elevation: 12,
    shadowColor: c.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
  },
  fabMenuContainer: {
    position: "absolute",
    right: 20,
    gap: 16,
    zIndex: 99,
  },
  menuItemContainer: {
    alignItems: "flex-end",
  },
  menuItem: {
    backgroundColor: c.chrome,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1.5,
    borderColor: c.accent,
    minWidth: 145,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 10,
  },
  menuText: {
    color: c.onChrome,
    fontSize: 15.5,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  /* Legacy / Feed styles */
  flatListContent: {
    paddingTop: 12,
    paddingBottom: 32,
    backgroundColor: c.surfaceSunken,
  },
  emptyListContent: {
    // Keep the same header geometry as the populated feed.
    // Centering/padding the entire FlatList content caused the welcome card
    // and flair row to resize or shift when refresh temporarily emptied the
    // data or when a selected flair had no matching posts.
    flexGrow: 1,
    paddingTop: 12,
    paddingBottom: 32,
    backgroundColor: c.surfaceSunken,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 32,
  },
  loadingText: {
    color: c.textSecondary,
    fontSize: 16,
    marginTop: 16,
    fontWeight: "600",
  },
  imageViewerContainer: {
    flex: 1,
    backgroundColor: "#000",
  },
  imageViewerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    paddingTop: 32,
    backgroundColor: "rgba(0,0,0,0.9)",
  },
  imageViewerCounter: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  imageViewerSlide: {
    width: SCREEN_WIDTH,
    justifyContent: "center",
    alignItems: "center",
  },
  fullscreenImage: {
    width: SCREEN_WIDTH,
    height: "100%",
  },
  // Floats over the feed rather than sitting in it, so showing or hiding it
  // never changes the list's layout or the reader's scroll position.
  newPostsPillWrap: {
    position: "absolute",
    top: 10,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 20,
  },
  newPostsPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: c.primary,
    borderWidth: 1,
    borderColor: c.accent,
    shadowColor: c.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.28,
    shadowRadius: 6,
    elevation: 5,
  },
  newPostsPillText: {
    color: c.onPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
  feedFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingVertical: 16,
  },
  feedEnd: {
    alignItems: "center",
    paddingTop: 24,
    paddingBottom: 32,
    paddingHorizontal: 32,
  },
  feedEndTitle: {
    color: c.textPrimary,
    fontSize: 16,
    fontWeight: "800",
    marginTop: 8,
    textAlign: "center",
  },
  feedEndText: {
    color: c.textMuted,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 4,
    textAlign: "center",
  },
  feedEndButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.border,
  },
  feedEndButtonText: {
    color: c.primary,
    fontSize: 13.5,
    fontWeight: "800",
  },
  offlineStatusBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffedd5",
    paddingVertical: 7,
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

// HomeScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  AppStateStatus,
  Dimensions,
  FlatList,
  Image,
  Linking,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";
import {
  removeLikeNotification,
  upsertLikeNotification,
} from "@/utils/notifications";
import { useNetworkStatus } from "@/utils/networkUtils";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import { resolveAvatarUri } from "@/utils/avatar";
import {
  getStudentDocIdFromAuthUser,
  getUserDataByAuthUser,
  resolveUserRoleForAuthUser,
  UserRole,
} from "@/utils/rbac";
import AsyncStorage from "@react-native-async-storage/async-storage";
import PollCard from "../components/PollCard";
import CommentModal from "../components/CommentModal";
import PostCard from "../components/PostCard";
import ImageZoomViewer from "../components/ImageZoomViewer";
import ServerDrawer, {
  ServerEditPatch,
  ServerMemberPreview,
} from "../components/ServerDrawer";
import {
  appendThreadToSections,
  buildCommunityServers,
  makeCustomCommunityServerDraft,
  type RemoteCommunityServerRecord,
  type ServerJoinRequestRecord,
  type ServerMembershipRecord,
} from "@/utils/communityServers";
import { consumeServerDrawerReopenRequest } from "@/utils/communityNavigation";
import {
  getCommunityChannelKey,
  readCommunityChannelLastSeenMap,
  type CommunityChannelLastSeenMap,
} from "@/utils/communityUnread";
import { canViewModeratedContent } from "@/utils/contentModeration";
import { subscribeHomeFeedScrollToTop } from "@/utils/homeFeedEvents";
import { useRelativeTimeNow } from "@/utils/relativeTime";

export const tabBarTranslateY = new Animated.Value(0);

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const SELECTED_SERVER_KEY = "bonded.selectedCommunityServer";
const HOME_SEARCH_HISTORY_KEY = "bonded.homeSearchHistory";
const DEFAULT_CHANNEL_KEY = "general";
const HOME_RETURN_ROUTE = "/(main)/(tabs)/HomeScreen";



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
  serverId?: string | null;
  channelId?: string | null;
  pinnedAt?: any;
  pinnedBy?: string | null;
  aiReply?: { text: string; model?: string | null; generatedAtMs?: number; status?: string | null };
  moderationStatus?: string;
  moderationReasons?: string[];
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
  userVotes?: number[];
  commentCount?: number;
  serverId?: string | null;
  channelId?: string | null;
  moderationStatus?: string;
  moderationReasons?: string[];
};

type PostFeedItem = Post & { type: "post" };
type PollFeedItem = Poll & { type: "poll" };
type FeedItem = PostFeedItem | PollFeedItem;

type SearchTab = "all" | "posts" | "polls" | "people";
type SearchDateFilter = "all" | "today" | "week" | "month" | "year";
type SearchSort = "relevance" | "newest" | "oldest";

type SearchResult = {
  id: string;
  kind: "post" | "poll" | "person";
  sourceId: string;
  title: string;
  subtitle: string;
  meta?: string;
  avatarLabel: string;
  timestamp: number;
  score: number;
  haystack: string;
  matchPositions?: number[]; 
};

type SearchSuggestion = {
  id: string;
  label: string;
  hint: string;
  query: string;
  kind: SearchResult["kind"] | "recent" | "trending";
};

type SearchableStudent = {
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
  notificationCommentId?: string | string[];
  notificationReplyId?: string | string[];
  notificationOpenReply?: string | string[];
};

type NotificationTarget = {
  key: string;
  postId?: string;
  commentId?: string;
  replyId?: string;
  openReplyThread: boolean;
};

const getSingleParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const getTimestampValue = (value: any) => value?.toMillis?.() || 0;

const getDateFilterThreshold = (filter: SearchDateFilter) => {
  const now = new Date();
  if (filter === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (filter === "week") {
    return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  }
  if (filter === "month") {
    return now.getTime() - 30 * 24 * 60 * 60 * 1000;
  }
  if (filter === "year") {
    return now.getTime() - 365 * 24 * 60 * 60 * 1000;
  }
  return 0;
};

const getSearchTokens = (value: string): string[] =>
  value
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

const fuzzyMatchScore = (haystack: string, token: string): number => {
  if (haystack.includes(token)) return 10;
  if (haystack.startsWith(token)) return 8;
  const index = haystack.indexOf(token);
  if (index > -1) return Math.max(1, 6 - Math.floor(index / 3));
  return 0;
};

const computeAdvancedScore = (
  haystack: string,
  tokens: string[],
  timestamp = 0,
  likeCount = 0,
  voteCount = 0,
) => {
  let score = tokens.reduce((sum, token) => sum + fuzzyMatchScore(haystack, token), 0);

  score += (likeCount || 0) * 0.015;
  score += (voteCount || 0) * 0.01;

  if (timestamp > 0) {
    const daysOld = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
    if (daysOld < 7) score += 3;
    else if (daysOld < 30) score += 1.5;
  }

  return score;
};

const matchesAllTokens = (haystack: string, tokens: string[]) =>
  tokens.every((token) => haystack.includes(token));

const getSearchResultIconName = (kind: SearchResult["kind"]) => {
  if (kind === "person") return "person";
  if (kind === "poll") return "bar-chart";
  return "document-text";
};

const getSearchSuggestionIconName = (kind: SearchSuggestion["kind"]) => {
  if (kind === "recent") return "time-outline";
  if (kind === "trending") return "sparkles-outline";
  return getSearchResultIconName(kind);
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
      first.likeCount === second.likeCount &&
      first.commentCount === second.commentCount &&
      getTimestampValue(first.createdAt) ===
        getTimestampValue(second.createdAt) &&
      areStringArraysEqual(first.likedBy || [], second.likedBy || []) &&
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
      first.userId === second.userId &&
      first.username === second.username &&
      first.isAnonymous === second.isAnonymous &&
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
      arePollOptionsEqual(first.options || [], second.options || [])
    );
  }

  return false;
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

const sortFeedItems = (items: FeedItem[]) =>
  [...items].sort(
    (first, second) => {
      const firstPinned = first.type === "post" ? getTimestampValue(first.pinnedAt) : 0;
      const secondPinned = second.type === "post" ? getTimestampValue(second.pinnedAt) : 0;

      if (firstPinned || secondPinned) {
        if (!firstPinned) return 1;
        if (!secondPinned) return -1;
        if (secondPinned !== firstPinned) return secondPinned - firstPinned;
      }

      return getTimestampValue(second.createdAt) - getTimestampValue(first.createdAt);
    },
  );

const isGlobalFeedItem = (item: FeedItem) => !item.serverId;

// ─────────────────────────────────────────────────────────────────────────────

const HomeScreen = () => {
  const insets = useSafeAreaInsets();
  const [user, setUser] = useState<User | null>(null);
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [fabMenuVisible, setFabMenuVisible] = useState(false);
  const [serverDrawerVisible, setServerDrawerVisible] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [searchCommitted, setSearchCommitted] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [searchTab, setSearchTab] = useState<SearchTab>("all");
  const [searchDateFilter, setSearchDateFilter] =
    useState<SearchDateFilter>("all");
  const [searchSort, setSearchSort] = useState<SearchSort>("relevance");
  const [currentUserRole, setCurrentUserRole] = useState<UserRole | undefined>(
    undefined,
  );
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
  const [onlineUsersCount, setOnlineUsersCount] = useState(0);
  const [onlineUsersModalVisible, setOnlineUsersModalVisible] = useState(false);
  const [upcomingEventsCount, setUpcomingEventsCount] = useState(0);
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
  const [handledNotificationKey, setHandledNotificationKey] = useState<
    string | null
  >(null);
  const [highlightedFeedKey, setHighlightedFeedKey] = useState<string | null>(
    null,
  );
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const stripUndefined = useCallback((value: Record<string, unknown>) => {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
    );
  }, []);

  const fabTranslateY = useRef(new Animated.Value(0)).current;
  const fabRotation = useRef(new Animated.Value(0)).current;
  const menuScale = useRef(new Animated.Value(0)).current;
  const scrollY = useRef(0);
  const menuOpacity = useRef(new Animated.Value(0)).current;
  const menuTranslateY = useRef(new Animated.Value(0)).current;
  const feedListRef = useRef<FlatList<FeedItem>>(null);
  const searchInputRef = useRef<TextInput>(null);
  const router = useRouter();

  const {
    notificationKey,
    notificationPostId,
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
      feedItems.filter(
        (item) =>
          isGlobalFeedItem(item) &&
          canViewModeratedContent({
            moderationStatus: item.moderationStatus,
            realUserId: item.type === "post" ? item.realUserId : item.userId,
            userId: item.userId,
            viewerUserId: user?.uid,
            viewerRole: currentUserRole,
          }),
      ),
    [currentUserRole, feedItems, user?.uid],
  );

  const selectedServerJoinRequests = useMemo(
    () =>
      serverJoinRequests.filter(
        (request) =>
          request.serverId === selectedServerId && request.status === "pending",
      ),
    [selectedServerId, serverJoinRequests],
  );

  const selectedServerMembers = useMemo<ServerMemberPreview[]>(() => {
    if (!selectedServerId) return [];

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
        const matchedStudent = searchableStudents.find(
          (student) => student.userId === memberId || student.id === memberId,
        );

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
          isOnline: matchedStudent?.isOnline === true,
        } satisfies ServerMemberPreview;
      })
      .sort((first, second) => first.name.localeCompare(second.name));
  }, [searchableStudents, selectedServer?.ownerId, selectedServerId, serverMemberships]);

  const trendingSuggestions = useMemo(() => {
    const threshold = getDateFilterThreshold(searchDateFilter);

    return visibleFeedItems
      .filter(
        (item) =>
          item.type !== "post" ||
          getTimestampValue(item.createdAt) >= threshold,
      )
      .map((item) => {
        if (item.type === "post") {
          const timestamp = getTimestampValue(item.createdAt);
          const haystack = [
            item.content,
            item.username,
            item.link?.title,
            item.link?.url,
            ...(item.taggedUsers || []).map((tag) => `${tag.name} ${tag.studentID}`),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          return {
            id: `post:${item.id}`,
            kind: "post" as const,
            sourceId: item.id,
            title: item.username || "Post",
            subtitle:
              item.content?.slice(0, 120) || item.link?.title || "Media content",
            meta: `${item.likeCount || 0} likes • ${item.commentCount || 0} comments`,
            avatarLabel: "P",
            timestamp,
            score: computeAdvancedScore(
              haystack,
              [],
              timestamp,
              item.likeCount || 0,
              0,
            ),
            haystack,
          };
        }

        const timestamp = getTimestampValue(item.createdAt);
        const haystack = [item.question, item.username, ...item.options.map((option) => option.text)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return {
          id: `poll:${item.id}`,
          kind: "poll" as const,
          sourceId: item.id,
          title: item.question,
          subtitle: `${item.options.length} options • ${item.totalVotes} votes`,
          meta: `${item.totalVotes} votes`,
          avatarLabel: "V",
          timestamp,
          score: computeAdvancedScore(haystack, [], timestamp, 0, item.totalVotes || 0),
          haystack,
        };
      })
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, 12);
  }, [searchDateFilter, visibleFeedItems]);

  const searchResults = useMemo(() => {
  if (!deferredSearchQuery.trim() && searchTab === "all") {
    return trendingSuggestions;
  }

  const tokens = getSearchTokens(deferredSearchQuery);
  const threshold = getDateFilterThreshold(searchDateFilter);

  const postResults: SearchResult[] = visibleFeedItems
    .filter((item): item is PostFeedItem => item.type === "post")
    .map((post) => {
      const haystack = [
        post.content,
        post.username,
        post.link?.title,
        post.link?.url,
        ...(post.taggedUsers || []).map((t) => `${t.name} ${t.studentID}`),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return {
        id: `post:${post.id}`,
        kind: "post" as const,
        sourceId: post.id,
        title: post.username || "Post",
        subtitle: post.content?.slice(0, 120) || post.link?.title || "Media content",
        meta: `${post.likeCount || 0} likes • ${post.commentCount || 0} comments`,
        avatarLabel: "P",
        timestamp: getTimestampValue(post.createdAt),
        score: computeAdvancedScore(
          haystack,
          tokens,
          getTimestampValue(post.createdAt),
          post.likeCount || 0,
          0,
        ),
        haystack,
      };
    })
    .filter((item) => 
      item.timestamp >= threshold &&
      (tokens.length === 0 || matchesAllTokens(item.haystack, tokens))
    );

  const pollResults: SearchResult[] = visibleFeedItems
    .filter((item): item is PollFeedItem => item.type === "poll")
    .map((poll) => {
      const haystack = [
        poll.question,
        poll.username,
        ...poll.options.map((o) => o.text),
      ].join(" ").toLowerCase();

      return {
        id: `poll:${poll.id}`,
        kind: "poll" as const,
        sourceId: poll.id,
        title: poll.question,
        subtitle: `${poll.options.length} options • ${poll.totalVotes} votes`,
        meta: `${poll.totalVotes} votes`,
        avatarLabel: "V",
        timestamp: getTimestampValue(poll.createdAt),
        score: computeAdvancedScore(
          haystack,
          tokens,
          getTimestampValue(poll.createdAt),
          0,
          poll.totalVotes || 0,
        ),
        haystack,
      };
    })
    .filter((item) => 
      item.timestamp >= threshold &&
      (tokens.length === 0 || matchesAllTokens(item.haystack, tokens))
    );

  const peopleResults: SearchResult[] = searchableStudents.map((person) => {
    const fullName = `${person.firstname} ${person.lastname}`.trim();
    const haystack = [fullName, person.studentID, person.course, person.role]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return {
      id: `person:${person.id}`,
      kind: "person" as const,
      sourceId: person.id,
      title: fullName || "Student",
      subtitle: person.course ? `${person.course} • ${person.role || "Member"}` : "BondED Member",
      meta: person.studentID,
      avatarLabel: `${person.firstname?.[0] || ""}${person.lastname?.[0] || ""}`.toUpperCase() || "U",
      timestamp: 0,
      score: computeAdvancedScore(haystack, tokens),
      haystack,
    };
  }).filter((item) => tokens.length === 0 || matchesAllTokens(item.haystack, tokens));

  let combined = [...postResults, ...pollResults, ...peopleResults];

  // Apply tab filter
  if (searchTab !== "all") {
    const tabKind =
      searchTab === "posts" ? "post" :
      searchTab === "polls" ? "poll" :
      searchTab === "people" ? "person" :
      undefined;

    if (tabKind) {
      combined = combined.filter((r) => r.kind === tabKind);
    }
  }

  // Sort
  combined.sort((a, b) => {
    if (searchSort === "newest") return b.timestamp - a.timestamp;
    if (searchSort === "oldest") return a.timestamp - b.timestamp;
    // Relevance + recency
    if (Math.abs(b.score - a.score) > 0.5) return b.score - a.score;
    return b.timestamp - a.timestamp;
  });

  return combined.slice(0, 40); // increased limit
}, [
  deferredSearchQuery,
  searchTab,
  searchDateFilter,
  searchSort,
  searchableStudents,
  trendingSuggestions,
  visibleFeedItems,
]);

  const trimmedSearchQuery = searchQuery.trim();
  const isSearchFiltered =
    searchTab !== "all" ||
    searchDateFilter !== "all" ||
    searchSort !== "relevance";
  const showSearchResultsScreen =
    searchExpanded && (searchCommitted || isSearchFiltered);
  const showSearchDropdown = searchExpanded && !showSearchResultsScreen;

  const searchSuggestions = useMemo<SearchSuggestion[]>(() => {
    if (trimmedSearchQuery) {
      return searchResults.slice(0, 5).map((result) => ({
        id: `match-${result.id}`,
        label: result.title,
        hint: result.subtitle,
        query: trimmedSearchQuery,
        kind: result.kind,
      }));
    }

    const recent = recentSearches.slice(0, 4).map((query) => ({
      id: `recent-${query}`,
      label: query,
      hint: "Recent search",
      query,
      kind: "recent" as const,
    }));

    const trending = trendingSuggestions.slice(0, 3).map((result) => ({
      id: `trending-${result.id}`,
      label: result.title,
      hint: result.meta || "Trending on Home",
      query: result.title,
      kind: "trending" as const,
    }));

    return [...recent, ...trending].slice(0, 6);
  }, [recentSearches, searchResults, trendingSuggestions, trimmedSearchQuery]);

  const peopleSearchResults = useMemo(
    () => searchResults.filter((result) => result.kind === "person").slice(0, 4),
    [searchResults],
  );

  const contentSearchResults = useMemo(
    () => searchResults.filter((result) => result.kind !== "person"),
    [searchResults],
  );

  const matchedFeedItems = useMemo(() => {
    const orderLookup = new Map(
      contentSearchResults.map((result, index) => [
        `${result.kind}:${result.sourceId}`,
        index,
      ]),
    );

    return visibleFeedItems
      .filter((item) => orderLookup.has(`${item.type}:${item.id}`))
      .sort(
        (first, second) =>
          (orderLookup.get(`${first.type}:${first.id}`) ?? 0) -
          (orderLookup.get(`${second.type}:${second.id}`) ?? 0),
      )
      .slice(0, 6);
  }, [contentSearchResults, visibleFeedItems]);



  const listenersSetup = useRef(false);
  const unsubscribePostsRef = useRef<(() => void) | null>(null);
  const unsubscribePollsRef = useRef<(() => void) | null>(null);

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

  const handleDeletePost = useCallback(
    async (postId: string) => {
      if (isOffline) {
        Alert.alert("No Connection", "Cannot delete posts while offline.");
        return;
      }

      Alert.alert("Delete Post", "This will permanently remove the post, comments, and replies.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteCommentTree(postId);
              await deleteDoc(doc(db, "posts", postId));
            } catch (error) {
              console.error("Error deleting post:", error);
              Alert.alert("Error", "Failed to delete post.");
            }
          },
        },
      ]);
    },
    [deleteCommentTree, isOffline],
  );

  const handleDeletePoll = useCallback(
    async (pollId: string) => {
      if (isOffline) {
        Alert.alert("No Connection", "Cannot delete polls while offline.");
        return;
      }

      Alert.alert("Delete Poll", "This will permanently remove the poll, comments, and replies.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteCommentTree(pollId);
              await deleteDoc(doc(db, "polls", pollId));
            } catch (error) {
              console.error("Error deleting poll:", error);
              Alert.alert("Error", "Failed to delete poll.");
            }
          },
        },
      ]);
    },
    [deleteCommentTree, isOffline],
  );

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return unsubscribe;
  }, []);

  // ── Load persisted community preferences
  useEffect(() => {
    const loadCommunityPreferences = async () => {
      try {
        const [storedServerId, storedSearches] = await Promise.all([
          AsyncStorage.getItem(SELECTED_SERVER_KEY),
          AsyncStorage.getItem(HOME_SEARCH_HISTORY_KEY),
        ]);
        if (storedServerId) setSelectedServerId(storedServerId);
        if (storedSearches) setRecentSearches(JSON.parse(storedSearches));
      } catch (error) {
        console.error("Error loading community spaces:", error);
      }
    };
    loadCommunityPreferences();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(
      HOME_SEARCH_HISTORY_KEY,
      JSON.stringify(recentSearches.slice(0, 8)),
    ).catch((error) => console.error("Error saving recent searches:", error));
  }, [recentSearches]);

  // ── Persist admin servers

  // ── Persist selected server
  useEffect(() => {
    if (selectedServerId) {
      AsyncStorage.setItem(SELECTED_SERVER_KEY, selectedServerId).catch((error) =>
        console.error("Error saving selected server:", error),
      );
      return;
    }

    AsyncStorage.removeItem(SELECTED_SERVER_KEY).catch((error) =>
      console.error("Error clearing selected server:", error),
    );
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
      feedListRef.current?.scrollToOffset({ offset: 0, animated: true });
      setHighlightedPostId(null);
      setHighlightedFeedKey(null);
      if (!searchExpanded) {
        setRefreshing(true);
        setTimeout(() => setRefreshing(false), 500);
      }
    });

    return () => subscription.remove();
  }, [searchExpanded]);

  // ── Online status heartbeat
  useEffect(() => {
    if (!user?.uid || !user?.email || isOffline) return;

    const email = user.email;
    const studentID = email.split("@")[0] || user.uid;
    const userStatusRef = doc(db, "students", studentID);
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const setOnline = async () => {
      try {
        if (!auth.currentUser) return;
        await setDoc(
          userStatusRef,
          { isOnline: true, lastSeen: serverTimestamp() },
          { merge: true },
        );
      } catch (error) {
        console.error("Error setting online status:", error);
      }
    };

    const setOffline = async () => {
      try {
        if (!auth.currentUser) return;
        await setDoc(
          userStatusRef,
          { isOnline: false, lastSeen: serverTimestamp() },
          { merge: true },
        );
      } catch (error) {
        console.error("Error setting offline status:", error);
      }
    };

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === "active") {
        void setOnline();
        if (!intervalId) {
          intervalId = setInterval(() => void setOnline(), 30000);
        }
        return;
      }

      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      void setOffline();
    };

    handleAppStateChange(AppState.currentState);
    const appStateSubscription = AppState.addEventListener("change", handleAppStateChange);
    return () => {
      appStateSubscription.remove();
      if (intervalId) {
        clearInterval(intervalId);
      }
      void setOffline();
    };
  }, [user?.uid, user?.email, isOffline]);

  // ── Online users count
  useEffect(() => {
    if (!user || isOffline) {
      setOnlineUsersCount(0);
      return;
    }
    const q = query(
      collection(db, "students"),
      where("isOnline", "==", true),
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setOnlineUsersCount(snapshot.size);
    });
    return unsubscribe;
  }, [user, isOffline]);

  // ── Upcoming events count
  useEffect(() => {
    if (!user || isOffline) {
      setUpcomingEventsCount(0);
      return;
    }
    const today = new Date().toISOString().split("T")[0];
    const q = query(
      collection(db, "events"),
      where("date", ">=", today),
      orderBy("date", "asc"),
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setUpcomingEventsCount(snapshot.size);
    });
    return unsubscribe;
  }, [user, isOffline]);

  // ── Fetch current user role
  useEffect(() => {
    const fetchCurrentUserRole = async () => {
      if (user?.uid && !isOffline && !currentUserRole) {
        try {
          const [userData, role] = await Promise.all([
            getUserDataByAuthUser(user),
            resolveUserRoleForAuthUser(user),
          ]);
          setCurrentUserProfile(userData);
          setCurrentUserRole(role);
        } catch (error) {
          console.error("Error fetching role:", error);
        }
      }
    };
    fetchCurrentUserRole();
  }, [user, isOffline, currentUserRole]);

  useEffect(() => {
    if (!user?.uid || isOffline) return;
    if (currentUserProfile?.userId === user.uid) return;

    const fetchCurrentUserProfile = async () => {
      try {
        const profile = await getUserDataByAuthUser(user);
        if (profile) setCurrentUserProfile(profile);
      } catch (error) {
        console.error("Error fetching current user profile:", error);
      }
    };
    fetchCurrentUserProfile();
  }, [user, isOffline, currentUserProfile?.userId]);

  useEffect(() => {
    if (!user || isOffline) {
      setSearchableStudents([]);
      return;
    }

    const unsubscribe = onSnapshot(
      collection(db, "students"),
      (snapshot) => {
        setSearchableStudents(
          snapshot.docs.map((item) => {
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
              isOnline: data.isOnline === true,
              lastSeen: data.lastSeen,
            };
          }),
        );
      },
      (error) => {
        console.error("Error loading searchable students:", error);
      },
    );

    return unsubscribe;
  }, [isOffline, user]);

  useEffect(() => {
    if (!user?.uid || isOffline) {
      setRemoteServers([]);
      setServerMemberships([]);
      setServerJoinRequests([]);
      setCommunityThreadMessages([]);
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
              }) as ServerJoinRequestRecord,
          ),
        );
      },
      (error) => {
        console.error("Error loading join requests:", error);
      },
    );

    const unsubscribeThreadMessages = onSnapshot(
      query(collection(db, "communityThreadMessages"), orderBy("createdAt", "asc")),
      (snapshot) => {
        setCommunityThreadMessages(
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
      },
      (error) => {
        console.error("Error loading community thread messages:", error);
      },
    );

    return () => {
      unsubscribeServers();
      unsubscribeMemberships();
      unsubscribeJoinRequests();
      unsubscribeThreadMessages();
    };
  }, [isOffline, user?.uid]);

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
    setPendingNotificationTarget({
      key,
      postId: getSingleParam(notificationPostId),
      commentId: getSingleParam(notificationCommentId),
      replyId: getSingleParam(notificationReplyId),
      openReplyThread: getSingleParam(notificationOpenReply) === "1",
    });
  }, [
    notificationCommentId,
    notificationKey,
    notificationOpenReply,
    notificationPostId,
    notificationReplyId,
  ]);

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

    console.log("🔥 Setting up feed listeners");
    listenersSetup.current = true;
    setIsLoading(true);

    const qPosts = query(
      collection(db, "posts"),
      orderBy("createdAt", "desc"),
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

        fetchedPosts.forEach((post) => {
          if (post.type === "post" && !post.isAnonymous && post.userId) {
            fetchUserRole(post.userId);
          }
        });

        setFeedItems((prev) => {
          const polls = prev.filter((item) => item.type === "poll");
          return mergeFeedItemsByIdentity(
            prev,
            sortFeedItems([...fetchedPosts, ...polls]),
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

        fetchedPolls.forEach((poll) => {
          if (poll.type === "poll" && !poll.isAnonymous && poll.userId) {
            fetchUserRole(poll.userId);
          }
        });

        setFeedItems((prev) => {
          const posts = prev.filter((item) => item.type === "post");
          return mergeFeedItemsByIdentity(
            prev,
            sortFeedItems([...posts, ...fetchedPolls]),
          );
        });
      },
      (error) => {
        if (auth.currentUser) console.error("Error fetching polls:", error);
      },
    );

    return undefined;
  }, [user, isOffline, fetchUserRole, feedItems.length]);

  // ── Cleanup on logout
  useEffect(() => {
    if (!user && listenersSetup.current) {
      console.log("🧹 Cleaning up feed listeners");
      if (unsubscribePostsRef.current) unsubscribePostsRef.current();
      if (unsubscribePollsRef.current) unsubscribePollsRef.current();
      listenersSetup.current = false;
      setFeedItems([]);
    }
  }, [user]);

  const onRefresh = useCallback(async () => {
    if (isOffline) {
      Alert.alert(
        "No Connection",
        "Please check your internet connection and try again.",
      );
      return;
    }
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 800);
  }, [isOffline]);

  const isPollExpired = useCallback((expiresAt: any) => {
    if (!expiresAt || !expiresAt.toDate) return false;
    return new Date() > expiresAt.toDate();
  }, []);

  const handleLike = useCallback(
    async (postId: string, currentLikedBy: string[] = []) => {
      if (!user) return;
      if (isOffline) {
        Alert.alert("No Connection", "Cannot like posts while offline.");
        return;
      }

      const postRef = doc(db, "posts", postId);
      const hasLiked = currentLikedBy.includes(user.uid);
      let currentPost = feedItems.find(
        (item): item is PostFeedItem =>
          item.type === "post" && item.id === postId,
      );

      const actorName =
        currentUserProfile?.firstname && currentUserProfile?.lastname
          ? `${currentUserProfile.firstname} ${currentUserProfile.lastname}`.trim()
          : user.displayName || user.email?.split("@")[0] || "Someone";

      try {
        if (!currentPost) {
          const postSnap = await getDoc(postRef);
          currentPost = postSnap.exists()
            ? ({ id: postSnap.id, type: "post", ...postSnap.data() } as PostFeedItem)
            : undefined;
        }

        const postOwnerId = currentPost?.realUserId || currentPost?.userId;

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
            actor: {
              id: user.uid,
              name: actorName,
              profileImage: currentUserProfile?.profileImage || null,
            },
            entityType: "post",
            entityId: postId,
            preview: currentPost?.content,
          });
        }
      } catch (error) {
        console.error("Error updating like:", error);
        Alert.alert("Error", "Failed to like post. Please try again.");
      }
    },
    [currentUserProfile, feedItems, isOffline, user],
  );

  // ── Scroll to post from notification
  useEffect(() => {
    if (!pendingNotificationTarget?.key) return;
    if (
      handledNotificationKey === pendingNotificationTarget.key ||
      !pendingNotificationTarget.postId
    ) {
      return;
    }

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
        Alert.alert("No Connection", "Cannot vote while offline.");
        return;
      }

      const pollRef = doc(db, "polls", pollId);
      const poll = feedItems.find(
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
        Alert.alert("Error", "Failed to vote. Please try again.");
      }
    },
    [feedItems, isOffline, isPollExpired, user],
  );

  const addOptionToPoll = useCallback(
    async (pollId: string, text: string) => {
      try {
        if (!text.trim()) {
          Alert.alert("Error", "Option cannot be empty.");
          return;
        }

        const pollRef = doc(db, "polls", pollId);
        const pollSnap = await getDoc(pollRef);

        if (!pollSnap.exists()) {
          Alert.alert("Error", "Poll not found.");
          return;
        }

        const poll = pollSnap.data() as Poll;
        if (isPollExpired(poll.expiresAt)) {
          Alert.alert("Error", "This poll has already expired.");
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
        Alert.alert("Success", "Option added! You can vote for it manually.");
      } catch (error) {
        console.error("Error adding option:", error);
        Alert.alert("Error", "Failed to add option. Please try again.");
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

    if (delta > 5) {
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
        Animated.timing(tabBarTranslateY, {
          toValue: 100,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }

    if (delta < -5) {
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
        Animated.timing(tabBarTranslateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }

    scrollY.current = currentOffsetY;
  };

  const openSearchExperience = useCallback(() => {
    setSearchExpanded(true);
    setSearchCommitted(false);
    setTimeout(() => searchInputRef.current?.focus(), 60);
  }, []);

  const closeSearchExperience = useCallback(() => {
    setSearchExpanded(false);
    setSearchCommitted(false);
    setSearchQuery("");
    setSearchTab("all");
    setSearchDateFilter("all");
    setSearchSort("relevance");
  }, []);

  const closeServerDrawer = useCallback(() => {
    setServerDrawerVisible(false);
  }, []);

  const rememberSearch = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setRecentSearches((previous) => [
      trimmed,
      ...previous.filter((item) => item.toLowerCase() !== trimmed.toLowerCase()),
    ].slice(0, 8));
  }, []);

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (!value.trim()) {
      setSearchCommitted(false);
    }
  }, []);

  const handleSearchSubmit = useCallback(() => {
    rememberSearch(searchQuery);
    setSearchCommitted(true);
  }, [rememberSearch, searchQuery]);

  const handleSearchSuggestionPress = useCallback(
    (suggestion: SearchSuggestion) => {
      setSearchQuery(suggestion.query);
      rememberSearch(suggestion.query);
      setSearchCommitted(true);
    },
    [rememberSearch],
  );

  const handleSearchTabPress = useCallback((tab: SearchTab) => {
    setSearchTab(tab);
    setSearchCommitted(true);
  }, []);

  const handleSearchDateFilterPress = useCallback(
    (filter: SearchDateFilter) => {
      setSearchDateFilter(filter);
      setSearchCommitted(true);
    },
    [],
  );

  const handleSearchSortToggle = useCallback(() => {
    const nextSort =
      searchSort === "relevance"
        ? "newest"
        : searchSort === "newest"
          ? "oldest"
          : "relevance";
    setSearchSort(nextSort);
    setSearchCommitted(true);
  }, [searchSort]);

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
        Alert.alert(
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
    ) => {
      if (!user?.uid) return;
      if (isOffline) {
        Alert.alert("No Connection", "You need internet access to create a server.");
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
        description: description?.trim() || "",
        accent: accent || nextServer.accent,
        emoji: emoji || nextServer.emoji,
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
        Alert.alert("No Connection", "You need internet access to update this server.");
        return;
      }

      const updatePayload: Record<string, unknown> = {
        updatedAt: serverTimestamp(),
      };

      if (patch.name !== undefined) updatePayload.name = patch.name.trim();
      if (patch.description !== undefined) {
        updatePayload.description = patch.description.trim();
      }
      if (patch.accent !== undefined) updatePayload.accent = patch.accent;
      if (patch.isPublic !== undefined) updatePayload.isPublic = patch.isPublic;
      if (patch.logoUri !== undefined) updatePayload.logoUri = patch.logoUri;
      if (patch.bannerUri !== undefined) updatePayload.bannerUri = patch.bannerUri;
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
        Alert.alert("No Connection", "You need internet access to delete this server.");
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

  const handleCreateThread = useCallback(
    async (
      serverId: string,
      label: string,
      emoji?: string,
      description?: string,
    ) => {
      if (isOffline) {
        Alert.alert("No Connection", "You need internet access to create a channel.");
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
      );

      await setDoc(
        doc(db, "communityServers", serverId),
        {
          sections: nextSections,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    },
    [isOffline, remoteServers],
  );

  const handleRequestJoin = useCallback(
    async (serverId: string) => {
      if (!user?.uid) return;
      if (isOffline) {
        Alert.alert("No Connection", "You need internet access to request access.");
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
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      Alert.alert(
        "Request Sent",
        "A teacher, moderator, or admin can approve your request.",
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
                  }
                : item,
            ),
          ),
        );

        await updateDoc(doc(db, "posts", postId), {
          pinnedAt: shouldPin ? serverTimestamp() : null,
          pinnedBy: shouldPin ? user.uid : null,
        });
      } catch (error) {
        console.error("Error updating pinned post:", error);
        Alert.alert("Error", "Failed to update the pinned post.");
      }
    },
    [currentUserRole, user?.uid],
  );

  const handleApproveJoinRequest = useCallback(
    async (serverId: string, targetUserId: string) => {
      if (!user?.uid) return;
      if (isOffline) {
        Alert.alert("No Connection", "You need internet access to approve requests.");
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
        Alert.alert(
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
        Alert.alert("No Connection", "You need internet access to reject requests.");
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
        Alert.alert(
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
        Alert.alert("Unavailable", "Admins cannot leave servers.");
        return;
      }
      if (isOffline) {
        Alert.alert("No Connection", "You need internet access to leave this server.");
        return;
      }

      Alert.alert("Leave Server", "You will lose access to this server until you join again.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: async () => {
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
        },
      ]);
    },
    [currentUserRole, exitServerView, isOffline, selectedServerId, user?.uid],
  );

  const handleMenuAction = (action: string) => {
    if (isOffline) {
      Alert.alert("No Connection", "Cannot create posts while offline.");
      return;
    }
    toggleFabMenu();

    if (action === "create") {
      router.push("/CreatePostScreen");
    } else if (action === "polls") {
      router.push("/CreatePollScreen");
    } else if (action === "live") {
      router.push({
        pathname: "/LiveStreamScreen",
        params: {
          serverId: selectedServer?.id || "",
          serverName: selectedServer?.name || "",
          channelId: selectedChannel?.id || "",
          channelLabel: selectedChannel?.label || "",
        },
      });
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
              Alert.alert(
                "Cannot Open File",
                "Unable to open this file type on your device.",
              );
            }
          })
          .catch((err) => {
            console.error("Error opening URL:", err);
            Alert.alert("Error", "Failed to open file. Please try again.");
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

  const jumpToSearchResult = useCallback(
    (result: {
      kind: "post" | "poll" | "person";
      sourceId: string;
      id: string;
      title: string;
    }) => {
      if (result.kind === "person") {
        closeSearchExperience();
        if (result.sourceId === user?.uid) {
          router.push({
            pathname: "/(main)/(tabs)/ProfileScreen",
            params: { returnTo: HOME_RETURN_ROUTE },
          });
        } else {
          router.push(
            buildUserProfileHref({
              userId: result.sourceId,
              returnTo: HOME_RETURN_ROUTE,
            }) as any,
          );
        }
        rememberSearch(searchQuery || result.title);
        return;
      }

      const index = visibleFeedItems.findIndex(
        (item) => item.type === result.kind && item.id === result.sourceId,
      );
      if (index < 0) {
        Alert.alert("Not Found", "That item is no longer available in Home.");
        return;
      }

      closeSearchExperience();
      rememberSearch(searchQuery || result.title);
      setHighlightedFeedKey(result.id);
      setTimeout(() => setHighlightedFeedKey(null), 3500);
      setTimeout(() => {
        feedListRef.current?.scrollToIndex({
          index,
          animated: true,
          viewPosition: 0.18,
        });
      }, 150);
    },
    [
      closeSearchExperience,
      rememberSearch,
      router,
      searchQuery,
      user?.uid,
      visibleFeedItems,
    ],
  );

  const rotation = fabRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "135deg"],
  });
  const relativeTimeNow = useRelativeTimeNow();

  const getTimeAgo = useCallback((timestamp: any) => {
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
      year:
        postDate.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
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

  const onlineRoster = useMemo(
    () =>
      [...searchableStudents].sort((first, second) => {
        if (first.isOnline !== second.isOnline) {
          return first.isOnline ? -1 : 1;
        }
        return getTimestampValue(second.lastSeen) - getTimestampValue(first.lastSeen);
      }),
    [searchableStudents],
  );

  const renderFeedHeader = useCallback(() => {
    return null;
  }, []);

  const renderFeedItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      if (item.type === "post") {
        const post = item as Post;
        const isLiked = post.likedBy?.includes(user?.uid || "") || false;
        return (
          <PostCard
            post={post}
            isLiked={isLiked}
            isHighlighted={
              highlightedPostId === post.id || highlightedFeedKey === `post:${post.id}`
            }
            currentUserRole={currentUserRole}
            currentUserId={user?.uid}
            onLike={handleLike}
            onDelete={handleDeletePost}
            canPin={["admin", "teacher", "moderator"].includes(currentUserRole || "")}
            onTogglePin={handleTogglePinnedPost}
            onProfileClick={handlePostCardProfileClick}
            onTagClick={handlePostCardTagClick}
            onImagePress={openImageViewer}
            onFilePress={handleFilePress}
            getTimeAgo={getTimeAgo}
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
          onProfileClick={handleProfileClick}
          getTimeAgo={getTimeAgo}
          isPollExpired={isPollExpired}
        />
      );
    },
    [
      addOptionToPoll,
      currentUserRole,
      getTimeAgo,
      handleFilePress,
      handleLike,
      handleDeletePoll,
      handleDeletePost,
      handleTogglePinnedPost,
      handlePollVote,
      handlePostCardProfileClick,
      handlePostCardTagClick,
      handleProfileClick,
      highlightedFeedKey,
      highlightedPostId,
      isPollExpired,
      openImageViewer,
      user?.uid,
      userRoles,
    ],
  );

  const renderSearchResultsScreen = useCallback(() => {
    const showPeopleSection = searchTab === "all" || searchTab === "people";
    const showContentSection =
      searchTab === "all" || searchTab === "posts" || searchTab === "polls";
    const resultSummary = trimmedSearchQuery
      ? `Showing ${searchResults.length} matches${searchDateFilter === "all" ? "" : ` from ${searchDateFilter === "today" ? "today" : searchDateFilter === "week" ? "this week" : searchDateFilter === "month" ? "this month" : "this year"}`}.`
      : "Browse people and recent community activity with simple filters.";

    return (
      <ScrollView
        style={styles.searchScreen}
        contentContainerStyle={styles.searchScreenContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.searchOverviewCard}>
          <View style={styles.searchOverviewIcon}>
            <Ionicons
              name={trimmedSearchQuery ? "sparkles" : "search"}
              size={20}
              color="#5f0909"
            />
          </View>
          <View style={styles.searchOverviewCopy}>
            <Text style={styles.searchOverviewTitle}>
              {trimmedSearchQuery
                ? `Results for "${trimmedSearchQuery}"`
                : "Search Home"}
            </Text>
            <Text style={styles.searchOverviewSubtitle}>{resultSummary}</Text>
          </View>
        </View>

        <View style={styles.searchMetricsRow}>
          <View style={styles.searchMetricChip}>
            <Text style={styles.searchMetricValue}>{peopleSearchResults.length}</Text>
            <Text style={styles.searchMetricLabel}>People</Text>
          </View>
          <View style={styles.searchMetricChip}>
            <Text style={styles.searchMetricValue}>{contentSearchResults.length}</Text>
            <Text style={styles.searchMetricLabel}>Posts & polls</Text>
          </View>
          <View style={styles.searchMetricChip}>
            <Text style={styles.searchMetricValue}>
              {searchDateFilter === "all" ? "Any" : searchDateFilter}
            </Text>
            <Text style={styles.searchMetricLabel}>Date</Text>
          </View>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.quickFiltersRow}
          style={styles.quickFiltersContainer}
        >
          {[
            { key: "all", label: "Everything" },
            { key: "posts", label: "Posts" },
            { key: "polls", label: "Polls" },
            { key: "people", label: "People" },
          ].map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[
                styles.quickFilterChip,
                searchTab === tab.key && styles.quickFilterChipActive,
              ]}
              onPress={() => handleSearchTabPress(tab.key as SearchTab)}
              activeOpacity={0.9}
            >
              <Text
                style={[
                  styles.quickFilterText,
                  searchTab === tab.key && styles.quickFilterTextActive,
                ]}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.quickFiltersRow}
        >
          {[
            { key: "all", label: "Any time" },
            { key: "today", label: "Today" },
            { key: "week", label: "This week" },
            { key: "month", label: "This month" },
            { key: "year", label: "This year" },
          ].map((item) => (
            <TouchableOpacity
              key={item.key}
              style={[
                styles.timeChip,
                searchDateFilter === item.key && styles.timeChipActive,
              ]}
              onPress={() =>
                handleSearchDateFilterPress(item.key as SearchDateFilter)
              }
              activeOpacity={0.9}
            >
              <Text
                style={[
                  styles.timeChipText,
                  searchDateFilter === item.key && styles.timeChipTextActive,
                ]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          ))}

          <TouchableOpacity
            style={[styles.timeChip, styles.sortChip]}
            onPress={handleSearchSortToggle}
            activeOpacity={0.9}
          >
            <Ionicons name="swap-vertical" size={14} color="#8f6a60" />
            <Text style={styles.timeChipText}>
              {searchSort === "relevance"
                ? "Best match"
                : searchSort === "newest"
                  ? "Newest first"
                  : "Oldest first"}
            </Text>
          </TouchableOpacity>
        </ScrollView>

        {searchResults.length === 0 ? (
          <View style={styles.emptySearchState}>
            <Ionicons name="search-outline" size={58} color="#d4b8a8" />
            <Text style={styles.emptyTitle}>No results found</Text>
            <Text style={styles.emptySubtitle}>
              Try a different keyword or widen the date filter.
            </Text>
          </View>
        ) : (
          <>
            {showPeopleSection && peopleSearchResults.length > 0 && (
              <View style={styles.searchSection}>
                <View style={styles.searchSectionHeader}>
                  <View style={styles.searchSectionIcon}>
                    <Ionicons name="people" size={18} color="#5f0909" />
                  </View>
                  <View style={styles.searchSectionCopy}>
                    <Text style={styles.searchSectionTitle}>People</Text>
                    <Text style={styles.searchSectionSubtitle}>
                      Profiles that closely match your search.
                    </Text>
                  </View>
                </View>

                {peopleSearchResults.map((result) => (
                  <TouchableOpacity
                    key={result.id}
                    style={styles.personResultCard}
                    onPress={() => jumpToSearchResult(result)}
                    activeOpacity={0.88}
                  >
                    <View style={styles.personAvatar}>
                      <Text style={styles.personAvatarText}>
                        {result.avatarLabel}
                      </Text>
                    </View>
                    <View style={styles.personResultCopy}>
                      <Text style={styles.personResultTitle}>{result.title}</Text>
                      <Text
                        style={styles.personResultSubtitle}
                        numberOfLines={2}
                      >
                        {result.subtitle}
                      </Text>
                    </View>
                    <Ionicons
                      name="chevron-forward"
                      size={18}
                      color="#c47e6e"
                    />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {showContentSection && matchedFeedItems.length > 0 && (
              <View style={styles.searchSection}>
                <View style={styles.searchSectionHeader}>
                  <View style={styles.searchSectionIcon}>
                    <Ionicons name="newspaper" size={18} color="#5f0909" />
                  </View>
                  <View style={styles.searchSectionCopy}>
                    <Text style={styles.searchSectionTitle}>Related Content</Text>
                    <Text style={styles.searchSectionSubtitle}>
                      Matching posts and polls from Home.
                    </Text>
                  </View>
                </View>

                {matchedFeedItems.map((item) => (
                  <View
                    key={`search-feed-${item.type}-${item.id}`}
                    style={styles.searchFeedCardWrap}
                  >
                    {renderFeedItem({ item })}
                  </View>
                ))}
              </View>
            )}

            {trimmedSearchQuery ? (
              <View style={styles.searchTopicCard}>
                <Text style={styles.searchTopicTitle}>
                  Posts about {trimmedSearchQuery}
                </Text>
                <Text style={styles.searchTopicSubtitle}>
                  {contentSearchResults.length} related item
                  {contentSearchResults.length === 1 ? "" : "s"} found on Home.
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    );
  }, [
    contentSearchResults.length,
    handleSearchDateFilterPress,
    handleSearchSortToggle,
    handleSearchTabPress,
    jumpToSearchResult,
    matchedFeedItems,
    peopleSearchResults,
    renderFeedItem,
    searchDateFilter,
    searchResults.length,
    searchSort,
    searchTab,
    trimmedSearchQuery,
  ]);
const renderEmptyState = () => {
  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#e0a53d" />
        <Text style={styles.loadingText}>Loading feed...</Text>
      </View>
    );
  }

  if (isOffline && feedItems.length === 0) {
    return (
      <View style={styles.emptySearchState}>   {/* Reuse the nice empty style */}
        <Ionicons name="cloud-offline" size={58} color="#d4b8a8" />
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
        <Ionicons name="chatbubbles-outline" size={58} color="#d4b8a8" />
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
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        {searchExpanded ? (
          <View style={styles.headerSearchRow}>
            <TouchableOpacity
              style={styles.headerIconButton}
              activeOpacity={0.82}
              onPress={openServerDrawer}
            >
              <Ionicons name="menu" size={22} color="#f4e7df" />
            </TouchableOpacity>

            <View style={styles.headerSearchBar}>
              <Ionicons name="search" size={20} color="#7f4d44" />
              <TextInput
                ref={searchInputRef}
                style={styles.headerSearchInput}
                value={searchQuery}
                onChangeText={handleSearchQueryChange}
                placeholder="Search people, posts, or polls"
                placeholderTextColor="#af8478"
                returnKeyType="search"
                autoFocus
                onSubmitEditing={handleSearchSubmit}
              />
              {searchQuery.length > 0 ? (
                <TouchableOpacity
                  onPress={() => {
                    setSearchQuery("");
                    setSearchCommitted(false);
                  }}
                  activeOpacity={0.82}
                >
                  <Ionicons name="close-circle" size={20} color="#c47e6e" />
                </TouchableOpacity>
              ) : null}
            </View>

            <TouchableOpacity
              onPress={closeSearchExperience}
              style={styles.searchCancelButton}
              activeOpacity={0.82}
            >
              <Text style={styles.searchCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.headerLeft}>
              <TouchableOpacity
                style={styles.headerIconButton}
                activeOpacity={0.82}
                onPress={openServerDrawer}
              >
                <Ionicons name="menu" size={22} color="#f4e7df" />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.headerIconButton}
                activeOpacity={0.82}
                onPress={openSearchExperience}
              >
                <Ionicons name="search" size={20} color="#f4e7df" />
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
                onPress={() => router.push("/EventCalendarScreen")}
              >
                <Ionicons name="calendar-outline" size={22} color="#5f0909" />
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
        {showSearchResultsScreen ? (
          renderSearchResultsScreen()
        ) : (
          <FlatList
            ref={feedListRef}
            data={visibleFeedItems}
            renderItem={renderFeedItem}
            keyExtractor={(item) => item.id}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            contentContainerStyle={
              visibleFeedItems.length === 0
                ? styles.emptyListContent
                : styles.flatListContent
            }
            ListEmptyComponent={renderEmptyState}
            ListHeaderComponent={renderFeedHeader}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                colors={["#dca33d"]}
                tintColor="#dca33d"
                title={isOffline ? "Offline" : "Refreshing feed..."}
                titleColor="#dca33d"
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
        )}

        {showSearchDropdown ? (
          <View style={styles.searchDropdownCard}>
            <View style={styles.searchDropdownHeader}>
              <Text style={styles.searchDropdownTitle}>
                {trimmedSearchQuery ? "Quick matches" : "Recent and trending"}
              </Text>
              {trimmedSearchQuery ? (
                <TouchableOpacity
                  onPress={handleSearchSubmit}
                  activeOpacity={0.82}
                >
                  <Text style={styles.searchDropdownAction}>See all</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {searchSuggestions.length > 0 ? (
              searchSuggestions.map((suggestion) => (
                <TouchableOpacity
                  key={suggestion.id}
                  style={styles.searchSuggestionRow}
                  onPress={() => handleSearchSuggestionPress(suggestion)}
                  activeOpacity={0.86}
                >
                  <View style={styles.searchSuggestionIconWrap}>
                    <Ionicons
                      name={getSearchSuggestionIconName(suggestion.kind)}
                      size={18}
                      color="#7c2a22"
                    />
                  </View>
                  <View style={styles.searchSuggestionCopy}>
                    <Text
                      style={styles.searchSuggestionTitle}
                      numberOfLines={1}
                    >
                      {suggestion.label}
                    </Text>
                    <Text
                      style={styles.searchSuggestionHint}
                      numberOfLines={1}
                    >
                      {suggestion.hint}
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={16}
                    color="#c47e6e"
                  />
                </TouchableOpacity>
              ))
            ) : (
              <View style={styles.searchDropdownEmpty}>
                <Ionicons name="search-outline" size={22} color="#c9a89a" />
                <Text style={styles.searchDropdownEmptyText}>
                  Start typing to search Home.
                </Text>
              </View>
            )}
          </View>
        ) : null}
      </View>

      <Modal
        visible={onlineUsersModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setOnlineUsersModalVisible(false)}
      >
        <View style={styles.onlineModalOverlay}>
          <View style={styles.onlineModalCard}>
            <View style={styles.onlineModalHeader}>
              <View>
                <Text style={styles.onlineModalTitle}>Campus Presence</Text>
                <Text style={styles.onlineModalSubtitle}>
                  {onlineUsersCount} online right now
                </Text>
              </View>
              <TouchableOpacity onPress={() => setOnlineUsersModalVisible(false)}>
                <Ionicons name="close" size={24} color="#7a3b2e" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {onlineRoster.map((student) => {
                const fullName = `${student.firstname} ${student.lastname}`.trim() || "Student";
                return (
                  <TouchableOpacity
                    key={student.id}
                    style={styles.onlineUserRow}
                    activeOpacity={0.82}
                    onPress={() => {
                      setOnlineUsersModalVisible(false);
                      handleProfileClick(student.id, false);
                    }}
                  >
                    <View style={styles.onlineAvatarWrap}>
                      {student.profileImage ? (
                        <Image
                          source={{ uri: student.profileImage }}
                          style={styles.onlineAvatarImage}
                        />
                      ) : (
                        <Text style={styles.onlineAvatarText}>
                          {(student.firstname?.[0] || fullName[0] || "S").toUpperCase()}
                        </Text>
                      )}
                    </View>
                    <View style={styles.onlineUserCopy}>
                      <Text style={styles.onlineUserName}>{fullName}</Text>
                      <Text style={styles.onlineUserMeta}>
                        {student.course || student.role || "Campus member"}
                      </Text>
                    </View>
                    <View style={styles.onlineStatusWrap}>
                      <View
                        style={[
                          styles.onlineStatusPill,
                          student.isOnline
                            ? styles.onlineStatusPillActive
                            : styles.onlineStatusPillIdle,
                        ]}
                      >
                        <Text
                          style={[
                            styles.onlineStatusText,
                            student.isOnline
                              ? styles.onlineStatusTextActive
                              : styles.onlineStatusTextIdle,
                          ]}
                        >
                          {student.isOnline ? "Online" : "Offline"}
                        </Text>
                      </View>
                      <Text style={styles.onlineLastSeenText}>
                        {student.isOnline ? "Active now" : formatLastSeen(student.lastSeen)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
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
        onCreateThread={handleCreateThread}
        onRequestJoin={handleRequestJoin}
        onApproveJoinRequest={handleApproveJoinRequest}
        onRejectJoinRequest={handleRejectJoinRequest}
        onOpenUserProfile={(userId, profileDocId) =>
          handleProfileClick(userId, false, profileDocId)
        }
        onLeaveServer={handleLeaveServer}
        pendingJoinRequests={selectedServerJoinRequests}
        serverMembers={selectedServerMembers}
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
            <Ionicons name="add" size={28} color="#5f0909" />
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
   </SafeAreaView>
    </GestureDetector>
  );
};

export default HomeScreen;

// ─── Final Improved Styles ─────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: "#5f0909" 
  },

  /* ====================== HEADER ====================== */
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#7f2220",
    backgroundColor: "#5f0909",
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
    gap: 14,
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
    fontSize: 19,
    fontWeight: "700",
    color: "#f4e7df",
    letterSpacing: 0.8,
  },
  headerIcons: {
    flexDirection: "row",
    gap: 14,
    alignItems: "center",
  },
  onlineUsersContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f0e7e2",
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 6,
    borderWidth: 1,
    borderColor: "#d6c9c2",
  },
  onlineDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: "#8f3a2b",
  },
  onlineUsersText: {
    color: "#5f0909",
    fontSize: 13.5,
    fontWeight: "700",
  },
  onlineModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(10, 2, 2, 0.72)",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  onlineModalCard: {
    maxHeight: "76%",
    backgroundColor: "#fffaf7",
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: "#ead8cf",
  },
  onlineModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  onlineModalTitle: {
    color: "#4d1b17",
    fontSize: 19,
    fontWeight: "800",
  },
  onlineModalSubtitle: {
    color: "#9b766c",
    fontSize: 13,
    marginTop: 3,
  },
  onlineUserRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f1e4dc",
    gap: 12,
  },
  onlineAvatarWrap: {
    width: 48,
    height: 48,
    borderRadius: 18,
    backgroundColor: "#f4d7b1",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  onlineAvatarImage: {
    width: "100%",
    height: "100%",
  },
  onlineAvatarText: {
    color: "#5f0909",
    fontSize: 17,
    fontWeight: "800",
  },
  onlineUserCopy: {
    flex: 1,
  },
  onlineUserName: {
    color: "#381713",
    fontSize: 15.5,
    fontWeight: "700",
  },
  onlineUserMeta: {
    color: "#8d6a61",
    fontSize: 12.5,
    marginTop: 3,
  },
  onlineStatusWrap: {
    alignItems: "flex-end",
    maxWidth: 110,
  },
  onlineStatusPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  onlineStatusPillActive: {
    backgroundColor: "#e7f8ec",
  },
  onlineStatusPillIdle: {
    backgroundColor: "#f0e7e2",
  },
  onlineStatusText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  onlineStatusTextActive: {
    color: "#17663a",
  },
  onlineStatusTextIdle: {
    color: "#7a3b2e",
  },
  onlineLastSeenText: {
    color: "#9b766c",
    fontSize: 11,
    textAlign: "right",
    marginTop: 4,
  },
  calendarButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#e0a53d",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#d69a2f",
    position: "relative",
  },
  eventBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: "#f4e7df",
    borderRadius: 12,
    minWidth: 22,
    height: 22,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#5f0909",
  },
  eventBadgeText: {
    color: "#5f0909",
    fontSize: 11.5,
    fontWeight: "bold",
  },

  /* ====================== SEARCH ====================== */
  contentArea: {
    flex: 1,
    backgroundColor: "#f8f3ef",
  },
  headerSearchRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerSearchBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff7f2",
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1.5,
    borderColor: "#e6c6b9",
    shadowColor: "#280404",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
  },
  headerSearchInput: {
    flex: 1,
    color: "#3f1e1a",
    fontSize: 17,
    fontWeight: "500",
    marginLeft: 10,
    paddingVertical: 0,
  },
  searchCancelButton: {
    paddingHorizontal: 2,
    paddingVertical: 10,
  },
  searchCancelText: {
    color: "#f4dccc",
    fontSize: 16,
    fontWeight: "600",
  },
  searchDropdownCard: {
    position: "absolute",
    top: 8,
    left: 14,
    right: 14,
    backgroundColor: "#fffaf7",
    borderRadius: 24,
    padding: 14,
    borderWidth: 1.5,
    borderColor: "#ead8cd",
    shadowColor: "#2d0905",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    elevation: 14,
    zIndex: 30,
  },
  searchDropdownHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  searchDropdownTitle: {
    color: "#4d1b17",
    fontSize: 15.5,
    fontWeight: "800",
  },
  searchDropdownAction: {
    color: "#b45c4b",
    fontSize: 13.5,
    fontWeight: "700",
  },
  searchSuggestionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 6,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f1e4dc",
  },
  searchSuggestionIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 14,
    backgroundColor: "#f9e4d7",
    alignItems: "center",
    justifyContent: "center",
  },
  searchSuggestionCopy: {
    flex: 1,
  },
  searchSuggestionTitle: {
    color: "#3f1e1a",
    fontSize: 15.5,
    fontWeight: "700",
  },
  searchSuggestionHint: {
    color: "#8d6a61",
    fontSize: 13,
    marginTop: 2,
  },
  searchDropdownEmpty: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 6,
    paddingVertical: 12,
  },
  searchDropdownEmptyText: {
    color: "#9c776d",
    fontSize: 14,
    fontWeight: "500",
  },
  searchScreen: {
    flex: 1,
  },
  searchScreenContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 140,
  },
  searchOverviewCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "#fff8f3",
    borderRadius: 24,
    padding: 16,
    borderWidth: 1.5,
    borderColor: "#efd9ca",
    marginBottom: 14,
  },
  searchOverviewIcon: {
    width: 42,
    height: 42,
    borderRadius: 15,
    backgroundColor: "#f8ddbf",
    alignItems: "center",
    justifyContent: "center",
  },
  searchOverviewCopy: {
    flex: 1,
  },
  searchOverviewTitle: {
    color: "#4a1712",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 3,
  },
  searchOverviewSubtitle: {
    color: "#86645a",
    fontSize: 14,
    lineHeight: 20,
  },
  searchMetricsRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 10,
  },
  searchMetricChip: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#ebddd4",
    alignItems: "center",
  },
  searchMetricValue: {
    color: "#5f0909",
    fontSize: 16,
    fontWeight: "800",
    textTransform: "capitalize",
  },
  searchMetricLabel: {
    color: "#9b766c",
    fontSize: 12.5,
    fontWeight: "600",
    marginTop: 3,
  },

  /* Filters */
  quickFiltersContainer: {
    marginBottom: 6,
  },
  quickFiltersRow: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 4,
    paddingRight: 8,
  },
  quickFilterChip: {
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: "#fff",
    borderWidth: 1.5,
    borderColor: "#e8d9d0",
  },
  quickFilterChipActive: {
    backgroundColor: "#5f0909",
    borderColor: "#5f0909",
  },
  quickFilterText: {
    color: "#8c5f54",
    fontSize: 14.5,
    fontWeight: "600",
  },
  quickFilterTextActive: {
    color: "#f4e7df",
    fontWeight: "700",
  },
  timeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#e8d9d0",
  },
  sortChip: {
    marginLeft: 4,
  },
  timeChipActive: {
    backgroundColor: "#5f0909",
    borderColor: "#5f0909",
  },
  timeChipText: {
    color: "#8f6a60",
    fontSize: 13.5,
    fontWeight: "600",
  },
  timeChipTextActive: {
    color: "#f4e7df",
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
    color: "#4d1b17",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  clearAllText: {
    color: "#c15f4a",
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
    borderColor: "#e8d9d0",
  },
  recentChipText: {
    color: "#5f0909",
    fontSize: 14,
    fontWeight: "600",
  },

  /* Results */
  searchSection: {
    marginTop: 14,
  },
  searchSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  searchSectionIcon: {
    width: 44,
    height: 44,
    borderRadius: 16,
    backgroundColor: "#f9dfc8",
    alignItems: "center",
    justifyContent: "center",
  },
  searchSectionCopy: {
    flex: 1,
  },
  searchSectionTitle: {
    color: "#4d1b17",
    fontSize: 16.5,
    fontWeight: "800",
  },
  searchSectionSubtitle: {
    color: "#967267",
    fontSize: 13.5,
    marginTop: 2,
  },
  personResultCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 22,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#efdfd6",
  },
  personAvatar: {
    width: 50,
    height: 50,
    borderRadius: 18,
    backgroundColor: "#f4d7b1",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  personAvatarText: {
    color: "#5f0909",
    fontSize: 17,
    fontWeight: "800",
  },
  personResultCopy: {
    flex: 1,
    marginRight: 8,
  },
  personResultTitle: {
    color: "#381713",
    fontSize: 16,
    fontWeight: "700",
  },
  personResultSubtitle: {
    color: "#77574f",
    fontSize: 13.5,
    lineHeight: 19,
    marginTop: 3,
  },
  searchFeedCardWrap: {
    marginBottom: 12,
  },
  searchTopicCard: {
    backgroundColor: "#fffaf4",
    borderRadius: 22,
    padding: 18,
    borderWidth: 1.5,
    borderColor: "#edd7b5",
    marginTop: 16,
  },
  searchTopicTitle: {
    color: "#4c1b14",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 6,
  },
  searchTopicSubtitle: {
    color: "#87685f",
    fontSize: 14,
    lineHeight: 20,
  },
  emptySearchState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 56,
    paddingHorizontal: 26,
  },
  emptyTitle: {
    color: "#5f0909",
    fontSize: 18,
    fontWeight: "800",
    marginTop: 14,
    textAlign: "center",
  },
  emptySubtitle: {
    color: "#9b776d",
    fontSize: 14.5,
    lineHeight: 21,
    marginTop: 8,
    textAlign: "center",
  },


/* ====================== EMPTY STATES ====================== */
emptyStateContainer: {
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: 120,
  backgroundColor: "#f8f3ef",
},
emptyStateTitle: {
  color: "#5f0909",
  fontSize: 19,
  fontWeight: "700",
  marginTop: 16,
  textAlign: "center",
},
emptyStateText: {
  color: "#a17d71",
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
    backgroundColor: "#e0a53d",
    justifyContent: "center",
    alignItems: "center",
    elevation: 12,
    shadowColor: "#5f0909",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
  },
  fabMenuContainer: {
    position: "absolute",
    right: 20,
    gap: 14,
    zIndex: 99,
  },
  menuItemContainer: {
    alignItems: "flex-end",
  },
  menuItem: {
    backgroundColor: "#5f0909",
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1.5,
    borderColor: "#e0a53d",
    minWidth: 145,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 10,
  },
  menuText: {
    color: "#f4e7df",
    fontSize: 15.5,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  /* Legacy / Feed styles */
  flatListContent: {
    paddingTop: 12,
    paddingBottom: 130,
    backgroundColor: "#f8f3ef",
  },
  emptyListContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 30,
    backgroundColor: "#f8f3ef",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 120,
  },
  loadingText: {
    color: "#7a3b2e",
    fontSize: 16.5,
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
    paddingTop: 50,
    backgroundColor: "rgba(0,0,0,0.9)",
  },
  imageViewerCounter: {
    color: "#fff",
    fontSize: 17,
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
});
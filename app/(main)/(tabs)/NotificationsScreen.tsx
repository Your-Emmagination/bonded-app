import { getDirectNotificationTarget } from "@/utils/messengerState";
import { useNetworkStatus } from "@/utils/networkUtils";
import {
    getCachedNotifications,
    saveCachedNotifications,
} from "@/utils/offlineStorage";
import { resolveAvatarUri } from "@/utils/avatar";
import { ensureUserData, peekUserData, subscribeToUserDataUpdates } from "@/utils/rbac";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { subscribeTabScrollToTop } from "@/utils/tabScrollEvents";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { onAuthStateChanged, User } from "firebase/auth";
import {
    collection,
    doc,
    getDoc,
    onSnapshot,
    query,
    updateDoc,
    where,
    writeBatch,
} from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Animated,
    Modal,
    Platform, RefreshControl, SectionList,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";
import ConfirmDialog from "../components/ConfirmDialog";
import { ListSkeleton } from "../components/Skeleton";
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";

type NotificationType =
  | "direct_message"
  | "like"
  | "comment"
  | "reply"
  | "mention"
  | "activity"
  | "event"
  | "emergency"
  | "moderation"
  | "moderation_approved"
  | "support";
type TimeSection = "Today" | "Yesterday" | "This Week" | "This Month" | "Older";
type FilterOption =
  | "All"
  | "Today"
  | "Yesterday"
  | "This Week"
  | "This Month"
  | "Older";

type NotificationItem = {
  id: string;
  type: NotificationType;
  entityType?: "post" | "poll" | "comment" | "reply" | "event" | "emergency" | "direct_message" | "thread_message" | "support_ticket";
  entityId?: string;
  parentId?: string | null;
  /** Set on thread_message mentions so the tap can open the channel itself. */
  channelId?: string | null;
  /** Auth uid of whoever caused this. Written by createNotification. */
  actorId?: string;
  actorName: string;
  /** Anonymous posters keep their stored name — a live lookup would out them. */
  actorIsAnonymous?: boolean;
  // Firestore field written by utils/notifications.ts is `actorProfileImage`
  // (see createNotification's payload). This used to read a nonexistent
  // `actorAvatar` field, so avatars never rendered — every row silently fell
  // back to the initial-letter placeholder. Fixed to read the real field.
  actorProfileImage?: string | null;
  message: string;
  preview?: string | null;
  createdAt?: any;
  read: boolean;
  /**
   * Set when one row stands for several like notifications on the same post.
   * Display-only: the underlying documents are untouched, so the tab's unread
   * badge still counts every real notification. Holds every id in the group
   * (including this one) so opening the row marks them all read together.
   */
  collapsedIds?: string[];
};

/**
 * Folds repeated likes on the same content into one row, the way a social app
 * does: "Ana Cruz and 4 others liked your post" instead of five separate
 * lines that push everything else off the screen.
 *
 * Only likes collapse. A comment, a reply or a mention is a distinct thing
 * somebody said and each deserves its own row; a like carries no content, so
 * five of them carry no more information than one plus a number.
 *
 * Input must already be newest-first — the first item of each group becomes
 * the row that is shown and tapped.
 */
function collapseLikeNotifications(items: NotificationItem[]): NotificationItem[] {
  const output: NotificationItem[] = [];
  const groupIndexByKey = new Map<string, number>();
  const actorsByKey = new Map<string, string[]>();

  items.forEach((item) => {
    if (item.type !== "like" || !item.entityId) {
      output.push(item);
      return;
    }

    const key = `like:${item.entityType || "post"}:${item.entityId}`;
    const existingIndex = groupIndexByKey.get(key);

    if (existingIndex === undefined) {
      groupIndexByKey.set(key, output.length);
      actorsByKey.set(key, [item.actorName]);
      output.push({ ...item, collapsedIds: [item.id] });
      return;
    }

    const head = output[existingIndex];
    const actors = actorsByKey.get(key) || [];
    if (item.actorName && !actors.includes(item.actorName)) {
      actors.push(item.actorName);
    }

    output[existingIndex] = {
      ...head,
      // The row is unread while any like inside it is unread, so folding
      // them together can never hide something the user has not seen.
      read: head.read && item.read,
      collapsedIds: [...(head.collapsedIds || [head.id]), item.id],
    };
  });

  // Rewrite the wording only once the whole group is known.
  return output.map((item) => {
    if (!item.collapsedIds || item.collapsedIds.length < 2) return item;

    const actors = actorsByKey.get(
      `like:${item.entityType || "post"}:${item.entityId}`,
    ) || [];
    const others = item.collapsedIds.length - 1;

    return {
      ...item,
      message:
        actors.length === 2 && others === 1
          ? `and ${actors[1]} ${item.message}`
          : `and ${others} ${others === 1 ? "other" : "others"} ${item.message}`,
    };
  });
}

const SECTION_ORDER: TimeSection[] = [
  "Today",
  "Yesterday",
  "This Week",
  "This Month",
  "Older",
];

const FILTER_OPTIONS: FilterOption[] = [
  "All",
  "Today",
  "Yesterday",
  "This Week",
  "This Month",
  "Older",
];

const NotificationsScreen = () => {
  // Rebuilt only when the palette changes, so switching theme restyles the
  // screen without re-creating the stylesheet on every render.
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  // Seeded from auth.currentUser so a warm session skips the round trip, and
  // paired with authResolved because a null user means two different things:
  // "signed out" and "we have not been told yet". Treating the second as the
  // first is what made a reload show "No notifications yet" for a moment,
  // then the skeleton, then the real list.
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [authResolved, setAuthResolved] = useState(() => !!auth.currentUser);
  const [loadError, setLoadError] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    singleAction?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<FilterOption>("All");
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { isOffline } = useNetworkStatus();
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const sectionListRef = useRef<SectionList<NotificationItem>>(null);

  // Tapping the Notifications tab while it's already open scrolls back to
  // the top of the list.
  useEffect(() => {
    const subscription = subscribeTabScrollToTop("NotificationsScreen", () => {
      try {
        sectionListRef.current?.scrollToLocation({
          sectionIndex: 0,
          itemIndex: 0,
          animated: true,
          viewOffset: 0,
        });
      } catch {
        // Nothing to scroll to while the list is empty.
      }
    });
    return () => subscription.remove();
  }, []);

  const router = useRouter();
  const { unavailable } = useLocalSearchParams<{
    unavailable?: string | string[];
  }>();

  useEffect(() => {
    if (!unavailable) return;
    setConfirmDialog({
      title: "Content not available",
      description: "This post, comment, or reply has been deleted or is no longer available.",
      confirmText: "OK",
      singleAction: true,
      onConfirm: () => setConfirmDialog(null),
    });
  }, [unavailable]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthResolved(true);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    // Wait for the answer before declaring the list empty.
    if (!authResolved) return;

    if (!user?.uid) {
      setNotifications([]);
      setLoading(false);
      return;
    }

    let isMounted = true;
    getCachedNotifications<NotificationItem>(user.uid).then((cached) => {
      if (isMounted && cached && cached.length > 0) {
        setNotifications((prev) => (prev.length === 0 ? cached : prev));
        setLoading(false);
      }
    });

    setLoading(true);
    const notificationsQuery = query(
      collection(db, "notifications"),
      where("recipientId", "==", user.uid),
    );

    const unsubscribe = onSnapshot(
      notificationsQuery,
      (snapshot) => {
        const fetchedNotifications = snapshot.docs
          .map((notificationDoc) => ({
            id: notificationDoc.id,
            ...(notificationDoc.data() as Omit<NotificationItem, "id">),
          }))
          .sort((first, second) => {
            const toMillis = (value: any) => {
              if (value?.toMillis) return value.toMillis();
              if (!value) return 0;
              const parsed = new Date(value).getTime();
              return Number.isNaN(parsed) ? 0 : parsed;
            };
            return toMillis(second.createdAt) - toMillis(first.createdAt);
          });

        setNotifications(fetchedNotifications);
        setLoadError(false);
        setLoading(false);
        saveCachedNotifications(user.uid, fetchedNotifications);
      },
      (error) => {
        // Without this the screen falls through to "No notifications yet" and
        // a failure is indistinguishable from genuinely having none.
        console.error("Error loading notifications:", error);
        setLoadError(true);
        setLoading(false);
      },
    );

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [authResolved, user?.uid]);

  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification.read).length,
    [notifications],
  );

  const showFilters = () => {
    setShowFilterModal(true);
    Animated.spring(scaleAnim, {
      toValue: 1,
      tension: 100,
      friction: 7,
      useNativeDriver: true,
    }).start();
  };

  const hideFilters = () => {
    Animated.timing(scaleAnim, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => setShowFilterModal(false));
  };

  const handleFilterSelect = (filter: FilterOption) => {
    setSelectedFilter(filter);
    hideFilters();
  };
  const relativeTimeNow = useRelativeTimeNow();

 const getTimeSection = useCallback(
  (value?: any): TimeSection => {
    const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return "Older";
    }

    const now = new Date(relativeTimeNow);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    const diffDays = Math.floor(
      (today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24)
    );

    // 1. Today & Yesterday
    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";

    // 2. Rolling 7 Days (Covers notifications 2–7 days old smoothly)
    if (diffDays <= 7) return "This Week";

    // 3. Current Calendar Month
    if (
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear()
    ) {
      return "This Month";
    }

    // 4. Everything else
    return "Older";
  },
  [relativeTimeNow]
);

  const getTimeAgo = (value?: any) => {
    const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return "";
    }

    const now = new Date(relativeTimeNow);
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  };
const onRefresh = useCallback(() => {
  setRefreshing(true);
  // Snapshot listener automatically syncs, just toggle spinner briefly
  setTimeout(() => setRefreshing(false), 800);
}, []);
  // The avatar and name on a notification are a copy taken when it was
  // created, so changing your picture left every notification you had ever
  // sent showing the old one. These are resolved from the live profile
  // instead, with the stored copy as the fallback.
  const [actorProfiles, setActorProfiles] = useState<
    Record<string, { name: string; avatar: string | null }>
  >({});

  const actorIds = useMemo(
    () =>
      Array.from(
        new Set(
          notifications
            .map((notification) => notification.actorId)
            .filter((id): id is string => !!id),
        ),
      ),
    [notifications],
  );

  useEffect(() => {
    if (actorIds.length === 0) return;
    let cancelled = false;

    const readAll = () => {
      const next: Record<string, { name: string; avatar: string | null }> = {};
      actorIds.forEach((id) => {
        const profile = peekUserData(id);
        if (!profile) return;
        const name = `${profile.firstname || ""} ${profile.lastname || ""}`.trim();
        next[id] = { name, avatar: resolveAvatarUri(profile) || null };
      });
      if (!cancelled) setActorProfiles(next);
    };

    // Fills the shared cache for anyone not in it yet — one query per thirty
    // people — then reads every actor back out of it.
    ensureUserData(actorIds)
      .then(readAll)
      .catch(() => undefined);

    // And keep up with changes made while this screen is open.
    const unsubscribe = subscribeToUserDataUpdates(() => readAll());

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [actorIds]);

  const groupedNotifications = useMemo(() => {
    const filteredNotifications =
      selectedFilter === "All"
        ? notifications
        : notifications.filter(
            (notification) =>
              getTimeSection(notification.createdAt) === selectedFilter,
          );

    const sectionMap: Record<TimeSection, NotificationItem[]> = {
      Today: [],
      Yesterday: [],
      "This Week": [],
      "This Month": [],
      Older: [],
    };

    filteredNotifications.forEach((notification) => {
      sectionMap[getTimeSection(notification.createdAt)].push(notification);
    });

    return SECTION_ORDER.map((title) => ({
      title,
      // Collapsed per section, so a like from today never folds into one
      // from last week and lands under the wrong heading.
      data: collapseLikeNotifications(sectionMap[title]),
    })).filter((section) => section.data.length > 0);
  }, [getTimeSection, notifications, selectedFilter]);

  const markAsRead = async (notificationId: string, alsoMarkIds?: string[]) => {
    // A collapsed row stands for several documents; opening it has to clear
    // all of them, or the row bounces straight back to unread.
    const ids = Array.from(new Set([notificationId, ...(alsoMarkIds || [])]));
    const unread = ids.filter((id) => {
      const target = notifications.find(
        (notification) => notification.id === id,
      );
      return target && !target.read;
    });

    if (unread.length === 0) return;

    try {
      await Promise.all(
        unread.map((id) =>
          updateDoc(doc(db, "notifications", id), { read: true }),
        ),
      );
    } catch (error) {
      console.error("Error marking notification as read:", error);
    }
  };

 const handleNotificationPress = async (notification: NotificationItem) => {
  // Mark as read in the background; navigation must never wait on this write.
   void markAsRead(notification.id, notification.collapsedIds);
   const directConversationId = getDirectNotificationTarget(notification);
   if (directConversationId) {
     router.push({ pathname: "/(main)/DirectChatScreen", params: { conversationId: directConversationId } });
     return;
   }

  // Priority safety/moderation notifications are queue shortcuts rather than
  // normal content-navigation notifications. Pending content may intentionally
  // be hidden, so take authorized reviewers directly to the dashboard queue.
  if (notification.type === "moderation" && notification.parentId === "moderation-queue") {
    router.push("/(main)/(tabs)/DashboardScreen");
    return;
  }

  if (!notification.entityType || !notification.entityId) {
    return;
  }

  // Opens the ticket itself rather than the support list: the student tapped
  // because they want to read the reply, not browse their requests.
  if (notification.entityType === "support_ticket") {
    router.push({
      pathname: "/SupportTicketScreen",
      params: { ticketId: notification.entityId },
    });
    return;
  }

  if (notification.entityType === "event") {
    router.push({
      pathname: "/EventCalendarScreen",
      params: { eventId: notification.entityId },
    });
    return;
  }

  // A mention inside a community channel opens that channel directly. It must
  // be handled before the post/comment/reply lookups below, which would find
  // nothing for a channel message and report it as deleted.
  if (notification.entityType === "thread_message") {
    const serverId = String(notification.parentId || "");
    const channelId = String(notification.channelId || "");

    if (!serverId || !channelId) {
      setConfirmDialog({
        title: "Channel not available",
        description:
          "This mention was saved before channels were recorded, so it can't be opened. Find it in the server instead.",
        confirmText: "OK",
        singleAction: true,
        onConfirm: () => setConfirmDialog(null),
      });
      return;
    }

    router.push({
      pathname: "/(main)/ServerChannelScreen",
      params: { serverId, channelId },
    });
    return;
  }

  if (
    notification.type === "moderation_approved" &&
    (notification.entityType === "post" || notification.entityType === "poll")
  ) {
    try {
      const targetSnapshot = await getDoc(
        doc(
          db,
          notification.entityType === "post" ? "posts" : "polls",
          notification.entityId,
        ),
      );
      const isApproved =
        targetSnapshot.exists() &&
        String(targetSnapshot.data()?.moderationStatus || "approved").toLowerCase() ===
          "approved";

      if (!isApproved) {
        throw new Error("approved-content-unavailable");
      }

      router.push({
        pathname: "/(main)/(tabs)/HomeScreen",
        params: {
          notificationKey: `${notification.id}:${Date.now()}`,
          ...(notification.entityType === "post"
            ? { notificationPostId: notification.entityId }
            : { notificationPollId: notification.entityId }),
        },
      });
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "approved-content-unavailable"
      ) {
        console.warn("Unable to open approved content:", error);
      }
      setConfirmDialog({
        title: "Content not available",
        description: "This content has been deleted or is no longer available.",
        confirmText: "OK",
        singleAction: true,
        onConfirm: () => setConfirmDialog(null),
      });
      return;
    }
  }

  let targetExists = false;
  try {
    if (notification.entityType === "post") {
      targetExists = (await getDoc(doc(db, "posts", notification.entityId))).exists();
    } else if (notification.entityType === "comment") {
      const commentSnap = await getDoc(doc(db, "comments", notification.entityId));
      if (commentSnap.exists()) {
        const postId = String(commentSnap.data()?.postId || notification.parentId || "");
        targetExists = Boolean(
          postId && (await getDoc(doc(db, "posts", postId))).exists(),
        );
      } else {
        targetExists = (
          await getDoc(doc(db, "communityThreadMessages", notification.entityId))
        ).exists();
      }
    } else if (notification.entityType === "reply") {
      const replySnap = await getDoc(doc(db, "replies", notification.entityId));
      if (replySnap.exists()) {
        const commentId = String(
          replySnap.data()?.commentId || notification.parentId || "",
        );
        const commentSnap = commentId
          ? await getDoc(doc(db, "comments", commentId))
          : null;
        const postId = commentSnap?.exists()
          ? String(commentSnap.data()?.postId || "")
          : "";
        targetExists = Boolean(
          postId && (await getDoc(doc(db, "posts", postId))).exists(),
        );
      }
    }
  } catch (error) {
    console.warn("Unable to validate notification destination:", error);
  }

  if (!targetExists) {
    setConfirmDialog({
      title: "Content not available",
      description: "This post, comment, or reply has been deleted or is no longer available.",
      confirmText: "OK",
      singleAction: true,
      onConfirm: () => setConfirmDialog(null),
    });
    return;
  }

  router.push({
    pathname: "/NotificationTargetScreen",
    params: {
      notificationId: notification.id,
      entityType: notification.entityType,
      entityId: notification.entityId,
      parentId: notification.parentId || "",
    },
  });
};

  const markAllAsRead = async () => {
    if (isOffline) {
      setConfirmDialog({
        title: "No Connection",
        description: "Please check your internet connection to mark notifications as read.",
        confirmText: "OK",
        singleAction: true,
        onConfirm: () => setConfirmDialog(null),
      });
      return;
    }

    const unreadNotifications = notifications.filter(
      (notification) => !notification.read,
    );
    if (unreadNotifications.length === 0) {
      return;
    }

    try {
      const batch = writeBatch(db);
      unreadNotifications.forEach((notification) => {
        batch.update(doc(db, "notifications", notification.id), {
          read: true,
        });
      });
      await batch.commit();
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
    }
  };

  const getIconName = (type: NotificationType) => {
    switch (type) {
      case "like":
        return "heart";
      case "comment":
        return "chatbubble";
      case "reply":
        return "return-up-back";
      case "mention":
        return "at";
      case "event":
        return "calendar";
      case "emergency":
        return "warning";
      case "moderation":
        return "shield-outline";
      case "support":
        return "help-buoy";
      case "moderation_approved":
        return "checkmark-circle";
      default:
        return "notifications";
    }
  };

  const getNotificationColors = (type: NotificationType) => {
    switch (type) {
      case "like":
        return { icon: "#ff3b7f", bg: "#ff3b7f20" };
      case "comment":
        return { icon: "#4a9eff", bg: "#4a9eff20" };
      case "reply":
        return { icon: "#f5a524", bg: "#f5a52420" };
      case "mention":
        return { icon: "#00d470", bg: "#00d47020" };
      case "event":
        return { icon: theme.accent, bg: "#e0a53d20" };
      case "emergency":
        return { icon: "#ff2d2d", bg: "#ff2d2d22" };
      case "moderation":
        return { icon: theme.accent, bg: "#e0913d22" };
      case "moderation_approved":
        return { icon: "#2f855a", bg: "#2f855a20" };
      default:
        return { icon: theme.textMuted, bg: "#b88f8720" };
    }
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Ionicons name="notifications-off-outline" size={64} color={theme.textMuted} />
      <Text style={styles.emptyText}>No notifications yet</Text>
      <Text style={styles.emptySubtext}>
        You&apos;ll see likes, comments, replies, mentions, and event alerts here
      </Text>
    </View>
  );

  // "We could not load them" and "you are offline" used to render as "you have
  // none", which is the one thing they do not mean.
  const renderLoadError = () => (
    <View style={styles.emptyContainer}>
      <Ionicons name="cloud-offline-outline" size={64} color={theme.textMuted} />
      <Text style={styles.emptyText}>Couldn&apos;t load notifications</Text>
      <Text style={styles.emptySubtext}>
        Something went wrong on our side. Pull down to try again.
      </Text>
    </View>
  );

  const renderOfflineState = () => (
    <View style={styles.emptyContainer}>
      <Ionicons name="wifi-outline" size={64} color={theme.textMuted} />
      <Text style={styles.emptyText}>You&apos;re offline</Text>
      <Text style={styles.emptySubtext}>
        Reconnect to see your latest notifications.
      </Text>
    </View>
  );

  const renderNotificationItem = ({ item }: { item: NotificationItem }) => {
  const liveProfile = item.actorId ? actorProfiles[item.actorId] : undefined;
  // Anonymous notifications must keep their stored name — the live profile
  // would undo the anonymity.
  const liveAvatar = item.actorIsAnonymous ? null : liveProfile?.avatar || null;
  const liveName =
    item.actorIsAnonymous || !liveProfile?.name ? item.actorName : liveProfile.name;
  const colors = getNotificationColors(item.type);

  return (
    <TouchableOpacity
      style={[
        styles.notificationItem,
        item.type === "emergency" && styles.emergencyItem,
        !item.read && styles.unreadItem,
        item.type === "emergency" && !item.read && styles.emergencyUnreadItem,
      ]}
      onPress={() => handleNotificationPress(item)}
      activeOpacity={0.7}
    >
      {/* Avatar Container with Badge Overlay */}
      <View style={styles.avatarContainer}>
        {liveAvatar || item.actorProfileImage ? (
          <Image
            source={{ uri: liveAvatar || item.actorProfileImage! }}
            style={styles.avatarImage}
          />
        ) : (
          <View style={[styles.avatarPlaceholder, { backgroundColor: colors.bg }]}>
            <Text style={[styles.avatarInitial, { color: colors.icon }]}>
              {item.actorName?.charAt(0).toUpperCase() || "?"}
            </Text>
          </View>
        )}
        
        {/* Type Icon Badge Overlay */}
        <View style={[styles.badgeOverlay, { backgroundColor: colors.icon }]}>
          <Ionicons name={getIconName(item.type)} size={10} color={theme.onPrimary} />
        </View>
      </View>

      {/* Main Content Area */}
      <View style={styles.notificationContent}>
        <Text style={styles.notificationText}>
          <Text style={styles.username}>{liveName}</Text>
          <Text style={styles.contentText}> {item.message}</Text>
        </Text>

        {!!item.preview && (
          <View style={styles.previewBox}>
            <Text style={styles.previewText} numberOfLines={2}>
              {`“${item.preview}”`}
            </Text>
          </View>
        )}

        <Text style={styles.timestamp}>{getTimeAgo(item.createdAt)}</Text>
      </View>

      {/* Unread Status Dot */}
      {!item.read && (
        <View
          style={[
            styles.unreadDot,
            item.type === "emergency" && styles.emergencyUnreadDot,
          ]}
        />
      )}
    </TouchableOpacity>
  );
};

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.headerTitle}>Notifications</Text>
            {unreadCount > 0 && (
              <Text style={styles.headerSubtitle}>
                {unreadCount} unread {unreadCount === 1 ? "update" : "updates"}
              </Text>
            )}
          </View>

          <View style={styles.headerActions}>
            <TouchableOpacity onPress={showFilters} style={styles.filterButton}>
              <Ionicons name="funnel-outline" size={22} color={theme.accent} />
              {selectedFilter !== "All" && <View style={styles.filterBadge} />}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.markReadButton}
              onPress={markAllAsRead}
              disabled={unreadCount === 0}
            >
              <Ionicons
                name="checkmark-done"
                size={22}
                color={unreadCount > 0 ? theme.accent : theme.textMuted}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* Order matters: auth first, because until it answers we genuinely do
            not know whether there is anything to show. */}
        {!authResolved || (loading && !isOffline) ? (
          <ListSkeleton
            count={6}
            contentStyle={styles.skeletonContent}
            rowStyle={styles.skeletonRow}
          />
        ) : loadError && notifications.length === 0 ? (
          renderLoadError()
        ) : isOffline && notifications.length === 0 ? (
          renderOfflineState()
        ) : groupedNotifications.length === 0 ? (
          renderEmptyState()
        ) : (
          <View style={{ flex: 1 }}>
            {isOffline && notifications.length > 0 && (
              <View style={styles.offlineStatusBar}>
                <Ionicons name="cloud-offline-outline" size={14} color="#9a3412" />
                <Text style={styles.offlineStatusText}>
                  Offline mode
                </Text>
              </View>
            )}
            <SectionList
  ref={sectionListRef}
  sections={groupedNotifications}
  keyExtractor={(item) => item.id}
  renderItem={renderNotificationItem}
  // Virtualization tuning (previously using RN's defaults): notification
  // rows include an avatar image each, so a smaller render window keeps
  // scrolling smooth on long notification histories.
  initialNumToRender={10}
  maxToRenderPerBatch={10}
  windowSize={8}
  removeClippedSubviews={Platform.OS === "android"}
  stickySectionHeadersEnabled={true} // 👈 Keeps section header visible on scroll
  renderSectionHeader={({ section: { title } }) => (
    <View style={styles.timePillContainer}>
      <View style={styles.goldEdgeTimePill}>
        <Text style={styles.timePillText}>{title.toUpperCase()}</Text>
      </View>
    </View>
  )}
  contentContainerStyle={styles.listContent}
  showsVerticalScrollIndicator={false}

  refreshControl={
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={theme.accent}
      colors={[theme.accent]}
    />
  }
/>
          </View>
        )}
      </View>

      <Modal
        visible={showFilterModal}
        transparent
        animationType="none"
        onRequestClose={hideFilters}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={hideFilters}
        >
          <Animated.View
            style={[styles.filterModal, { transform: [{ scale: scaleAnim }] }]}
          >
            <View style={styles.filterHeader}>
              <Text style={styles.filterTitle}>Filter Notifications</Text>
              <TouchableOpacity onPress={hideFilters}>
                <Ionicons name="close" size={24} color={theme.accent} />
              </TouchableOpacity>
            </View>

            {FILTER_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option}
                style={[
                  styles.filterOption,
                  selectedFilter === option && styles.filterOptionActive,
                ]}
                onPress={() => handleFilterSelect(option)}
              >
                <Ionicons
                  name={
                    option === "All"
                      ? "apps-outline"
                      : option === "Today"
                        ? "today-outline"
                        : option === "Yesterday"
                          ? "calendar-outline"
                          : option === "This Week"
                            ? "calendar-outline"
                            : option === "This Month"
                              ? "calendar-outline"
                              : "archive-outline"
                  }
                  size={22}
                  color={selectedFilter === option ? theme.accent : theme.textMuted}
                />
                <Text
                  style={[
                    styles.filterOptionText,
                    selectedFilter === option && styles.filterOptionTextActive,
                  ]}
                >
                  {option}
                </Text>
                {selectedFilter === option && (
                  <Ionicons name="checkmark" size={24} color={theme.accent} />
                )}
              </TouchableOpacity>
            ))}
          </Animated.View>
        </TouchableOpacity>
      </Modal>
      <ConfirmDialog
        visible={!!confirmDialog}
        title={confirmDialog?.title ?? ""}
        description={confirmDialog?.description}
        confirmText={confirmDialog?.confirmText}
        cancelText={confirmDialog?.cancelText}
        destructive={confirmDialog?.destructive ?? false}
        singleAction={confirmDialog?.singleAction ?? false}
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </SafeAreaView>
  );
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  // Add background match in style so list items don't bleed through sticky header
timePillContainer: {
  paddingHorizontal: 16,
  paddingTop: 12,
  paddingBottom: 6,
  alignItems: "flex-start",
  backgroundColor: c.surfaceSunken, // 👈 Matches content shell background
},
goldEdgeTimePill: {
  backgroundColor: c.border, // Light cream fill matching your theme
  paddingHorizontal: 18,
  paddingVertical: 6,
  borderRadius: 999, // Oval / pill shape
  
  // Gold Edge Border
  borderWidth: 1.5,
  borderColor: c.accent,

  shadowColor: "#000",
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.05,
  shadowRadius: 2,
  elevation: 1,
},
timePillText: {
  color: c.primary, // CSAP Dark Maroon text
  fontSize: 12,
  fontWeight: "800",
  letterSpacing: 0.8,
},
  container: {
    flex: 1,
    backgroundColor: c.chrome,
  },
  contentShell: {
    flex: 1,
    backgroundColor: c.surfaceSunken,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 18,
    backgroundColor: c.chrome,
    borderBottomWidth: 1,
    borderBottomColor: c.textSecondary,
  },
  headerCopy: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: c.onChrome,
  },
  headerSubtitle: {
    color: c.borderStrong,
    fontSize: 12,
    marginTop: 3,
  },
  headerActions: {
    flexDirection: "row",
    gap: 12,
    marginLeft: 12,
  },
  filterButton: {
    position: "relative",
    padding: 9,
    borderRadius: 999,
    backgroundColor: "rgba(255,250,247,0.12)",
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.4)",
  },
  filterBadge: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: c.accent,
  },
  markReadButton: {
    padding: 9,
    borderRadius: 999,
    backgroundColor: "rgba(255,250,247,0.12)",
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.4)",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  loadingText: {
    color: c.textMuted,
    fontSize: 14,
    marginTop: 14,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  emptyText: {
    color: "#999",
    fontSize: 18,
    marginTop: 16,
    fontWeight: "600",
  },
  emptySubtext: {
    color: "#666",
    fontSize: 14,
    marginTop: 8,
    textAlign: "center",
  },
  listContent: {
    paddingBottom: 80,
  },
  sectionHeader: {
    backgroundColor: c.surfaceSunken,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sectionTitle: {
    color: c.primary,
    fontSize: 14,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    backgroundColor: c.border,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
 skeletonContent: {
  paddingTop: 6,
 },
 skeletonRow: {
  backgroundColor: c.surface,
  marginHorizontal: 16,
  marginBottom: 10,
  borderRadius: 14,
  borderWidth: 1,
  borderColor: c.borderStrong,
  borderLeftWidth: 4,
  borderLeftColor: c.accent,
  paddingHorizontal: 16,
  paddingVertical: 14,
 },
 notificationItem: {
  flexDirection: "row",
  alignItems: "flex-start",
  paddingHorizontal: 16,
  paddingVertical: 14,
  backgroundColor: c.surface,
  marginHorizontal: 16,
  marginBottom: 10,
  borderRadius: 14,
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
 unreadItem: {
  backgroundColor: c.surfaceRaised, // Light tint contrast for unread items
  borderLeftWidth: 4,
  borderLeftColor: c.accent,
  borderColor: "rgba(224,165,61,0.34)",
},
/* Avatar & Badge Overlay Styling */
avatarContainer: {
  position: "relative",
  width: 44,
  height: 44,
  marginRight: 12,
},
avatarImage: {
  width: 44,
  height: 44,
  borderRadius: 22,
  backgroundColor: c.border,
  borderWidth: 1,
  borderColor: "rgba(95,9,9,0.08)",
},
avatarPlaceholder: {
  width: 44,
  height: 44,
  borderRadius: 22,
  justifyContent: "center",
  alignItems: "center",
},
avatarInitial: {
  fontSize: 16,
  fontWeight: "bold",
},
badgeOverlay: {
  position: "absolute",
  bottom: -2,
  right: -2,
  width: 18,
  height: 18,
  borderRadius: 9,
  justifyContent: "center",
  alignItems: "center",
  borderWidth: 2,
  borderColor: c.surface,
},
  emergencyItem: {
    backgroundColor: "#fff1f1",
    borderColor: "rgba(255,45,45,0.36)",
  },
  emergencyUnreadItem: {
    borderLeftWidth: 4,
    borderLeftColor: "#ff2d2d",
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
 notificationContent: {
  flex: 1,
},
  notificationText: {
  color: c.textPrimary,
  fontSize: 14,
  lineHeight: 20,
},
 username: {
  fontWeight: "700",
  color: c.primary,
},
 contentText: {
  color: c.textSecondary,
},
previewBox: {
  marginTop: 6,
  paddingHorizontal: 10,
  paddingVertical: 6,
  backgroundColor: "rgba(0,0,0,0.03)",
  borderRadius: 8,
  borderLeftWidth: 2,
  borderLeftColor: c.borderStrong,
},
  previewText: {
  color: c.textMuted,
  fontSize: 13,
  lineHeight: 18,
  fontStyle: "italic",
},
 timestamp: {
  color: c.textMuted,
  fontSize: 12,
  marginTop: 6,
},
  unreadDot: {
  width: 8,
  height: 8,
  borderRadius: 4,
  backgroundColor: c.accent,
  marginLeft: 8,
  marginTop: 6,
},
  emergencyUnreadDot: {
    backgroundColor: "#ff2d2d",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
  },
  filterModal: {
    backgroundColor: c.surface,
    borderRadius: 16,
    width: "85%",
    maxWidth: 400,
    borderWidth: 1,
    borderColor: c.textSecondary,
  },
  filterHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: c.textSecondary,
    backgroundColor: c.chrome,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  filterTitle: {
    color: c.onChrome,
    fontSize: 18,
    fontWeight: "bold",
  },
  filterOption: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.borderStrong,
  },
  filterOptionActive: {
    backgroundColor: "rgba(95, 9, 9, 0.08)",
  },
  filterOptionText: {
    flex: 1,
    color: c.textMuted,
    fontSize: 16,
    fontWeight: "500",
  },
  filterOptionTextActive: {
    color: c.primary,
    fontWeight: "600",
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

export default NotificationsScreen;

import { useRelativeTimeNow } from "@/utils/relativeTime";
import { Ionicons } from "@expo/vector-icons";
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, RefreshControl } from "react-native";
import ConfirmDialog from "../components/ConfirmDialog";
import {
  ActivityIndicator,
  Animated,
  Modal,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";

type NotificationType =
  | "like"
  | "comment"
  | "reply"
  | "mention"
  | "activity"
  | "event"
  | "emergency"
  | "moderation";
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
  entityType?: "post" | "comment" | "reply" | "event" | "emergency";
  entityId?: string;
  parentId?: string | null;
  actorName: string;
  actorAvatar?: string; // Add avatar URL support
  message: string;
  preview?: string | null;
  createdAt?: any;
  read: boolean;
};

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
  const [user, setUser] = useState<User | null>(null);
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
  const scaleAnim = useRef(new Animated.Value(0)).current;
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
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setNotifications([]);
      setLoading(false);
      return;
    }

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
            const firstTime = first.createdAt?.toMillis?.() || 0;
            const secondTime = second.createdAt?.toMillis?.() || 0;
            return secondTime - firstTime;
          });

        setNotifications(fetchedNotifications);
        setLoading(false);
      },
      (error) => {
        console.error("Error loading notifications:", error);
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [user?.uid]);

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
      data: sectionMap[title],
    })).filter((section) => section.data.length > 0);
  }, [getTimeSection, notifications, selectedFilter]);

  const markAsRead = async (notificationId: string) => {
    const target = notifications.find(
      (notification) => notification.id === notificationId,
    );
    if (!target || target.read) {
      return;
    }

    try {
      await updateDoc(doc(db, "notifications", notificationId), {
        read: true,
      });
    } catch (error) {
      console.error("Error marking notification as read:", error);
    }
  };

 const handleNotificationPress = async (notification: NotificationItem) => {
  // Mark as read in the background; navigation must never wait on this write.
  void markAsRead(notification.id);

  if (!notification.entityType || !notification.entityId) {
    return;
  }

  if (notification.entityType === "event") {
    router.push({
      pathname: "/EventCalendarScreen",
      params: { eventId: notification.entityId },
    });
    return;
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
        return { icon: "#e0a53d", bg: "#e0a53d20" };
      case "emergency":
        return { icon: "#ff2d2d", bg: "#ff2d2d22" };
      case "moderation":
        return { icon: "#e0913d", bg: "#e0913d22" };
      default:
        return { icon: "#b88f87", bg: "#b88f8720" };
    }
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Ionicons name="notifications-off-outline" size={64} color="#666" />
      <Text style={styles.emptyText}>No notifications yet</Text>
      <Text style={styles.emptySubtext}>
        You&apos;ll see likes, comments, replies, mentions, and event alerts here
      </Text>
    </View>
  );

  const renderNotificationItem = ({ item }: { item: NotificationItem }) => {
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
        {item.actorAvatar ? (
          <Image source={{ uri: item.actorAvatar }} style={styles.avatarImage} />
        ) : (
          <View style={[styles.avatarPlaceholder, { backgroundColor: colors.bg }]}>
            <Text style={[styles.avatarInitial, { color: colors.icon }]}>
              {item.actorName?.charAt(0).toUpperCase() || "?"}
            </Text>
          </View>
        )}
        
        {/* Type Icon Badge Overlay */}
        <View style={[styles.badgeOverlay, { backgroundColor: colors.icon }]}>
          <Ionicons name={getIconName(item.type)} size={10} color="#ffffff" />
        </View>
      </View>

      {/* Main Content Area */}
      <View style={styles.notificationContent}>
        <Text style={styles.notificationText}>
          <Text style={styles.username}>{item.actorName}</Text>
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
              <Ionicons name="funnel-outline" size={22} color="#e0a53d" />
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
                color={unreadCount > 0 ? "#e0a53d" : "#b88f87"}
              />
            </TouchableOpacity>
          </View>
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#e0a53d" />
            <Text style={styles.loadingText}>Loading notifications...</Text>
          </View>
        ) : groupedNotifications.length === 0 ? (
          renderEmptyState()
        ) : (
          <SectionList
  sections={groupedNotifications}
  keyExtractor={(item) => item.id}
  renderItem={renderNotificationItem}
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
      tintColor="#e0a53d"
      colors={["#e0a53d"]}
    />
  }
/>
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
                <Ionicons name="close" size={24} color="#e0a53d" />
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
                  color={selectedFilter === option ? "#e0a53d" : "#9b766c"}
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
                  <Ionicons name="checkmark" size={24} color="#e0a53d" />
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

const styles = StyleSheet.create({
  // Add background match in style so list items don't bleed through sticky header
timePillContainer: {
  paddingHorizontal: 16,
  paddingTop: 12,
  paddingBottom: 6,
  alignItems: "flex-start",
  backgroundColor: "#f6f1ed", // 👈 Matches content shell background
},
goldEdgeTimePill: {
  backgroundColor: "#f0e7e2", // Light cream fill matching your theme
  paddingHorizontal: 18,
  paddingVertical: 6,
  borderRadius: 999, // Oval / pill shape
  
  // Gold Edge Border
  borderWidth: 1.5,
  borderColor: "#e0a53d",

  shadowColor: "#000",
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.05,
  shadowRadius: 2,
  elevation: 1,
},
timePillText: {
  color: "#5f0909", // CSAP Dark Maroon text
  fontSize: 12,
  fontWeight: "800",
  letterSpacing: 0.8,
},
  container: {
    flex: 1,
    backgroundColor: "#5f0909",
  },
  contentShell: {
    flex: 1,
    backgroundColor: "#f6f1ed",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 18,
    backgroundColor: "#5f0909",
    borderBottomWidth: 1,
    borderBottomColor: "#8f3a2b",
  },
  headerCopy: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#fffaf7",
  },
  headerSubtitle: {
    color: "#f0d2c2",
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
    backgroundColor: "#e0a53d",
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
    color: "#9b766c",
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
    backgroundColor: "#f6f1ed",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sectionTitle: {
    color: "#5f0909",
    fontSize: 14,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    backgroundColor: "#f0e7e2",
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#dfc9c1",
  },
 notificationItem: {
  flexDirection: "row",
  alignItems: "flex-start",
  paddingHorizontal: 16,
  paddingVertical: 14,
  backgroundColor: "#fffaf7",
  marginHorizontal: 16,
  marginBottom: 10,
  borderRadius: 14,
  borderWidth: 1,
  borderColor: "#e8d3b2",
  borderLeftWidth: 4,
  borderLeftColor: "#e0a53d",
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.04,
  shadowRadius: 4,
  elevation: 2,
},
 unreadItem: {
  backgroundColor: "#fff8f5", // Light tint contrast for unread items
  borderLeftWidth: 4,
  borderLeftColor: "#e0a53d",
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
  backgroundColor: "#e0e0e0",
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
  borderColor: "#fffaf7",
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
  color: "#333333",
  fontSize: 14,
  lineHeight: 20,
},
 username: {
  fontWeight: "700",
  color: "#5f0909",
},
 contentText: {
  color: "#4a4a4a",
},
previewBox: {
  marginTop: 6,
  paddingHorizontal: 10,
  paddingVertical: 6,
  backgroundColor: "rgba(0,0,0,0.03)",
  borderRadius: 8,
  borderLeftWidth: 2,
  borderLeftColor: "#dfc9c1",
},
  previewText: {
  color: "#666666",
  fontSize: 13,
  lineHeight: 18,
  fontStyle: "italic",
},
 timestamp: {
  color: "#999999",
  fontSize: 12,
  marginTop: 6,
},
  unreadDot: {
  width: 8,
  height: 8,
  borderRadius: 4,
  backgroundColor: "#e0a53d",
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
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    width: "85%",
    maxWidth: 400,
    borderWidth: 1,
    borderColor: "#8f3a2b",
  },
  filterHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#8f3a2b",
    backgroundColor: "#5f0909",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  filterTitle: {
    color: "#fffaf7",
    fontSize: 18,
    fontWeight: "bold",
  },
  filterOption: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#dfc9c1",
  },
  filterOptionActive: {
    backgroundColor: "rgba(95, 9, 9, 0.08)",
  },
  filterOptionText: {
    flex: 1,
    color: "#9b766c",
    fontSize: 16,
    fontWeight: "500",
  },
  filterOptionTextActive: {
    color: "#5f0909",
    fontWeight: "600",
  },
});

export default NotificationsScreen;

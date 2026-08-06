import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  query,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useRelativeTimeNow } from "@/utils/relativeTime";

type NotificationType =
  | "like"
  | "comment"
  | "reply"
  | "mention"
  | "activity"
  | "event"
  | "emergency";
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
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<FilterOption>("All");
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const router = useRouter();

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

  const getTimeSection = useCallback((value?: any): TimeSection => {
    const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return "Older";
    }

    const now = new Date(relativeTimeNow);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    );
    const diffDays = Math.floor(
      (today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays <= 7) return "This Week";
    if (diffDays <= 30) return "This Month";
    return "Older";
  }, [relativeTimeNow]);

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
    await markAsRead(notification.id);

    if (!notification.entityType || !notification.entityId) {
      return;
    }

    if (notification.entityType === "event") {
      router.push({
        pathname: "/EventCalendarScreen",
        params: {
          eventId: notification.entityId,
        },
      });
      return;
    }

    const targetPostId =
      notification.entityType === "post"
        ? notification.entityId
        : notification.entityType === "comment"
          ? notification.parentId || undefined
          : undefined;
    const targetCommentId =
      notification.entityType === "comment"
        ? notification.entityId
        : notification.entityType === "reply"
          ? notification.parentId || undefined
          : undefined;
    const targetReplyId =
      notification.entityType === "reply" ? notification.entityId : undefined;

    router.push({
      pathname: "/(main)/(tabs)/HomeScreen",
      params: {
        notificationKey: `${notification.id}-${Date.now()}`,
        notificationPostId: targetPostId,
        notificationCommentId: targetCommentId,
        notificationReplyId: targetReplyId,
        notificationOpenReply:
          notification.entityType === "reply" ? "1" : "0",
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
        activeOpacity={0.85}
      >
        <View style={[styles.iconContainer, { backgroundColor: colors.bg }]}>
          <Ionicons
            name={getIconName(item.type)}
            size={20}
            color={colors.icon}
          />
        </View>

        <View style={styles.notificationContent}>
          <Text style={styles.notificationText}>
            <Text style={styles.username}>{item.actorName}</Text>
            <Text style={styles.contentText}> {item.message}</Text>
          </Text>

          {!!item.preview && (
            <Text style={styles.previewText} numberOfLines={2}>
              {item.preview}
            </Text>
          )}

          <Text style={styles.timestamp}>{getTimeAgo(item.createdAt)}</Text>
        </View>

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
            renderSectionHeader={({ section: { title } }) => (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{title}</Text>
              </View>
            )}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
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
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
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
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#f0e7e2",
    shadowColor: "#5f0909",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 1,
  },
  unreadItem: {
    backgroundColor: "#fff4ee",
    borderLeftWidth: 3,
    borderLeftColor: "#e0a53d",
    borderColor: "rgba(224,165,61,0.34)",
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
    color: "#4d1b17",
    fontSize: 14,
    lineHeight: 20,
  },
  username: {
    fontWeight: "700",
    color: "#5f0909",
  },
  contentText: {
    color: "#7a3b2e",
  },
  previewText: {
    color: "#9b766c",
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  timestamp: {
    color: "#9b766c",
    fontSize: 12,
    marginTop: 6,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#e0a53d",
    marginLeft: 8,
    marginTop: 8,
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

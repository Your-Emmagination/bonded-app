import { Text, View, StyleSheet, SectionList, TouchableOpacity, Modal, Animated } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useState, useRef } from "react";

type Notification = {
  id: string;
  type: 'like' | 'comment' | 'mention';
  user: string;
  content: string;
  timestamp: Date;
  read: boolean;
};

type FilterOption = 'All' | 'Today' | 'Yesterday' | 'This Week' | 'This Month';

const NotificationsScreen = () => {
  const [notifications] = useState<Notification[]>([
    {
      id: '1',
      type: 'like',
      user: 'Harvey Intan',
      content: 'liked your post "Introduction to React Native"',
      timestamp: new Date(Date.now() - 1000 * 60 * 30),
      read: false,
    },
    {
      id: '2',
      type: 'comment',
      user: 'Jett Kupal',
      content: 'commented on your post',
      timestamp: new Date(Date.now() - 1000 * 60 * 120),
      read: false,
    },
    {
      id: '3',
      type: 'mention',
      user: 'Wilbur Palautog',
      content: 'mentioned you in a discussion',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 5),
      read: true,
    },
    {
      id: '4',
      type: 'like',
      user: 'Emman Gwapo Johnson',
      content: 'liked your comment',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24),
      read: true,
    },
    {
      id: '5',
      type: 'comment',
      user: 'Wilbur Palautog',
      content: 'replied to your comment',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2),
      read: true,
    },
    {
      id: '6',
      type: 'mention',
      user: 'Harvey Papart',
      content: 'mentioned you in a study group',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 8),
      read: true,
    },
    {
      id: '7',
      type: 'like',
      user: 'Emman Gwapo',
      content: 'liked your post about "Database Design"',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 15),
      read: true,
    },
    {
      id: '8',
      type: 'comment',
      user: 'Jett Butakal',
      content: 'commented on your question',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 25),
      read: true,
    },
  ]);

  const [selectedFilter, setSelectedFilter] = useState<FilterOption>('All');
  const [showFilterModal, setShowFilterModal] = useState(false);
  const scaleAnim = useRef(new Animated.Value(0)).current;

  const filterOptions: FilterOption[] = ['All', 'Today', 'Yesterday', 'This Week', 'This Month'];

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

  const getTimeCategory = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays <= 7) return 'This Week';
    if (diffDays <= 30) return 'This Month';
    return 'This Month'; 
  };

  const getTimeAgo = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const groupNotifications = () => {
    const groups: { [key: string]: Notification[] } = {
      'Today': [],
      'Yesterday': [],
      'This Week': [],
      'This Month': [],
    };

    let filteredNotifications = notifications;
    if (selectedFilter !== 'All') {
      filteredNotifications = notifications.filter(notif => 
        getTimeCategory(notif.timestamp) === selectedFilter
      );
    }

    filteredNotifications.forEach(notif => {
      const category = getTimeCategory(notif.timestamp);
      groups[category].push(notif);
    });

    return Object.entries(groups)
      .filter(([_, items]) => items.length > 0)
      .map(([title, data]) => ({ title, data }));
  };

  const getIconName = (type: string) => {
    switch (type) {
      case 'like': return 'heart';
      case 'comment': return 'chatbubble';
      case 'mention': return 'at';
      default: return 'notifications';
    }
  };

  const sections = groupNotifications();

  if (sections.length === 0 || sections.every(s => s.data.length === 0)) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Notifications</Text>
        </View>
        <View style={styles.emptyContainer}>
          <Ionicons name="notifications-off-outline" size={64} color="#666" />
          <Text style={styles.emptyText}>No notifications yet</Text>
          <Text style={styles.emptySubtext}>
            You&apos;ll see updates about your posts here
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const renderNotificationItem = ({ item }: { item: Notification }) => (
    <TouchableOpacity style={[styles.notificationItem, !item.read && styles.unreadItem]}>
      <View style={[styles.iconContainer, { backgroundColor: item.type === 'like' ? '#ff3b7f20' : item.type === 'comment' ? '#4a9eff20' : '#00d47020' }]}>
        <Ionicons
          name={getIconName(item.type) as any}
          size={20}
          color={item.type === 'like' ? '#ff3b7f' : item.type === 'comment' ? '#4a9eff' : '#00d470'}
        />
      </View>
      <View style={styles.notificationContent}>
        <Text style={styles.notificationText}>
          <Text style={styles.username}>{item.user}</Text>
          <Text style={styles.contentText}> {item.content}</Text>
        </Text>
        <Text style={styles.timestamp}>{getTimeAgo(item.timestamp)}</Text>
      </View>
      {!item.read && <View style={styles.unreadDot} />}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={showFilters} style={styles.filterButton}>
            <Ionicons name="funnel-outline" size={22} color="#ff3b7f" />
            {selectedFilter !== 'All' && <View style={styles.filterBadge} />}
          </TouchableOpacity>
          <TouchableOpacity style={styles.markReadButton}>
            <Ionicons name="checkmark-done" size={22} color="#ff3b7f" />
          </TouchableOpacity>
        </View>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={renderNotificationItem}
        renderSectionHeader={({ section: { title } }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{title}</Text>
          </View>
        )}
        contentContainerStyle={styles.listContent}
        scrollEnabled={true}
      />

      {/* Filter Modal */}
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
            style={[
              styles.filterModal,
              { transform: [{ scale: scaleAnim }] },
            ]}
          >
            <View style={styles.filterHeader}>
              <Text style={styles.filterTitle}>Filter Notifications</Text>
              <TouchableOpacity onPress={hideFilters}>
                <Ionicons name="close" size={24} color="#999" />
              </TouchableOpacity>
            </View>

            {filterOptions.map((option) => (
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
                    option === 'All' ? 'apps-outline' :
                    option === 'Today' ? 'today-outline' :
                    option === 'Yesterday' ? 'calendar-outline' :
                    option === 'This Week' ? 'calendar-outline' :
                    'calendar-outline'
                  }
                  size={22}
                  color={selectedFilter === option ? '#ff3b7f' : '#999'}
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
                  <Ionicons name="checkmark" size={24} color="#ff3b7f" />
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
    backgroundColor: "#0f1624",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#ff3b7f",
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#ff3b7f",
  },
  headerActions: {
    flexDirection: "row",
    gap: 12,
  },
  filterButton: {
    position: "relative",
    padding: 4,
  },
  filterBadge: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ff3b7f",
  },
  markReadButton: {
    padding: 4,
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
    backgroundColor: "#0f1624",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sectionTitle: {
    color: "#ff3b7f",
    fontSize: 14,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  notificationItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "#1c2535",
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 12,
  },
  unreadItem: {
    backgroundColor: "#1c253590",
    borderLeftWidth: 3,
    borderLeftColor: "#ff3b7f",
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
    color: "#fff",
    fontSize: 14,
    lineHeight: 20,
  },
  username: {
    fontWeight: "700",
    color: "#fff",
  },
  contentText: {
    color: "#ccc",
  },
  timestamp: {
    color: "#999",
    fontSize: 12,
    marginTop: 4,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ff3b7f",
    marginLeft: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
  },
  filterModal: {
    backgroundColor: "#1c2535",
    borderRadius: 16,
    width: "85%",
    maxWidth: 400,
    borderWidth: 1,
    borderColor: "#ff3b7f",
  },
  filterHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#2a3548",
  },
  filterTitle: {
    color: "#ff3b7f",
    fontSize: 18,
    fontWeight: "bold",
  },
  filterOption: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#2a3548",
  },
  filterOptionActive: {
    backgroundColor: "#ff3b7f15",
  },
  filterOptionText: {
    flex: 1,
    color: "#999",
    fontSize: 16,
    fontWeight: "500",
  },
  filterOptionTextActive: {
    color: "#fff",
    fontWeight: "600",
  },
});

export default NotificationsScreen
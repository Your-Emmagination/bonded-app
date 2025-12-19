// EventCalendarScreen.tsx - FIXED: Only "VIEW MORE" opens modal
import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Modal,
  ScrollView,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  deleteDoc,
  doc,
} from "firebase/firestore";
import { db, auth } from "../../Firebase_configure";
import { getUserData, UserRole } from "@/utils/rbac";

type CalendarEvent = {
  id: string;
  title: string;
  description?: string;
  date: string; // Format: "YYYY-MM-DD"
  startTime?: string; // Format: "HH:mm"
  endTime?: string;
  category: "morning" | "afternoon" | "evening" | "all-day";
  createdBy: string;
  createdByName: string;
  createdAt: any;
  notifyUsers?: boolean;
};

type GroupedEvents = {
  [month: string]: {
    [date: string]: CalendarEvent[];
  };
};

const EventCalendarScreen = () => {
  const router = useRouter();
  const [, setEvents] = useState<CalendarEvent[]>([]);
  const [groupedEvents, setGroupedEvents] = useState<GroupedEvents>({});
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<CalendarEvent[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [currentUserRole, setCurrentUserRole] = useState<UserRole | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUserRole = async () => {
      if (auth.currentUser) {
        const userData = await getUserData(auth.currentUser.uid);
        setCurrentUserRole(userData?.role);
      }
    };
    fetchUserRole();
  }, []);

  useEffect(() => {
    const q = query(collection(db, "events"), orderBy("date", "asc"));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const fetchedEvents: CalendarEvent[] = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as CalendarEvent[];

        setEvents(fetchedEvents);
        groupEventsByMonth(fetchedEvents);
        setLoading(false);
      },
      (error) => {
        console.error("Error fetching events:", error);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  const groupEventsByMonth = (eventList: CalendarEvent[]) => {
    const grouped: GroupedEvents = {};

    eventList.forEach((event) => {
      const date = new Date(event.date);
      const monthYear = date.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      });

      if (!grouped[monthYear]) {
        grouped[monthYear] = {};
      }

      if (!grouped[monthYear][event.date]) {
        grouped[monthYear][event.date] = [];
      }

      grouped[monthYear][event.date].push(event);
    });

    setGroupedEvents(grouped);
  };

  // ✅ FIXED: Separate handler for "VIEW MORE" button
  const handleViewMorePress = (date: string, eventsForDate: CalendarEvent[]) => {
    setSelectedDate(date);
    setSelectedEvents(eventsForDate);
    setModalVisible(true);
  };

  const handleDeleteEvent = async (eventId: string) => {
    Alert.alert(
      "Delete Event",
      "Are you sure you want to delete this event?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteDoc(doc(db, "events", eventId));
              Alert.alert("Success", "Event deleted successfully");
            } catch (error) {
              console.error("Error deleting event:", error);
              Alert.alert("Error", "Failed to delete event");
            }
          },
        },
      ]
    );
  };

  const canManageEvents = () => {
    return ["moderator", "teacher", "admin"].includes(currentUserRole || "");
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  const getCategoryColor = (category: string) => {
    const colors = {
      morning: "#ff9f43",
      afternoon: "#4f9cff",
      evening: "#9b59b6",
      "all-day": "#ff5c93",
    };
    return colors[category as keyof typeof colors] || "#4f9cff";
  };

  const renderMonthSection = ({ item }: { item: string }) => {
    const dates = Object.keys(groupedEvents[item]).sort();

    return (
      <View style={styles.monthSection}>
        <Text style={styles.monthHeader}>{item}</Text>
        {dates.map((date) => {
          const eventsForDate = groupedEvents[item][date];
          const dateNum = new Date(date).getDate();

          return (
            // ✅ FIXED: Changed from TouchableOpacity to View (no press action)
            <View
              key={date}
              style={styles.dateCard}
            >
              <View style={styles.dateNumber}>
                <Text style={styles.dateNumberText}>{dateNum}</Text>
              </View>

              <View style={styles.eventPreview}>
                <Text style={styles.eventTitle} numberOfLines={1}>
                  {eventsForDate[0].title}
                </Text>
                {eventsForDate.length > 1 && (
                  <Text style={styles.moreEvents}>
                    +{eventsForDate.length - 1} more
                  </Text>
                )}
              </View>

              {/* ✅ FIXED: Only this button opens the modal */}
              <TouchableOpacity 
                style={styles.viewMoreButton}
                onPress={() => handleViewMorePress(date, eventsForDate)}
                activeOpacity={0.7}
              >
                <Text style={styles.viewMoreText}>VIEW MORE</Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#b8c7ff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Event Calendar</Text>
        {canManageEvents() && (
          <TouchableOpacity onPress={() => router.push("/CreateEventScreen")}>
            <Ionicons name="add-circle" size={28} color="#ff5c93" />
          </TouchableOpacity>
        )}
        {!canManageEvents() && <View style={{ width: 28 }} />}
      </View>

      {/* Events List */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading events...</Text>
        </View>
      ) : Object.keys(groupedEvents).length === 0 ? (
        <View style={styles.emptyContainer}>
          <Ionicons name="calendar-outline" size={80} color="#3a4a6a" />
          <Text style={styles.emptyText}>No events scheduled</Text>
          {canManageEvents() && (
            <TouchableOpacity
              style={styles.createButton}
              onPress={() => router.push("/CreateEventScreen")}
            >
              <Text style={styles.createButtonText}>Create Event</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          data={Object.keys(groupedEvents)}
          renderItem={renderMonthSection}
          keyExtractor={(item) => item}
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* Event Details Modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalDate}>
                {selectedDate ? formatDate(selectedDate) : ""}
              </Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={28} color="#b8c7ff" />
              </TouchableOpacity>
            </View>

            {/* Events List */}
            <ScrollView style={styles.eventsScrollView}>
              {selectedEvents.map((event) => (
                <View
                  key={event.id}
                  style={[
                    styles.eventCard,
                    { borderLeftColor: getCategoryColor(event.category) },
                  ]}
                >
                  <View style={styles.eventHeader}>
                    <Text style={styles.eventCardTitle}>{event.title}</Text>
                    {canManageEvents() && (
                      <TouchableOpacity
                        onPress={() => handleDeleteEvent(event.id)}
                      >
                        <Ionicons name="trash-outline" size={20} color="#ff5c93" />
                      </TouchableOpacity>
                    )}
                  </View>

                  {event.description && (
                    <Text style={styles.eventDescription}>
                      {event.description}
                    </Text>
                  )}

                  <View style={styles.eventMeta}>
                    {event.startTime && (
                      <View style={styles.metaItem}>
                        <Ionicons name="time-outline" size={16} color="#b8c7ff" />
                        <Text style={styles.metaText}>
                          {event.startTime}
                          {event.endTime && ` - ${event.endTime}`}
                        </Text>
                      </View>
                    )}

                    <View style={styles.metaItem}>
                      <Ionicons name="person-outline" size={16} color="#b8c7ff" />
                      <Text style={styles.metaText}>{event.createdByName}</Text>
                    </View>
                  </View>

                  <View
                    style={[
                      styles.categoryBadge,
                      { backgroundColor: getCategoryColor(event.category) },
                    ]}
                  >
                    <Text style={styles.categoryText}>
                      {event.category.replace("-", " ").toUpperCase()}
                    </Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0e1320",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1b2235",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#b8c7ff",
    letterSpacing: 1,
  },
  listContent: {
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  monthSection: {
    marginBottom: 24,
  },
  monthHeader: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#ff5c93",
    marginBottom: 12,
    letterSpacing: 0.5,
  },
  dateCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1b2235",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 92, 147, 0.2)",
  },
  dateNumber: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "#ff5c93",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
  },
  dateNumberText: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#fff",
  },
  eventPreview: {
    flex: 1,
  },
  eventTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#e9edff",
    marginBottom: 4,
  },
  moreEvents: {
    fontSize: 12,
    color: "#b8c7ff",
  },
  viewMoreButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(255, 92, 147, 0.2)",
  },
  viewMoreText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#ff5c93",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: "#1b2235",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 20,
    maxHeight: "80%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#2a3650",
  },
  modalDate: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#e9edff",
  },
  eventsScrollView: {
    padding: 20,
  },
  eventCard: {
    backgroundColor: "#243054",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderLeftWidth: 4,
  },
  eventHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  eventCardTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#e9edff",
    flex: 1,
  },
  eventDescription: {
    fontSize: 14,
    color: "#b8c7ff",
    marginBottom: 12,
    lineHeight: 20,
  },
  eventMeta: {
    marginBottom: 12,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  metaText: {
    fontSize: 13,
    color: "#b8c7ff",
    marginLeft: 8,
  },
  categoryBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  categoryText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#fff",
    letterSpacing: 0.5,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    fontSize: 16,
    color: "#b8c7ff",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  emptyText: {
    fontSize: 18,
    color: "#b8c7ff",
    marginTop: 16,
    marginBottom: 24,
  },
  createButton: {
    backgroundColor: "#ff5c93",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  createButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#fff",
  },
});

export default EventCalendarScreen;
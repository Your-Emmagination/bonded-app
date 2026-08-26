// EventCalendarScreen.tsx
import { getUserData, UserRole } from "@/utils/rbac";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import React, { useEffect, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";

type CalendarEvent = {
  id: string;
  title: string;
  description?: string;
  date: string; 
  startTime?: string; 
  endTime?: string;
  category: "morning" | "afternoon" | "evening" | "all-day";
  createdBy: string;
  createdByName: string;
  createdAt: any;
  notifyUsers?: boolean;
  status?: "published" | "draft" | "archived";
};

type GroupedEvents = {
  [month: string]: {
    [date: string]: CalendarEvent[];
  };
};

const EventCalendarScreen = () => {
  const router = useRouter();
  const { eventId } = useLocalSearchParams<{ eventId?: string | string[] }>();
  const resolvedEventId = Array.isArray(eventId) ? eventId[0] : eventId;
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [groupedEvents, setGroupedEvents] = useState<GroupedEvents>({});
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<CalendarEvent[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [currentUserRole, setCurrentUserRole] = useState<
    UserRole | undefined
  >();
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
      },
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!resolvedEventId || events.length === 0) return;

    const targetEvent = events.find((event) => event.id === resolvedEventId);
    if (!targetEvent) return;

    const eventsForDate = events
      .filter((event) => event.date === targetEvent.date)
      .sort((first, second) => {
        const firstTime = first.startTime || "";
        const secondTime = second.startTime || "";
        return firstTime.localeCompare(secondTime);
      });

    setSelectedDate(targetEvent.date);
    setSelectedEvents(eventsForDate);
    setModalVisible(true);
  }, [events, resolvedEventId]);

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

  const handleViewMorePress = (
    date: string,
    eventsForDate: CalendarEvent[],
  ) => {
    setSelectedDate(date);
    setSelectedEvents(eventsForDate);
    setModalVisible(true);
  };

  const handleDeleteEvent = async (eventId: string) => {
    Alert.alert("Delete Event", "Are you sure you want to delete this event?", [
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
    ]);
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
      "all-day": "#e0a53d",
    };
    return colors[category as keyof typeof colors] || "#4f9cff";
  };

  const getStatusDetails = (status?: CalendarEvent["status"]) => {
    if (status === "draft") {
      return { label: "DRAFT", icon: "create-outline" as const, color: "#9b766c" };
    }
    if (status === "archived") {
      return { label: "ARCHIVED", icon: "archive-outline" as const, color: "#7a3b2e" };
    }
    return { label: "PUBLISHED", icon: "checkmark-circle-outline" as const, color: "#5f0909" };
  };

  const handleEditEvent = (event: CalendarEvent) => {
    if (event.status !== "draft" || !canManageEvents()) return;
    setModalVisible(false);
    router.push({ pathname: "/CreateEventScreen", params: { eventId: event.id } });
  };

  const renderMonthSection = ({ item }: { item: string }) => {
    const dates = Object.keys(groupedEvents[item]).sort();

    return (
      <View style={styles.monthSection}>
        <View style={styles.monthHeaderRow}>
          <Text style={styles.monthHeader}>{item}</Text>
          <View style={styles.monthAccent} />
        </View>
        {dates.map((date) => {
          const eventsForDate = groupedEvents[item][date];
          const dateNum = new Date(date).getDate();

          return (
            <View key={date} style={styles.dateCard}>
              <View style={styles.dateNumber}>
                <Text style={styles.dateNumberText}>{dateNum}</Text>
              </View>

              <View style={styles.eventPreview}>
                <Text style={styles.eventDateLabel}>
                  {new Date(date).toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </Text>
                <Text style={styles.eventTitle} numberOfLines={1}>
                  {eventsForDate[0].title}
                </Text>
                <View style={styles.previewStatus}>
                  <Ionicons
                    name={getStatusDetails(eventsForDate[0].status).icon}
                    size={13}
                    color={getStatusDetails(eventsForDate[0].status).color}
                  />
                  <Text style={[styles.previewStatusText, { color: getStatusDetails(eventsForDate[0].status).color }]}>
                    {getStatusDetails(eventsForDate[0].status).label}
                  </Text>
                </View>
                {eventsForDate.length > 1 && (
                  <Text style={styles.moreEvents}>
                    +{eventsForDate.length - 1} more scheduled
                  </Text>
                )}
              </View>

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
      <View style={styles.contentShell}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#7a3b2e" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Event Calendar</Text>
        {canManageEvents() && (
          <TouchableOpacity onPress={() => router.push("/CreateEventScreen")}>
            <Ionicons name="add-circle" size={28} color="#e0a53d" />
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
          <Ionicons name="calendar-outline" size={80} color="#b88f87" />
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
                <Ionicons name="close" size={28} color="#7a3b2e" />
              </TouchableOpacity>
            </View>

            {/* Events List */}
            <ScrollView style={styles.eventsScrollView}>
              {selectedEvents.map((event) => (
                <View
                  key={event.id}
                  style={[
                    styles.eventCard,
                    resolvedEventId === event.id && styles.highlightedEventCard,
                    { borderLeftColor: getCategoryColor(event.category) },
                  ]}
                >
                  <View style={styles.eventHeader}>
                    <Text style={styles.eventCardTitle}>{event.title}</Text>
                    {event.status === "draft" && canManageEvents() && (
                      <TouchableOpacity onPress={() => handleEditEvent(event)} accessibilityLabel="Edit draft event">
                        <Ionicons name="create-outline" size={21} color="#e0a53d" />
                      </TouchableOpacity>
                    )}
                    {canManageEvents() && (
                      <TouchableOpacity
                        onPress={() => handleDeleteEvent(event.id)}
                      >
                        <Ionicons
                          name="trash-outline"
                          size={20}
                          color="#e0a53d"
                        />
                      </TouchableOpacity>
                    )}
                  </View>

                  <View style={[styles.statusBadge, { backgroundColor: getStatusDetails(event.status).color }]}>
                    <Ionicons name={getStatusDetails(event.status).icon} size={13} color="#fffaf7" />
                    <Text style={styles.statusText}>{getStatusDetails(event.status).label}</Text>
                  </View>

                  {event.description && (
                    <Text style={styles.eventDescription}>
                      {event.description}
                    </Text>
                  )}

                  <View style={styles.eventMeta}>
                    {event.startTime && (
                      <View style={styles.metaItem}>
                        <Ionicons
                          name="time-outline"
                          size={16}
                          color="#7a3b2e"
                        />
                        <Text style={styles.metaText}>
                          {event.startTime}
                          {event.endTime && ` - ${event.endTime}`}
                        </Text>
                      </View>
                    )}

                    <View style={styles.metaItem}>
                      <Ionicons
                        name="person-outline"
                        size={16}
                        color="#7a3b2e"
                      />
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
      </View>
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
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#fffaf7",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#7a3b2e",
    letterSpacing: 1,
  },
  listContent: {
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  monthSection: {
    marginBottom: 24,
  },
  monthHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  monthHeader: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#5f0909",
    letterSpacing: 0.5,
  },
  monthAccent: {
    flex: 1,
    height: 1,
    marginLeft: 12,
    backgroundColor: "#d8b7ab",
  },
  dateCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fffdfb",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#eadbd4",
    shadowColor: "#7a3b2e",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  dateNumber: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "#7d1d13",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
  },
  dateNumberText: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#fff7f1",
  },
  eventDateLabel: {
    fontSize: 11,
    color: "#9b766c",
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 3,
  },
  eventPreview: {
    flex: 1,
  },
  eventTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#4d1b17",
    marginBottom: 4,
  },
  previewStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  previewStatusText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  moreEvents: {
    fontSize: 12,
    color: "#7a3b2e",
  },
  viewMoreButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#7d1d13",
  },
  viewMoreText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#fff7f1",
    letterSpacing: 0.4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: "#fffaf7",
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
    borderBottomColor: "#eadbd4",
  },
  modalDate: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#4d1b17",
  },
  eventsScrollView: {
    padding: 20,
  },
  eventCard: {
    backgroundColor: "#f8efea",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderWidth: 1,
    borderColor: "#eadbd4",
  },
  highlightedEventCard: {
    backgroundColor: "#fff5df",
    borderColor: "#e0a53d",
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
    color: "#4d1b17",
    flex: 1,
  },
  statusBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 10,
    marginBottom: 10,
  },
  statusText: {
    color: "#fffaf7",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  eventDescription: {
    fontSize: 14,
    color: "#7a3b2e",
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
    color: "#7a3b2e",
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
    color: "#7a3b2e",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  emptyText: {
    fontSize: 18,
    color: "#7a3b2e",
    marginTop: 16,
    marginBottom: 24,
  },
  createButton: {
    backgroundColor: "#e0a53d",
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
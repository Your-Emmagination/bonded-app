// CreateEventScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker"; 
import { useLocalSearchParams, useRouter } from "expo-router";
import { addDoc, collection, doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import { getUserData, UserRole } from "@/utils/rbac";
import { createBroadcastEventNotifications } from "@/utils/notifications";
import { sendBroadcastEventPushNotifications } from "@/utils/pushNotifications";
type CalendarEvent = {
  title: string;
  description?: string;
  date: string; // Format: "YYYY-MM-DD"
  startTime?: string; // Format: "HH:mm"
  endTime?: string;
  category: "morning" | "afternoon" | "evening" | "all-day";
  notifyUsers?: boolean;
  status?: "published" | "draft" | "archived";
};

const categoryIcons = {
  morning: "sunny-outline",
  afternoon: "partly-sunny-outline",
  evening: "moon-outline",
  "all-day": "infinite-outline",
} as const;

const CreateEventScreen = () => {
  const router = useRouter();
  const { eventId } = useLocalSearchParams<{ eventId?: string | string[] }>();
  const editingEventId = Array.isArray(eventId) ? eventId[0] : eventId;
  const [currentUserRole, setCurrentUserRole] = useState<
    UserRole | undefined
  >();
  const [form, setForm] = useState<CalendarEvent>({
    title: "",
    description: "",
    date: new Date().toISOString().split("T")[0], 
    category: "morning",
    notifyUsers: false,
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!editingEventId) return;

    const loadEvent = async () => {
      try {
        const eventSnapshot = await getDoc(doc(db, "events", editingEventId));
        if (eventSnapshot.exists()) {
          const event = eventSnapshot.data() as CalendarEvent;
          setForm({
            title: event.title || "",
            description: event.description || "",
            date: event.date || new Date().toISOString().split("T")[0],
            startTime: event.startTime,
            endTime: event.endTime,
            category: event.category || "morning",
            notifyUsers: event.notifyUsers || false,
            status: event.status,
          });
        }
      } catch (error) {
        console.error("Error loading event:", error);
        Alert.alert("Error", "Could not load this event for editing.");
      }
    };

    loadEvent();
  }, [editingEventId]);

  useEffect(() => {
    const fetchUserRole = async () => {
      if (auth.currentUser) {
        const userData = await getUserData(auth.currentUser.uid);
        setCurrentUserRole(userData?.role);
      }
    };
    fetchUserRole();
  }, []);

  // Check if user can manage events
  const canManageEvents = useCallback(() => {
    return ["moderator", "teacher", "admin"].includes(currentUserRole || "");
  }, [currentUserRole]);

  useEffect(() => {
    if (currentUserRole !== undefined && !canManageEvents()) {
      Alert.alert(
        "Access Denied",
        "You do not have permission to create events.",
        [{ text: "OK", onPress: () => router.back() }],
      );
    }
  }, [currentUserRole, canManageEvents, router]);

  const handleInputChange = (
    key: keyof CalendarEvent,
    value: string | boolean,
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleDateChange = (event: any, selectedDate?: Date) => {
    setShowDatePicker(false);
    if (selectedDate) {
      const dateString = selectedDate.toISOString().split("T")[0];
      setForm((prev) => ({ ...prev, date: dateString }));
    }
  };

  const handleTimeChange = (
    event: any,
    selectedTime: Date | undefined,
    field: "startTime" | "endTime",
  ) => {
    setShowStartTimePicker(false);
    setShowEndTimePicker(false);
    if (selectedTime) {
      const timeString = selectedTime.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      setForm((prev) => ({ ...prev, [field]: timeString }));
    }
  };

  const handleSave = async (status: "published" | "draft") => {
    if (!form.title.trim()) {
      Alert.alert("Error", "Title is required.");
      return;
    }

    if (!auth.currentUser) {
      Alert.alert("Error", "You must be logged in to create an event.");
      return;
    }

    setLoading(true);
    try {
      const currentUserData = await getUserData(auth.currentUser.uid);
      const actorName =
        currentUserData
          ? `${currentUserData.firstname} ${currentUserData.lastname}`.trim()
          : auth.currentUser.displayName || auth.currentUser.email || "Unknown";
      const eventData = {
        ...form,
        status,
        createdBy: auth.currentUser.uid,
        createdByName:
          currentUserData
            ? `${currentUserData.firstname} ${currentUserData.lastname}`.trim() ||
              auth.currentUser.displayName ||
              auth.currentUser.email ||
              "Unknown"
            : auth.currentUser.displayName || auth.currentUser.email || "Unknown",
      };
      let createdEventRef = editingEventId
        ? { id: editingEventId }
        : await addDoc(collection(db, "events"), {
            ...eventData,
            createdAt: serverTimestamp(),
          });

      if (editingEventId) {
        await updateDoc(doc(db, "events", editingEventId), eventData);
      }

      let successMessage = status === "draft"
        ? "Event saved as a draft."
        : editingEventId
          ? "Event updated successfully!"
          : "Event created successfully!";

      if (status === "published" && form.notifyUsers) {
        const notificationResults = await Promise.allSettled([
          createBroadcastEventNotifications({
            actor: {
              id: auth.currentUser.uid,
              name: actorName,
              profileImage: currentUserData?.profileImage || null,
            },
            entityId: createdEventRef.id,
            title: form.title,
            description: form.description,
            eventDate: form.date,
          }),
          sendBroadcastEventPushNotifications({
            entityId: createdEventRef.id,
            title: form.title,
            description: form.description,
            eventDate: form.date,
            excludeUserIds: [auth.currentUser.uid],
          }),
        ]);

        const failedDeliveries = notificationResults.filter(
          (result) => result.status === "rejected",
        );

        if (failedDeliveries.length > 0) {
          failedDeliveries.forEach((result) => {
            if (result.status === "rejected") {
              console.error("Event notification delivery error:", result.reason);
            }
          });
          successMessage =
            "Event created, but some notifications could not be delivered.";
        }
      }

      Alert.alert("Success", successMessage, [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (error) {
      console.error("Error creating event:", error);
      Alert.alert("Error", "Failed to create event. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!canManageEvents()) {
    return null; 
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color="#7a3b2e" />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.headerEyebrow}>CALENDAR</Text>
          <Text style={styles.headerTitle}>Create Event</Text>
        </View>
        <View style={styles.draftBadge}>
          <Ionicons name="create-outline" size={14} color="#9b766c" />
          <Text style={styles.draftBadgeText}>{editingEventId ? "EDIT EVENT" : "NEW EVENT"}</Text>
        </View>
      </View>

      <ScrollView
        style={styles.formContainer}
        contentContainerStyle={styles.formContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.introCard}>
          <View style={styles.dateBadge}>
            <Text style={styles.dateBadgeMonth}>{form.date.slice(5, 7)}</Text>
            <Text style={styles.dateBadgeDay}>{form.date.slice(8, 10)}</Text>
          </View>
          <View style={styles.introCopy}>
            <Text style={styles.introEyebrow}>EVENT WORKSPACE</Text>
            <Text style={styles.introTitle}>Plan something meaningful</Text>
            <Text style={styles.introText}>
              Add the details below and choose who should be notified.
            </Text>
          </View>
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Title *</Text>
          <TextInput
            style={styles.textInput}
            value={form.title}
            onChangeText={(value) => handleInputChange("title", value)}
            placeholder="Enter event title"
            placeholderTextColor="#9b766c"
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Description</Text>
          <TextInput
            style={[styles.textInput, styles.multilineInput]}
            value={form.description}
            onChangeText={(value) => handleInputChange("description", value)}
            placeholder="Enter event description (optional)"
            placeholderTextColor="#9b766c"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Date *</Text>
          <TouchableOpacity
            style={styles.dateTimeButton}
            onPress={() => setShowDatePicker(true)}
          >
            <Text style={styles.dateTimeText}>{form.date}</Text>
            <Ionicons name="calendar-outline" size={20} color="#7a3b2e" />
          </TouchableOpacity>
          {showDatePicker && (
            <DateTimePicker
              value={new Date(form.date)}
              mode="date"
              display="default"
              onChange={handleDateChange}
            />
          )}
        </View>

        <View style={styles.timeRow}>
          <View style={styles.timeField}>
            <Text style={styles.label}>Start time</Text>
            <TouchableOpacity
              style={styles.dateTimeButton}
              onPress={() => setShowStartTimePicker(true)}
            >
              <Text style={styles.dateTimeText} numberOfLines={1}>
                {form.startTime || "Select time"}
              </Text>
              <Ionicons name="time-outline" size={19} color="#7a3b2e" />
            </TouchableOpacity>
            {showStartTimePicker && (
              <DateTimePicker
                value={form.startTime ? new Date(`2000-01-01T${form.startTime}`) : new Date()}
                mode="time"
                display="default"
                onChange={(event, selected) => handleTimeChange(event, selected, "startTime")}
              />
            )}
          </View>
          <View style={styles.timeField}>
            <Text style={styles.label}>End time</Text>
            <TouchableOpacity
              style={styles.dateTimeButton}
              onPress={() => setShowEndTimePicker(true)}
            >
              <Text style={styles.dateTimeText} numberOfLines={1}>
                {form.endTime || "Select time"}
              </Text>
              <Ionicons name="time-outline" size={19} color="#7a3b2e" />
            </TouchableOpacity>
            {showEndTimePicker && (
              <DateTimePicker
                value={form.endTime ? new Date(`2000-01-01T${form.endTime}`) : new Date()}
                mode="time"
                display="default"
                onChange={(event, selected) => handleTimeChange(event, selected, "endTime")}
              />
            )}
          </View>
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Category</Text>
          <View style={styles.categoryContainer}>
            {(["morning", "afternoon", "evening", "all-day"] as const).map(
              (cat) => (
                <TouchableOpacity
                  key={cat}
                  style={[
                    styles.categoryButton,
                    form.category === cat && styles.selectedCategoryButton,
                  ]}
                  onPress={() => handleInputChange("category", cat)}
                >
                  <Ionicons
                    name={categoryIcons[cat]}
                    size={16}
                    color={form.category === cat ? "#fff" : "#7a3b2e"}
                  />
                  <Text
                    style={[
                      styles.categoryButtonText,
                      form.category === cat &&
                        styles.selectedCategoryButtonText,
                    ]}
                  >
                    {cat.replace("-", " ").toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ),
            )}
          </View>
        </View>

        <View style={[styles.inputGroup, styles.notifyCard]}>
          <View style={styles.switchContainer}>
            <View style={styles.notifyCopy}>
              <Text style={[styles.label, styles.notifyTitle]}>Notify all users</Text>
              <Text style={styles.notifyText}>Send an update when this event is published.</Text>
            </View>
            <TouchableOpacity
              style={[
                styles.toggleButton,
                form.notifyUsers && styles.toggleButtonActive,
              ]}
              onPress={() =>
                handleInputChange("notifyUsers", !form.notifyUsers)
              }
            >
              <Ionicons
                name={form.notifyUsers ? "toggle" : "toggle-outline"}
                size={24}
                color="#fff"
              />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      <View style={styles.actionBar}>
        <TouchableOpacity
          style={[styles.secondaryAction, loading && styles.submitButtonDisabled]}
          onPress={() => handleSave("draft")}
          disabled={loading}
        >
          <Ionicons name="bookmark-outline" size={19} color="#7a3b2e" />
          <Text style={styles.secondaryActionText}>Save draft</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.submitButton, loading && styles.submitButtonDisabled]}
          onPress={() => handleSave("published")}
          disabled={loading}
        >
          <Ionicons name={loading ? "hourglass-outline" : "paper-plane-outline"} size={19} color="#fff" />
          <Text style={styles.submitButtonText}>{loading ? "Saving..." : "Publish"}</Text>
        </TouchableOpacity>
      </View>
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
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#dfc5bc",
    backgroundColor: "#fff8f4",
  },
  backButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: "#f6f1ed",
    borderWidth: 1,
    borderColor: "#dfc5bc",
  },
  headerCopy: {
    flex: 1,
    marginLeft: 12,
  },
  headerEyebrow: {
    color: "#9b766c",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#7a3b2e",
    marginTop: 2,
  },
  draftBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: "#f6f1ed",
    borderWidth: 1,
    borderColor: "#dfc5bc",
  },
  draftBadgeText: {
    color: "#9b766c",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  formContainer: {
    flex: 1,
    paddingHorizontal: 16,
  },
  formContent: {
    paddingTop: 18,
    paddingBottom: 28,
  },
  introCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#5f0909",
    borderWidth: 1,
    borderColor: "#7a3b2e",
    borderRadius: 18,
    padding: 16,
    marginBottom: 22,
  },
  dateBadge: {
    width: 50,
    minHeight: 54,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#e0a53d",
  },
  dateBadgeMonth: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  dateBadgeDay: {
    color: "#fff",
    fontSize: 21,
    fontWeight: "800",
    lineHeight: 23,
  },
  introCopy: {
    flex: 1,
    marginLeft: 12,
  },
  introTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800",
  },
  introEyebrow: {
    color: "#e0a53d",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.2,
    marginBottom: 3,
  },
  introText: {
    color: "#fff8f4",
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  inputGroup: {
    marginBottom: 18,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#4d1b17",
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: "#fff8f4",
    color: "#4d1b17",
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    fontSize: 16,
    borderWidth: 1,
    borderColor: "#dfc5bc",
  },
  multilineInput: {
    height: 96,
    textAlignVertical: "top",
  },
  dateTimeButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff8f4",
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#dfc5bc",
  },
  dateTimeText: {
    color: "#4d1b17",
    fontSize: 16,
  },
  timeRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 18,
  },
  timeField: {
    flex: 1,
  },
  categoryContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  categoryButton: {
    backgroundColor: "#fff8f4",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#dfc5bc",
  },
  selectedCategoryButton: {
    backgroundColor: "#e0a53d",
    borderColor: "#e0a53d",
  },
  categoryButtonText: {
    color: "#7a3b2e",
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  selectedCategoryButtonText: {
    color: "#fff",
  },
  switchContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  notifyCard: {
    backgroundColor: "#fff8f4",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#dfc5bc",
    padding: 14,
  },
  notifyCopy: {
    flex: 1,
    marginRight: 12,
  },
  notifyTitle: {
    marginBottom: 3,
  },
  notifyText: {
    color: "#9b766c",
    fontSize: 12,
    lineHeight: 17,
  },
  toggleButton: {
    backgroundColor: "#fff8f4",
    padding: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#dfc5bc",
  },
  toggleButtonActive: {
    backgroundColor: "#e0a53d",
    borderColor: "#e0a53d",
  },
  submitButton: {
    flex: 1,
    backgroundColor: "#e0a53d",
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 20,
    borderRadius: 12,
    shadowColor: "#e0a53d",
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 3,
  },
  submitButtonDisabled: {
    backgroundColor: "#b88f87",
  },
  submitButtonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
  },
  actionBar: {
    flexDirection: "row",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 20,
  },
  secondaryAction: {
    flex: 1,
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#dfc5bc",
    backgroundColor: "#fff8f4",
  },
  secondaryActionText: {
    color: "#7a3b2e",
    fontSize: 14,
    fontWeight: "700",
  },
});

export default CreateEventScreen;
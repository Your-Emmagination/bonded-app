// CreateEventScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker"; 
import { useRouter } from "expo-router";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
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
};

const CreateEventScreen = () => {
  const router = useRouter();
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

  const handleSubmit = async () => {
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
      const createdEventRef = await addDoc(collection(db, "events"), {
        ...form,
        createdBy: auth.currentUser.uid,
        createdByName:
          currentUserData
            ? `${currentUserData.firstname} ${currentUserData.lastname}`.trim() ||
              auth.currentUser.displayName ||
              auth.currentUser.email ||
              "Unknown"
            : auth.currentUser.displayName || auth.currentUser.email || "Unknown",
        createdAt: serverTimestamp(),
      });

      let successMessage = "Event created successfully!";

      if (form.notifyUsers) {
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
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#7a3b2e" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Create Event</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        style={styles.formContainer}
        contentContainerStyle={styles.formContent}
      >
        {/* Title */}
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

        {/* Description */}
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

        {/* Date */}
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

        {/* Start Time */}
        <View style={styles.inputGroup}>
          <Text style={styles.label}>Start Time (Optional)</Text>
          <TouchableOpacity
            style={styles.dateTimeButton}
            onPress={() => setShowStartTimePicker(true)}
          >
            <Text style={styles.dateTimeText}>
              {form.startTime || "Select start time"}
            </Text>
            <Ionicons name="time-outline" size={20} color="#7a3b2e" />
          </TouchableOpacity>
          {showStartTimePicker && (
            <DateTimePicker
              value={
                form.startTime
                  ? new Date(`2000-01-01T${form.startTime}`)
                  : new Date()
              }
              mode="time"
              display="default"
              onChange={(event, selected) =>
                handleTimeChange(event, selected, "startTime")
              }
            />
          )}
        </View>

        {/* End Time */}
        <View style={styles.inputGroup}>
          <Text style={styles.label}>End Time (Optional)</Text>
          <TouchableOpacity
            style={styles.dateTimeButton}
            onPress={() => setShowEndTimePicker(true)}
          >
            <Text style={styles.dateTimeText}>
              {form.endTime || "Select end time"}
            </Text>
            <Ionicons name="time-outline" size={20} color="#7a3b2e" />
          </TouchableOpacity>
          {showEndTimePicker && (
            <DateTimePicker
              value={
                form.endTime
                  ? new Date(`2000-01-01T${form.endTime}`)
                  : new Date()
              }
              mode="time"
              display="default"
              onChange={(event, selected) =>
                handleTimeChange(event, selected, "endTime")
              }
            />
          )}
        </View>

        {/* Category */}
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

        {/* Notify Users */}
        <View style={styles.inputGroup}>
          <View style={styles.switchContainer}>
            <Text style={styles.label}>Notify All Users</Text>
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

      {/* Submit Button */}
      <TouchableOpacity
        style={[styles.submitButton, loading && styles.submitButtonDisabled]}
        onPress={handleSubmit}
        disabled={loading}
      >
        <Text style={styles.submitButtonText}>
          {loading ? "Creating..." : "Create Event"}
        </Text>
      </TouchableOpacity>
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
  formContainer: {
    flex: 1,
    paddingHorizontal: 16,
  },
  formContent: {
    paddingVertical: 16,
  },
  inputGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    color: "#4d1b17",
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: "#fff8f4",
    color: "#4d1b17",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    borderWidth: 1,
    borderColor: "#dfc5bc",
  },
  multilineInput: {
    height: 80,
    textAlignVertical: "top",
  },
  dateTimeButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff8f4",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "#dfc5bc",
  },
  dateTimeText: {
    color: "#4d1b17",
    fontSize: 16,
  },
  categoryContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  categoryButton: {
    backgroundColor: "#fff8f4",
    paddingHorizontal: 16,
    paddingVertical: 8,
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
  },
  selectedCategoryButtonText: {
    color: "#fff",
  },
  switchContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
    backgroundColor: "#e0a53d",
    paddingVertical: 16,
    alignItems: "center",
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
});

export default CreateEventScreen;

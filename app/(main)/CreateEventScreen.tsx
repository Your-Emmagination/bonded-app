// CreateEventScreen.tsx
import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../../Firebase_configure";
import { getUserData, UserRole } from "@/utils/rbac";
import DateTimePicker from "@react-native-community/datetimepicker"; // You'll need to install this: npx expo install @react-native-community/datetimepicker

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
  const [currentUserRole, setCurrentUserRole] = useState<UserRole | undefined>();
  const [form, setForm] = useState<CalendarEvent>({
    title: "",
    description: "",
    date: new Date().toISOString().split("T")[0], // Default to today
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
        console.log("Fetched user role:", userData?.role); // Temporary debug log
        setCurrentUserRole(userData?.role);
      }
    };
    fetchUserRole();
  }, []);

  // Check if user can manage events
  const canManageEvents = useCallback(() => {
    return ["moderator", "teacher", "admin"].includes(currentUserRole || "");
  }, [currentUserRole]);

  // ✅ FIXED: Only check after role is fetched (avoids race condition)
  useEffect(() => {
    if (currentUserRole !== undefined && !canManageEvents()) {
      Alert.alert("Access Denied", "You do not have permission to create events.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    }
  }, [currentUserRole, canManageEvents, router]);

  const handleInputChange = (key: keyof CalendarEvent, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleDateChange = (event: any, selectedDate?: Date) => {
    setShowDatePicker(false);
    if (selectedDate) {
      const dateString = selectedDate.toISOString().split("T")[0];
      setForm((prev) => ({ ...prev, date: dateString }));
    }
  };

  const handleTimeChange = (event: any, selectedTime: Date | undefined, field: "startTime" | "endTime") => {
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
      await addDoc(collection(db, "events"), {
        ...form,
        createdBy: auth.currentUser.uid,
        createdByName: auth.currentUser.displayName || auth.currentUser.email || "Unknown",
        createdAt: serverTimestamp(),
      });
      Alert.alert("Success", "Event created successfully!", [
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
    return null; // Or a loading screen until redirect
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#b8c7ff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Create Event</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView style={styles.formContainer} contentContainerStyle={styles.formContent}>
        {/* Title */}
        <View style={styles.inputGroup}>
          <Text style={styles.label}>Title *</Text>
          <TextInput
            style={styles.textInput}
            value={form.title}
            onChangeText={(value) => handleInputChange("title", value)}
            placeholder="Enter event title"
            placeholderTextColor="rgba(255,255,255,0.5)"
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
            placeholderTextColor="rgba(255,255,255,0.5)"
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
            <Ionicons name="calendar-outline" size={20} color="#b8c7ff" />
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
            <Ionicons name="time-outline" size={20} color="#b8c7ff" />
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
            <Ionicons name="time-outline" size={20} color="#b8c7ff" />
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

        {/* Category */}
        <View style={styles.inputGroup}>
          <Text style={styles.label}>Category</Text>
          <View style={styles.categoryContainer}>
            {(["morning", "afternoon", "evening", "all-day"] as const).map((cat) => (
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
                    form.category === cat && styles.selectedCategoryButtonText,
                  ]}
                >
                  {cat.replace("-", " ").toUpperCase()}
                </Text>
              </TouchableOpacity>
            ))}
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
              onPress={() => handleInputChange("notifyUsers", !form.notifyUsers)}
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
    color: "#e9edff",
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: "#243054",
    color: "#fff",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  multilineInput: {
    height: 80,
    textAlignVertical: "top",
  },
  dateTimeButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#243054",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  dateTimeText: {
    color: "#fff",
    fontSize: 16,
  },
  categoryContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  categoryButton: {
    backgroundColor: "#243054",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  selectedCategoryButton: {
    backgroundColor: "#ff5c93",
    borderColor: "#ff5c93",
  },
  categoryButtonText: {
    color: "#b8c7ff",
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
    backgroundColor: "#243054",
    padding: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  toggleButtonActive: {
    backgroundColor: "#ff5c93",
    borderColor: "#ff5c93",
  },
  submitButton: {
    backgroundColor: "#ff5c93",
    paddingVertical: 16,
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 20,
    borderRadius: 12,
    shadowColor: "#ff5c93",
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 3,
  },
  submitButtonDisabled: {
    backgroundColor: "#6c757d",
  },
  submitButtonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
  },
});

export default CreateEventScreen;
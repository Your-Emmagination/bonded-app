import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { addDoc, collection, doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import { ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useNetworkStatus } from "@/utils/networkUtils";
import { createBroadcastEventNotifications } from "@/utils/notifications";
import { sendBroadcastEventPushNotifications } from "@/utils/pushNotifications";
import { getUserData, UserRole } from "@/utils/rbac";
import { auth, db } from "../../Firebase_configure";

type CalendarEvent = {
  title: string;
  description?: string;
  date: string;
  startTime?: string;
  endTime?: string;
  category: "morning" | "afternoon" | "evening" | "all-day";
  notifyUsers?: boolean;
  status?: "published" | "draft" | "archived";
};

type Category = CalendarEvent["category"];
type IconName = ComponentProps<typeof Ionicons>["name"];

const colors = {
  maroon: "#5f0909",
  gold: "#e0a53d",
  cream: "#faf4ec",
  surface: "#fffdf9",
  soft: "#f5eae0",
  ink: "#321817",
  muted: "#806964",
  border: "#ead7c9",
  error: "#b42318",
} as const;

const categoryIcons: Record<Category, IconName> = {
  morning: "sunny-outline",
  afternoon: "partly-sunny-outline",
  evening: "moon-outline",
  "all-day": "infinite-outline",
};

const categoryLabels: Record<Category, string> = {
  morning: "MORNING",
  afternoon: "AFTERNOON",
  evening: "EVENING",
  "all-day": "ALL DAY",
};

const categories = Object.keys(categoryIcons) as Category[];

const toLocalDateString = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseDate = (value: string) => new Date(`${value}T00:00:00`);

const formatTime = (value?: string) => {
  if (!value) return "Select time";
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value;
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
};

const SectionHeading = ({
  icon,
  title,
  subtitle,
  spaced = false,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  spaced?: boolean;
}) => (
  <View style={[styles.sectionHeading, spaced && styles.sectionHeadingSpaced]}>
    <View style={styles.sectionIcon}>
      <Ionicons name={icon} size={18} color={colors.maroon} />
    </View>
    <View>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionSubtitle}>{subtitle}</Text>
    </View>
  </View>
);

const TimeRow = ({
  label,
  date,
  value,
  empty,
  onPress,
}: {
  label: string;
  date: string;
  value: string;
  empty: boolean;
  onPress: () => void;
}) => (
  <View style={styles.timeRow}>
    <View style={styles.timeCopy}>
      <Text style={styles.timeLabel}>{label}</Text>
      <Text style={styles.timeDate}>{date}</Text>
    </View>
    <TouchableOpacity
      accessibilityHint={`Opens the ${label.toLowerCase()} time picker`}
      accessibilityLabel={`${label} time, ${value}`}
      accessibilityRole="button"
      activeOpacity={0.72}
      onPress={onPress}
      style={styles.timeButton}
    >
      <Ionicons name="time-outline" size={16} color={colors.maroon} />
      <Text style={[styles.timeButtonText, empty && styles.timePlaceholder]}>{value}</Text>
    </TouchableOpacity>
  </View>
);

const CreateEventScreen = () => {
  const router = useRouter();
  const { isOffline } = useNetworkStatus();
  const { eventId } = useLocalSearchParams<{ eventId?: string | string[] }>();
  const editingEventId = Array.isArray(eventId) ? eventId[0] : eventId;
  const savingRef = useRef(false);
  const [currentUserRole, setCurrentUserRole] = useState<UserRole>();
  const [form, setForm] = useState<CalendarEvent>({
    title: "",
    description: "",
    date: toLocalDateString(new Date()),
    category: "morning",
    notifyUsers: false,
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);
  const [titleFocused, setTitleFocused] = useState(false);
  const [detailsFocused, setDetailsFocused] = useState(false);

  useEffect(() => {
    if (!editingEventId) return;
    const loadEvent = async () => {
      try {
        const snapshot = await getDoc(doc(db, "events", editingEventId));
        if (snapshot.exists()) {
          const event = snapshot.data() as CalendarEvent;
          setForm({
            title: event.title || "",
            description: event.description || "",
            date: event.date || toLocalDateString(new Date()),
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
    void loadEvent();
  }, [editingEventId]);

  useEffect(() => {
    const fetchUserRole = async () => {
      if (auth.currentUser) {
        const userData = await getUserData(auth.currentUser.uid);
        setCurrentUserRole(userData?.role);
      }
    };
    void fetchUserRole();
  }, []);

  const canManageEvents = useCallback(
    () => ["moderator", "teacher", "admin"].includes(currentUserRole || ""),
    [currentUserRole],
  );

  useEffect(() => {
    if (currentUserRole !== undefined && !canManageEvents()) {
      Alert.alert("Access Denied", "You do not have permission to create events.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    }
  }, [currentUserRole, canManageEvents, router]);

  const selectedDate = useMemo(() => parseDate(form.date), [form.date]);
  const dateDisplay = useMemo(
    () => ({
      month: selectedDate.toLocaleDateString("en-US", { month: "short" }).toUpperCase(),
      day: selectedDate.toLocaleDateString("en-US", { day: "2-digit" }),
      weekday: selectedDate.toLocaleDateString("en-US", { weekday: "long" }),
      long: selectedDate.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    }),
    [selectedDate],
  );

  const handleInputChange = (key: keyof CalendarEvent, value: string | boolean) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const handleDateChange = (_event: unknown, selected?: Date) => {
    setShowDatePicker(false);
    if (selected) {
      setForm((previous) => ({ ...previous, date: toLocalDateString(selected) }));
      void Haptics.selectionAsync();
    }
  };

  const handleTimeChange = (
    _event: unknown,
    selected: Date | undefined,
    field: "startTime" | "endTime",
  ) => {
    setShowStartTimePicker(false);
    setShowEndTimePicker(false);
    if (selected) {
      const value = `${String(selected.getHours()).padStart(2, "0")}:${String(
        selected.getMinutes(),
      ).padStart(2, "0")}`;
      setForm((previous) => ({ ...previous, [field]: value }));
      void Haptics.selectionAsync();
    }
  };

  const handleSave = async (status: "published" | "draft") => {
    if (savingRef.current) return;
    setTitleTouched(true);

    if (!form.title.trim()) {
      Alert.alert("Error", "Title is required.");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    if (!auth.currentUser) {
      Alert.alert("Error", "You must be logged in to create an event.");
      return;
    }
    // Firestore has no offline persistence here, so a "saved" event would be
    // lost without ever reaching the server.
    if (isOffline) {
      Alert.alert("Offline", "Saving events is unavailable while offline.");
      return;
    }

    savingRef.current = true;
    setLoading(true);
    Keyboard.dismiss();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const currentUserData = await getUserData(auth.currentUser.uid);
      const actorName = currentUserData
        ? `${currentUserData.firstname} ${currentUserData.lastname}`.trim()
        : auth.currentUser.displayName || auth.currentUser.email || "Unknown";
      const authorName = currentUserData
        ? `${currentUserData.firstname} ${currentUserData.lastname}`.trim() ||
          auth.currentUser.displayName ||
          auth.currentUser.email ||
          "Unknown"
        : auth.currentUser.displayName || auth.currentUser.email || "Unknown";

      // An edit writes only the form fields. Authorship stays with whoever
      // created the event: reassigning createdBy to the editor would hand the
      // event to a different owner and lock the original author out of it,
      // because canEditEvent() keys off createdBy. createdAt is likewise only
      // ever written once, at creation.
      const eventData = {
        ...form,
        status,
      };
      const createdEventRef = editingEventId
        ? { id: editingEventId }
        : await addDoc(collection(db, "events"), {
            ...eventData,
            createdBy: auth.currentUser.uid,
            createdByName: authorName,
            createdAt: serverTimestamp(),
          });

      if (editingEventId) {
        await updateDoc(doc(db, "events", editingEventId), eventData);
      }

      let successMessage =
        status === "draft"
          ? "Event saved as a draft."
          : editingEventId
            ? "Event updated successfully!"
            : "Event created successfully!";

      if (status === "published" && form.notifyUsers) {
        const results = await Promise.allSettled([
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
        const failures = results.filter((result) => result.status === "rejected");
        failures.forEach((result) => {
          if (result.status === "rejected") {
            console.error("Event notification delivery error:", result.reason);
          }
        });
        if (failures.length) {
          successMessage = "Event created, but some notifications could not be delivered.";
        }
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Success", successMessage, [{ text: "OK", onPress: () => router.back() }]);
    } catch (error) {
      console.error("Error creating event:", error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Error", "Failed to create event. Please try again.");
    } finally {
      savingRef.current = false;
      setLoading(false);
    }
  };

  if (!canManageEvents()) return null;

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.contentShell}
      >
        <View style={styles.header}>
          <TouchableOpacity
            accessibilityLabel="Go back"
            accessibilityRole="button"
            activeOpacity={0.72}
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Ionicons name="arrow-back" size={22} color={colors.maroon} />
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.headerTitle}>Create Event</Text>
            <Text style={styles.headerSubtitle}>Add an event to the school calendar</Text>
          </View>
          <View style={styles.modeBadge}>
            <View style={styles.modeDot} />
            <Text style={styles.modeText}>{editingEventId ? "EDIT" : "NEW"}</Text>
          </View>
        </View>

        <ScrollView
          contentContainerStyle={styles.formContent}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.formContainer}
        >
          <View style={styles.titleSection}>
            <Text style={styles.eyebrow}>EVENT NAME</Text>
            <TextInput
              accessibilityLabel="Event title, required"
              onBlur={() => {
                setTitleFocused(false);
                setTitleTouched(true);
              }}
              onChangeText={(value) => handleInputChange("title", value)}
              onFocus={() => setTitleFocused(true)}
              placeholder="Enter event title"
              placeholderTextColor="#a68d85"
              returnKeyType="next"
              style={[
                styles.titleInput,
                titleFocused && styles.inputFocused,
                titleTouched && !form.title.trim() && styles.inputError,
              ]}
              value={form.title}
            />
            {titleTouched && !form.title.trim() ? (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle" size={15} color={colors.error} />
                <Text style={styles.errorText}>Title is required.</Text>
              </View>
            ) : (
              <Text style={styles.fieldHint}>Give your event a clear, memorable name.</Text>
            )}
          </View>

          <SectionHeading icon="calendar-outline" title="Schedule" subtitle="Set the event date and time" />
          <View style={styles.scheduleCard}>
            <TouchableOpacity
              accessibilityHint="Opens the date picker"
              accessibilityLabel={`Date, ${dateDisplay.weekday}, ${dateDisplay.long}`}
              accessibilityRole="button"
              activeOpacity={0.75}
              onPress={() => {
                setShowDatePicker(true);
                void Haptics.selectionAsync();
              }}
              style={styles.dateSelector}
            >
              <View style={styles.dateTile}>
                <View style={styles.dateTileHeader}>
                  <Text style={styles.dateMonth}>{dateDisplay.month}</Text>
                </View>
                <Text style={styles.dateDay}>{dateDisplay.day}</Text>
              </View>
              <View style={styles.dateCopy}>
                <Text style={styles.dateWeekday}>{dateDisplay.weekday}</Text>
                <Text style={styles.dateLong}>{dateDisplay.long}</Text>
                <Text style={styles.dateHint}>Tap to change date</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.maroon} />
            </TouchableOpacity>
            {showDatePicker && (
              <DateTimePicker
                value={selectedDate}
                mode="date"
                display="default"
                onChange={handleDateChange}
              />
            )}

            <View style={styles.divider} />
            <View style={styles.timeline}>
              <View style={styles.timelineRail}>
                <View style={styles.timelineDotActive} />
                <View style={styles.timelineLine} />
                <View style={styles.timelineDot} />
              </View>
              <View style={styles.timelineBody}>
                <TimeRow
                  label="START"
                  date={`${dateDisplay.weekday}, ${dateDisplay.month} ${dateDisplay.day}`}
                  value={formatTime(form.startTime)}
                  empty={!form.startTime}
                  onPress={() => setShowStartTimePicker(true)}
                />
                <View style={styles.timelineGap}>
                  <Text style={styles.timelineGapText}>SAME DAY</Text>
                </View>
                <TimeRow
                  label="END"
                  date={`${dateDisplay.weekday}, ${dateDisplay.month} ${dateDisplay.day}`}
                  value={formatTime(form.endTime)}
                  empty={!form.endTime}
                  onPress={() => setShowEndTimePicker(true)}
                />
              </View>
            </View>
            {showStartTimePicker && (
              <DateTimePicker
                value={form.startTime ? new Date(`2000-01-01T${form.startTime}`) : new Date()}
                mode="time"
                display="default"
                onChange={(event, selected) => handleTimeChange(event, selected, "startTime")}
              />
            )}
            {showEndTimePicker && (
              <DateTimePicker
                value={form.endTime ? new Date(`2000-01-01T${form.endTime}`) : new Date()}
                mode="time"
                display="default"
                onChange={(event, selected) => handleTimeChange(event, selected, "endTime")}
              />
            )}
          </View>

          <SectionHeading icon="options-outline" title="Category" subtitle="Choose the event time-of-day label" spaced />
          <ScrollView
            contentContainerStyle={styles.categoryContainer}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {categories.map((category) => {
              const selected = form.category === category;
              return (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  activeOpacity={0.76}
                  key={category}
                  onPress={() => {
                    handleInputChange("category", category);
                    void Haptics.selectionAsync();
                  }}
                  style={[styles.categoryButton, selected && styles.selectedCategoryButton]}
                >
                  <Ionicons
                    name={categoryIcons[category]}
                    size={17}
                    color={selected ? colors.cream : colors.maroon}
                  />
                  <Text
                    style={[
                      styles.categoryButtonText,
                      selected && styles.selectedCategoryButtonText,
                    ]}
                  >
                    {categoryLabels[category]}
                  </Text>
                  {selected && <Ionicons name="checkmark" size={14} color={colors.gold} />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <SectionHeading icon="document-text-outline" title="Description" subtitle="Add helpful details for attendees" spaced />
          <TextInput
            accessibilityLabel="Event description"
            multiline
            numberOfLines={5}
            onBlur={() => setDetailsFocused(false)}
            onChangeText={(value) => handleInputChange("description", value)}
            onFocus={() => setDetailsFocused(true)}
            placeholder="Enter event description (optional)"
            placeholderTextColor="#a68d85"
            style={[styles.descriptionInput, detailsFocused && styles.inputFocused]}
            textAlignVertical="top"
            value={form.description}
          />

          <SectionHeading icon="notifications-outline" title="Publishing options" subtitle="Control how people hear about it" spaced />
          <View style={styles.notifyCard}>
            <View style={styles.notifyIcon}>
              <Ionicons name="megaphone-outline" size={20} color={colors.maroon} />
            </View>
            <View style={styles.notifyCopy}>
              <Text style={styles.notifyTitle}>Notify all users</Text>
              <Text style={styles.notifyText}>Send an update when this event is published.</Text>
            </View>
            <Switch
              accessibilityLabel="Notify all users"
              ios_backgroundColor={colors.border}
              onValueChange={(value) => {
                handleInputChange("notifyUsers", value);
                void Haptics.selectionAsync();
              }}
              thumbColor={colors.cream}
              trackColor={{ false: colors.border, true: colors.maroon }}
              value={Boolean(form.notifyUsers)}
            />
          </View>

          <View style={styles.previewHeading}>
            <Text style={styles.eyebrow}>LIVE PREVIEW</Text>
            <Text style={styles.previewState}>{form.title.trim() ? "READY" : "ADD A TITLE"}</Text>
          </View>
          <View style={styles.previewCard}>
            <View style={styles.previewDate}>
              <Text style={styles.previewMonth}>{dateDisplay.month}</Text>
              <Text style={styles.previewDay}>{dateDisplay.day}</Text>
            </View>
            <View style={styles.previewCopy}>
              <Text numberOfLines={2} style={[styles.previewTitle, !form.title && styles.previewPlaceholder]}>
                {form.title || "Event title"}
              </Text>
              <View style={styles.previewMetaRow}>
                <Ionicons name="time-outline" size={14} color="#dcc4b8" />
                <Text numberOfLines={1} style={styles.previewMeta}>
                  {form.startTime || form.endTime
                    ? `${formatTime(form.startTime)} – ${formatTime(form.endTime)}`
                    : categoryLabels[form.category]}
                </Text>
              </View>
            </View>
          </View>
        </ScrollView>

        <View style={styles.actionBar}>
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.74}
            disabled={loading}
            onPress={() => void handleSave("draft")}
            style={[styles.secondaryAction, loading && styles.actionDisabled]}
          >
            <Ionicons name="bookmark-outline" size={19} color={colors.maroon} />
            <Text style={styles.secondaryActionText}>Save draft</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.8}
            disabled={loading}
            onPress={() => void handleSave("published")}
            style={[
              styles.submitButton,
              !form.title.trim() && styles.submitIncomplete,
              loading && styles.actionDisabled,
            ]}
          >
            {loading ? (
              <ActivityIndicator color={colors.cream} size="small" />
            ) : (
              <Ionicons name="paper-plane-outline" size={18} color={colors.cream} />
            )}
            <Text style={styles.submitButtonText}>{loading ? "Saving..." : "Publish"}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.maroon },
  contentShell: { flex: 1, backgroundColor: colors.cream },
  header: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    zIndex: 2,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerCopy: { flex: 1, marginLeft: 12 },
  headerTitle: { color: colors.ink, fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  headerSubtitle: { color: colors.muted, fontSize: 11.5, marginTop: 2 },
  modeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 99,
    backgroundColor: colors.soft,
  },
  modeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.gold },
  modeText: { color: colors.maroon, fontSize: 9, fontWeight: "900", letterSpacing: 0.9 },
  formContainer: { flex: 1 },
  formContent: { paddingHorizontal: 18, paddingTop: 24, paddingBottom: 30 },
  titleSection: { marginBottom: 28 },
  eyebrow: { color: colors.maroon, fontSize: 10, fontWeight: "900", letterSpacing: 1.5 },
  titleInput: {
    minHeight: 64,
    marginTop: 7,
    paddingHorizontal: 0,
    color: colors.ink,
    fontSize: 25,
    fontWeight: "700",
    letterSpacing: -0.5,
    borderBottomWidth: 2,
    borderBottomColor: colors.border,
  },
  inputFocused: { borderColor: colors.maroon },
  inputError: { borderColor: colors.error },
  fieldHint: { color: colors.muted, fontSize: 12, marginTop: 8 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  errorText: { color: colors.error, fontSize: 12, fontWeight: "600" },
  sectionHeading: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  sectionHeadingSpaced: { marginTop: 28 },
  sectionIcon: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    borderRadius: 12,
    backgroundColor: colors.soft,
  },
  sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: "800" },
  sectionSubtitle: { color: colors.muted, fontSize: 11.5, marginTop: 2 },
  scheduleCard: {
    overflow: "hidden",
    borderRadius: 22,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.07,
    shadowRadius: 14,
    elevation: 3,
  },
  dateSelector: { minHeight: 94, flexDirection: "row", alignItems: "center", padding: 16 },
  dateTile: {
    width: 58,
    height: 66,
    overflow: "hidden",
    alignItems: "center",
    borderRadius: 15,
    backgroundColor: colors.cream,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dateTileHeader: { alignSelf: "stretch", alignItems: "center", paddingVertical: 4, backgroundColor: colors.maroon },
  dateMonth: { color: colors.cream, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  dateDay: { color: colors.ink, fontSize: 25, lineHeight: 39, fontWeight: "900" },
  dateCopy: { flex: 1, marginLeft: 14 },
  dateWeekday: { color: colors.ink, fontSize: 17, fontWeight: "800" },
  dateLong: { color: colors.muted, fontSize: 13, marginTop: 3 },
  dateHint: { color: colors.maroon, fontSize: 10.5, fontWeight: "700", marginTop: 5 },
  divider: { height: 1, marginHorizontal: 16, backgroundColor: colors.border },
  timeline: { flexDirection: "row", padding: 16 },
  timelineRail: { width: 20, alignItems: "center", paddingVertical: 16 },
  timelineDotActive: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.maroon, borderWidth: 2, borderColor: colors.gold },
  timelineLine: { flex: 1, width: 1.5, marginVertical: 4, backgroundColor: colors.border },
  timelineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.maroon },
  timelineBody: { flex: 1, marginLeft: 8 },
  timeRow: { minHeight: 60, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  timeCopy: { flex: 1, marginRight: 8 },
  timeLabel: { color: colors.maroon, fontSize: 9, fontWeight: "900", letterSpacing: 1.2 },
  timeDate: { color: colors.muted, fontSize: 11.5, marginTop: 4 },
  timeButton: {
    minWidth: 116,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: 11,
    borderRadius: 12,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  timeButtonText: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  timePlaceholder: { color: colors.muted, fontWeight: "500" },
  timelineGap: { height: 24, justifyContent: "center" },
  timelineGapText: { alignSelf: "flex-start", paddingHorizontal: 7, paddingVertical: 3, borderRadius: 99, overflow: "hidden", backgroundColor: colors.cream, color: colors.muted, fontSize: 9, fontWeight: "800", letterSpacing: 0.6 },
  categoryContainer: { gap: 8, paddingRight: 18 },
  categoryButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 15,
    borderRadius: 99,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  selectedCategoryButton: { backgroundColor: colors.maroon, borderColor: colors.maroon },
  categoryButtonText: { color: colors.maroon, fontSize: 12, fontWeight: "800", letterSpacing: 0.3 },
  selectedCategoryButtonText: { color: colors.cream },
  descriptionInput: {
    minHeight: 124,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.ink,
    fontSize: 15,
    lineHeight: 22,
  },
  notifyCard: {
    minHeight: 78,
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  notifyIcon: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: colors.soft },
  notifyCopy: { flex: 1, marginHorizontal: 12 },
  notifyTitle: { color: colors.ink, fontSize: 14, fontWeight: "800" },
  notifyText: { color: colors.muted, fontSize: 11.5, lineHeight: 16, marginTop: 3 },
  previewHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 30, marginBottom: 10 },
  previewState: { color: colors.muted, fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  previewCard: { minHeight: 92, flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 18, backgroundColor: colors.maroon, borderLeftWidth: 4, borderLeftColor: colors.gold },
  previewDate: { width: 52, height: 60, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: "rgba(250,244,236,0.12)", borderWidth: 1, borderColor: "rgba(250,244,236,0.18)" },
  previewMonth: { color: colors.gold, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  previewDay: { color: colors.cream, fontSize: 22, fontWeight: "900", marginTop: 1 },
  previewCopy: { flex: 1, marginLeft: 13 },
  previewTitle: { color: colors.cream, fontSize: 15, lineHeight: 20, fontWeight: "800" },
  previewPlaceholder: { color: "rgba(250,244,236,0.62)", fontStyle: "italic" },
  previewMetaRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 7 },
  previewMeta: { flex: 1, color: "#dcc4b8", fontSize: 11.5 },
  actionBar: {
    flexDirection: "row",
    gap: 9,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: Platform.OS === "android" ? 14 : 10,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 7,
  },
  secondaryAction: { flex: 0.9, minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 15, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryActionText: { color: colors.maroon, fontSize: 14, fontWeight: "800" },
  submitButton: { flex: 1.1, minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 15, backgroundColor: colors.maroon, shadowColor: colors.maroon, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8, elevation: 3 },
  submitIncomplete: { opacity: 0.62 },
  actionDisabled: { opacity: 0.55 },
  submitButtonText: { color: colors.cream, fontSize: 16, fontWeight: "800" },
});

export default CreateEventScreen;
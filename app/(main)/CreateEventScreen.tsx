import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { addDoc, collection, doc, getDoc, getDocs, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
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

import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { useNetworkStatus } from "@/utils/networkUtils";
import { createBroadcastEventNotifications } from "@/utils/notifications";
import { sendBroadcastEventPushNotifications } from "@/utils/pushNotifications";
import { getUserData } from "@/utils/rbac";
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
  /**
   * The main event this one belongs to — "Intramurals" for a "Basketball
   * Finals" part. Null or missing means a standalone event. Only one level
   * deep: a part can never itself be a parent.
   */
  parentEventId?: string | null;
};

type Category = CalendarEvent["category"];

const palette = (c: ThemeTokens) =>
  ({
    /** The screen's maroon ground — a bar, so it follows `chrome`. */
    shell: c.chrome,
    /** The identity red, as ink and as a filled button. */
    maroon: c.primary,
    /** Anything drawn on top of that button. */
    onDark: c.onPrimary,
    gold: c.accent,
    cream: c.background,
    surface: c.surfaceRaised,
    soft: c.surfaceSunken,
    ink: c.textPrimary,
    muted: c.textMuted,
    border: c.border,
    error: c.danger,
  }) as const;

const categoryLabels: Record<Category, string> = {
  morning: "MORNING",
  afternoon: "AFTERNOON",
  evening: "EVENING",
  "all-day": "ALL DAY",
};

// The colour each time-of-day shows as on the calendar.
const CATEGORY_COLORS: Record<Category, string> = {
  morning: "#ff9f43",
  afternoon: "#4f9cff",
  evening: "#9b59b6",
  "all-day": "#e0a53d",
};

/**
 * Morning/afternoon/evening is a fact about the start time, so it is worked
 * out rather than picked. One less field, and no way for the label and the
 * clock to disagree.
 */
const deriveCategory = (allDay: boolean, startTime?: string): Category => {
  if (allDay) return "all-day";
  const hour = Number(String(startTime || "").split(":")[0]);
  if (!Number.isFinite(hour)) return "morning";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
};

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

// A plain label above each field. A six-field form does not need an icon tile
// and a subtitle per section — that chrome was most of what made this screen
// hard to read.
const SectionHeading = ({
  title,
  spaced = false,
}: {
  title: string;
  spaced?: boolean;
}) => {
  const { styles } = useStyles();

  return (
    <Text style={[styles.fieldLabel, spaced && styles.fieldLabelSpaced]}>{title}</Text>
  );
};

// Start and end sit side by side: they are a pair, and stacking them made the
// two read as a sequence instead of a range.
const TimeCard = ({
  label,
  value,
  empty,
  required,
  onPress,
}: {
  label: string;
  value: string;
  empty: boolean;
  required?: boolean;
  onPress: () => void;
}) => {
  const { styles, colors } = useStyles();

  return (
    <TouchableOpacity
      accessibilityHint={`Opens the ${label.toLowerCase()} time picker`}
      accessibilityLabel={`${label} time, ${value}`}
      accessibilityRole="button"
      activeOpacity={0.72}
      onPress={onPress}
      style={styles.timeCard}
    >
      <Text style={styles.timeCardLabel}>
        {label}
        {required ? " · required" : ""}
      </Text>
      <View style={styles.timeCardValueRow}>
        <Ionicons name="time-outline" size={15} color={colors.maroon} />
        <Text
          numberOfLines={1}
          style={[styles.timeCardValue, empty && styles.timeCardPlaceholder]}
        >
          {value}
        </Text>
      </View>
    </TouchableOpacity>
  );
};

const CreateEventScreen = () => {
  const { styles, colors } = useStyles();
  const router = useRouter();
  const { isOffline } = useNetworkStatus();
  const { eventId, parentId } = useLocalSearchParams<{
    eventId?: string | string[];
    parentId?: string | string[];
  }>();
  const editingEventId = Array.isArray(eventId) ? eventId[0] : eventId;
  // Set when "Add a part" is tapped on a main event, so the link is pre-filled.
  const presetParentId = Array.isArray(parentId) ? parentId[0] : parentId;
  const savingRef = useRef(false);
  // Live, so a role change lands here too — a demoted account is turned away
  // even if it had this form open.
  const currentUserRole = useCurrentUserRole();
  const [form, setForm] = useState<CalendarEvent>({
    title: "",
    description: "",
    date: toLocalDateString(new Date()),
    category: "morning",
    notifyUsers: false,
    parentEventId: presetParentId || null,
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);
  const [titleFocused, setTitleFocused] = useState(false);
  const [detailsFocused, setDetailsFocused] = useState(false);
  const [parentOptions, setParentOptions] = useState<
    { id: string; title: string; date: string; status?: string }[]
  >([]);
  const [parentPickerVisible, setParentPickerVisible] = useState(false);
  const [parentSearch, setParentSearch] = useState("");
  const [isAllDay, setIsAllDay] = useState(false);

  const selectedParent = useMemo(
    () => parentOptions.find((option) => option.id === form.parentEventId) || null,
    [parentOptions, form.parentEventId],
  );

  const filteredParents = useMemo(() => {
    const needle = parentSearch.trim().toLowerCase();
    if (!needle) return parentOptions;
    return parentOptions.filter((option) =>
      option.title.toLowerCase().includes(needle),
    );
  }, [parentOptions, parentSearch]);

  const derivedCategory = useMemo(
    () => deriveCategory(isAllDay, form.startTime),
    [isAllDay, form.startTime],
  );

  // Main events this one could belong to. Fetched once rather than subscribed:
  // the list is short and a live listener would only churn a form.
  useEffect(() => {
    const loadParents = async () => {
      try {
        const snapshot = await getDocs(
          query(collection(db, "events"), where("status", "in", ["published", "draft"])),
        );
        setParentOptions(
          snapshot.docs
            .map((eventDoc) => ({ id: eventDoc.id, ...(eventDoc.data() as any) }))
            // Only a top-level event can be a parent, and an event can never be
            // its own parent. One level of nesting keeps the calendar simple.
            .filter((option) => !option.parentEventId && option.id !== editingEventId)
            .sort((first, second) => String(first.date).localeCompare(String(second.date)))
            .map((option) => ({
              id: option.id,
              title: String(option.title || "Untitled"),
              date: String(option.date || ""),
              status: option.status,
            })),
        );
      } catch (error) {
        console.warn("[CreateEvent] Could not load main events:", error);
      }
    };
    void loadParents();
  }, [editingEventId]);

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
            parentEventId: event.parentEventId || null,
          });
          setIsAllDay(event.category === "all-day");
        }
      } catch (error) {
        console.error("Error loading event:", error);
        Alert.alert("Error", "Could not load this event for editing.");
      }
    };
    void loadEvent();
  }, [editingEventId]);

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

    const partOfId = String(form.parentEventId || "");
    // A part is a session, and a session has a clock. Without both times the
    // whole day counts as its window, so it would read as happening now from
    // midnight to midnight — useless for "which game is on right now".
    if (partOfId && (!form.startTime || !form.endTime)) {
      Alert.alert(
        "Start and end time needed",
        "A part needs both times so students can see what is happening right now.",
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    // A published part under an unpublished main event would appear on the
    // calendar with nothing to belong to.
    if (partOfId && status === "published") {
      const parent = parentOptions.find((option) => option.id === partOfId);
      if (parent?.status === "draft") {
        Alert.alert(
          "Publish the main event first",
          `"${parent.title}" is still a draft, so this part would appear on its own with no context.`,
        );
        return;
      }
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
        // Derived from the start time rather than picked separately.
        category: derivedCategory,
        // Normalised to null so "standalone" is one value everywhere, never a
        // mix of null, undefined and "".
        parentEventId: partOfId || null,
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

  // The role is resolved asynchronously. Rendering null while it is still
  // undefined showed authorized staff a blank screen for a beat, so wait on a
  // spinner and only decide who may be here once the role is actually known.
  if (currentUserRole === undefined) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={[styles.contentShell, styles.roleLoading]}>
          <ActivityIndicator size="large" color={colors.maroon} />
        </View>
      </SafeAreaView>
    );
  }

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
        </View>

        <ScrollView
          contentContainerStyle={styles.formContent}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.formContainer}
        >
          <View style={styles.titleSection}>
            <SectionHeading title="Event name" />
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

          <SectionHeading title="Schedule" spaced />
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
              style={styles.dateRow}
            >
              <View style={styles.rowIcon}>
                <Ionicons name="calendar" size={18} color={colors.maroon} />
              </View>
              <Text style={styles.dateRowValue} numberOfLines={1}>
                {dateDisplay.weekday}, {dateDisplay.long}
              </Text>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </TouchableOpacity>

            {showDatePicker && (
              <DateTimePicker
                value={selectedDate}
                mode="date"
                display="default"
                onChange={handleDateChange}
              />
            )}

            {!isAllDay && (
              <>
                <View style={styles.divider} />
                <View style={styles.timePairRow}>
                  <TimeCard
                    label="Starts"
                    value={formatTime(form.startTime)}
                    empty={!form.startTime}
                    required={!!form.parentEventId}
                    onPress={() => setShowStartTimePicker(true)}
                  />
                  <TimeCard
                    label="Ends"
                    value={formatTime(form.endTime)}
                    empty={!form.endTime}
                    required={!!form.parentEventId}
                    onPress={() => setShowEndTimePicker(true)}
                  />
                </View>
              </>
            )}

            <View style={styles.divider} />
            <View style={styles.allDayRow}>
              <View style={styles.allDayCopy}>
                <Text style={styles.allDayTitle}>All day</Text>
                <Text style={styles.allDayHint}>
                  {form.parentEventId
                    ? "A part always needs a start and end time"
                    : "No start or end time"}
                </Text>
              </View>
              <Switch
                accessibilityLabel="All day event"
                disabled={!!form.parentEventId}
                ios_backgroundColor={colors.border}
                onValueChange={(value) => {
                  setIsAllDay(value);
                  void Haptics.selectionAsync();
                }}
                thumbColor={colors.onDark}
                trackColor={{ false: colors.border, true: colors.maroon }}
                value={isAllDay}
              />
            </View>

            {/* The time of day is derived from the start time, so there is no
                separate category to pick and no way for the two to disagree. */}
            <View style={styles.derivedRow}>
              <View
                style={[
                  styles.derivedDot,
                  { backgroundColor: CATEGORY_COLORS[derivedCategory] },
                ]}
              />
              <Text style={styles.derivedText} numberOfLines={1}>
                Shows as {categoryLabels[derivedCategory].toLowerCase()} on the calendar
              </Text>
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

          <SectionHeading title="Part of a bigger event?" spaced />
          {/* A row that opens a searchable list. The old horizontal chips meant
              scrolling sideways through every event to find one. */}
          <TouchableOpacity
            accessibilityLabel={
              selectedParent ? `Part of ${selectedParent.title}` : "Standalone event"
            }
            accessibilityRole="button"
            activeOpacity={0.75}
            onPress={() => {
              setParentSearch("");
              setParentPickerVisible(true);
            }}
            style={styles.pickerRow}
          >
            <View
              style={[
                styles.rowIcon,
                !!selectedParent && { backgroundColor: "#efe3f5" },
              ]}
            >
              <Ionicons
                name={selectedParent ? "albums" : "calendar-outline"}
                size={18}
                color={selectedParent ? "#7b3fa0" : colors.maroon}
              />
            </View>
            <View style={styles.pickerRowCopy}>
              <Text style={styles.pickerRowValue} numberOfLines={1}>
                {selectedParent ? selectedParent.title : "Standalone event"}
              </Text>
              <Text style={styles.pickerRowHint} numberOfLines={1}>
                {selectedParent
                  ? "Tap to change or remove"
                  : "Not part of a bigger event"}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </TouchableOpacity>

          <SectionHeading title="Details (optional)" spaced />
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

          <SectionHeading title="Publishing" spaced />
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
              thumbColor={colors.onDark}
              trackColor={{ false: colors.border, true: colors.maroon }}
              value={Boolean(form.notifyUsers)}
            />
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
              <ActivityIndicator color={colors.onDark} size="small" />
            ) : (
              <Ionicons name="paper-plane-outline" size={18} color={colors.onDark} />
            )}
            <Text style={styles.submitButtonText}>{loading ? "Saving..." : "Publish"}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <Modal
        visible={parentPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setParentPickerVisible(false)}
      >
        <View style={styles.pickerBackdrop}>
          <View style={styles.pickerSheet}>
            <View style={styles.pickerHandle} />
            <Text style={styles.pickerTitle}>Part of a bigger event?</Text>

            <View style={styles.pickerSearch}>
              <Ionicons name="search" size={17} color={colors.muted} />
              <TextInput
                accessibilityLabel="Search main events"
                autoCorrect={false}
                onChangeText={setParentSearch}
                placeholder="Search events"
                placeholderTextColor="#a68d85"
                style={styles.pickerSearchInput}
                value={parentSearch}
              />
              {!!parentSearch && (
                <TouchableOpacity
                  accessibilityLabel="Clear search"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => setParentSearch("")}
                >
                  <Ionicons name="close-circle" size={18} color={colors.muted} />
                </TouchableOpacity>
              )}
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={styles.pickerList}
            >
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: !form.parentEventId }}
                activeOpacity={0.75}
                onPress={() => {
                  handleInputChange("parentEventId", "");
                  setParentPickerVisible(false);
                  void Haptics.selectionAsync();
                }}
                style={styles.pickerOption}
              >
                <Ionicons name="calendar-outline" size={18} color={colors.maroon} />
                <Text style={styles.pickerOptionText}>Standalone event</Text>
                {!form.parentEventId && (
                  <Ionicons name="checkmark-circle" size={20} color={colors.maroon} />
                )}
              </TouchableOpacity>

              {filteredParents.map((option) => {
                const selected = form.parentEventId === option.id;
                return (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    activeOpacity={0.75}
                    key={option.id}
                    onPress={() => {
                      handleInputChange("parentEventId", option.id);
                      setParentPickerVisible(false);
                      void Haptics.selectionAsync();
                    }}
                    style={styles.pickerOption}
                  >
                    <Ionicons name="albums-outline" size={18} color="#7b3fa0" />
                    <View style={styles.pickerOptionCopy}>
                      <Text style={styles.pickerOptionText} numberOfLines={1}>
                        {option.title}
                      </Text>
                      <Text style={styles.pickerOptionMeta} numberOfLines={1}>
                        {option.date}
                        {option.status === "draft" ? " · draft" : ""}
                      </Text>
                    </View>
                    {selected && (
                      <Ionicons name="checkmark-circle" size={20} color={colors.maroon} />
                    )}
                  </TouchableOpacity>
                );
              })}

              {filteredParents.length === 0 && (
                <Text style={styles.pickerEmpty}>
                  {parentSearch
                    ? `No events match "${parentSearch}"`
                    : "No other events yet."}
                </Text>
              )}
            </ScrollView>

            <TouchableOpacity
              accessibilityRole="button"
              activeOpacity={0.8}
              onPress={() => setParentPickerVisible(false)}
              style={styles.pickerClose}
            >
              <Text style={styles.pickerCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
};

const makeStyles = (t: ThemeTokens) => {
  const c = palette(t);
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.shell },
  fieldLabel: {
    color: c.ink,
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 8,
  },
  fieldLabelSpaced: { marginTop: 26 },
  rowIcon: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: c.soft,
  },
  dateRow: {
    minHeight: 66,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
  },
  dateRowValue: { flex: 1, color: c.ink, fontSize: 16, fontWeight: "700" },
  timePairRow: { flexDirection: "row", gap: 10, padding: 14 },
  timeCard: {
    flex: 1,
    minHeight: 68,
    justifyContent: "center",
    paddingHorizontal: 13,
    borderRadius: 14,
    backgroundColor: c.cream,
    borderWidth: 1,
    borderColor: c.border,
  },
  timeCardLabel: {
    color: c.maroon,
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 5,
  },
  timeCardValueRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  timeCardValue: { flex: 1, color: c.ink, fontSize: 16, fontWeight: "700" },
  timeCardPlaceholder: { color: c.muted, fontWeight: "500" },
  allDayRow: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
  },
  allDayCopy: { flex: 1, minWidth: 0 },
  allDayTitle: { color: c.ink, fontSize: 15, fontWeight: "700" },
  allDayHint: { color: c.muted, fontSize: 13, marginTop: 2 },
  derivedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  derivedDot: { width: 9, height: 9, borderRadius: 5 },
  derivedText: { flex: 1, color: c.muted, fontSize: 13 },
  pickerRow: {
    minHeight: 70,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  pickerRowCopy: { flex: 1, minWidth: 0 },
  pickerRowValue: { color: c.ink, fontSize: 16, fontWeight: "700" },
  pickerRowHint: { color: c.muted, fontSize: 13, marginTop: 2 },
  pickerBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(22, 4, 3, 0.55)",
  },
  pickerSheet: {
    maxHeight: "82%",
    paddingTop: 10,
    paddingHorizontal: 18,
    paddingBottom: 18,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: c.surface,
  },
  pickerHandle: {
    alignSelf: "center",
    width: 42,
    height: 4,
    borderRadius: 2,
    marginBottom: 14,
    backgroundColor: c.border,
  },
  pickerTitle: {
    color: c.ink,
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 12,
  },
  pickerSearch: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 48,
    paddingHorizontal: 13,
    borderRadius: 14,
    backgroundColor: c.cream,
    borderWidth: 1,
    borderColor: c.border,
  },
  pickerSearchInput: { flex: 1, color: c.ink, fontSize: 15 },
  pickerList: { marginTop: 12 },
  pickerOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 58,
    paddingHorizontal: 13,
    marginBottom: 8,
    borderRadius: 14,
    backgroundColor: c.cream,
    borderWidth: 1,
    borderColor: c.border,
  },
  pickerOptionCopy: { flex: 1, minWidth: 0 },
  pickerOptionText: { flex: 1, color: c.ink, fontSize: 15, fontWeight: "700" },
  pickerOptionMeta: { color: c.muted, fontSize: 13, marginTop: 2 },
  pickerEmpty: {
    color: c.muted,
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 26,
  },
  pickerClose: {
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
    borderRadius: 14,
    backgroundColor: c.soft,
  },
  pickerCloseText: { color: c.maroon, fontSize: 15, fontWeight: "800" },
  contentShell: { flex: 1, backgroundColor: c.cream },
  roleLoading: { alignItems: "center", justifyContent: "center" },
  header: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: c.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
    shadowColor: c.ink,
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
    backgroundColor: c.soft,
    borderWidth: 1,
    borderColor: c.border,
  },
  headerCopy: { flex: 1, marginLeft: 12 },
  headerTitle: { color: c.ink, fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  headerSubtitle: { color: c.muted, fontSize: 13, marginTop: 2 },
  formContainer: { flex: 1 },
  formContent: { paddingHorizontal: 18, paddingTop: 24, paddingBottom: 30 },
  titleSection: { marginBottom: 28 },
  titleInput: {
    minHeight: 64,
    marginTop: 7,
    paddingHorizontal: 0,
    color: c.ink,
    fontSize: 25,
    fontWeight: "700",
    letterSpacing: -0.5,
    borderBottomWidth: 2,
    borderBottomColor: c.border,
  },
  inputFocused: { borderColor: c.maroon },
  inputError: { borderColor: c.error },
  fieldHint: { color: c.muted, fontSize: 12, marginTop: 8 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  errorText: { color: c.error, fontSize: 12, fontWeight: "600" },
  scheduleCard: {
    overflow: "hidden",
    borderRadius: 22,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: c.ink,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.07,
    shadowRadius: 14,
    elevation: 3,
  },
  divider: { height: 1, marginHorizontal: 16, backgroundColor: c.border },
  descriptionInput: {
    minHeight: 124,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 18,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    color: c.ink,
    fontSize: 15,
    lineHeight: 22,
  },
  notifyCard: {
    minHeight: 78,
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 18,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  notifyIcon: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: c.soft },
  notifyCopy: { flex: 1, marginHorizontal: 12 },
  notifyTitle: { color: c.ink, fontSize: 14, fontWeight: "800" },
  notifyText: { color: c.muted, fontSize: 13, lineHeight: 16, marginTop: 3 },
  actionBar: {
    flexDirection: "row",
    gap: 9,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: Platform.OS === "android" ? 14 : 10,
    backgroundColor: c.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    shadowColor: c.ink,
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 7,
  },
  secondaryAction: { flex: 0.9, minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 15, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  secondaryActionText: { color: c.maroon, fontSize: 14, fontWeight: "800" },
  submitButton: { flex: 1.1, minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 15, backgroundColor: c.maroon, shadowColor: c.maroon, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8, elevation: 3 },
  submitIncomplete: { opacity: 0.62 },
  actionDisabled: { opacity: 0.55 },
  submitButtonText: { color: c.onDark, fontSize: 16, fontWeight: "800" },
});
};

export default CreateEventScreen;
/** Themed stylesheet and palette for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const colors = useMemo(() => palette(theme), [theme]);
  return useMemo(() => ({ styles, colors }), [styles, colors]);
};

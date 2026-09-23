import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { addDoc, collection, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, updateDoc, where, writeBatch } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Keyboard,
    Modal,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
// The keyboard library's own view. It follows the keyboard frame by frame;
// React Native's built-in one stopped lifting anything on Android once
// KeyboardProvider (app/_layout.tsx) took over the keyboard.
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import ConfirmDialog from "./components/ConfirmDialog";

import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { useNetworkStatus } from "@/utils/networkUtils";
import { audienceLabel, normalizeAudience } from "@/utils/eventAudience";
import { createBroadcastEventNotifications, listEventRecipientIds } from "@/utils/notifications";
import { showAppToast } from "@/utils/toastEvents";
import { sendBroadcastEventPushNotifications } from "@/utils/pushNotifications";
import { getUserData } from "@/utils/rbac";
import { auth, db } from "../../Firebase_configure";
import { getEventTimingWindow } from "@/utils/eventTiming";

type CalendarEvent = {
  title: string;
  subEvent?: string;
  subEvents?: string[];
  description?: string;
  date: string;
  endDate?: string;
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
  /** Where it happens — what keeps two 1:00 PM games apart. */
  venue?: string;
  /**
   * Which programs this is for. Empty means the whole campus. Only a main
   * event carries it; its parts follow whatever their main event says.
   */
  forPrograms?: string[];
};

type Category = CalendarEvent["category"];

/** A main event this one can belong to, for the "Part of" picker. */
type MainEventOption = {
  id: string;
  title: string;
  date: string;
  endDate: string;
  forPrograms: string[];
};

/** Programs are managed in AdminManageProgramsScreen; a student's `course`
 *  holds the program name, so that is what an audience is written in. */
/** A program, and its short code from Manage Programs ("BSIS"), if it has one. */
type ProgramOption = { id: string; name: string; code?: string };

/**
 * One line of the program builder — a timed part of this event, written here
 * and saved as its own event document with parentEventId pointing back. The
 * whole program is typed in this form, so a five-day Siglakas is one pass
 * instead of sixteen trips through the calendar.
 */
type ProgramRow = {
  /** Local list key. */
  key: string;
  /** The event document, once it exists. Missing means it is new. */
  id?: string;
  title: string;
  venue: string;
  date: string;
  startTime: string;
  endTime: string;
};

let nextProgramKey = 0;
const newProgramRow = (date: string, startTime = "", endTime = ""): ProgramRow => ({
  key: `row-${nextProgramKey++}`,
  title: "",
  venue: "",
  date,
  startTime,
  endTime,
});

const palette = (c: ThemeTokens) =>
  ({
    /** The screen's maroon ground — a bar, so it follows `chrome`. */
    shell: c.chrome,
    /** The identity red, as ink and as a filled button. */
    maroon: c.primary,
    /** Anything drawn on top of that button. */
    onDark: c.onPrimary,
    onChrome: c.onChrome,
    onChromeMuted: c.onChromeMuted,
    chromeBorder: c.chromeBorder,
    gold: c.accent,
    cream: c.background,
    surface: c.surfaceRaised,
    soft: c.surfaceSunken,
    ink: c.textPrimary,
    muted: c.textMuted,
    border: c.border,
    error: c.danger,
  }) as const;

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
    <Text style={[styles.fieldLabel, spaced && styles.fieldLabelSpaced, spaced && styles.sectionLabel]}>{title}</Text>
  );
};

// The same time control is used for start and end to keep the schedule clear.
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
  const { eventId, parentEventId: parentEventIdParam, date: dateParam } = useLocalSearchParams<{
    eventId?: string | string[];
    parentEventId?: string | string[];
    date?: string | string[];
  }>();
  const editingEventId = Array.isArray(eventId) ? eventId[0] : eventId;
  // "+ Add part" on a main event opens this form with the parent and its day
  // already filled in, so a program is typed in one pass.
  const presetParentId = (Array.isArray(parentEventIdParam) ? parentEventIdParam[0] : parentEventIdParam) || "";
  const presetDate = (Array.isArray(dateParam) ? dateParam[0] : dateParam) || "";
  const savingRef = useRef(false);
  const formScrollRef = useRef<ScrollView>(null);
  const titleInputRef = useRef<TextInput>(null);
  const detailsInputRef = useRef<TextInput>(null);
  const focusedInputRef = useRef<TextInput | null>(null);
  const scrollOffsetRef = useRef(0);
  const keyboardTopRef = useRef<number | null>(null);
  // Live, so a role change lands here too — a demoted account is turned away
  // even if it had this form open.
  const currentUserRole = useCurrentUserRole();
  const [form, setForm] = useState<CalendarEvent>({
    title: "",
    description: "",
    date: presetDate || toLocalDateString(new Date()),
    endDate: presetDate || toLocalDateString(new Date()),
    category: "morning",
    notifyUsers: false,
    parentEventId: presetParentId || null,
    venue: "",
    forPrograms: [],
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showEndDatePicker, setShowEndDatePicker] = useState(false);
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);
  const [titleFocused, setTitleFocused] = useState(false);
  const [detailsFocused, setDetailsFocused] = useState(false);
  const [subEventFields, setSubEventFields] = useState([{ id: 0, value: "" }]);
  const [endDateCustomized, setEndDateCustomized] = useState(false);
  const [isAllDay, setIsAllDay] = useState(false);
  const [venueFocused, setVenueFocused] = useState(false);
  const [mainEvents, setMainEvents] = useState<MainEventOption[]>([]);
  const [programs, setPrograms] = useState<ProgramOption[]>([]);
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [programRows, setProgramRows] = useState<ProgramRow[]>([]);
  const [removedPartIds, setRemovedPartIds] = useState<string[]>([]);
  const [programTimePicker, setProgramTimePicker] = useState<
    { key: string; field: "startTime" | "endTime" } | null
  >(null);
  const [focusedProgramKey, setFocusedProgramKey] = useState<string | null>(null);

  // Everything this form has to say goes through the app's own dialog. It used
  // to use Alert.alert, which draws the phone's grey system box.
  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm?: () => void;
    onDismiss?: () => void;
  } | null>(null);
  const showMessage = (title: string, description?: string, onConfirm?: () => void) => {
    setDialog({ title, description, onConfirm });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  };
  /** Two ways forward, both of them fine — used for "tell everyone?". */
  const showChoice = (options: {
    title: string;
    description: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onDismiss: () => void;
  }) => setDialog(options);

  // What the event looked like when this form opened, so a save can tell a
  // typo from a change people need to hear about.
  const [original, setOriginal] = useState<{
    status: string;
    date: string;
    endDate: string;
    startTime: string;
    endTime: string;
    venue: string;
  } | null>(null);
  // An event that already has parts of its own can never become a part: the
  // program is one level deep, so nobody has to dig for a schedule.
  const [hasOwnParts, setHasOwnParts] = useState(false);

  const keepFocusedInputVisible = useCallback(() => {
    requestAnimationFrame(() => {
      focusedInputRef.current?.measureInWindow((_x, fieldY, _width, fieldHeight) => {
        formScrollRef.current?.getNativeScrollRef()?.measureInWindow((_scrollX, scrollY, _scrollWidth, scrollHeight) => {
          const visibleBottom = Math.min(scrollY + scrollHeight, keyboardTopRef.current ?? Infinity) - 20;
          const overlap = fieldY + fieldHeight - visibleBottom;
          if (overlap > 0) {
            formScrollRef.current?.scrollTo({ y: scrollOffsetRef.current + overlap + 12, animated: true });
          } else if (fieldY < scrollY + 8) {
            formScrollRef.current?.scrollTo({ y: Math.max(0, scrollOffsetRef.current - (scrollY + 20 - fieldY)), animated: true });
          }
        });
      });
    });
  }, []);

  useEffect(() => {
    const onShow = Keyboard.addListener("keyboardDidShow", (event) => {
      keyboardTopRef.current = event.endCoordinates.screenY;
      setTimeout(keepFocusedInputVisible, 80);
    });
    const onFrameChange = Keyboard.addListener("keyboardDidChangeFrame", (event) => {
      keyboardTopRef.current = event.endCoordinates.screenY;
      keepFocusedInputVisible();
    });
    const onHide = Keyboard.addListener("keyboardDidHide", () => {
      keyboardTopRef.current = null;
    });
    return () => { onShow.remove(); onFrameChange.remove(); onHide.remove(); };
  }, [keepFocusedInputVisible]);

  const derivedCategory = useMemo(
    () => deriveCategory(isAllDay, form.startTime),
    [isAllDay, form.startTime],
  );

  useEffect(() => {
    if (!editingEventId) return;
    const loadEvent = async () => {
      try {
        const snapshot = await getDoc(doc(db, "events", editingEventId));
        if (snapshot.exists()) {
          const event = snapshot.data() as CalendarEvent;
          const legacyWindow = getEventTimingWindow(event);
          const legacyEndDate = !event.endDate && event.startTime && event.endTime &&
            event.endTime <= event.startTime && legacyWindow
            ? toLocalDateString(new Date(legacyWindow.endMs))
            : event.date;
          setForm({
            title: event.title || "",
            description: event.description || "",
            date: event.date || toLocalDateString(new Date()),
            endDate: event.endDate || legacyEndDate || toLocalDateString(new Date()),
            startTime: event.startTime,
            endTime: event.endTime,
            category: event.category || "morning",
            notifyUsers: event.notifyUsers || false,
            status: event.status,
            parentEventId: event.parentEventId || null,
            venue: event.venue || "",
            forPrograms: normalizeAudience(event.forPrograms),
          });
          setOriginal({
            status: String(event.status || "published"),
            date: event.date || "",
            endDate: event.endDate || event.date || "",
            startTime: event.startTime || "",
            endTime: event.endTime || "",
            venue: event.venue || "",
          });
          const loadedSubEvents = Array.isArray(event.subEvents) && event.subEvents.length
            ? event.subEvents
            : event.subEvent ? [event.subEvent] : [""];
          setSubEventFields(loadedSubEvents.map((value, id) => ({ id, value })));
          setEndDateCustomized(Boolean((event.endDate || legacyEndDate) && (event.endDate || legacyEndDate) !== event.date));
          setIsAllDay(event.category === "all-day");
        }
      } catch (error) {
        console.error("Error loading event:", error);
        showMessage(
          "Couldn't open this event",
          "Check your connection and try again.",
        );
      }
    };
    void loadEvent();
  }, [editingEventId]);

  // Main events to choose from, and the programs an audience is written in.
  // Read once when the form opens: both lists are short and neither changes
  // while someone is typing.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [eventDocs, programDocs] = await Promise.all([
          getDocs(query(collection(db, "events"), orderBy("date", "desc"), limit(120))),
          getDocs(query(collection(db, "programs"), orderBy("name", "asc"))),
        ]);
        if (cancelled) return;
        setMainEvents(
          eventDocs.docs
            .map((item) => ({ id: item.id, ...(item.data() as CalendarEvent) }))
            .filter((event) => !event.parentEventId && String(event.status || "published") !== "archived")
            .map((event) => ({
              id: event.id,
              title: event.title || "Untitled event",
              date: event.date || "",
              endDate: event.endDate || event.date || "",
              forPrograms: normalizeAudience(event.forPrograms),
            })),
        );
        setPrograms(
          programDocs.docs.map((item) => {
            const data = item.data() as { name?: string; code?: string };
            return {
              id: item.id,
              name: String(data.name || "").trim(),
              code: String(data.code || "").trim() || undefined,
            };
          }).filter((program) => program.name),
        );
      } catch (error) {
        console.error("Error loading main events or programs:", error);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  // The parts this event already has, loaded into the builder so an edit can
  // change a time, rename a part or drop one without leaving the form.
  useEffect(() => {
    if (!editingEventId) return;
    let cancelled = false;
    getDocs(query(collection(db, "events"), where("parentEventId", "==", editingEventId)))
      .then((snapshot) => {
        if (cancelled) return;
        setHasOwnParts(!snapshot.empty);
        setProgramRows(
          snapshot.docs
            .map((item) => {
              const data = item.data() as CalendarEvent;
              return {
                key: `row-${nextProgramKey++}`,
                id: item.id,
                title: data.title || "",
                venue: data.venue || "",
                date: data.date || "",
                startTime: data.startTime || "",
                endTime: data.endTime || "",
              };
            })
            .sort((first, second) =>
              first.date === second.date
                ? first.startTime.localeCompare(second.startTime)
                : first.date.localeCompare(second.date),
            ),
        );
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [editingEventId]);

  // The chosen main event may be older than the list above, or may have been
  // handed straight to this form by "Add part". Either way its name and dates
  // have to be here, or the picker would read "Not part of anything" while
  // the form says otherwise.
  useEffect(() => {
    const parentId = form.parentEventId;
    if (!parentId || mainEvents.some((event) => event.id === parentId)) return;
    let cancelled = false;
    getDoc(doc(db, "events", parentId))
      .then((snapshot) => {
        if (cancelled || !snapshot.exists()) return;
        const data = snapshot.data() as CalendarEvent;
        setMainEvents((current) =>
          current.some((event) => event.id === parentId)
            ? current
            : [
                {
                  id: parentId,
                  title: data.title || "Untitled event",
                  date: data.date || "",
                  endDate: data.endDate || data.date || "",
                  forPrograms: normalizeAudience(data.forPrograms),
                },
                ...current,
              ],
        );
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [form.parentEventId, mainEvents]);

  // Editing something that already exists, or a part being added from the
  // calendar: both need to see and change which event they belong to. A blank
  // new event does not.
  const showParentField = Boolean(editingEventId || presetParentId);
  const alreadyPublished = Boolean(editingEventId && (original?.status || "") === "published");

  const selectedParent = useMemo(
    () => mainEvents.find((event) => event.id === form.parentEventId) || null,
    [mainEvents, form.parentEventId],
  );

  /** A part follows its main event's audience, so it is only set in one place. */
  const effectiveAudience = useMemo(
    () => (form.parentEventId ? selectedParent?.forPrograms || [] : normalizeAudience(form.forPrograms)),
    [form.parentEventId, form.forPrograms, selectedParent],
  );

  /** Every day this event covers, for the day chips on each part. */
  const eventDays = useMemo(() => {
    const days: string[] = [];
    const start = parseDate(form.date);
    const end = parseDate(form.endDate || form.date);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [form.date];
    for (let day = new Date(start); day <= end && days.length < 31; day.setDate(day.getDate() + 1)) {
      days.push(toLocalDateString(day));
    }
    return days.length ? days : [form.date];
  }, [form.date, form.endDate]);

  const updateProgramRow = (key: string, changes: Partial<ProgramRow>) => {
    setProgramRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...changes } : row)));
  };

  const addProgramRow = () => {
    setProgramRows((rows) => {
      const last = rows[rows.length - 1];
      // The next part usually starts where the last one ended, on the same day.
      return [...rows, newProgramRow(last?.date || form.date, last?.endTime || "", "")];
    });
    void Haptics.selectionAsync();
  };

  const removeProgramRow = (key: string) => {
    setProgramRows((rows) => {
      const row = rows.find((item) => item.key === key);
      if (row?.id) setRemovedPartIds((ids) => (ids.includes(row.id!) ? ids : [...ids, row.id!]));
      return rows.filter((item) => item.key !== key);
    });
    void Haptics.selectionAsync();
  };

  // A row is only saved once it has a name and both times; a blank row left at
  // the bottom is just an unused line, not an error.
  /** Names from the old text list, shown read-only when an event has them. */
  const legacySubEvents = useMemo(
    () => subEventFields.map((field) => field.value.trim()).filter(Boolean),
    [subEventFields],
  );

  const filledProgramRows = useMemo(
    () => programRows.filter((row) => row.title.trim() && row.startTime && row.endTime),
    [programRows],
  );

  // "Who is this for?": the chosen programs are shown by their short codes,
  // and picked in a sheet with search — fourteen full program names as
  // chips made a wall of pills.
  const [programSheetOpen, setProgramSheetOpen] = useState(false);
  const [programSearch, setProgramSearch] = useState("");
  const programCodeByName = useMemo(
    () => new Map(programs.map((program) => [program.name, program.code || program.name])),
    [programs],
  );
  const visiblePrograms = useMemo(() => {
    const term = programSearch.trim().toLowerCase();
    if (!term) return programs;
    return programs.filter(
      (program) =>
        program.name.toLowerCase().includes(term) ||
        (program.code || "").toLowerCase().includes(term),
    );
  }, [programSearch, programs]);
  const openProgramSheet = () => {
    Keyboard.dismiss();
    setProgramSearch("");
    setProgramSheetOpen(true);
  };

  const toggleProgram = (name: string) => {
    setForm((previous) => {
      const current = normalizeAudience(previous.forPrograms);
      const next = current.includes(name)
        ? current.filter((program) => program !== name)
        : [...current, name];
      return { ...previous, forPrograms: next };
    });
    void Haptics.selectionAsync();
  };

  const canManageEvents = useCallback(
    () => ["moderator", "teacher", "admin"].includes(currentUserRole || ""),
    [currentUserRole],
  );

  const selectedDate = useMemo(() => parseDate(form.date), [form.date]);
  const selectedEndDate = useMemo(() => parseDate(form.endDate || form.date), [form.endDate, form.date]);
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
      const date = toLocalDateString(selected);
      setForm((previous) => ({ ...previous, date, endDate: endDateCustomized ? previous.endDate : date }));
      void Haptics.selectionAsync();
    }
  };

  const handleEndDateChange = (_event: unknown, selected?: Date) => {
    setShowEndDatePicker(false);
    if (selected) {
      const endDate = toLocalDateString(selected);
      setEndDateCustomized(endDate !== form.date);
      setForm((previous) => ({ ...previous, endDate }));
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

  /**
   * The notice this save should send, or null for silence.
   *
   * Only four things matter to somebody deciding whether to turn up: the day,
   * the time, the place, and whether it is still on. Fixing a typo at
   * midnight must never buzz the campus; moving the parade to Saturday must.
   */
  const describeChange = () => {
    if (!original) return null;
    const title = form.title.trim();
    const dateChanged =
      original.date !== form.date ||
      original.endDate !== (form.endDate || form.date);
    const timeChanged =
      original.startTime !== (form.startTime || "") ||
      original.endTime !== (form.endTime || "");
    const venue = (form.venue || "").trim();
    const venueChanged = original.venue.trim() !== venue;
    if (!dateChanged && !timeChanged && !venueChanged) return null;

    const day = parseDate(form.date).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const clock = form.startTime ? ` · ${formatTime(form.startTime)}` : "";

    if (dateChanged) {
      return {
        headline: `${title} moved`,
        message: `moved this event to ${day}${clock}`,
        preview: `${title} moved to ${day}${clock}`,
      };
    }
    if (timeChanged) {
      const span = form.startTime && form.endTime
        ? `${formatTime(form.startTime)} – ${formatTime(form.endTime)}`
        : "a new time";
      return {
        headline: `${title} — new time`,
        message: `changed the time to ${span}`,
        preview: `${title} now runs ${span} on ${day}`,
      };
    }
    return {
      headline: `${title} — new venue`,
      message: `moved this event to ${venue}`,
      preview: `${title} is now at ${venue}`,
    };
  };

  const handleSave = async (status: "published" | "draft") => {
    if (savingRef.current) return;
    setTitleTouched(true);

    if (!form.title.trim()) {
      showMessage("Title needed", "Give this event a name before saving it.");
      return;
    }
    if (!auth.currentUser) {
      showMessage("Sign in needed", "Sign in again to create an event.");
      return;
    }

    if (status === "published" && !isAllDay && (!form.startTime || !form.endTime)) {
      showMessage("Schedule needed", "Choose a start time and an end time.");
      return;
    }
    const schedule = getEventTimingWindow({ ...form, category: derivedCategory }, false);
    if (status === "published" && (!schedule || schedule.endMs <= schedule.startMs)) {
      showMessage("Check the schedule", "The end must come after the start.");
      return;
    }
    // A part outside its main event's dates would sit alone in the calendar,
    // away from the program it belongs to.
    if (form.parentEventId && selectedParent) {
      const parentStart = selectedParent.date;
      const parentEnd = selectedParent.endDate || selectedParent.date;
      const partStart = form.date;
      const partEnd = form.endDate || form.date;
      if (parentStart && parentEnd && (partStart < parentStart || partEnd > parentEnd)) {
        showMessage(
          "Outside the main event",
          `${selectedParent.title} runs ${parentStart} to ${parentEnd}. Move this part inside those dates, or extend the main event first.`,
        );
        return;
      }
    }
    // A half-typed part is the easiest way to lose one, so it is named here
    // rather than dropped quietly at save time.
    const startedRow = programRows.find(
      (row) => (row.title.trim() || row.startTime || row.endTime) &&
        !(row.title.trim() && row.startTime && row.endTime),
    );
    if (startedRow) {
      showMessage(
        "Finish this part",
        `"${startedRow.title.trim() || "Untitled part"}" needs a name, a start time and an end time — or remove it.`,
      );
      return;
    }
    const backwardsRow = filledProgramRows.find((row) => row.endTime <= row.startTime);
    if (backwardsRow) {
      showMessage(
        "Check the times",
        `"${backwardsRow.title.trim()}" ends before it starts.`,
      );
      return;
    }
    const strayRow = filledProgramRows.find((row) => !eventDays.includes(row.date));
    if (strayRow) {
      showMessage(
        "Outside the event's days",
        `"${strayRow.title.trim()}" falls outside ${form.date} to ${form.endDate || form.date}. Move it, or change the event's dates first.`,
      );
      return;
    }

    if (form.parentEventId && hasOwnParts) {
      showMessage(
        "This event already has parts",
        "An event with its own parts can't also be part of another one. Remove its parts first.",
      );
      return;
    }
    // Firestore has no offline persistence here, so a "saved" event would be
    // lost without ever reaching the server.
    if (isOffline) {
      showAppToast({ message: "You're offline — events can't be saved right now." });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }

    // A first publish announces the event, if the switch is on. A later edit
    // says nothing unless the day, time or place moved — and then it asks,
    // showing the exact words it would send.
    const firstPublish = !editingEventId || (original?.status || "published") !== "published";
    if (status === "published" && !firstPublish) {
      const change = describeChange();
      if (change) {
        showChoice({
          title: "Tell everyone what changed?",
          description: `"${change.preview}"\n\nThis goes to everyone this event is for.`,
          confirmText: "Send notice",
          cancelText: "Don't send",
          onConfirm: () => void performSave(status, change),
          onDismiss: () => void performSave(status, null),
        });
        return;
      }
      await performSave(status, null);
      return;
    }

    await performSave(
      status,
      status === "published" && form.notifyUsers
        ? {
            headline: `New event: ${form.title.trim()}`,
            message: "scheduled a new event",
            preview: "",
          }
        : null,
    );
  };

  const performSave = async (
    status: "published" | "draft",
    notice: { headline: string; message: string; preview: string } | null,
  ) => {
    if (savingRef.current || !auth.currentUser) return;
    savingRef.current = true;
    setLoading(true);
    Keyboard.dismiss();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const subEvents = subEventFields.map((field) => field.value.trim()).filter(Boolean);
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
      // Captured here: inside the batch callbacks below TypeScript can no
      // longer see that the sign-in check above already ran.
      const authorUid = auth.currentUser.uid;

      // An edit writes only the form fields. Authorship stays with whoever
      // created the event: reassigning createdBy to the editor would hand the
      // event to a different owner and lock the original author out of it,
      // because canEditEvent() keys off createdBy. createdAt is likewise only
      // ever written once, at creation.
      const eventData = {
        ...form,
        title: form.title.trim(),
        venue: (form.venue || "").trim(),
        // Only a main event carries an audience; a part follows its parent, so
        // there is never a second copy to keep in step.
        forPrograms: form.parentEventId ? [] : normalizeAudience(form.forPrograms),
        subEvent: subEvents[0] || "",
        subEvents,
        description: form.description?.trim() || "",
        startTime: isAllDay ? "" : form.startTime || "",
        endTime: isAllDay ? "" : form.endTime || "",
        endDate: form.endDate || form.date,
        status,
        // Derived from the start time rather than picked separately.
        category: derivedCategory,
        // Normalised to null so "standalone" is one value everywhere, never a
        // mix of null, undefined and "".
        parentEventId: form.parentEventId || null,
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

      // The program, in one batch: new parts created, existing ones updated,
      // removed ones deleted. A part follows its main event's status and
      // audience, so publishing the event publishes its whole program.
      if (!form.parentEventId && (filledProgramRows.length > 0 || removedPartIds.length > 0)) {
        const batch = writeBatch(db);
        filledProgramRows.forEach((row) => {
          const partData = {
            title: row.title.trim(),
            description: "",
            date: row.date,
            endDate: row.date,
            startTime: row.startTime,
            endTime: row.endTime,
            category: deriveCategory(false, row.startTime),
            venue: row.venue.trim(),
            status,
            parentEventId: createdEventRef.id,
            forPrograms: [],
            notifyUsers: false,
            subEvent: "",
            subEvents: [],
          };
          if (row.id) {
            batch.update(doc(db, "events", row.id), partData);
          } else {
            batch.set(doc(collection(db, "events")), {
              ...partData,
              createdBy: authorUid,
              createdByName: authorName,
              createdAt: serverTimestamp(),
            });
          }
        });
        removedPartIds.forEach((partId) => batch.delete(doc(db, "events", partId)));
        await batch.commit();
        setRemovedPartIds([]);
      }

      const partNote = filledProgramRows.length
        ? ` with ${filledProgramRows.length} ${filledProgramRows.length === 1 ? "part" : "parts"}`
        : "";
      let successMessage =
        status === "draft"
          ? `Event saved as a draft${partNote}.`
          : editingEventId
            ? `Event updated${partNote}.`
            : `Event created${partNote}.`;

      if (status === "published" && notice) {
        // Read the student list once, honour the audience, and hand the same
        // recipients to both senders: a BSIT-only event never reaches BSED.
        const recipientIds = await listEventRecipientIds({
          forPrograms: effectiveAudience,
          excludeUserIds: [auth.currentUser.uid],
        });
        const results = await Promise.allSettled([
          createBroadcastEventNotifications({
            actor: {
              id: auth.currentUser.uid,
              name: actorName,
              profileImage: currentUserData?.profileImage || null,
            },
            entityId: createdEventRef.id,
            title: eventData.title,
            description: form.description,
            eventDate: form.date,
            recipientIds,
            message: notice.message,
          }),
          sendBroadcastEventPushNotifications({
            entityId: createdEventRef.id,
            title: eventData.title,
            description: form.description,
            eventDate: form.date,
            excludeUserIds: [auth.currentUser.uid],
            onlyUserIds: recipientIds,
            headline: notice.headline,
          }),
        ]);
        const failures = results.filter((result) => result.status === "rejected");
        failures.forEach((result) => {
          if (result.status === "rejected") {
            console.error("Event notification delivery error:", result.reason);
          }
        });
        if (failures.length) {
          successMessage = "Saved, but some notifications could not be delivered.";
        }
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showAppToast({ message: successMessage.replace(/\.$/, "") });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (error) {
      console.error("Error creating event:", error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showMessage(
        editingEventId ? "Couldn't save your changes" : "Couldn't create the event",
        "Check your connection and try again.",
      );
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

  // Staff only. Refused on screen in the app's own dialog rather than by a
  // system box fired from an effect.
  if (!canManageEvents()) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <ConfirmDialog
          visible
          variant="warning"
          title="Only staff can create events"
          description="Ask an administrator if you need to add something to the campus calendar."
          confirmText="Go back"
          singleAction
          onConfirm={() => router.back()}
          onCancel={() => router.back()}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <KeyboardAvoidingView automaticOffset
        behavior="padding"
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
            <Ionicons name="arrow-back" size={21} color={colors.onChrome} />
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.headerEyebrow}>CAMPUS CALENDAR</Text>
            <Text style={styles.headerTitle}>{editingEventId ? "Edit Event" : "Create Event"}</Text>
            <Text style={styles.headerSubtitle}>{editingEventId ? "Update the plan for your community" : "Bring the campus together"}</Text>
          </View>
        </View>

        <ScrollView
          ref={formScrollRef}
          contentContainerStyle={styles.formContent}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onScroll={(event) => { scrollOffsetRef.current = event.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          style={styles.formContainer}
        >
          <View style={styles.formIntro}>
            <View style={styles.formIntroIcon}><Ionicons name="sparkles-outline" size={19} color={colors.maroon} /></View>
            <View style={styles.formIntroCopy}>
              <Text style={styles.formIntroTitle}>Start with the essentials</Text>
              <Text style={styles.formIntroText}>Give your event a name, then set when it happens.</Text>
            </View>
          </View>
          <View style={styles.titleSection}>
            <Text style={styles.cardEyebrow}>01  EVENT INFORMATION</Text>
            <SectionHeading title="Main Event Title" />
            <TextInput
              ref={titleInputRef}
              accessibilityLabel="Event title, required"
              onBlur={() => {
                if (focusedInputRef.current === titleInputRef.current) focusedInputRef.current = null;
                setTitleFocused(false);
                setTitleTouched(true);
              }}
              onChangeText={(value) => handleInputChange("title", value)}
              onFocus={() => {
                focusedInputRef.current = titleInputRef.current;
                setTitleFocused(true);
                setTimeout(keepFocusedInputVisible, 80);
              }}
              onSubmitEditing={() => Keyboard.dismiss()}
              placeholder="Enter event title"
              placeholderTextColor={colors.muted}
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
            {/* The old names-only list. It is kept for events that already
                have one — the timed program below replaced it. */}
            {legacySubEvents.length > 0 && (
              <>
                <Text style={styles.optionalFieldLabel}>Sub event names (old list)</Text>
                <Text style={styles.legacySubEvents}>{legacySubEvents.join(" · ")}</Text>
                <Text style={styles.fieldHint}>
                  Names only, with no times. Add them to the program below to
                  give each one its own times and Ongoing badge.
                </Text>
              </>
            )}
          </View>

          <SectionHeading title="02  PLACE & AUDIENCE" spaced />
          <View style={styles.scheduleCard}>
            <Text style={styles.scheduleSectionLabel}>Venue</Text>
            <TextInput
              accessibilityLabel="Venue, optional"
              onBlur={() => setVenueFocused(false)}
              onChangeText={(value) => handleInputChange("venue", value)}
              onFocus={() => setVenueFocused(true)}
              placeholder="Covered court, Room 204, Chapel…"
              placeholderTextColor={colors.muted}
              style={[styles.venueInput, venueFocused && styles.inputFocused]}
              value={form.venue || ""}
            />
            <Text style={styles.endDateHint}>
              Optional, but it is what tells two events at the same hour apart.
            </Text>

            {/* Only where it can be acted on. A new event builds its program
                downwards, in section 04 — asking "part of what?" here as well
                is the same question pointing the other way. */}
            {showParentField && (
              <>
                <View style={styles.divider} />
                <Text style={styles.scheduleSectionLabel}>Part of a main event</Text>
                {form.parentEventId || presetParentId ? (
                  <>
                    <TouchableOpacity
                      accessibilityHint="Choose the main event this belongs to"
                      accessibilityLabel={`Part of ${selectedParent ? selectedParent.title : "nothing"}`}
                      accessibilityRole="button"
                      activeOpacity={0.75}
                      disabled={hasOwnParts}
                      onPress={() => { Keyboard.dismiss(); setParentPickerOpen(true); }}
                      style={[styles.dateRow, hasOwnParts && styles.rowDisabled]}
                    >
                      <View style={styles.rowIcon}>
                        <Ionicons name="albums-outline" size={18} color={colors.maroon} />
                      </View>
                      <Text style={styles.dateRowValue} numberOfLines={1}>
                        {selectedParent ? selectedParent.title : "Not part of anything"}
                      </Text>
                      <Ionicons name="chevron-forward" size={20} color={colors.muted} />
                    </TouchableOpacity>
                    <Text style={styles.endDateHint}>
                      {hasOwnParts
                        ? "This event has parts of its own, so it stays a main event."
                        : selectedParent
                          ? `It shows in ${selectedParent.title}'s program, with its own Ongoing badge.`
                          : "Not part of anything — it stands on its own."}
                    </Text>
                  </>
                ) : (
                  <TouchableOpacity
                    accessibilityRole="button"
                    activeOpacity={0.75}
                    disabled={hasOwnParts}
                    onPress={() => { Keyboard.dismiss(); setParentPickerOpen(true); }}
                    style={[styles.parentLink, hasOwnParts && styles.rowDisabled]}
                  >
                    <Ionicons name="albums-outline" size={16} color={colors.maroon} />
                    <Text style={styles.parentLinkText}>
                      {hasOwnParts
                        ? "Has parts of its own — it stays a main event"
                        : "Move this into another event's program"}
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            )}

            <View style={styles.divider} />
            <Text style={styles.scheduleSectionLabel}>Who is this for?</Text>
            {form.parentEventId ? (
              <Text style={styles.inheritNote}>
                Follows {selectedParent ? selectedParent.title : "the main event"} ·{" "}
                {audienceLabel(effectiveAudience)}
              </Text>
            ) : (
              <>
                <View style={styles.audienceSwitch} accessibilityRole="radiogroup">
                  {(
                    [
                      { key: "campus", label: "Whole campus", icon: "business-outline" },
                      { key: "programs", label: "Specific programs", icon: "school-outline" },
                    ] as const
                  ).map((option) => {
                    const on =
                      option.key === "campus"
                        ? effectiveAudience.length === 0
                        : effectiveAudience.length > 0;
                    return (
                      <TouchableOpacity
                        key={option.key}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        activeOpacity={0.82}
                        onPress={() => {
                          if (option.key === "campus") {
                            setForm((previous) => ({ ...previous, forPrograms: [] }));
                          } else {
                            openProgramSheet();
                          }
                        }}
                        style={[styles.audienceOption, on && styles.audienceOptionOn]}
                      >
                        <Ionicons name={option.icon} size={15} color={on ? colors.onDark : colors.muted} />
                        <Text style={[styles.audienceOptionText, on && styles.audienceOptionTextOn]}>
                          {option.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {effectiveAudience.length > 0 && (
                  <>
                    <TouchableOpacity
                      accessibilityHint="Opens the list of programs"
                      accessibilityRole="button"
                      activeOpacity={0.82}
                      onPress={openProgramSheet}
                      style={styles.programChooser}
                    >
                      <Ionicons name="school-outline" size={18} color={colors.maroon} />
                      <Text style={styles.programChooserText}>
                        Choose programs · {effectiveAudience.length} selected
                      </Text>
                      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
                    </TouchableOpacity>
                    <View style={styles.programCodeRow}>
                      {effectiveAudience.map((name) => (
                        <TouchableOpacity
                          key={name}
                          accessibilityLabel={`Remove ${name}`}
                          accessibilityRole="button"
                          activeOpacity={0.82}
                          onPress={() => toggleProgram(name)}
                          style={styles.programCodeChip}
                        >
                          <Text style={styles.programCodeText}>{programCodeByName.get(name) || name}</Text>
                          <Ionicons name="close" size={13} color={colors.onDark} />
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}
                <Text style={styles.endDateHint}>
                  {effectiveAudience.length > 0
                    ? "It shows first for these programs, and only their students are notified. Nothing is hidden from anyone else."
                    : "Everyone on campus sees it the same way."}
                </Text>
              </>
            )}
          </View>

          <SectionHeading title="03  SCHEDULE" spaced />
          <View style={styles.scheduleCard}>
            <Text style={styles.scheduleSectionLabel}>Starts</Text>
            <TouchableOpacity
              accessibilityHint="Opens the date picker"
              accessibilityLabel={`Date, ${dateDisplay.weekday}, ${dateDisplay.long}`}
              accessibilityRole="button"
              activeOpacity={0.75}
              onPress={() => {
                Keyboard.dismiss();
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
                  <TimeCard
                    label="Start"
                    value={formatTime(form.startTime)}
                    empty={!form.startTime}
                    required
                    onPress={() => { Keyboard.dismiss(); setShowStartTimePicker(true); }}
                  />
              </>
            )}

            <View style={styles.divider} />
            <Text style={styles.scheduleSectionLabel}>Ends</Text>
            <Text style={styles.endDateHint}>End date is optional. Same day as start unless changed.</Text>
            <TouchableOpacity
              accessibilityLabel={`End date, ${endDateCustomized ? selectedEndDate.toLocaleDateString("en-US", { dateStyle: "long" }) : "same as start date"}`}
              accessibilityRole="button"
              activeOpacity={0.75}
              onPress={() => { Keyboard.dismiss(); setShowEndDatePicker(true); void Haptics.selectionAsync(); }}
              style={styles.dateRow}
            >
              <View style={styles.rowIcon}><Ionicons name="calendar" size={18} color={colors.maroon} /></View>
              <Text style={styles.dateRowValue} numberOfLines={1}>
                {endDateCustomized
                  ? selectedEndDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
                  : "Same day as start"}
              </Text>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </TouchableOpacity>
            {showEndDatePicker && (
              <DateTimePicker value={selectedEndDate} mode="date" display="default" onChange={handleEndDateChange} />
            )}
            {endDateCustomized && (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => { setEndDateCustomized(false); setForm((previous) => ({ ...previous, endDate: previous.date })); }}
                style={styles.sameDayButton}
              >
                <Text style={styles.sameDayText}>Use start date instead</Text>
              </TouchableOpacity>
            )}
            {!isAllDay && (
              <>
                <View style={styles.divider} />
                <TimeCard label="End" value={formatTime(form.endTime)} empty={!form.endTime} required onPress={() => { Keyboard.dismiss(); setShowEndTimePicker(true); }} />
              </>
            )}
            <View style={styles.divider} />
            <View style={styles.allDayRow}>
              <View style={styles.allDayCopy}>
                <Text style={styles.allDayTitle}>All day</Text>
                <Text style={styles.allDayHint}>Runs from the start date through the end date</Text>
              </View>
              <Switch
                accessibilityLabel="All day event"
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
            {programTimePicker && (
              <DateTimePicker
                value={(() => {
                  const row = programRows.find((item) => item.key === programTimePicker.key);
                  const value = row?.[programTimePicker.field];
                  return value ? new Date(`2000-01-01T${value}`) : new Date();
                })()}
                mode="time"
                display="default"
                onChange={(_pickerEvent, selected) => {
                  const target = programTimePicker;
                  setProgramTimePicker(null);
                  if (!selected || !target) return;
                  const value = `${String(selected.getHours()).padStart(2, "0")}:${String(
                    selected.getMinutes(),
                  ).padStart(2, "0")}`;
                  updateProgramRow(target.key, { [target.field]: value });
                  void Haptics.selectionAsync();
                }}
              />
            )}
          </View>

          {/* The program. Typed here in one pass, saved as one part per row.
              An event that is itself a part never gets one: the program is a
              single level deep. */}
          {!form.parentEventId && (
            <>
              <SectionHeading title="04  PROGRAM" spaced />
              <View style={styles.scheduleCard}>
                <View style={styles.programHeadRow}>
                  <Text style={styles.scheduleSectionLabel}>Parts (optional)</Text>
                  <Text style={styles.programCount}>
                    {filledProgramRows.length}{" "}
                    {filledProgramRows.length === 1 ? "part" : "parts"}
                    {eventDays.length > 1 ? ` · ${eventDays.length} days` : ""}
                  </Text>
                </View>
                <Text style={styles.endDateHint}>
                  Each part gets its own times, venue and Ongoing badge — the
                  parade, the mass, the opening. They are saved with this event.
                </Text>

                {programRows.map((row, index) => (
                  <View key={row.key} style={styles.programRow}>
                    <View style={styles.programRowHead}>
                      <Text style={styles.programRowNumber}>Part {index + 1}</Text>
                      <TouchableOpacity
                        accessibilityLabel={`Remove part ${index + 1}`}
                        accessibilityRole="button"
                        hitSlop={8}
                        onPress={() => removeProgramRow(row.key)}
                      >
                        <Ionicons name="close" size={18} color={colors.muted} />
                      </TouchableOpacity>
                    </View>

                    <TextInput
                      accessibilityLabel={`Part ${index + 1} name`}
                      onBlur={() => setFocusedProgramKey(null)}
                      onChangeText={(value) => updateProgramRow(row.key, { title: value })}
                      onFocus={() => setFocusedProgramKey(`${row.key}-title`)}
                      placeholder="Holy Mass"
                      placeholderTextColor={colors.muted}
                      style={[
                        styles.programInput,
                        focusedProgramKey === `${row.key}-title` && styles.inputFocused,
                      ]}
                      value={row.title}
                    />
                    <TextInput
                      accessibilityLabel={`Part ${index + 1} venue`}
                      onBlur={() => setFocusedProgramKey(null)}
                      onChangeText={(value) => updateProgramRow(row.key, { venue: value })}
                      onFocus={() => setFocusedProgramKey(`${row.key}-venue`)}
                      placeholder="Venue — Chapel, Covered court…"
                      placeholderTextColor={colors.muted}
                      style={[
                        styles.programInput,
                        focusedProgramKey === `${row.key}-venue` && styles.inputFocused,
                      ]}
                      value={row.venue}
                    />

                    {eventDays.length > 1 && (
                      <View style={styles.chipsRow}>
                        {eventDays.map((day, dayIndex) => {
                          const selected = row.date === day;
                          return (
                            <TouchableOpacity
                              key={day}
                              accessibilityRole="button"
                              accessibilityState={{ selected }}
                              activeOpacity={0.82}
                              onPress={() => updateProgramRow(row.key, { date: day })}
                              style={[styles.dayChip, selected && styles.dayChipOn]}
                            >
                              <Text style={[styles.dayChipText, selected && styles.dayChipTextOn]}>
                                Day {dayIndex + 1}
                              </Text>
                              <Text style={[styles.dayChipMeta, selected && styles.dayChipTextOn]}>
                                {parseDate(day).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}

                    <View style={styles.programTimes}>
                      <TouchableOpacity
                        accessibilityLabel={`Part ${index + 1} start time`}
                        accessibilityRole="button"
                        activeOpacity={0.78}
                        onPress={() => {
                          Keyboard.dismiss();
                          setProgramTimePicker({ key: row.key, field: "startTime" });
                        }}
                        style={styles.programTimeButton}
                      >
                        <Ionicons name="time-outline" size={15} color={colors.maroon} />
                        <Text style={[styles.programTimeText, !row.startTime && styles.programTimeEmpty]}>
                          {row.startTime ? formatTime(row.startTime) : "Start"}
                        </Text>
                      </TouchableOpacity>
                      <Text style={styles.programTimeDash}>–</Text>
                      <TouchableOpacity
                        accessibilityLabel={`Part ${index + 1} end time`}
                        accessibilityRole="button"
                        activeOpacity={0.78}
                        onPress={() => {
                          Keyboard.dismiss();
                          setProgramTimePicker({ key: row.key, field: "endTime" });
                        }}
                        style={styles.programTimeButton}
                      >
                        <Ionicons name="time-outline" size={15} color={colors.maroon} />
                        <Text style={[styles.programTimeText, !row.endTime && styles.programTimeEmpty]}>
                          {row.endTime ? formatTime(row.endTime) : "End"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}

                <TouchableOpacity
                  accessibilityLabel="Add another part"
                  accessibilityRole="button"
                  activeOpacity={0.82}
                  onPress={addProgramRow}
                  style={styles.addPartRowButton}
                >
                  <Ionicons name="add-circle-outline" size={18} color={colors.maroon} />
                  <Text style={styles.addSubEventText}>
                    {programRows.length ? "Add another part" : "Add a part"}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          <SectionHeading title="05  NOTIFICATIONS" spaced />
          {alreadyPublished ? (
            <View style={styles.notifyCard}>
              <View style={styles.notifyIcon}>
                <Ionicons name="megaphone-outline" size={20} color={colors.maroon} />
              </View>
              <View style={styles.notifyCopy}>
                <Text style={styles.notifyTitle}>Already announced</Text>
                <Text style={styles.notifyText}>
                  Saving won&apos;t notify anyone again. If you move the day, the
                  time or the venue, you&apos;ll be asked whether to send a notice.
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.notifyCard}>
              <View style={styles.notifyIcon}>
                <Ionicons name="megaphone-outline" size={20} color={colors.maroon} />
              </View>
              <View style={styles.notifyCopy}>
                <Text style={styles.notifyTitle}>Notify</Text>
                <Text style={styles.notifyText}>
                  Tells {audienceLabel(effectiveAudience).toLowerCase() === "whole campus"
                    ? "everyone"
                    : effectiveAudience.join(" and ")} when this event is published.
                </Text>
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
          )}

          <SectionHeading title="06  DETAILS" spaced />
          <Text style={[styles.optionalFieldLabel, styles.detailsFieldLabel]}>Details (Optional)</Text>
          <TextInput
            ref={detailsInputRef}
            accessibilityLabel="Event description"
            multiline
            numberOfLines={5}
            onBlur={() => { if (focusedInputRef.current === detailsInputRef.current) focusedInputRef.current = null; setDetailsFocused(false); }}
            onChangeText={(value) => handleInputChange("description", value)}
            onContentSizeChange={keepFocusedInputVisible}
            onFocus={() => { focusedInputRef.current = detailsInputRef.current; setDetailsFocused(true); setTimeout(keepFocusedInputVisible, 120); }}
            onSelectionChange={keepFocusedInputVisible}
            placeholder="Enter event description (optional)"
            placeholderTextColor={colors.muted}
            style={[styles.descriptionInput, detailsFocused && styles.inputFocused]}
            textAlignVertical="top"
            value={form.description}
          />


          <View style={styles.actionBar}>
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
            <Text style={styles.submitButtonText}>{loading ? "Saving..." : editingEventId ? "Update Event" : "Create Event"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.74}
            disabled={loading}
            onPress={() => void handleSave("draft")}
            style={[styles.secondaryAction, loading && styles.actionDisabled]}
          >
            <Ionicons name="bookmark-outline" size={19} color={colors.maroon} />
            <Text style={styles.secondaryActionText}>Save as draft</Text>
          </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Which main event this belongs to. One level deep: only events that
          are not themselves parts can be chosen. */}
      {/* Choose programs: search, select all or none, one row per program
          with its code first. Changes apply as they're tapped. */}
      <Modal
        visible={programSheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setProgramSheetOpen(false)}
      >
        <KeyboardAvoidingView automaticOffset behavior="padding" style={styles.sheetBackdrop}>
          <TouchableOpacity
            accessible={false}
            activeOpacity={1}
            onPress={() => setProgramSheetOpen(false)}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.programSheet}>
            <View style={styles.programSheetHead}>
              <Text style={styles.programSheetTitle}>Choose programs</Text>
              <TouchableOpacity
                accessibilityLabel="Close"
                accessibilityRole="button"
                hitSlop={10}
                onPress={() => setProgramSheetOpen(false)}
              >
                <Ionicons name="close" size={24} color={colors.muted} />
              </TouchableOpacity>
            </View>

            <View style={styles.programSearch}>
              <Ionicons name="search" size={16} color={colors.muted} />
              <TextInput
                accessibilityLabel="Search programs"
                autoCorrect={false}
                onChangeText={setProgramSearch}
                placeholder="Search by name or code"
                placeholderTextColor={colors.muted}
                style={styles.programSearchInput}
                value={programSearch}
              />
            </View>

            <View style={styles.programSheetActions}>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setForm((previous) => ({ ...previous, forPrograms: programs.map((program) => program.name) }))}
              >
                <Text style={styles.programSheetAction}>Select all</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setForm((previous) => ({ ...previous, forPrograms: [] }))}
              >
                <Text style={styles.programSheetAction}>Clear</Text>
              </TouchableOpacity>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" style={styles.programSheetList}>
              {visiblePrograms.map((program) => {
                const selected = effectiveAudience.includes(program.name);
                return (
                  <TouchableOpacity
                    key={program.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    activeOpacity={0.82}
                    onPress={() => toggleProgram(program.name)}
                    style={styles.programOption}
                  >
                    <Ionicons
                      name={selected ? "checkbox" : "square-outline"}
                      size={24}
                      color={selected ? colors.maroon : colors.muted}
                    />
                    <View style={styles.programOptionCopy}>
                      <Text style={styles.programOptionCode}>{program.code || program.name}</Text>
                      {!!program.code && (
                        <Text style={styles.programOptionName}>{program.name}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
              {visiblePrograms.length === 0 && (
                <Text style={styles.programSheetEmpty}>
                  No program matches &ldquo;{programSearch.trim()}&rdquo;.
                </Text>
              )}
            </ScrollView>

            <TouchableOpacity
              accessibilityRole="button"
              activeOpacity={0.85}
              onPress={() => setProgramSheetOpen(false)}
              style={styles.programSheetDone}
            >
              <Text style={styles.programSheetDoneText}>
                {effectiveAudience.length > 0
                  ? `Done · ${effectiveAudience.length} selected`
                  : "Done · Whole campus"}
              </Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={parentPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setParentPickerOpen(false)}
      >
        <View style={styles.pickerOverlay}>
          <View style={styles.pickerCard}>
            <Text style={styles.pickerTitle}>Part of a main event</Text>
            <ScrollView style={styles.pickerList} keyboardShouldPersistTaps="handled">
              <TouchableOpacity
                accessibilityRole="button"
                activeOpacity={0.8}
                onPress={() => {
                  setForm((previous) => ({ ...previous, parentEventId: null }));
                  setParentPickerOpen(false);
                }}
                style={styles.pickerRow}
              >
                <Ionicons
                  name={form.parentEventId ? "radio-button-off" : "radio-button-on"}
                  size={19}
                  color={colors.maroon}
                />
                <View style={styles.pickerRowCopy}>
                  <Text style={styles.pickerRowText}>Not part of anything</Text>
                  <Text style={styles.pickerRowMeta}>A normal event, or a main event of its own</Text>
                </View>
              </TouchableOpacity>

              {mainEvents
                .filter((event) => event.id !== editingEventId)
                .map((event) => {
                  const selected = form.parentEventId === event.id;
                  return (
                    <TouchableOpacity
                      key={event.id}
                      accessibilityRole="button"
                      activeOpacity={0.8}
                      onPress={() => {
                        setForm((previous) => ({
                          ...previous,
                          parentEventId: event.id,
                          // Start inside the main event's dates, which is
                          // where a part has to sit anyway.
                          date: previous.date >= event.date && previous.date <= (event.endDate || event.date)
                            ? previous.date
                            : event.date,
                          endDate: previous.date >= event.date && previous.date <= (event.endDate || event.date)
                            ? previous.endDate
                            : event.date,
                        }));
                        setParentPickerOpen(false);
                        void Haptics.selectionAsync();
                      }}
                      style={styles.pickerRow}
                    >
                      <Ionicons
                        name={selected ? "radio-button-on" : "radio-button-off"}
                        size={19}
                        color={colors.maroon}
                      />
                      <View style={styles.pickerRowCopy}>
                        <Text style={styles.pickerRowText} numberOfLines={1}>{event.title}</Text>
                        <Text style={styles.pickerRowMeta} numberOfLines={1}>
                          {event.date}
                          {event.endDate && event.endDate !== event.date ? ` – ${event.endDate}` : ""}
                          {` · ${audienceLabel(event.forPrograms)}`}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}

              {mainEvents.length === 0 && (
                <Text style={styles.pickerEmpty}>
                  No main events yet. Create one first, then add its parts.
                </Text>
              )}
            </ScrollView>
            <TouchableOpacity
              accessibilityRole="button"
              activeOpacity={0.85}
              onPress={() => setParentPickerOpen(false)}
              style={styles.pickerClose}
            >
              <Text style={styles.pickerCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ConfirmDialog
        visible={!!dialog}
        variant={dialog?.cancelText ? "info" : "warning"}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmText={dialog?.confirmText ?? "OK"}
        cancelText={dialog?.cancelText}
        singleAction={!dialog?.cancelText}
        destructive={false}
        onConfirm={() => {
          const after = dialog?.onConfirm;
          setDialog(null);
          after?.();
        }}
        onCancel={() => {
          const after = dialog?.onDismiss;
          setDialog(null);
          after?.();
        }}
      />

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
  fieldLabelSpaced: { marginTop: 24, marginBottom: 12 },
  sectionLabel: { color: c.maroon, fontSize: 12, fontWeight: "900", letterSpacing: 1.2 },
  cardEyebrow: { color: c.maroon, fontSize: 11, fontWeight: "900", letterSpacing: 1.1, marginBottom: 20 },
  optionalFieldLabel: { color: c.ink, fontSize: 14, fontWeight: "700", marginTop: 22, marginBottom: 8 },
  venueInput: {
    minHeight: 52,
    paddingHorizontal: 15,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    color: c.ink,
    fontSize: 15,
    marginTop: 6,
  },
  rowDisabled: { opacity: 0.55 },
  parentLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingVertical: 10,
  },
  parentLinkText: { color: c.maroon, fontSize: 13, fontWeight: "700" },
  inheritNote: {
    color: c.ink,
    fontSize: 13,
    fontWeight: "700",
    backgroundColor: c.soft,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 6,
  },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  legacySubEvents: {
    color: c.ink,
    fontSize: 13,
    backgroundColor: c.soft,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  // The card brings no padding of its own; every piece inside keeps 15 from
  // its edges, as the label and hint already did.
  programHeadRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10 },
  programCount: { color: c.muted, fontSize: 12, fontWeight: "700", paddingRight: 16, flexShrink: 0 },
  programRow: {
    marginTop: 12,
    marginHorizontal: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.soft,
    gap: 8,
  },
  programRowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  programRowNumber: { color: c.maroon, fontSize: 11, fontWeight: "900", letterSpacing: 0.8 },
  programInput: {
    minHeight: 46,
    paddingHorizontal: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    color: c.ink,
    fontSize: 14,
  },
  dayChip: {
    borderRadius: 11,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    paddingHorizontal: 11,
    paddingVertical: 6,
    alignItems: "center",
  },
  dayChipOn: { backgroundColor: c.maroon, borderColor: c.maroon },
  dayChipText: { color: c.ink, fontSize: 12, fontWeight: "800" },
  dayChipMeta: { color: c.muted, fontSize: 10.5 },
  dayChipTextOn: { color: c.onDark },
  programTimes: { flexDirection: "row", alignItems: "center", gap: 8 },
  programTimeButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    paddingVertical: 11,
  },
  programTimeText: { color: c.ink, fontSize: 13, fontWeight: "700" },
  programTimeEmpty: { color: c.muted, fontWeight: "600" },
  programTimeDash: { color: c.muted, fontSize: 14 },
  addPartRowButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
    marginHorizontal: 12,
    marginBottom: 16,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: c.border,
  },
  // Who is this for: a two-way switch, then the chosen programs by code.
  audienceSwitch: {
    flexDirection: "row",
    gap: 6,
    marginHorizontal: 16,
    marginTop: 10,
    padding: 4,
    borderRadius: 14,
    backgroundColor: c.soft,
  },
  audienceOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 40,
    borderRadius: 11,
  },
  audienceOptionOn: { backgroundColor: c.maroon },
  audienceOptionText: { color: c.muted, fontSize: 13, fontWeight: "800" },
  audienceOptionTextOn: { color: c.onDark },
  programChooser: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 10,
    minHeight: 52,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  programChooserText: { flex: 1, color: c.ink, fontSize: 14, fontWeight: "700" },
  programCodeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginHorizontal: 16, marginTop: 10 },
  programCodeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    paddingLeft: 10,
    paddingRight: 8,
    paddingVertical: 5,
    backgroundColor: c.maroon,
  },
  programCodeText: { color: c.onDark, fontSize: 12, fontWeight: "800" },
  sheetBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  programSheet: {
    maxHeight: "85%",
    backgroundColor: c.cream,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 14,
  },
  programSheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  programSheetTitle: { color: c.ink, fontSize: 16, fontWeight: "900" },
  programSearch: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 46,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  programSearchInput: { flex: 1, color: c.ink, fontSize: 14, paddingVertical: 10 },
  programSheetActions: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 10 },
  programSheetAction: { color: c.maroon, fontSize: 13.5, fontWeight: "800" },
  programSheetList: { flexGrow: 0 },
  programOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  programOptionCopy: { flex: 1 },
  programOptionCode: { color: c.ink, fontSize: 14.5, fontWeight: "800" },
  programOptionName: { color: c.muted, fontSize: 12.5, marginTop: 1 },
  programSheetEmpty: { color: c.muted, fontSize: 13, textAlign: "center", paddingVertical: 24 },
  programSheetDone: {
    marginTop: 7,
    minHeight: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.maroon,
  },
  programSheetDoneText: { color: c.onDark, fontSize: 15, fontWeight: "800" },
  pickerOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 14,
  },
  pickerCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: c.cream,
    borderRadius: 20,
    padding: 14,
  },
  pickerTitle: { color: c.ink, fontSize: 16, fontWeight: "900", marginBottom: 10 },
  pickerList: { maxHeight: 340 },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  pickerRowCopy: { flex: 1 },
  pickerRowText: { color: c.ink, fontSize: 14, fontWeight: "700" },
  pickerRowMeta: { color: c.muted, fontSize: 11.5, marginTop: 2 },
  pickerEmpty: { color: c.muted, fontSize: 13, paddingVertical: 16, textAlign: "center" },
  pickerClose: {
    marginTop: 7,
    backgroundColor: c.maroon,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  pickerCloseText: { color: c.onDark, fontSize: 14, fontWeight: "900" },
  detailsFieldLabel: { marginTop: 0 },
  subEventInput: {
    flex: 1,
    minHeight: 52,
    paddingHorizontal: 15,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.cream,
    color: c.ink,
    fontSize: 16,
  },
  subEventRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 9 },
  removeSubEventButton: { width: 44, height: 48, alignItems: "center", justifyContent: "center" },
  addSubEventButton: { minHeight: 42, flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 7, marginTop: 2, paddingHorizontal: 4 },
  addSubEventText: { color: c.maroon, fontSize: 14, fontWeight: "700" },
  endDateHint: { color: c.muted, fontSize: 12, marginTop: 4, marginHorizontal: 16 },
  sameDayButton: { alignSelf: "flex-start", minHeight: 40, justifyContent: "center", marginLeft: 16 },
  sameDayText: { color: c.maroon, fontSize: 13, fontWeight: "700" },
  scheduleSectionLabel: {
    paddingHorizontal: 15,
    paddingTop: 16,
    color: c.ink,
    fontSize: 14,
    fontWeight: "800",
  },
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
  timeCard: {
    flex: 1,
    minHeight: 68,
    justifyContent: "center",
    paddingHorizontal: 13,
    borderRadius: 14,
    backgroundColor: c.surface,
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
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
  },
  allDayCopy: { flex: 1, minWidth: 0 },
  allDayTitle: { color: c.ink, fontSize: 15, fontWeight: "700" },
  allDayHint: { color: c.muted, fontSize: 13, marginTop: 2 },
  contentShell: { flex: 1, backgroundColor: c.cream },
  roleLoading: { alignItems: "center", justifyContent: "center" },
  header: {
    minHeight: 102,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: c.shell,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.chromeBorder,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: c.shell,
    borderWidth: 1,
    borderColor: c.chromeBorder,
  },
  headerCopy: { flex: 1, marginLeft: 12 },
  headerEyebrow: { color: c.gold, fontSize: 10, fontWeight: "900", letterSpacing: 1.4, marginBottom: 4 },
  headerTitle: { color: c.onChrome, fontSize: 24, fontWeight: "800", letterSpacing: -0.6 },
  headerSubtitle: { color: c.onChromeMuted, fontSize: 12, marginTop: 3 },
  formContainer: { flex: 1 },
  formContent: { paddingHorizontal: 18, paddingTop: 24, paddingBottom: 56 },
  formIntro: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 24 },
  formIntroIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: c.soft, alignItems: "center", justifyContent: "center" },
  formIntroCopy: { flex: 1, minWidth: 0 },
  formIntroTitle: { color: c.ink, fontSize: 16, fontWeight: "800" },
  formIntroText: { color: c.muted, fontSize: 12, lineHeight: 16, marginTop: 2 },
  titleSection: { padding: 16, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  titleInput: {
    minHeight: 52,
    paddingHorizontal: 14,
    color: c.ink,
    fontSize: 18,
    fontWeight: "700",
    borderRadius: 13,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.cream,
  },
  inputFocused: { borderColor: c.maroon },
  inputError: { borderColor: c.error },
  fieldHint: { color: c.muted, fontSize: 12, marginTop: 8 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  errorText: { color: c.error, fontSize: 12, fontWeight: "600" },
  scheduleCard: {
    overflow: "hidden",
    borderRadius: 20,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  divider: { height: 1, marginHorizontal: 16, backgroundColor: c.border },
  descriptionInput: {
    minHeight: 124,
    maxHeight: 180,
    paddingHorizontal: 16,
    paddingVertical: 16,
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
    gap: 8,
    marginTop: 7,
  },
  secondaryAction: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 15 },
  secondaryActionText: { color: c.maroon, fontSize: 14, fontWeight: "800" },
  submitButton: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 16, backgroundColor: c.maroon },
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

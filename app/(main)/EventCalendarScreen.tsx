// EventCalendarScreen.tsx
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { useNetworkStatus } from "@/utils/networkUtils";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
    collection,
    deleteDoc,
    doc,
    onSnapshot,
    orderBy,
    query,
    where,
    writeBatch,
} from "firebase/firestore";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Animated,
    AppState,
    Easing,
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
  /** The main event this one belongs to; null/missing means standalone. */
  parentEventId?: string | null;
};

type GroupedEvents = {
  [month: string]: {
    [date: string]: CalendarEvent[];
  };
};

type LocalDateParts = {
  year: number;
  monthIndex: number;
  day: number;
};

type EventLifecycle = "draft" | "archived" | "published" | "ongoing" | "finished";

const parseLocalDateParts = (dateString: string): LocalDateParts | null => {
  const match = dateString.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return null;
  }

  return { year, monthIndex, day };
};

const parseEventDate = (dateString: string) => {
  const dateParts = parseLocalDateParts(dateString);

  if (dateParts) {
    return new Date(dateParts.year, dateParts.monthIndex, dateParts.day);
  }

  return new Date(dateString);
};

/** Local YYYY-MM-DD. Dates are stored this way, so string order is date order. */
const toDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const formatCompactDate = (dateString: string) =>
  parseEventDate(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const formatTime = (value?: string) => {
  const time = value?.trim();
  if (!time) return "";

  const match = time.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return time;

  let hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    minute > 59 ||
    hour > 24 ||
    (hour === 24 && minute !== 0)
  ) {
    return time;
  }

  if (hour === 24) hour = 0;

  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;

  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
};

const formatEventTime = (event: CalendarEvent) => {
  if (event.category === "all-day") return "All day";

  const startTime = formatTime(event.startTime);
  const endTime = formatTime(event.endTime);

  if (startTime && endTime) return `${startTime} – ${endTime}`;
  if (startTime) return startTime;
  if (endTime) return `Ends ${endTime}`;

  return "Time not set";
};

const parseClockMinutes = (value?: string) => {
  const time = value?.trim();
  if (!time) return null;

  const match = time.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) {
    return null;
  }

  return hour * 60 + minute;
};

const getEventWindow = (event: CalendarEvent) => {
  const dateParts = parseLocalDateParts(event.date);
  if (!dateParts) return null;

  const hasStartTime = Boolean(event.startTime?.trim());
  const hasEndTime = Boolean(event.endTime?.trim());
  const startMinutes = parseClockMinutes(event.startTime);
  const endMinutes = parseClockMinutes(event.endTime);

  if (
    (hasStartTime && startMinutes === null) ||
    (hasEndTime && endMinutes === null)
  ) {
    return null;
  }

  const { year, monthIndex, day } = dateParts;
  const dayStart = new Date(year, monthIndex, day).getTime();
  const nextDayStart = new Date(year, monthIndex, day + 1).getTime();

  if (event.category === "all-day" || (!hasStartTime && !hasEndTime)) {
    return { startMs: dayStart, endMs: nextDayStart };
  }

  const startMs = hasStartTime
    ? new Date(year, monthIndex, day, 0, startMinutes || 0).getTime()
    : dayStart;
  let endMs = hasEndTime
    ? new Date(year, monthIndex, day, 0, endMinutes || 0).getTime()
    : nextDayStart;

  if (hasStartTime && hasEndTime && endMs <= startMs) {
    endMs = new Date(
      year,
      monthIndex,
      day + 1,
      0,
      endMinutes || 0,
    ).getTime();
  }

  return { startMs, endMs };
};

const getEventLifecycle = (
  event: CalendarEvent,
  currentTimeMs: number,
): EventLifecycle => {
  if (event.status === "draft") return "draft";
  if (event.status === "archived") return "archived";

  const eventWindow = getEventWindow(event);
  if (!eventWindow) return "published";

  if (currentTimeMs >= eventWindow.endMs) return "finished";
  if (currentTimeMs >= eventWindow.startMs) return "ongoing";

  return "published";
};

const sortEvents = (eventList: CalendarEvent[]) =>
  [...eventList].sort((first, second) => {
    const dateComparison = first.date.localeCompare(second.date);
    if (dateComparison !== 0) return dateComparison;

    return (first.startTime || "").localeCompare(second.startTime || "");
  });

const groupEventsByMonth = (eventList: CalendarEvent[]) => {
  const grouped: GroupedEvents = {};

  sortEvents(eventList).forEach((event) => {
    const date = parseEventDate(event.date);
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

  return grouped;
};

const EventCalendarScreen = () => {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const { isOffline } = useNetworkStatus();
  const { eventId } = useLocalSearchParams<{ eventId?: string | string[] }>();
  const resolvedEventId = Array.isArray(eventId) ? eventId[0] : eventId;
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [draftEvents, setDraftEvents] = useState<CalendarEvent[]>([]);
  const [showAllDrafts, setShowAllDrafts] = useState(false);
  const [showPast, setShowPast] = useState(false);
  // How far back to load. The recent past stays in memory so an event that is
  // half finished still knows all of its parts — the day counter needs the
  // finished ones too. Older history is only fetched when someone asks.
  const [pastWindowDays, setPastWindowDays] = useState(60);
  const windowStartKey = useMemo(() => {
    const start = new Date();
    start.setDate(start.getDate() - pastWindowDays);
    return toDateKey(start);
  }, [pastWindowDays]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<CalendarEvent[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(
    auth.currentUser?.uid || null,
  );
  const [authReady, setAuthReady] = useState(Boolean(auth.currentUser));
  // Live, so an admin promoting or demoting this account is reflected without
  // the screen being re-entered: staff buttons appear and vanish correctly.
  const currentUserRole = useCurrentUserRole();
  const [loading, setLoading] = useState(true);
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());
  const todayKey = useMemo(() => toDateKey(new Date(currentTimeMs)), [currentTimeMs]);

  // The main list starts at today, so the next thing that happens is the first
  // thing on screen instead of the oldest event ever created.
  const upcomingEvents = useMemo(
    () => events.filter((event) => event.date >= todayKey),
    [events, todayKey],
  );
  // Newest first: the recent past is what anyone actually looks for.
  const pastEvents = useMemo(
    () => events.filter((event) => event.date < todayKey).slice().reverse(),
    [events, todayKey],
  );
  // Parts are folded into their main event here, so a finished Intramurals is
  // one row in the history instead of six.
  const pastTopLevel = useMemo(
    () => pastEvents.filter((event) => !event.parentEventId),
    [pastEvents],
  );
  const groupedEvents = useMemo(
    () => groupEventsByMonth(upcomingEvents),
    [upcomingEvents],
  );
  const revealAnimation = useRef(new Animated.Value(0)).current;

  const calendarInsights = useMemo(() => {
    const lifecycleCounts = events.reduce(
      (counts, event) => {
        const lifecycle = getEventLifecycle(event, currentTimeMs);
        counts[lifecycle] += 1;
        return counts;
      },
      {
        draft: 0,
        archived: 0,
        published: 0,
        ongoing: 0,
        finished: 0,
      } as Record<EventLifecycle, number>,
    );
    const nextEvent = events.find((event) => {
      const lifecycle = getEventLifecycle(event, currentTimeMs);
      return lifecycle === "ongoing" || lifecycle === "published";
    });

    return {
      live: lifecycleCounts.ongoing,
      upcoming: lifecycleCounts.published,
      nextEvent,
    };
  }, [currentTimeMs, events]);

  // Parts grouped under the main event they belong to. A part is an ordinary
  // event carrying parentEventId, so it still appears on its own date in the
  // timeline below — this only adds the roll-up view.
  const partsByParent = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>();
    events.forEach((event) => {
      const parentId = String(event.parentEventId || "");
      if (!parentId) return;
      const existing = grouped.get(parentId);
      if (existing) existing.push(event);
      else grouped.set(parentId, [event]);
    });

    const sorted = new Map<string, CalendarEvent[]>();
    grouped.forEach((list, parentId) => sorted.set(parentId, sortEvents(list)));
    return sorted;
  }, [events]);

  // What is running inside each main event right now, and what follows it.
  const partSummaries = useMemo(() => {
    const summaries = new Map<
      string,
      { parts: CalendarEvent[]; now?: CalendarEvent; next?: CalendarEvent }
    >();
    partsByParent.forEach((parts, parentId) => {
      summaries.set(parentId, {
        parts,
        now: parts.find(
          (part) => getEventLifecycle(part, currentTimeMs) === "ongoing",
        ),
        next: parts.find(
          (part) => getEventLifecycle(part, currentTimeMs) === "published",
        ),
      });
    });
    return summaries;
  }, [partsByParent, currentTimeMs]);

  const eventTitleById = useMemo(() => {
    const titles = new Map<string, string>();
    [...events, ...draftEvents].forEach((event) => titles.set(event.id, event.title));
    return titles;
  }, [events, draftEvents]);

  // Everything on right now, parts included — the question a student opens
  // this screen to answer.
  const happeningNow = useMemo(
    () =>
      events.filter(
        (event) =>
          getEventLifecycle(event, currentTimeMs) === "ongoing" &&
          // A main event is a container, not a session. During Intramurals the
          // useful answer is the game, not the week — so only leaves appear
          // here, and they name their parent as context.
          !partsByParent.has(event.id),
      ),
    [events, currentTimeMs, partsByParent],
  );

  // Start, end and day-of-span for each main event, derived from its parts so
  // there is no second copy of the range to keep in sync.
  const umbrellaSpans = useMemo(() => {
    const spans = new Map<
      string,
      { start: string; end: string; totalDays: number; dayIndex: number }
    >();
    partsByParent.forEach((parts, parentId) => {
      const days = [...new Set(parts.map((part) => part.date))].sort();
      if (days.length === 0) return;
      spans.set(parentId, {
        start: days[0],
        end: days[days.length - 1],
        totalDays: days.length,
        dayIndex: days.indexOf(todayKey) + 1,
      });
    });
    return spans;
  }, [partsByParent, todayKey]);

  // The main event a given day belongs to, so a student landing mid-week still
  // sees "Intramurals" without another card to scroll past.
  const parentTitleByDate = useMemo(() => {
    const byDate = new Map<string, string>();
    events.forEach((event) => {
      const parentId = String(event.parentEventId || "");
      if (!parentId || byDate.has(event.date)) return;
      const title = eventTitleById.get(parentId);
      if (title) byDate.set(event.date, title);
    });
    return byDate;
  }, [events, eventTitleById]);

  useEffect(() => {
    if (loading) return;

    revealAnimation.setValue(0);
    Animated.timing(revealAnimation, {
      toValue: 1,
      duration: 620,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [loading, revealAnimation]);

  useEffect(() => {
    let minuteTimeout: ReturnType<typeof setTimeout> | undefined;
    let minuteInterval: ReturnType<typeof setInterval> | undefined;

    const stopClock = () => {
      if (minuteTimeout !== undefined) clearTimeout(minuteTimeout);
      if (minuteInterval !== undefined) clearInterval(minuteInterval);
    };

    const startClock = () => {
      stopClock();
      setCurrentTimeMs(Date.now());

      const millisecondsUntilNextMinute =
        60_000 - (Date.now() % 60_000) + 25;

      minuteTimeout = setTimeout(() => {
        setCurrentTimeMs(Date.now());
        minuteInterval = setInterval(() => {
          setCurrentTimeMs(Date.now());
        }, 60_000);
      }, millisecondsUntilNextMinute);
    };

    startClock();
    const appStateSubscription = AppState.addEventListener(
      "change",
      (nextState) => {
        if (nextState === "active") startClock();
      },
    );

    return () => {
      stopClock();
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!active) return;

      // The role is tracked by useCurrentUserRole above; this only needs to
      // know which account the event listeners belong to.
      setCurrentUserId(user?.uid || null);
      setAuthReady(true);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady) return;

    if (!currentUserId) {
      setEvents([]);
      setDraftEvents([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    let publicEventsLoaded = false;
    let ownedEventsLoaded = false;

    const finishLoading = () => {
      if (publicEventsLoaded && ownedEventsLoaded) {
        setLoading(false);
      }
    };

    // Bounded by date rather than fetching every event ever created. A range
    // filter and orderBy on the same field need no composite index, so status
    // is filtered below instead of in the query.
    const publicEventsQuery = query(
      collection(db, "events"),
      where("date", ">=", windowStartKey),
      orderBy("date", "asc"),
    );
    const ownedEventsQuery = query(
      collection(db, "events"),
      where("createdBy", "==", currentUserId),
    );

    const unsubscribePublicEvents = onSnapshot(
      publicEventsQuery,
      (snapshot) => {
        const fetchedEvents = (snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as CalendarEvent[]).filter((event) => {
          const status = String(event.status || "published");
          return status === "published" || status === "archived";
        });

        setEvents(sortEvents(fetchedEvents));
        publicEventsLoaded = true;
        finishLoading();
      },
      (error) => {
        console.error("Error fetching published events:", error);
        setEvents([]);
        publicEventsLoaded = true;
        finishLoading();
      },
    );

    const unsubscribeOwnedEvents = onSnapshot(
      ownedEventsQuery,
      (snapshot) => {
        const fetchedDrafts = snapshot.docs
          .map((eventDoc) => ({
            id: eventDoc.id,
            ...eventDoc.data(),
          })) as CalendarEvent[];

        setDraftEvents(
          sortEvents(
            fetchedDrafts.filter(
              (event) =>
                event.status === "draft" && event.createdBy === currentUserId,
            ),
          ),
        );
        ownedEventsLoaded = true;
        finishLoading();
      },
      (error) => {
        console.error("Error fetching draft events:", error);
        setDraftEvents([]);
        ownedEventsLoaded = true;
        finishLoading();
      },
    );

    return () => {
      unsubscribePublicEvents();
      unsubscribeOwnedEvents();
    };
  }, [authReady, currentUserId, windowStartKey]);

  useEffect(() => {
    const accessibleEvents = [...events, ...draftEvents];
    if (!resolvedEventId || accessibleEvents.length === 0) return;

    const targetEvent = accessibleEvents.find(
      (event) => event.id === resolvedEventId,
    );
    if (!targetEvent) return;

    const eventSource = targetEvent.status === "draft" ? draftEvents : events;
    const eventsForDate = eventSource
      .filter((event) => event.date === targetEvent.date)
      .sort((first, second) =>
        (first.startTime || "").localeCompare(second.startTime || ""),
      );

    setSelectedDate(targetEvent.date);
    setSelectedEvents(eventsForDate);
    setModalVisible(true);
  }, [draftEvents, events, resolvedEventId]);

  useEffect(() => {
    if (draftEvents.length <= 1) {
      setShowAllDrafts(false);
    }
  }, [draftEvents.length]);

  const handleViewMorePress = (
    date: string,
    eventsForDate: CalendarEvent[],
  ) => {
    setSelectedDate(date);
    setSelectedEvents(eventsForDate);
    setModalVisible(true);
  };

  const handleCreateEvent = () => {
    if (!["moderator", "teacher", "admin"].includes(currentUserRole || "")) {
      return;
    }

    // Writes need the network: Firestore has no offline persistence here, so
    // a "saved" event would silently vanish.
    if (isOffline) {
      Alert.alert("Offline", "Creating events is unavailable while offline.");
      return;
    }

    router.push("/CreateEventScreen");
  };

  const handleDeleteEvent = async (eventId: string) => {
    if (isOffline) {
      Alert.alert("Offline", "Deleting events is unavailable while offline.");
      return;
    }

    // Firestore has no cascade delete, so the parts have to go with the main
    // event. Leaving them behind would strand sessions pointing at an event
    // that no longer exists.
    const parts = partsByParent.get(eventId) || [];
    const message = parts.length
      ? `This will also delete its ${parts.length} ${parts.length === 1 ? "part" : "parts"}. This can't be undone.`
      : "Are you sure you want to delete this event?";

    Alert.alert(parts.length ? "Delete event and its parts?" : "Delete Event", message, [
      { text: "Cancel", style: "cancel" },
      {
        text: parts.length ? `Delete all ${parts.length + 1}` : "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            if (parts.length) {
              // One batch, so a failure part-way cannot leave orphans behind.
              const batch = writeBatch(db);
              batch.delete(doc(db, "events", eventId));
              parts.forEach((part) => batch.delete(doc(db, "events", part.id)));
              await batch.commit();
            } else {
              await deleteDoc(doc(db, "events", eventId));
            }
            setModalVisible(false);
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

  const canEditEvent = (event: CalendarEvent) => {
    return (
      (event.status === "draft" || event.status === "published") &&
      event.createdBy === currentUserId &&
      canManageEvents()
    );
  };

  const formatDate = (dateStr: string) => {
    const date = parseEventDate(dateStr);
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

  const getStatusDetails = (event: CalendarEvent) => {
    const lifecycle = getEventLifecycle(event, currentTimeMs);

    if (lifecycle === "draft") {
      return {
        lifecycle,
        label: "DRAFT",
        icon: "create-outline" as const,
        color: theme.textMuted,
        surfaceColor: theme.surfaceRaised,
        borderColor: theme.border,
      };
    }

    if (lifecycle === "archived") {
      return {
        lifecycle,
        label: "ARCHIVED",
        icon: "archive-outline" as const,
        color: theme.textSecondary,
        surfaceColor: theme.surfaceSunken,
        borderColor: theme.borderStrong,
      };
    }

    if (lifecycle === "ongoing") {
      return {
        lifecycle,
        label: "ONGOING",
        icon: "radio-button-on" as const,
        color: theme.success,
        surfaceColor: theme.successSoft,
        borderColor: theme.success,
      };
    }

    if (lifecycle === "finished") {
      return {
        lifecycle,
        label: "FINISHED",
        icon: "checkmark-done-circle-outline" as const,
        color: theme.textMuted,
        surfaceColor: theme.surfaceSunken,
        borderColor: theme.border,
      };
    }

    return {
      lifecycle,
      label: "PUBLISHED",
      icon: "checkmark-circle-outline" as const,
      color: theme.primary,
      surfaceColor: theme.surfaceRaised,
      borderColor: theme.border,
    };
  };

  const handleEditEvent = (event: CalendarEvent) => {
    if (!canEditEvent(event)) return;

    if (isOffline) {
      Alert.alert("Offline", "Editing events is unavailable while offline.");
      return;
    }

    setModalVisible(false);
    router.push({ pathname: "/CreateEventScreen", params: { eventId: event.id } });
  };

  const renderListHeader = () => {
    const nextEvent = calendarInsights.nextEvent;

    return (
      <>
        {/* The first thing on screen answers "what is on right now?" rather
            than decorating the page. Parts count here too, so during
            Intramurals a student sees the game, not just the week. */}
        <View style={styles.nowPanel}>
          <View style={styles.nowHeaderRow}>
            <Text style={styles.nowHeading}>
              {happeningNow.length > 0 ? "Happening now" : "Up next"}
            </Text>
            {happeningNow.length > 0 && (
              <View style={styles.nowLivePill}>
                <View style={styles.nowLiveDot} />
                <Text style={styles.nowLiveText}>LIVE</Text>
              </View>
            )}
          </View>

          {happeningNow.length > 0 ? (
            happeningNow.slice(0, 3).map((event) => {
              const parentTitle = event.parentEventId
                ? eventTitleById.get(String(event.parentEventId))
                : undefined;
              const endsAt = formatTime(event.endTime);

              return (
                <TouchableOpacity
                  key={event.id}
                  style={styles.nowRow}
                  activeOpacity={0.75}
                  onPress={() => handleViewMorePress(event.date, [event])}
                  accessibilityRole="button"
                  accessibilityLabel={`Happening now: ${event.title}`}
                >
                  <View style={styles.nowDot} />
                  <View style={styles.nowRowCopy}>
                    <Text style={styles.nowTitle} numberOfLines={1}>
                      {event.title}
                    </Text>
                    <Text style={styles.nowMeta} numberOfLines={1}>
                      {parentTitle ? `${parentTitle} · ` : ""}
                      {endsAt ? `until ${endsAt}` : "all day"}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })
          ) : (
            <Text style={styles.nowEmpty} numberOfLines={2}>
              {nextEvent
                ? `${nextEvent.title} · ${formatCompactDate(nextEvent.date)}`
                : "Nothing scheduled yet."}
            </Text>
          )}

          <View style={styles.nowStatsRow}>
            <Text style={styles.nowStat}>{calendarInsights.upcoming} upcoming</Text>
            <Text style={styles.nowStatDivider}>·</Text>
            <Text style={styles.nowStat}>
              {events.length} {events.length === 1 ? "event" : "events"}
            </Text>
            {draftEvents.length > 0 && (
              <>
                <Text style={styles.nowStatDivider}>·</Text>
                <Text style={styles.nowStat}>
                  {draftEvents.length} draft{draftEvents.length === 1 ? "" : "s"}
                </Text>
              </>
            )}
          </View>
        </View>

      </>
    );
  };

  // Drafts are staff-only and unpublished, so they sit below the timeline
  // rather than above it, where they pushed real events off the screen.
  const renderDrafts = () => {
    if (draftEvents.length === 0) return null;
    const visibleDraftEvents = showAllDrafts
      ? draftEvents
      : draftEvents.slice(0, 1);

    return (
          <View style={styles.draftsSection}>
            <View style={styles.draftsHeader}>
              <View style={styles.draftTitleRow}>
                <View style={styles.draftLockOrb}>
                  <Ionicons name="lock-closed" size={13} color={theme.textMuted} />
                </View>
                <View style={styles.draftsHeaderCopy}>
                  <Text style={styles.draftsTitle}>Drafts</Text>
                  <Text style={styles.draftsSubtitle}>Only you can see these</Text>
                </View>
              </View>
              <View style={styles.draftCountBadge}>
                <Text style={styles.draftCountText}>{draftEvents.length}</Text>
              </View>
            </View>

            {visibleDraftEvents.map((event) => {
              const draftsForDate = draftEvents.filter(
                (draft) => draft.date === event.date,
              );

              return (
                <View key={event.id} style={styles.draftCard}>
                  <TouchableOpacity
                    style={styles.draftCardBody}
                    onPress={() =>
                      handleViewMorePress(event.date, draftsForDate)
                    }
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`View draft ${event.title}`}
                  >
                    <View style={styles.draftIcon}>
                      <Ionicons
                        name="sparkles-outline"
                        size={18}
                        color={theme.textMuted}
                      />
                    </View>
                    <View style={styles.draftCopy}>
                      <Text style={styles.draftEventTitle} numberOfLines={1}>
                        {event.title}
                      </Text>
                      <Text style={styles.draftEventDate} numberOfLines={1}>
                        {formatCompactDate(event.date)} at {formatEventTime(event)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  {canEditEvent(event) && (
                    <TouchableOpacity
                      style={styles.editIconButton}
                      onPress={() => handleEditEvent(event)}
                      activeOpacity={0.75}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit draft ${event.title}`}
                    >
                      <Ionicons
                        name="create-outline"
                        size={19}
                        color={theme.textMuted}
                      />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}

            {draftEvents.length > 1 && (
              <TouchableOpacity
                style={styles.draftsToggleButton}
                onPress={() => setShowAllDrafts((isShowingAll) => !isShowingAll)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={
                  showAllDrafts
                    ? "Show fewer drafts"
                    : `View all ${draftEvents.length} drafts`
                }
                accessibilityState={{ expanded: showAllDrafts }}
              >
                <Text style={styles.draftsToggleText}>
                  {showAllDrafts
                    ? "Show less"
                    : `View all ${draftEvents.length} drafts`}
                </Text>
                <Ionicons
                  name={showAllDrafts ? "chevron-up" : "chevron-down"}
                  size={18}
                  color={theme.textMuted}
                />
              </TouchableOpacity>
            )}
          </View>
    );
  };

  const renderMonthSection = ({ item }: { item: string }) => {
    const dates = Object.keys(groupedEvents[item]).sort();

    return (
      <View style={styles.monthSection}>
        <Text style={styles.monthLabel}>{item.toUpperCase()}</Text>

        {dates.map((date) => {
          const eventsForDate = groupedEvents[item][date];
          const calendarDate = parseEventDate(date);
          const isToday = date === todayKey;
          // Naming the main event in the day heading means a student landing
          // mid-week sees "Intramurals" without another card to scroll past.
          const dayParent = parentTitleByDate.get(date);

          return (
            <View key={date} style={styles.daySection}>
              <Text
                style={[styles.dayHeading, isToday && styles.dayHeadingToday]}
                numberOfLines={2}
              >
                {isToday ? "Today · " : ""}
                {calendarDate.toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
                {dayParent ? ` · ${dayParent}` : ""}
              </Text>

              {eventsForDate.map((event) => {
                const statusDetails = getStatusDetails(event);
                const isLive = statusDetails.lifecycle === "ongoing";
                const isDone = statusDetails.lifecycle === "finished";
                // A main event has parts; it shows a date range rather than a
                // clock, which is what tells a student it is the big one.
                const span = umbrellaSpans.get(event.id);
                const partCount = partSummaries.get(event.id)?.parts.length || 0;
                const parentTitle = event.parentEventId
                  ? eventTitleById.get(String(event.parentEventId))
                  : undefined;

                return (
                  <TouchableOpacity
                    key={event.id}
                    style={[
                      styles.rowCard,
                      isDone && styles.rowCardDone,
                      !!span && styles.rowCardMain,
                    ]}
                    activeOpacity={0.75}
                    onPress={() => handleViewMorePress(date, eventsForDate)}
                    accessibilityRole="button"
                    accessibilityLabel={`${event.title}, ${formatEventTime(event)}`}
                    accessibilityHint="Opens event details"
                  >
                    <View
                      style={[
                        styles.rowBar,
                        { backgroundColor: getCategoryColor(event.category) },
                      ]}
                    />

                    <View style={styles.rowBody}>
                      <View style={styles.rowTopRow}>
                        <Text style={styles.rowTime} numberOfLines={1}>
                          {span
                            ? `${formatCompactDate(span.start)} – ${formatCompactDate(span.end)}`
                            : formatEventTime(event)}
                        </Text>

                        {isLive ? (
                          <View style={styles.liveTag}>
                            <View style={styles.liveTagDot} />
                            <Text style={styles.liveTagText}>LIVE</Text>
                          </View>
                        ) : isDone ? (
                          <Text style={styles.doneTag}>Finished</Text>
                        ) : event.status === "draft" ? (
                          <Text style={styles.draftTag}>Draft</Text>
                        ) : null}
                      </View>

                      <Text style={styles.rowName} numberOfLines={2}>
                        {event.title}
                      </Text>

                      {span ? (
                        <Text style={styles.rowContext} numberOfLines={1}>
                          {partCount} {partCount === 1 ? "part" : "parts"}
                          {span.dayIndex > 0
                            ? ` · in progress, day ${span.dayIndex} of ${span.totalDays}`
                            : ``}
                        </Text>
                      ) : parentTitle ? (
                        <Text style={styles.rowContext} numberOfLines={1}>
                          {parentTitle}
                        </Text>
                      ) : null}
                    </View>

                    {canEditEvent(event) && (
                      <TouchableOpacity
                        style={styles.rowEdit}
                        onPress={() => handleEditEvent(event)}
                        activeOpacity={0.7}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={`Edit ${event.title}`}
                      >
                        <Ionicons name="create-outline" size={19} color={theme.textMuted} />
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>
                );
              })}
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
          <TouchableOpacity
            style={styles.headerBackButton}
            onPress={() => router.back()}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={20} color={theme.textPrimary} />
          </TouchableOpacity>

          <View style={styles.headerCopy}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              Events
            </Text>
          </View>

          {canManageEvents() && (
            <TouchableOpacity
              style={styles.headerCreateButton}
              onPress={handleCreateEvent}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Create a new event"
            >
              <Ionicons name="add" size={19} color={theme.onChrome} />
              <Text style={styles.headerCreateText}>New event</Text>
            </TouchableOpacity>
          )}
        </View>

      {isOffline && (
        <View style={styles.offlineStatusBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={theme.warning} />
          <Text style={styles.offlineStatusText}>Offline mode</Text>
        </View>
      )}

      {/* Events List */}
      {/* Offline the listeners never resolve, so the spinner would spin
          forever — fall through to the empty state instead. */}
      {loading && !isOffline ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={styles.loadingText}>Loading your calendar...</Text>
        </View>
      ) : events.length === 0 && draftEvents.length === 0 ? (
        <View style={styles.emptyContainer}>
          <View style={styles.emptyIcon}>
            <Ionicons name="calendar-outline" size={42} color={theme.textSecondary} />
          </View>
          <Text style={styles.emptyText}>
            {isOffline ? "Offline mode" : "No events yet"}
          </Text>
          <Text style={styles.emptySubtitle}>
            {canManageEvents()
              ? "Create the first event and start building your schedule."
              : "Published events will appear here when they are scheduled."}
          </Text>
          {canManageEvents() && (
            <TouchableOpacity
              style={styles.createButton}
              onPress={handleCreateEvent}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Create the first event"
            >
              <Ionicons name="add" size={20} color={theme.onChrome} />
              <Text style={styles.createButtonText}>Create event</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <Animated.FlatList
          data={Object.keys(groupedEvents)}
          renderItem={renderMonthSection}
          keyExtractor={(item) => item}
          style={{
            opacity: revealAnimation,
            transform: [
              {
                translateY: revealAnimation.interpolate({
                  inputRange: [0, 1],
                  outputRange: [18, 0],
                }),
              },
            ],
          }}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={renderListHeader}
          ListFooterComponent={
            <>
              {renderDrafts()}
              {pastTopLevel.length > 0 ? (
              <View style={styles.pastSection}>
                <TouchableOpacity
                  style={styles.pastToggle}
                  onPress={() => setShowPast((value) => !value)}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showPast }}
                  accessibilityLabel={
                    showPast ? "Hide past events" : "Show past events"
                  }
                >
                  <Ionicons
                    name={showPast ? "chevron-up" : "chevron-down"}
                    size={17}
                    color={theme.textMuted}
                  />
                  <Text style={styles.pastToggleText}>
                    {showPast
                      ? "Hide past events"
                      : `Past events (${pastTopLevel.length})`}
                  </Text>
                </TouchableOpacity>

                {showPast && (
                  <>
                    {pastTopLevel.map((event) => {
                      const partCount =
                        partSummaries.get(event.id)?.parts.length || 0;
                      return (
                        <TouchableOpacity
                          key={event.id}
                          style={styles.pastRow}
                          activeOpacity={0.75}
                          onPress={() => handleViewMorePress(event.date, [event])}
                          accessibilityRole="button"
                          accessibilityLabel={`${event.title}, ${formatCompactDate(event.date)}`}
                        >
                          <Text style={styles.pastRowTitle} numberOfLines={1}>
                            {event.title}
                          </Text>
                          <Text style={styles.pastRowMeta} numberOfLines={1}>
                            {formatCompactDate(event.date)}
                            {partCount > 0
                              ? ` · ${partCount} ${partCount === 1 ? "part" : "parts"}`
                              : ""}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}

                    <TouchableOpacity
                      style={styles.pastLoadMore}
                      onPress={() => setPastWindowDays((days) => days + 180)}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel="Load older events"
                    >
                      <Text style={styles.pastLoadMoreText}>Load older events</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
              ) : null}
            </>
          }
          ListEmptyComponent={
            draftEvents.length > 0 ? (
              <View style={styles.publishedEmptyCard}>
                <View style={styles.publishedEmptyIcon}>
                  <Ionicons
                    name="calendar-outline"
                    size={26}
                    color={theme.textSecondary}
                  />
                </View>
                <Text style={styles.publishedEmptyText}>
                  No calendar events yet
                </Text>
                <Text style={styles.publishedEmptySubtitle}>
                  Your saved drafts are ready whenever you want to publish.
                </Text>
                {canManageEvents() && (
                  <TouchableOpacity
                    style={styles.emptyCreateLink}
                    onPress={handleCreateEvent}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Create another event"
                  >
                    <Ionicons name="add" size={17} color={theme.textSecondary} />
                    <Text style={styles.emptyCreateLinkText}>New event</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : null
          }
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
            <View style={styles.modalHandle} />

            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderCopy}>
                <Text style={styles.modalDate} numberOfLines={2}>
                  {selectedDate ? formatDate(selectedDate) : ""}
                </Text>
                <Text style={styles.modalSubtitle}>
                  {selectedEvents.length}{" "}
                  {selectedEvents.length === 1 ? "event" : "events"}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={() => setModalVisible(false)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Close event details"
              >
                <Ionicons name="close" size={23} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Events List */}
            <ScrollView
              style={styles.eventsScrollView}
              contentContainerStyle={styles.eventsScrollContent}
              showsVerticalScrollIndicator={false}
            >
              {selectedEvents.map((event) => {
                const isOwnDraft =
                  event.status === "draft" && event.createdBy === currentUserId;
                const statusDetails = getStatusDetails(event);

                return (
                <View
                  key={event.id}
                  style={[
                    styles.eventCard,
                    {
                      backgroundColor: statusDetails.surfaceColor,
                      borderColor: statusDetails.borderColor,
                      borderLeftColor:
                        statusDetails.lifecycle === "ongoing" ||
                        statusDetails.lifecycle === "finished"
                          ? statusDetails.color
                          : getCategoryColor(event.category),
                    },
                    resolvedEventId === event.id && styles.highlightedEventCard,
                  ]}
                >
                  <View style={styles.eventHeader}>
                    <Text style={styles.eventCardTitle}>{event.title}</Text>
                    <View style={styles.eventActions}>
                      {canEditEvent(event) && (
                        <TouchableOpacity
                          style={styles.editIconButton}
                          onPress={() => handleEditEvent(event)}
                          activeOpacity={0.7}
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel={`Edit ${
                            event.status === "draft" ? "draft" : "published event"
                          } ${event.title}`}
                        >
                          <Ionicons
                            name="create-outline"
                            size={19}
                            color={theme.accent}
                          />
                        </TouchableOpacity>
                      )}
                      {canManageEvents() &&
                        (event.status !== "draft" || isOwnDraft) && (
                          <TouchableOpacity
                            style={[
                              styles.eventActionButton,
                              styles.deleteActionButton,
                            ]}
                            onPress={() => handleDeleteEvent(event.id)}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={`Delete ${event.title}`}
                          >
                            <Ionicons
                              name="trash-outline"
                              size={18}
                              color={theme.danger}
                            />
                          </TouchableOpacity>
                        )}
                    </View>
                  </View>

                  <View style={styles.badgesRow}>
                    <View
                      style={[
                        styles.statusBadge,
                        { backgroundColor: statusDetails.color },
                      ]}
                    >
                      <Ionicons
                        name={statusDetails.icon}
                        size={12}
                        color={theme.onChrome}
                      />
                      <Text style={styles.statusText}>{statusDetails.label}</Text>
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

                  {/* Every part of this event, in time order, so one tap on
                      "Intramurals" shows the whole schedule. */}
                  {(partSummaries.get(event.id)?.parts.length || 0) > 0 && (
                    <View style={styles.modalPartsBox}>
                      <Text style={styles.modalPartsHeading}>
                        {partSummaries.get(event.id)!.parts.length} PARTS
                      </Text>
                      {partSummaries.get(event.id)!.parts.map((part) => {
                        const partStatus = getStatusDetails(part);
                        return (
                          <View key={part.id} style={styles.modalPartRow}>
                            <View
                              style={[
                                styles.modalPartDot,
                                { backgroundColor: partStatus.color },
                              ]}
                            />
                            <Text style={styles.modalPartTitle} numberOfLines={1}>
                              {part.title}
                            </Text>
                            <Text style={styles.modalPartTime}>
                              {partStatus.lifecycle === "ongoing"
                                ? "NOW"
                                : formatEventTime(part)}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  )}

                  {/* Only a main event can take parts — one level deep. */}
                  {canManageEvents() && !event.parentEventId && (
                    <TouchableOpacity
                      style={styles.addPartButton}
                      activeOpacity={0.75}
                      onPress={() => {
                        setModalVisible(false);
                        router.push({
                          pathname: "/CreateEventScreen",
                          params: { parentId: event.id },
                        });
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Add a part to ${event.title}`}
                    >
                      <Ionicons name="add-circle-outline" size={18} color={theme.primary} />
                      <Text style={styles.addPartText}>Add a part</Text>
                    </TouchableOpacity>
                  )}

                  {event.description && (
                    <Text style={styles.eventDescription}>
                      {event.description}
                    </Text>
                  )}

                  <View style={styles.eventMeta}>
                    {event.category === "all-day" ? (
                      <View style={styles.metaItem}>
                        <View style={styles.metaIcon}>
                          <Ionicons
                            name="sunny-outline"
                            size={16}
                            color={theme.textSecondary}
                          />
                        </View>
                        <View style={styles.metaCopy}>
                          <Text style={styles.metaLabel}>Schedule</Text>
                          <Text style={styles.metaText}>All day</Text>
                        </View>
                      </View>
                    ) : (
                      <>
                        <View style={styles.metaItem}>
                          <View style={styles.metaIcon}>
                            <Ionicons
                              name="play-circle-outline"
                              size={16}
                              color={theme.textSecondary}
                            />
                          </View>
                          <View style={styles.metaCopy}>
                            <Text style={styles.metaLabel}>Start time</Text>
                            <Text style={styles.metaText}>
                              {formatTime(event.startTime) || "Not set"}
                            </Text>
                          </View>
                        </View>

                        <View style={styles.metaItem}>
                          <View style={styles.metaIcon}>
                            <Ionicons
                              name="stop-circle-outline"
                              size={16}
                              color={theme.textSecondary}
                            />
                          </View>
                          <View style={styles.metaCopy}>
                            <Text style={styles.metaLabel}>End time</Text>
                            <Text style={styles.metaText}>
                              {formatTime(event.endTime) || "Not set"}
                            </Text>
                          </View>
                        </View>
                      </>
                    )}

                    <View style={styles.metaItem}>
                      <View style={styles.metaIcon}>
                        <Ionicons
                          name="person-outline"
                          size={16}
                          color={theme.textSecondary}
                        />
                      </View>
                      <View style={styles.metaCopy}>
                        <Text style={styles.metaLabel}>Created by</Text>
                        <Text style={styles.metaText}>{event.createdByName}</Text>
                      </View>
                    </View>
                  </View>
                </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
      </View>
    </SafeAreaView>
  );
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  monthSection: { marginBottom: 8 },
  addPartButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minHeight: 44,
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  addPartText: { color: c.primary, fontSize: 14, fontWeight: "700" },
  pastSection: {
    marginTop: 22,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  pastToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
  },
  pastToggleText: { color: c.textMuted, fontSize: 15, fontWeight: "700" },
  pastRow: {
    paddingVertical: 11,
    paddingHorizontal: 13,
    marginBottom: 8,
    borderRadius: 12,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  pastRowTitle: { color: c.textSecondary, fontSize: 15, fontWeight: "600" },
  pastRowMeta: { color: c.textMuted, fontSize: 13, marginTop: 2 },
  pastLoadMore: { alignItems: "center", paddingVertical: 12 },
  pastLoadMoreText: { color: c.primary, fontSize: 14, fontWeight: "700" },
  monthLabel: {
    color: c.textMuted,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.6,
    marginTop: 18,
    marginBottom: 6,
  },
  daySection: { marginBottom: 16 },
  dayHeading: {
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 8,
  },
  dayHeadingToday: { color: c.success },
  rowCard: {
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    marginBottom: 8,
    borderRadius: 14,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
  },
  // Finished events stay visible but step back, so today still reads as today.
  rowCardDone: { backgroundColor: c.surfaceSunken, opacity: 0.72 },
  // A main event is the container for a week; a heavier edge sets it apart
  // from the sessions inside it.
  rowCardMain: { borderColor: c.border, backgroundColor: c.surfaceRaised },
  rowBar: { width: 4, alignSelf: "stretch" },
  rowBody: { flex: 1, minWidth: 0, paddingVertical: 12, paddingHorizontal: 13 },
  rowTopRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTime: { flex: 1, color: c.textMuted, fontSize: 15, fontWeight: "600" },
  rowName: {
    color: c.textPrimary,
    fontSize: 17,
    fontWeight: "700",
    lineHeight: 23,
    marginTop: 3,
  },
  rowContext: { color: c.textMuted, fontSize: 13, marginTop: 3 },
  rowEdit: { paddingHorizontal: 13, paddingVertical: 12 },
  liveTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: c.successSoft,
    borderWidth: 1,
    borderColor: c.success,
  },
  liveTagDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.success },
  liveTagText: { color: c.success, fontSize: 12, fontWeight: "800" },
  doneTag: { color: c.textMuted, fontSize: 12, fontWeight: "600" },
  draftTag: { color: c.textMuted, fontSize: 12, fontWeight: "700" },
  nowPanel: {
    marginBottom: 22,
    padding: 18,
    borderRadius: 22,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
  },
  nowHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  nowHeading: {
    color: c.textPrimary,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  nowLivePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: c.successSoft,
    borderWidth: 1,
    borderColor: c.success,
  },
  nowLiveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.success },
  nowLiveText: {
    color: c.success,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.9,
  },
  nowRow: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 8 },
  nowRowCopy: { flex: 1, minWidth: 0 },
  nowDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: c.success },
  nowTitle: { color: c.textPrimary, fontSize: 15, fontWeight: "700" },
  nowMeta: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  nowEmpty: { color: c.textMuted, fontSize: 13, lineHeight: 19 },
  nowStatsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  nowStat: { color: c.textMuted, fontSize: 13, fontWeight: "600" },
  nowStatDivider: { color: c.textMuted, fontSize: 13 },
  modalPartsBox: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: c.border,
    gap: 7,
  },
  modalPartsHeading: {
    color: c.textMuted,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  modalPartRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  modalPartDot: { width: 7, height: 7, borderRadius: 4 },
  modalPartTitle: { flex: 1, color: c.textPrimary, fontSize: 13, fontWeight: "600" },
  modalPartTime: { color: c.textMuted, fontSize: 13 },
  container: {
    flex: 1,
    backgroundColor: c.surface,
  },
  offlineStatusBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.accentSoft,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: c.borderStrong,
  },
  offlineStatusText: {
    fontSize: 12,
    color: c.warning,
    fontWeight: "600",
  },
  contentShell: {
    flex: 1,
    backgroundColor: c.surface,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 70,
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    zIndex: 1,
  },
  headerBackButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: 13,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: c.textPrimary,
    letterSpacing: -0.3,
  },
  headerCreateButton: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: 21,
    backgroundColor: c.primary,
  },
  headerCreateText: {
    fontSize: 13,
    fontWeight: "800",
    color: c.surface,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 28,
  },
  draftsSection: {
    marginBottom: 28,
    padding: 16,
    borderRadius: 20,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
  },
  draftsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 11,
  },
  draftTitleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  draftLockOrb: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    borderRadius: 17,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  draftsHeaderCopy: {
    flex: 1,
  },
  draftsTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: c.textPrimary,
  },
  draftsSubtitle: {
    marginTop: 2,
    fontSize: 13,
    color: c.textMuted,
  },
  draftCountBadge: {
    minWidth: 31,
    height: 31,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: c.surfaceSunken,
  },
  draftCountText: {
    fontSize: 13,
    fontWeight: "800",
    color: c.primary,
  },
  draftCard: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    padding: 10,
    borderRadius: 14,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
  },
  draftCardBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    marginRight: 8,
  },
  draftIcon: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    borderRadius: 18,
    backgroundColor: c.surfaceSunken,
  },
  draftCopy: {
    flex: 1,
  },
  draftEventTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: c.textPrimary,
  },
  draftEventDate: {
    marginTop: 3,
    fontSize: 13,
    color: c.textMuted,
  },
  editIconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  draftsToggleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    marginTop: 10,
    paddingVertical: 8,
  },
  draftsToggleText: {
    fontSize: 14,
    fontWeight: "700",
    color: c.accent,
  },
  publishedEmptyCard: {
    alignItems: "center",
    paddingVertical: 34,
    paddingHorizontal: 22,
    borderRadius: 26,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
  },
  publishedEmptyIcon: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 26,
    backgroundColor: c.surfaceSunken,
  },
  publishedEmptyText: {
    marginTop: 12,
    fontSize: 16,
    fontWeight: "800",
    color: c.textPrimary,
  },
  publishedEmptySubtitle: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    color: c.textMuted,
  },
  emptyCreateLink: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    marginTop: 14,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: c.surfaceSunken,
  },
  emptyCreateLinkText: {
    fontSize: 13,
    fontWeight: "800",
    color: c.primary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(22, 4, 3, 0.76)",
    justifyContent: "flex-end",
  },
  modalContent: {
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    backgroundColor: c.surface,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingTop: 10,
    maxHeight: "88%",
    overflow: "hidden",
  },
  modalHandle: {
    width: 42,
    height: 5,
    alignSelf: "center",
    marginBottom: 8,
    borderRadius: 999,
    backgroundColor: c.borderStrong,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 22,
    paddingBottom: 17,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  modalHeaderCopy: {
    flex: 1,
    minWidth: 0,
    marginRight: 14,
  },
  modalDate: {
    fontSize: 22,
    lineHeight: 27,
    fontWeight: "700",
    color: c.textPrimary,
    letterSpacing: -0.5,
  },
  modalSubtitle: {
    marginTop: 3,
    fontSize: 12,
    fontWeight: "600",
    color: c.textMuted,
  },
  modalCloseButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: c.surfaceSunken,
  },
  eventsScrollView: {
    flexGrow: 0,
  },
  eventsScrollContent: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 36,
  },
  eventCard: {
    backgroundColor: c.surfaceRaised,
    borderRadius: 24,
    padding: 18,
    marginBottom: 16,
    borderLeftWidth: 5,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: "#3A1410",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  highlightedEventCard: {
    backgroundColor: c.accentSoft,
    borderColor: c.accent,
  },
  eventHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 11,
  },
  eventCardTitle: {
    fontSize: 20,
    lineHeight: 25,
    fontWeight: "700",
    color: c.textPrimary,
    flex: 1,
    minWidth: 0,
    marginRight: 10,
  },
  eventActions: {
    flexDirection: "row",
    gap: 7,
  },
  eventActionButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  deleteActionButton: {
    backgroundColor: c.dangerSoft,
    borderColor: c.danger,
  },
  badgesRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 7,
    marginBottom: 12,
  },
  statusBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
  },
  statusText: {
    color: c.surface,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  eventDescription: {
    fontSize: 14,
    color: c.textSecondary,
    marginBottom: 14,
    lineHeight: 21,
  },
  eventMeta: {
    gap: 8,
    padding: 13,
    borderRadius: 18,
    backgroundColor: "rgba(93, 34, 27, 0.055)",
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  metaIcon: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
    backgroundColor: c.surfaceSunken,
  },
  metaCopy: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10,
  },
  metaLabel: {
    marginBottom: 1,
    fontSize: 12,
    fontWeight: "800",
    color: c.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  metaText: {
    fontSize: 13,
    fontWeight: "600",
    color: c.textSecondary,
  },
  categoryBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  categoryText: {
    fontSize: 12,
    fontWeight: "700",
    color: c.onPrimary,
    letterSpacing: 0.5,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: c.surface,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: "600",
    color: c.primary,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    margin: 16,
    paddingHorizontal: 28,
    paddingVertical: 42,
    borderRadius: 24,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
  },
  emptyIcon: {
    width: 78,
    height: 78,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 39,
    backgroundColor: c.surfaceSunken,
  },
  emptyText: {
    marginTop: 18,
    fontSize: 21,
    fontWeight: "800",
    color: c.textPrimary,
  },
  emptySubtitle: {
    maxWidth: 300,
    marginTop: 7,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    color: c.textMuted,
  },
  createButton: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 22,
    backgroundColor: c.primary,
    paddingHorizontal: 20,
    borderRadius: 15,
  },
  createButtonText: {
    fontSize: 15,
    fontWeight: "800",
    color: c.surface,
  },
});

export default EventCalendarScreen;
/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

// EventCalendarScreen.tsx
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { useNetworkStatus } from "@/utils/networkUtils";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { onAuthStateChanged } from "firebase/auth";
import {
    collection,
    deleteDoc,
    doc,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    where,
    writeBatch,
} from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Animated,
    AppState,
    Easing,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import ConfirmDialog from "./components/ConfirmDialog";
import DragToCloseSheet from "./components/DragToCloseSheet";
import { SkeletonBlock, SkeletonGroup } from "./components/Skeleton";
import { getEventTimingStatus, getEventTimingWindow } from "@/utils/eventTiming";
import { buildTimelineCards, groupPartsByStart, summarizeProgram, type TimelineCard as ProgramTimelineCard } from "@/utils/eventProgram";
import {
  audienceLabel,
  isLimitedAudience,
  matchesEventAudience,
  normalizeAudience,
} from "@/utils/eventAudience";
import { getUserData, isStaff, subscribeToCurrentUserProfile } from "@/utils/rbac";
import { createBroadcastEventNotifications, listEventRecipientIds } from "@/utils/notifications";
import { sendBroadcastEventPushNotifications } from "@/utils/pushNotifications";
import { showAppToast } from "@/utils/toastEvents";

type CalendarEvent = {
  id: string;
  title: string;
  subEvent?: string;
  subEvents?: string[];
  description?: string;
  date: string;
  endDate?: string;
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
  /** Where it happens — what keeps two events at the same hour apart. */
  venue?: string;
  /** Programs this is for; empty is the whole campus. Parts follow their main event. */
  forPrograms?: string[];
  /**
   * Called off, but still on the calendar so anyone looking for it sees why.
   * Deleting instead would just leave people waiting at the covered court.
   */
  cancelled?: boolean;
};

type LocalDateParts = {
  year: number;
  monthIndex: number;
  day: number;
};

type EventLifecycle =
  | "cancelled"
  | "draft"
  | "archived"
  | "published"
  | "ongoing"
  | "finished";

const getSubEvents = (event: CalendarEvent): string[] => {
  const values = Array.isArray(event.subEvents) && event.subEvents.length
    ? event.subEvents
    : event.subEvent ? [event.subEvent] : [];
  return values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim());
};

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
  if (event.category === "all-day") return event.endDate && event.endDate !== event.date
    ? `All day · through ${formatCompactDate(event.endDate)}` : "All day";

  const startTime = formatTime(event.startTime);
  const endTime = formatTime(event.endTime);

  if (startTime && endTime) return event.endDate && event.endDate !== event.date
    ? `${startTime} – ${formatCompactDate(event.endDate)}, ${endTime}`
    : `${startTime} – ${endTime}`;
  if (startTime) return startTime;
  if (endTime) return `Ends ${endTime}`;

  return "Time not set";
};

const getEventLifecycle = (
  event: CalendarEvent,
  currentTimeMs: number,
): EventLifecycle => {
  if (event.cancelled) return "cancelled";
  if (event.status === "draft") return "draft";
  if (event.status === "archived") return "archived";

  const eventWindow = getEventTimingWindow(event);
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

/** One card in the timeline — see buildTimelineCards in eventProgram.ts. */
type TimelineCard = ProgramTimelineCard<CalendarEvent>;

const sortCards = (cards: TimelineCard[]) =>
  [...cards].sort((first, second) => {
    const byDate = first.date.localeCompare(second.date);
    if (byDate !== 0) return byDate;
    const firstStart = first.dayParts[0]?.startTime || first.event.startTime || "";
    const secondStart = second.dayParts[0]?.startTime || second.event.startTime || "";
    return firstStart.localeCompare(secondStart);
  });

const groupCardsByMonth = (cards: TimelineCard[]) => {
  const grouped: { [month: string]: { [date: string]: TimelineCard[] } } = {};

  sortCards(cards).forEach((card) => {
    const monthYear = parseEventDate(card.date).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
    if (!grouped[monthYear]) grouped[monthYear] = {};
    if (!grouped[monthYear][card.date]) grouped[monthYear][card.date] = [];
    grouped[monthYear][card.date].push(card);
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
  // Stable, so the details sheet's drag gesture isn't rebuilt every render.
  const closeEventDetails = useCallback(() => setModalVisible(false), []);
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

  // The student's own program, live, so a transfer is reflected without the
  // screen being re-entered. Staff have none and are shown everything.
  const [viewerCourse, setViewerCourse] = useState("");
  useEffect(() => {
    if (!authReady) return;
    return subscribeToCurrentUserProfile(auth.currentUser, (profile) => {
      setViewerCourse(profile?.course || "");
    });
  }, [authReady, currentUserId]);
  const viewerIsStaff = isStaff(currentUserRole);
  const [audienceFilter, setAudienceFilter] = useState<"mine" | "all">("mine");
  // Which day of a multi-day program the details sheet is showing. Set to the
  // day whose card was tapped, so Day 2's card opens on Day 2.
  const [programDay, setProgramDay] = useState<string | null>(null);

  // Every question and every error on this screen goes through the app's own
  // dialog. It used to use Alert.alert, which draws the phone's grey system
  // box — the one piece of this screen that looked like a different app.
  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    singleAction?: boolean;
    icon?: keyof typeof Ionicons.glyphMap;
    onConfirm: () => void;
  } | null>(null);
  const showInfo = (title: string, description?: string) => {
    setDialog({
      title,
      description,
      confirmText: "OK",
      singleAction: true,
      destructive: false,
      onConfirm: () => setDialog(null),
    });
  };
  const showConfirm = (options: {
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    icon?: keyof typeof Ionicons.glyphMap;
    onConfirm: () => void;
  }) => {
    setDialog({
      ...options,
      onConfirm: () => {
        setDialog(null);
        options.onConfirm();
      },
    });
  };

  // Who each event is for. A part follows its main event, so an admin sets the
  // audience once and both are read the same way.
  const audienceByEventId = useMemo(() => {
    const declared = new Map<string, string[]>();
    events.forEach((event) => declared.set(event.id, normalizeAudience(event.forPrograms)));
    const resolved = new Map<string, string[]>();
    events.forEach((event) => {
      const parentId = String(event.parentEventId || "");
      resolved.set(event.id, (parentId ? declared.get(parentId) : declared.get(event.id)) ?? []);
    });
    return resolved;
  }, [events]);

  const isForViewer = useCallback(
    (event: CalendarEvent) =>
      matchesEventAudience(audienceByEventId.get(event.id) ?? [], {
        course: viewerCourse,
        isStaff: viewerIsStaff,
      }),
    [audienceByEventId, viewerCourse, viewerIsStaff],
  );

  // A student with a program can narrow the calendar to their own. Nothing is
  // hidden — the rest are one tap away — and staff never see the switch.
  const canFilterByProgram = !viewerIsStaff && Boolean(viewerCourse);
  const visibleEvents = useMemo(
    () =>
      canFilterByProgram && audienceFilter === "mine" ? events.filter(isForViewer) : events,
    [audienceFilter, canFilterByProgram, events, isForViewer],
  );
  const hiddenByProgramCount = events.length - visibleEvents.length;

  // Newest first: the recent past is what anyone actually looks for.
  const pastEvents = useMemo(
    () => visibleEvents.filter((event) => event.date < todayKey).slice().reverse(),
    [visibleEvents, todayKey],
  );
  // Parts are folded into their main event here, so a finished Intramurals is
  // one row in the history instead of six.
  const pastTopLevel = useMemo(
    () => pastEvents.filter((event) => !event.parentEventId),
    [pastEvents],
  );
  // The past, filed by month — "September 2026 · 4 events" — so a long history
  // is a short list of months to open, not one scroll of everything.
  const pastMonths = useMemo(() => {
    const months: { key: string; label: string; events: CalendarEvent[] }[] = [];
    pastTopLevel.forEach((event) => {
      const key = event.date.slice(0, 7);
      let month = months[months.length - 1];
      if (!month || month.key !== key) {
        month = {
          key,
          label: parseEventDate(event.date).toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          }),
          events: [],
        };
        months.push(month);
      }
      month.events.push(event);
    });
    return months;
  }, [pastTopLevel]);
  // Which months are open. The most recent starts open; the rest wait.
  const [openPastMonths, setOpenPastMonths] = useState<Record<string, boolean>>({});
  // Parts are folded into the main event's card for their own day, so the
  // calendar never shows "Siglakas 2027" and "Foot parade" side by side as if
  // they were two separate events.
  const timelineCards = useMemo(() => buildTimelineCards(visibleEvents), [visibleEvents]);

  const upcomingCards = useMemo(
    () => sortCards(timelineCards.filter((card) => card.date >= todayKey)),
    [timelineCards, todayKey],
  );

  const groupedEvents = useMemo(
    () => groupCardsByMonth(upcomingCards),
    [upcomingCards],
  );
  const revealAnimation = useRef(new Animated.Value(0)).current;

  // "Coming up" answers the same question as the agenda below it, so it is
  // counted from the same cards. It used to scan every document, which meant
  // the next thing up was usually a part — "Group 1" with nothing to say which
  // event it belonged to.
  const calendarInsights = useMemo(() => {
    const nextCard = upcomingCards.find((card) => {
      if (card.event.cancelled) return false;
      if (card.totalDays > 0) {
        // A main event's day, still to come or part-way through.
        return summarizeProgram(card.dayParts, currentTimeMs).state !== "done";
      }
      return getEventLifecycle(card.event, currentTimeMs) === "published";
    });

    return { nextCard: nextCard || null };
  }, [currentTimeMs, upcomingCards]);

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
  // this screen to answer. Never filtered: another program's event is shown
  // below the student's own rather than kept from them.
  const happeningNow = useMemo(
    () =>
      events.filter(
        (event) =>
          !event.cancelled &&
          getEventLifecycle(event, currentTimeMs) === "ongoing" &&
          // A main event is a container, not a session. During Intramurals the
          // useful answer is the game, not the week — so only leaves appear
          // here, and they name their parent as context.
          !partsByParent.has(event.id),
      ),
    [events, currentTimeMs, partsByParent],
  );
  const happeningMine = useMemo(() => happeningNow.filter(isForViewer), [happeningNow, isForViewer]);
  const happeningOthers = useMemo(
    () => happeningNow.filter((event) => !isForViewer(event)),
    [happeningNow, isForViewer],
  );

  // The span a main event covers, for the date range on its card. The day
  // counter itself lives on each timeline card, which knows its own day.
  const umbrellaSpans = useMemo(() => {
    const spans = new Map<string, { start: string; end: string }>();
    partsByParent.forEach((parts, parentId) => {
      const days = [...new Set(parts.map((part) => part.date))].sort();
      if (days.length === 0) return;
      spans.set(parentId, { start: days[0], end: days[days.length - 1] });
    });
    return spans;
  }, [partsByParent]);

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

    setProgramDay(targetEvent.date);
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
    setProgramDay(date);
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
      showAppToast({ message: "You're offline — events can't be created right now." });
      return;
    }

    router.push("/CreateEventScreen");
  };

  const handleDeleteEvent = async (eventId: string) => {
    if (isOffline) {
      showAppToast({ message: "You're offline — events can't be deleted right now." });
      return;
    }

    // Firestore has no cascade delete, so the parts have to go with the main
    // event. Leaving them behind would strand sessions pointing at an event
    // that no longer exists.
    const parts = partsByParent.get(eventId) || [];
    const message = parts.length
      ? `This will also delete its ${parts.length} ${parts.length === 1 ? "part" : "parts"}. This can't be undone.`
      : "Are you sure you want to delete this event?";

    showConfirm({
      title: parts.length ? "Delete event and its parts?" : "Delete event",
      description: message,
      confirmText: parts.length ? `Delete all ${parts.length + 1}` : "Delete",
      cancelText: "Cancel",
      destructive: true,
      onConfirm: async () => {
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
          showAppToast({
            message: parts.length
              ? `Event deleted, with its ${parts.length} ${parts.length === 1 ? "part" : "parts"}`
              : "Event deleted",
          });
        } catch (error) {
          console.error("Error deleting event:", error);
          showInfo("Couldn't delete the event", "Check your connection and try again.");
        }
      },
    });
  };

  /**
   * Tells this event's audience what happened to it. Used for a cancellation
   * and for putting one back on — the two changes people plan around.
   */
  const sendEventNotice = async (event: CalendarEvent, headline: string, message: string) => {
    if (!currentUserId) return;
    try {
      const profile = await getUserData(currentUserId);
      const actorName = profile
        ? `${profile.firstname} ${profile.lastname}`.trim() || "BondED"
        : "BondED";
      const recipientIds = await listEventRecipientIds({
        forPrograms: audienceByEventId.get(event.id) || [],
        excludeUserIds: [currentUserId],
      });
      await Promise.allSettled([
        createBroadcastEventNotifications({
          actor: { id: currentUserId, name: actorName, profileImage: profile?.profileImage || null },
          entityId: event.id,
          title: event.title,
          description: event.description,
          eventDate: event.date,
          recipientIds,
          message,
        }),
        sendBroadcastEventPushNotifications({
          entityId: event.id,
          title: event.title,
          description: event.description,
          eventDate: event.date,
          excludeUserIds: [currentUserId],
          onlyUserIds: recipientIds,
          headline,
        }),
      ]);
      showAppToast({ message: "Notice sent" });
    } catch (error) {
      console.error("Error sending the event notice:", error);
      showInfo("Couldn't send the notice", "The change is saved. You can try again from the event.");
    }
  };

  /** Marks an event — and everything under it — called off, or back on. */
  const setEventCancelled = async (event: CalendarEvent, cancelled: boolean) => {
    const parts = partsByParent.get(event.id) || [];
    const batch = writeBatch(db);
    const change = { cancelled, cancelledAt: cancelled ? serverTimestamp() : null };
    batch.update(doc(db, "events", event.id), change);
    parts.forEach((part) => batch.update(doc(db, "events", part.id), change));
    await batch.commit();
    return parts.length;
  };

  const handleCancelEvent = (event: CalendarEvent) => {
    if (!canManageEvents()) return;
    if (isOffline) {
      showAppToast({ message: "You're offline — events can't be cancelled right now." });
      return;
    }
    const parts = partsByParent.get(event.id) || [];
    showConfirm({
      title: "Cancel this event?",
      description: parts.length
        ? `It stays on the calendar marked Cancelled, along with its ${parts.length} ${parts.length === 1 ? "part" : "parts"}. You can put it back later.`
        : "It stays on the calendar marked Cancelled, so anyone looking for it sees why. You can put it back later.",
      confirmText: "Cancel event",
      cancelText: "Keep it",
      destructive: true,
      onConfirm: async () => {
        try {
          await setEventCancelled(event, true);
          setModalVisible(false);
          showAppToast({ message: `${event.title} marked cancelled` });
          showConfirm({
            title: "Tell everyone?",
            description: `"Cancelled: ${event.title} · ${formatCompactDate(event.date)}"\n\nThis goes to everyone this event is for.`,
            confirmText: "Send notice",
            cancelText: "Don't send",
            destructive: false,
            onConfirm: () =>
              void sendEventNotice(event, `Cancelled: ${event.title}`, "cancelled an event"),
          });
        } catch (error) {
          console.error("Error cancelling event:", error);
          showInfo("Couldn't cancel the event", "Check your connection and try again.");
        }
      },
    });
  };

  const handleRestoreEvent = (event: CalendarEvent) => {
    if (!canManageEvents()) return;
    if (isOffline) {
      showAppToast({ message: "You're offline — events can't be restored right now." });
      return;
    }
    showConfirm({
      title: "Put this event back on?",
      description: "It goes back to a normal event, with its times as they were.",
      confirmText: "Restore",
      cancelText: "Leave cancelled",
      destructive: false,
      onConfirm: async () => {
        try {
          await setEventCancelled(event, false);
          setModalVisible(false);
          showAppToast({ message: `${event.title} is back on` });
          showConfirm({
            title: "Tell everyone?",
            description: `"${event.title} is back on · ${formatCompactDate(event.date)}"\n\nThis goes to everyone this event is for.`,
            confirmText: "Send notice",
            cancelText: "Don't send",
            destructive: false,
            onConfirm: () =>
              void sendEventNotice(event, `${event.title} is back on`, "put this event back on"),
          });
        } catch (error) {
          console.error("Error restoring event:", error);
          showInfo("Couldn't restore the event", "Check your connection and try again.");
        }
      },
    });
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

  const getStatusDetails = (event: CalendarEvent) => {
    const lifecycle = getEventLifecycle(event, currentTimeMs);
    const timing = getEventTimingStatus(event, currentTimeMs);

    if (lifecycle === "cancelled") {
      return {
        lifecycle,
        label: "Cancelled",
        supportingText: timing?.status === "ended" ? "" : "This is not happening",
        icon: "close-circle-outline" as const,
        color: theme.danger,
        surfaceColor: theme.dangerSoft,
        borderColor: theme.danger,
      };
    }

    if (lifecycle === "draft") {
      return {
        lifecycle,
        label: "DRAFT",
        supportingText: "",
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
        supportingText: "",
        icon: "archive-outline" as const,
        color: theme.textSecondary,
        surfaceColor: theme.surfaceSunken,
        borderColor: theme.borderStrong,
      };
    }

    if (lifecycle === "ongoing") {
      return {
        lifecycle,
        label: "Ongoing",
        supportingText: timing?.supportingText || "",
        icon: "radio-button-on" as const,
        color: theme.success,
        surfaceColor: theme.successSoft,
        borderColor: theme.success,
      };
    }

    if (lifecycle === "finished") {
      return {
        lifecycle,
        label: "Ended",
        supportingText: timing?.supportingText || "",
        icon: "checkmark-done-circle-outline" as const,
        color: theme.textMuted,
        surfaceColor: theme.surfaceSunken,
        borderColor: theme.border,
      };
    }

    if (timing?.status === "starting-soon") {
      return {
        lifecycle,
        label: timing.label,
        supportingText: timing.supportingText,
        icon: "time-outline" as const,
        color: theme.warning,
        surfaceColor: theme.surfaceRaised,
        borderColor: theme.border,
      };
    }

    return {
      lifecycle,
      label: "Upcoming",
      supportingText: timing?.supportingText || "",
      icon: "calendar-outline" as const,
      color: theme.primary,
      surfaceColor: theme.surfaceRaised,
      borderColor: theme.border,
    };
  };

  const handleAddPart = (mainEvent: CalendarEvent, day?: string) => {
    if (!canManageEvents()) return;
    if (isOffline) {
      showAppToast({ message: "You're offline — parts can't be added right now." });
      return;
    }
    setModalVisible(false);
    router.push({
      pathname: "/CreateEventScreen",
      params: { parentEventId: mainEvent.id, date: day || mainEvent.date },
    });
  };

  /**
   * The Now / Up next strip on a main event's card: what is running inside it
   * and what follows. Several parts can run at once in different venues, so it
   * counts them and names them rather than picking the first and hiding the
   * rest.
   */
  const renderProgramStrip = (parts: CalendarEvent[]) => {
    const program = summarizeProgram(parts, currentTimeMs);
    if (program.state === "empty" || program.state === "done") return null;

    const whereLabel = (part: CalendarEvent) =>
      part.venue?.trim() ? ` · ${part.venue.trim()}` : "";
    const endsLabel = (part: CalendarEvent) =>
      getEventTimingStatus(part, currentTimeMs)?.supportingText || formatEventTime(part);
    const startsLabel = (part: CalendarEvent) =>
      `${part.date === todayKey ? "" : `${formatCompactDate(part.date)}, `}${formatEventTime(part)}`;

    if (program.state === "many") {
      const shown = program.running.slice(0, 2);
      return (
        <View style={styles.stripBox}>
          <View style={styles.stripRow}>
            <View style={styles.stripDotOn} />
            <Text style={[styles.stripKey, styles.stripKeyOn]}>NOW</Text>
            <Text style={styles.stripNowText}>{program.running.length} running</Text>
          </View>
          {shown.map((part) => (
            <Text key={part.id} style={styles.stripSub} numberOfLines={1}>
              {part.title}
              <Text style={styles.stripWhere}>{whereLabel(part)}</Text>
              <Text style={styles.stripMeta}>{` · ${endsLabel(part)}`}</Text>
            </Text>
          ))}
          {program.running.length > shown.length && (
            <Text style={styles.stripMore}>
              +{program.running.length - shown.length} more — tap to see all
            </Text>
          )}
        </View>
      );
    }

    const running = program.state === "now";
    const highlight = running ? program.running[0] : program.next;
    if (!highlight) return null;

    return (
      <View style={styles.stripBox}>
        <View style={styles.stripRow}>
          <View style={running ? styles.stripDotOn : styles.stripDotOff} />
          <Text style={[styles.stripKey, running && styles.stripKeyOn]}>
            {running ? "NOW" : program.state === "before" ? "STARTS" : "NEXT"}
          </Text>
          <Text style={running ? styles.stripNowText : styles.stripText} numberOfLines={1}>
            {highlight.title}
            <Text style={styles.stripWhere}>{whereLabel(highlight)}</Text>
            <Text style={styles.stripMeta}>
              {` · ${running ? endsLabel(highlight) : startsLabel(highlight)}`}
            </Text>
          </Text>
        </View>
        {running && program.next && (
          <Text style={styles.stripSub} numberOfLines={1}>
            Up next: {program.next.title}
            <Text style={styles.stripMeta}>{` · ${startsLabel(program.next)}`}</Text>
          </Text>
        )}
      </View>
    );
  };

  const handleEditEvent = (event: CalendarEvent) => {
    if (!canEditEvent(event)) return;

    if (isOffline) {
      showAppToast({ message: "You're offline — events can't be edited right now." });
      return;
    }

    setModalVisible(false);
    router.push({ pathname: "/CreateEventScreen", params: { eventId: event.id } });
  };

  const renderListHeader = () => {
    const nextCard = calendarInsights.nextCard;
    const nextEvent = nextCard?.event;
    // A main event leads with its own name and uses its first part of that day
    // as the detail: "Sep 26 · starts 8:00 AM with Group 1".
    const nextFirstPart = nextCard?.dayParts[0];
    const nextVenue = nextEvent?.venue?.trim();
    const nextDetail = nextCard
      ? nextFirstPart
        ? `${formatCompactDate(nextCard.date)} · starts ${formatTime(nextFirstPart.startTime)} with ${nextFirstPart.title}`
        : `${formatCompactDate(nextCard.date)} · ${formatEventTime(nextEvent!)}${nextVenue ? ` · ${nextVenue}` : ""}`
      : "";

    /** One line of "Happening now": what it is, where, and how long is left. */
    const renderNowRow = (event: CalendarEvent, fromAnotherProgram = false) => {
      const subEvents = getSubEvents(event);
      const parentTitle = event.parentEventId
        ? eventTitleById.get(String(event.parentEventId))
        : undefined;
      const endsAt = formatTime(event.endTime);
      const venue = event.venue?.trim();
      const context = venue
        ? `${venue} · `
        : subEvents.length
          ? `${subEvents[0]}${subEvents.length > 1 ? ` +${subEvents.length - 1} more` : ""} · `
          : parentTitle
            ? `${parentTitle} · `
            : "";

      return (
        <TouchableOpacity
          key={event.id}
          style={[styles.nowRow, fromAnotherProgram && styles.nowRowOther]}
          activeOpacity={0.75}
          onPress={() => handleViewMorePress(event.date, [event])}
          accessibilityRole="button"
          accessibilityLabel={`Happening now: ${event.title}`}
        >
          <View style={[styles.nowDot, fromAnotherProgram && styles.nowDotOther]} />
          <View style={styles.nowRowCopy}>
            <Text style={styles.nowTitle} numberOfLines={1}>
              {event.title}
            </Text>
            <Text style={styles.nowMeta} numberOfLines={1}>
              {venue && parentTitle ? `${parentTitle} · ` : ""}
              {context}
              {getEventTimingStatus(event, currentTimeMs)?.supportingText || (endsAt ? `until ${endsAt}` : "all day")}
            </Text>
          </View>
          {fromAnotherProgram && (
            <Text style={styles.nowOtherTag} numberOfLines={1}>
              {audienceLabel(audienceByEventId.get(event.id))}
            </Text>
          )}
        </TouchableOpacity>
      );
    };

    return (
      <>
        {/* The first thing on screen answers "what is on right now?" rather
            than decorating the page. Parts count here too, so during
            Intramurals a student sees the game, not just the week. */}
        <View style={styles.nowPanel}>
          <Text style={styles.nowEyebrow}>
            {new Date(currentTimeMs).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }).toUpperCase()}
          </Text>
          <View style={styles.nowHeaderRow}>
            <Text style={styles.nowHeading}>
              {happeningNow.length > 0 ? "Happening now" : "Coming up"}
            </Text>
            {happeningNow.length > 0 && (
              <View style={styles.nowLivePill}>
                <View style={styles.nowLiveDot} />
                <Text style={styles.nowLiveText}>LIVE</Text>
              </View>
            )}
          </View>

          {happeningNow.length > 0 ? (
            <>
              {happeningMine.length > 0 && happeningOthers.length > 0 && (
                <Text style={styles.nowGroupLabel}>YOURS</Text>
              )}
              {happeningMine.map((event) => renderNowRow(event))}
              {happeningOthers.length > 0 && (
                <>
                  <Text style={styles.nowGroupLabel}>ALSO ON CAMPUS</Text>
                  {happeningOthers.map((event) => renderNowRow(event, true))}
                </>
              )}
            </>
          ) : nextCard && nextEvent ? (
            <TouchableOpacity
              style={styles.nowRow}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={`View upcoming event ${nextEvent.title}, ${nextDetail}`}
              onPress={() => handleViewMorePress(nextCard.date, [nextEvent])}
            >
              <View style={styles.nowUpcomingIcon}><Ionicons name="calendar-outline" size={18} color={theme.primary} /></View>
              <View style={styles.nowRowCopy}>
                <Text style={styles.nowTitle} numberOfLines={2}>{nextEvent.title}</Text>
                <Text style={styles.nowMeta} numberOfLines={2}>{nextDetail}</Text>
              </View>
              <Ionicons name="arrow-forward" size={18} color={theme.primary} />
            </TouchableOpacity>
          ) : <Text style={styles.nowEmpty}>{events.length ? "Nothing coming up right now. Past events are below." : "No events on the calendar yet."}</Text>}

          {/* Only what can be acted on. A count of everything on the
              calendar, past included, told nobody anything — and the agenda
              below already says how much is ahead. */}
          {draftEvents.length > 0 && (
            <View style={styles.nowStatsRow}>
              <Text style={styles.nowStat}>
                {draftEvents.length} draft{draftEvents.length === 1 ? "" : "s"} waiting
              </Text>
            </View>
          )}
        </View>

        <View style={styles.agendaHeader}>
          <View>
            <Text style={styles.agendaEyebrow}>EXPLORE THE CALENDAR</Text>
            <Text style={styles.agendaTitle}>Your agenda</Text>
          </View>
          <View style={styles.agendaCount}><Text style={styles.agendaCountText}>{upcomingCards.length} ahead</Text></View>
        </View>

        {/* Other programs hold their own events. This puts the student's own
            first without hiding anything: "All campus" is one tap. */}
        {canFilterByProgram && (
          <View style={styles.filterRow}>
            {(["mine", "all"] as const).map((option) => {
              const active = audienceFilter === option;
              return (
                <TouchableOpacity
                  key={option}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  activeOpacity={0.82}
                  onPress={() => setAudienceFilter(option)}
                  style={[styles.filterChip, active && styles.filterChipOn]}
                >
                  <Text style={[styles.filterChipText, active && styles.filterChipTextOn]}>
                    {option === "mine" ? `My program · ${viewerCourse}` : "All campus"}
                  </Text>
                </TouchableOpacity>
              );
            })}
            {audienceFilter === "mine" && hiddenByProgramCount > 0 && (
              <Text style={styles.filterNote}>
                {hiddenByProgramCount} from other programs
              </Text>
            )}
          </View>
        )}

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
              return (
                <View key={event.id} style={styles.draftCard}>
                  <TouchableOpacity
                    style={styles.draftCardBody}
                    onPress={() => handleViewMorePress(event.date, [event])}
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
          const cardsForDate = groupedEvents[item][date];
          const calendarDate = parseEventDate(date);
          const isToday = date === todayKey;

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
              </Text>

              {cardsForDate.map((card) => {
                const event = card.event;
                const subEvents = getSubEvents(event);
                const statusDetails = getStatusDetails(event);
                const isDone = statusDetails.lifecycle === "finished";
                // A main event has parts; it shows a date range rather than a
                // clock, which is what tells a student it is the big one.
                const span = card.totalDays > 0 ? umbrellaSpans.get(event.id) : undefined;
                const partCount = card.dayParts.length;
                const parentTitle = event.parentEventId
                  ? eventTitleById.get(String(event.parentEventId))
                  : undefined;

                return (
                  <TouchableOpacity
                    key={card.key}
                    style={[
                      styles.rowCard,
                      isDone && styles.rowCardDone,
                      !!span && styles.rowCardMain,
                    ]}
                    activeOpacity={0.75}
                    onPress={() => handleViewMorePress(date, [event])}
                    accessibilityRole="button"
                    accessibilityLabel={
                      card.totalDays > 1
                        ? `${event.title}, day ${card.dayIndex} of ${card.totalDays}, ${partCount} ${partCount === 1 ? "part" : "parts"}`
                        : `${event.title}, ${formatEventTime(event)}`
                    }
                    accessibilityHint="Opens event details"
                  >
                    <View style={[styles.rowIconOrb, { borderColor: statusDetails.color, backgroundColor: statusDetails.surfaceColor }]}>
                      <Ionicons name={event.category === "all-day" ? "sunny-outline" : "calendar-outline"} size={19} color={statusDetails.color} />
                    </View>

                    <View style={styles.rowBody}>
                      <Text
                        style={[styles.rowName, event.cancelled && styles.cancelledTitle]}
                        numberOfLines={2}
                      >
                        {event.title}
                      </Text>
                      {/* Whose event this is, so a student never has to guess
                          whether a 1:00 PM card is meant for them. */}
                      {isLimitedAudience(audienceByEventId.get(event.id)) && (
                        <View style={styles.audienceChip}>
                          <Ionicons name="people-outline" size={11} color={theme.primary} />
                          <Text style={styles.audienceChipText} numberOfLines={1}>
                            {audienceLabel(audienceByEventId.get(event.id))}
                          </Text>
                        </View>
                      )}
                      {subEvents.length > 0 && (
                        <Text style={styles.rowContext} numberOfLines={2}>
                          {subEvents.slice(0, 2).join(" · ")}
                          {subEvents.length > 2 ? ` · +${subEvents.length - 2} more` : ""}
                        </Text>
                      )}
                      <View style={styles.rowTopRow}>
                        <Text
                          style={[styles.rowTime, event.cancelled && styles.cancelledTime]}
                          numberOfLines={1}
                        >
                          {span
                            ? `${formatCompactDate(span.start)} – ${formatCompactDate(span.end)}`
                            : formatEventTime(event)}
                          {event.venue?.trim() ? ` · ${event.venue.trim()}` : ""}
                        </Text>

                        {card.totalDays > 1 ? (
                          <View style={styles.dayBadge}>
                            <Text style={styles.dayBadgeText}>
                              Day {card.dayIndex}/{card.totalDays}
                            </Text>
                          </View>
                        ) : null}

                        {event.status === "draft" ? (
                          <Text style={styles.draftTag}>Draft</Text>
                        ) : null}
                      </View>

                      {event.status !== "draft" && (
                        <View style={styles.rowStatusLine}>
                          <View style={[styles.rowStatusPill, { backgroundColor: statusDetails.surfaceColor, borderColor: statusDetails.color }]}>
                            <Ionicons name={statusDetails.icon} size={13} color={statusDetails.color} />
                            <Text style={[styles.rowStatusText, { color: statusDetails.color }]}>{statusDetails.label}</Text>
                          </View>
                          {!!statusDetails.supportingText && (
                            <Text style={styles.rowContext} numberOfLines={1}>{statusDetails.supportingText}</Text>
                          )}
                        </View>
                      )}

                      {card.totalDays > 0 ? (
                        <Text style={styles.rowContext} numberOfLines={1}>
                          {partCount} {partCount === 1 ? "part" : "parts"} today
                          {card.totalDays > 1 ? ` · day ${card.dayIndex} of ${card.totalDays}` : ""}
                        </Text>
                      ) : parentTitle ? (
                        <Text style={styles.rowContext} numberOfLines={1}>
                          {parentTitle}
                        </Text>
                      ) : null}

                      {/* Only this day's parts: Day 2's card counts down Day 2. */}
                      {card.totalDays > 0 ? renderProgramStrip(card.dayParts) : null}
                    </View>

                    {!canEditEvent(event) && <Ionicons name="chevron-forward" size={17} color={theme.textMuted} style={styles.rowChevron} />}

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
      <StatusBar style="light" />
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
            <Ionicons name="arrow-back" size={20} color={theme.onChrome} />
          </TouchableOpacity>

          <View style={styles.headerCopy}>
            <Text style={styles.headerEyebrow}>BONDED • CAMPUS LIFE</Text>
            <Text style={styles.headerTitle} numberOfLines={1}>
              Campus events
            </Text>
            <Text style={styles.headerSubtitle}>Your plans, all in one place</Text>
          </View>

          {canManageEvents() && (
            <TouchableOpacity
              style={styles.headerCreateButton}
              onPress={handleCreateEvent}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Create a new event"
            >
              <Ionicons name="add" size={19} color={theme.onAccent} />
              <Text style={styles.headerCreateText}>New</Text>
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
        // Drawn in the calendar's own month, day and event-row styles, so
        // the events land exactly where the placeholders were.
        <SkeletonGroup style={styles.listContent}>
          <View style={styles.monthSection}>
            <SkeletonBlock width={90} height={11} style={{ marginTop: 20, marginBottom: 16 }} />
            {[2, 1, 1].map((rows, dayIndex) => (
              <View key={dayIndex} style={styles.daySection}>
                <SkeletonBlock width={dayIndex ? 150 : 190} height={12} style={{ marginBottom: 10 }} />
                {Array.from({ length: rows }).map((_, index) => (
                  <View key={index} style={styles.rowCard}>
                    <SkeletonBlock width={42} height={42} radius={14} style={{ marginLeft: 16 }} />
                    <View style={styles.rowBody}>
                      <SkeletonBlock width="68%" height={16} />
                      <SkeletonBlock width="42%" height={11} style={{ marginTop: 8 }} />
                      <SkeletonBlock width={84} height={22} radius={12} style={{ marginTop: 8 }} />
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </SkeletonGroup>
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
                    {pastMonths.map((month, monthIndex) => {
                      const open = openPastMonths[month.key] ?? monthIndex === 0;
                      const previousYear = monthIndex > 0 ? pastMonths[monthIndex - 1].key.slice(0, 4) : null;
                      const year = month.key.slice(0, 4);
                      return (
                        <View key={month.key}>
                          {/* A quiet line where one year gives way to the one before. */}
                          {previousYear && previousYear !== year && (
                            <View style={styles.pastYearRow}>
                              <View style={styles.pastYearLine} />
                              <Text style={styles.pastYearText}>{year}</Text>
                              <View style={styles.pastYearLine} />
                            </View>
                          )}
                          <TouchableOpacity
                            style={styles.pastMonthHeader}
                            activeOpacity={0.75}
                            onPress={() =>
                              setOpenPastMonths((current) => ({ ...current, [month.key]: !open }))
                            }
                            accessibilityRole="button"
                            accessibilityState={{ expanded: open }}
                            accessibilityLabel={`${month.label}, ${month.events.length} ${month.events.length === 1 ? "event" : "events"}`}
                          >
                            <Text style={styles.pastMonthLabel}>{month.label.toUpperCase()}</Text>
                            <Text style={styles.pastMonthCount}>
                              {month.events.length} {month.events.length === 1 ? "event" : "events"}
                            </Text>
                            <Ionicons
                              name={open ? "chevron-up" : "chevron-down"}
                              size={16}
                              color={theme.textMuted}
                            />
                          </TouchableOpacity>

                          {open &&
                            month.events.map((event) => {
                              const partCount = partSummaries.get(event.id)?.parts.length || 0;
                              const day = parseEventDate(event.date);
                              return (
                                <TouchableOpacity
                                  key={event.id}
                                  style={styles.pastRow}
                                  activeOpacity={0.75}
                                  onPress={() => handleViewMorePress(event.date, [event])}
                                  accessibilityRole="button"
                                  accessibilityLabel={`${event.title}, ${formatCompactDate(event.date)}${event.cancelled ? ", cancelled" : ""}`}
                                >
                                  <View style={styles.pastDateBlock}>
                                    <Text style={styles.pastDateDay}>{day.getDate()}</Text>
                                    <Text style={styles.pastDateMonth}>
                                      {day.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}
                                    </Text>
                                  </View>
                                  <View style={styles.pastRowCopy}>
                                    <Text
                                      style={[styles.pastRowTitle, event.cancelled && styles.cancelledTitle]}
                                      numberOfLines={1}
                                    >
                                      {event.title}
                                    </Text>
                                    <Text style={styles.pastRowMeta} numberOfLines={1}>
                                      {day.toLocaleDateString("en-US", { weekday: "long" })}
                                      {event.category !== "all-day" && event.startTime ? ` · ${formatTime(event.startTime)}` : ""}
                                      {partCount > 0
                                        ? ` · ${partCount} ${partCount === 1 ? "part" : "parts"}`
                                        : ""}
                                    </Text>
                                  </View>
                                  {event.cancelled && (
                                    <View style={styles.pastCancelledPill}>
                                      <Text style={styles.pastCancelledText}>Cancelled</Text>
                                    </View>
                                  )}
                                </TouchableOpacity>
                              );
                            })}
                        </View>
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
                    size={24}
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

      {/* Event details — drag the top down to close. */}
      <DragToCloseSheet
        visible={modalVisible}
        onClose={closeEventDetails}
        handleColor={theme.borderStrong}
        backdropColor={theme.scrim}
        closeLabel="Close event details"
        sheetStyle={[styles.modalContent, styles.draggableSheet]}
        header={
          <>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderCopy}>
                <Text style={styles.modalDate} numberOfLines={2}>
                  {selectedDate ? formatDate(selectedDate) : ""}
                </Text>
                <Text style={styles.modalSubtitle}>
                  {selectedEvents.length === 1 ? "EVENT DETAILS" : `${selectedEvents.length} EVENTS`}
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
          </>
        }
      >
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
            const parts = partSummaries.get(event.id)?.parts || [];
            // Five days of Siglakas is five programs, not one long list. The
            // day whose card was tapped opens first; today, otherwise the
            // first day still to come.
            const partDays = [...new Set(parts.map((part) => part.date))].sort();
            const activeDay =
              (programDay && partDays.includes(programDay) && programDay) ||
              (selectedDate && partDays.includes(selectedDate) && selectedDate) ||
              partDays.find((day) => day >= todayKey) ||
              partDays[partDays.length - 1] ||
              "";
            const dayParts = parts.filter((part) => part.date === activeDay);
            const eventAudience = audienceByEventId.get(event.id) || [];
            const canAddParts = canManageEvents() && !event.parentEventId;

            return (
            <View
              key={event.id}
              style={[
                styles.eventCard,
                {
                  backgroundColor: theme.surfaceRaised,
                  borderColor: theme.border,
                  borderLeftColor: statusDetails.color,
                },
                resolvedEventId === event.id && styles.highlightedEventCard,
              ]}
            >
              <View style={styles.eventHeader}>
                <Text
                  style={[styles.eventCardTitle, event.cancelled && styles.cancelledTitle]}
                >
                  {event.title}
                </Text>
                <View style={styles.eventActions}>
                  {/* Called off is not the same as never happened: cancelling
                      keeps it on the calendar, where people go looking. */}
                  {canManageEvents() && event.status !== "draft" && !event.parentEventId && (
                    <TouchableOpacity
                      style={styles.editIconButton}
                      onPress={() =>
                        event.cancelled ? handleRestoreEvent(event) : handleCancelEvent(event)
                      }
                      activeOpacity={0.7}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={
                        event.cancelled ? `Put ${event.title} back on` : `Cancel ${event.title}`
                      }
                    >
                      <Ionicons
                        name={event.cancelled ? "refresh-outline" : "close-circle-outline"}
                        size={19}
                        color={event.cancelled ? theme.success : theme.danger}
                      />
                    </TouchableOpacity>
                  )}
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
              {getSubEvents(event).length > 0 && (
                <View style={styles.subEventList}>
                  <Text style={styles.subEventListLabel}>EVENT PROGRAM</Text>
                  {getSubEvents(event).map((subEvent, index) => (
                    <View key={`${event.id}-sub-${index}`} style={styles.subEventListRow}>
                      <View style={styles.subEventListDot} />
                      <Text style={styles.subEventListText}>{subEvent}</Text>
                    </View>
                  ))}
                </View>
              )}

              <View style={styles.badgesRow}>
                <View
                  style={[
                    styles.statusBadge,
                    { backgroundColor: statusDetails.surfaceColor, borderColor: statusDetails.color, borderWidth: 1 },
                  ]}
                >
                  <Ionicons
                    name={statusDetails.icon}
                    size={12}
                    color={statusDetails.color}
                  />
                  <Text style={[styles.statusText, { color: statusDetails.color }]}>{statusDetails.label}</Text>
                </View>
                {isLimitedAudience(eventAudience) && (
                  <View style={styles.audienceChip}>
                    <Ionicons name="people-outline" size={11} color={theme.primary} />
                    <Text style={styles.audienceChipText} numberOfLines={1}>
                      {audienceLabel(eventAudience)}
                    </Text>
                  </View>
                )}
                {!!event.venue?.trim() && (
                  <View style={styles.venueChip}>
                    <Ionicons name="location-outline" size={11} color={theme.textSecondary} />
                    <Text style={styles.venueChipText} numberOfLines={1}>
                      {event.venue.trim()}
                    </Text>
                  </View>
                )}
              </View>
              {!!statusDetails.supportingText && (
                <Text style={styles.statusSupportText}>{statusDetails.supportingText}</Text>
              )}

              {/* The program: every part in time order, with anything that
                  starts at the same moment kept together. Three games at once
                  are three places to be, not a queue. */}
              {(parts.length > 0 || canAddParts) && (
                <View style={styles.modalPartsBox}>
                  <View style={styles.modalPartsHeader}>
                    <Text style={styles.modalPartsHeading}>
                      {parts.length} {parts.length === 1 ? "PART" : "PARTS"}
                    </Text>
                    {canAddParts && (
                      <TouchableOpacity
                        style={styles.addPartButton}
                        onPress={() => handleAddPart(event, activeDay || selectedDate || event.date)}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityLabel={`Add a part to ${event.title}`}
                      >
                        <Ionicons name="add" size={14} color={theme.accent} />
                        <Text style={styles.addPartText}>Add part</Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  {/* One chip per day that has parts. A single-day program
                      needs no chips, so it doesn't get any. */}
                  {partDays.length > 1 && (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.dayTabs}
                    >
                      {partDays.map((day, index) => {
                        const active = day === activeDay;
                        const count = parts.filter((part) => part.date === day).length;
                        return (
                          <TouchableOpacity
                            key={day}
                            style={[styles.dayTab, active && styles.dayTabOn]}
                            onPress={() => setProgramDay(day)}
                            activeOpacity={0.82}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            accessibilityLabel={`Day ${index + 1}, ${formatCompactDate(day)}, ${count} ${count === 1 ? "part" : "parts"}`}
                          >
                            <Text style={[styles.dayTabTitle, active && styles.dayTabTitleOn]}>
                              Day {index + 1}
                            </Text>
                            <Text style={[styles.dayTabMeta, active && styles.dayTabMetaOn]}>
                              {formatCompactDate(day)}
                              {day === todayKey ? " · today" : ""}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  )}

                  {partDays.length > 1 && !!activeDay && (
                    <Text style={styles.modalDayHeading}>
                      {parseEventDate(activeDay).toLocaleDateString("en-US", {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                      })}
                      {` · ${dayParts.length} ${dayParts.length === 1 ? "part" : "parts"}`}
                    </Text>
                  )}

                  {parts.length === 0 ? (
                    <Text style={styles.modalPartsEmpty}>
                      No parts yet. Add one to give this event a program, where
                      each item shows Ongoing while it runs.
                    </Text>
                  ) : (
                    groupPartsByStart(dayParts).map((slot) => (
                      <View
                        key={slot.key}
                        style={slot.parts.length > 1 ? styles.modalSlotGroup : undefined}
                      >
                        {slot.parts.length > 1 && (
                          <Text style={styles.modalSlotHeading}>
                            {formatTime(slot.parts[0].startTime) || "All day"} · {slot.parts.length} at once
                          </Text>
                        )}
                        {slot.parts.map((part) => {
                          const partStatus = getStatusDetails(part);
                          const partVenue = part.venue?.trim();
                          return (
                            <TouchableOpacity
                              key={part.id}
                              style={styles.modalPartRow}
                              activeOpacity={0.75}
                              onPress={() => handleViewMorePress(part.date, [part])}
                              accessibilityRole="button"
                              accessibilityLabel={`${part.title}, ${formatEventTime(part)}${partVenue ? `, ${partVenue}` : ""}, ${partStatus.label}`}
                            >
                              <View
                                style={[
                                  styles.modalPartDot,
                                  { backgroundColor: partStatus.color },
                                ]}
                              />
                              <View style={styles.modalPartCopy}>
                                <Text style={styles.modalPartTitle} numberOfLines={1}>
                                  {part.title}
                                </Text>
                                <Text style={styles.modalPartMeta} numberOfLines={1}>
                                  {formatEventTime(part)}
                                  {partVenue ? ` · ${partVenue}` : ""}
                                </Text>
                              </View>
                              <View
                                style={[
                                  styles.modalPartPill,
                                  { backgroundColor: partStatus.surfaceColor, borderColor: partStatus.color },
                                ]}
                              >
                                <Text style={[styles.modalPartPillText, { color: partStatus.color }]}>
                                  {partStatus.label}
                                </Text>
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    ))
                  )}
                </View>
              )}

              {event.description && (
                <View style={styles.descriptionBlock}>
                  <Text style={styles.subEventListLabel}>ABOUT THIS EVENT</Text>
                  <Text style={styles.eventDescription}>{event.description}</Text>
                </View>
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
                      <Text style={styles.metaText}>{formatEventTime(event)}</Text>
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
                          {event.endDate && event.endDate !== event.date ? `${formatCompactDate(event.endDate)} · ` : ""}
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
      </DragToCloseSheet>

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmText={dialog?.confirmText ?? "Confirm"}
        cancelText={dialog?.cancelText}
        destructive={dialog?.destructive ?? true}
        singleAction={dialog?.singleAction ?? false}
        icon={dialog?.icon}
        onConfirm={() => dialog?.onConfirm()}
        onCancel={() => setDialog(null)}
      />
      </View>
    </SafeAreaView>
  );
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  monthSection: { marginBottom: 10 },
  pastSection: {
    marginTop: 20,
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
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderRadius: 14,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  pastRowCopy: { flex: 1, minWidth: 0 },
  pastRowTitle: { color: c.textSecondary, fontSize: 15, fontWeight: "600" },
  pastRowMeta: { color: c.textMuted, fontSize: 12.5, marginTop: 2 },
  // A calendar leaf: the day big, the month small, so rows scan by date.
  pastDateBlock: {
    width: 44,
    paddingVertical: 5,
    borderRadius: 11,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
  },
  pastDateDay: { color: c.textPrimary, fontSize: 16, fontWeight: "800", lineHeight: 20 },
  pastDateMonth: { color: c.textMuted, fontSize: 9.5, fontWeight: "800", letterSpacing: 0.6 },
  pastMonthHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    marginTop: 6,
  },
  pastMonthLabel: { flex: 1, color: c.primary, fontSize: 12, fontWeight: "800", letterSpacing: 1.1 },
  pastMonthCount: { color: c.textMuted, fontSize: 12, fontWeight: "600" },
  pastYearRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16, marginBottom: 2 },
  pastYearLine: { flex: 1, height: 1, backgroundColor: c.border },
  pastYearText: { color: c.textMuted, fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  pastCancelledPill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.danger,
    backgroundColor: c.dangerSoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pastCancelledText: { color: c.danger, fontSize: 10.5, fontWeight: "800" },
  pastLoadMore: { alignItems: "center", paddingVertical: 12 },
  pastLoadMoreText: { color: c.primary, fontSize: 14, fontWeight: "700" },
  monthLabel: {
    color: c.primary,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.2,
    marginTop: 20,
    marginBottom: 16,
  },
  daySection: { marginBottom: 16 },
  dayHeading: {
    color: c.textSecondary,
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 10,
    letterSpacing: 0.2,
  },
  dayHeadingToday: { color: c.success },
  rowCard: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
    borderRadius: 20,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: c.textPrimary,
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  // Finished events stay visible but step back, so today still reads as today.
  rowCardDone: { backgroundColor: c.surfaceSunken },
  // A main event is the container for a week; a heavier edge sets it apart
  // from the sessions inside it.
  rowCardMain: { borderColor: c.border, backgroundColor: c.surfaceRaised },
  rowIconOrb: { width: 42, height: 42, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center", marginLeft: 16 },
  rowChevron: { marginRight: 13 },
  rowBody: { flex: 1, minWidth: 0, paddingVertical: 12, paddingHorizontal: 13 },
  rowTopRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTime: { flex: 1, color: c.textSecondary, fontSize: 12, fontWeight: "600", marginTop: 5 },
  rowStatusLine: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 7, marginTop: 6 },
  rowStatusPill: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  rowStatusText: { fontSize: 11, fontWeight: "800" },
  rowName: {
    color: c.textPrimary,
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 20,
  },
  rowContext: { color: c.textMuted, fontSize: 13, marginTop: 3 },
  // A cancelled event keeps its place in the list, struck through, so nobody
  // turns up for it and nobody wonders where it went.
  cancelledTitle: { textDecorationLine: "line-through", color: c.textMuted },
  cancelledTime: { textDecorationLine: "line-through" },
  rowEdit: { paddingHorizontal: 13, paddingVertical: 12 },
  draftTag: { color: c.textMuted, fontSize: 12, fontWeight: "700" },
  nowPanel: {
    marginBottom: 24,
    padding: 24,
    borderRadius: 24,
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.border,
  },
  nowEyebrow: { color: c.primary, fontSize: 10, fontWeight: "900", letterSpacing: 1.25, marginBottom: 11 },
  nowHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  nowHeading: {
    color: c.textPrimary,
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: -0.5,
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
  nowRow: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 9 },
  nowUpcomingIcon: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: c.surfaceRaised },
  nowRowCopy: { flex: 1, minWidth: 0 },
  nowDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: c.success },
  nowTitle: { color: c.textPrimary, fontSize: 16, fontWeight: "800" },
  nowMeta: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  nowEmpty: { color: c.textMuted, fontSize: 13, lineHeight: 19 },
  nowStatsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  nowStat: { color: c.textMuted, fontSize: 13, fontWeight: "600" },
  nowStatDivider: { color: c.textMuted, fontSize: 13 },
  agendaHeader: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 8 },
  agendaEyebrow: { color: c.textMuted, fontSize: 10, fontWeight: "800", letterSpacing: 1.1 },
  agendaTitle: { color: c.textPrimary, fontSize: 24, fontWeight: "800", letterSpacing: -0.6, marginTop: 4 },
  agendaCount: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: c.surfaceSunken },
  agendaCountText: { color: c.textSecondary, fontSize: 12, fontWeight: "700" },
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
  modalPartRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 },
  modalPartDot: { width: 7, height: 7, borderRadius: 4 },
  modalPartTitle: { color: c.textPrimary, fontSize: 13, fontWeight: "600" },
  modalPartTime: { color: c.textMuted, fontSize: 13 },
  modalPartsHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  dayBadge: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.accent,
    backgroundColor: c.accentSoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  dayBadgeText: { color: c.accent, fontSize: 10.5, fontWeight: "900" },
  dayTabs: { gap: 7, paddingVertical: 4, paddingRight: 4 },
  dayTab: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceSunken,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  dayTabOn: { backgroundColor: c.primary, borderColor: c.primary },
  dayTabTitle: { color: c.textPrimary, fontSize: 12, fontWeight: "800" },
  dayTabTitleOn: { color: c.onPrimary },
  dayTabMeta: { color: c.textMuted, fontSize: 10.5, marginTop: 1 },
  dayTabMetaOn: { color: c.onPrimary },
  modalDayHeading: {
    color: c.textSecondary,
    fontSize: 11.5,
    fontWeight: "800",
    marginTop: 2,
  },
  modalPartCopy: { flex: 1, minWidth: 0 },
  modalPartMeta: { color: c.textMuted, fontSize: 11.5, marginTop: 1 },
  modalPartPill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  modalPartPillText: { fontSize: 10.5, fontWeight: "800" },
  modalPartsEmpty: { color: c.textMuted, fontSize: 12.5, lineHeight: 16 },
  // Parts that start together are bracketed, so "at once" reads as at once.
  modalSlotGroup: {
    borderLeftWidth: 2,
    borderLeftColor: c.accent,
    paddingLeft: 9,
    marginVertical: 2,
    gap: 2,
  },
  modalSlotHeading: { color: c.accent, fontSize: 10.5, fontWeight: "900", letterSpacing: 0.6 },
  addPartButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.accent,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  addPartText: { color: c.accent, fontSize: 11.5, fontWeight: "800" },

  // The Now / Up next strip on a main event's card.
  stripBox: {
    marginTop: 9,
    paddingTop: 9,
    borderTopWidth: 1,
    borderTopColor: c.border,
    gap: 4,
  },
  stripRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  stripDotOn: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.success },
  stripDotOff: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: c.borderStrong },
  stripKey: { color: c.textMuted, fontSize: 9.5, fontWeight: "900", letterSpacing: 0.9, width: 46 },
  stripKeyOn: { color: c.success },
  stripText: { flex: 1, color: c.textSecondary, fontSize: 12.5 },
  stripNowText: { flex: 1, color: c.textPrimary, fontSize: 12.5, fontWeight: "800" },
  stripWhere: { color: c.primary, fontWeight: "700" },
  stripMeta: { color: c.textMuted, fontWeight: "400" },
  stripSub: { color: c.textSecondary, fontSize: 12, marginLeft: 24 },
  stripMore: { color: c.textMuted, fontSize: 11.5, marginLeft: 24 },

  // Whose event it is, and where it happens.
  audienceChip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.primary,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  audienceChipText: { color: c.primary, fontSize: 10.5, fontWeight: "800" },
  venueChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceSunken,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  venueChipText: { color: c.textSecondary, fontSize: 11, fontWeight: "700", maxWidth: 160 },

  // My program / All campus.
  filterRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  filterChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceRaised,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  filterChipOn: { backgroundColor: c.primary, borderColor: c.primary },
  filterChipText: { color: c.textSecondary, fontSize: 12, fontWeight: "800" },
  filterChipTextOn: { color: c.onPrimary },
  filterNote: { color: c.textMuted, fontSize: 11.5 },

  // Happening now, theirs first.
  nowGroupLabel: {
    color: c.textMuted,
    fontSize: 9.5,
    fontWeight: "900",
    letterSpacing: 1.1,
    marginTop: 8,
  },
  nowRowOther: { opacity: 0.72 },
  nowDotOther: { backgroundColor: c.borderStrong },
  nowOtherTag: { color: c.primary, fontSize: 10.5, fontWeight: "800", maxWidth: 110 },
  container: {
    flex: 1,
    backgroundColor: c.chrome,
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
    backgroundColor: c.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 96,
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: c.chrome,
    borderBottomWidth: 1,
    borderBottomColor: c.chromeBorder,
    zIndex: 1,
  },
  headerBackButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: c.chrome,
    borderWidth: 1,
    borderColor: c.chromeBorder,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: 13,
  },
  headerEyebrow: { fontSize: 10, fontWeight: "900", letterSpacing: 1.1, color: c.accent, marginBottom: 3 },
  headerSubtitle: { fontSize: 12, color: c.onChromeMuted, marginTop: 2 },
  headerTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: c.onChrome,
    letterSpacing: -0.3,
  },
  headerCreateButton: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: c.accent,
  },
  headerCreateText: {
    fontSize: 13,
    fontWeight: "800",
    color: c.onAccent,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
  },
  draftsSection: {
    marginTop: 20,
    marginBottom: 24,
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
    fontSize: 18,
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
    padding: 12,
    borderRadius: 18,
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
    paddingVertical: 32,
    paddingHorizontal: 20,
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
    lineHeight: 20,
    textAlign: "center",
    color: c.textMuted,
  },
  emptyCreateLink: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    marginTop: 16,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: c.surfaceSunken,
  },
  emptyCreateLinkText: {
    fontSize: 13,
    fontWeight: "800",
    color: c.primary,
  },
  modalContent: {
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    backgroundColor: c.surface,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: 10,
    maxHeight: "88%",
    overflow: "hidden",
  },
  // DragToCloseSheet draws the handle, with its own space above it.
  draggableSheet: {
    paddingTop: 0,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  modalHeaderCopy: {
    flex: 1,
    minWidth: 0,
    marginRight: 16,
  },
  modalDate: {
    fontSize: 24,
    lineHeight: 24,
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
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
  },
  eventCard: {
    backgroundColor: c.surfaceRaised,
    borderRadius: 20,
    padding: 16,
    marginBottom: 16,
    borderLeftWidth: 3,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: c.textPrimary,
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
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
    lineHeight: 24,
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
  subEventList: { marginBottom: 16, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14, backgroundColor: c.surfaceSunken, gap: 8 },
  subEventListLabel: { color: c.textMuted, fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  subEventListRow: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
  subEventListDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7, backgroundColor: c.accent },
  subEventListText: { flex: 1, color: c.textPrimary, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  statusSupportText: { color: c.textSecondary, fontSize: 13, marginTop: -4, marginBottom: 16 },
  descriptionBlock: { gap: 7, marginBottom: 16 },
  eventDescription: {
    fontSize: 14,
    color: c.textSecondary,
    lineHeight: 20,
  },
  eventMeta: {
    gap: 8,
    padding: 13,
    borderRadius: 18,
    backgroundColor: c.surfaceSunken,
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
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: c.background,
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
    paddingHorizontal: 20,
    paddingVertical: 32,
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
    marginTop: 20,
    fontSize: 20,
    fontWeight: "800",
    color: c.textPrimary,
  },
  emptySubtitle: {
    maxWidth: 300,
    marginTop: 7,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    color: c.textMuted,
  },
  createButton: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 20,
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

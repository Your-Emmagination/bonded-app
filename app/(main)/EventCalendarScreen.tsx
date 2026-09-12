// EventCalendarScreen.tsx
import { useNetworkStatus } from "@/utils/networkUtils";
import { getUserData, UserRole } from "@/utils/rbac";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
    collection,
    deleteDoc,
    doc,
    onSnapshot,
    query,
    where,
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
  const router = useRouter();
  const { isOffline } = useNetworkStatus();
  const { eventId } = useLocalSearchParams<{ eventId?: string | string[] }>();
  const resolvedEventId = Array.isArray(eventId) ? eventId[0] : eventId;
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [draftEvents, setDraftEvents] = useState<CalendarEvent[]>([]);
  const [showAllDrafts, setShowAllDrafts] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<CalendarEvent[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(
    auth.currentUser?.uid || null,
  );
  const [authReady, setAuthReady] = useState(Boolean(auth.currentUser));
  const [currentUserRole, setCurrentUserRole] = useState<
    UserRole | undefined
  >();
  const [loading, setLoading] = useState(true);
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());
  const groupedEvents = useMemo(() => groupEventsByMonth(events), [events]);
  const revealAnimation = useRef(new Animated.Value(0)).current;
  const orbitAnimation = useRef(new Animated.Value(0)).current;

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
    const orbitLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(orbitAnimation, {
          toValue: 1,
          duration: 3200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(orbitAnimation, {
          toValue: 0,
          duration: 3200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );

    orbitLoop.start();
    return () => orbitLoop.stop();
  }, [orbitAnimation]);

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

      setCurrentUserId(user?.uid || null);
      setAuthReady(true);
      setCurrentUserRole(undefined);

      if (user) {
        getUserData(user.uid)
          .then((userData) => {
            if (active && auth.currentUser?.uid === user.uid) {
              setCurrentUserRole(userData?.role);
            }
          })
          .catch((error) => {
            console.error("Error fetching user role:", error);
          });
      }
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

    const publicEventsQuery = query(
      collection(db, "events"),
      where("status", "in", ["published", "archived"]),
    );
    const ownedEventsQuery = query(
      collection(db, "events"),
      where("createdBy", "==", currentUserId),
    );

    const unsubscribePublicEvents = onSnapshot(
      publicEventsQuery,
      (snapshot) => {
        const fetchedEvents: CalendarEvent[] = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as CalendarEvent[];

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
  }, [authReady, currentUserId]);

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
        color: "#9b766c",
        surfaceColor: "#fffdfb",
        borderColor: "#eadbd4",
      };
    }

    if (lifecycle === "archived") {
      return {
        lifecycle,
        label: "ARCHIVED",
        icon: "archive-outline" as const,
        color: "#7a3b2e",
        surfaceColor: "#f8efea",
        borderColor: "#dfc5bc",
      };
    }

    if (lifecycle === "ongoing") {
      return {
        lifecycle,
        label: "ONGOING",
        icon: "radio-button-on" as const,
        color: "#247a4d",
        surfaceColor: "#edf8f1",
        borderColor: "#b7ddc5",
      };
    }

    if (lifecycle === "finished") {
      return {
        lifecycle,
        label: "FINISHED",
        icon: "checkmark-done-circle-outline" as const,
        color: "#6f7479",
        surfaceColor: "#f1f2f2",
        borderColor: "#d5d8da",
      };
    }

    return {
      lifecycle,
      label: "PUBLISHED",
      icon: "checkmark-circle-outline" as const,
      color: "#5f0909",
      surfaceColor: "#fffdfb",
      borderColor: "#eadbd4",
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
    const visibleDraftEvents = showAllDrafts
      ? draftEvents
      : draftEvents.slice(0, 1);
    const nextEvent = calendarInsights.nextEvent;

    return (
      <>
        <View style={styles.timelineHero}>
          <View style={styles.heroGlow} />
          <Animated.View
            pointerEvents="none"
            style={[
              styles.heroOrbit,
              {
                opacity: orbitAnimation.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.3, 0.65],
                }),
                transform: [
                  {
                    scale: orbitAnimation.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.92, 1.08],
                    }),
                  },
                ],
              },
            ]}
          />
          <View style={styles.heroTopRow}>
            <View style={styles.heroLabel}>
              <View style={styles.heroLabelDot} />
              <Text style={styles.heroLabelText}>YOUR CHRONICLE</Text>
            </View>
            {calendarInsights.live > 0 && (
              <View style={styles.livePill}>
                <View style={styles.liveDot} />
                <Text style={styles.livePillText}>
                  {calendarInsights.live} LIVE
                </Text>
              </View>
            )}
          </View>

          <Text style={styles.heroTitle}>Time, beautifully{`\n`}in motion.</Text>
          <Text style={styles.heroSubtitle} numberOfLines={2}>
            {nextEvent
              ? `Next: ${nextEvent.title} · ${formatCompactDate(nextEvent.date)}`
              : "Your shared moments will unfold here."}
          </Text>

          <View style={styles.insightRail}>
            <View style={styles.insightItem}>
              <Text style={styles.insightNumber}>{calendarInsights.upcoming}</Text>
              <Text style={styles.insightLabel}>UP NEXT</Text>
            </View>
            <View style={styles.insightDivider} />
            <View style={styles.insightItem}>
              <Text style={styles.insightNumber}>{events.length}</Text>
              <Text style={styles.insightLabel}>MOMENTS</Text>
            </View>
            <View style={styles.insightDivider} />
            <View style={styles.insightItem}>
              <Text style={styles.insightNumber}>{draftEvents.length}</Text>
              <Text style={styles.insightLabel}>PRIVATE</Text>
            </View>
          </View>
        </View>

        {draftEvents.length > 0 && (
          <View style={styles.draftsSection}>
            <View style={styles.draftsHeader}>
              <View style={styles.draftTitleRow}>
                <View style={styles.draftLockOrb}>
                  <Ionicons name="lock-closed" size={13} color="#F4C873" />
                </View>
                <View style={styles.draftsHeaderCopy}>
                  <Text style={styles.draftsTitle}>Private studio</Text>
                  <Text style={styles.draftsSubtitle}>Unpublished ideas</Text>
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
                        color="#F4C873"
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
                        color="#F4C873"
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
                  color="#F4C873"
                />
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={styles.calendarSectionHeader}>
          <View style={styles.calendarSectionCopy}>
            <Text style={styles.calendarSectionEyebrow}>THE TIMELINE</Text>
            <Text style={styles.calendarSectionTitle}>Moments ahead</Text>
            <Text style={styles.calendarSectionSubtitle}>
              Follow the thread through every gathering
            </Text>
          </View>
          <View style={styles.calendarCountBadge}>
            <Ionicons name="infinite-outline" size={17} color="#7A1E18" />
            <Text style={styles.calendarCountText}>{events.length}</Text>
          </View>
        </View>
      </>
    );
  };

  const renderMonthSection = ({ item }: { item: string }) => {
    const dates = Object.keys(groupedEvents[item]).sort();
    const monthEventCount = dates.reduce(
      (total, date) => total + groupedEvents[item][date].length,
      0,
    );

    return (
      <View style={styles.monthSection}>
        <View style={styles.monthHeaderRow}>
          <View style={styles.monthMarker}>
            <View style={styles.monthMarkerCore} />
          </View>
          <View style={styles.monthPill}>
            <Text style={styles.monthHeader}>{item}</Text>
            <Text style={styles.monthEventCount}>
              {monthEventCount} {monthEventCount === 1 ? "moment" : "moments"}
            </Text>
          </View>
          <View style={styles.monthAccent} />
        </View>
        {dates.map((date) => {
          const eventsForDate = groupedEvents[item][date];
          const calendarDate = parseEventDate(date);
          const dateNum = calendarDate.getDate();
          const monthShort = calendarDate.toLocaleDateString("en-US", {
            month: "short",
          });
          const weekday = calendarDate.toLocaleDateString("en-US", {
            weekday: "short",
          });
          const isToday = calendarDate.toDateString() === new Date().toDateString();

          return (
            <View key={date} style={styles.dateCard}>
              <View style={styles.dateRail} />
              <TouchableOpacity
                style={[styles.dateTile, isToday && styles.dateTileToday]}
                onPress={() => handleViewMorePress(date, eventsForDate)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={`View ${eventsForDate.length} ${
                  eventsForDate.length === 1 ? "event" : "events"
                } on ${formatDate(date)}`}
                accessibilityHint="Opens event details"
              >
                <Text
                  style={[styles.dateWeekday, isToday && styles.dateTextToday]}
                >
                  {weekday}
                </Text>
                <Text
                  style={[styles.dateNumberText, isToday && styles.dateTextToday]}
                >
                  {dateNum}
                </Text>
                <Text style={[styles.dateMonth, isToday && styles.dateTextToday]}>
                  {monthShort}
                </Text>
              </TouchableOpacity>

              <View style={styles.eventPreviewSurface}>
                {eventsForDate.slice(0, 2).map((event, index) => {
                  const statusDetails = getStatusDetails(event);

                  return (
                    <View
                      key={event.id}
                      style={[
                        styles.eventPreviewRow,
                        index > 0 && styles.eventPreviewRowDivider,
                      ]}
                    >
                      <TouchableOpacity
                        style={styles.eventPreviewButton}
                        onPress={() => handleViewMorePress(date, eventsForDate)}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        accessibilityLabel={`View ${event.title}, ${formatEventTime(event)}`}
                        accessibilityHint="Opens event details"
                      >
                        <View
                          style={[
                            styles.eventColorDot,
                            {
                              backgroundColor:
                                statusDetails.lifecycle === "ongoing" ||
                                statusDetails.lifecycle === "finished"
                                  ? statusDetails.color
                                  : getCategoryColor(event.category),
                            },
                          ]}
                        />
                        <View style={styles.eventPreviewCopy}>
                          <Text style={styles.eventOrdinal}>
                            {event.category === "all-day"
                              ? "ALL DAY"
                              : formatEventTime(event).split(" ")[0]}
                          </Text>
                          <Text
                            style={[
                              styles.eventTitle,
                              (statusDetails.lifecycle === "ongoing" ||
                                statusDetails.lifecycle === "finished") && {
                                color: statusDetails.color,
                              },
                            ]}
                            numberOfLines={1}
                          >
                            {event.title}
                          </Text>
                          <View style={styles.eventPreviewMeta}>
                            <Text style={styles.eventPreviewTime} numberOfLines={1}>
                              {formatEventTime(event)}
                            </Text>
                            <View
                              style={[
                                styles.previewStatus,
                                {
                                  backgroundColor: statusDetails.surfaceColor,
                                  borderColor: statusDetails.borderColor,
                                },
                              ]}
                            >
                              <Ionicons
                                name={statusDetails.icon}
                                size={11}
                                color={statusDetails.color}
                              />
                              <Text
                                style={[
                                  styles.previewStatusText,
                                  { color: statusDetails.color },
                                ]}
                              >
                                {statusDetails.label}
                              </Text>
                            </View>
                          </View>
                        </View>
                      </TouchableOpacity>

                      {canEditEvent(event) && (
                        <TouchableOpacity
                          style={[
                            styles.editIconButton,
                            styles.previewEditButton,
                          ]}
                          onPress={() => handleEditEvent(event)}
                          activeOpacity={0.7}
                          hitSlop={4}
                          accessibilityRole="button"
                          accessibilityLabel={`Edit published event ${event.title}`}
                        >
                          <Ionicons
                            name="create-outline"
                            size={18}
                            color="#B67B2C"
                          />
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}

                {eventsForDate.length > 2 && (
                  <TouchableOpacity
                    style={styles.moreEventsBadge}
                    onPress={() => handleViewMorePress(date, eventsForDate)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`View ${eventsForDate.length - 2} more events`}
                  >
                    <Text style={styles.moreEvents}>
                      +{eventsForDate.length - 2} more along this thread
                    </Text>
                    <Ionicons name="arrow-forward" size={13} color="#7A1E18" />
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={styles.dateChevron}
                  onPress={() => handleViewMorePress(date, eventsForDate)}
                  activeOpacity={0.7}
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityLabel={`View all events on ${formatDate(date)}`}
                >
                  <Text style={styles.dateChevronText}>OPEN DAY</Text>
                  <Ionicons name="arrow-forward" size={14} color="#7A1E18" />
                </TouchableOpacity>
              </View>
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
            <Ionicons name="arrow-back" size={20} color="#F7EFE8" />
          </TouchableOpacity>

          <View style={styles.headerCopy}>
            <Text style={styles.headerEyebrow}>BONDED / TIME</Text>
            <Text style={styles.headerTitle} numberOfLines={1}>
              Chronicle
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
              <Ionicons name="add" size={19} color="#2A0908" />
              <Text style={styles.headerCreateText}>New moment</Text>
            </TouchableOpacity>
          )}
        </View>

      {isOffline && (
        <View style={styles.offlineStatusBar}>
          <Ionicons name="cloud-offline-outline" size={14} color="#9a3412" />
          <Text style={styles.offlineStatusText}>Offline mode</Text>
        </View>
      )}

      {/* Events List */}
      {/* Offline the listeners never resolve, so the spinner would spin
          forever — fall through to the empty state instead. */}
      {loading && !isOffline ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#7d1d13" />
          <Text style={styles.loadingText}>Loading your calendar...</Text>
        </View>
      ) : events.length === 0 && draftEvents.length === 0 ? (
        <View style={styles.emptyContainer}>
          <View style={styles.emptyIcon}>
            <Ionicons name="calendar-outline" size={42} color="#7a3b2e" />
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
              <Ionicons name="add" size={20} color="#4d1b17" />
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
            events.length > 0 ? (
              <View style={styles.timelineEnd}>
                <View style={styles.timelineEndLine} />
                <View style={styles.timelineEndOrb}>
                  <Ionicons name="infinite" size={17} color="#F4C873" />
                </View>
                <Text style={styles.timelineEndText}>THE THREAD CONTINUES</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            draftEvents.length > 0 ? (
              <View style={styles.publishedEmptyCard}>
                <View style={styles.publishedEmptyIcon}>
                  <Ionicons
                    name="calendar-outline"
                    size={26}
                    color="#7a3b2e"
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
                    <Ionicons name="add" size={17} color="#7a3b2e" />
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
                <Ionicons name="close" size={23} color="#7a3b2e" />
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
                            color="#e0a53d"
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
                              color="#9d2f24"
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
                        color="#fffaf7"
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
                            color="#7a3b2e"
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
                              color="#7a3b2e"
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
                              color="#7a3b2e"
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
                          color="#7a3b2e"
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#250706",
  },
  offlineStatusBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ffedd5",
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#fed7aa",
  },
  offlineStatusText: {
    fontSize: 12,
    color: "#9a3412",
    fontWeight: "600",
  },
  contentShell: {
    flex: 1,
    backgroundColor: "#F4EEE8",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 70,
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: "#250706",
    zIndex: 1,
  },
  headerBackButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: 13,
  },
  headerEyebrow: {
    marginBottom: 2,
    fontSize: 9,
    fontWeight: "800",
    color: "#D5A75B",
    letterSpacing: 1.8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#FFF8F1",
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
    backgroundColor: "#F1C46B",
  },
  headerCreateText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#2A0908",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 28,
  },
  timelineHero: {
    minHeight: 286,
    justifyContent: "flex-end",
    marginBottom: 22,
    padding: 22,
    borderRadius: 30,
    overflow: "hidden",
    backgroundColor: "#420D0B",
    shadowColor: "#2A0908",
    shadowOpacity: 0.24,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  heroGlow: {
    position: "absolute",
    top: -65,
    right: -45,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "rgba(217, 92, 63, 0.28)",
  },
  heroOrbit: {
    position: "absolute",
    top: -78,
    right: -22,
    width: 210,
    height: 210,
    borderRadius: 105,
    borderWidth: 1,
    borderColor: "rgba(241, 196, 107, 0.48)",
  },
  heroTopRow: {
    position: "absolute",
    top: 22,
    left: 22,
    right: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  heroLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  heroLabelDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#F1C46B",
  },
  heroLabelText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#EBC98A",
    letterSpacing: 1.8,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.09)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#6FE1A8",
  },
  livePillText: {
    fontSize: 9,
    fontWeight: "900",
    color: "#D8FFE9",
    letterSpacing: 0.9,
  },
  heroTitle: {
    maxWidth: 290,
    fontSize: 38,
    lineHeight: 40,
    fontWeight: "700",
    color: "#FFF8F1",
    letterSpacing: -1.5,
  },
  heroSubtitle: {
    maxWidth: "88%",
    marginTop: 11,
    fontSize: 12,
    lineHeight: 18,
    color: "#D7BDB5",
  },
  insightRail: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 20,
    paddingTop: 15,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.1)",
  },
  insightItem: {
    flex: 1,
  },
  insightNumber: {
    fontSize: 18,
    fontWeight: "800",
    color: "#FFF8F1",
  },
  insightLabel: {
    marginTop: 2,
    fontSize: 8,
    fontWeight: "800",
    color: "#CDAEA6",
    letterSpacing: 1.2,
  },
  insightDivider: {
    width: 1,
    height: 27,
    marginHorizontal: 13,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  draftsSection: {
    marginBottom: 28,
    padding: 16,
    borderRadius: 24,
    backgroundColor: "#28100F",
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
    backgroundColor: "rgba(241,196,107,0.12)",
    borderWidth: 1,
    borderColor: "rgba(241,196,107,0.22)",
  },
  draftsHeaderCopy: {
    flex: 1,
  },
  draftsTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#FFF8F1",
  },
  draftsSubtitle: {
    marginTop: 2,
    fontSize: 10,
    color: "#AC918B",
  },
  draftCountBadge: {
    minWidth: 31,
    height: 31,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  draftCountText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#F1C46B",
  },
  draftCard: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    padding: 10,
    borderRadius: 17,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
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
    backgroundColor: "rgba(241,196,107,0.1)",
  },
  draftCopy: {
    flex: 1,
  },
  draftEventTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#FFF8F1",
  },
  draftEventDate: {
    marginTop: 3,
    fontSize: 10,
    color: "#AC918B",
  },
  editIconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: "rgba(241,196,107,0.12)",
    borderWidth: 1,
    borderColor: "rgba(241,196,107,0.25)",
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
    fontSize: 11,
    fontWeight: "700",
    color: "#F1C46B",
  },
  calendarSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 18,
    paddingHorizontal: 4,
  },
  calendarSectionCopy: {
    flex: 1,
    marginRight: 12,
  },
  calendarSectionEyebrow: {
    marginBottom: 5,
    fontSize: 9,
    fontWeight: "900",
    color: "#A66A32",
    letterSpacing: 1.8,
  },
  calendarSectionTitle: {
    fontSize: 26,
    lineHeight: 30,
    fontWeight: "700",
    color: "#2B0C0A",
    letterSpacing: -0.8,
  },
  calendarSectionSubtitle: {
    marginTop: 5,
    fontSize: 11,
    color: "#846B65",
  },
  calendarCountBadge: {
    minWidth: 52,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 11,
    borderRadius: 20,
    backgroundColor: "#FFF9F3",
    borderWidth: 1,
    borderColor: "#E2D2C8",
  },
  calendarCountText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#7A1E18",
  },
  publishedEmptyCard: {
    alignItems: "center",
    paddingVertical: 34,
    paddingHorizontal: 22,
    borderRadius: 26,
    backgroundColor: "#FFF9F3",
    borderWidth: 1,
    borderColor: "#E6D9D0",
  },
  publishedEmptyIcon: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 26,
    backgroundColor: "#F1E3D8",
  },
  publishedEmptyText: {
    marginTop: 12,
    fontSize: 16,
    fontWeight: "800",
    color: "#2B0C0A",
  },
  publishedEmptySubtitle: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    color: "#846B65",
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
    backgroundColor: "#F1E3D8",
  },
  emptyCreateLinkText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#7A1E18",
  },
  monthSection: {
    marginBottom: 8,
  },
  monthHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  monthMarker: {
    width: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  monthMarkerCore: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#F1C46B",
    borderWidth: 2,
    borderColor: "#7A1E18",
  },
  monthPill: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
  },
  monthHeader: {
    fontSize: 16,
    fontWeight: "800",
    color: "#2B0C0A",
    letterSpacing: -0.2,
  },
  monthEventCount: {
    fontSize: 9,
    fontWeight: "700",
    color: "#A08881",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  monthAccent: {
    flex: 1,
    height: 1,
    marginLeft: 10,
    backgroundColor: "#DCCDC4",
  },
  dateCard: {
    position: "relative",
    flexDirection: "row",
    alignItems: "flex-start",
    paddingBottom: 18,
  },
  dateRail: {
    position: "absolute",
    top: 66,
    bottom: -18,
    left: 27,
    width: 1,
    backgroundColor: "#D5C3B9",
  },
  dateTile: {
    width: 56,
    height: 78,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 28,
    backgroundColor: "#E8DAD0",
    borderWidth: 1,
    borderColor: "#D5C3B9",
  },
  dateTileToday: {
    backgroundColor: "#7A1E18",
    borderColor: "#7A1E18",
  },
  dateTextToday: {
    color: "#FFF8F1",
  },
  dateWeekday: {
    fontSize: 8,
    fontWeight: "900",
    color: "#9A675A",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  dateNumberText: {
    fontSize: 25,
    lineHeight: 27,
    fontWeight: "700",
    color: "#2B0C0A",
    letterSpacing: -0.7,
  },
  dateMonth: {
    fontSize: 8,
    fontWeight: "800",
    color: "#9A675A",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  eventPreviewSurface: {
    flex: 1,
    minWidth: 0,
    marginLeft: 13,
    padding: 14,
    borderRadius: 24,
    backgroundColor: "#FFF9F3",
    borderWidth: 1,
    borderColor: "#E6D9D0",
    shadowColor: "#3A1410",
    shadowOpacity: 0.07,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  eventPreviewRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  eventPreviewRowDivider: {
    marginTop: 13,
    paddingTop: 13,
    borderTopWidth: 1,
    borderTopColor: "#EFE4DC",
  },
  eventColorDot: {
    width: 3,
    height: 42,
    flexShrink: 0,
    marginRight: 10,
    borderRadius: 2,
  },
  eventPreviewCopy: {
    flex: 1,
    minWidth: 0,
  },
  eventPreviewButton: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  previewEditButton: {
    flexShrink: 0,
    marginLeft: 6,
    backgroundColor: "#F7EEDA",
    borderColor: "#ECD9A9",
  },
  eventOrdinal: {
    marginBottom: 3,
    fontSize: 8,
    fontWeight: "900",
    color: "#B67B2C",
    letterSpacing: 1.2,
  },
  eventTitle: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: "700",
    color: "#2B0C0A",
  },
  eventPreviewMeta: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: 6,
    rowGap: 3,
    marginTop: 4,
  },
  eventPreviewTime: {
    maxWidth: "72%",
    marginRight: 4,
    fontSize: 10,
    fontWeight: "600",
    color: "#846B65",
  },
  previewStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  previewStatusText: {
    fontSize: 8,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  moreEventsBadge: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: "#EFE4DC",
  },
  moreEvents: {
    fontSize: 10,
    fontWeight: "700",
    color: "#7A1E18",
  },
  dateChevron: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-end",
    gap: 5,
    marginTop: 12,
    paddingLeft: 10,
    paddingVertical: 4,
  },
  dateChevronText: {
    fontSize: 8,
    fontWeight: "900",
    color: "#7A1E18",
    letterSpacing: 1.1,
  },
  timelineEnd: {
    alignItems: "center",
    paddingTop: 4,
    paddingBottom: 20,
  },
  timelineEndLine: {
    width: 1,
    height: 26,
    backgroundColor: "#D5C3B9",
  },
  timelineEndOrb: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 19,
    backgroundColor: "#420D0B",
  },
  timelineEndText: {
    marginTop: 9,
    fontSize: 8,
    fontWeight: "900",
    color: "#9A7D74",
    letterSpacing: 1.5,
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
    backgroundColor: "#F4EEE8",
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
    backgroundColor: "#C9A99D",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 22,
    paddingBottom: 17,
    borderBottomWidth: 1,
    borderBottomColor: "#E0D2C9",
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
    color: "#2B0C0A",
    letterSpacing: -0.5,
  },
  modalSubtitle: {
    marginTop: 3,
    fontSize: 12,
    fontWeight: "600",
    color: "#846B65",
  },
  modalCloseButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: "#E8DAD0",
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
    backgroundColor: "#FFF9F3",
    borderRadius: 24,
    padding: 18,
    marginBottom: 16,
    borderLeftWidth: 5,
    borderWidth: 1,
    borderColor: "#E6D9D0",
    shadowColor: "#3A1410",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  highlightedEventCard: {
    backgroundColor: "#FFF4D9",
    borderColor: "#D7A743",
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
    color: "#2B0C0A",
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
    backgroundColor: "#E8DAD0",
    borderWidth: 1,
    borderColor: "#DBC8BD",
  },
  deleteActionButton: {
    backgroundColor: "#FCE7E2",
    borderColor: "#EBC6BD",
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
    color: "#fffaf7",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  eventDescription: {
    fontSize: 14,
    color: "#6E514B",
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
    backgroundColor: "#E8DAD0",
  },
  metaCopy: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10,
  },
  metaLabel: {
    marginBottom: 1,
    fontSize: 10,
    fontWeight: "800",
    color: "#9A746A",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  metaText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#5E3B35",
  },
  categoryBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
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
    backgroundColor: "#F4EEE8",
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: "600",
    color: "#7A1E18",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    margin: 16,
    paddingHorizontal: 28,
    paddingVertical: 42,
    borderRadius: 30,
    backgroundColor: "#420D0B",
  },
  emptyIcon: {
    width: 78,
    height: 78,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 39,
    backgroundColor: "rgba(241,196,107,0.12)",
  },
  emptyText: {
    marginTop: 18,
    fontSize: 21,
    fontWeight: "800",
    color: "#FFF8F1",
  },
  emptySubtitle: {
    maxWidth: 300,
    marginTop: 7,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    color: "#CBAFA7",
  },
  createButton: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 22,
    backgroundColor: "#F1C46B",
    paddingHorizontal: 20,
    borderRadius: 15,
  },
  createButtonText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#2A0908",
  },
});

export default EventCalendarScreen;
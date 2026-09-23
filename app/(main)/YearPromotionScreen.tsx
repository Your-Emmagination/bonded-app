// app/(main)/YearPromotionScreen.tsx
//
// Schedules the automatic year level promotion.
//
// This screen never promotes anybody itself. It writes a promotionSchedules
// document and the scheduled Cloud Function (runYearLevelPromotions in
// functions/index.js) does the work. "Run now" is the same thing dated now —
// one code path for a mutation that touches every student record.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useRouter } from "expo-router";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  where,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import ConfirmDialog from "./components/ConfirmDialog";
import { auth, db } from "../../Firebase_configure";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import {
  evaluatePromotion,
  formatPromotionMoment,
  YEAR_LEVELS,
  type PromotionSkipReason,
  type YearLevel,
} from "@/utils/yearLevels";

type PreviewRow = { from: YearLevel; to: YearLevel; count: number };

type Preview = {
  rows: PreviewRow[];
  total: number;
  graduating: number;
  skipped: Record<PromotionSkipReason, number>;
  studentsScanned: number;
};

type ScheduleRecord = {
  id: string;
  runAtMs: number | null;
  status: string;
  createdByName?: string | null;
  promotedCount?: number;
  graduatedCount?: number;
  error?: string | null;
};

type RunRecord = {
  id: string;
  promotedCount: number;
  graduatedCount: number;
  studentsScanned: number;
  completedAtMs: number | null;
};

const SKIP_LABELS: Record<PromotionSkipReason, string> = {
  not_a_student: "Staff accounts",
  no_year_level: "No year level set",
  already_graduated: "Already graduated",
  on_hold: "On hold",
  registered_after_scheduling: "Registered after scheduling",
};

// Skip reasons worth showing. "Staff accounts" is noise — nobody expects
// teachers to advance a year.
const VISIBLE_SKIPS: PromotionSkipReason[] = [
  "on_hold",
  "registered_after_scheduling",
  "already_graduated",
  "no_year_level",
];

function toMillis(value: any): number | null {
  if (!value) return null;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return null;
}

/** Default: tomorrow at 12:01 AM, the natural "first day of the term" slot. */
function defaultRunAt(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(0, 1, 0, 0);
  return date;
}

export default function YearPromotionScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const role = useCurrentUserRole();
  const isAdmin = role === "admin";

  const [runAt, setRunAt] = useState<Date>(defaultRunAt);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [pending, setPending] = useState<ScheduleRecord[]>([]);
  const [lastRun, setLastRun] = useState<RunRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const [dialog, setDialog] = useState<{
    visible: boolean;
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    singleAction?: boolean;
    onConfirm?: () => void;
  }>({ visible: false, title: "" });

  const closeDialog = useCallback(
    () => setDialog((prev) => ({ ...prev, visible: false })),
    [],
  );

  const showInfo = useCallback((title: string, description?: string) => {
    setDialog({
      visible: true,
      title,
      description,
      confirmText: "OK",
      destructive: false,
      singleAction: true,
    });
  }, []);

  const showConfirm = useCallback(
    (options: {
      title: string;
      description?: string;
      confirmText?: string;
      destructive?: boolean;
      onConfirm: () => void;
    }) => {
      setDialog({
        visible: true,
        cancelText: "Cancel",
        confirmText: "Confirm",
        destructive: false,
        ...options,
      });
    },
    [],
  );

  // The preview reads every student once so the counts are exact rather than
  // an estimate. It runs on open and whenever Refresh bumps reloadToken —
  // never on a timer, and never as a live listener: this screen would
  // otherwise hold a subscription over the entire students collection, which
  // is the very thing the paginated user list exists to avoid.
  //
  // The fetch is inlined here rather than wrapped in a helper so every
  // setState happens inside a promise callback, not synchronously in the
  // effect body.
  useEffect(() => {
    if (!isAdmin) return;

    let cancelled = false;

    getDocs(collection(db, "students"))
      .then((snapshot) => {
        if (cancelled) return;

        const scheduleCreatedAtMs = Date.now();
        const tally = new Map<string, PreviewRow>();
        const skipped: Record<PromotionSkipReason, number> = {
          not_a_student: 0,
          no_year_level: 0,
          already_graduated: 0,
          on_hold: 0,
          registered_after_scheduling: 0,
        };

        snapshot.forEach((docSnap) => {
          const data = docSnap.data() || {};
          const decision = evaluatePromotion(
            {
              role: data.role,
              yearlvl: data.yearlvl,
              promotionHold: data.promotionHold,
              createdAtMs: toMillis(data.createdAt),
            },
            scheduleCreatedAtMs,
          );

          if (!decision.promote) {
            skipped[decision.reason] += 1;
            return;
          }

          const key = `${decision.from}->${decision.to}`;
          const existing = tally.get(key);
          if (existing) existing.count += 1;
          else tally.set(key, { from: decision.from, to: decision.to, count: 1 });
        });

        // Ordered by the ladder, not by whatever Firestore returned first.
        const rows = Array.from(tally.values()).sort(
          (a, b) => YEAR_LEVELS.indexOf(a.from) - YEAR_LEVELS.indexOf(b.from),
        );

        setPreview({
          rows,
          total: rows.reduce((sum, row) => sum + row.count, 0),
          graduating: rows.find((row) => row.to === "Graduated")?.count ?? 0,
          skipped,
          studentsScanned: snapshot.size,
        });
        setPreviewError(false);
        setPreviewLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Promotion preview failed:", error);
        setPreviewError(true);
        setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin, reloadToken]);

  // Anything not finished yet: queued, mid-run, or parked after a failure.
  useEffect(() => {
    if (!isAdmin) return;
    const pendingQuery = query(
      collection(db, "promotionSchedules"),
      where("status", "in", ["pending", "running", "failed"]),
    );
    return onSnapshot(
      pendingQuery,
      (snapshot) => {
        const rows = snapshot.docs.map((docSnap) => {
          const data = docSnap.data() || {};
          return {
            id: docSnap.id,
            runAtMs: toMillis(data.runAt),
            status: String(data.status || "pending"),
            createdByName: data.createdByName ?? null,
            promotedCount: data.promotedCount,
            graduatedCount: data.graduatedCount,
            error: data.error ?? null,
          };
        });
        rows.sort((a, b) => (a.runAtMs ?? 0) - (b.runAtMs ?? 0));
        setPending(rows);
      },
      (error) => console.error("Promotion schedule listener failed:", error),
    );
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    const runsQuery = query(
      collection(db, "promotionRuns"),
      orderBy("completedAt", "desc"),
      limit(1),
    );
    return onSnapshot(
      runsQuery,
      (snapshot) => {
        const docSnap = snapshot.docs[0];
        if (!docSnap) {
          setLastRun(null);
          return;
        }
        const data = docSnap.data() || {};
        setLastRun({
          id: docSnap.id,
          promotedCount: Number(data.promotedCount || 0),
          graduatedCount: Number(data.graduatedCount || 0),
          studentsScanned: Number(data.studentsScanned || 0),
          completedAtMs: toMillis(data.completedAt),
        });
      },
      (error) => console.error("Promotion runs listener failed:", error),
    );
  }, [isAdmin]);

  const createSchedule = useCallback(
    async (when: Date, label: string) => {
      setBusy(true);
      try {
        await addDoc(collection(db, "promotionSchedules"), {
          runAt: Timestamp.fromDate(when),
          status: "pending",
          label,
          createdAt: serverTimestamp(),
          createdBy: auth.currentUser?.uid ?? null,
          createdByName: auth.currentUser?.displayName ?? null,
        });
      } catch (error) {
        console.error("Failed to schedule promotion:", error);
        showInfo(
          "Could not schedule",
          "The promotion was not saved. Check your connection and try again.",
        );
      } finally {
        setBusy(false);
      }
    },
    [showInfo],
  );

  const onSchedulePress = useCallback(() => {
    if (!preview) return;
    if (runAt.getTime() <= Date.now()) {
      showInfo(
        "Pick a future time",
        "That date and time has already passed. Choose a later one, or use Run now.",
      );
      return;
    }
    showConfirm({
      title: "Schedule promotion?",
      description:
        `${preview.total} student${preview.total === 1 ? "" : "s"} will move up one year level on ` +
        `${formatPromotionMoment(runAt)}.` +
        (preview.graduating
          ? `\n\n${preview.graduating} will become Graduated.`
          : ""),
      confirmText: "Schedule",
      onConfirm: () => {
        closeDialog();
        void createSchedule(runAt, "Scheduled promotion");
      },
    });
  }, [closeDialog, createSchedule, preview, runAt, showConfirm, showInfo]);

  const onRunNowPress = useCallback(() => {
    if (!preview) return;
    showConfirm({
      title: "Run promotion now?",
      description:
        `${preview.total} student${preview.total === 1 ? "" : "s"} will move up one year level within the next couple of minutes.` +
        (preview.graduating
          ? `\n\n${preview.graduating} will become Graduated.`
          : "") +
        "\n\nThis cannot be undone automatically.",
      confirmText: "Run now",
      destructive: true,
      onConfirm: () => {
        closeDialog();
        void createSchedule(new Date(), "Run now");
      },
    });
  }, [closeDialog, createSchedule, preview, showConfirm]);

  const onCancelSchedule = useCallback(
    (schedule: ScheduleRecord) => {
      showConfirm({
        title:
          schedule.status === "failed"
            ? "Remove this failed run?"
            : "Cancel this promotion?",
        description:
          schedule.status === "failed"
            ? "The record is removed. Students already promoted by it keep their new year level."
            : "The scheduled promotion is removed. Nothing changes for students.",
        confirmText: "Remove",
        destructive: true,
        onConfirm: async () => {
          closeDialog();
          try {
            await deleteDoc(doc(db, "promotionSchedules", schedule.id));
          } catch (error) {
            console.error("Failed to cancel promotion:", error);
            showInfo("Could not remove", "Check your connection and try again.");
          }
        },
      });
    },
    [closeDialog, showConfirm, showInfo],
  );

  const dateLabel = useMemo(
    () =>
      runAt.toLocaleDateString("en-US", {
        weekday: "short",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    [runAt],
  );

  const timeLabel = useMemo(
    () =>
      runAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
    [runAt],
  );

  if (role === undefined) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.centered}>
          <ActivityIndicator color={theme.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!isAdmin) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.centered}>
          <Ionicons name="lock-closed-outline" size={30} color={theme.textMuted} />
          <Text style={styles.deniedTitle}>Administrators only</Text>
          <Text style={styles.deniedText}>
            Only administrators can schedule year level promotions.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Year level promotion</Text>
        <TouchableOpacity
          onPress={() => {
            setPreviewLoading(true);
            setReloadToken((token) => token + 1);
          }}
          disabled={previewLoading}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons
            name="refresh"
            size={20}
            color={previewLoading ? theme.textMuted : theme.accent}
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 28 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.heroCard}>
          <View style={styles.heroIcon}>
            <Ionicons name="school" size={26} color={theme.accent} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroTitle}>Move everyone up a year</Text>
            <Text style={styles.heroText}>
              Students and student-moderators advance one year level. 4th Year
              becomes Graduated. Staff accounts and anyone on hold are left
              alone.
            </Text>
          </View>
        </View>

        {pending.map((schedule) => {
          const failed = schedule.status === "failed";
          const running = schedule.status === "running";
          return (
            <View
              key={schedule.id}
              style={[
                styles.statusCard,
                failed && styles.statusCardFailed,
                running && styles.statusCardRunning,
              ]}
            >
              <View style={styles.statusHeader}>
                {running ? (
                  <ActivityIndicator size="small" color={theme.accent} />
                ) : (
                  <Ionicons
                    name={failed ? "alert-circle" : "time-outline"}
                    size={18}
                    color={failed ? theme.danger : theme.accent}
                  />
                )}
                <Text
                  style={[
                    styles.statusTitle,
                    failed && styles.statusTitleFailed,
                  ]}
                >
                  {failed
                    ? "Promotion failed"
                    : running
                      ? "Promotion running now"
                      : "Promotion scheduled"}
                </Text>
              </View>

              <Text style={styles.statusWhen}>
                {schedule.runAtMs
                  ? formatPromotionMoment(new Date(schedule.runAtMs))
                  : "Time not set"}
              </Text>

              {failed && !!schedule.error && (
                <Text style={styles.statusError} numberOfLines={3}>
                  {schedule.error}
                </Text>
              )}

              {failed && (
                <Text style={styles.statusHelp}>
                  Students already moved keep their new year level. Scheduling
                  this again resumes where it stopped — nobody is promoted twice.
                </Text>
              )}

              {!running && (
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={() => onCancelSchedule(schedule)}
                  activeOpacity={0.84}
                >
                  <Ionicons name="close-circle-outline" size={15} color={theme.danger} />
                  <Text style={styles.cancelText}>
                    {failed ? "Remove record" : "Cancel promotion"}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}

        <Text style={styles.sectionLabel}>When should it run?</Text>

        <View style={styles.card}>
          <TouchableOpacity
            style={styles.pickerRow}
            onPress={() => setShowDatePicker(true)}
            activeOpacity={0.82}
          >
            <View style={styles.pickerIcon}>
              <Ionicons name="calendar-outline" size={18} color={theme.accent} />
            </View>
            <View style={styles.pickerCopy}>
              <Text style={styles.pickerLabel}>Date</Text>
              <Text style={styles.pickerValue}>{dateLabel}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.pickerRow}
            onPress={() => setShowTimePicker(true)}
            activeOpacity={0.82}
          >
            <View style={styles.pickerIcon}>
              <Ionicons name="time-outline" size={18} color={theme.accent} />
            </View>
            <View style={styles.pickerCopy}>
              <Text style={styles.pickerLabel}>Time</Text>
              <Text style={styles.pickerValue}>{timeLabel}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>

          <Text style={styles.pickerHint}>
            Philippine time. The promotion starts within about two minutes of
            the time you choose.
          </Text>
        </View>

        {showDatePicker && (
          <DateTimePicker
            value={runAt}
            mode="date"
            display="default"
            minimumDate={new Date()}
            onChange={(event, selected) => {
              setShowDatePicker(Platform.OS === "ios");
              if (event.type === "dismissed" || !selected) return;
              const next = new Date(runAt);
              next.setFullYear(
                selected.getFullYear(),
                selected.getMonth(),
                selected.getDate(),
              );
              setRunAt(next);
            }}
          />
        )}

        {showTimePicker && (
          <DateTimePicker
            value={runAt}
            mode="time"
            display="default"
            is24Hour={false}
            onChange={(event, selected) => {
              setShowTimePicker(Platform.OS === "ios");
              if (event.type === "dismissed" || !selected) return;
              const next = new Date(runAt);
              next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
              setRunAt(next);
            }}
          />
        )}

        <Text style={styles.sectionLabel}>What will change</Text>

        <View style={styles.card}>
          {previewLoading ? (
            <View style={styles.previewLoading}>
              <ActivityIndicator color={theme.primary} />
              <Text style={styles.previewLoadingText}>Counting students…</Text>
            </View>
          ) : previewError ? (
            <View style={styles.previewLoading}>
              <Ionicons name="cloud-offline-outline" size={22} color={theme.textMuted} />
              <Text style={styles.previewLoadingText}>
                Could not read the student list. Tap refresh to try again.
              </Text>
            </View>
          ) : preview && preview.total === 0 ? (
            <View style={styles.previewLoading}>
              <Ionicons name="checkmark-circle-outline" size={22} color={theme.success} />
              <Text style={styles.previewLoadingText}>
                Nobody is eligible right now. Everyone is graduated, on hold, or
                has no year level set.
              </Text>
            </View>
          ) : preview ? (
            <>
              {preview.rows.map((row) => (
                <View key={`${row.from}-${row.to}`} style={styles.previewRow}>
                  <View style={styles.previewLadder}>
                    <Text style={styles.previewFrom}>{row.from}</Text>
                    <Ionicons name="arrow-forward" size={13} color={theme.textMuted} />
                    <Text
                      style={[
                        styles.previewTo,
                        row.to === "Graduated" && styles.previewToGraduated,
                      ]}
                    >
                      {row.to}
                    </Text>
                  </View>
                  <Text style={styles.previewCount}>{row.count}</Text>
                </View>
              ))}

              <View style={styles.previewTotalRow}>
                <Text style={styles.previewTotalLabel}>
                  {preview.total} student{preview.total === 1 ? "" : "s"} promoted
                </Text>
                {preview.graduating > 0 && (
                  <View style={styles.graduateChip}>
                    <Ionicons name="ribbon-outline" size={12} color="#6e4aa3" />
                    <Text style={styles.graduateChipText}>
                      {preview.graduating} graduating
                    </Text>
                  </View>
                )}
              </View>

              {VISIBLE_SKIPS.some((reason) => preview.skipped[reason] > 0) && (
                <>
                  <View style={styles.divider} />
                  <Text style={styles.skipHeading}>Not included</Text>
                  {VISIBLE_SKIPS.filter(
                    (reason) => preview.skipped[reason] > 0,
                  ).map((reason) => (
                    <View key={reason} style={styles.skipRow}>
                      <Text style={styles.skipLabel}>{SKIP_LABELS[reason]}</Text>
                      <Text style={styles.skipCount}>
                        {preview.skipped[reason]}
                      </Text>
                    </View>
                  ))}
                </>
              )}
            </>
          ) : null}
        </View>

        <Text style={styles.previewNote}>
          Counted from {preview?.studentsScanned ?? 0} account
          {preview?.studentsScanned === 1 ? "" : "s"} just now. Anyone registered
          after you schedule this is skipped automatically.
        </Text>

        <TouchableOpacity
          style={[
            styles.primaryButton,
            (busy || previewLoading || !preview?.total) &&
              styles.primaryButtonDisabled,
          ]}
          onPress={onSchedulePress}
          disabled={busy || previewLoading || !preview?.total}
          activeOpacity={0.86}
        >
          {busy ? (
            <ActivityIndicator color={theme.onPrimary} size="small" />
          ) : (
            <>
              <Ionicons name="calendar" size={17} color={theme.onPrimary} />
              <Text style={styles.primaryButtonText}>Schedule promotion</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.secondaryButton,
            (busy || previewLoading || !preview?.total) &&
              styles.secondaryButtonDisabled,
          ]}
          onPress={onRunNowPress}
          disabled={busy || previewLoading || !preview?.total}
          activeOpacity={0.86}
        >
          <Ionicons name="flash-outline" size={16} color={theme.accent} />
          <Text style={styles.secondaryButtonText}>Run now</Text>
        </TouchableOpacity>

        {lastRun && (
          <View style={styles.lastRunCard}>
            <View style={styles.statusHeader}>
              <Ionicons name="checkmark-circle" size={17} color={theme.success} />
              <Text style={styles.lastRunTitle}>Last promotion</Text>
            </View>
            <Text style={styles.lastRunText}>
              {lastRun.promotedCount} student
              {lastRun.promotedCount === 1 ? "" : "s"} promoted
              {lastRun.graduatedCount
                ? `, ${lastRun.graduatedCount} graduated`
                : ""}
              {lastRun.completedAtMs
                ? ` on ${formatPromotionMoment(new Date(lastRun.completedAtMs))}`
                : ""}
              .
            </Text>
          </View>
        )}
      </ScrollView>

      <ConfirmDialog
        visible={dialog.visible}
        title={dialog.title}
        description={dialog.description}
        confirmText={dialog.confirmText}
        cancelText={dialog.cancelText}
        destructive={dialog.destructive ?? false}
        singleAction={dialog.singleAction ?? false}
        onConfirm={dialog.onConfirm ?? closeDialog}
        onCancel={closeDialog}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 10,
  },
  deniedTitle: { color: c.textPrimary, fontSize: 16, fontWeight: "900" },
  deniedText: {
    color: c.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  topBarTitle: { color: c.textPrimary, fontSize: 16, fontWeight: "900" },

  content: { padding: 16, gap: 12 },

  heroCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 18,
    padding: 16,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: 15,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  heroCopy: { flex: 1 },
  heroTitle: { color: c.textPrimary, fontSize: 16, fontWeight: "900" },
  heroText: {
    color: c.textMuted,
    fontSize: 12.5,
    lineHeight: 16,
    marginTop: 3,
  },

  sectionLabel: {
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginTop: 6,
  },

  card: {
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 18,
    padding: 16,
  },

  pickerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  pickerIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  pickerCopy: { flex: 1 },
  pickerLabel: { color: c.textMuted, fontSize: 11.5, fontWeight: "800" },
  pickerValue: {
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "800",
    marginTop: 2,
  },
  pickerHint: {
    color: c.textMuted,
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 12,
  },

  divider: { height: 1, backgroundColor: c.border, marginVertical: 12 },

  previewLoading: { alignItems: "center", gap: 9, paddingVertical: 14 },
  previewLoadingText: {
    color: c.textMuted,
    fontSize: 12.5,
    textAlign: "center",
    lineHeight: 16,
  },

  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 7,
  },
  previewLadder: { flexDirection: "row", alignItems: "center", gap: 7, flex: 1 },
  previewFrom: { color: c.textMuted, fontSize: 13.5, fontWeight: "700" },
  previewTo: { color: c.textPrimary, fontSize: 13.5, fontWeight: "900" },
  previewToGraduated: { color: "#6e4aa3" },
  previewCount: { color: c.primary, fontSize: 15, fontWeight: "900" },

  previewTotalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 10,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  previewTotalLabel: { color: c.textPrimary, fontSize: 13.5, fontWeight: "900", flex: 1 },
  graduateChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#f1ebfa",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  graduateChipText: { color: "#6e4aa3", fontSize: 11.5, fontWeight: "900" },

  skipHeading: {
    color: c.textMuted,
    fontSize: 11.5,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  skipRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 5,
  },
  skipLabel: { color: c.textMuted, fontSize: 12.5 },
  skipCount: { color: c.textMuted, fontSize: 12.5, fontWeight: "800" },

  previewNote: {
    color: c.textMuted,
    fontSize: 11.5,
    lineHeight: 16,
    paddingHorizontal: 2,
  },

  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.primary,
    borderRadius: 15,
    paddingVertical: 16,
    marginTop: 4,
  },
  primaryButtonDisabled: { backgroundColor: c.borderStrong },
  primaryButtonText: { color: c.background, fontSize: 14.5, fontWeight: "900" },

  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 15,
    paddingVertical: 12,
  },
  secondaryButtonDisabled: { opacity: 0.5 },
  secondaryButtonText: { color: c.accent, fontSize: 13.5, fontWeight: "900" },

  statusCard: {
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 18,
    padding: 16,
    gap: 7,
  },
  statusCardRunning: { backgroundColor: c.successSoft, borderColor: c.success },
  statusCardFailed: { backgroundColor: c.dangerSoft, borderColor: "#f0cfcb" },
  statusHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusTitle: { color: c.accent, fontSize: 13.5, fontWeight: "900" },
  statusTitleFailed: { color: c.danger },
  statusWhen: { color: c.textPrimary, fontSize: 15, fontWeight: "800" },
  statusError: { color: c.danger, fontSize: 12, lineHeight: 17 },
  statusHelp: { color: c.textMuted, fontSize: 12, lineHeight: 17 },
  cancelButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    marginTop: 3,
  },
  cancelText: { color: c.danger, fontSize: 12.5, fontWeight: "800" },

  lastRunCard: {
    backgroundColor: c.successSoft,
    borderWidth: 1,
    borderColor: c.success,
    borderRadius: 18,
    padding: 16,
    gap: 6,
    marginTop: 4,
  },
  lastRunTitle: { color: c.success, fontSize: 13.5, fontWeight: "900" },
  lastRunText: { color: c.success, fontSize: 12.5, lineHeight: 18 },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

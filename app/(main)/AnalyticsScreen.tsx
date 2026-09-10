// Analytics — a staff-only overview screen.
//   • "right now" numbers  -> getCountFromServer on the live collection
//   • "this week" / trends -> the dailyStats rollup (utils/dailyStats.ts),
//     written once a day by the Cloudflare Worker cron job.
//   • anomaly briefing     -> statistical test in utils/analyticsAnomalies.ts,
//     rendered through a fixed template (never LLM-narrated).
//   • recommendations      -> reuses clusterUnansweredQuestions + the same
//     AiMemoryScreen prefill hand-off UnansweredQuestionsScreen already uses.
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  collection,
  getCountFromServer,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import { requestDailyRollup } from "@/utils/aiWorker";
import {
  anomalySentence,
  detectAnomalies,
  type AnomalyResult,
} from "@/utils/analyticsAnomalies";
import {
  aggregateCategoryCounts,
  fetchRecentDailyStats,
  seriesOf,
  sumDailyStat,
  type DailyStat,
} from "@/utils/dailyStats";
import { POST_FLAIRS } from "@/utils/postFlairs";
import { isStaff, resolveUserRoleForAuthUser, type UserRole } from "@/utils/rbac";
import {
  clusterUnansweredQuestions,
  type UnansweredQuestionCluster,
} from "@/utils/unansweredClustering";
import ConfirmDialog from "./components/ConfirmDialog";
import {
  CategoryBar,
  DailyActiveUsersLine,
  DistributionDonut,
  type NamedValue,
} from "./components/analyticsCharts";

// 35 days of rollup history: enough for the anomaly baseline (current week +
// preceding 4 weeks) as well as the line chart (7/30 toggle), the KPI
// sparklines (last 14) and the moderation-reasons breakdown (last 30).
const HISTORY_DAYS = 35;
const SPARK_DAYS = 14;
const WEEK_DAYS = 7;
const MODERATION_REASON_WINDOW_DAYS = 30;
const LINE_RANGES = [7, 30] as const;
const MAX_RECOMMENDATIONS = 5;

// keyword:weapons -> "Weapons (keyword)", self-harm/intent -> "Self-harm intent"
function friendlyCategory(raw: string): string {
  const keyword = raw.startsWith("keyword:") ? raw.slice("keyword:".length) : null;
  const base = keyword ?? raw;
  const words = base.replace(/[/_-]+/g, " ").trim();
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return keyword ? `${titled} (keyword)` : titled;
}

// ── Minimal dependency-free sparkline ──────────────────────────────────────
// A row of thin bars scaled to the series max. Deliberately not a chart
// library — Task 2 makes that call; this stays self-contained.
function Sparkline({
  data,
  color = "#8f3a2b",
}: {
  data: number[];
  color?: string;
}) {
  const max = Math.max(1, ...data);
  return (
    <View style={styles.sparkRow}>
      {data.map((value, index) => (
        <View
          key={index}
          style={[
            styles.sparkBar,
            {
              height: 3 + (value / max) * 26,
              backgroundColor: color,
              opacity: 0.3 + 0.7 * (value / max),
            },
          ]}
        />
      ))}
    </View>
  );
}

type KpiCardProps = {
  label: string;
  value: number | string;
  caption: string;
  series: number[];
  accent: string;
  featured?: boolean;
  loading?: boolean;
};

function KpiCard({
  label,
  value,
  caption,
  series,
  accent,
  featured,
  loading,
}: KpiCardProps) {
  return (
    <View
      style={[
        styles.card,
        featured ? styles.cardFeatured : styles.cardHalf,
        featured && { borderColor: accent },
      ]}
    >
      <Text style={[styles.cardLabel, featured && styles.cardLabelFeatured]}>
        {label}
      </Text>
      {loading ? (
        <ActivityIndicator
          size="small"
          color={accent}
          style={styles.cardValueLoading}
        />
      ) : (
        <Text
          style={[
            styles.cardValue,
            featured && styles.cardValueFeatured,
            { color: accent },
          ]}
        >
          {value}
        </Text>
      )}
      <Sparkline data={series} color={accent} />
      <Text style={styles.cardCaption}>{caption}</Text>
    </View>
  );
}

export default function AnalyticsScreen() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [role, setRole] = useState<UserRole | undefined>(undefined);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rollingUp, setRollingUp] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; description?: string } | null>(
    null,
  );

  const [activeNow, setActiveNow] = useState<number | null>(null);
  const [pendingModeration, setPendingModeration] = useState<number | null>(null);
  const [trend, setTrend] = useState<DailyStat[]>([]);
  const [flairDist, setFlairDist] = useState<NamedValue[]>([]);
  const [roleDist, setRoleDist] = useState<NamedValue[]>([]);
  const [reportDist, setReportDist] = useState<NamedValue[]>([]);
  const [lineRange, setLineRange] = useState<(typeof LINE_RANGES)[number]>(7);
  const [unansweredClusters, setUnansweredClusters] = useState<
    UnansweredQuestionCluster[]
  >([]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user: User | null) => {
      if (!user) {
        setRole(undefined);
        setAuthChecked(true);
        return;
      }
      try {
        setRole(await resolveUserRoleForAuthUser(user));
      } catch {
        setRole(undefined);
      } finally {
        setAuthChecked(true);
      }
    });
    return unsubscribe;
  }, []);

  const canView = isStaff(role);

  const load = useCallback(async () => {
    try {
      const [
        onlineSnap,
        pendingSnap,
        rows,
        flairSnaps,
        studentsTotalSnap,
        teacherSnap,
        moderatorSnap,
        adminSnap,
        reportsTotalSnap,
        reportsResolvedSnap,
        reportsDismissedSnap,
      ] = await Promise.all([
        getCountFromServer(
          query(collection(db, "students"), where("isOnline", "==", true)),
        ),
        getCountFromServer(
          query(collection(db, "posts"), where("moderationStatus", "==", "pending")),
        ),
        fetchRecentDailyStats(HISTORY_DAYS),
        // Bar chart — current posts-by-flair distribution (one count per flair).
        Promise.all(
          POST_FLAIRS.map((flair) =>
            getCountFromServer(
              query(collection(db, "posts"), where("flair", "==", flair.id)),
            ),
          ),
        ),
        // Donut — role distribution (student derived as total − staff).
        getCountFromServer(collection(db, "students")),
        getCountFromServer(
          query(collection(db, "students"), where("role", "==", "teacher")),
        ),
        getCountFromServer(
          query(collection(db, "students"), where("role", "==", "moderator")),
        ),
        getCountFromServer(
          query(collection(db, "students"), where("role", "==", "admin")),
        ),
        // Donut — report resolution status (pending derived as total − closed).
        getCountFromServer(collection(db, "reports")),
        getCountFromServer(
          query(collection(db, "reports"), where("status", "==", "resolved")),
        ),
        getCountFromServer(
          query(collection(db, "reports"), where("status", "==", "dismissed")),
        ),
      ]);

      setActiveNow(onlineSnap.data().count);
      setPendingModeration(pendingSnap.data().count);
      setTrend(rows);

      setFlairDist(
        POST_FLAIRS.map((flair, index) => ({
          label: flair.label,
          value: flairSnaps[index].data().count,
        })),
      );

      const teachers = teacherSnap.data().count;
      const moderators = moderatorSnap.data().count;
      const admins = adminSnap.data().count;
      const studentsTotal = studentsTotalSnap.data().count;
      setRoleDist([
        {
          label: "Student",
          value: Math.max(0, studentsTotal - teachers - moderators - admins),
        },
        { label: "Teacher", value: teachers },
        { label: "Moderator", value: moderators },
        { label: "Admin", value: admins },
      ]);

      const reportsTotal = reportsTotalSnap.data().count;
      const resolved = reportsResolvedSnap.data().count;
      const dismissed = reportsDismissedSnap.data().count;
      setReportDist([
        { label: "Pending", value: Math.max(0, reportsTotal - resolved - dismissed) },
        { label: "Resolved", value: resolved },
        { label: "Dismissed", value: dismissed },
      ]);
    } catch (error) {
      console.error("Analytics load failed:", error);
      setDialog({
        title: "Couldn't load analytics",
        description: "Check your connection and try again.",
      });
    }
  }, []);

  useEffect(() => {
    if (!authChecked || !canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [authChecked, canView, load]);

  // Live unanswered-question clusters — same source and clustering the
  // Unanswered Questions screen uses; here we just surface the top few.
  useEffect(() => {
    if (!authChecked || !canView) return;
    const unsubscribe = onSnapshot(
      query(
        collection(db, "chatbotUnansweredQuestions"),
        orderBy("createdAt", "desc"),
      ),
      (snapshot) => {
        const questions = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          prompt: String(docSnap.data().prompt || ""),
        }));
        setUnansweredClusters(
          clusterUnansweredQuestions(questions)
            .filter((cluster) => cluster.count >= 2)
            .slice(0, MAX_RECOMMENDATIONS),
        );
      },
      (error) => console.error("Unanswered questions listener failed:", error),
    );
    return unsubscribe;
  }, [authChecked, canView]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  }, [load]);

  const runRollupNow = useCallback(async () => {
    setRollingUp(true);
    try {
      await requestDailyRollup();
      await load();
      setDialog({
        title: "Rollup complete",
        description: "Today's numbers are refreshed below.",
      });
    } catch (error) {
      setDialog({
        title: "Rollup failed",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setRollingUp(false);
    }
  }, [load]);

  const weekRows = useMemo(() => trend.slice(-WEEK_DAYS), [trend]);
  const newPostsThisWeek = useMemo(
    () => sumDailyStat(weekRows, "postsCreated"),
    [weekRows],
  );
  const criticalThisWeek = useMemo(
    () => sumDailyStat(weekRows, "criticalFlags"),
    [weekRows],
  );

  const lastRollup = useMemo(() => {
    for (let i = trend.length - 1; i >= 0; i -= 1) {
      if (trend[i].computedAtMs) return trend[i];
    }
    return null;
  }, [trend]);

  const hasRollupData = lastRollup !== null;

  const anomalyResult: AnomalyResult = useMemo(
    () => detectAnomalies(trend),
    [trend],
  );

  // Same hand-off UnansweredQuestionsScreen.openAiMemorySuggestion uses:
  // navigate to AiMemoryScreen with the cluster's title + tags pre-filled,
  // answer left blank for staff to write.
  const openRecommendation = useCallback(
    (cluster: UnansweredQuestionCluster) => {
      router.push({
        pathname: "/(main)/AiMemoryScreen",
        params: {
          prefillTitle: cluster.suggestedTitle,
          prefillTags: cluster.suggestedTags.join(", "),
        },
      });
    },
    [router],
  );

  // Line chart — daily active users for the selected range (oldest→newest).
  const activeUsersLine = useMemo(() => {
    const rows = trend.slice(-lineRange);
    return rows.map((row, index) => {
      let label = "";
      if (lineRange <= 7) {
        label = new Date(`${row.date}T00:00:00Z`).toLocaleDateString("en-US", {
          weekday: "short",
        });
      } else if (index === 0 || index === rows.length - 1 || index % 6 === 0) {
        label = String(new Date(`${row.date}T00:00:00Z`).getUTCDate());
      }
      return { value: row.activeUsers, label };
    });
  }, [trend, lineRange]);

  // Bar chart — moderation reasons over the trailing MODERATION_REASON_WINDOW_DAYS.
  const moderationReasons = useMemo(
    () =>
      aggregateCategoryCounts(trend.slice(-MODERATION_REASON_WINDOW_DAYS))
        .slice(0, 8)
        .map((entry) => ({
          label: friendlyCategory(entry.category),
          value: entry.count,
        })),
    [trend],
  );

  if (authChecked && !canView) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.deniedState}>
          <Ionicons name="lock-closed-outline" size={44} color="#e0a53d" />
          <Text style={styles.deniedTitle}>Staff only</Text>
          <Text style={styles.deniedText}>
            Analytics is available to teachers, moderators and admins.
          </Text>
          <TouchableOpacity
            style={styles.deniedButton}
            onPress={() => router.back()}
          >
            <Text style={styles.deniedButtonText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.topBar}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          activeOpacity={0.8}
        >
          <Ionicons name="arrow-back" size={21} color="#fffaf6" />
        </TouchableOpacity>
        <View style={styles.topBarCopy}>
          <Text style={styles.topBarEyebrow}>ADMIN WORKSPACE</Text>
          <Text style={styles.topBarTitle}>Analytics</Text>
        </View>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {loading ? (
          <View style={styles.loadingState}>
            <ActivityIndicator size="large" color="#8f3a2b" />
          </View>
        ) : (
          <>
            <View style={styles.briefingCard}>
              <View style={styles.briefingHeader}>
                <Ionicons name="pulse-outline" size={16} color="#8f1d2c" />
                <Text style={styles.briefingTitle}>This week&apos;s briefing</Text>
              </View>
              {anomalyResult.status === "insufficient-history" ? (
                <Text style={styles.briefingMuted}>
                  Not enough rollup history for anomaly detection yet —{" "}
                  {anomalyResult.weeksAvailable} of {anomalyResult.weeksNeeded}{" "}
                  baseline weeks so far. It compares this week against the
                  previous {anomalyResult.weeksNeeded}.
                </Text>
              ) : anomalyResult.anomalies.length === 0 ? (
                <Text style={styles.briefingMuted}>
                  No unusual activity this week — critical flags, reports and
                  pending moderation are all within ±50% of the 4-week average.
                </Text>
              ) : (
                anomalyResult.anomalies.map((anomaly) => (
                  <View key={anomaly.field} style={styles.briefingLine}>
                    <Ionicons
                      name={
                        anomaly.direction === "up"
                          ? "arrow-up-circle"
                          : "arrow-down-circle"
                      }
                      size={15}
                      color={anomaly.direction === "up" ? "#b3261e" : "#356a59"}
                    />
                    <Text style={styles.briefingLineText}>
                      {anomalySentence(anomaly)}
                    </Text>
                  </View>
                ))
              )}
            </View>

            <KpiCard
              featured
              label="Critical safety flags this week"
              value={criticalThisWeek}
              caption={`Last ${WEEK_DAYS} days · trend over ${SPARK_DAYS}`}
              series={seriesOf(trend, "criticalFlags").slice(-SPARK_DAYS)}
              accent="#b3261e"
            />

            <View style={styles.grid}>
              <KpiCard
                label="Active users now"
                value={activeNow ?? "—"}
                caption="Online right now"
                series={seriesOf(trend, "activeUsers").slice(-SPARK_DAYS)}
                accent="#356a59"
              />
              <KpiCard
                label="Pending moderation"
                value={pendingModeration ?? "—"}
                caption="Awaiting review now"
                series={seriesOf(trend, "moderationPending").slice(-SPARK_DAYS)}
                accent="#b86b1d"
              />
              <KpiCard
                label="New posts this week"
                value={newPostsThisWeek}
                caption={`Last ${WEEK_DAYS} days`}
                series={seriesOf(trend, "postsCreated").slice(-SPARK_DAYS)}
                accent="#5f0909"
              />
              <KpiCard
                label="Comments this week"
                value={sumDailyStat(weekRows, "commentsCreated")}
                caption={`Last ${WEEK_DAYS} days`}
                series={seriesOf(trend, "commentsCreated").slice(-SPARK_DAYS)}
                accent="#6e4aa3"
              />
            </View>

            {!hasRollupData && (
              <View style={styles.noticeCard}>
                <Ionicons name="time-outline" size={16} color="#8a5a10" />
                <Text style={styles.noticeText}>
                  No daily rollup data yet. Weekly totals, sparklines and the
                  trend charts fill in once the nightly job runs — or tap “Run
                  rollup now”.
                </Text>
              </View>
            )}

            <View style={styles.chartCard}>
              <View style={styles.chartHeaderRow}>
                <Text style={styles.chartTitle}>Daily active users</Text>
                <View style={styles.rangeToggle}>
                  {LINE_RANGES.map((days) => (
                    <TouchableOpacity
                      key={days}
                      style={[
                        styles.rangeChip,
                        lineRange === days && styles.rangeChipActive,
                      ]}
                      onPress={() => setLineRange(days)}
                    >
                      <Text
                        style={[
                          styles.rangeChipText,
                          lineRange === days && styles.rangeChipTextActive,
                        ]}
                      >
                        {days}d
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
              <Text style={styles.chartSubtitle}>
                Contributors per day, from the daily rollup.
              </Text>
              <DailyActiveUsersLine data={activeUsersLine} rangeDays={lineRange} />
            </View>

            <View style={styles.chartCard}>
              <Text style={styles.chartTitle}>Posts by flair</Text>
              <Text style={styles.chartSubtitle}>
                Current distribution across all posts.
              </Text>
              <CategoryBar
                data={flairDist}
                color="#5f0909"
                emptyNote="No posts yet."
              />
            </View>

            <View style={styles.chartCard}>
              <Text style={styles.chartTitle}>Moderation reasons</Text>
              <Text style={styles.chartSubtitle}>
                Categories on flagged content · last{" "}
                {MODERATION_REASON_WINDOW_DAYS} days.
              </Text>
              <CategoryBar
                data={moderationReasons}
                color="#b86b1d"
                emptyNote="No flagged content in this window."
              />
            </View>

            <View style={styles.chartCard}>
              <Text style={styles.chartTitle}>Role distribution</Text>
              <Text style={styles.chartSubtitle}>Everyone on BondED right now.</Text>
              <DistributionDonut data={roleDist} emptyNote="No accounts yet." />
            </View>

            <View style={styles.chartCard}>
              <Text style={styles.chartTitle}>Report resolution</Text>
              <Text style={styles.chartSubtitle}>
                Every report ever submitted, by status.
              </Text>
              <DistributionDonut
                data={reportDist}
                emptyNote="No reports submitted yet."
              />
            </View>

            <View style={styles.chartCard}>
              <Text style={styles.chartTitle}>Frequently asked, not yet answered</Text>
              <Text style={styles.chartSubtitle}>
                Clusters of similar chatbot questions with no AI Memory entry.
                Tap one to start an answer.
              </Text>
              {unansweredClusters.length === 0 ? (
                <View style={styles.recEmpty}>
                  <Ionicons
                    name="checkmark-circle-outline"
                    size={18}
                    color="#356a59"
                  />
                  <Text style={styles.recEmptyText}>
                    Nothing pending — every common question has an answer.
                  </Text>
                </View>
              ) : (
                unansweredClusters.map((cluster) => (
                  <TouchableOpacity
                    key={cluster.representativePrompt}
                    style={styles.recRow}
                    activeOpacity={0.8}
                    onPress={() => openRecommendation(cluster)}
                  >
                    <View style={styles.recCount}>
                      <Text style={styles.recCountText}>{cluster.count}</Text>
                    </View>
                    <View style={styles.recBody}>
                      <Text style={styles.recTitle} numberOfLines={2}>
                        {cluster.suggestedTitle || cluster.representativePrompt}
                      </Text>
                      {cluster.suggestedTags.length > 0 && (
                        <Text style={styles.recTags} numberOfLines={1}>
                          {cluster.suggestedTags.join(" · ")}
                        </Text>
                      )}
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="#c3a99e" />
                  </TouchableOpacity>
                ))
              )}
            </View>

            <View style={styles.footerRow}>
              <Text style={styles.footerText}>
                {lastRollup
                  ? `Last rollup: ${lastRollup.date}${lastRollup.partial ? " (partial)" : ""}`
                  : "Trends come from the daily rollup job."}
              </Text>
              <TouchableOpacity
                style={[styles.rollupButton, rollingUp && styles.rollupButtonBusy]}
                onPress={runRollupNow}
                disabled={rollingUp}
                activeOpacity={0.85}
              >
                {rollingUp ? (
                  <ActivityIndicator size="small" color="#5f0909" />
                ) : (
                  <>
                    <Ionicons name="refresh" size={14} color="#5f0909" />
                    <Text style={styles.rollupButtonText}>Run rollup now</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </>
        )}
      </ScrollView>

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmText="OK"
        singleAction
        destructive={false}
        onConfirm={() => setDialog(null)}
        onCancel={() => setDialog(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#5f0909" },
  topBar: {
    minHeight: 66,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#5f0909",
    borderBottomWidth: 1,
    borderBottomColor: "#7e2724",
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  topBarCopy: { flex: 1 },
  topBarEyebrow: {
    color: "#d9b27a",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.1,
  },
  topBarTitle: { color: "#fffaf6", fontSize: 22, fontWeight: "900", marginTop: 2 },
  body: { flex: 1, backgroundColor: "#f8f3ef" },
  content: { padding: 16, paddingBottom: 60 },
  loadingState: { paddingTop: 80, alignItems: "center" },

  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 12,
  },
  card: {
    backgroundColor: "#fffaf6",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#eadfd9",
    padding: 15,
  },
  cardHalf: { width: "48%", flexGrow: 1 },
  cardFeatured: { width: "100%", borderWidth: 2, padding: 18 },
  cardLabel: {
    color: "#7a3b2e",
    fontSize: 11.5,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  cardLabelFeatured: { fontSize: 12.5, color: "#8f1d2c" },
  cardValue: { fontSize: 26, fontWeight: "900", marginTop: 6 },
  cardValueFeatured: { fontSize: 40 },
  cardValueLoading: { alignSelf: "flex-start", marginTop: 10, marginBottom: 6 },
  cardCaption: { color: "#98766d", fontSize: 10.5, marginTop: 6 },

  sparkRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 30,
    marginTop: 10,
  },
  sparkBar: { flex: 1, borderRadius: 1.5, minWidth: 2 },

  noticeCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
    backgroundColor: "#fbeecf",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e7cd93",
    padding: 13,
    marginTop: 16,
  },
  noticeText: { flex: 1, color: "#7a5312", fontSize: 12, lineHeight: 17 },

  briefingCard: {
    backgroundColor: "#fff2f0",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#efc9c3",
    padding: 14,
    marginBottom: 4,
  },
  briefingHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginBottom: 8,
  },
  briefingTitle: {
    color: "#8f1d2c",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  briefingMuted: { color: "#7a5b56", fontSize: 12.5, lineHeight: 18 },
  briefingLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    paddingVertical: 3,
  },
  briefingLineText: {
    flex: 1,
    color: "#4c1b14",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },

  recEmpty: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
  },
  recEmptyText: { color: "#4a6b60", fontSize: 12.5, flex: 1 },
  recRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#f1e5e0",
  },
  recCount: {
    minWidth: 26,
    height: 26,
    borderRadius: 8,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f3e2d9",
  },
  recCountText: { color: "#8f3a2b", fontSize: 12, fontWeight: "900" },
  recBody: { flex: 1 },
  recTitle: { color: "#4c1b14", fontSize: 13, fontWeight: "700", lineHeight: 17 },
  recTags: { color: "#98766d", fontSize: 11, marginTop: 3 },

  chartCard: {
    backgroundColor: "#fffaf6",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#eadfd9",
    padding: 14,
    marginTop: 14,
  },
  chartHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  chartTitle: { color: "#4c1b14", fontSize: 15, fontWeight: "900" },
  chartSubtitle: { color: "#98766d", fontSize: 11, marginTop: 3 },
  rangeToggle: {
    flexDirection: "row",
    backgroundColor: "#f4e7de",
    borderRadius: 9,
    padding: 2,
    gap: 2,
  },
  rangeChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 7,
  },
  rangeChipActive: { backgroundColor: "#5f0909" },
  rangeChipText: { color: "#7a3b2e", fontSize: 11, fontWeight: "800" },
  rangeChipTextActive: { color: "#fffaf6" },

  footerRow: {
    marginTop: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  footerText: { flex: 1, color: "#98766d", fontSize: 11 },
  rollupButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fffaf6",
    borderWidth: 1,
    borderColor: "#e0bf80",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    minWidth: 130,
    justifyContent: "center",
  },
  rollupButtonBusy: { opacity: 0.7 },
  rollupButtonText: { color: "#5f0909", fontSize: 12, fontWeight: "800" },

  deniedState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 30,
    backgroundColor: "#f8f3ef",
  },
  deniedTitle: {
    color: "#4c1b14",
    fontSize: 20,
    fontWeight: "900",
    marginTop: 14,
  },
  deniedText: {
    color: "#8a6a60",
    fontSize: 13,
    textAlign: "center",
    marginTop: 6,
    lineHeight: 19,
  },
  deniedButton: {
    marginTop: 20,
    backgroundColor: "#5f0909",
    borderRadius: 12,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  deniedButtonText: { color: "#fffaf6", fontWeight: "800" },
});

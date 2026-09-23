import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { auth, db } from "../../Firebase_configure";
import ConfirmDialog from "./components/ConfirmDialog";
import { CardListSkeleton, SkeletonCard } from "./components/Skeleton";
import {
  getUserData,
  isStaff,
  parseUserRole,
  resolveUserRoleForAuthUser,
  type UserRole,
} from "@/utils/rbac";


type ReportStatus = "pending" | "resolved" | "dismissed" | string;
type ReportFilter = "all" | "pending" | "resolved" | "dismissed";

type ReportRecord = {
  id: string;
  contentType: string;
  contentId: string;
  reportedBy: string;
  reason: string;
  status: ReportStatus;
  createdAt?: any;
  reviewedAt?: any;
  reviewedBy?: string;
  reviewerName?: string;
  reporterName?: string;
  contentText?: string;
  contentAuthor?: string;
  contentAuthorId?: string;
  contentExists?: boolean;
  originalModerationStatus?: string;
  originalModerationReasons?: string[];
  originalModerationModel?: string | null;
};

/**
 * Every report filed against one piece of content, collapsed into a single
 * row. Twelve students flagging the same post is one decision for a
 * moderator, not twelve — and reading it twelve times is how the thirteenth,
 * different report gets missed.
 */
type ReportGroup = {
  key: string;
  primary: ReportRecord;
  reports: ReportRecord[];
  /** Distinct reasons with their counts, most-cited first. */
  reasons: { label: string; count: number }[];
  reporterNames: string[];
  pendingCount: number;
};

const FILTERS: { value: ReportFilter; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: "all", label: "All", icon: "apps-outline" },
  { value: "pending", label: "Pending", icon: "time-outline" },
  { value: "resolved", label: "Resolved", icon: "checkmark-circle-outline" },
  { value: "dismissed", label: "Dismissed", icon: "close-circle-outline" },
];

const COLLECTION_BY_TYPE: Record<string, string> = {
  post: "posts",
  comment: "comments",
  reply: "replies",
  message: "communityThreadMessages",
  poll: "polls",
};

function formatDate(value: any) {
  if (!value) return "Unknown date";
  try {
    const date = value?.toDate ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown date";
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "Unknown date";
  }
}

/** Sort key for a Firestore timestamp, Date, or millis number. 0 if absent. */
function timestampMs(value: any): number {
  if (!value) return 0;
  try {
    const date = value?.toDate ? value.toDate() : new Date(value);
    const ms = date.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  } catch {
    return 0;
  }
}

function normalizeReason(reason: string) {
  return reason
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getContentTypeLabel(type: string) {
  const labels: Record<string, string> = {
    post: "Post",
    comment: "Comment",
    reply: "Reply",
    message: "Server Message",
    poll: "Poll",
  };
  return labels[type] || type.replace(/[_-]/g, " ");
}

function getStatusMeta(status: ReportStatus, theme: ThemeTokens) {
  if (status === "resolved") {
    return { label: "Resolved", icon: "checkmark-circle" as const, color: theme.success, bg: theme.successSoft };
  }
  if (status === "dismissed") {
    return { label: "Dismissed", icon: "close-circle" as const, color: theme.textMuted, bg: theme.surfaceSunken };
  }
  return { label: "Pending", icon: "time" as const, color: theme.warning, bg: theme.accentSoft };
}

// One report in the list. Memoized so a report whose details finish loading
// (or that becomes busy) redraws on its own instead of every visible report.
const ReportCard = memo(function ReportCard({
  report,
  isBusy,
  duplicateCount,
  reasons,
  reporterNames,
  onOpen,
  onChangeStatus,
}: {
  report: ReportRecord;
  isBusy: boolean;
  /** How many reports this one row stands for. 1 means an ordinary report. */
  duplicateCount: number;
  reasons: { label: string; count: number }[];
  reporterNames: string[];
  onOpen: (report: ReportRecord) => void;
  onChangeStatus: (report: ReportRecord, nextStatus: "resolved" | "dismissed" | "pending") => void;
}) {
  const { styles, theme } = useStyles();
  const status = getStatusMeta(report.status, theme);
  return (
    <TouchableOpacity
      style={styles.reportCard}
      activeOpacity={0.88}
      onPress={() => onOpen(report)}
    >
      <View style={styles.reportTopRow}>
        <View style={styles.typeBadge}>
          <Ionicons name="flag-outline" size={14} color={theme.danger} />
          <Text style={styles.typeBadgeText}>{getContentTypeLabel(report.contentType)}</Text>
        </View>
        {duplicateCount > 1 && (
          <View style={styles.duplicateBadge}>
            <Ionicons name="layers-outline" size={13} color={theme.accent} />
            <Text style={styles.duplicateBadgeText}>{duplicateCount} reports</Text>
          </View>
        )}
        <View style={[styles.statusBadge, { backgroundColor: status.bg }]}>
          <Ionicons name={status.icon} size={14} color={status.color} />
          <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
        </View>
      </View>

      {duplicateCount > 1 ? (
        <View style={styles.reasonList}>
          {reasons.map((entry) => (
            <View key={entry.label} style={styles.reasonChip}>
              <Text style={styles.reasonChipText}>{entry.label}</Text>
              <Text style={styles.reasonChipCount}>{entry.count}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.reportReason}>{normalizeReason(report.reason)}</Text>
      )}

      <Text style={styles.reportPreview} numberOfLines={3}>
        {report.contentText || "Loading content preview..."}
      </Text>

      <View style={styles.metaRow}>
        <Text style={styles.metaText} numberOfLines={1}>
          {duplicateCount > 1
            ? `Reported by ${reporterNames.slice(0, 2).join(", ")}${
                reporterNames.length > 2
                  ? ` and ${reporterNames.length - 2} other${reporterNames.length - 2 === 1 ? "" : "s"}`
                  : ""
              }`
            : `Reported by ${report.reporterName || report.reportedBy || "Unknown user"}`}
        </Text>
        <Text style={styles.metaText}>{formatDate(report.createdAt)}</Text>
      </View>

      {report.status === "pending" && (
        <View style={styles.quickActions}>
          <TouchableOpacity
            style={styles.dismissButton}
            disabled={isBusy}
            onPress={(event) => {
              event.stopPropagation();
              onChangeStatus(report, "dismissed");
            }}
          >
            <Ionicons name="close-circle-outline" size={17} color={theme.textSecondary} />
            <Text style={styles.dismissButtonText}>Dismiss</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.resolveButton}
            disabled={isBusy}
            onPress={(event) => {
              event.stopPropagation();
              onChangeStatus(report, "resolved");
            }}
          >
            <Ionicons name="checkmark-circle-outline" size={17} color={theme.onPrimary} />
            <Text style={styles.resolveButtonText}>Resolve</Text>
          </TouchableOpacity>
        </View>
      )}
    </TouchableOpacity>
  );
});

export default function ReportManagementScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const [userRole, setUserRole] = useState<UserRole | undefined>();
  const [authLoading, setAuthLoading] = useState(true);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<ReportFilter>("pending");
  const [search, setSearch] = useState("");
  const [selectedReport, setSelectedReport] = useState<ReportRecord | null>(null);
  const [busyReportId, setBusyReportId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    reportId: string;
    title: string;
    description: string;
    confirmText: string;
    destructive: boolean;
    nextStatus: "resolved" | "dismissed" | "pending";
  } | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      try {
        if (!user) {
          setUserRole(undefined);
          return;
        }
        const role = await resolveUserRoleForAuthUser(user);
        setUserRole(parseUserRole(role));
      } finally {
        setAuthLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isStaff(userRole)) {
      router.replace("/(main)/(tabs)/HomeScreen");
      return;
    }

    const unsubscribe = onSnapshot(
      collection(db, "reports"),
      async (snapshot) => {
        setLoading(false);
        const baseReports: ReportRecord[] = snapshot.docs.map((reportDoc) => {
          const data = reportDoc.data();
          return {
            id: reportDoc.id,
            contentType: String(data.contentType || "unknown"),
            contentId: String(data.contentId || ""),
            reportedBy: String(data.reportedBy || ""),
            reason: String(data.reason || "unspecified"),
            status: String(data.status || "pending"),
            createdAt: data.createdAt,
            reviewedAt: data.reviewedAt,
            reviewedBy: data.reviewedBy,
          };
        });

        baseReports.sort((a, b) => {
          const aTime = a.createdAt?.toMillis?.() ?? 0;
          const bTime = b.createdAt?.toMillis?.() ?? 0;
          return bTime - aTime;
        });

        setReports(baseReports);

        // Resolve report context after the list is available. This keeps the report
        // document itself small while still giving staff useful review information.
        await Promise.all(
          baseReports.map(async (report) => {
            try {
              const [reporter, target] = await Promise.all([
                report.reportedBy ? getUserData(report.reportedBy) : null,
                COLLECTION_BY_TYPE[report.contentType] && report.contentId
                  ? getDoc(doc(db, COLLECTION_BY_TYPE[report.contentType], report.contentId))
                  : null,
              ]);

              const targetData = target?.exists() ? target.data() : null;
              const authorId = targetData?.realUserId || targetData?.userId || targetData?.createdBy || targetData?.ownerId;
              let authorData: any = null;
              if (authorId) {
                try {
                  authorData = await getUserData(authorId);
                } catch {}
              }

              const reporterName = reporter
                ? `${reporter.firstname || ""} ${reporter.lastname || ""}`.trim() || report.reportedBy
                : report.reportedBy;
              const contentAuthor = authorData
                ? `${authorData.firstname || ""} ${authorData.lastname || ""}`.trim() || authorId
                : targetData?.username || targetData?.authorName || authorId || "Unknown user";

              const contentText =
                targetData?.text ||
                targetData?.content ||
                targetData?.question ||
                targetData?.message ||
                targetData?.title ||
                "No text preview available.";

              const originalModerationStatus =
                targetData?.moderationStatus || targetData?.moderationDecision?.status || null;
              const originalModerationReasons =
                Array.isArray(targetData?.moderationReasons)
                  ? targetData.moderationReasons.map(String)
                  : Array.isArray(targetData?.moderationDecision?.reasons)
                    ? targetData.moderationDecision.reasons.map(String)
                    : [];
              const originalModerationModel =
                targetData?.moderationModel || targetData?.moderationDecision?.model || null;

              setReports((current) =>
                current.map((item) =>
                  item.id === report.id
                    ? {
                        ...item,
                        reporterName,
                        contentText: String(contentText),
                        contentAuthor,
                        contentAuthorId: authorId,
                        contentExists: !!targetData,
                        originalModerationStatus: originalModerationStatus || undefined,
                        originalModerationReasons,
                        originalModerationModel,
                      }
                    : item,
                ),
              );
            } catch {}
          }),
        );
      },
      () => {
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [authLoading, router, userRole]);

  const filteredReports = useMemo(() => {
    const searchValue = search.trim().toLowerCase();
    return reports.filter((report) => {
      if (filter !== "all" && report.status !== filter) return false;
      if (!searchValue) return true;
      const haystack = [
        report.contentType,
        report.reason,
        report.status,
        report.reporterName,
        report.reportedBy,
        report.contentAuthor,
        report.contentText,
        report.contentId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(searchValue);
    });
  }, [filter, reports, search]);

  // Reports are grouped by the content they target. A report with no
  // resolvable contentId cannot be matched to anything, so it stays its own
  // row rather than being lumped into a meaningless bucket.
  const reportGroups = useMemo<ReportGroup[]>(() => {
    const groups = new Map<string, ReportRecord[]>();

    filteredReports.forEach((report) => {
      const key =
        report.contentId && report.contentType
          ? `${report.contentType}:${report.contentId}`
          : `report:${report.id}`;
      const existing = groups.get(key);
      if (existing) existing.push(report);
      else groups.set(key, [report]);
    });

    const built = Array.from(groups.entries()).map(([key, items]) => {
      // Newest first inside a group, so the primary report carries the most
      // recent context and the preview is the freshest snapshot.
      const ordered = [...items].sort(
        (a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt),
      );

      const reasonCounts = new Map<string, number>();
      ordered.forEach((item) => {
        const label = normalizeReason(item.reason);
        reasonCounts.set(label, (reasonCounts.get(label) || 0) + 1);
      });

      const reporterNames = Array.from(
        new Set(
          ordered
            .map((item) => item.reporterName || item.reportedBy)
            .filter((name): name is string => !!name),
        ),
      );

      return {
        key,
        primary: ordered[0],
        reports: ordered,
        reasons: Array.from(reasonCounts.entries())
          .map(([label, count]) => ({ label, count }))
          .sort((a, b) => b.count - a.count),
        reporterNames,
        pendingCount: ordered.filter((item) => item.status === "pending").length,
      };
    });

    // Most-reported first: the post twelve people flagged is the one that
    // should not be sitting three screens down a chronological list.
    return built.sort((a, b) => {
      if (b.reports.length !== a.reports.length) {
        return b.reports.length - a.reports.length;
      }
      return timestampMs(b.primary.createdAt) - timestampMs(a.primary.createdAt);
    });
  }, [filteredReports]);

  const counts = useMemo(
    () => ({
      all: reports.length,
      pending: reports.filter((item) => item.status === "pending").length,
      resolved: reports.filter((item) => item.status === "resolved").length,
      dismissed: reports.filter((item) => item.status === "dismissed").length,
    }),
    [reports],
  );

  const updateReportStatus = async (report: ReportRecord, nextStatus: "resolved" | "dismissed" | "pending") => {
    const currentUser = auth.currentUser;
    if (!currentUser) return;
    setBusyReportId(report.id);
    try {
      const targetCollection = COLLECTION_BY_TYPE[report.contentType];
      const targetRef = targetCollection && report.contentId
        ? doc(db, targetCollection, report.contentId)
        : null;

      // A resolved report is a confirmed violation. Save the moderator's
      // decision before removing the reported content so the moderation
      // history survives deletion. The text snapshot is intentionally
      // retained only as a staff-controlled feedback record for future
      // moderation evaluation.
      if (nextStatus === "resolved") {
        let targetData: any = null;
        if (targetRef) {
          const targetSnap = await getDoc(targetRef);
          targetData = targetSnap.exists() ? targetSnap.data() : null;
        }

        const contentText = String(
          targetData?.text ||
          targetData?.content ||
          targetData?.question ||
          targetData?.message ||
          targetData?.title ||
          "",
        ).trim();

        await addDoc(collection(db, "moderationFeedback"), {
          reportId: report.id,
          contentType: report.contentType,
          contentId: report.contentId,
          source: "user_report",
          originalModerationStatus: targetData?.moderationStatus || null,
          originalModerationReasons: Array.isArray(targetData?.moderationReasons)
            ? targetData.moderationReasons
            : [],
          originalModerationModel: targetData?.moderationModel || targetData?.moderationDecision?.model || null,
          moderatorDecision: "inappropriate",
          reason: report.reason,
          contentText: contentText || null,
          reviewedBy: currentUser.uid,
          reviewedAt: serverTimestamp(),
          trainingEligible: false,
          status: "verified",
        });

        if (targetRef) {
          const targetSnap = await getDoc(targetRef);
          if (targetSnap.exists()) {
            await deleteDoc(targetRef);

            // Keep the parent comment's reply count in sync when a reply
            // is removed through moderation.
            if (report.contentType === "reply" && targetData?.commentId) {
              const commentRef = doc(db, "comments", String(targetData.commentId));
              const commentSnap = await getDoc(commentRef);
              if (commentSnap.exists()) {
                const currentCount = Number(commentSnap.data()?.replyCount || 0);
                await updateDoc(commentRef, {
                  replyCount: Math.max(0, currentCount - 1),
                });
              }
            }
          }
        }
      } else if (nextStatus === "dismissed") {
        await addDoc(collection(db, "moderationFeedback"), {
          reportId: report.id,
          contentType: report.contentType,
          contentId: report.contentId,
          source: "user_report",
          originalModerationStatus: report.originalModerationStatus || null,
          originalModerationReasons: report.originalModerationReasons || [],
          originalModerationModel: report.originalModerationModel || null,
          moderatorDecision: "appropriate",
          reason: report.reason,
          reviewedBy: currentUser.uid,
          reviewedAt: serverTimestamp(),
          trainingEligible: false,
          status: "verified",
        });
      }

      await updateDoc(doc(db, "reports", report.id), {
        status: nextStatus,
        reviewedBy: currentUser.uid,
        reviewedAt: serverTimestamp(),
      });

      // One decision closes every report filed against the same content.
      // Only the report above records moderationFeedback and deletes the
      // content; the rest are marked reviewed so they stop reappearing as
      // separate work. Doing it the other way would file one training record
      // per reporter and attempt the same delete a dozen times.
      const siblings = reports.filter(
        (candidate) =>
          candidate.id !== report.id &&
          candidate.status === "pending" &&
          candidate.contentId &&
          candidate.contentId === report.contentId &&
          candidate.contentType === report.contentType,
      );

      if (siblings.length) {
        const batch = writeBatch(db);
        siblings.forEach((sibling) => {
          batch.update(doc(db, "reports", sibling.id), {
            status: nextStatus,
            reviewedBy: currentUser.uid,
            reviewedAt: serverTimestamp(),
            resolvedWithReportId: report.id,
          });
        });
        await batch.commit();
      }

      setSelectedReport(null);
      setConfirm(null);
    } catch (error) {
      console.error("Failed to update report:", error);
    } finally {
      setBusyReportId(null);
    }
  };

  const openStatusConfirm = useCallback((report: ReportRecord, nextStatus: "resolved" | "dismissed" | "pending") => {
    if (nextStatus === "resolved") {
      setConfirm({
        reportId: report.id,
        title: "Resolve Report?",
        description: "Confirm the violation. The reported content will be removed and a verified moderation feedback record will be saved.",
        confirmText: "Resolve",
        destructive: false,
        nextStatus,
      });
      return;
    }

    if (nextStatus === "dismissed") {
      setConfirm({
        reportId: report.id,
        title: "Dismiss Report?",
        description: "Mark this report as dismissed because no moderation action is required.",
        confirmText: "Dismiss",
        destructive: false,
        nextStatus,
      });
      return;
    }

    setConfirm({
      reportId: report.id,
      title: "Reopen Report?",
      description: "Move this report back to Pending so staff can review it again.",
      confirmText: "Reopen",
      destructive: false,
      nextStatus,
    });
  }, []);

  const renderReport = useCallback(
    ({ item }: { item: ReportGroup }) => (
      <ReportCard
        report={item.primary}
        isBusy={busyReportId === item.primary.id}
        duplicateCount={item.reports.length}
        reasons={item.reasons}
        reporterNames={item.reporterNames}
        onOpen={setSelectedReport}
        onChangeStatus={openStatusConfirm}
      />
    ),
    [busyReportId, openStatusConfirm],
  );

  const refresh = async () => {
    setRefreshing(true);
    // onSnapshot is already live; this short delay gives the refresh control
    // predictable feedback without creating a second listener.
    await new Promise((resolve) => setTimeout(resolve, 350));
    setRefreshing(false);
  };

  if (authLoading || loading) {
    // Drawn as the screen will be — its bar, its opening card, then cards in
    // the real card style — so nothing moves when the data arrives.
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => router.back()} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={24} color={theme.onPrimary} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.headerTitle}>Reports Management</Text>
            <Text style={styles.headerSubtitle}>
              Review and handle reports submitted by the community
            </Text>
          </View>
        </View>
        <CardListSkeleton
          count={4}
          style={[styles.content, styles.contentContainer]}
          header={
            <SkeletonCard
              style={styles.summaryCard}
              avatar={{ size: 48, radius: 16 }}
              lines={[
                { width: "55%", height: 15 },
                { width: "80%", height: 11, gap: 8 },
              ]}
            />
          }
          cardStyle={styles.reportCard}
          lines={[
            { width: 110, height: 22 },
            { width: "90%", height: 12, gap: 12 },
            { width: "70%", height: 12, gap: 8 },
          ]}
          chips={[82, 64, 96]}
          chipHeight={24}
        />
      </View>
    );
  }

  if (!isStaff(userRole)) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()} activeOpacity={0.8}>
          <Ionicons name="arrow-back" size={22} color={theme.onPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle}>Reports Management</Text>
          <Text style={styles.headerSubtitle}>
            Review and handle reports submitted by the community
          </Text>
        </View>
      </View>

      {/* Only the reports near the screen are drawn, so a long report history
          doesn't slow this screen down. */}
      <FlatList
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        data={reportGroups}
        keyExtractor={(group) => group.key}
        renderItem={renderReport}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={7}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.accent} />}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            <View style={styles.summaryCard}>
              <View style={styles.summaryIcon}>
                <Ionicons name="flag" size={24} color={theme.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.summaryTitle}>Moderation Queue</Text>
                <Text style={styles.summaryText}>
                  {counts.pending} pending report{counts.pending === 1 ? "" : "s"} require staff review.
                </Text>
              </View>
            </View>

            <View style={styles.filterRow}>
              {FILTERS.map((item) => {
                const active = filter === item.value;
                return (
                  <TouchableOpacity
                    key={item.value}
                    style={[styles.filterChip, active && styles.filterChipActive]}
                    onPress={() => setFilter(item.value)}
                    activeOpacity={0.8}
                  >
                    <Ionicons name={item.icon} size={16} color={active ? theme.onPrimary : theme.textMuted} />
                    <Text style={[styles.filterText, active && styles.filterTextActive]}>
                      {item.label} {counts[item.value]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.searchBox}>
              <Ionicons name="search-outline" size={20} color={theme.textSecondary} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search reports, users, reasons..."
                placeholderTextColor={theme.textMuted}
                style={styles.searchInput}
              />
              {!!search && (
                <TouchableOpacity onPress={() => setSearch("")}>
                  <Ionicons name="close-circle" size={19} color={theme.textSecondary} />
                </TouchableOpacity>
              )}
            </View>
          </>
        }
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <Ionicons name="checkmark-done-outline" size={34} color={theme.accent} />
            </View>
            <Text style={styles.emptyTitle}>No reports found</Text>
            <Text style={styles.emptyText}>
              {filter === "pending" ? "There are no pending reports right now." : "Try another filter or search term."}
            </Text>
          </View>
        }
      />

      <Modal
        visible={!!selectedReport}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedReport(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setSelectedReport(null)}>
          <Pressable style={styles.detailCard} onPress={(event) => event.stopPropagation()}>
            {selectedReport && (() => {
              const status = getStatusMeta(selectedReport.status, theme);
              return (
                <>
                  <View style={styles.detailHeader}>
                    <View style={styles.detailIcon}>
                      <Ionicons name="flag" size={24} color={theme.accent} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.detailTitle}>Report Details</Text>
                      <Text style={styles.detailSubtitle}>{getContentTypeLabel(selectedReport.contentType)}</Text>
                    </View>
                    <TouchableOpacity onPress={() => setSelectedReport(null)}>
                      <Ionicons name="close" size={24} color={theme.textSecondary} />
                    </TouchableOpacity>
                  </View>

                  <ScrollView
                    style={styles.detailScroll}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.detailScrollContent}
                  >
                    <View style={[styles.statusLarge, { backgroundColor: status.bg }]}>
                      <Ionicons name={status.icon} size={17} color={status.color} />
                      <Text style={[styles.statusLargeText, { color: status.color }]}>{status.label}</Text>
                    </View>

                    <Text style={styles.detailLabel}>Reason</Text>
                    <Text style={styles.detailValue}>{normalizeReason(selectedReport.reason)}</Text>

                    <Text style={styles.detailLabel}>Reported Content</Text>
                    <View style={styles.contentPreviewCard}>
                      <Text style={styles.contentAuthor}>{selectedReport.contentAuthor || "Unknown author"}</Text>
                      <Text style={styles.contentPreviewText}>{selectedReport.contentText || "No content preview available."}</Text>
                      {!selectedReport.contentExists && (
                        <Text style={styles.deletedHint}>The reported content is no longer available.</Text>
                      )}
                    </View>

                    <Text style={styles.detailLabel}>Original AI Moderation</Text>
                    <Text style={styles.detailValue}>
                      {selectedReport.originalModerationStatus
                        ? `${selectedReport.originalModerationStatus}${selectedReport.originalModerationModel ? ` • ${selectedReport.originalModerationModel}` : ""}`
                        : "No moderation result recorded"}
                    </Text>

                    <Text style={styles.detailLabel}>Reported By</Text>
                    <Text style={styles.detailValue}>{selectedReport.reporterName || selectedReport.reportedBy}</Text>

                    <Text style={styles.detailLabel}>Submitted</Text>
                    <Text style={styles.detailValue}>{formatDate(selectedReport.createdAt)}</Text>
                  </ScrollView>

                  {selectedReport.status === "pending" ? (
                    <View style={styles.detailActions}>
                      <TouchableOpacity
                        style={styles.detailDismissButton}
                        onPress={() => openStatusConfirm(selectedReport, "dismissed")}
                        disabled={!!busyReportId}
                      >
                        <Ionicons name="close-circle-outline" size={19} color={theme.textSecondary} />
                        <Text style={styles.detailDismissText}>Dismiss</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.detailResolveButton}
                        onPress={() => openStatusConfirm(selectedReport, "resolved")}
                        disabled={!!busyReportId}
                      >
                        <Ionicons name="checkmark-circle-outline" size={19} color={theme.onPrimary} />
                        <Text style={styles.detailResolveText}>Resolve</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={styles.reopenButton}
                      onPress={() => openStatusConfirm(selectedReport, "pending")}
                      disabled={!!busyReportId}
                    >
                      <Ionicons name="refresh-outline" size={19} color={theme.primary} />
                      <Text style={styles.reopenText}>Reopen Report</Text>
                    </TouchableOpacity>
                  )}
                </>
              );
            })()}
          </Pressable>
        </Pressable>
      </Modal>

      <ConfirmDialog
        visible={!!confirm}
        title={confirm?.title || "Confirm"}
        description={confirm?.description}
        confirmText={confirm?.confirmText}
        cancelText="Cancel"
        destructive={confirm?.destructive ?? false}
        loading={!!busyReportId}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          const report = reports.find((item) => item.id === confirm.reportId);
          if (report) {
            updateReportStatus(report, confirm.nextStatus);
          }
        }}
      />
    </View>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceSunken },
  centered: { flex: 1, backgroundColor: c.primary, justifyContent: "center", alignItems: "center" },
  loadingText: { color: c.onPrimary, marginTop: 10, fontSize: 14 },
  header: {
    backgroundColor: c.primary,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: "rgba(255,250,247,0.12)",
    justifyContent: "center",
    alignItems: "center",
  },
  headerTextWrap: { flex: 1 },
  headerTitle: { color: c.surface, fontSize: 22, fontWeight: "800" },
  headerSubtitle: { color: c.onPrimary, fontSize: 12.5, marginTop: 3 },
  content: { flex: 1 },
  contentContainer: { padding: 16, paddingBottom: 100 },
  summaryCard: {
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  summaryIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: "rgba(224,165,61,0.14)",
    justifyContent: "center",
    alignItems: "center",
  },
  summaryTitle: { color: c.textPrimary, fontSize: 16, fontWeight: "800" },
  summaryText: { color: c.textMuted, fontSize: 13, marginTop: 3, lineHeight: 18 },
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    height: 38,
    borderRadius: 12,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  filterChipActive: { backgroundColor: c.primary, borderColor: c.primary },
  filterText: { color: c.textMuted, fontSize: 12.5, fontWeight: "700" },
  filterTextActive: { color: c.surface },
  searchBox: {
    minHeight: 48,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 14,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  searchInput: { flex: 1, color: c.textPrimary, fontSize: 14, paddingVertical: 8 },
  reportCard: {
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 16,
    marginBottom: 12,
  },
  skeletonContent: { padding: 16 },
  skeletonCard: {
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 16,
    marginBottom: 12,
  },
  reportTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  typeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: c.surface,
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  typeBadgeText: { color: c.danger, fontSize: 11.5, fontWeight: "800" },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 6 },
  statusText: { fontSize: 11.5, fontWeight: "800" },
  reportReason: { color: c.textPrimary, fontSize: 16, fontWeight: "800", marginTop: 12 },
  duplicateBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: c.accentSoft,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  duplicateBadgeText: { color: c.primary, fontSize: 11.5, fontWeight: "900" },
  reasonList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 6,
  },
  reasonChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: c.surface,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  reasonChipText: { color: c.danger, fontSize: 12, fontWeight: "800" },
  reasonChipCount: { color: c.textMuted, fontSize: 11.5, fontWeight: "900" },
  reportPreview: { color: c.textSecondary, fontSize: 13.5, lineHeight: 19, marginTop: 6 },
  metaRow: { marginTop: 12, flexDirection: "row", justifyContent: "space-between", gap: 8 },
  metaText: { flex: 1, color: c.textMuted, fontSize: 10.5 },
  quickActions: { flexDirection: "row", gap: 8, marginTop: 13 },
  dismissButton: { flex: 1, height: 40, borderRadius: 11, backgroundColor: c.surfaceSunken, borderWidth: 1, borderColor: c.borderStrong, justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 6 },
  dismissButtonText: { color: c.textMuted, fontSize: 13, fontWeight: "700" },
  resolveButton: { flex: 1, height: 40, borderRadius: 11, backgroundColor: c.primary, justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 6 },
  resolveButtonText: { color: c.surface, fontSize: 13, fontWeight: "700" },
  emptyCard: { backgroundColor: c.surface, borderRadius: 18, borderWidth: 1, borderColor: c.borderStrong, padding: 30, alignItems: "center", marginTop: 8 },
  emptyIcon: { width: 64, height: 64, borderRadius: 22, backgroundColor: "rgba(224,165,61,0.12)", justifyContent: "center", alignItems: "center" },
  emptyTitle: { color: c.textPrimary, fontSize: 18, fontWeight: "800", marginTop: 13 },
  emptyText: { color: c.textMuted, fontSize: 13, textAlign: "center", marginTop: 5, lineHeight: 19 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", paddingHorizontal: 18 },
  detailCard: { maxHeight: "88%", backgroundColor: c.surface, borderRadius: 22, borderWidth: 1, borderColor: c.borderStrong, padding: 18 },
  detailHeader: { flexDirection: "row", alignItems: "center", gap: 11 },
  detailScroll: { flexShrink: 1 },
  detailScrollContent: { paddingBottom: 4 },
  detailIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: "rgba(224,165,61,0.14)", justifyContent: "center", alignItems: "center" },
  detailTitle: { color: c.textPrimary, fontSize: 18, fontWeight: "800" },
  detailSubtitle: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  statusLarge: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, marginTop: 15 },
  statusLargeText: { fontSize: 12, fontWeight: "800" },
  detailLabel: { color: c.textMuted, fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 15, marginBottom: 4 },
  detailValue: { color: c.textPrimary, fontSize: 14, lineHeight: 19 },
  contentPreviewCard: { backgroundColor: c.surfaceSunken, borderRadius: 14, borderWidth: 1, borderColor: c.borderStrong, padding: 12 },
  contentAuthor: { color: c.primary, fontSize: 13, fontWeight: "800", marginBottom: 5 },
  contentPreviewText: { color: c.textSecondary, fontSize: 13.5, lineHeight: 19 },
  deletedHint: { color: c.textMuted, fontSize: 11.5, marginTop: 8, fontStyle: "italic" },
  detailActions: { flexDirection: "row", gap: 9, marginTop: 20 },
  detailDismissButton: { flex: 1, height: 45, borderRadius: 12, backgroundColor: c.surfaceSunken, borderWidth: 1, borderColor: c.borderStrong, justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 6 },
  detailDismissText: { color: c.textMuted, fontSize: 14, fontWeight: "700" },
  detailResolveButton: { flex: 1, height: 45, borderRadius: 12, backgroundColor: c.primary, justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 6 },
  detailResolveText: { color: c.surface, fontSize: 14, fontWeight: "700" },
  reopenButton: { height: 45, borderRadius: 12, backgroundColor: c.accentSoft, justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 7, marginTop: 20 },
  reopenText: { color: c.primary, fontSize: 14, fontWeight: "800" },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

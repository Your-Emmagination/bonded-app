import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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
} from "firebase/firestore";
import { auth, db } from "../../Firebase_configure";
import ConfirmDialog from "./components/ConfirmDialog";
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

function getStatusMeta(status: ReportStatus) {
  if (status === "resolved") {
    return { label: "Resolved", icon: "checkmark-circle" as const, color: "#2e8b57", bg: "#e9f6ee" };
  }
  if (status === "dismissed") {
    return { label: "Dismissed", icon: "close-circle" as const, color: "#8f6a60", bg: "#f4eeea" };
  }
  return { label: "Pending", icon: "time" as const, color: "#c27b16", bg: "#fff4dc" };
}

export default function ReportManagementScreen() {
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
      setSelectedReport(null);
      setConfirm(null);
    } catch (error) {
      console.error("Failed to update report:", error);
    } finally {
      setBusyReportId(null);
    }
  };

  const openStatusConfirm = (report: ReportRecord, nextStatus: "resolved" | "dismissed" | "pending") => {
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
  };

  const refresh = async () => {
    setRefreshing(true);
    // onSnapshot is already live; this short delay gives the refresh control
    // predictable feedback without creating a second listener.
    await new Promise((resolve) => setTimeout(resolve, 350));
    setRefreshing(false);
  };

  if (authLoading || loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#e0a53d" />
        <Text style={styles.loadingText}>Loading reports...</Text>
      </View>
    );
  }

  if (!isStaff(userRole)) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()} activeOpacity={0.8}>
          <Ionicons name="arrow-back" size={22} color="#fffaf7" />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle}>Reports Management</Text>
          <Text style={styles.headerSubtitle}>
            Review and handle reports submitted by the community
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#e0a53d" />}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.summaryCard}>
          <View style={styles.summaryIcon}>
            <Ionicons name="flag" size={24} color="#e0a53d" />
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
                <Ionicons name={item.icon} size={16} color={active ? "#fffaf7" : "#7d5c53"} />
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {item.label} {counts[item.value]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={20} color="#9b766c" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search reports, users, reasons..."
            placeholderTextColor="#b99c93"
            style={styles.searchInput}
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch("")}> 
              <Ionicons name="close-circle" size={19} color="#9b766c" />
            </TouchableOpacity>
          )}
        </View>

        {filteredReports.length === 0 ? (
          <View style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <Ionicons name="checkmark-done-outline" size={34} color="#e0a53d" />
            </View>
            <Text style={styles.emptyTitle}>No reports found</Text>
            <Text style={styles.emptyText}>
              {filter === "pending" ? "There are no pending reports right now." : "Try another filter or search term."}
            </Text>
          </View>
        ) : (
          filteredReports.map((report) => {
            const status = getStatusMeta(report.status);
            const isBusy = busyReportId === report.id;
            return (
              <TouchableOpacity
                key={report.id}
                style={styles.reportCard}
                activeOpacity={0.88}
                onPress={() => setSelectedReport(report)}
              >
                <View style={styles.reportTopRow}>
                  <View style={styles.typeBadge}>
                    <Ionicons name="flag-outline" size={14} color="#7b2a21" />
                    <Text style={styles.typeBadgeText}>{getContentTypeLabel(report.contentType)}</Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: status.bg }]}>
                    <Ionicons name={status.icon} size={14} color={status.color} />
                    <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
                  </View>
                </View>

                <Text style={styles.reportReason}>{normalizeReason(report.reason)}</Text>
                <Text style={styles.reportPreview} numberOfLines={3}>
                  {report.contentText || "Loading content preview..."}
                </Text>

                <View style={styles.metaRow}>
                  <Text style={styles.metaText}>
                    Reported by {report.reporterName || report.reportedBy || "Unknown user"}
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
                        openStatusConfirm(report, "dismissed");
                      }}
                    >
                      <Ionicons name="close-circle-outline" size={17} color="#7d5c53" />
                      <Text style={styles.dismissButtonText}>Dismiss</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.resolveButton}
                      disabled={isBusy}
                      onPress={(event) => {
                        event.stopPropagation();
                        openStatusConfirm(report, "resolved");
                      }}
                    >
                      <Ionicons name="checkmark-circle-outline" size={17} color="#fffaf7" />
                      <Text style={styles.resolveButtonText}>Resolve</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      <Modal
        visible={!!selectedReport}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedReport(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setSelectedReport(null)}>
          <Pressable style={styles.detailCard} onPress={(event) => event.stopPropagation()}>
            {selectedReport && (() => {
              const status = getStatusMeta(selectedReport.status);
              return (
                <>
                  <View style={styles.detailHeader}>
                    <View style={styles.detailIcon}>
                      <Ionicons name="flag" size={24} color="#e0a53d" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.detailTitle}>Report Details</Text>
                      <Text style={styles.detailSubtitle}>{getContentTypeLabel(selectedReport.contentType)}</Text>
                    </View>
                    <TouchableOpacity onPress={() => setSelectedReport(null)}>
                      <Ionicons name="close" size={24} color="#7d5c53" />
                    </TouchableOpacity>
                  </View>

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

                  {selectedReport.status === "pending" ? (
                    <View style={styles.detailActions}>
                      <TouchableOpacity
                        style={styles.detailDismissButton}
                        onPress={() => openStatusConfirm(selectedReport, "dismissed")}
                        disabled={!!busyReportId}
                      >
                        <Ionicons name="close-circle-outline" size={19} color="#7d5c53" />
                        <Text style={styles.detailDismissText}>Dismiss</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.detailResolveButton}
                        onPress={() => openStatusConfirm(selectedReport, "resolved")}
                        disabled={!!busyReportId}
                      >
                        <Ionicons name="checkmark-circle-outline" size={19} color="#fffaf7" />
                        <Text style={styles.detailResolveText}>Resolve</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={styles.reopenButton}
                      onPress={() => openStatusConfirm(selectedReport, "pending")}
                      disabled={!!busyReportId}
                    >
                      <Ionicons name="refresh-outline" size={19} color="#5f0909" />
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f6f1ed" },
  centered: { flex: 1, backgroundColor: "#5f0909", justifyContent: "center", alignItems: "center" },
  loadingText: { color: "#f5e8df", marginTop: 10, fontSize: 14 },
  header: {
    backgroundColor: "#5f0909",
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
  headerTitle: { color: "#fffaf7", fontSize: 22, fontWeight: "800" },
  headerSubtitle: { color: "#e7cdbf", fontSize: 12.5, marginTop: 3 },
  content: { flex: 1 },
  contentContainer: { padding: 16, paddingBottom: 100 },
  summaryCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#eadbd3",
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  summaryIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: "rgba(224,165,61,0.14)",
    justifyContent: "center",
    alignItems: "center",
  },
  summaryTitle: { color: "#4d1b17", fontSize: 16, fontWeight: "800" },
  summaryText: { color: "#9b766c", fontSize: 13, marginTop: 3, lineHeight: 18 },
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    height: 38,
    borderRadius: 12,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#eadbd3",
  },
  filterChipActive: { backgroundColor: "#5f0909", borderColor: "#5f0909" },
  filterText: { color: "#7d5c53", fontSize: 12.5, fontWeight: "700" },
  filterTextActive: { color: "#fffaf7" },
  searchBox: {
    minHeight: 48,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#eadbd3",
    borderRadius: 14,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 14,
  },
  searchInput: { flex: 1, color: "#4d1b17", fontSize: 14, paddingVertical: 8 },
  reportCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#eadbd3",
    padding: 15,
    marginBottom: 12,
  },
  reportTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  typeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#f8e9e3",
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  typeBadgeText: { color: "#7b2a21", fontSize: 11.5, fontWeight: "800" },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 6 },
  statusText: { fontSize: 11.5, fontWeight: "800" },
  reportReason: { color: "#4d1b17", fontSize: 16, fontWeight: "800", marginTop: 12 },
  reportPreview: { color: "#745b53", fontSize: 13.5, lineHeight: 19, marginTop: 6 },
  metaRow: { marginTop: 12, flexDirection: "row", justifyContent: "space-between", gap: 8 },
  metaText: { flex: 1, color: "#a0847a", fontSize: 10.5 },
  quickActions: { flexDirection: "row", gap: 8, marginTop: 13 },
  dismissButton: { flex: 1, height: 40, borderRadius: 11, backgroundColor: "#f5efeb", borderWidth: 1, borderColor: "#eadbd3", justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 6 },
  dismissButtonText: { color: "#7d5c53", fontSize: 13, fontWeight: "700" },
  resolveButton: { flex: 1, height: 40, borderRadius: 11, backgroundColor: "#5f0909", justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 6 },
  resolveButtonText: { color: "#fffaf7", fontSize: 13, fontWeight: "700" },
  emptyCard: { backgroundColor: "#fffaf7", borderRadius: 18, borderWidth: 1, borderColor: "#eadbd3", padding: 30, alignItems: "center", marginTop: 8 },
  emptyIcon: { width: 64, height: 64, borderRadius: 22, backgroundColor: "rgba(224,165,61,0.12)", justifyContent: "center", alignItems: "center" },
  emptyTitle: { color: "#4d1b17", fontSize: 18, fontWeight: "800", marginTop: 13 },
  emptyText: { color: "#9b766c", fontSize: 13, textAlign: "center", marginTop: 5, lineHeight: 19 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", paddingHorizontal: 18 },
  detailCard: { maxHeight: "88%", backgroundColor: "#fffaf7", borderRadius: 22, borderWidth: 1, borderColor: "#eadbd3", padding: 18 },
  detailHeader: { flexDirection: "row", alignItems: "center", gap: 11 },
  detailIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: "rgba(224,165,61,0.14)", justifyContent: "center", alignItems: "center" },
  detailTitle: { color: "#4d1b17", fontSize: 18, fontWeight: "800" },
  detailSubtitle: { color: "#9b766c", fontSize: 12, marginTop: 2 },
  statusLarge: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, marginTop: 15 },
  statusLargeText: { fontSize: 12, fontWeight: "800" },
  detailLabel: { color: "#9b766c", fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 15, marginBottom: 4 },
  detailValue: { color: "#4d1b17", fontSize: 14, lineHeight: 19 },
  contentPreviewCard: { backgroundColor: "#f8eee8", borderRadius: 14, borderWidth: 1, borderColor: "#ecd9ce", padding: 12 },
  contentAuthor: { color: "#5f0909", fontSize: 13, fontWeight: "800", marginBottom: 5 },
  contentPreviewText: { color: "#5f514c", fontSize: 13.5, lineHeight: 19 },
  deletedHint: { color: "#a86f66", fontSize: 11.5, marginTop: 8, fontStyle: "italic" },
  detailActions: { flexDirection: "row", gap: 9, marginTop: 20 },
  detailDismissButton: { flex: 1, height: 45, borderRadius: 12, backgroundColor: "#f5efeb", borderWidth: 1, borderColor: "#eadbd3", justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 6 },
  detailDismissText: { color: "#7d5c53", fontSize: 14, fontWeight: "700" },
  detailResolveButton: { flex: 1, height: 45, borderRadius: 12, backgroundColor: "#5f0909", justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 6 },
  detailResolveText: { color: "#fffaf7", fontSize: 14, fontWeight: "700" },
  reopenButton: { height: 45, borderRadius: 12, backgroundColor: "#f4e5bf", justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 7, marginTop: 20 },
  reopenText: { color: "#5f0909", fontSize: 14, fontWeight: "800" },
});

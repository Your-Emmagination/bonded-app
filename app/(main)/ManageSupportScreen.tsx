// app/(main)/ManageSupportScreen.tsx
//
// The staff side of Help & Support: every ticket, filterable, newest activity
// first.
//
// Sits on the Dashboard beside ManageUsersScreen, ReportManagementScreen and
// ManageModerationScreen — it is the same kind of work. Distinct from reports,
// which are about *content* somebody objected to; these are about *problems*
// with the app or an account.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CardListSkeleton } from "./components/Skeleton";
import { SIGN_IN_TICKET_SOURCE } from "@/utils/signInHelp";
import { isAdmin as isAdminRole } from "@/utils/rbac";
import { getTimeAgo } from "@/utils/relativeTime";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import {
  getCategoryLabel,
  subscribeToAllTickets,
  TICKET_PRIORITY_META,
  TICKET_STATUS_META,
  type SupportTicket,
  type TicketStatus,
} from "@/utils/supportTickets";

type QueueFilter = "waiting" | TicketStatus | "all";

const FILTERS: { value: QueueFilter; label: string }[] = [
  // "Waiting" first on purpose: it is the only view that answers "what do I
  // have to do now", which is the question staff actually open this with.
  { value: "waiting", label: "Waiting on us" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export default function ManageSupportScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const role = useCurrentUserRole();
  // Administrators only. Moderators are students, so staff-wide access here
  // would put one student's account and records problems in front of another.
  const admin = isAdminRole(role);

  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<QueueFilter>("waiting");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!admin) return;
    return subscribeToAllTickets((rows) => {
      setTickets(rows);
      setLoading(false);
    });
  }, [admin]);

  const counts = useMemo(
    () => ({
      waiting: tickets.filter((ticket) => ticket.unreadForStaff).length,
      open: tickets.filter((ticket) => ticket.status === "open").length,
      in_progress: tickets.filter((ticket) => ticket.status === "in_progress").length,
      resolved: tickets.filter((ticket) => ticket.status === "resolved").length,
      closed: tickets.filter((ticket) => ticket.status === "closed").length,
      all: tickets.length,
    }),
    [tickets],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return tickets.filter((ticket) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "waiting" ? ticket.unreadForStaff : ticket.status === filter);
      if (!matchesFilter) return false;
      if (!term) return true;
      return [
        ticket.ticketNo,
        ticket.subject,
        ticket.description,
        ticket.userName,
        ticket.userStudentId,
        getCategoryLabel(ticket.category),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [filter, search, tickets]);

  // The same bar whether the queue has loaded or not, so it never jumps.
  const topBar = (
    <View style={styles.topBar}>
      <TouchableOpacity
        onPress={() => router.back()}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
      </TouchableOpacity>
      <Text style={styles.topBarTitle}>Support requests</Text>
      <View style={{ width: 24 }} />
    </View>
  );
  // Ticket cards drawn in the real card style, so they land where the
  // tickets will.
  const ticketSkeleton = (
    <CardListSkeleton
      count={5}
      style={styles.skeletonList}
      cardStyle={styles.card}
      lines={[
        { width: 84, height: 12 },
        { width: "70%", height: 15, gap: 10 },
        { width: "95%", height: 12, gap: 8 },
        { width: "58%", height: 12, gap: 6 },
        { width: "40%", height: 10, gap: 10 },
      ]}
    />
  );

  if (role === undefined) {
    return (
      <SafeAreaView style={styles.screen}>
        {topBar}
        <View style={styles.listContent}>{ticketSkeleton}</View>
      </SafeAreaView>
    );
  }

  if (!admin) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.denied}>
          <Ionicons name="lock-closed-outline" size={30} color={theme.textMuted} />
          <Text style={styles.deniedTitle}>Administrators only</Text>
          <Text style={styles.deniedText}>
            Support requests can contain account and records details, so only
            administrators can open this queue.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      {topBar}
      <FlatList
        data={visible}
        keyExtractor={(ticket) => ticket.id}
        contentContainerStyle={styles.listContent}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <View style={styles.searchShell}>
              <Ionicons name="search" size={18} color={theme.textMuted} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search ticket no, name, or subject"
                placeholderTextColor={theme.textMuted}
                style={styles.searchInput}
                autoCapitalize="none"
              />
              {!!search && (
                <TouchableOpacity onPress={() => setSearch("")}>
                  <Ionicons name="close-circle" size={18} color={theme.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterRow}
            >
              {FILTERS.map((item) => {
                const active = filter === item.value;
                const count = counts[item.value as keyof typeof counts] ?? 0;
                return (
                  <TouchableOpacity
                    key={item.value}
                    style={[styles.filterChip, active && styles.filterChipActive]}
                    onPress={() => setFilter(item.value)}
                    activeOpacity={0.84}
                  >
                    <Text
                      style={[styles.filterText, active && styles.filterTextActive]}
                    >
                      {item.label}
                    </Text>
                    <View
                      style={[styles.filterCount, active && styles.filterCountActive]}
                    >
                      <Text
                        style={[
                          styles.filterCountText,
                          active && styles.filterCountTextActive,
                        ]}
                      >
                        {count}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        }
        ListEmptyComponent={
          loading ? (
            ticketSkeleton
          ) : (
            <View style={styles.emptyCard}>
              <Ionicons name="checkmark-done-outline" size={28} color={theme.success} />
              <Text style={styles.emptyTitle}>
                {filter === "waiting" ? "Nothing waiting" : "No requests here"}
              </Text>
              <Text style={styles.emptyText}>
                {filter === "waiting"
                  ? "Every request has been answered."
                  : "Try a different filter."}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const status = TICKET_STATUS_META[item.status];
          const priority = TICKET_PRIORITY_META[item.priority];
          return (
            <TouchableOpacity
              style={[styles.card, item.unreadForStaff && styles.cardWaiting]}
              onPress={() =>
                router.push({
                  pathname: "/SupportTicketScreen",
                  params: { ticketId: item.id },
                })
              }
              activeOpacity={0.86}
            >
              <View style={styles.cardTop}>
                <Text style={styles.ticketNo}>{item.ticketNo}</Text>
                <View style={styles.cardTopRight}>
                  {item.source === SIGN_IN_TICKET_SOURCE && (
                    <View style={[styles.chip, { backgroundColor: theme.accentSoft }]}>
                      <Text style={[styles.chipText, { color: theme.accent }]}>Sign-in request</Text>
                    </View>
                  )}
                  {item.priority !== "normal" && (
                    <View style={[styles.chip, { backgroundColor: priority.bg }]}>
                      <Text style={[styles.chipText, { color: priority.color }]}>
                        {priority.label}
                      </Text>
                    </View>
                  )}
                  <View style={[styles.chip, { backgroundColor: status.bg }]}>
                    <Text style={[styles.chipText, { color: status.color }]}>
                      {status.label}
                    </Text>
                  </View>
                </View>
              </View>

              <Text style={styles.subject} numberOfLines={1}>
                {item.subject}
              </Text>
              <Text style={styles.preview} numberOfLines={2}>
                {item.lastMessagePreview || item.description}
              </Text>

              <View style={styles.metaRow}>
                <Text style={styles.metaText} numberOfLines={1}>
                  {item.userName} · {getCategoryLabel(item.category)}
                </Text>
                <Text style={styles.metaText}>{getTimeAgo(item.lastMessageAt)}</Text>
              </View>

              {item.unreadForStaff && (
                <View style={styles.waitingRow}>
                  <View style={styles.waitingDot} />
                  <Text style={styles.waitingText}>Waiting on us</Text>
                </View>
              )}
              {!!item.assignedToName && (
                <Text style={styles.assignedText}>
                  Handled by {item.assignedToName}
                </Text>
              )}
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
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

  denied: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 9 },
  deniedTitle: { color: c.textPrimary, fontSize: 16, fontWeight: "900" },
  deniedText: { color: c.textMuted, fontSize: 13, textAlign: "center", lineHeight: 19 },

  listContent: { padding: 16, gap: 10 },
  // Same spacing between cards as the real list.
  skeletonList: { gap: 10 },

  searchShell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  searchInput: { flex: 1, color: c.textPrimary, fontSize: 14 },

  filterRow: { gap: 8, paddingRight: 6 },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  filterChipActive: { backgroundColor: c.primary, borderColor: c.primary },
  filterText: { color: c.textMuted, fontSize: 12.5, fontWeight: "800" },
  filterTextActive: { color: c.background },
  filterCount: {
    minWidth: 20,
    alignItems: "center",
    backgroundColor: c.border,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  filterCountActive: { backgroundColor: "rgba(255,255,255,0.22)" },
  filterCountText: { color: "#6d4a41", fontSize: 11, fontWeight: "900" },
  filterCountTextActive: { color: c.background },

  card: {
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 16,
    padding: 14,
    gap: 5,
  },
  cardWaiting: { borderColor: "#e6b9b2", backgroundColor: c.surfaceRaised },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTopRight: { flexDirection: "row", gap: 6 },
  ticketNo: { color: c.textMuted, fontSize: 11.5, fontWeight: "900", letterSpacing: 0.4 },
  chip: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  chipText: { fontSize: 11, fontWeight: "900" },
  subject: { color: c.textPrimary, fontSize: 14.5, fontWeight: "800" },
  preview: { color: c.textMuted, fontSize: 12.5, lineHeight: 18 },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 4,
  },
  metaText: { color: c.textMuted, fontSize: 11.5, flexShrink: 1 },
  waitingRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  waitingDot: { width: 7, height: 7, borderRadius: 999, backgroundColor: "#a8201a" },
  waitingText: { color: c.danger, fontSize: 11.5, fontWeight: "900" },
  assignedText: { color: c.accent, fontSize: 11.5, fontWeight: "800", marginTop: 2 },

  emptyCard: {
    alignItems: "center",
    gap: 7,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 18,
    paddingVertical: 32,
    paddingHorizontal: 20,
  },
  emptyTitle: { color: c.textPrimary, fontSize: 14.5, fontWeight: "900" },
  emptyText: { color: c.textMuted, fontSize: 12.5, textAlign: "center" },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

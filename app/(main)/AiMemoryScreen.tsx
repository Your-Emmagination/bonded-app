import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import {
    type AiMemoryEntry,
    type AiMemoryScopeType,
    makeAiMemoryChannelScopeId,
} from "@/utils/aiMemory";
import { canManageAiMemory } from "@/utils/rbac";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    onSnapshot,
    serverTimestamp,
    setDoc,
} from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Modal,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import ConfirmDialog from "./components/ConfirmDialog";
import { ListSkeleton } from "./components/Skeleton";

type DraftState = {
  id?: string | null;
  title: string;
  content: string;
  scopeType: AiMemoryScopeType;
  scopeId: string;
  tags: string;
  priority: string;
  active: boolean;
};

const emptyDraft: DraftState = {
  id: null,
  title: "",
  content: "",
  scopeType: "global",
  scopeId: "",
  tags: "",
  priority: "0",
  active: true,
};

export default function AiMemoryScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  // Optional pre-fill coming from UnansweredQuestionsScreen's clustered
  // suggestions — title and tags only, never content. Staff always write
  // the actual answer themselves; this just saves them re-typing the
  // question pattern and starts the editor already open.
  const { prefillTitle, prefillTags } = useLocalSearchParams<{
    prefillTitle?: string;
    prefillTags?: string;
  }>();
  // Live, so losing AI-memory access closes this screen without a reopen.
  const role = useCurrentUserRole();
  const allowed = canManageAiMemory(role);
  // An unresolved role still counts as loading, so the "no access" state is
  // never shown before the answer is actually known.
  const loading = !!auth.currentUser && role === undefined;
  const [entries, setEntries] = useState<AiMemoryEntry[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    const unsubscribe = onSnapshot(collection(db, "communityServers"), (snapshot) => {
      const nextEntries = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }))
        .filter((item: any) => item.recordType === "aiMemory")
        .map(
          (item: any) =>
            ({
              id: item.id,
              title: String(item.title || ""),
              content: String(item.content || ""),
              scopeType: item.scopeType || "global",
              scopeId: item.scopeId ? String(item.scopeId) : null,
              tags: Array.isArray(item.tags) ? item.tags.map((tag: unknown) => String(tag)) : [],
              priority: Number(item.priority || 0),
              active: item.active !== false,
              createdAt: item.createdAt || null,
              updatedAt: item.updatedAt || null,
            }) as AiMemoryEntry,
        )
        .sort((first, second) => {
          if (second.priority !== first.priority) return second.priority - first.priority;
          const firstUpdated = first.updatedAt?.toMillis?.() || 0;
          const secondUpdated = second.updatedAt?.toMillis?.() || 0;
          return secondUpdated - firstUpdated;
        });
      setEntries(nextEntries);
    });

    return unsubscribe;
  }, [allowed]);

  const [scopeFilter, setScopeFilter] = useState<"all" | AiMemoryScopeType>("all");
  const [search, setSearch] = useState("");

  const groupedStats = useMemo(
    () => ({
      global: entries.filter((entry) => entry.scopeType === "global").length,
      server: entries.filter((entry) => entry.scopeType === "server").length,
      channel: entries.filter((entry) => entry.scopeType === "channel").length,
    }),
    [entries],
  );

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (scopeFilter !== "all" && entry.scopeType !== scopeFilter) return false;
      if (!query) return true;
      return (
        entry.title.toLowerCase().includes(query) ||
        entry.content.toLowerCase().includes(query) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });
  }, [entries, scopeFilter, search]);

  const openCreate = () => {
    setDraft(emptyDraft);
    setShowEditor(true);
  };

  useEffect(() => {
    if (!allowed) return;
    const title = Array.isArray(prefillTitle) ? prefillTitle[0] : prefillTitle;
    const tags = Array.isArray(prefillTags) ? prefillTags[0] : prefillTags;
    if (!title) return;
    setDraft({ ...emptyDraft, title, tags: tags || "" });
    setShowEditor(true);
    // Only meant to fire once when arriving from the suggestion flow, not
    // every time this screen re-renders — intentionally omitting
    // prefillTitle/prefillTags from deps would cause an eslint warning, so
    // this is scoped to only actually run when `allowed` first becomes true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);

  const openEdit = (entry: AiMemoryEntry) => {
    setDraft({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      scopeType: entry.scopeType,
      scopeId: entry.scopeId || "",
      tags: entry.tags.join(", "),
      priority: String(entry.priority || 0),
      active: entry.active,
    });
    setShowEditor(true);
  };

  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    singleAction?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const showInfo = (title: string, description: string) =>
    setDialog({
      title,
      description,
      confirmText: "OK",
      singleAction: true,
      onConfirm: () => setDialog(null),
    });

  const saveEntry = async () => {
    if (!draft.title.trim() || !draft.content.trim()) {
      showInfo("Missing Info", "Title and content are required.");
      return;
    }

    const trimmedScopeId = draft.scopeId.trim();
    if (draft.scopeType !== "global" && !trimmedScopeId) {
      showInfo(
        "Missing Scope ID",
        `Enter a ${draft.scopeType} scope ID, or switch scope back to Global.`,
      );
      return;
    }

    setSaving(true);
    try {
      const payload = {
        recordType: "aiMemory",
        title: draft.title.trim(),
        content: draft.content.trim(),
        // Previously this was hardcoded to "global" no matter what the admin
        // picked above, so every entry silently lost its Server/Channel
        // scope on save. Now it persists whatever was actually selected.
        scopeType: draft.scopeType,
        scopeId: draft.scopeType === "global" ? null : trimmedScopeId,
        tags: draft.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        priority: Number(draft.priority || 0),
        active: draft.active,
        createdBy: auth.currentUser?.uid || null,
        ownerId: auth.currentUser?.uid || null,
        updatedAt: serverTimestamp(),
      };

      if (draft.id) {
        await setDoc(
          doc(db, "communityServers", draft.id),
          payload,
          { merge: true },
        );
      } else {
        await addDoc(collection(db, "communityServers"), {
          ...payload,
          createdAt: serverTimestamp(),
        });
      }

      setShowEditor(false);
      setDraft(emptyDraft);
    } catch (error) {
      console.error("Error saving AI memory:", error);
      showInfo("Error", "Failed to save AI memory.");
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = (entryId: string) => {
    setDialog({
      title: "Delete Memory",
      description: "Remove this memory entry? This can't be undone.",
      confirmText: "Delete",
      cancelText: "Cancel",
      destructive: true,
      onConfirm: async () => {
        setDeletingId(entryId);
        try {
          await deleteDoc(doc(db, "communityServers", entryId));
          setDialog(null);
        } catch (error) {
          console.error("Error deleting AI memory:", error);
          showInfo("Error", "Failed to delete AI memory.");
        } finally {
          setDeletingId(null);
        }
      },
    });
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ListSkeleton showAvatar={false} count={6} />
      </SafeAreaView>
    );
  }

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerState}>
          <Ionicons name="lock-closed-outline" size={42} color={theme.accent} />
          <Text style={styles.emptyTitle}>Access Restricted</Text>
          <Text style={styles.emptyText}>
            Only admins, teachers, and moderators can manage B.E.A. memory.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconButton}>
          <Ionicons name="arrow-back" size={22} color={theme.onChrome} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>B.E.A. Memory</Text>
          <Text style={styles.headerSubtitle}>
            Global long-term knowledge for B.E.A.
          </Text>
        </View>
        <TouchableOpacity onPress={openCreate} style={styles.addButton}>
          <Ionicons name="add" size={22} color={theme.primary} />
        </TouchableOpacity>
      </View>

      <View style={styles.statsRow}>
        <TouchableOpacity
          style={[styles.statPill, scopeFilter === "all" && styles.statPillActive]}
          activeOpacity={0.8}
          onPress={() => setScopeFilter("all")}
        >
          <Text style={[styles.statValue, scopeFilter === "all" && styles.statValueActive]}>
            {entries.length}
          </Text>
          <Text style={[styles.statLabel, scopeFilter === "all" && styles.statLabelActive]}>
            Total
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.statPill, scopeFilter === "global" && styles.statPillActive]}
          activeOpacity={0.8}
          onPress={() => setScopeFilter("global")}
        >
          <Text style={[styles.statValue, scopeFilter === "global" && styles.statValueActive]}>
            {groupedStats.global}
          </Text>
          <Text style={[styles.statLabel, scopeFilter === "global" && styles.statLabelActive]}>
            Global
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.statPill, scopeFilter === "server" && styles.statPillActive]}
          activeOpacity={0.8}
          onPress={() => setScopeFilter("server")}
        >
          <Text style={[styles.statValue, scopeFilter === "server" && styles.statValueActive]}>
            {groupedStats.server}
          </Text>
          <Text style={[styles.statLabel, scopeFilter === "server" && styles.statLabelActive]}>
            Server
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.statPill, scopeFilter === "channel" && styles.statPillActive]}
          activeOpacity={0.8}
          onPress={() => setScopeFilter("channel")}
        >
          <Text style={[styles.statValue, scopeFilter === "channel" && styles.statValueActive]}>
            {groupedStats.channel}
          </Text>
          <Text style={[styles.statLabel, scopeFilter === "channel" && styles.statLabelActive]}>
            Channel
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchBox}>
        <Ionicons name="search-outline" size={18} color={theme.textMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search title, content, or tags..."
          placeholderTextColor={theme.textMuted}
          style={styles.searchInput}
        />
        {!!search && (
          <TouchableOpacity onPress={() => setSearch("")} hitSlop={8}>
            <Ionicons name="close-circle" size={17} color={theme.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.helperCard}>
          <Text style={styles.helperTitle}>Scope format</Text>
          <Text style={styles.helperText}>Server scope ID example: `bsis`</Text>
          <Text style={styles.helperText}>Channel scope ID example: `bsis:bsis_general`</Text>
          <Text style={styles.helperText}>
            B.E.A. currently searches every active memory entry regardless of
            scope, ranked by priority — scope here is for your own organization
            (filtering this list, and future per-server/channel targeting).
          </Text>
        </View>

        {entries.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="library-outline" size={42} color={theme.textMuted} />
            <Text style={styles.emptyTitle}>No memory yet</Text>
            <Text style={styles.emptyText}>
              Add facts like developers, project history, rules, FAQ answers, or server-specific knowledge.
            </Text>
          </View>
        ) : visibleEntries.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="search-outline" size={42} color={theme.textMuted} />
            <Text style={styles.emptyTitle}>No matches</Text>
            <Text style={styles.emptyText}>
              Nothing matches this filter or search. Try clearing the search or picking a different scope.
            </Text>
          </View>
        ) : (
          visibleEntries.map((entry) => (
            <View key={entry.id} style={styles.memoryCard}>
              <View style={styles.memoryHeader}>
                <View style={styles.scopeBadge}>
                  <Text style={styles.scopeBadgeText}>{entry.scopeType.toUpperCase()}</Text>
                </View>
                <Text style={styles.priorityText}>Priority {entry.priority}</Text>
              </View>
              <Text style={styles.memoryTitle}>{entry.title}</Text>
              {!!entry.scopeId && <Text style={styles.scopeIdText}>{entry.scopeId}</Text>}
              <Text style={styles.memoryBody} numberOfLines={5}>
                {entry.content}
              </Text>
              {!!entry.tags.length && (
                <Text style={styles.tagsText}>{entry.tags.join(" • ")}</Text>
              )}
              <View style={styles.cardActions}>
                <TouchableOpacity
                  style={styles.cardAction}
                  onPress={() => openEdit(entry)}
                  disabled={deletingId === entry.id}
                >
                  <Ionicons name="create-outline" size={16} color={theme.primary} />
                  <Text style={styles.cardActionText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.cardAction}
                  onPress={() => removeEntry(entry.id)}
                  disabled={deletingId === entry.id}
                >
                  {deletingId === entry.id ? (
                    <ActivityIndicator size="small" color={theme.danger} />
                  ) : (
                    <Ionicons name="trash-outline" size={16} color={theme.danger} />
                  )}
                  <Text style={[styles.cardActionText, { color: theme.danger }]}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </ScrollView>
      </View>

      <Modal visible={showEditor} animationType="slide" onRequestClose={() => setShowEditor(false)}>
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{draft.id ? "Edit Memory" : "New Memory"}</Text>
            <TouchableOpacity onPress={() => setShowEditor(false)}>
              <Ionicons name="close" size={24} color={theme.primary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalContent}>
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput
              value={draft.title}
              onChangeText={(value) => setDraft((current) => ({ ...current, title: value }))}
              style={styles.input}
              placeholder="Developers of this system"
              placeholderTextColor={theme.textMuted}
            />

            <Text style={styles.fieldLabel}>Content</Text>
            <TextInput
              value={draft.content}
              onChangeText={(value) => setDraft((current) => ({ ...current, content: value }))}
              style={[styles.input, styles.textArea]}
              multiline
              textAlignVertical="top"
              placeholder="Write the long-term fact or instruction here..."
              placeholderTextColor={theme.textMuted}
            />

            <Text style={styles.fieldLabel}>Scope</Text>
            <View style={styles.scopeSwitchRow}>
              {(["global", "server", "channel"] as AiMemoryScopeType[]).map((scope) => (
                <TouchableOpacity
                  key={scope}
                  style={[
                    styles.scopeSwitch,
                    draft.scopeType === scope && styles.scopeSwitchActive,
                  ]}
                  onPress={() =>
                    setDraft((current) => ({
                      ...current,
                      scopeType: scope,
                      scopeId:
                        scope === "channel" && current.scopeId.includes(":")
                          ? current.scopeId
                          : scope === "global"
                            ? ""
                            : current.scopeId,
                    }))
                  }
                >
                  <Text
                    style={[
                      styles.scopeSwitchText,
                      draft.scopeType === scope && styles.scopeSwitchTextActive,
                    ]}
                  >
                    {scope}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {draft.scopeType !== "global" && (
              <>
                <Text style={styles.fieldLabel}>Scope ID</Text>
                <TextInput
                  value={draft.scopeId}
                  onChangeText={(value) => setDraft((current) => ({ ...current, scopeId: value }))}
                  style={styles.input}
                  placeholder={
                    draft.scopeType === "server" ? "bsis" : makeAiMemoryChannelScopeId("bsis", "bsis_general")
                  }
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="none"
                />
              </>
            )}

            <Text style={styles.fieldLabel}>Tags</Text>
            <TextInput
              value={draft.tags}
              onChangeText={(value) => setDraft((current) => ({ ...current, tags: value }))}
              style={styles.input}
              placeholder="developers, project, rules"
              placeholderTextColor={theme.textMuted}
            />

            <Text style={styles.fieldLabel}>Priority</Text>
            <TextInput
              value={draft.priority}
              onChangeText={(value) => setDraft((current) => ({ ...current, priority: value }))}
              style={styles.input}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor={theme.textMuted}
            />

            <View style={styles.toggleRow}>
              <Text style={styles.fieldLabel}>Active</Text>
              <Switch
                value={draft.active}
                onValueChange={(value) => setDraft((current) => ({ ...current, active: value }))}
                trackColor={{ false: theme.borderStrong, true: theme.accent }}
                thumbColor={draft.active ? theme.primary : theme.surfaceRaised}
              />
            </View>

            <TouchableOpacity
              style={[styles.saveButton, saving && { opacity: 0.6 }]}
              onPress={saveEntry}
              disabled={saving}
            >
              <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save Memory"}</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmText={dialog?.confirmText ?? "Confirm"}
        cancelText={dialog?.cancelText}
        destructive={dialog?.destructive ?? true}
        singleAction={dialog?.singleAction ?? false}
        loading={!!deletingId}
        onConfirm={() => dialog?.onConfirm()}
        onCancel={() => setDialog(null)}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.primary,
  },
  contentShell: {
    flex: 1,
    backgroundColor: c.surfaceSunken,
  },
  centerState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 28,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: c.primary,
    gap: 12,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.primary,
  },
  headerTitle: {
    color: c.surface,
    fontSize: 21,
    fontWeight: "800",
  },
  headerSubtitle: {
    color: c.borderStrong,
    marginTop: 2,
    fontSize: 12.5,
  },
  addButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.accent,
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  statPill: {
    flex: 1,
    backgroundColor: c.surface,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  statPillActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  statValue: {
    color: c.primary,
    fontSize: 18,
    fontWeight: "800",
  },
  statValueActive: {
    color: c.surface,
  },
  statLabel: {
    color: c.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  statLabelActive: {
    color: c.borderStrong,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.borderStrong,
    paddingHorizontal: 12,
    height: 42,
  },
  searchInput: {
    flex: 1,
    color: c.textPrimary,
    fontSize: 14,
    height: "100%",
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 36,
  },
  helperCard: {
    backgroundColor: c.surfaceRaised,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 14,
    marginBottom: 14,
  },
  helperTitle: {
    color: c.primary,
    fontWeight: "800",
    marginBottom: 8,
  },
  helperText: {
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  emptyCard: {
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 28,
    alignItems: "center",
  },
  emptyTitle: {
    marginTop: 12,
    color: c.primary,
    fontSize: 18,
    fontWeight: "800",
  },
  emptyText: {
    marginTop: 8,
    color: c.textMuted,
    textAlign: "center",
    lineHeight: 20,
  },
  memoryCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 14,
    marginBottom: 12,
  },
  memoryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  scopeBadge: {
    backgroundColor: c.primary,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  scopeBadgeText: {
    color: c.surface,
    fontSize: 11,
    fontWeight: "800",
  },
  priorityText: {
    color: c.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  memoryTitle: {
    color: c.textPrimary,
    fontSize: 16,
    fontWeight: "800",
  },
  scopeIdText: {
    color: "#a86fff",
    fontSize: 12,
    marginTop: 4,
    fontWeight: "700",
  },
  memoryBody: {
    color: c.textSecondary,
    fontSize: 14,
    marginTop: 8,
    lineHeight: 21,
  },
  tagsText: {
    color: c.accent,
    marginTop: 10,
    fontSize: 12,
    fontWeight: "600",
  },
  cardActions: {
    flexDirection: "row",
    gap: 18,
    marginTop: 14,
  },
  cardAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  cardActionText: {
    color: c.primary,
    fontWeight: "700",
  },
  modalContainer: {
    flex: 1,
    backgroundColor: c.surfaceSunken,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.borderStrong,
  },
  modalTitle: {
    color: c.primary,
    fontSize: 20,
    fontWeight: "800",
  },
  modalContent: {
    padding: 16,
    paddingBottom: 40,
  },
  fieldLabel: {
    color: c.primary,
    fontWeight: "700",
    marginBottom: 8,
  },
  input: {
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.borderStrong,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: c.textPrimary,
    marginBottom: 14,
  },
  textArea: {
    minHeight: 180,
  },
  scopeSwitchRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 14,
  },
  scopeSwitch: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  scopeSwitchActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  scopeSwitchText: {
    color: c.primary,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  scopeSwitchTextActive: {
    color: c.surface,
  },
  toggleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 22,
  },
  saveButton: {
    backgroundColor: c.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveButtonText: {
    color: c.surface,
    fontSize: 15,
    fontWeight: "800",
  },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

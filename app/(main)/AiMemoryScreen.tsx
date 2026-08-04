import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import {
  type AiMemoryEntry,
  type AiMemoryScopeType,
  makeAiMemoryChannelScopeId,
} from "@/utils/aiMemory";
import { canManageAiMemory, resolveUserRoleForAuthUser } from "@/utils/rbac";

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
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [entries, setEntries] = useState<AiMemoryEntry[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const bootstrap = async () => {
      const authUser = auth.currentUser;
      if (!authUser) {
        setAllowed(false);
        setLoading(false);
        return;
      }

      const role = await resolveUserRoleForAuthUser(authUser);
      setAllowed(canManageAiMemory(role));
      setLoading(false);
    };

    bootstrap();
  }, []);

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

  const groupedStats = useMemo(
    () => ({
      global: entries.filter((entry) => entry.scopeType === "global").length,
      server: entries.filter((entry) => entry.scopeType === "server").length,
      channel: entries.filter((entry) => entry.scopeType === "channel").length,
    }),
    [entries],
  );

  const openCreate = () => {
    setDraft(emptyDraft);
    setShowEditor(true);
  };

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

  const saveEntry = async () => {
    if (!draft.title.trim() || !draft.content.trim()) {
      Alert.alert("Missing Info", "Title and content are required.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        recordType: "aiMemory",
        title: draft.title.trim(),
        content: draft.content.trim(),
        scopeType: "global",
        scopeId: null,
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
      Alert.alert("Error", "Failed to save AI memory.");
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = async (entryId: string) => {
    Alert.alert("Delete Memory", "Remove this memory entry?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteDoc(doc(db, "communityServers", entryId));
          } catch (error) {
            console.error("Error deleting AI memory:", error);
            Alert.alert("Error", "Failed to delete AI memory.");
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color="#e0a53d" />
        </View>
      </SafeAreaView>
    );
  }

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerState}>
          <Ionicons name="lock-closed-outline" size={42} color="#e0a53d" />
          <Text style={styles.emptyTitle}>Access Restricted</Text>
          <Text style={styles.emptyText}>
            Only admins, teachers, and moderators can manage Bonded AI memory.
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
          <Ionicons name="arrow-back" size={22} color="#fffaf7" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Bonded AI Memory</Text>
          <Text style={styles.headerSubtitle}>
            Global long-term knowledge for Bonded AI
          </Text>
        </View>
        <TouchableOpacity onPress={openCreate} style={styles.addButton}>
          <Ionicons name="add" size={22} color="#5f0909" />
        </TouchableOpacity>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statPill}>
          <Text style={styles.statValue}>{entries.length}</Text>
          <Text style={styles.statLabel}>Total</Text>
        </View>
        <View style={styles.statPill}>
          <Text style={styles.statValue}>{groupedStats.global}</Text>
          <Text style={styles.statLabel}>Global</Text>
        </View>
        <View style={styles.statPill}>
          <Text style={styles.statValue}>{groupedStats.server}</Text>
          <Text style={styles.statLabel}>Server</Text>
        </View>
        <View style={styles.statPill}>
          <Text style={styles.statValue}>{groupedStats.channel}</Text>
          <Text style={styles.statLabel}>Channel</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.helperCard}>
          <Text style={styles.helperTitle}>Scope format</Text>
          <Text style={styles.helperText}>Server scope ID example: `bsis`</Text>
          <Text style={styles.helperText}>Channel scope ID example: `bsis:bsis_general`</Text>
          <Text style={styles.helperText}>
            All saved memory is treated as global and prioritized by Bonded AI.
          </Text>
        </View>

        {entries.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="library-outline" size={42} color="#c59a8a" />
            <Text style={styles.emptyTitle}>No memory yet</Text>
            <Text style={styles.emptyText}>
              Add facts like developers, project history, rules, FAQ answers, or server-specific knowledge.
            </Text>
          </View>
        ) : (
          entries.map((entry) => (
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
                <TouchableOpacity style={styles.cardAction} onPress={() => openEdit(entry)}>
                  <Ionicons name="create-outline" size={16} color="#5f0909" />
                  <Text style={styles.cardActionText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.cardAction} onPress={() => removeEntry(entry.id)}>
                  <Ionicons name="trash-outline" size={16} color="#9b1f1c" />
                  <Text style={[styles.cardActionText, { color: "#9b1f1c" }]}>Delete</Text>
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
              <Ionicons name="close" size={24} color="#5f0909" />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalContent}>
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput
              value={draft.title}
              onChangeText={(value) => setDraft((current) => ({ ...current, title: value }))}
              style={styles.input}
              placeholder="Developers of this system"
              placeholderTextColor="#9b766c"
            />

            <Text style={styles.fieldLabel}>Content</Text>
            <TextInput
              value={draft.content}
              onChangeText={(value) => setDraft((current) => ({ ...current, content: value }))}
              style={[styles.input, styles.textArea]}
              multiline
              textAlignVertical="top"
              placeholder="Write the long-term fact or instruction here..."
              placeholderTextColor="#9b766c"
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
                  placeholderTextColor="#9b766c"
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
              placeholderTextColor="#9b766c"
            />

            <Text style={styles.fieldLabel}>Priority</Text>
            <TextInput
              value={draft.priority}
              onChangeText={(value) => setDraft((current) => ({ ...current, priority: value }))}
              style={styles.input}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor="#9b766c"
            />

            <View style={styles.toggleRow}>
              <Text style={styles.fieldLabel}>Active</Text>
              <Switch
                value={draft.active}
                onValueChange={(value) => setDraft((current) => ({ ...current, active: value }))}
                trackColor={{ false: "#d7c0b6", true: "#d7a94f" }}
                thumbColor={draft.active ? "#5f0909" : "#fffaf7"}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#5f0909",
  },
  contentShell: {
    flex: 1,
    backgroundColor: "#f6f1ed",
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
    backgroundColor: "#5f0909",
    gap: 12,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#7b1f17",
  },
  headerTitle: {
    color: "#fffaf7",
    fontSize: 21,
    fontWeight: "800",
  },
  headerSubtitle: {
    color: "#f0d2c2",
    marginTop: 2,
    fontSize: 12.5,
  },
  addButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#e0a53d",
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  statPill: {
    flex: 1,
    backgroundColor: "#fffaf7",
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ead7cf",
  },
  statValue: {
    color: "#5f0909",
    fontSize: 18,
    fontWeight: "800",
  },
  statLabel: {
    color: "#9b766c",
    fontSize: 11,
    marginTop: 2,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 36,
  },
  helperCard: {
    backgroundColor: "#fff8f4",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ead7cf",
    padding: 14,
    marginBottom: 14,
  },
  helperTitle: {
    color: "#5f0909",
    fontWeight: "800",
    marginBottom: 8,
  },
  helperText: {
    color: "#7a3b2e",
    fontSize: 13,
    lineHeight: 20,
  },
  emptyCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#ead7cf",
    padding: 28,
    alignItems: "center",
  },
  emptyTitle: {
    marginTop: 12,
    color: "#5f0909",
    fontSize: 18,
    fontWeight: "800",
  },
  emptyText: {
    marginTop: 8,
    color: "#9b766c",
    textAlign: "center",
    lineHeight: 20,
  },
  memoryCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ead7cf",
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
    backgroundColor: "#5f0909",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  scopeBadgeText: {
    color: "#fffaf7",
    fontSize: 11,
    fontWeight: "800",
  },
  priorityText: {
    color: "#9b766c",
    fontSize: 12,
    fontWeight: "600",
  },
  memoryTitle: {
    color: "#4d1b17",
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
    color: "#68423b",
    fontSize: 14,
    marginTop: 8,
    lineHeight: 21,
  },
  tagsText: {
    color: "#c07a34",
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
    color: "#5f0909",
    fontWeight: "700",
  },
  modalContainer: {
    flex: 1,
    backgroundColor: "#f6f1ed",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#ead7cf",
  },
  modalTitle: {
    color: "#5f0909",
    fontSize: 20,
    fontWeight: "800",
  },
  modalContent: {
    padding: 16,
    paddingBottom: 40,
  },
  fieldLabel: {
    color: "#5f0909",
    fontWeight: "700",
    marginBottom: 8,
  },
  input: {
    backgroundColor: "#fffaf7",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ead7cf",
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: "#4d1b17",
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
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#ead7cf",
  },
  scopeSwitchActive: {
    backgroundColor: "#5f0909",
    borderColor: "#5f0909",
  },
  scopeSwitchText: {
    color: "#5f0909",
    fontWeight: "700",
    textTransform: "capitalize",
  },
  scopeSwitchTextActive: {
    color: "#fffaf7",
  },
  toggleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 22,
  },
  saveButton: {
    backgroundColor: "#5f0909",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveButtonText: {
    color: "#fffaf7",
    fontSize: 15,
    fontWeight: "800",
  },
});

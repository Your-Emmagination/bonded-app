// app/(main)/ManageCampusFaqScreen.tsx
//
// Admin-only workspace for the Campus FAQ library that powers the BondED
// assistant (campus_knowledge intent). Full CRUD plus multi-select bulk delete.
//
// Performance notes (targets a steady 60fps, 120fps on ProMotion devices):
//  - FlatList with a fixed row height + getItemLayout, so no async layout
//    passes happen while scrolling.
//  - Row is React.memo'd with an explicit comparator; renderItem passes only
//    primitives (id, isSelected, selectionMode) so unaffected rows never
//    re-render on selection changes.
//  - Every handler passed down is useCallback-stable.
//  - The one animation (the selection bar) runs on the native driver.
//  - The editor lives in a separate Modal, so typing never re-renders the list.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { CAMPUS_KNOWLEDGE_INDEX } from "@/utils/campusKnowledgeIndex";
import { isAdmin } from "@/utils/rbac";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
    addDoc,
    collection,
    doc,
    onSnapshot,
    serverTimestamp,
    updateDoc,
    writeBatch,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated,
    FlatList,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
// The keyboard library's own view. It follows the keyboard frame by frame;
// React Native's built-in one stopped lifting anything on Android once
// KeyboardProvider (app/_layout.tsx) took over the keyboard.
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import ConfirmDialog from "./components/ConfirmDialog";
import { CardListSkeleton, SkeletonCard } from "./components/Skeleton";

const normalizeQuestion = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const QUESTION_MAX = 300;
const ANSWER_MAX = 2000;
const ROW_HEIGHT = 118; // card 108 + 10 gap — must match styles.card + marginBottom

type FaqRecord = {
  id: string;
  question: string;
  answer: string;
  updatedAtMs: number | null;
};

const formatUpdated = (ms: number | null) => {
  if (!ms) return "Just added";
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `Updated ${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `Updated ${day}d ago`;
  return `Updated ${new Date(ms).toLocaleDateString()}`;
};

// ---------------------------------------------------------------------------
// Row — memoized, fixed height
// ---------------------------------------------------------------------------

type RowProps = {
  id: string;
  question: string;
  answer: string;
  updatedAtMs: number | null;
  selectionMode: boolean;
  isSelected: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onLongPress: (id: string) => void;
};

const FaqRow = React.memo(
  function FaqRow({
    id,
    question,
    answer,
    updatedAtMs,
    selectionMode,
    isSelected,
    onOpen,
    onToggle,
    onLongPress,
  }: RowProps) {
    const { styles, theme } = useStyles();
    const handlePress = useCallback(() => {
      if (selectionMode) onToggle(id);
      else onOpen(id);
    }, [selectionMode, id, onToggle, onOpen]);

    const handleLongPress = useCallback(() => onLongPress(id), [id, onLongPress]);

    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={handlePress}
        onLongPress={handleLongPress}
        delayLongPress={220}
        style={[styles.card, isSelected && styles.cardSelected]}
      >
        {selectionMode && (
          <View
            style={[styles.checkbox, isSelected && styles.checkboxOn]}
          >
            {isSelected && (
              <Ionicons name="checkmark" size={15} color={theme.onPrimary} />
            )}
          </View>
        )}
        <View style={styles.cardBody}>
          <Text style={styles.cardQuestion} numberOfLines={1}>
            {question}
          </Text>
          <Text style={styles.cardAnswer} numberOfLines={2}>
            {answer}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {formatUpdated(updatedAtMs)}
          </Text>
        </View>
        {!selectionMode && (
          <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
        )}
      </TouchableOpacity>
    );
  },
  (prev, next) =>
    prev.id === next.id &&
    prev.question === next.question &&
    prev.answer === next.answer &&
    prev.updatedAtMs === next.updatedAtMs &&
    prev.selectionMode === next.selectionMode &&
    prev.isSelected === next.isSelected,
);

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ManageCampusFaqScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  // Live, so losing admin access closes this screen without a reopen.
  const role = useCurrentUserRole();
  const [entries, setEntries] = useState<FaqRecord[]>([]);
  const [search, setSearch] = useState("");

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [editorVisible, setEditorVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftQuestion, setDraftQuestion] = useState("");
  const [draftAnswer, setDraftAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [confirmingImport, setConfirmingImport] = useState(false);
  const [importing, setImporting] = useState(false);

  const canManage = isAdmin(role);
  const selectionBar = useRef(new Animated.Value(0)).current;
  const fabScale = useRef(new Animated.Value(0)).current;

  // --- auth gate ---------------------------------------------------------
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setLoading(false);
      if (!user) {
        router.replace("/(main)/(tabs)/HomeScreen");
      }
    });
    return unsubscribe;
  }, [router]);

  // The role is tracked live above. undefined means it has not resolved yet,
  // which must not trigger a redirect.
  useEffect(() => {
    if (role !== undefined && !isAdmin(role)) {
      router.replace("/(main)/(tabs)/DashboardScreen");
    }
  }, [role, router]);

  // --- live data -------------------------------------------------------
  useEffect(() => {
    if (!canManage || !auth.currentUser) {
      setEntries([]);
      return;
    }
    return onSnapshot(
      collection(db, "campusFaq"),
      (snapshot) => {
        const next = snapshot.docs.map((item) => {
          const data = item.data() as Record<string, unknown>;
          const updatedAt = data.updatedAt as
            | { toMillis?: () => number }
            | undefined;
          return {
            id: item.id,
            question: String(data.question || "").trim(),
            answer: String(data.answer || "").trim(),
            updatedAtMs:
              updatedAt && typeof updatedAt.toMillis === "function"
                ? updatedAt.toMillis()
                : null,
          };
        });
        next.sort((a, b) => a.question.localeCompare(b.question));
        setEntries(next);
      },
      (error) => console.error("campusFaq snapshot error:", error),
    );
  }, [canManage]);

  // --- selection bar animation ---------------------------------------
  useEffect(() => {
    Animated.timing(selectionBar, {
      toValue: selectionMode ? 1 : 0,
      duration: 190,
      useNativeDriver: true,
    }).start();
  }, [selectionMode, selectionBar]);

  useEffect(() => {
    Animated.spring(fabScale, {
      toValue: selectionMode ? 0 : 1,
      useNativeDriver: true,
      friction: 7,
      tension: 80,
    }).start();
  }, [selectionMode, fabScale]);

  // --- derived ------------------------------------------------------------
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (entry) =>
        entry.question.toLowerCase().includes(q) ||
        entry.answer.toLowerCase().includes(q),
    );
  }, [entries, search]);

  const selectedCount = selectedIds.size;
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((entry) => selectedIds.has(entry.id));

  // Built-in FAQ answers (from the bundled offline index) that aren't in
  // Firestore yet — matched by normalized question so a re-import is a no-op.
  const bundledPending = useMemo(() => {
    const existing = new Set(entries.map((entry) => normalizeQuestion(entry.question)));
    const questions = CAMPUS_KNOWLEDGE_INDEX.questions;
    const answers = CAMPUS_KNOWLEDGE_INDEX.answers;
    const out: { question: string; answer: string }[] = [];
    for (let i = 0; i < questions.length; i += 1) {
      const question = String(questions[i] || "").trim();
      const answer = String(answers[i] || "").trim();
      if (!question || !answer) continue;
      if (answer.toLowerCase().startsWith("todo:")) continue;
      if (existing.has(normalizeQuestion(question))) continue;
      out.push({ question, answer });
    }
    return out;
  }, [entries]);

  // --- handlers ---------------------------------------------------------
  const openCreate = useCallback(() => {
    setEditingId(null);
    setDraftQuestion("");
    setDraftAnswer("");
    setEditorError(null);
    setEditorVisible(true);
  }, []);

  const openEdit = useCallback(
    (id: string) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry) return;
      setEditingId(id);
      setDraftQuestion(entry.question);
      setDraftAnswer(entry.answer);
      setEditorError(null);
      setEditorVisible(true);
    },
    [entries],
  );

  const closeEditor = useCallback(() => {
    if (saving) return;
    setEditorVisible(false);
  }, [saving]);

  const saveEntry = useCallback(async () => {
    const question = draftQuestion.trim();
    const answer = draftAnswer.trim();
    if (!question) {
      setEditorError("Add the question a student would ask.");
      return;
    }
    if (!answer) {
      setEditorError("Add the answer the assistant should give.");
      return;
    }
    if (question.length > QUESTION_MAX || answer.length > ANSWER_MAX) {
      setEditorError("Trim the entry to the allowed length.");
      return;
    }
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    setSaving(true);
    setEditorError(null);
    try {
      if (editingId) {
        await updateDoc(doc(db, "campusFaq", editingId), {
          question,
          answer,
          updatedBy: uid,
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, "campusFaq"), {
          question,
          answer,
          updatedBy: uid,
          updatedAt: serverTimestamp(),
        });
      }
      setEditorVisible(false);
    } catch (error) {
      console.error("Failed to save campus FAQ entry:", error);
      setEditorError("Could not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }, [draftQuestion, draftAnswer, editingId]);

  const enterSelection = useCallback((id: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((current) => {
      if (filtered.length > 0 && filtered.every((e) => current.has(e.id))) {
        return new Set();
      }
      return new Set(filtered.map((e) => e.id));
    });
  }, [filtered]);

  const askDeleteBulk = useCallback(() => {
    if (selectedIds.size === 0) return;
    setConfirmingDelete(true);
  }, [selectedIds]);

  const cancelDelete = useCallback(() => {
    if (deleting) return;
    setConfirmingDelete(false);
  }, [deleting]);

  const confirmDelete = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      setConfirmingDelete(false);
      return;
    }
    setDeleting(true);
    try {
      // A single delete is just a one-item batch; Firestore batches cap at 500.
      for (let i = 0; i < ids.length; i += 450) {
        const batch = writeBatch(db);
        ids.slice(i, i + 450).forEach((id) => {
          batch.delete(doc(db, "campusFaq", id));
        });
        await batch.commit();
      }
      setSelectionMode(false);
      setSelectedIds(new Set());
      setConfirmingDelete(false);
    } catch (error) {
      console.error("Failed to delete campus FAQ entries:", error);
    } finally {
      setDeleting(false);
    }
  }, [selectedIds]);

  const importBundled = useCallback(async () => {
    const uid = auth.currentUser?.uid;
    if (!uid || bundledPending.length === 0) {
      setConfirmingImport(false);
      return;
    }
    setImporting(true);
    try {
      for (let i = 0; i < bundledPending.length; i += 450) {
        const batch = writeBatch(db);
        bundledPending.slice(i, i + 450).forEach(({ question, answer }) => {
          batch.set(doc(collection(db, "campusFaq")), {
            question,
            answer,
            updatedBy: uid,
            updatedAt: serverTimestamp(),
          });
        });
        await batch.commit();
      }
      setConfirmingImport(false);
    } catch (error) {
      console.error("Failed to import bundled campus FAQ answers:", error);
    } finally {
      setImporting(false);
    }
  }, [bundledPending]);

  // --- list plumbing (stable) ----------------------------------------
  const keyExtractor = useCallback((item: FaqRecord) => item.id, []);

  const getItemLayout = useCallback(
    (_: ArrayLike<FaqRecord> | null | undefined, index: number) => ({
      length: ROW_HEIGHT,
      offset: ROW_HEIGHT * index,
      index,
    }),
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: FaqRecord }) => (
      <FaqRow
        id={item.id}
        question={item.question}
        answer={item.answer}
        updatedAtMs={item.updatedAtMs}
        selectionMode={selectionMode}
        isSelected={selectedIds.has(item.id)}
        onOpen={openEdit}
        onToggle={toggleSelect}
        onLongPress={enterSelection}
      />
    ),
    [selectionMode, selectedIds, openEdit, toggleSelect, enterSelection],
  );

  // --- gates ---------------------------------------------------------
  if (loading) {
    // Drawn as the screen will be — its bar, its opening card, then cards in
    // the real card style — so nothing moves when the data arrives.
    return (
      <SafeAreaView style={styles.safeArea} edges={["top"]}>
        <View style={styles.topBar}>
          <TouchableOpacity
            style={styles.iconBtnDark}
            onPress={() => router.back()}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            <Ionicons name="arrow-back" size={21} color={theme.onPrimary} />
          </TouchableOpacity>
          <View style={styles.topBarCopy}>
            <Text style={styles.topBarEyebrow}>ADMIN WORKSPACE</Text>
            <Text style={styles.topBarTitle}>Manage Campus FAQ</Text>
          </View>
          <View style={[styles.iconBtnGold, styles.iconBtnGoldOff]} />
        </View>
        <CardListSkeleton
          count={5}
          style={[styles.list, styles.listContent]}
          header={
            <SkeletonCard
              style={styles.heroCard}
              avatar={{ size: 48, radius: 16, style: { marginRight: 16 } }}
              lines={[
                { width: "55%", height: 15 },
                { width: "90%", height: 11, gap: 9 },
                { width: "70%", height: 11, gap: 6 },
              ]}
            />
          }
          cardStyle={styles.card}
          lines={[
            { width: "72%", height: 14 },
            { width: "95%", height: 11, gap: 10 },
            { width: "80%", height: 11, gap: 6 },
            { width: 90, height: 10, gap: 10 },
          ]}
        />
      </SafeAreaView>
    );
  }
  if (!canManage) return null;

  const questionLen = draftQuestion.trim().length;
  const answerLen = draftAnswer.trim().length;
  const canSave =
    questionLen > 0 &&
    answerLen > 0 &&
    questionLen <= QUESTION_MAX &&
    answerLen <= ANSWER_MAX &&
    !saving;

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity
          style={styles.iconBtnDark}
          onPress={() => (selectionMode ? exitSelection() : router.back())}
          activeOpacity={0.8}
          accessibilityRole="button"
        >
          <Ionicons
            name={selectionMode ? "close" : "arrow-back"}
            size={21}
            color={theme.onPrimary}
          />
        </TouchableOpacity>
        <View style={styles.topBarCopy}>
          <Text style={styles.topBarEyebrow}>ADMIN WORKSPACE</Text>
          <Text style={styles.topBarTitle}>
            {selectionMode ? `${selectedCount} selected` : "Manage Campus FAQ"}
          </Text>
        </View>
        <TouchableOpacity
          style={[
            styles.iconBtnGold,
            entries.length === 0 && !selectionMode && styles.iconBtnGoldOff,
          ]}
          onPress={() => setSelectionMode((value) => !value)}
          disabled={entries.length === 0 && !selectionMode}
          activeOpacity={0.82}
          accessibilityRole="button"
          accessibilityLabel={selectionMode ? "Exit selection" : "Select entries"}
        >
          <Ionicons
            name={selectionMode ? "checkmark-done" : "checkbox-outline"}
            size={20}
            color={theme.primary}
          />
        </TouchableOpacity>
      </View>

      {/* Selection action bar */}
      {selectionMode && (
        <Animated.View
          style={[
            styles.selectionBar,
            {
              opacity: selectionBar,
              transform: [
                {
                  translateY: selectionBar.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-12, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <TouchableOpacity
            style={styles.selectionAction}
            onPress={toggleSelectAll}
            activeOpacity={0.75}
          >
            <Ionicons
              name={allVisibleSelected ? "checkbox" : "square-outline"}
              size={18}
              color={theme.primary}
            />
            <Text style={styles.selectionActionText}>
              {allVisibleSelected ? "Clear all" : "Select all"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.selectionDelete,
              selectedCount === 0 && styles.selectionDeleteOff,
            ]}
            onPress={askDeleteBulk}
            disabled={selectedCount === 0}
            activeOpacity={0.85}
          >
            <Ionicons name="trash-outline" size={17} color={theme.onPrimary} />
            <Text style={styles.selectionDeleteText}>
              Delete{selectedCount > 0 ? ` ${selectedCount}` : ""}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* Hero + search (list header) */}
      <FlatList
        data={filtered}
        style={styles.list}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialNumToRender={10}
        maxToRenderPerBatch={8}
        windowSize={7}
        updateCellsBatchingPeriod={40}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            <View style={styles.heroCard}>
              <View style={styles.heroIcon}>
                <Ionicons name="book-outline" size={26} color={theme.accent} />
              </View>
              <View style={styles.heroCopy}>
                <Text style={styles.heroTitle}>Campus FAQ library</Text>
                <Text style={styles.heroText}>
                  These answers power the BondED assistant. Anything you add,
                  edit, or remove reaches students the next time they ask.
                </Text>
              </View>
            </View>

            <View style={styles.summaryRow}>
              <Text style={styles.summaryText}>
                {entries.length}{" "}
                {entries.length === 1 ? "published answer" : "published answers"}
              </Text>
              {search.trim().length > 0 && (
                <Text style={styles.summaryMuted}>
                  {filtered.length} shown
                </Text>
              )}
            </View>

            <View style={styles.searchShell}>
              <Ionicons name="search" size={18} color={theme.textSecondary} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search questions and answers"
                placeholderTextColor={theme.textMuted}
                style={styles.searchInput}
                autoCapitalize="none"
                returnKeyType="search"
              />
              {search.trim().length > 0 && (
                <TouchableOpacity
                  onPress={() => setSearch("")}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons name="close-circle" size={18} color={theme.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            {bundledPending.length > 0 && !selectionMode && (
              <View style={styles.importCard}>
                <View style={styles.importIcon}>
                  <Ionicons
                    name="cloud-download-outline"
                    size={20}
                    color={theme.accent}
                  />
                </View>
                <View style={styles.importCopy}>
                  <Text style={styles.importTitle}>
                    {bundledPending.length}{" "}
                    {bundledPending.length === 1
                      ? "built-in answer"
                      : "built-in answers"}{" "}
                    ready to import
                  </Text>
                  <Text style={styles.importText}>
                    BondED's starter FAQ answers. Import once, then edit or
                    delete any of them here.
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.importBtn}
                  onPress={() => setConfirmingImport(true)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.importBtnText}>Import</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons
              name={search.trim() ? "search-outline" : "book-outline"}
              size={40}
              color={theme.textMuted}
            />
            <Text style={styles.emptyTitle}>
              {search.trim() ? "Nothing matches that search" : "No FAQ answers yet"}
            </Text>
            <Text style={styles.emptyText}>
              {search.trim()
                ? "Try a shorter or different phrase."
                : "Add your first campus answer so the assistant can help students with school questions."}
            </Text>
            {!search.trim() && (
              <TouchableOpacity
                style={styles.emptyCta}
                onPress={openCreate}
                activeOpacity={0.85}
              >
                <Ionicons name="add" size={18} color={theme.primary} />
                <Text style={styles.emptyCtaText}>Add an answer</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />

      {/* FAB */}
      <Animated.View
        style={[
          styles.fabWrap,
          { transform: [{ scale: fabScale }] },
        ]}
        pointerEvents={selectionMode ? "none" : "auto"}
      >
        <TouchableOpacity
          style={styles.fab}
          onPress={openCreate}
          activeOpacity={0.88}
          accessibilityRole="button"
          accessibilityLabel="Add FAQ entry"
        >
          <Ionicons name="add" size={26} color={theme.onPrimary} />
        </TouchableOpacity>
      </Animated.View>

      {/* Editor */}
      <Modal
        visible={editorVisible}
        animationType="slide"
        transparent
        onRequestClose={closeEditor}
      >
        <KeyboardAvoidingView automaticOffset
          behavior="padding"
          style={styles.editorOverlay}
        >
          <Pressable style={styles.editorBackdrop} onPress={closeEditor} />
          <View style={styles.editorSheet}>
            <View style={styles.editorHandle} />
            <View style={styles.editorHeader}>
              <Text style={styles.editorTitle}>
                {editingId ? "Edit FAQ entry" : "New FAQ entry"}
              </Text>
              <TouchableOpacity
                onPress={closeEditor}
                style={styles.iconBtnLight}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Ionicons name="close" size={20} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.field}>
              <View style={styles.fieldLabelRow}>
                <Text style={styles.fieldLabel}>Question</Text>
                <Text
                  style={[
                    styles.counter,
                    questionLen > QUESTION_MAX && styles.counterOver,
                  ]}
                >
                  {questionLen}/{QUESTION_MAX}
                </Text>
              </View>
              <TextInput
                value={draftQuestion}
                onChangeText={setDraftQuestion}
                placeholder="Phrase it the way a student would ask"
                placeholderTextColor={theme.textMuted}
                style={styles.inputQuestion}
                multiline
              />
            </View>

            <View style={styles.field}>
              <View style={styles.fieldLabelRow}>
                <Text style={styles.fieldLabel}>Answer</Text>
                <Text
                  style={[
                    styles.counter,
                    answerLen > ANSWER_MAX && styles.counterOver,
                  ]}
                >
                  {answerLen}/{ANSWER_MAX}
                </Text>
              </View>
              <TextInput
                value={draftAnswer}
                onChangeText={setDraftAnswer}
                placeholder="The assistant will give this wording exactly"
                placeholderTextColor={theme.textMuted}
                style={styles.inputAnswer}
                multiline
                textAlignVertical="top"
              />
            </View>

            {editorError && (
              <View style={styles.editorErrorRow}>
                <Ionicons name="alert-circle" size={15} color={theme.danger} />
                <Text style={styles.editorErrorText}>{editorError}</Text>
              </View>
            )}

            <View style={styles.editorButtons}>
              <TouchableOpacity
                style={styles.editorCancel}
                onPress={closeEditor}
                disabled={saving}
                activeOpacity={0.8}
              >
                <Text style={styles.editorCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.editorSave, !canSave && styles.editorSaveOff]}
                onPress={saveEntry}
                disabled={!canSave}
                activeOpacity={0.88}
              >
                {saving ? (
                  <ActivityIndicator color={theme.onPrimary} size="small" />
                ) : (
                  <Text style={styles.editorSaveText}>Save entry</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Delete confirm — one entry or many */}
      <ConfirmDialog
        visible={confirmingDelete}
        variant="destructive"
        icon="trash-outline"
        title={
          selectedCount === 1
            ? "Delete this FAQ entry?"
            : `Delete ${selectedCount} FAQ entries?`
        }
        description={
          selectedCount === 1
            ? "The assistant will stop giving this answer. This can't be undone."
            : `The assistant will stop giving these ${selectedCount} answers. This can't be undone.`
        }
        confirmText={selectedCount === 1 ? "Delete" : `Delete ${selectedCount}`}
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />

      {/* Import bundled answers confirm */}
      <ConfirmDialog
        visible={confirmingImport}
        variant="info"
        icon="cloud-download-outline"
        title={`Import ${bundledPending.length} built-in ${
          bundledPending.length === 1 ? "answer" : "answers"
        }?`}
        description="These are BondED's starter FAQ answers. They'll be added as normal entries you can edit or delete. Answers you've already added are skipped."
        confirmText="Import"
        loading={importing}
        onConfirm={importBundled}
        onCancel={() => {
          if (!importing) setConfirmingImport(false);
        }}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: c.primary },
  loadingState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
    gap: 12,
  },
  loadingText: { color: c.textMuted, fontSize: 13, fontWeight: "600" },

  topBar: {
    minHeight: 66,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: c.primary,
    borderBottomWidth: 1,
    borderBottomColor: c.primary,
  },
  iconBtnDark: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  iconBtnGold: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.accent,
  },
  iconBtnGoldOff: { opacity: 0.45 },
  iconBtnLight: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
  },
  topBarCopy: { flex: 1 },
  topBarEyebrow: {
    color: c.accent,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.1,
  },
  topBarTitle: {
    color: c.background,
    fontSize: 20,
    fontWeight: "900",
    marginTop: 2,
  },

  selectionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: c.accentSoft,
    borderBottomWidth: 1,
    borderBottomColor: c.accent,
  },
  selectionAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  selectionActionText: { color: c.primary, fontSize: 13, fontWeight: "800" },
  selectionDelete: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: c.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
  },
  selectionDeleteOff: { backgroundColor: c.borderStrong },
  selectionDeleteText: { color: c.background, fontSize: 13, fontWeight: "800" },

  list: { flex: 1, backgroundColor: c.surfaceSunken },
  listContent: {
    padding: 16,
    paddingBottom: 32,
    flexGrow: 1,
  },

  heroCard: {
    flexDirection: "row",
    gap: 16,
    padding: 16,
    borderRadius: 20,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.borderStrong,
    marginBottom: 16,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  heroCopy: { flex: 1 },
  heroTitle: { color: c.textPrimary, fontSize: 17, fontWeight: "900" },
  heroText: {
    color: c.textMuted,
    fontSize: 12.5,
    lineHeight: 20,
    marginTop: 5,
  },

  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  summaryText: { color: c.textSecondary, fontSize: 12.5, fontWeight: "800" },
  summaryMuted: { color: c.textMuted, fontSize: 12, fontWeight: "700" },

  searchShell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: Platform.OS === "ios" ? 12 : 4,
    marginBottom: 16,
  },
  searchInput: {
    flex: 1,
    color: c.textPrimary,
    fontSize: 14,
    padding: 0,
  },

  importCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.accent,
    borderRadius: 16,
    padding: 13,
    marginBottom: 16,
  },
  importIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  importCopy: { flex: 1 },
  importTitle: { color: c.accent, fontSize: 13, fontWeight: "800" },
  importText: {
    color: c.textSecondary,
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 3,
  },
  importBtn: {
    backgroundColor: c.primary,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  importBtnText: { color: c.background, fontSize: 12.5, fontWeight: "800" },

  skeletonContent: { flex: 1, backgroundColor: c.surfaceSunken, padding: 16 },
  skeletonCard: {
    height: 108,
    marginBottom: 10,
    backgroundColor: c.background,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  card: {
    height: 108,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: c.background,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  cardSelected: {
    borderColor: c.accent,
    backgroundColor: c.surface,
  },
  cardBody: { flex: 1 },
  cardQuestion: { color: c.textPrimary, fontSize: 14.5, fontWeight: "800" },
  cardAnswer: {
    color: c.textSecondary,
    fontSize: 12.5,
    lineHeight: 16,
    marginTop: 3,
  },
  cardMeta: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: "600",
    marginTop: 5,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: c.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },

  emptyState: {
    alignItems: "center",
    paddingTop: 32,
    paddingHorizontal: 20,
    gap: 8,
  },
  emptyTitle: {
    color: c.textPrimary,
    fontSize: 16,
    fontWeight: "900",
    marginTop: 4,
  },
  emptyText: {
    color: c.textMuted,
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
  },
  emptyCta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: c.accent,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 13,
    marginTop: 10,
  },
  emptyCtaText: { color: c.primary, fontSize: 13, fontWeight: "800" },

  fabWrap: {
    position: "absolute",
    right: 18,
    bottom: 26,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 20,
    backgroundColor: c.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#3a0606",
    shadowOpacity: 0.32,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
  },

  editorOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(37,12,9,0.55)",
  },
  editorBackdrop: { ...StyleSheet.absoluteFill },
  editorSheet: {
    backgroundColor: c.surfaceSunken,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
  },
  editorHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.borderStrong,
    marginBottom: 10,
  },
  editorHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  editorTitle: { color: c.textPrimary, fontSize: 18, fontWeight: "900" },
  field: { marginBottom: 14 },
  fieldLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  fieldLabel: {
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  counter: { color: c.textMuted, fontSize: 11, fontWeight: "700" },
  counterOver: { color: c.danger },
  inputQuestion: {
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 13,
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: c.textPrimary,
    fontSize: 14,
    minHeight: 52,
  },
  inputAnswer: {
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 13,
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: c.textPrimary,
    fontSize: 14,
    minHeight: 128,
    lineHeight: 20,
  },
  editorErrorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 12,
  },
  editorErrorText: { color: c.danger, fontSize: 12.5, fontWeight: "700", flex: 1 },
  editorButtons: { flexDirection: "row", gap: 10, marginTop: 2 },
  editorCancel: {
    flex: 1,
    borderRadius: 13,
    paddingVertical: 16,
    alignItems: "center",
    backgroundColor: c.surfaceSunken,
  },
  editorCancelText: { color: c.textSecondary, fontSize: 14, fontWeight: "800" },
  editorSave: {
    flex: 1.4,
    borderRadius: 13,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.primary,
  },
  editorSaveOff: { backgroundColor: c.borderStrong },
  editorSaveText: { color: c.background, fontSize: 14, fontWeight: "800" },

});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

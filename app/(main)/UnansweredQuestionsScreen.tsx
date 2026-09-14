import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { isStaff, resolveUserRoleForAuthUser } from "@/utils/rbac";
import { clusterUnansweredQuestions, type UnansweredQuestionCluster } from "@/utils/unansweredClustering";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, Timestamp } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import ConfirmDialog from "./components/ConfirmDialog";
import { ListSkeleton } from "./components/Skeleton";

type UnansweredQuestion = {
  id: string;
  prompt: string;
  intent: string;
  confidence: number;
  createdAt?: Timestamp | null;
};

const formatDate = (value?: Timestamp | null) => {
  const date = value?.toDate?.();
  if (!date) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

export default function UnansweredQuestionsScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [questions, setQuestions] = useState<UnansweredQuestion[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<UnansweredQuestion | null>(null);

  useEffect(() => {
    const bootstrap = async () => {
      const authUser = auth.currentUser;
      if (!authUser) {
        setAllowed(false);
        setLoading(false);
        return;
      }

      const role = await resolveUserRoleForAuthUser(authUser);
      setAllowed(isStaff(role));
      setLoading(false);
    };

    bootstrap();
  }, []);

  useEffect(() => {
    if (!allowed) return;
    const unsubscribe = onSnapshot(
      query(collection(db, "chatbotUnansweredQuestions"), orderBy("createdAt", "desc")),
      (snapshot) => {
        const nextQuestions = snapshot.docs.map((item) => {
          const data = item.data();
          return {
            id: item.id,
            prompt: String(data.prompt || ""),
            intent: String(data.intent || "unknown"),
            confidence: Number(data.confidence || 0),
            createdAt: data.createdAt || null,
          } as UnansweredQuestion;
        });
        setQuestions(nextQuestions);
      },
    );

    return unsubscribe;
  }, [allowed]);

  // Only clusters with 2+ similar questions are shown as "common patterns"
  // — a lone question isn't really a pattern yet, and still shows in the
  // full list below either way.
  const clusters = useMemo(
    () =>
      clusterUnansweredQuestions(
        questions.map((question) => ({ id: question.id, prompt: question.prompt })),
      ).filter((cluster) => cluster.count >= 2),
    [questions],
  );

  const openAiMemorySuggestion = (cluster: UnansweredQuestionCluster) => {
    router.push({
      pathname: "/(main)/AiMemoryScreen",
      params: {
        prefillTitle: cluster.suggestedTitle,
        prefillTags: cluster.suggestedTags.join(", "),
      },
    });
  };

  const requestDeleteQuestion = (question: UnansweredQuestion) => {
    setConfirmTarget(question);
  };

  const confirmDeleteQuestion = async () => {
    if (!confirmTarget) return;
    setDeletingId(confirmTarget.id);
    try {
      await deleteDoc(doc(db, "chatbotUnansweredQuestions", confirmTarget.id));
      setConfirmTarget(null);
    } catch (error) {
      console.error("Error deleting unanswered question:", error);
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ListSkeleton showAvatar={false} count={5} />
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
            Only admins, teachers, and moderators can view unanswered chatbot questions.
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
            <Text style={styles.headerTitle}>Unanswered Questions</Text>
            <Text style={styles.headerSubtitle}>
              Real student questions B.E.A. couldn't answer
            </Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.helperCard}>
            <Text style={styles.helperText}>
              These questions failed to get a confident, database-backed answer. Review
              them to add new intent training examples or AI Memory entries.
            </Text>
          </View>

          {clusters.length > 0 && (
            <View style={styles.clusterSection}>
              <Text style={styles.clusterSectionTitle}>Common patterns</Text>
              <Text style={styles.clusterSectionHint}>
                Similar questions grouped together, most-asked first. Tap "Add to AI
                Memory" to open a draft entry with the title and tags pre-filled — you
                still write the actual answer.
              </Text>
              {clusters.map((cluster, index) => (
                <View key={`${cluster.representativePrompt}-${index}`} style={styles.clusterCard}>
                  <View style={styles.clusterCountBadge}>
                    <Text style={styles.clusterCountText}>
                      {cluster.count} similar question{cluster.count === 1 ? "" : "s"}
                    </Text>
                  </View>
                  <Text style={styles.clusterPrompt}>{cluster.representativePrompt}</Text>
                  {cluster.suggestedTags.length > 0 && (
                    <View style={styles.clusterTagsRow}>
                      {cluster.suggestedTags.map((tag) => (
                        <View key={tag} style={styles.clusterTagChip}>
                          <Text style={styles.clusterTagText}>{tag}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.clusterAddButton}
                    activeOpacity={0.85}
                    onPress={() => openAiMemorySuggestion(cluster)}
                  >
                    <Ionicons name="add-circle-outline" size={16} color={theme.onChrome} />
                    <Text style={styles.clusterAddButtonText}>Add to AI Memory</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {questions.length === 0 ? (
            <View style={styles.emptyCard}>
              <Ionicons name="checkmark-circle-outline" size={42} color={theme.textMuted} />
              <Text style={styles.emptyTitle}>Nothing unanswered</Text>
              <Text style={styles.emptyText}>
                B.E.A. hasn't logged any unanswered student questions yet.
              </Text>
            </View>
          ) : (
            questions.map((question) => (
              <View key={question.id} style={styles.questionCard}>
                <View style={styles.questionTopRow}>
                  <Text style={styles.promptText}>{question.prompt}</Text>
                  <TouchableOpacity
                    style={styles.deleteIconButton}
                    hitSlop={8}
                    disabled={deletingId === question.id}
                    onPress={() => requestDeleteQuestion(question)}
                  >
                    {deletingId === question.id ? (
                      <ActivityIndicator size="small" color={theme.danger} />
                    ) : (
                      <Ionicons name="trash-outline" size={18} color={theme.danger} />
                    )}
                  </TouchableOpacity>
                </View>
                <View style={styles.metaRow}>
                  <View style={styles.intentBadge}>
                    <Text style={styles.intentBadgeText}>{question.intent}</Text>
                  </View>
                  <Text style={styles.confidenceText}>
                    Confidence {(question.confidence * 100).toFixed(0)}%
                  </Text>
                </View>
                <Text style={styles.dateText}>{formatDate(question.createdAt)}</Text>
              </View>
            ))
          )}
        </ScrollView>
      </View>

      <ConfirmDialog
        visible={!!confirmTarget}
        title="Delete Question"
        description="Remove this unanswered question from the review list? This can't be undone."
        confirmText="Delete"
        cancelText="Cancel"
        destructive
        loading={!!deletingId}
        onConfirm={confirmDeleteQuestion}
        onCancel={() => setConfirmTarget(null)}
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
  helperText: {
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  clusterSection: {
    marginBottom: 18,
  },
  clusterSectionTitle: {
    color: c.primary,
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 4,
  },
  clusterSectionHint: {
    color: c.textMuted,
    fontSize: 12.5,
    lineHeight: 18,
    marginBottom: 12,
  },
  clusterCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.accent,
    padding: 14,
    marginBottom: 12,
  },
  clusterCountBadge: {
    alignSelf: "flex-start",
    backgroundColor: c.accent,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
  },
  clusterCountText: {
    color: c.textPrimary,
    fontSize: 11,
    fontWeight: "800",
  },
  clusterPrompt: {
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 21,
    marginBottom: 10,
  },
  clusterTagsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 12,
  },
  clusterTagChip: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  clusterTagText: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: "700",
  },
  clusterAddButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: c.primary,
    borderRadius: 12,
    paddingVertical: 9,
  },
  clusterAddButtonText: {
    color: c.surface,
    fontSize: 13,
    fontWeight: "800",
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
  questionCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 14,
    marginBottom: 12,
  },
  questionTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  deleteIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fbeaea",
  },
  promptText: {
    flex: 1,
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 21,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
  },
  intentBadge: {
    backgroundColor: c.primary,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  intentBadgeText: {
    color: c.surface,
    fontSize: 11,
    fontWeight: "800",
  },
  confidenceText: {
    color: c.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  dateText: {
    color: c.accent,
    marginTop: 8,
    fontSize: 12,
    fontWeight: "600",
  },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

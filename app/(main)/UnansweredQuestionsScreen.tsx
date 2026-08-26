import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { collection, onSnapshot, orderBy, query, Timestamp } from "firebase/firestore";
import React, { useEffect, useState } from "react";
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
import { isStaff, resolveUserRoleForAuthUser } from "@/utils/rbac";

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
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [questions, setQuestions] = useState<UnansweredQuestion[]>([]);

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
            <Ionicons name="arrow-back" size={22} color="#fffaf7" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Unanswered Questions</Text>
            <Text style={styles.headerSubtitle}>
              Real student questions Bonded AI couldn't answer
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

          {questions.length === 0 ? (
            <View style={styles.emptyCard}>
              <Ionicons name="checkmark-circle-outline" size={42} color="#c59a8a" />
              <Text style={styles.emptyTitle}>Nothing unanswered</Text>
              <Text style={styles.emptyText}>
                Bonded AI hasn't logged any unanswered student questions yet.
              </Text>
            </View>
          ) : (
            questions.map((question) => (
              <View key={question.id} style={styles.questionCard}>
                <Text style={styles.promptText}>{question.prompt}</Text>
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
  questionCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ead7cf",
    padding: 14,
    marginBottom: 12,
  },
  promptText: {
    color: "#4d1b17",
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
    backgroundColor: "#5f0909",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  intentBadgeText: {
    color: "#fffaf7",
    fontSize: 11,
    fontWeight: "800",
  },
  confidenceText: {
    color: "#9b766c",
    fontSize: 12,
    fontWeight: "600",
  },
  dateText: {
    color: "#c07a34",
    marginTop: 8,
    fontSize: 12,
    fontWeight: "600",
  },
});

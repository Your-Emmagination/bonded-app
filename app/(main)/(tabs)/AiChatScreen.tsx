// app/(main)/(tabs)/AiChatScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";
import { AI_ASSISTANT_NAME } from "@/utils/aiAssistant";
import { requestNonGenerativeChatbotReply } from "@/utils/nonGenerativeChatbot";
import { useNetworkStatus } from "@/utils/networkUtils";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import ConfirmDialog from "../components/ConfirmDialog";

type ChatRole = "user" | "assistant";
type ChatFeedback = "up" | "down";

type ChatMessage = {
  id: string;
  text: string;
  role: ChatRole;
  createdAt?: any;
  intent?: string | null;
  confidence?: number | null;
  feedback?: ChatFeedback | null;
};

function getTimeAgo(timestamp: any, nowMs = Date.now()) {
  if (!timestamp?.toDate) return "";
  const now = new Date(nowMs);
  const createdAt = timestamp.toDate();
  const diffMs = now.getTime() - createdAt.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);

  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHour < 24) return `${diffHour}h`;
  return createdAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const GREETING_TEXT =
  "Hello! I'm Bonded AI. I can help with BondED campus information, upcoming events, academic programs, date/time, and basic calculations.";

const SUGGESTED_QUESTIONS = [
  "What programs are offered?",
  "What events are coming up?",
  "What's my student ID?",
  "Help",
];

const FALLBACK_REPLY_TEXT =
  "Sorry, I ran into a problem answering that. Please try again.";

function ChatBubble({
  item,
  nowMs,
  onFeedback,
}: {
  item: ChatMessage;
  nowMs: number;
  onFeedback: (messageId: string, feedback: ChatFeedback) => void;
}) {
  const isOwnMessage = item.role === "user";

  return (
    <View
      style={[
        styles.messageRow,
        isOwnMessage ? styles.messageRowOwn : styles.messageRowOther,
      ]}
    >
      {!isOwnMessage && (
        <View style={styles.avatar}>
          <Ionicons name="sparkles" size={15} color="#5f0909" />
        </View>
      )}
      <View style={styles.messageContentWrap}>
        <View
          style={[
            styles.messageBubble,
            isOwnMessage && styles.messageBubbleOwn,
          ]}
        >
          {!isOwnMessage && (
            <Text style={styles.messageAuthor}>{AI_ASSISTANT_NAME}</Text>
          )}
          <Text
            style={[styles.messageText, isOwnMessage && styles.messageTextOwn]}
          >
            {item.text}
          </Text>
        </View>

        <View
          style={[
            styles.messageFooter,
            isOwnMessage && styles.messageFooterOwn,
          ]}
        >
          <Text style={styles.messageMeta}>{getTimeAgo(item.createdAt, nowMs)}</Text>

          {!isOwnMessage && (
            <View style={styles.feedbackRow}>
              <TouchableOpacity
                onPress={() => onFeedback(item.id, "up")}
                style={styles.feedbackButton}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons
                  name={item.feedback === "up" ? "thumbs-up" : "thumbs-up-outline"}
                  size={14}
                  color={item.feedback === "up" ? "#e0a53d" : "#9b766c"}
                />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onFeedback(item.id, "down")}
                style={styles.feedbackButton}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons
                  name={item.feedback === "down" ? "thumbs-down" : "thumbs-down-outline"}
                  size={14}
                  color={item.feedback === "down" ? "#e0a53d" : "#9b766c"}
                />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

function TypingBubble() {
  return (
    <View style={[styles.messageRow, styles.messageRowOther]}>
      <View style={styles.avatar}>
        <Ionicons name="sparkles" size={15} color="#5f0909" />
      </View>
      <View style={styles.messageContentWrap}>
        <View style={styles.messageBubble}>
          <Text style={styles.messageAuthor}>{AI_ASSISTANT_NAME}</Text>
          <View style={styles.typingRow}>
            <ActivityIndicator size="small" color="#8f3a2b" />
            <Text style={styles.typingText}>Thinking...</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function EmptyState() {
  return (
    <View style={styles.emptyState}>
      <View style={styles.avatar}>
        <Ionicons name="sparkles" size={15} color="#5f0909" />
      </View>
      <View style={styles.messageContentWrap}>
        <View style={styles.messageBubble}>
          <Text style={styles.messageAuthor}>{AI_ASSISTANT_NAME}</Text>
          <Text style={styles.messageText}>{GREETING_TEXT}</Text>
        </View>
      </View>
    </View>
  );
}

function SuggestionsBar({
  onSelect,
}: {
  onSelect: (question: string) => void;
}) {
  return (
    <View style={styles.suggestionsBar}>
      <Text style={styles.suggestionsBarLabel}>Try asking</Text>
      <View style={styles.suggestionsWrap}>
        {SUGGESTED_QUESTIONS.map((question) => (
          <TouchableOpacity
            key={question}
            style={styles.suggestionChip}
            onPress={() => onSelect(question)}
            activeOpacity={0.8}
          >
            <Text style={styles.suggestionChipText}>{question}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function AiChatScreen() {
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClearVisible, setConfirmClearVisible] = useState(false);
  const hasInitializedSuggestions = useRef(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const nowMs = useRelativeTimeNow();
  const { isOffline } = useNetworkStatus();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setMessages([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const messagesQuery = query(
      collection(db, "aiDirectMessages", user.uid, "messages"),
      orderBy("createdAt", "asc"),
    );

    const unsubscribe = onSnapshot(
      messagesQuery,
      (snapshot) => {
        setMessages(
          snapshot.docs.map(
            (item) => ({ id: item.id, ...item.data() }) as ChatMessage,
          ),
        );
        setLoading(false);
      },
      (error) => {
        console.error("Error loading Bonded AI chat history:", error);
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [user?.uid]);

  useEffect(() => {
    if (!messages.length) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages.length, sending]);

  useEffect(() => {
    if (loading || hasInitializedSuggestions.current) return;
    hasInitializedSuggestions.current = true;
    // Auto-open only for a brand-new user with no prior history — returning
    // users already know how to chat, so don't clutter their screen every time.
    setSuggestionsOpen(messages.length === 0);
  }, [loading, messages.length]);

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      const userId = user?.uid;
      if (!text || !userId || sending) return;

      setInputText("");
      setSuggestionsOpen(false);
      setSending(true);
      try {
        await addDoc(collection(db, "aiDirectMessages", userId, "messages"), {
          text,
          role: "user",
          createdAt: serverTimestamp(),
          intent: null,
          confidence: null,
        });

        const result = await requestNonGenerativeChatbotReply(text);

        await addDoc(collection(db, "aiDirectMessages", userId, "messages"), {
          text: result.reply,
          role: "assistant",
          createdAt: serverTimestamp(),
          intent: result.intent,
          confidence: result.confidence,
        });
      } catch (error) {
        console.error("Error getting Bonded AI reply:", error);
        await addDoc(collection(db, "aiDirectMessages", userId, "messages"), {
          text: FALLBACK_REPLY_TEXT,
          role: "assistant",
          createdAt: serverTimestamp(),
          intent: null,
          confidence: null,
        }).catch(() => null);
      } finally {
        setSending(false);
      }
    },
    [sending, user?.uid],
  );

  const handleFeedback = useCallback(
    (messageId: string, feedback: ChatFeedback) => {
      const userId = user?.uid;
      if (!userId) return;
      const message = messages.find((item) => item.id === messageId);
      const nextFeedback = message?.feedback === feedback ? null : feedback;
      updateDoc(doc(db, "aiDirectMessages", userId, "messages", messageId), {
        feedback: nextFeedback,
      }).catch((error) => {
        console.error("Error saving Bonded AI feedback:", error);
      });
    },
    [messages, user?.uid],
  );

  const clearConversation = useCallback(async () => {
    const userId = user?.uid;
    if (!userId) return;

    setClearing(true);
    try {
      const snapshot = await getDocs(
        collection(db, "aiDirectMessages", userId, "messages"),
      );
      const batch = writeBatch(db);
      snapshot.docs.forEach((item) => batch.delete(item.ref));
      await batch.commit();
      setSuggestionsOpen(true);
    } catch (error) {
      console.error("Error clearing Bonded AI chat history:", error);
    } finally {
      setClearing(false);
      setConfirmClearVisible(false);
    }
  }, [user?.uid]);

  const canSend = !!inputText.trim() && !sending && !!user?.uid;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.headerAvatar}>
          <Ionicons name="sparkles" size={18} color="#e0a53d" />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle}>{AI_ASSISTANT_NAME}</Text>
          <Text style={styles.headerSubtitle}>Your private BondED assistant</Text>
        </View>
        {messages.length > 0 && (
          <TouchableOpacity
            onPress={() => setConfirmClearVisible(true)}
            style={styles.headerActionButton}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="trash-outline" size={19} color="#e7cdbf" />
          </TouchableOpacity>
        )}
      </View>

      {isOffline && (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline-outline" size={14} color="#7d3b30" />
          <Text style={styles.offlineBannerText}>
            You&apos;re offline — messages will send once you&apos;re back online.
          </Text>
        </View>
      )}

      <KeyboardAvoidingView
        style={styles.flexFill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {loading || !user ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color="#e0a53d" />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <ChatBubble item={item} nowMs={nowMs} onFeedback={handleFeedback} />
            )}
            contentContainerStyle={
              messages.length ? styles.listContent : styles.emptyListContent
            }
            ListEmptyComponent={<EmptyState />}
            ListFooterComponent={sending ? <TypingBubble /> : null}
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: true })
            }
          />
        )}

        {suggestionsOpen && <SuggestionsBar onSelect={sendMessage} />}

        <View style={styles.composer}>
          <TouchableOpacity
            onPress={() => setSuggestionsOpen((open) => !open)}
            style={[
              styles.suggestionsToggle,
              suggestionsOpen && styles.suggestionsToggleActive,
            ]}
          >
            <Ionicons
              name={suggestionsOpen ? "bulb" : "bulb-outline"}
              size={18}
              color={suggestionsOpen ? "#fff" : "#8f3a2b"}
            />
          </TouchableOpacity>
          <TextInput
            value={inputText}
            onChangeText={setInputText}
            placeholder={`Message ${AI_ASSISTANT_NAME}...`}
            placeholderTextColor="#9b766c"
            style={styles.input}
            multiline
            editable={!!user}
            onSubmitEditing={() => sendMessage(inputText)}
          />
          <TouchableOpacity
            onPress={() => sendMessage(inputText)}
            disabled={!canSend}
            style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons
                name="send"
                size={16}
                color={canSend ? "#fff" : "#9b766c"}
              />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={confirmClearVisible}
        title="Clear conversation?"
        description="This deletes your entire chat history with Bonded AI. This can't be undone."
        confirmText="Clear"
        destructive
        loading={clearing}
        onConfirm={clearConversation}
        onCancel={() => setConfirmClearVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#5f0909",
  },
  flexFill: {
    flex: 1,
    backgroundColor: "#f6f1ed",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    backgroundColor: "#5f0909",
    borderBottomWidth: 1,
    borderBottomColor: "#7f2220",
  },
  headerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(224, 165, 61, 0.18)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#e0a53d",
  },
  headerCopy: {
    flex: 1,
  },
  headerTitle: {
    color: "#fffaf7",
    fontSize: 17,
    fontWeight: "800",
  },
  headerSubtitle: {
    color: "#e7cdbf",
    fontSize: 12,
    marginTop: 2,
  },
  headerActionButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "#f7ddd7",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(95,9,9,0.12)",
  },
  offlineBannerText: {
    flex: 1,
    color: "#7d3b30",
    fontSize: 12,
    fontWeight: "600",
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  emptyListContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  emptyState: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  messageRow: {
    marginBottom: 14,
    flexDirection: "row",
    alignItems: "flex-end",
  },
  messageRowOwn: {
    justifyContent: "flex-end",
  },
  messageRowOther: {
    justifyContent: "flex-start",
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ead7cf",
    marginRight: 8,
  },
  messageContentWrap: {
    maxWidth: "78%",
  },
  messageBubble: {
    backgroundColor: "#fffaf7",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#ead7cf",
  },
  messageBubbleOwn: {
    backgroundColor: "#5f0909",
    borderColor: "transparent",
    borderBottomRightRadius: 8,
  },
  messageAuthor: {
    color: "#8f3a2b",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
  },
  messageText: {
    color: "#4d1b17",
    fontSize: 15,
    lineHeight: 21,
  },
  messageTextOwn: {
    color: "#fffaf7",
  },
  messageFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  messageFooterOwn: {
    justifyContent: "flex-end",
  },
  messageMeta: {
    color: "#9b766c",
    fontSize: 11,
  },
  feedbackRow: {
    flexDirection: "row",
    gap: 10,
  },
  feedbackButton: {
    padding: 2,
  },
  typingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  typingText: {
    color: "#7d3b30",
    fontSize: 13,
    fontWeight: "600",
  },
  suggestionsBar: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
    backgroundColor: "#f6f1ed",
    borderTopWidth: 1,
    borderTopColor: "#ead7cf",
  },
  suggestionsBarLabel: {
    color: "#9b766c",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  suggestionsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  suggestionChip: {
    backgroundColor: "#fff8f4",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#e0a53d",
  },
  suggestionChipText: {
    color: "#8f3a2b",
    fontSize: 12.5,
    fontWeight: "600",
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 96,
    backgroundColor: "#f6f1ed",
    borderTopWidth: 1,
    borderTopColor: "#ead7cf",
  },
  suggestionsToggle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#fff8f4",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e0a53d",
  },
  suggestionsToggleActive: {
    backgroundColor: "#e0a53d",
  },
  input: {
    flex: 1,
    color: "#4d1b17",
    fontSize: 14.5,
    maxHeight: 100,
    minHeight: 40,
    paddingTop: 10,
    paddingBottom: 10,
    paddingHorizontal: 14,
    lineHeight: 20,
    backgroundColor: "#fffaf7",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(95,9,9,0.16)",
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#5f0909",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e0a53d",
  },
  sendButtonDisabled: {
    backgroundColor: "#f0d2c2",
    borderColor: "#f0d2c2",
  },
});

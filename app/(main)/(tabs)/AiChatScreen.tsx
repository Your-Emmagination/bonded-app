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
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import {
  ActivityIndicator,
  Animated,
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
import {
  requestNonGenerativeChatbotReply,
  type ChatbotIntent,
} from "@/utils/nonGenerativeChatbot";
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

function FadeSlideIn({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: any;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [progress]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [8, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

function TypingDots() {
  const dots = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;

  useEffect(() => {
    const loops = dots.map((dot, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 140),
          Animated.timing(dot, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0, duration: 320, useNativeDriver: true }),
          Animated.delay((dots.length - 1 - index) * 140),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [dots]);

  return (
    <View style={styles.typingDotsRow}>
      {dots.map((dot, index) => (
        <Animated.View
          key={index}
          style={[
            styles.typingDot,
            {
              opacity: dot.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
              transform: [
                {
                  translateY: dot.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }),
                },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

/**
 * Bold-only inline markdown for assistant replies: splits on **fact**
 * segments so the specific piece of data answering the question can be
 * highlighted in maroon, matching the "important part is bold" pattern
 * used by chat assistants. No external markdown library needed.
 */
function FormattedMessageText({ text, style }: { text: string; style?: any }) {
  const segments = React.useMemo(() => {
    const pattern = /\*\*(.+?)\*\*/g;
    const parts: { text: string; bold: boolean }[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: text.slice(lastIndex, match.index), bold: false });
      }
      parts.push({ text: match[1], bold: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push({ text: text.slice(lastIndex), bold: false });
    }
    return parts;
  }, [text]);

  return (
    <Text style={style}>
      {segments.map((segment, index) =>
        segment.bold ? (
          <Text key={index} style={styles.messageTextBold}>
            {segment.text}
          </Text>
        ) : (
          <Text key={index}>{segment.text}</Text>
        ),
      )}
    </Text>
  );
}

/**
 * Owns its own 30s tick (via useRelativeTimeNow) so only this small label
 * re-renders as time passes, instead of the parent AiChatScreen re-rendering
 * on a timer and forcing every mounted ChatBubble to re-render with it.
 */
const TimeAgoText = React.memo(function TimeAgoText({ createdAt }: { createdAt: any }) {
  const nowMs = useRelativeTimeNow();
  return <Text style={styles.messageMeta}>{getTimeAgo(createdAt, nowMs)}</Text>;
});

const ChatBubble = React.memo(function ChatBubble({
  item,
  onFeedback,
}: {
  item: ChatMessage;
  onFeedback: (messageId: string, feedback: ChatFeedback | null) => void;
}) {
  const isOwnMessage = item.role === "user";

  return (
    <FadeSlideIn
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
          {isOwnMessage ? (
            <Text style={[styles.messageText, styles.messageTextOwn]}>
              {item.text}
            </Text>
          ) : (
            <FormattedMessageText text={item.text} style={styles.messageText} />
          )}
        </View>

        <View
          style={[
            styles.messageFooter,
            isOwnMessage && styles.messageFooterOwn,
          ]}
        >
          <TimeAgoText createdAt={item.createdAt} />

          {!isOwnMessage && (
            <View style={styles.feedbackRow}>
              <TouchableOpacity
                onPress={() => onFeedback(item.id, item.feedback === "up" ? null : "up")}
                style={[
                  styles.feedbackButton,
                  item.feedback !== "up" && styles.feedbackButtonInactive,
                ]}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons
                  name={item.feedback === "up" ? "thumbs-up" : "thumbs-up-outline"}
                  size={14}
                  color={item.feedback === "up" ? "#e0a53d" : "#9b766c"}
                />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onFeedback(item.id, item.feedback === "down" ? null : "down")}
                style={[
                  styles.feedbackButton,
                  item.feedback !== "down" && styles.feedbackButtonInactive,
                ]}
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
    </FadeSlideIn>
  );
});

function TypingBubble() {
  return (
    <FadeSlideIn style={[styles.messageRow, styles.messageRowOther]}>
      <View style={styles.avatar}>
        <Ionicons name="sparkles" size={15} color="#5f0909" />
      </View>
      <View style={styles.messageContentWrap}>
        <View style={styles.messageBubble}>
          <Text style={styles.messageAuthor}>{AI_ASSISTANT_NAME}</Text>
          <TypingDots />
        </View>
      </View>
    </FadeSlideIn>
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
  const { isOffline } = useNetworkStatus();
  // Whether the reader is at (or near) the bottom of the list — used so a
  // new message only pulls the view down when they haven't scrolled away to
  // read older history. Defaults true so a first-time load still lands at
  // the bottom.
  const isNearBottomRef = useRef(true);
  // Set once the list has done its one-time instant jump to the latest
  // message after loading; resets whenever the signed-in user changes.
  const hasJumpedToLatestRef = useRef(false);
  // Long histories can take several layout passes before FlatList knows its
  // true content height. Keep the initial "open at latest" request pending
  // until the list actually reaches the bottom. A brand-new/first chat does
  // not use this path.
  const pendingInitialBottomScrollRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  // Reuses the previous ChatMessage object for a doc whose relevant fields
  // haven't changed, instead of remapping every doc into a brand-new object
  // on every snapshot. Without this, React.memo on ChatBubble can never
  // bail out — a new message (or a feedback toggle on any one message)
  // would otherwise give every row a fresh `item` reference and force the
  // whole list to re-render.
  const messagesCacheRef = useRef<Map<string, ChatMessage>>(new Map());

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return unsubscribe;
  }, []);

  useEffect(() => {
    hasJumpedToLatestRef.current = false;
    pendingInitialBottomScrollRef.current = false;
    previousMessageCountRef.current = 0;
    isNearBottomRef.current = true;
    messagesCacheRef.current = new Map();

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
        const cache = messagesCacheRef.current;
        const nextMessages = snapshot.docs.map((docSnapshot) => {
          const data = docSnapshot.data() as Omit<ChatMessage, "id">;
          const cached = cache.get(docSnapshot.id);
          // createdAt is set once at write time and never updated, so it's
          // safe to skip comparing it here — comparing it would always miss
          // anyway, since Firestore hands back a new Timestamp instance on
          // every read even when the underlying value hasn't changed.
          const feedback = data.feedback ?? null;
          if (
            cached &&
            cached.text === data.text &&
            cached.role === data.role &&
            cached.feedback === feedback &&
            cached.intent === (data.intent ?? null) &&
            cached.confidence === (data.confidence ?? null)
          ) {
            return cached;
          }

          const message: ChatMessage = { id: docSnapshot.id, ...data };
          cache.set(docSnapshot.id, message);
          return message;
        });

        const currentIds = new Set(nextMessages.map((message) => message.id));
        for (const id of cache.keys()) {
          if (!currentIds.has(id)) cache.delete(id);
        }

        // Only existing conversations need an initial bottom jump.
        // Empty and one-message first-chat states keep their current behavior.
        if (!hasJumpedToLatestRef.current && nextMessages.length > 1) {
          pendingInitialBottomScrollRef.current = true;
        }

        setMessages(nextMessages);
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
    const previousCount = previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;
    if (!messages.length) return;

    // Existing chat history: request an instant jump to the latest message.
    // For long histories this first call may happen before FlatList finishes
    // measuring, so pendingInitialBottomScrollRef stays true and layout/content
    // callbacks below repeat the instant jump until the real bottom is reached.
    // A first/brand-new chat (0 or 1 message) is left unchanged.
    if (!hasJumpedToLatestRef.current) {
      hasJumpedToLatestRef.current = true;

      if (messages.length > 1) {
        pendingInitialBottomScrollRef.current = true;
        requestAnimationFrame(() => {
          listRef.current?.scrollToEnd({ animated: false });
        });
      }
      return;
    }

    // Only auto-scroll for an actual new message, and only when the reader
    // was already near the bottom (or it's their own message) — otherwise
    // this would yank someone back down while they're scrolled up reading
    // older history, which is what happened when this ran on every render.
    const gotNewMessage = messages.length > previousCount;
    const lastMessage = messages[messages.length - 1];
    const shouldAutoScroll =
      gotNewMessage && (isNearBottomRef.current || lastMessage?.role === "user");

    if (shouldAutoScroll) {
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });
    }
  }, [messages]);

  useEffect(() => {
    if (!sending) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [sending]);

  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height;
      isNearBottomRef.current = distanceFromBottom < 120;

      if (
        pendingInitialBottomScrollRef.current &&
        distanceFromBottom <= 8
      ) {
        pendingInitialBottomScrollRef.current = false;
      }
    },
    [],
  );

  // FlatList measures long/wrapping messages progressively, so the content
  // height right after the initial scrollToEnd can still grow afterward —
  // without this, the list can settle partway up instead of at the true
  // bottom on a first load with long AI replies. Gating on isNearBottomRef
  // keeps this from re-snapping someone who has deliberately scrolled up.
  const handleContentSizeChange = useCallback(() => {
    if (pendingInitialBottomScrollRef.current) {
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }

    if (!isNearBottomRef.current) return;
    listRef.current?.scrollToEnd({ animated: false });
  }, []);

  const handleListLayout = useCallback(() => {
    if (!pendingInitialBottomScrollRef.current) return;

    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: false });
    });
  }, []);

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

      // Conversation memory: if the most recent assistant reply in THIS
      // chat answered a filterable intent (programs/events/staff), a short
      // follow-up like "what about BSTM?" can reuse that same intent's
      // answer function instead of getting reclassified from scratch. Only
      // looks at already-loaded local state — nothing extra is persisted.
      const previousAssistantMessage = [...messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.intent);
      const previousIntent = (previousAssistantMessage?.intent || undefined) as
        | ChatbotIntent
        | undefined;

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

        const result = await requestNonGenerativeChatbotReply(text, { previousIntent });

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
    [sending, user?.uid, messages],
  );

  const handleFeedback = useCallback(
    (messageId: string, nextFeedback: ChatFeedback | null) => {
      const userId = user?.uid;
      if (!userId) return;
      updateDoc(doc(db, "aiDirectMessages", userId, "messages", messageId), {
        feedback: nextFeedback,
      }).catch((error) => {
        console.error("Error saving Bonded AI feedback:", error);
      });
    },
    [user?.uid],
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

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <ChatBubble item={item} onFeedback={handleFeedback} />
    ),
    [handleFeedback],
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.headerAvatar}>
          <Ionicons name="sparkles" size={18} color="#e0a53d" />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle}>{AI_ASSISTANT_NAME}</Text>
          <Text style={styles.headerSubtitle}>Your BondED assistant</Text>
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
            renderItem={renderItem}
            contentContainerStyle={
              messages.length ? styles.listContent : styles.emptyListContent
            }
            ListEmptyComponent={<EmptyState />}
            ListFooterComponent={sending ? <TypingBubble /> : null}
            onScroll={handleListScroll}
            scrollEventThrottle={100}
            onLayout={handleListLayout}
            onContentSizeChange={handleContentSizeChange}
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
    paddingHorizontal: 15,
    paddingVertical: 13,
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
    marginBottom: 5,
  },
  messageText: {
    color: "#4d1b17",
    fontSize: 15,
    lineHeight: 22.5,
  },
  messageTextOwn: {
    color: "#fffaf7",
  },
  messageTextBold: {
    fontWeight: "700",
    color: "#5f0909",
  },
  messageFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
    paddingHorizontal: 4,
  },
  messageFooterOwn: {
    justifyContent: "flex-end",
  },
  messageMeta: {
    color: "#b09188",
    fontSize: 11,
  },
  feedbackRow: {
    flexDirection: "row",
    gap: 12,
  },
  feedbackButton: {
    padding: 3,
  },
  feedbackButtonInactive: {
    opacity: 0.6,
  },
  typingDotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 3,
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#8f3a2b",
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
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 38,
    justifyContent: "center",
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

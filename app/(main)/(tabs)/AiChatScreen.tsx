// app/(main)/(tabs)/AiChatScreen.tsx
import { AI_ASSISTANT_NAME } from "@/utils/aiAssistant";
import { useNetworkStatus } from "@/utils/networkUtils";
import { requestNonGenerativeChatbotReply } from "@/utils/nonGenerativeChatbot";
import {
    getCachedAiConversations,
    getCachedAiMessages,
    saveCachedAiConversations,
    saveCachedAiMessages,
} from "@/utils/offlineStorage";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { subscribeTabScrollToTop } from "@/utils/tabScrollEvents";
import { Ionicons } from "@expo/vector-icons";
import { onAuthStateChanged, User } from "firebase/auth";
import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    updateDoc,
    writeBatch,
} from "firebase/firestore";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import {
    ActivityIndicator,
    Animated,
    FlatList,
    Keyboard,
    Modal,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import ReanimatedAnimated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";
import ConfirmDialog from "../components/ConfirmDialog";
import { ChatSkeleton } from "../components/Skeleton";

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

type ConversationSummary = {
  id: string;
  title?: string | null;
  createdAt?: any;
  updatedAt?: any;
  origin?: string;
};

// How many past conversations to show per page in the history list, and how
// many more each "Load more" tap adds — same limit + "Load more" pattern the
// admin list screens use (ManageUsersScreen / ManageModerationScreen).
const HISTORY_PAGE_SIZE = 20;

// A conversation's display title: the first user message, whitespace-collapsed
// and truncated with an ellipsis. Same convention as notification previews
// (`sanitizePreview` in utils/notifications.ts), just a shorter cap.
function deriveConversationTitle(text: string, maxLength = 60): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

const CONVERSATION_FALLBACK_TITLE = "New conversation";

// Firestore writeBatch caps at 500 ops; stay well under it when copying or
// deleting a whole conversation's messages.
const BATCH_CHUNK = 400;

async function commitInChunks(
  refs: { ref: any }[],
  apply: (batch: ReturnType<typeof writeBatch>, ref: any) => void,
) {
  for (let start = 0; start < refs.length; start += BATCH_CHUNK) {
    const batch = writeBatch(db);
    for (const { ref } of refs.slice(start, start + BATCH_CHUNK)) {
      apply(batch, ref);
    }
    await batch.commit();
  }
}

/**
 * One-time move of a user's legacy single conversation
 * (`aiDirectMessages/{uid}/messages`) into the multi-conversation shape
 * (`aiConversations/{uid}/conversations/{id}/messages`).
 *
 * Design choice — copy, don't reference: the old flat collection had no
 * conversation document to hang a title/updatedAt off, and branching every
 * read/write on "is this the legacy path?" would spread through the whole
 * screen. Instead we copy the messages into a real conversation once.
 *
 * Safety:
 * - Idempotent. Messages are copied with their original document IDs, so a
 *   retry after a partial failure overwrites rather than duplicates.
 * - Non-destructive until proven complete. The old docs are only deleted
 *   after every message has been copied; if anything fails first, the throw
 *   propagates before the delete and `aiDirectMessages/{uid}/messages` stays
 *   fully intact for the next attempt.
 * - Marked done via `aiConversations/{uid}.legacyMigratedAt` so it runs at
 *   most once per user in the normal case (one getDoc on subsequent opens).
 */
async function migrateLegacyAiConversation(uid: string): Promise<void> {
  const markerRef = doc(db, "aiConversations", uid);
  const markerSnap = await getDoc(markerRef);
  if (markerSnap.exists() && markerSnap.data()?.legacyMigratedAt) return;

  const legacySnap = await getDocs(
    query(
      collection(db, "aiDirectMessages", uid, "messages"),
      orderBy("createdAt", "asc"),
    ),
  );

  if (!legacySnap.empty) {
    const legacyDocs = legacySnap.docs;
    const conversationRef = doc(
      collection(db, "aiConversations", uid, "conversations"),
    );
    const firstUserMessage = legacyDocs.find(
      (entry) => entry.data()?.role === "user",
    );
    const firstCreatedAt = legacyDocs[0].data()?.createdAt ?? serverTimestamp();
    const lastCreatedAt =
      legacyDocs[legacyDocs.length - 1].data()?.createdAt ?? serverTimestamp();

    await setDoc(conversationRef, {
      createdAt: firstCreatedAt,
      updatedAt: lastCreatedAt,
      title:
        deriveConversationTitle(String(firstUserMessage?.data()?.text ?? "")) ??
        null,
      origin: "legacy",
    });

    await commitInChunks(
      legacyDocs.map((entry) => ({ ref: entry })),
      (batch, entry) => {
        batch.set(
          doc(
            db,
            "aiConversations",
            uid,
            "conversations",
            conversationRef.id,
            "messages",
            entry.id,
          ),
          entry.data(),
        );
      },
    );

    // Copy is complete — now it's safe to remove the originals. Best effort:
    // orphaned legacy docs are harmless, and the marker below stops re-runs.
    try {
      await commitInChunks(
        legacyDocs.map((entry) => ({ ref: entry.ref })),
        (batch, ref) => batch.delete(ref),
      );
    } catch (cleanupError) {
      console.warn(
        "[AiChat] legacy cleanup failed (copied data is intact):",
        cleanupError,
      );
    }
  }

  await setDoc(markerRef, { legacyMigratedAt: serverTimestamp() }, { merge: true });
}

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
  "Hello! I'm B.E.A. I can help with BondED campus information, upcoming events, academic programs, and date/time.";

const SUGGESTED_QUESTIONS = [
  "What programs are offered?",
  "What events are coming up?",
  "What's my student ID?",
  "Help",
];

const FALLBACK_REPLY_TEXT =
  "Sorry, I ran into a problem answering that. Please try again.";

// Must match styles.composer's paddingBottom — the resting-state clearance
// for the bottom tab bar. Kept as a named constant so the keyboard-lift
// math below stays in sync with it instead of drifting out of sync.
const COMPOSER_RESTING_BOTTOM_PADDING = 96;

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

  // Multi-conversation state. `activeConversationId` null + `startingNewChat`
  // true = a fresh, not-yet-persisted chat (the conversation doc is created
  // lazily on the first message). null + false = nothing picked yet (initial
  // load will select the most recent conversation).
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [migrating, setMigrating] = useState(true);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const [startingNewChat, setStartingNewChat] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [confirmDeleteConversationId, setConfirmDeleteConversationId] = useState<
    string | null
  >(null);
  const [deletingConversationId, setDeletingConversationId] = useState<
    string | null
  >(null);
  // Latest values readable from inside the conversations snapshot without
  // making it a dependency (which would tear down / rebuild the listener).
  const activeConversationIdRef = useRef<string | null>(null);
  const startingNewChatRef = useRef(false);

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
  const userScrolledUpRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const previousMessageCountRef = useRef(0);
  // Reuses the previous ChatMessage object for a doc whose relevant fields
  // haven't changed, instead of remapping every doc into a brand-new object
  // on every snapshot. Without this, React.memo on ChatBubble can never
  // bail out — a new message (or a feedback toggle on any one message)
  // would otherwise give every row a fresh `item` reference and force the
  // whole list to re-render.
  const messagesCacheRef = useRef<Map<string, ChatMessage>>(new Map());
  // Composer lift while the keyboard is open. KeyboardAvoidingView was
  // removed because its `behavior` is `undefined` on Android (no adjustment
  // happens at all there), which is why the composer used to end up hidden
  // behind the keyboard. Reanimated runs the lift on the UI thread, so the
  // keyboard no longer has to wait for JavaScript work to finish.
  const composerBottom = useSharedValue(0);
  const composerAnimatedStyle = useAnimatedStyle(() => ({
    marginBottom: composerBottom.value,
  }));

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const scrollToEndIfNearBottom = () => {
      if (isNearBottomRef.current || !userScrolledUpRef.current) {
        requestAnimationFrame(() => {
          listRef.current?.scrollToEnd({ animated: true });
        });
      }
    };

    const showSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (event: KeyboardEvent) => {
        const keyboardHeight = event.endCoordinates?.height || 0;
        // The composer already carries COMPOSER_RESTING_BOTTOM_PADDING of
        // its own bottom padding (clearance for the tab bar when the
        // keyboard is closed) — subtract it here so the lift doesn't stack
        // on top of that and leave a gap above the keyboard.
        const lift = Math.max(0, keyboardHeight - COMPOSER_RESTING_BOTTOM_PADDING);
        composerBottom.value = withTiming(
          lift,
          { duration: Platform.OS === "ios" ? event.duration || 250 : 220 },
          (finished) => {
            if (finished) runOnJS(scrollToEndIfNearBottom)();
          },
        );
      },
    );

    const hideSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      (event: KeyboardEvent) => {
        composerBottom.value = withTiming(0, {
          duration: Platform.OS === "ios" ? event.duration || 250 : 180,
        });
      },
    );

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [composerBottom]);

  // Tapping the B.E.A. tab while it's already open jumps to the newest
  // message — a chat reads from the bottom, so "back to the top" would land
  // on the oldest message instead.
  useEffect(() => {
    const subscription = subscribeTabScrollToTop("AiChatScreen", () => {
      listRef.current?.scrollToEnd({ animated: true });
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    startingNewChatRef.current = startingNewChat;
  }, [startingNewChat]);

  // Per-user reset + one-time legacy migration.
  useEffect(() => {
    activeConversationIdRef.current = null;
    startingNewChatRef.current = false;
    setConversations([]);
    setActiveConversationId(null);
    setStartingNewChat(false);
    setHistoryLimit(HISTORY_PAGE_SIZE);
    setMessages([]);

    if (!user?.uid) {
      setMigrating(false);
      setConversationsLoading(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setMigrating(true);
    migrateLegacyAiConversation(user.uid)
      .catch((error) => {
        // Never blocks the screen. The legacy messages stay untouched in
        // aiDirectMessages/{uid}/messages, so nothing is lost — migration
        // just retries on the next open.
        console.error(
          "[AiChat] history migration failed; previous messages are preserved in aiDirectMessages:",
          error,
        );
      })
      .finally(() => {
        if (!cancelled) setMigrating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  // Live list of the user's conversations, most-recently-updated first,
  // bounded by historyLimit (grown by "Load more").
  useEffect(() => {
    if (!user?.uid) {
      setConversations([]);
      setConversationsLoading(false);
      return;
    }

    let isMounted = true;
    getCachedAiConversations<ConversationSummary>(user.uid).then((cached) => {
      if (isMounted && cached && cached.length > 0) {
        setConversations((prev) => (prev.length === 0 ? cached : prev));
        setConversationsLoading(false);
        if (
          !activeConversationIdRef.current &&
          !startingNewChatRef.current &&
          cached[0]?.id
        ) {
          setLoading(true);
          setActiveConversationId(cached[0].id);
        }
      }
    });

    // Only the first page gates the full-screen skeleton; a "Load more"
    // re-subscribe is covered by the in-modal `historyLoadingMore` spinner.
    if (historyLimit === HISTORY_PAGE_SIZE) {
      setConversationsLoading(true);
    }
    const conversationsQuery = query(
      collection(db, "aiConversations", user.uid, "conversations"),
      orderBy("updatedAt", "desc"),
      limit(historyLimit),
    );

    const unsubscribe = onSnapshot(
      conversationsQuery,
      (snapshot) => {
        const list: ConversationSummary[] = snapshot.docs.map((entry) => ({
          id: entry.id,
          ...(entry.data() as Omit<ConversationSummary, "id">),
        }));
        setConversations(list);
        setHistoryHasMore(snapshot.size === historyLimit);
        setConversationsLoading(false);
        setHistoryLoadingMore(false);
        saveCachedAiConversations(user.uid, list);

        // Pick the most recent conversation as active on first load. Never
        // override an explicit choice or a new-chat-in-progress.
        if (
          !activeConversationIdRef.current &&
          !startingNewChatRef.current &&
          list[0]?.id
        ) {
          setLoading(true);
          setActiveConversationId(list[0].id);
        }
      },
      (error) => {
        console.error("Error loading Bonded AI conversations:", error);
        setConversationsLoading(false);
        setHistoryLoadingMore(false);
      },
    );

    return unsubscribe;
    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [user?.uid, historyLimit]);

  // Reset the scroll/cache bookkeeping whenever the active conversation
  // (or user) changes — each conversation opens at its own latest message.
  useEffect(() => {
    hasJumpedToLatestRef.current = false;
    pendingInitialBottomScrollRef.current = false;
    previousMessageCountRef.current = 0;
    isNearBottomRef.current = true;
    userScrolledUpRef.current = false;
    setShowScrollToBottom(false);
    messagesCacheRef.current = new Map();

    const timer = setTimeout(() => {
      if (!userScrolledUpRef.current) {
        listRef.current?.scrollToEnd({ animated: false });
      }
      pendingInitialBottomScrollRef.current = false;
    }, 600);
    return () => clearTimeout(timer);
  }, [user?.uid, activeConversationId]);

  // Messages for the active conversation.
  useEffect(() => {
    if (!user?.uid || !activeConversationId) {
      setMessages([]);
      setLoading(false);
      return;
    }

    let isMounted = true;
    getCachedAiMessages<ChatMessage>(user.uid, activeConversationId).then((cached) => {
      if (isMounted && cached && cached.length > 0) {
        setMessages((prev) => (prev.length === 0 ? cached : prev));
        setLoading(false);
      }
    });

    setLoading(true);
    const messagesQuery = query(
      collection(
        db,
        "aiConversations",
        user.uid,
        "conversations",
        activeConversationId,
        "messages",
      ),
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
        saveCachedAiMessages(user.uid, activeConversationId, nextMessages);
      },
      (error) => {
        console.error("Error loading Bonded AI chat history:", error);
        setLoading(false);
      },
    );

    return unsubscribe;
    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [user?.uid, activeConversationId]);

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

    const gotNewMessage = messages.length > previousCount;
    const lastMessage = messages[messages.length - 1];
    const shouldAutoScroll =
      gotNewMessage && (!userScrolledUpRef.current || isNearBottomRef.current || lastMessage?.role === "user");

    if (shouldAutoScroll) {
      userScrolledUpRef.current = false;
      isNearBottomRef.current = true;
      setShowScrollToBottom(false);
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });
    }
  }, [messages]);

  const handleScrollBeginDrag = useCallback(() => {
    userScrolledUpRef.current = true;
    pendingInitialBottomScrollRef.current = false;
  }, []);

  const scrollToBottom = useCallback(() => {
    userScrolledUpRef.current = false;
    isNearBottomRef.current = true;
    setShowScrollToBottom(false);
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  useEffect(() => {
    if (!sending) return;
    userScrolledUpRef.current = false;
    isNearBottomRef.current = true;
    setShowScrollToBottom(false);
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [sending]);

  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height;

      const nearBottom = distanceFromBottom < 100;
      isNearBottomRef.current = nearBottom;

      if (nearBottom) {
        userScrolledUpRef.current = false;
        setShowScrollToBottom(false);
      } else if (distanceFromBottom > 200 && userScrolledUpRef.current) {
        setShowScrollToBottom(true);
      }
    },
    [],
  );

  // Like ChatGPT, Claude, and Gemini: follow expanding messages progressively
  // down as long as the user hasn't explicitly scrolled up to read earlier history.
  const handleContentSizeChange = useCallback(() => {
    if (pendingInitialBottomScrollRef.current) {
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }

    if (!userScrolledUpRef.current || sending) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [sending]);

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

  // Returns the id of the conversation to write into, creating it lazily on
  // the first message so "New Chat" never litters empty conversation docs.
  const ensureActiveConversation = useCallback(
    async (firstMessageText: string): Promise<string | null> => {
      const userId = user?.uid;
      if (!userId) return null;
      if (activeConversationIdRef.current) return activeConversationIdRef.current;

      const conversationRef = await addDoc(
        collection(db, "aiConversations", userId, "conversations"),
        {
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          title: deriveConversationTitle(firstMessageText),
        },
      );
      activeConversationIdRef.current = conversationRef.id;
      startingNewChatRef.current = false;
      setActiveConversationId(conversationRef.id);
      setStartingNewChat(false);
      return conversationRef.id;
    },
    [user?.uid],
  );

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      const userId = user?.uid;
      if (!text || !userId || sending) return;

      setInputText("");
      setSuggestionsOpen(false);
      setSending(true);
      userScrolledUpRef.current = false;
      isNearBottomRef.current = true;
      setShowScrollToBottom(false);
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });
      let conversationId: string | null = null;
      try {
        conversationId = await ensureActiveConversation(text);
        if (!conversationId) return;

        const messagesCollection = collection(
          db,
          "aiConversations",
          userId,
          "conversations",
          conversationId,
          "messages",
        );
        const conversationRef = doc(
          db,
          "aiConversations",
          userId,
          "conversations",
          conversationId,
        );

        await addDoc(messagesCollection, {
          text,
          role: "user",
          createdAt: serverTimestamp(),
          intent: null,
          confidence: null,
        });
        // Bump updatedAt so this conversation sorts to the top of history.
        await updateDoc(conversationRef, { updatedAt: serverTimestamp() });

        const result = await requestNonGenerativeChatbotReply(text);

        await addDoc(messagesCollection, {
          text: result.reply,
          role: "assistant",
          createdAt: serverTimestamp(),
          intent: result.intent,
          confidence: result.confidence,
        });
        await updateDoc(conversationRef, { updatedAt: serverTimestamp() });
      } catch (error) {
        console.error("Error getting Bonded AI reply:", error);
        if (conversationId) {
          await addDoc(
            collection(
              db,
              "aiConversations",
              userId,
              "conversations",
              conversationId,
              "messages",
            ),
            {
              text: FALLBACK_REPLY_TEXT,
              role: "assistant",
              createdAt: serverTimestamp(),
              intent: null,
              confidence: null,
            },
          ).catch(() => null);
        }
      } finally {
        setSending(false);
      }
    },
    [sending, user?.uid, ensureActiveConversation],
  );

  const handleFeedback = useCallback(
    (messageId: string, nextFeedback: ChatFeedback | null) => {
      const userId = user?.uid;
      if (!userId || !activeConversationId) return;
      updateDoc(
        doc(
          db,
          "aiConversations",
          userId,
          "conversations",
          activeConversationId,
          "messages",
          messageId,
        ),
        { feedback: nextFeedback },
      ).catch((error) => {
        console.error("Error saving Bonded AI feedback:", error);
      });
    },
    [user?.uid, activeConversationId],
  );

  const startNewChat = useCallback(() => {
    activeConversationIdRef.current = null;
    startingNewChatRef.current = true;
    setHistoryVisible(false);
    setActiveConversationId(null);
    setStartingNewChat(true);
    setMessages([]);
    setInputText("");
    setSending(false);
    setSuggestionsOpen(true);
    setLoading(false);
  }, []);

  const selectConversation = useCallback((conversationId: string) => {
    setHistoryVisible(false);
    if (conversationId === activeConversationIdRef.current) return;
    activeConversationIdRef.current = conversationId;
    startingNewChatRef.current = false;
    setStartingNewChat(false);
    setLoading(true);
    setActiveConversationId(conversationId);
  }, []);

  const loadMoreHistory = useCallback(() => {
    if (historyLoadingMore || !historyHasMore) return;
    setHistoryLoadingMore(true);
    setHistoryLimit((current) => current + HISTORY_PAGE_SIZE);
  }, [historyLoadingMore, historyHasMore]);

  // Wipes only the *current* conversation's messages. The conversation doc
  // (and every other conversation) is left intact.
  const clearConversation = useCallback(async () => {
    const userId = user?.uid;
    const conversationId = activeConversationId;
    if (!userId || !conversationId) return;

    setClearing(true);
    try {
      const snapshot = await getDocs(
        collection(
          db,
          "aiConversations",
          userId,
          "conversations",
          conversationId,
          "messages",
        ),
      );
      await commitInChunks(
        snapshot.docs.map((entry) => ({ ref: entry.ref })),
        (batch, ref) => batch.delete(ref),
      );
      setSuggestionsOpen(true);
    } catch (error) {
      console.error("Error clearing Bonded AI conversation:", error);
    } finally {
      setClearing(false);
      setConfirmClearVisible(false);
    }
  }, [user?.uid, activeConversationId]);

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      const userId = user?.uid;
      if (!userId) return;

      setDeletingConversationId(conversationId);
      try {
        const snapshot = await getDocs(
          collection(
            db,
            "aiConversations",
            userId,
            "conversations",
            conversationId,
            "messages",
          ),
        );
        await commitInChunks(
          snapshot.docs.map((entry) => ({ ref: entry.ref })),
          (batch, ref) => batch.delete(ref),
        );
        await deleteDoc(
          doc(db, "aiConversations", userId, "conversations", conversationId),
        );

        if (activeConversationIdRef.current === conversationId) {
          const nextConversation = conversations.find(
            (conversation) => conversation.id !== conversationId,
          );
          if (nextConversation) {
            activeConversationIdRef.current = nextConversation.id;
            startingNewChatRef.current = false;
            setStartingNewChat(false);
            setLoading(true);
            setActiveConversationId(nextConversation.id);
          } else {
            activeConversationIdRef.current = null;
            startingNewChatRef.current = true;
            setActiveConversationId(null);
            setStartingNewChat(true);
            setMessages([]);
            setLoading(false);
          }
        }
      } catch (error) {
        console.error("Error deleting Bonded AI conversation:", error);
      } finally {
        setDeletingConversationId(null);
        setConfirmDeleteConversationId(null);
      }
    },
    [user?.uid, conversations],
  );

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
        <View style={styles.headerActions}>
          {!!user && (
            <TouchableOpacity
              onPress={startNewChat}
              style={styles.headerActionButton}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="New chat"
            >
              <Ionicons name="create-outline" size={19} color="#e7cdbf" />
            </TouchableOpacity>
          )}
          {conversations.length > 0 && (
            <TouchableOpacity
              onPress={() => setHistoryVisible(true)}
              style={styles.headerActionButton}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Conversation history"
            >
              <Ionicons name="time-outline" size={19} color="#e7cdbf" />
            </TouchableOpacity>
          )}
          {messages.length > 0 && !!activeConversationId && (
            <TouchableOpacity
              onPress={() => setConfirmClearVisible(true)}
              style={styles.headerActionButton}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Clear this conversation"
            >
              <Ionicons name="trash-outline" size={19} color="#e7cdbf" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {isOffline && (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline-outline" size={14} color="#7d3b30" />
          <Text style={styles.offlineBannerText}>
            You&apos;re offline — messages will send once you&apos;re back online.
          </Text>
        </View>
      )}

      <View style={styles.flexFill}>
        {!user || ((migrating || conversationsLoading || loading) && !isOffline) ? (
          <ChatSkeleton count={6} />
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            // Virtualization tuning, consistent with the other message/
            // comment lists in the app.
            initialNumToRender={20}
            maxToRenderPerBatch={10}
            windowSize={11}
            removeClippedSubviews={Platform.OS === "android"}
            contentContainerStyle={
              messages.length ? styles.listContent : styles.emptyListContent
            }
            ListEmptyComponent={<EmptyState />}
            ListFooterComponent={sending ? <TypingBubble /> : null}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScroll={handleListScroll}
            scrollEventThrottle={100}
            onLayout={handleListLayout}
            onContentSizeChange={handleContentSizeChange}
          />
        )}

        {showScrollToBottom && (
          <TouchableOpacity
            style={styles.scrollToBottomBtn}
            onPress={scrollToBottom}
            activeOpacity={0.85}
            accessibilityLabel="Scroll to latest messages"
          >
            <Ionicons name="chevron-down" size={20} color="#fff" />
          </TouchableOpacity>
        )}

        <ReanimatedAnimated.View style={composerAnimatedStyle}>
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
        </ReanimatedAnimated.View>
      </View>

      <Modal
        visible={historyVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setHistoryVisible(false)}
      >
        <View style={styles.historyBackdrop}>
          <View style={styles.historyCard}>
            <View style={styles.historyHeader}>
              <Text style={styles.historyTitle}>Conversations</Text>
              <TouchableOpacity
                onPress={() => setHistoryVisible(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color="#7a3b2e" />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.historyNewButton}
              onPress={startNewChat}
              activeOpacity={0.85}
            >
              <Ionicons name="add" size={18} color="#5f0909" />
              <Text style={styles.historyNewButtonText}>New chat</Text>
            </TouchableOpacity>

            <FlatList
              data={conversations}
              keyExtractor={(item) => item.id}
              style={styles.historyList}
              contentContainerStyle={styles.historyListContent}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const isActive = item.id === activeConversationId;
                return (
                  <View
                    style={[
                      styles.historyRow,
                      isActive && styles.historyRowActive,
                    ]}
                  >
                    <TouchableOpacity
                      style={styles.historyRowMain}
                      onPress={() => selectConversation(item.id)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.historyRowTitle} numberOfLines={1}>
                        {item.title?.trim() || CONVERSATION_FALLBACK_TITLE}
                      </Text>
                      <Text style={styles.historyRowMeta}>
                        {getTimeAgo(item.updatedAt) || "New"}
                        {item.origin === "legacy" ? " · earlier chat" : ""}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.historyDeleteButton}
                      onPress={() => setConfirmDeleteConversationId(item.id)}
                      disabled={deletingConversationId === item.id}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityLabel="Delete conversation"
                    >
                      {deletingConversationId === item.id ? (
                        <ActivityIndicator size="small" color="#b3261e" />
                      ) : (
                        <Ionicons name="trash-outline" size={18} color="#b3261e" />
                      )}
                    </TouchableOpacity>
                  </View>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.historyEmptyText}>
                  No past conversations yet.
                </Text>
              }
              ListFooterComponent={
                historyHasMore ? (
                  <TouchableOpacity
                    style={styles.historyLoadMore}
                    onPress={loadMoreHistory}
                    disabled={historyLoadingMore}
                    activeOpacity={0.85}
                  >
                    {historyLoadingMore ? (
                      <ActivityIndicator size="small" color="#5f0909" />
                    ) : (
                      <Text style={styles.historyLoadMoreText}>Load more</Text>
                    )}
                  </TouchableOpacity>
                ) : null
              }
            />
          </View>
        </View>
      </Modal>

      <ConfirmDialog
        visible={confirmClearVisible}
        title="Clear this conversation?"
        description="This clears every message in the current conversation. Your other conversations aren't affected. This can't be undone."
        confirmText="Clear"
        destructive
        loading={clearing}
        onConfirm={clearConversation}
        onCancel={() => setConfirmClearVisible(false)}
      />

      <ConfirmDialog
        visible={!!confirmDeleteConversationId}
        title="Delete this conversation?"
        description="This permanently removes this conversation and all of its messages. Your other conversations aren't affected."
        confirmText="Delete"
        destructive
        loading={!!deletingConversationId}
        onConfirm={() => {
          if (confirmDeleteConversationId) {
            void deleteConversation(confirmDeleteConversationId);
          }
        }}
        onCancel={() => setConfirmDeleteConversationId(null)}
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
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
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
  scrollToBottomBtn: {
    position: "absolute",
    right: 16,
    bottom: 80,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#7a3b2e",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
    zIndex: 20,
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
  historyBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  historyCard: {
    backgroundColor: "#f6f1ed",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: "82%",
  },
  historyHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  historyTitle: {
    color: "#4d1b17",
    fontSize: 18,
    fontWeight: "900",
  },
  historyNewButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "#fff8f4",
    borderWidth: 1,
    borderColor: "#e0a53d",
  },
  historyNewButtonText: {
    color: "#5f0909",
    fontSize: 13.5,
    fontWeight: "800",
  },
  historyList: {
    flexGrow: 0,
  },
  historyListContent: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 8,
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fffaf7",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#ead7cf",
    paddingLeft: 14,
    paddingRight: 6,
    marginBottom: 8,
  },
  historyRowActive: {
    borderColor: "#e0a53d",
    backgroundColor: "#fff8f4",
  },
  historyRowMain: {
    flex: 1,
    paddingVertical: 12,
  },
  historyRowTitle: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "700",
  },
  historyRowMeta: {
    color: "#9b766c",
    fontSize: 11.5,
    marginTop: 3,
  },
  historyDeleteButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  historyEmptyText: {
    color: "#9b766c",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
  historyLoadMore: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    marginTop: 2,
    borderRadius: 12,
    backgroundColor: "#fff8f4",
    borderWidth: 1,
    borderColor: "#ead7cf",
  },
  historyLoadMoreText: {
    color: "#5f0909",
    fontSize: 13,
    fontWeight: "800",
  },
});

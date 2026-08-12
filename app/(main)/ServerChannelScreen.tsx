import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AVATAR_SIZE_SMALL, FEED_IMAGE_WIDTH, avatarThumb, feedImage } from "@/utils/cloudinaryImages";
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  Dimensions,
  FlatList,
  Image,
  Keyboard,
  KeyboardEvent,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import ReanimatedAnimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { auth, db } from "../../Firebase_configure";
import CommentComposer from "./components/CommentComposer";
import { createMentionNotifications, resolveMentionRecipientIds } from "@/utils/notifications";
import { useNetworkStatus } from "@/utils/networkUtils";
import { getUserData } from "@/utils/rbac";
import { requestServerDrawerReopen } from "@/utils/communityNavigation";
import { markCommunityChannelViewed } from "@/utils/communityUnread";
import { AI_ASSISTANT_ID, AI_ASSISTANT_NAME, isAiAssistantId } from "@/utils/aiAssistant";
import { getAiErrorMessage } from "@/utils/aiConfig";
import {
  AI_REQUEST_COOLDOWN_MS,
  getAiContextLimit,
  requestAiReplyFromWorker,
  reserveAiCooldown,
  type AiContextMessage,
} from "@/utils/aiWorker";
import {
  canViewModeratedContent,
  getModerationPreviewText,
  requestModerationDecision,
} from "@/utils/contentModeration";
import { resolveAvatarUri } from "@/utils/avatar";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import ExpandableText from "./components/ExpandableText";
import { useRelativeTimeNow } from "@/utils/relativeTime";

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get("window");

type TaggedUser = {
  id: string;
  name: string;
  studentID: string;
};

type ThreadMessage = {
  id: string;
  text: string;
  userId: string;
  realUserId?: string;
  username?: string;
  role?: string;
  profileImage?: string | null;
  profilePic?: string | null;
  isAnonymous?: boolean;
  files?: { url: string; mimeType: string; name?: string }[];
  link?: { url: string; title: string };
  taggedUsers?: TaggedUser[];
  createdAt?: any;
  serverId?: string | null;
  channelId?: string | null;
  aiAssistant?: boolean;
  aiSourceMessageId?: string | null;
  aiStatus?: string | null;
  moderationStatus?: string;
  moderationReasons?: string[];
};

type RouteParams = {
  serverId?: string | string[];
  channelId?: string | string[];
  serverName?: string | string[];
  channelLabel?: string | string[];
  serverAccent?: string | string[];
};

const getSingleParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const buildCurrentUserPreview = (authUser: User | null) => {
  if (!authUser) return null;

  const displayName = authUser.displayName?.trim() || "";
  const [firstName = "", ...restName] = displayName.split(/\s+/).filter(Boolean);
  const lastName = restName.join(" ");
  const emailFallback = authUser.email?.split("@")[0]?.trim() || "You";

  return {
    uid: authUser.uid,
    userId: authUser.uid,
    firstname: firstName || emailFallback,
    lastname: lastName,
    username: displayName || emailFallback,
    role: "student",
    profileImage: null,
    profilePic: null,
  };
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

const formatCooldownLabel = (remainingMs: number) => {
  const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
};

const summarizeThreadMessage = (message: Partial<ThreadMessage>) => {
  const parts: string[] = [];
  const text = message.text?.trim();
  if (text) parts.push(text);
  if (message.link?.url) {
    parts.push(`[shared a link: ${message.link.title || message.link.url}]`);
  }
  if (message.files?.length) {
    parts.push(
      `[shared ${message.files.length} attachment${message.files.length === 1 ? "" : "s"}]`,
    );
  }
  if (message.taggedUsers?.length) {
    parts.push(`Tagged users: ${message.taggedUsers.map((tag) => tag.name).join(", ")}`);
  }
  return parts.join("\n").trim() || "[empty message]";
};

const buildAiContextMessages = (
  threadMessages: ThreadMessage[],
  pendingMessage: Partial<ThreadMessage>,
) => {
  const recentMessages = [
    ...threadMessages.slice(-getAiContextLimit() + 1),
    {
      ...pendingMessage,
      id: "pending-ai-request",
    } as ThreadMessage,
  ];

  return recentMessages.map(
    (message): AiContextMessage => ({
      role: isAiAssistantId(message.realUserId || message.userId) ? "assistant" : "user",
      name: message.isAnonymous ? "Anonymous" : message.username || "User",
      content: summarizeThreadMessage(message),
    }),
  );
};

function MessageBubble({
  item,
  isOwnMessage,
  accent,
  onProfilePress,
  nowMs,
}: {
  item: ThreadMessage;
  isOwnMessage: boolean;
  accent: string;
  onProfilePress: (userId?: string, isAnonymous?: boolean) => void;
  nowMs: number;
}) {
  const imageFiles = (item.files || []).filter(
    (file) => file.mimeType.startsWith("image/") && !file.mimeType.includes("gif"),
  );
  const gifFiles = (item.files || []).filter((file) => file.mimeType.includes("gif"));
  const docs = (item.files || []).filter((file) => !file.mimeType.startsWith("image/"));
  const avatarUri = resolveAvatarUri(item);
  const bubbleStyle = isOwnMessage
    ? [styles.messageBubble, styles.messageBubbleOwn, { backgroundColor: accent }]
    : styles.messageBubble;

  return (
    <View
      style={[
        styles.messageRow,
        isOwnMessage ? styles.messageRowOwn : styles.messageRowOther,
      ]}
    >
      {!isOwnMessage && (
        <TouchableOpacity
          onPress={() => onProfilePress(item.realUserId || item.userId, item.isAnonymous)}
          disabled={item.isAnonymous}
          style={styles.avatarWrap}
        >
          <View style={styles.avatar}>
            {avatarUri ? (
              <Image source={{ uri: avatarThumb(avatarUri, AVATAR_SIZE_SMALL) }} style={styles.avatarImage} />
            ) : (
              <Text style={styles.avatarText}>
                {(item.username?.[0] || "A").toUpperCase()}
              </Text>
            )}
          </View>
        </TouchableOpacity>
      )}

      <View style={styles.messageContentWrap}>
        <View style={bubbleStyle}>
          {!isOwnMessage && (
            <Text style={styles.messageAuthor}>
              {item.isAnonymous ? "Anonymous" : item.username || "User"}
            </Text>
          )}
          {!!item.text && (
            <ExpandableText
              text={item.text}
              textStyle={[styles.messageText, isOwnMessage && styles.messageTextOwn]}
              collapsedLines={5}
              minLengthToToggle={220}
              buttonTextStyle={[
                styles.messageToggleText,
                isOwnMessage && styles.messageToggleTextOwn,
              ]}
            />
          )}

          {item.aiAssistant && item.aiStatus === "generating" && !item.text ? (
            <View style={styles.aiPendingRow}>
              <ActivityIndicator size="small" color={isOwnMessage ? "#fffaf7" : "#8f2117"} />
              <Text style={[styles.aiPendingText, isOwnMessage && styles.aiPendingTextOwn]}>
                Bonded AI is generating...
              </Text>
            </View>
          ) : null}

          {gifFiles.map((file) => (
            <Image key={file.url} source={{ uri: feedImage(file.url, FEED_IMAGE_WIDTH) }} style={styles.messageImage} />
          ))}

          {imageFiles.map((file) => (
            <Image key={file.url} source={{ uri: feedImage(file.url, FEED_IMAGE_WIDTH) }} style={styles.messageImage} />
          ))}

          {docs.map((file) => (
            <TouchableOpacity
              key={file.url}
              style={styles.fileChip}
              onPress={() => Linking.openURL(file.url).catch(() => null)}
              activeOpacity={0.8}
            >
              <Ionicons
                name={file.mimeType.includes("pdf") ? "document-text-outline" : "document-outline"}
                size={16}
                color={isOwnMessage ? "#fffaf7" : "#5f0909"}
              />
              <Text
                style={[styles.fileChipText, isOwnMessage && styles.fileChipTextOwn]}
                numberOfLines={1}
              >
                {file.name || "Attachment"}
              </Text>
            </TouchableOpacity>
          ))}

          {item.link && (
            <TouchableOpacity
              style={styles.linkCard}
              onPress={() => Linking.openURL(item.link?.url || "").catch(() => null)}
              activeOpacity={0.82}
            >
              <Ionicons
                name="link-outline"
                size={16}
                color={isOwnMessage ? "#fffaf7" : "#5f0909"}
              />
              <View style={{ flex: 1 }}>
                <Text
                  style={[styles.linkTitle, isOwnMessage && styles.linkTitleOwn]}
                  numberOfLines={1}
                >
                  {item.link.title || "Link"}
                </Text>
                <Text
                  style={[styles.linkUrl, isOwnMessage && styles.linkUrlOwn]}
                  numberOfLines={1}
                >
                  {item.link.url}
                </Text>
              </View>
            </TouchableOpacity>
          )}

          {!!item.taggedUsers?.length && (
            <View style={styles.tagRow}>
              <Ionicons
                name="people-outline"
                size={13}
                color={isOwnMessage ? "#fffaf7" : "#a86fff"}
              />
              <Text style={[styles.tagText, isOwnMessage && styles.tagTextOwn]}>
                with {item.taggedUsers.map((tag) => tag.name).join(", ")}
              </Text>
            </View>
          )}
        </View>

        <Text style={[styles.messageMeta, isOwnMessage && styles.messageMetaOwn]}>
          {getTimeAgo(item.createdAt, nowMs)}
        </Text>
      </View>
    </View>
  );
}

export default function ServerChannelScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { serverId, channelId, serverName, channelLabel, serverAccent } =
    useLocalSearchParams<RouteParams>();

  const resolvedServerId = getSingleParam(serverId) || null;
  const resolvedChannelId = getSingleParam(channelId) || null;
  const resolvedServerName = getSingleParam(serverName) || "Server";
  const resolvedChannelLabel = getSingleParam(channelLabel) || "general";
  const resolvedServerAccent = getSingleParam(serverAccent) || "#5f0909";
  const relativeTimeNow = useRelativeTimeNow();

  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [currentUserProfile, setCurrentUserProfile] = useState<any>(
    () => buildCurrentUserPreview(auth.currentUser),
  );
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const { isOffline } = useNetworkStatus();
  const listRef = useRef<FlatList<ThreadMessage>>(null);
  const composerBottom = useRef(new Animated.Value(0)).current;

  const translateY = useSharedValue(SCREEN_HEIGHT);
  const overlayOpacity = useSharedValue(0);

  const closeToDrawer = useCallback(() => {
    translateY.value = withTiming(SCREEN_HEIGHT, { duration: 240 });
    overlayOpacity.value = withTiming(0, { duration: 200 }, (finished) => {
      if (finished) {
        runOnJS(requestServerDrawerReopen)();
        runOnJS(router.back)();
      }
    });
  }, [router]);

  useEffect(() => {
    translateY.value = withTiming(0, { duration: 280 });
    overlayOpacity.value = withTiming(1, { duration: 220 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount, same as the original PanResponder-based version
  }, []);

  useEffect(() => {
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      closeToDrawer();
      return true;
    });
    return () => backHandler.remove();
  }, [closeToDrawer]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setCurrentUserProfile((currentProfile: any) => {
        if (!nextUser) return null;
        if (currentProfile?.uid === nextUser.uid) {
          return currentProfile;
        }
        return buildCurrentUserPreview(nextUser);
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user?.uid || isOffline) return;
    getUserData(user.uid)
      .then((profile) => {
        setCurrentUserProfile(
          profile
            ? {
                ...(buildCurrentUserPreview(user) || {}),
                ...profile,
                uid: user.uid,
                profilePic: profile.profileImage || null,
              }
            : buildCurrentUserPreview(user),
        );
      })
      .catch((error) => {
        console.error("Error fetching current user profile:", error);
      });
  }, [isOffline, user]);

  useEffect(() => {
    if (!resolvedServerId || !resolvedChannelId) return;

    const messagesQuery = query(
      collection(db, "communityThreadMessages"),
      orderBy("createdAt", "asc"),
    );

    const unsubscribe = onSnapshot(
      messagesQuery,
      (snapshot) => {
        const nextMessages = snapshot.docs
          .map(
            (item) =>
              ({
                id: item.id,
                ...item.data(),
              }) as ThreadMessage,
          )
          .filter(
            (item) =>
              item.serverId === resolvedServerId &&
              item.channelId === resolvedChannelId &&
              canViewModeratedContent({
                moderationStatus: item.moderationStatus,
                realUserId: item.realUserId,
                userId: item.userId,
                viewerUserId: user?.uid,
                viewerRole: currentUserProfile?.role,
              }),
          );
        setMessages(nextMessages);
        setLoading(false);
      },
      (error) => {
        console.error("Error loading thread messages:", error);
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [currentUserProfile?.role, resolvedChannelId, resolvedServerId, user?.uid]);

  useEffect(() => {
    if (!messages.length) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages.length]);

  useEffect(() => {
    if (!resolvedServerId || !resolvedChannelId || messages.length === 0) return;

    const latestMessage = messages[messages.length - 1];
    const latestCreatedAtMs = latestMessage?.createdAt?.toMillis?.() || Date.now();

    markCommunityChannelViewed(
      resolvedServerId,
      resolvedChannelId,
      latestCreatedAtMs,
    ).catch((error) => {
      console.error("Error marking channel as viewed:", error);
    });
  }, [messages, resolvedChannelId, resolvedServerId]);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (event: KeyboardEvent) => {
        Animated.timing(composerBottom, {
          toValue: Math.max(0, event.endCoordinates.height),
          duration: Platform.OS === "ios" ? event.duration || 250 : 220,
          useNativeDriver: false,
        }).start(({ finished }) => {
          if (finished) {
            requestAnimationFrame(() => {
              listRef.current?.scrollToEnd({ animated: true });
            });
          }
        });
      },
    );

    const hideSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      (event: KeyboardEvent) => {
        Animated.timing(composerBottom, {
          toValue: 0,
          duration: Platform.OS === "ios" ? event.duration || 250 : 180,
          useNativeDriver: false,
        }).start();
      },
    );

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [composerBottom]);

  const handleProfilePress = useCallback(
    (targetUserId?: string, isAnonymous?: boolean) => {
      if (!targetUserId || isAnonymous || targetUserId === "anonymous") return;
      const returnTo = `/ServerChannelScreen?serverId=${encodeURIComponent(resolvedServerId || "")}&channelId=${encodeURIComponent(resolvedChannelId || "")}&serverName=${encodeURIComponent(resolvedServerName || "")}&channelLabel=${encodeURIComponent(resolvedChannelLabel || "")}&serverAccent=${encodeURIComponent(resolvedServerAccent || "")}`;
      if (user?.uid === targetUserId) {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo },
        });
        return;
      }
      router.push(
        buildUserProfileHref({
          userId: targetUserId,
          returnTo,
        }) as any,
      );
    },
    [
      resolvedChannelId,
      resolvedChannelLabel,
      resolvedServerAccent,
      resolvedServerId,
      resolvedServerName,
      router,
      user?.uid,
    ],
  );

  const handleSend = useCallback(
    async (messageData: any) => {
      if (!user?.uid || !resolvedServerId || !resolvedChannelId) return;
      if (isOffline) {
        Alert.alert("No Connection", "You need internet access to send a message.");
        return;
      }

      const payload = {
        ...messageData,
        profilePic:
          messageData.isAnonymous === true ? null : resolveAvatarUri(messageData) || resolveAvatarUri(currentUserProfile),
        profileImage:
          messageData.isAnonymous === true ? null : resolveAvatarUri(messageData) || resolveAvatarUri(currentUserProfile),
        serverId: resolvedServerId,
        channelId: resolvedChannelId,
        createdAt: serverTimestamp(),
      };
      const moderationDecision = await requestModerationDecision({
        text: getModerationPreviewText({
          text: messageData.text,
          linkTitle: messageData.link?.title,
          fileCount: messageData.files?.length,
        }),
        scope: "thread",
        serverId: resolvedServerId,
        channelId: resolvedChannelId,
        authorId: user.uid,
        authorRole: currentUserProfile?.role,
      });
      payload.moderationStatus = moderationDecision.status;
      payload.moderationReasons = moderationDecision.reasons;
      payload.moderatedAtMs = Date.now();

      const messageRef = await addDoc(collection(db, "communityThreadMessages"), payload);
      const mentionRecipientIds = (messageData.taggedUsers || [])
        .map((tag: TaggedUser) => tag.id)
        .filter((recipientId: string) => !isAiAssistantId(recipientId));
      const shouldTriggerAi = (messageData.taggedUsers || []).some((tag: TaggedUser) =>
        isAiAssistantId(tag.id),
      );

      if (moderationDecision.status !== "pending") {
        await createMentionNotifications({
          recipientIds: await resolveMentionRecipientIds({
            taggedUserIds: mentionRecipientIds,
            actorId: user.uid,
            serverId: resolvedServerId,
          }),
          actor: {
            id: user.uid,
            name: messageData.username || currentUserProfile?.firstname || "Someone",
            profileImage:
              messageData.isAnonymous === true
                ? null
                : resolveAvatarUri(currentUserProfile),
            isAnonymous: messageData.isAnonymous,
          },
          entityType: "comment",
          entityId: messageRef.id,
          parentId: resolvedServerId,
          message: `mentioned you in #${resolvedChannelLabel}`,
          preview: messageData.text,
        });
      }

      if (!shouldTriggerAi || moderationDecision.status === "pending") {
        if (moderationDecision.status === "pending") {
          Alert.alert(
            "Message Pending Review",
            "This message was flagged and is waiting for moderator approval.",
          );
        }
        return;
      }

      const contextMessages = buildAiContextMessages(messages, {
        ...payload,
        username: messageData.username,
      });
      const aiPrompt = summarizeThreadMessage(payload);

      void (async () => {
        const cooldown = await reserveAiCooldown(
          resolvedServerId,
          resolvedChannelId,
          AI_REQUEST_COOLDOWN_MS,
        );

        if (!cooldown.allowed) {
          Alert.alert(
            "AI Cooling Down",
            `Bonded AI can be called again in ${formatCooldownLabel(cooldown.remainingMs)}.`,
          );
          return;
        }

        const pendingReplyRef = await addDoc(collection(db, "communityThreadMessages"), {
          text: "",
          userId: AI_ASSISTANT_ID,
          realUserId: AI_ASSISTANT_ID,
          username: AI_ASSISTANT_NAME,
          role: "assistant",
          profileImage: null,
          profilePic: null,
          isAnonymous: false,
          taggedUsers: [],
          files: [],
          link: null,
          serverId: resolvedServerId,
          channelId: resolvedChannelId,
          aiAssistant: true,
          aiStatus: "generating",
          aiSourceMessageId: messageRef.id,
          createdAt: serverTimestamp(),
        });

        const { reply } = await requestAiReplyFromWorker({
          serverId: resolvedServerId,
          channelId: resolvedChannelId,
          sourceMessageId: messageRef.id,
          sourceUserId: user.uid,
          prompt: aiPrompt,
          contextMessages,
        });

        await updateDoc(doc(db, "communityThreadMessages", pendingReplyRef.id), {
          text: reply,
          aiStatus: "completed",
        });
      })().catch((error) => {
        console.error("AI assistant request failed:", error);
        Alert.alert(
          "AI Unavailable",
          getAiErrorMessage(error),
        );
      });
    },
    [
      currentUserProfile?.firstname,
      currentUserProfile?.profileImage,
      currentUserProfile?.profilePic,
      currentUserProfile?.role,
      isOffline,
      messages,
      resolvedChannelId,
      resolvedChannelLabel,
      resolvedServerId,
      user?.uid,
    ],
  );

  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        // Mirrors the original onMoveShouldSetPanResponder gate: only
        // capture drags that are meaningfully downward and more vertical
        // than horizontal, so horizontal scrolling/swiping elsewhere isn't
        // affected.
        .activeOffsetY(12)
        .failOffsetX([-20, 20])
        .onUpdate((event) => {
          if (event.translationY > 0) {
            translateY.value = event.translationY;
            overlayOpacity.value = Math.max(0.4, 1 - event.translationY / SCREEN_HEIGHT);
          }
        })
        .onEnd((event) => {
          // RNGH reports velocity in px/s, whereas the old PanResponder's
          // vy was roughly px/ms — 0.8 px/ms ≈ 800 px/s, same threshold.
          if (event.translationY > 130 || event.velocityY > 800) {
            runOnJS(closeToDrawer)();
            return;
          }

          translateY.value = withSpring(0, { damping: 20, stiffness: 220 });
          overlayOpacity.value = withTiming(1, { duration: 180 });
        }),
    [closeToDrawer],
  );

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View style={styles.root}>
      <ReanimatedAnimated.View style={[styles.backdrop, backdropAnimatedStyle]} />
      <ReanimatedAnimated.View
        style={[
          styles.sheet,
          {
            paddingTop: insets.top,
            paddingBottom: Math.max(insets.bottom, 12),
          },
          sheetAnimatedStyle,
        ]}
      >
        <SafeAreaView style={styles.container} edges={["left", "right"]}>
          <GestureDetector gesture={dragGesture}>
            <View style={styles.dragZone}>
              <View style={styles.dragHandle} />
              <Text style={styles.dragText}>Swipe down to return to the drawer</Text>
            </View>
          </GestureDetector>

          <View style={[styles.header, { borderBottomColor: `${resolvedServerAccent}55` }]}>
            <View style={styles.headerCopy}>
              <Text style={styles.serverName}>{resolvedServerName}</Text>
              <Text style={styles.channelName}>#{resolvedChannelLabel}</Text>
            </View>

            <TouchableOpacity
              style={[styles.closeButton, { backgroundColor: resolvedServerAccent }]}
              onPress={closeToDrawer}
              activeOpacity={0.82}
            >
              <Ionicons name="close" size={18} color="#fffaf7" />
            </TouchableOpacity>
          </View>
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <MessageBubble
                item={item}
                isOwnMessage={(item.realUserId || item.userId) === user?.uid}
                accent={resolvedServerAccent}
                onProfilePress={handleProfilePress}
                nowMs={relativeTimeNow}
              />
            )}
            contentContainerStyle={[
              styles.listContent,
              messages.length === 0 && styles.emptyListContent,
            ]}
            ListEmptyComponent={
              loading ? (
                <View style={styles.emptyState}>
                  <ActivityIndicator size="large" color={resolvedServerAccent} />
                  <Text style={styles.emptyTitle}>Loading thread...</Text>
                </View>
              ) : (
                <View style={styles.emptyState}>
                  <Ionicons
                    name="sparkles-outline"
                    size={56}
                    color={resolvedServerAccent}
                  />
                  <Text style={styles.emptyTitle}>Kick off #{resolvedChannelLabel}</Text>
                </View>
              )
            }
            showsVerticalScrollIndicator={false}
          />

          {currentUserProfile && (
            <Animated.View style={[styles.composerShell, { marginBottom: composerBottom }]}>
              <CommentComposer
                currentUser={currentUserProfile}
                onSend={handleSend}
                placeholder={`Message #${resolvedChannelLabel}`}
              />
            </Animated.View>
          )}
        </SafeAreaView>
      </ReanimatedAnimated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "transparent",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(8, 2, 2, 0.55)",
  },
  sheet: {
    flex: 1,
    backgroundColor: "#f6f1ed",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: "hidden",
  },
  container: {
    flex: 1,
    backgroundColor: "#f6f1ed",
  },
  dragZone: {
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 10,
  },
  dragHandle: {
    width: 44,
    height: 5,
    borderRadius: 999,
    backgroundColor: "#c9b0a8",
  },
  dragText: {
    marginTop: 6,
    color: "#9b766c",
    fontSize: 12,
    fontWeight: "600",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  headerCopy: {
    flex: 1,
    paddingRight: 12,
  },
  serverName: {
    color: "#4d1b17",
    fontSize: 18,
    fontWeight: "800",
  },
  channelName: {
    color: "#9b766c",
    fontSize: 13,
    marginTop: 4,
    fontWeight: "600",
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 20,
  },
  emptyListContent: {
    flexGrow: 1,
    justifyContent: "center",
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
  avatarWrap: {
    marginRight: 8,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ead7cf",
    overflow: "hidden",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarText: {
    color: "#5f0909",
    fontSize: 13,
    fontWeight: "800",
  },
  messageContentWrap: {
    maxWidth: SCREEN_WIDTH * 0.74,
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
  messageToggleText: {
    color: "#8f3a2b",
    fontSize: 13,
    fontWeight: "700",
  },
  messageToggleTextOwn: {
    color: "#fff2c9",
  },
  aiPendingRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  aiPendingText: {
    marginLeft: 8,
    color: "#7d3b30",
    fontSize: 12.5,
    fontWeight: "600",
  },
  aiPendingTextOwn: {
    color: "#fffaf7",
  },
  messageImage: {
    width: "100%",
    height: 180,
    borderRadius: 14,
    marginTop: 10,
    backgroundColor: "#efe1d6",
  },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginTop: 10,
    backgroundColor: "rgba(255,250,247,0.18)",
  },
  fileChipText: {
    flex: 1,
    color: "#5f0909",
    fontSize: 12.5,
    fontWeight: "600",
  },
  fileChipTextOwn: {
    color: "#fffaf7",
  },
  linkCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    padding: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,250,247,0.18)",
  },
  linkTitle: {
    color: "#5f0909",
    fontSize: 13,
    fontWeight: "700",
  },
  linkTitleOwn: {
    color: "#fffaf7",
  },
  linkUrl: {
    color: "#9b766c",
    fontSize: 11.5,
    marginTop: 2,
  },
  linkUrlOwn: {
    color: "rgba(255,250,247,0.82)",
  },
  tagRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
  },
  tagText: {
    color: "#8f3a2b",
    fontSize: 12.5,
    fontWeight: "600",
    flex: 1,
  },
  tagTextOwn: {
    color: "#fffaf7",
  },
  messageMeta: {
    color: "#9b766c",
    fontSize: 11.5,
    marginTop: 5,
    marginLeft: 4,
  },
  messageMetaOwn: {
    textAlign: "right",
    marginRight: 4,
  },
  emptyState: {
    alignItems: "center",
    paddingHorizontal: 26,
  },
  emptyTitle: {
    marginTop: 14,
    color: "#4d1b17",
    fontSize: 20,
    fontWeight: "800",
  },
  emptyText: {
    marginTop: 8,
    color: "#9b766c",
    textAlign: "center",
    lineHeight: 20,
  },
  composerShell: {
    borderTopWidth: 1,
    borderTopColor: "#ead7cf",
    backgroundColor: "#fff4ee",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: Platform.OS === "android" ? 8 : 0,
  },
});
// app/(main)/MessagesScreen.tsx
import { auth, db } from "@/Firebase_configure";
import { resolveAvatarUri } from "@/utils/avatar";
import { AVATAR_SIZE_MEDIUM, avatarThumb } from "@/utils/cloudinaryImages";
import {
    DirectConversation,
    deleteDirectConversationForMe,
    getDirectChatParams,
    subscribeToUserConversations
} from "@/utils/directMessages";
import { getRoleColor, getRoleDisplayName, parseUserRole } from "@/utils/rbac";
import { getTimeAgo, useRelativeTimeNow } from "@/utils/relativeTime";
import { getPresenceState, type PresenceData } from "@/utils/messengerState";
import { useUserPresence } from "@/utils/presence";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { collection, onSnapshot } from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    FlatList,
    Keyboard,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import ConfirmDialog from "./components/ConfirmDialog";

type SearchableUser = PresenceData & {
  id: string;
  userId: string;
  firstname: string;
  lastname: string;
  fullName: string;
  studentID?: string;
  role?: string;
  profileImage?: string | null;
  course?: string;
  isOnline?: boolean;
};

/* ==================== CONVERSATION ROW (MEMOIZED FOR 60-120 FPS) ==================== */
interface ConversationRowProps {
  conversation: DirectConversation;
  currentUserId: string;
  nowMs: number;
  onPress: (conversation: DirectConversation, otherUser: { uid: string; displayName: string; avatarUri: string | null }) => void;
  onDelete: (conversation: DirectConversation, name: string) => void;
  deleting: boolean;
}

const ConversationRowComponent: React.FC<ConversationRowProps> = ({
  conversation,
  currentUserId,
  nowMs,
  onPress,
  onDelete,
  deleting,
}) => {
  const otherUserId = useMemo(() => {
    return conversation.participants.find((id) => id !== currentUserId) || conversation.participants[0] || "";
  }, [conversation.participants, currentUserId]);

  const otherParticipantDetail = conversation.participantDetails?.[otherUserId];
  const presence = useUserPresence(otherUserId, otherParticipantDetail?.studentID);
  const activity = getPresenceState(presence, nowMs);
  const nickname = conversation.nicknames?.[otherUserId];
  const displayName = nickname || otherParticipantDetail?.displayName || "User";
  const role = parseUserRole(otherParticipantDetail?.role);
  const roleColor = getRoleColor(role || "student");
  const unreadCount = conversation.unreadCounts?.[currentUserId] || 0;
  const isUnread = unreadCount > 0;

  const lastMessage = conversation.lastMessage;
  const isOwnLastMessage = lastMessage?.senderId === currentUserId;
  const otherUserAvatar = otherParticipantDetail?.profileImage || null;

  // Messenger Seen status: if current user sent last message and recipient has seen it
  const isSeenByOther = useMemo(() => {
    if (!isOwnLastMessage || !lastMessage) return false;
    const otherLastRead = conversation.lastReadAt?.[otherUserId];
    if (!otherLastRead) return false;
    const msgTime = lastMessage.createdAt?.toMillis?.() ?? 0;
    const readTime = otherLastRead?.toMillis?.() ?? 0;
    return readTime >= msgTime && msgTime > 0;
  }, [isOwnLastMessage, lastMessage, conversation.lastReadAt, otherUserId]);

  const timeLabel = useMemo(() => {
    const time = lastMessage?.createdAt || conversation.updatedAt || conversation.createdAt;
    return getTimeAgo(time, nowMs);
  }, [lastMessage?.createdAt, conversation.updatedAt, conversation.createdAt, nowMs]);

  const previewSnippet = useMemo(() => {
    if (!lastMessage) return "No messages yet";
    let text = lastMessage.text;
    if (lastMessage.isImage) text = "Sent an image";
    else if (lastMessage.isFile) text = "Sent a file";

    if (isOwnLastMessage) {
      return `You: ${text}`;
    }
    return text;
  }, [lastMessage, isOwnLastMessage]);

  const handlePress = useCallback(() => {
    onPress(conversation, {
      uid: otherUserId,
      displayName,
      avatarUri: otherUserAvatar,
    });
  }, [onPress, conversation, otherUserId, displayName, otherUserAvatar]);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.conversationItem,
        pressed && styles.conversationItemPressed,
        isUnread && styles.conversationItemUnread,
      ]}
      onPress={handlePress}
      onLongPress={() => onDelete(conversation, displayName)}
      disabled={deleting}
      accessibilityRole="button"
      accessibilityLabel={`Chat with ${displayName}`}
      accessibilityHint="Long-press to delete this conversation for you."
      accessibilityActions={[{ name: "delete", label: "Delete conversation for me" }]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "delete") onDelete(conversation, displayName);
      }}
    >
      {/* Avatar with unread indicator / online badge */}
      <View style={styles.avatarWrapper}>
        {otherUserAvatar ? (
          <Image
            source={{ uri: avatarThumb(otherUserAvatar, AVATAR_SIZE_MEDIUM) }}
            style={styles.avatar}
            contentFit="cover"
          />
        ) : (
          <View style={[styles.avatarPlaceholder, { backgroundColor: roleColor + "25" }]}>
            <Text style={[styles.avatarInitials, { color: roleColor }]}>
              {(displayName[0] || "U").toUpperCase()}
            </Text>
          </View>
        )}
        {/* Unread dot or seen indicator */}
        {activity.active && <View style={styles.onlineDot} />}
      </View>

      {/* Body: Name, Role Chip, Snippet */}
      <View style={styles.conversationBody}>
        <View style={styles.conversationHeaderRow}>
          <Text
            style={[styles.displayNameText, isUnread && styles.displayNameTextBold]}
            numberOfLines={1}
          >
            {displayName}
          </Text>

          {role && role !== "student" && (
            <View style={[styles.roleChip, { backgroundColor: roleColor + "18", borderColor: roleColor }]}>
              <Text style={[styles.roleChipText, { color: roleColor }]}>
                {getRoleDisplayName(role)}
              </Text>
            </View>
          )}

          <Text style={[styles.timeText, isUnread && styles.timeTextUnread]}>{timeLabel}</Text>
        </View>

        <View style={styles.conversationPreviewRow}>
          <Text
            style={[styles.previewText, isUnread && styles.previewTextUnread]}
            numberOfLines={1}
          >
            {previewSnippet}
          </Text>

          {/* Right trailing indicator: unread badge pill OR seen miniature avatar */}
          {deleting ? <ActivityIndicator size="small" color="#8f2117" /> : isUnread ? (
            <View style={styles.unreadBadgePill}>
              <Text style={styles.unreadBadgeText}>
                {unreadCount > 99 ? "99+" : unreadCount}
              </Text>
            </View>
          ) : isOwnLastMessage && isSeenByOther && otherUserAvatar ? (
            <Image
              source={{ uri: avatarThumb(otherUserAvatar, 20) }}
              style={styles.seenMiniAvatar}
              contentFit="cover"
            />
          ) : isOwnLastMessage ? (
            <Ionicons name="checkmark" size={15} color="#9b766c" />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
};

const ConversationRow = React.memo(ConversationRowComponent);

/* ==================== MAIN MESSAGES SCREEN ==================== */
export default function MessagesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const currentUserId = auth.currentUser?.uid || "";
  const nowMs = useRelativeTimeNow();

  const [conversations, setConversations] = useState<DirectConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  // People Directory Modal state
  const [newChatModalVisible, setNewChatModalVisible] = useState(false);
  const [directoryUsers, setDirectoryUsers] = useState<SearchableUser[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [peopleSearchQuery, setPeopleSearchQuery] = useState("");
  const [startingChatWithId, setStartingChatWithId] = useState<string | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletionInFlight = useRef(false);

  const handleDeleteConversation = useCallback((conversation: DirectConversation, name: string) => {
    if (deletionInFlight.current) return;
    Keyboard.dismiss();
    setDeleteError(null);
    setDeleteTarget({ id: conversation.id, name });
  }, []);

  const confirmDeleteConversation = useCallback(async () => {
    if (!deleteTarget || deletionInFlight.current) return;
    deletionInFlight.current = true;
    setDeletingConversationId(deleteTarget.id);
    setDeleteError(null);
    try {
      await deleteDirectConversationForMe(deleteTarget.id, currentUserId);
      setDeleteTarget(null);
    } catch (error) {
      console.warn("[MessagesScreen] Delete conversation failed:", error);
      setDeleteError("Your conversation is still here. Check your connection and try again.");
    } finally {
      deletionInFlight.current = false;
      setDeletingConversationId(null);
    }
  }, [currentUserId, deleteTarget]);

  const cancelDeleteConversation = useCallback(() => {
    if (deletionInFlight.current) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }, []);

  // Subscribe to real-time conversations
  useEffect(() => {
    if (!currentUserId) return;

    const unsubscribe = subscribeToUserConversations(currentUserId, (convList) => {
      setConversations(convList);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [currentUserId]);

  // Filter conversations by search
  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;

    return conversations.filter((conv) => {
      const otherUserId = conv.participants.find((id) => id !== currentUserId) || "";
      const otherUser = conv.participantDetails?.[otherUserId];
      const nickname = conv.nicknames?.[otherUserId] || "";
      const name = (nickname || otherUser?.displayName || "").toLowerCase();
      const lastMsg = (conv.lastMessage?.text || "").toLowerCase();
      return name.includes(q) || lastMsg.includes(q);
    });
  }, [conversations, searchQuery, currentUserId]);

  // Open conversation handler
  const handleOpenConversation = useCallback(
    (
      conversation: DirectConversation,
      otherUser: { uid: string; displayName: string; avatarUri: string | null },
    ) => {
      router.push({
        pathname: "/(main)/DirectChatScreen" as any,
        params: {
          conversationId: conversation.id,
          recipientId: otherUser.uid,
          recipientName: otherUser.displayName,
          recipientAvatar: otherUser.avatarUri || "",
        },
      });
    },
    [router],
  );

  // Load directory users when opening "New Chat" modal
  useEffect(() => {
    if (!newChatModalVisible) return;
    return onSnapshot(collection(db, "students"), (snap) => {
      const list: SearchableUser[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        const uid = data.userId || data.uid;
        if (!uid) return; // A student document ID is not necessarily an auth UID.
        if (uid === currentUserId) return; // skip self

        const firstname = data.firstname || "";
        const lastname = data.lastname || "";
        const fullName = `${firstname} ${lastname}`.trim() || data.displayName || "Student";

        list.push({
          id: docSnap.id,
          userId: uid,
          firstname,
          lastname,
          fullName,
          studentID: data.studentID || "",
          role: data.role || "student",
          profileImage: resolveAvatarUri(data),
          course: data.course || "",
          isOnline: data.isOnline === true,
          lastSeen: data.lastSeen,
          activeStatusEnabled: data.activeStatusEnabled,
          presenceSessions: data.presenceSessions,
        });
      });

      // Sort alphabetically
      list.sort((a, b) => a.fullName.localeCompare(b.fullName));
      setDirectoryUsers(list);
      setDirectoryLoading(false);
    }, (e) => {
      console.warn("[MessagesScreen] Failed to load directory users:", e);
      setDirectoryLoading(false);
    });
  }, [currentUserId, newChatModalVisible]);

  const handleOpenNewChatModal = useCallback(() => {
    setDirectoryLoading(true);
    setPeopleSearchQuery("");
    setNewChatModalVisible(true);
  }, []);

  // Filtered people in modal
  const filteredPeople = useMemo(() => {
    const q = peopleSearchQuery.trim().toLowerCase();
    if (!q) return directoryUsers;

    return directoryUsers.filter((u) => {
      return (
        u.fullName.toLowerCase().includes(q) ||
        (u.studentID && u.studentID.toLowerCase().includes(q)) ||
        (u.course && u.course.toLowerCase().includes(q)) ||
        (u.role && u.role.toLowerCase().includes(q))
      );
    });
  }, [directoryUsers, peopleSearchQuery]);

  // Start chat with selected user from directory
  const handleStartChatWithUser = useCallback(
    (targetUser: SearchableUser) => {
      if (!currentUserId || startingChatWithId) return;
      setStartingChatWithId(targetUser.userId);

      try {
        const otherUserData = {
          uid: targetUser.userId,
          displayName: targetUser.fullName,
          role: targetUser.role || "student",
          profileImage: targetUser.profileImage || null,
          studentID: targetUser.studentID || "",
        };

        const chatParams = getDirectChatParams(currentUserId, otherUserData);

        setNewChatModalVisible(false);
        router.push({
          pathname: "/(main)/DirectChatScreen" as any,
          params: chatParams,
        });
      } catch (err) {
        console.error("[MessagesScreen] Failed to open direct conversation:", err);
      } finally {
        setStartingChatWithId(null);
      }
    },
    [currentUserId, router, startingChatWithId],
  );

  const renderConversationItem = useCallback(
    ({ item }: { item: DirectConversation }) => {
      return (
        <ConversationRow
          conversation={item}
          currentUserId={currentUserId}
          nowMs={nowMs}
          onPress={handleOpenConversation}
          onDelete={handleDeleteConversation}
          deleting={deletingConversationId === item.id}
        />
      );
    },
    [currentUserId, nowMs, handleOpenConversation, handleDeleteConversation, deletingConversationId],
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Top App Header */}
      <View style={[styles.header, { paddingTop: Platform.OS === "android" ? 10 : 0 }]}>
        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={() => router.back()}
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color="#5f0909" />
        </TouchableOpacity>

        <Text style={styles.headerTitle}>Messages</Text>

        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={handleOpenNewChatModal}
          accessibilityLabel="Start a new conversation"
        >
          <Ionicons name="create-outline" size={24} color="#5f0909" />
        </TouchableOpacity>
      </View>

      {/* Search Conversations Bar */}
      <View style={styles.searchBarWrapper}>
        <Ionicons name="search" size={18} color="#8f766e" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search chats..."
          placeholderTextColor="#af928b"
          value={searchQuery}
          onChangeText={setSearchQuery}
          clearButtonMode="while-editing"
        />
        {searchQuery.length > 0 && Platform.OS === "android" && (
          <TouchableOpacity onPress={() => setSearchQuery("")} style={styles.clearSearchBtn}>
            <Ionicons name="close-circle" size={18} color="#8f766e" />
          </TouchableOpacity>
        )}
      </View>

      {/* Conversations List (Virtualized 60-120 FPS) */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#8f2117" />
          <Text style={styles.loadingText}>Loading conversations...</Text>
        </View>
      ) : (
        <FlatList
          data={filteredConversations}
          keyExtractor={(item) => item.id}
          renderItem={renderConversationItem}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          windowSize={7}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          updateCellsBatchingPeriod={30}
          removeClippedSubviews={Platform.OS === "android"}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <View style={styles.emptyIconCircle}>
                <Ionicons name="chatbubbles-outline" size={44} color="#8f2117" />
              </View>
              <Text style={styles.emptyTitle}>
                {searchQuery ? "No matches found" : "No messages yet"}
              </Text>
              <Text style={styles.emptySubtitle}>
                {searchQuery
                  ? "Try searching with a different name or message phrase."
                  : "Connect directly with students, teachers, or administrators."}
              </Text>
              {!searchQuery && (
                <TouchableOpacity
                  style={styles.startChatButton}
                  onPress={handleOpenNewChatModal}
                  activeOpacity={0.85}
                >
                  <Ionicons name="add" size={20} color="#fffaf7" />
                  <Text style={styles.startChatButtonText}>Start a Chat</Text>
                </TouchableOpacity>
              )}
            </View>
          }
        />
      )}

      {/* ==================== NEW CHAT / PEOPLE SEARCH MODAL ==================== */}
      <Modal
        visible={newChatModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setNewChatModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          {/* Modal Header */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>New Conversation</Text>
            <TouchableOpacity
              style={styles.modalCloseBtn}
              onPress={() => setNewChatModalVisible(false)}
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={24} color="#5f0909" />
            </TouchableOpacity>
          </View>

          {/* People Search Input */}
          <View style={styles.modalSearchWrapper}>
            <Ionicons name="search" size={18} color="#8f766e" style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search people by name, ID, or course..."
              placeholderTextColor="#af928b"
              value={peopleSearchQuery}
              onChangeText={setPeopleSearchQuery}
              autoFocus
              clearButtonMode="while-editing"
            />
            {peopleSearchQuery.length > 0 && Platform.OS === "android" && (
              <TouchableOpacity onPress={() => setPeopleSearchQuery("")} style={styles.clearSearchBtn}>
                <Ionicons name="close-circle" size={18} color="#8f766e" />
              </TouchableOpacity>
            )}
          </View>

          {/* People Results List */}
          {directoryLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="small" color="#8f2117" />
              <Text style={styles.loadingText}>Loading campus directory...</Text>
            </View>
          ) : (
            <FlatList
              data={filteredPeople}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              windowSize={8}
              initialNumToRender={15}
              maxToRenderPerBatch={10}
              contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 24) }}
              renderItem={({ item }) => {
                const role = parseUserRole(item.role);
                const roleColor = getRoleColor(role || "student");
                const isStarting = startingChatWithId === item.userId;

                return (
                  <TouchableOpacity
                    style={styles.personRow}
                    onPress={() => handleStartChatWithUser(item)}
                    activeOpacity={0.7}
                    disabled={isStarting}
                  >
                    <View style={styles.personAvatarWrap}>
                      {item.profileImage ? (
                        <Image
                          source={{ uri: avatarThumb(item.profileImage, AVATAR_SIZE_MEDIUM) }}
                          style={styles.avatar}
                          contentFit="cover"
                        />
                      ) : (
                        <View style={[styles.avatarPlaceholder, { backgroundColor: roleColor + "22" }]}>
                          <Text style={[styles.avatarInitials, { color: roleColor }]}>
                            {(item.fullName[0] || "U").toUpperCase()}
                          </Text>
                        </View>
                      )}
                      {getPresenceState(item, nowMs).active && <View style={styles.onlineDot} />}
                    </View>

                    <View style={styles.personInfo}>
                      <View style={styles.personHeaderRow}>
                        <Text style={styles.personName} numberOfLines={1}>
                          {item.fullName}
                        </Text>
                        {role && role !== "student" && (
                          <View style={[styles.roleChip, { backgroundColor: roleColor + "18", borderColor: roleColor }]}>
                            <Text style={[styles.roleChipText, { color: roleColor }]}>
                              {getRoleDisplayName(role)}
                            </Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.personSubtext} numberOfLines={1}>
                        {[item.studentID, item.course].filter(Boolean).join(" • ") || "BondED Member"}
                      </Text>
                      <Text style={styles.personSubtext}>{getPresenceState(item, nowMs).label}</Text>
                    </View>

                    {isStarting ? (
                      <ActivityIndicator size="small" color="#8f2117" />
                    ) : (
                      <Ionicons name="chatbubble-outline" size={20} color="#8f2117" />
                    )}
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <View style={styles.modalEmpty}>
                  <Ionicons name="person-outline" size={38} color="#af928b" />
                  <Text style={styles.modalEmptyText}>No matching members found</Text>
                </View>
              }
            />
          )}
        </SafeAreaView>
      </Modal>

      <ConfirmDialog
        visible={!!deleteTarget}
        title={deleteError ? "Couldn’t delete conversation" : "Delete conversation for you?"}
        description={deleteError || (deleteTarget
          ? `Your conversation with ${deleteTarget.name} will be removed from your view.\n\nTheir copy will stay. You can’t undo this.`
          : "")}
        icon={deleteError ? "alert-circle-outline" : "trash-outline"}
        variant="destructive"
        confirmText={deleteError ? "Try again" : "Delete"}
        cancelText="Cancel"
        loading={!!deletingConversationId}
        onConfirm={() => void confirmDeleteConversation()}
        onCancel={cancelDeleteConversation}
      />
    </SafeAreaView>
  );
}

/* ==================== STYLES ==================== */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fffaf7",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(95, 9, 9, 0.12)",
    backgroundColor: "#fffaf7",
  },
  headerIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(143, 33, 23, 0.08)",
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#4d1510",
    letterSpacing: -0.3,
  },
  searchBarWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(143, 33, 23, 0.06)",
    marginHorizontal: 16,
    marginVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    height: 42,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: "#4d1510",
    paddingVertical: 0,
  },
  clearSearchBtn: {
    padding: 4,
  },
  listContent: {
    paddingVertical: 6,
    flexGrow: 1,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  loadingText: {
    marginTop: 10,
    fontSize: 14,
    color: "#7a554e",
  },
  conversationItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#fffaf7",
  },
  conversationItemPressed: {
    backgroundColor: "rgba(143, 33, 23, 0.05)",
  },
  conversationItemUnread: {
    backgroundColor: "rgba(224, 165, 61, 0.08)",
  },
  avatarWrapper: {
    position: "relative",
    marginRight: 14,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#f2e8e3",
  },
  avatarPlaceholder: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarInitials: {
    fontSize: 20,
    fontWeight: "700",
  },
  unreadDot: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: "#e0a53d",
    borderWidth: 2,
    borderColor: "#fffaf7",
  },
  conversationBody: {
    flex: 1,
    justifyContent: "center",
  },
  conversationHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  displayNameText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#2a0f0b",
    flex: 1,
    marginRight: 6,
  },
  displayNameTextBold: {
    fontWeight: "800",
    color: "#1a0805",
  },
  roleChip: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 1.5,
    marginRight: 6,
  },
  roleChipText: {
    fontSize: 10.5,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  timeText: {
    fontSize: 12,
    color: "#9b766c",
  },
  timeTextUnread: {
    color: "#8f2117",
    fontWeight: "700",
  },
  conversationPreviewRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  previewText: {
    fontSize: 14,
    color: "#7a554e",
    flex: 1,
    marginRight: 8,
  },
  previewTextUnread: {
    color: "#1a0805",
    fontWeight: "700",
  },
  unreadBadgePill: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#8f2117",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 6,
  },
  unreadBadgeText: {
    color: "#fffaf7",
    fontSize: 11,
    fontWeight: "800",
  },
  seenMiniAvatar: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#fffaf7",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 36,
    marginTop: 60,
  },
  emptyIconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(143, 33, 23, 0.08)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 19,
    fontWeight: "800",
    color: "#4d1510",
    marginBottom: 8,
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#8f766e",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 20,
  },
  startChatButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#8f2117",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
    gap: 6,
  },
  startChatButtonText: {
    color: "#fffaf7",
    fontSize: 15,
    fontWeight: "700",
  },

  /* Modal Styles */
  modalContainer: {
    flex: 1,
    backgroundColor: "#fffaf7",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(95, 9, 9, 0.12)",
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#4d1510",
  },
  modalCloseBtn: {
    padding: 6,
  },
  modalSearchWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(143, 33, 23, 0.06)",
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderRadius: 14,
    height: 44,
  },
  personRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(95, 9, 9, 0.06)",
  },
  personAvatarWrap: {
    position: "relative",
    marginRight: 12,
  },
  onlineDot: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: "#22c55e",
    borderWidth: 2,
    borderColor: "#fffaf7",
  },
  personInfo: {
    flex: 1,
    marginRight: 10,
  },
  personHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 3,
  },
  personName: {
    fontSize: 15.5,
    fontWeight: "700",
    color: "#2a0f0b",
    marginRight: 6,
  },
  personSubtext: {
    fontSize: 12.5,
    color: "#8f766e",
  },
  modalEmpty: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
    gap: 10,
  },
  modalEmptyText: {
    fontSize: 14.5,
    color: "#8f766e",
    fontWeight: "600",
  },
});

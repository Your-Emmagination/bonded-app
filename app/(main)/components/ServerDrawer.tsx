import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Dimensions,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { AVATAR_SIZE_SMALL, avatarThumb } from "@/utils/cloudinaryImages";
import type {
  CommunityChannel,
  CommunityServer,
  ServerJoinRequestRecord,
} from "@/utils/communityServers";

export type ServerEditPatch = {
  name: string;
  description: string;
  accent: string;
  isPublic: boolean;
  bannerUri?: string;
  logoUri?: string;
  emoji?: string;
};

export type ServerMemberPreview = {
  id: string;
  name: string;
  userId?: string | null;
  profileDocId?: string | null;
  role?: string | null;
  course?: string | null;
  avatarUri?: string | null;
  isOnline?: boolean;
};

type ServerDrawerProps = {
  visible: boolean;
  onClose: () => void;
  onExitServerView?: () => void;
  currentUserRole?: string | null;
  servers: CommunityServer[];
  selectedServerId?: string | null;
  selectedChannelId?: string | null;
  canCreateServer?: boolean;
  onSelectServer: (serverId: string) => void;
  onSelectChannel: (channelId: string) => void;
  onCreateServer?: (
    name: string,
    description?: string,
    accent?: string,
    isPublic?: boolean,
    emoji?: string,
  ) => void | Promise<void>;
  onEditServer?: (
    serverId: string,
    patch: Partial<ServerEditPatch>,
  ) => void | Promise<void>;
  onDeleteServer?: (serverId: string) => void | Promise<void>;
  onCreateThread?: (
    serverId: string,
    label: string,
    emoji?: string,
    description?: string,
  ) => void | Promise<void>;
  onRequestJoin?: (serverId: string) => void | Promise<void>;
  onApproveJoinRequest?: (
    serverId: string,
    userId: string,
  ) => void | Promise<void>;
  onRejectJoinRequest?: (
    serverId: string,
    userId: string,
  ) => void | Promise<void>;
  onOpenUserProfile?: (userId?: string, profileDocId?: string) => void;
  onLeaveServer?: (serverId: string) => void | Promise<void>;
  pendingJoinRequests?: ServerJoinRequestRecord[];
  serverMembers?: ServerMemberPreview[];
};

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const DRAWER_WIDTH = SCREEN_WIDTH;
const RAIL_WIDTH = 82;

const PRESET_ACCENTS = [
  "#8f3a2b",
  "#e0a53d",
  "#b64040",
  "#2f7d6b",
  "#4568a8",
  "#7f5cf0",
  "#c04e8a",
  "#3a8f6e",
];

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (nextValue: string) => void;
}) {
  return (
    <View style={styles.colorRow}>
      {PRESET_ACCENTS.map((accent) => (
        <TouchableOpacity
          key={accent}
          style={[
            styles.colorSwatch,
            { backgroundColor: accent },
            value === accent && styles.colorSwatchSelected,
          ]}
          onPress={() => onChange(accent)}
          activeOpacity={0.8}
        />
      ))}
    </View>
  );
}

function RailAvatar({
  server,
  selected,
  onPress,
  onLongPress,
}: {
  server: CommunityServer;
  selected: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.railAvatarWrap, selected && styles.railAvatarWrapSelected]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.82}
    >
      {selected && <View style={styles.selectedRailBridge} />}
      {selected && <View style={styles.activePill} />}
      <View
        style={[
          styles.railAvatar,
          selected && styles.railAvatarSelected,
          {
            backgroundColor: server.logoUri ? "#220505" : server.accent,
            borderColor: selected ? "#ffffff" : "transparent",
          },
        ]}
      >
        {server.logoUri ? (
          <Image source={{ uri: avatarThumb(server.logoUri, AVATAR_SIZE_SMALL) }} style={styles.railAvatarImage} />
        ) : (
          <Text style={styles.railAvatarEmoji}>{server.emoji || "🏫"}</Text>
        )}
      </View>
      {server.membershipState === "pending" && <View style={styles.pendingDot} />}
    </TouchableOpacity>
  );
}

function ChannelRow({
  channel,
  active,
  accent,
  disabled,
  onPress,
}: {
  channel: CommunityChannel;
  active: boolean;
  accent: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.channelRow,
        active && styles.channelRowActive,
        disabled && styles.channelRowDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
    >
      {active && (
        <View style={[styles.channelActiveBar, { backgroundColor: accent }]} />
      )}
      <View style={[styles.channelGlyph, { backgroundColor: `${accent}18` }]}>
        <Text style={styles.channelGlyphEmoji}>{channel.emoji || "💬"}</Text>
      </View>
      <View style={styles.channelCopy}>
        <Text style={styles.channelLabel}>#{channel.label}</Text>
        {!!channel.hint && <Text style={styles.channelHint}>{channel.hint}</Text>}
      </View>
      {!!channel.unreadCount ? (
        <View style={styles.unreadBadge}>
          <Text style={styles.unreadBadgeText}>
            {channel.unreadCount > 99 ? "99+" : channel.unreadCount}
          </Text>
        </View>
      ) : !!channel.unread ? (
        <View style={styles.unreadDot} />
      ) : null}
    </TouchableOpacity>
  );
}

export default function ServerDrawer({
  visible,
  onClose,
  onExitServerView,
  currentUserRole,
  servers,
  selectedServerId,
  selectedChannelId,
  canCreateServer = false,
  onSelectServer,
  onSelectChannel,
  onCreateServer,
  onEditServer,
  onDeleteServer,
  onCreateThread,
  onRequestJoin,
  onApproveJoinRequest,
  onRejectJoinRequest,
  onOpenUserProfile,
  onLeaveServer,
  pendingJoinRequests = [],
  serverMembers = [],
}: ServerDrawerProps) {
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const [createVisible, setCreateVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [threadVisible, setThreadVisible] = useState(false);
  const [membersVisible, setMembersVisible] = useState(false);

  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createAccent, setCreateAccent] = useState(PRESET_ACCENTS[0]);
  const [createPublic, setCreatePublic] = useState(true);
  const [createEmoji, setCreateEmoji] = useState("🏫");

  const [editServerId, setEditServerId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editAccent, setEditAccent] = useState(PRESET_ACCENTS[0]);
  const [editPublic, setEditPublic] = useState(true);
  const [editEmoji, setEditEmoji] = useState("🏫");

  const [threadName, setThreadName] = useState("");
  const [threadEmoji, setThreadEmoji] = useState("💬");
  const [threadDescription, setThreadDescription] = useState("");

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) || servers[0] || null,
    [selectedServerId, servers],
  );

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 260,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: -DRAWER_WIDTH,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
      setCreateVisible(false);
      setEditVisible(false);
      setThreadVisible(false);
      setMembersVisible(false);
    }
  }, [fadeAnim, slideAnim, visible]);

  const openEdit = (server: CommunityServer) => {
    if (!server.canManage) return;
    setEditServerId(server.id);
    setEditName(server.name);
    setEditDesc(server.description || "");
    setEditAccent(server.accent);
    setEditPublic(server.isPublic ?? true);
    setEditEmoji(server.emoji || "🏫");
    setEditVisible(true);
  };

  const handleCreate = async () => {
    if (!createName.trim()) return;
    await onCreateServer?.(
      createName.trim(),
      createDesc.trim(),
      createAccent,
      createPublic,
      createEmoji.trim() || "🏫",
    );
    setCreateVisible(false);
    setCreateName("");
    setCreateDesc("");
    setCreateAccent(PRESET_ACCENTS[0]);
    setCreatePublic(true);
    setCreateEmoji("🏫");
  };

  const handleSaveEdit = async () => {
    if (!editServerId) return;
    await onEditServer?.(editServerId, {
      name: editName.trim(),
      description: editDesc.trim(),
      accent: editAccent,
      isPublic: editPublic,
      emoji: editEmoji.trim() || "🏫",
    });
    setEditVisible(false);
  };

  const handleDeleteServer = () => {
    if (!editServerId || currentUserRole !== "admin") return;
    Alert.alert("Delete Server", "This server will disappear for everyone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await onDeleteServer?.(editServerId);
          setEditVisible(false);
        },
      },
    ]);
  };

  const handleCreateThread = async () => {
    if (!selectedServer || !threadName.trim()) return;
    await onCreateThread?.(
      selectedServer.id,
      threadName.trim(),
      threadEmoji.trim() || "💬",
      threadDescription.trim(),
    );
    setThreadVisible(false);
    setThreadName("");
    setThreadEmoji("💬");
    setThreadDescription("");
  };

  const membershipState = selectedServer?.membershipState || "joined";
  const canEnterThreads = membershipState === "joined";
  const canLeaveServer =
    membershipState === "joined" && currentUserRole !== "admin";

  // ── Edge-swipe navigation: ServerDrawer → HomeScreen ────────────────────
  // The drawer renders inside a Modal (its own native layer), so this needs
  // its own gesture rather than relying on one in HomeScreen underneath.
  // Starts near the RIGHT edge only; a horizontal left swipe reuses the
  // same onClose() used by the backdrop tap and the "Home" button.
  const edgeSwipeCloseGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ right: 0, width: 32 }) // Activation zone limited to the right screen edge (~32px)
        .activeOffsetX(-20) // Requires an intentful leftward drag before the gesture activates
        .failOffsetY([-15, 15]) // Yields to vertical scrolling (rail / channel list) immediately
        .maxPointers(1)
        .onEnd((event) => {
          const isDraggedLeft = event.translationX < -60;
          const isFlickedLeft = event.velocityX < -350;

          if (isDraggedLeft || isFlickedLeft) {
            runOnJS(onClose)();
          }
        }),
    [onClose],
  );

  return (
    <>
      <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
        <GestureHandlerRootView style={styles.overlay}>
          <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
          </Animated.View>

          <GestureDetector gesture={edgeSwipeCloseGesture}>
          <Animated.View
            style={[
              styles.drawerShell,
              { transform: [{ translateX: slideAnim }] },
            ]}
          >
            <View style={[styles.rail, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
              <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.railContent}
              >
                {servers.map((server) => (
                  <RailAvatar
                    key={server.id}
                    server={server}
                    selected={server.id === selectedServer?.id}
                    onPress={() => onSelectServer(server.id)}
                    onLongPress={server.canManage ? () => openEdit(server) : undefined}
                  />
                ))}
              </ScrollView>

              {canCreateServer && (
                <TouchableOpacity
                  style={styles.addServerButton}
                  onPress={() => setCreateVisible(true)}
                  activeOpacity={0.82}
                >
                  <Ionicons name="add" size={24} color="#fffaf7" />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.panel}>
              {selectedServer ? (
                <>
                  <View style={[styles.panelTopBar, { paddingTop: insets.top + 10 }]}>
                    <TouchableOpacity
                      style={styles.topBarButton}
                      onPress={onExitServerView || onClose}
                      activeOpacity={0.82}
                    >
                      <Ionicons name="arrow-back" size={18} color="#5f0909" />
                      <Text style={styles.topBarButtonText}>Home</Text>
                    </TouchableOpacity>

                    {selectedServer.canManage && (
                      <TouchableOpacity
                        style={styles.topBarButton}
                        onPress={() => openEdit(selectedServer)}
                        activeOpacity={0.82}
                      >
                        <Ionicons name="settings-outline" size={18} color="#5f0909" />
                        <Text style={styles.topBarButtonText}>Manage</Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  <ScrollView
                    style={styles.panelScroll}
                    contentContainerStyle={{ paddingBottom: insets.bottom + 28 }}
                    showsVerticalScrollIndicator={false}
                  >
                    <View style={[styles.heroCard, { backgroundColor: selectedServer.accent }]}>
                      <View style={styles.heroBadge}>
                        {selectedServer.logoUri ? (
                          <Image
                            source={{ uri: avatarThumb(selectedServer.logoUri, AVATAR_SIZE_SMALL) }}
                            style={styles.heroBadgeImage}
                          />
                        ) : (
                          <Text style={styles.heroBadgeEmoji}>
                            {selectedServer.emoji || "🏫"}
                          </Text>
                        )}
                      </View>
                      <Text style={styles.heroTitle}>{selectedServer.name}</Text>
                      <Text style={styles.heroSubtitle}>
                        {selectedServer.description || "Community workspace"}
                      </Text>
                      <View style={styles.heroMetaRow}>
                        <TouchableOpacity
                          style={styles.metaPill}
                          activeOpacity={0.82}
                          onPress={() => setMembersVisible(true)}
                        >
                          <Ionicons name="people-outline" size={14} color="#fffaf7" />
                          <Text style={styles.metaPillText}>
                            {selectedServer.memberCount.toLocaleString()} members
                          </Text>
                        </TouchableOpacity>
                        <View style={styles.metaPill}>
                          <Ionicons
                            name={
                              selectedServer.isPublic ? "globe-outline" : "lock-closed-outline"
                            }
                            size={14}
                            color="#fffaf7"
                          />
                          <Text style={styles.metaPillText}>
                            {selectedServer.isPublic ? "Public" : "Private"}
                          </Text>
                        </View>
                      </View>
                    </View>

                    {!canEnterThreads && (
                      <View style={styles.accessCard}>
                        {membershipState === "available" && (
                          <TouchableOpacity
                            style={styles.joinButton}
                            onPress={() => onRequestJoin?.(selectedServer.id)}
                            activeOpacity={0.82}
                          >
                            <Ionicons name="paper-plane-outline" size={16} color="#fffaf7" />
                            <Text style={styles.joinButtonText}>Request to Join</Text>
                          </TouchableOpacity>
                        )}
                        {membershipState === "pending" && (
                          <View style={styles.pendingAccessPill}>
                            <Ionicons name="time-outline" size={15} color="#8a5a10" />
                            <Text style={styles.pendingAccessText}>Request Pending</Text>
                          </View>
                        )}
                      </View>
                    )}

                    {selectedServer.canManage && pendingJoinRequests.length > 0 && (
                      <View style={styles.requestSection}>
                        <View style={styles.sectionHeaderRow}>
                          <Text style={styles.sectionTitle}>Join Requests</Text>
                          <Text style={styles.sectionCount}>
                            {pendingJoinRequests.length}
                          </Text>
                        </View>
                        {pendingJoinRequests.map((request) => (
                          <View key={`${request.serverId}_${request.userId}`} style={styles.requestCard}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.requestName}>
                                {request.requesterName || request.userId}
                              </Text>
                              <Text style={styles.requestMeta}>
                                {request.course || "Course not provided"}
                              </Text>
                              <TouchableOpacity
                                onPress={() => onOpenUserProfile?.(request.userId)}
                                activeOpacity={0.78}
                                style={styles.requestProfileLink}
                              >
                                <Text style={styles.requestProfileLinkText}>Open profile</Text>
                              </TouchableOpacity>
                            </View>
                            <View style={styles.requestActionColumn}>
                              <TouchableOpacity
                                style={styles.requestApprove}
                                onPress={() =>
                                  onApproveJoinRequest?.(request.serverId, request.userId)
                                }
                                activeOpacity={0.82}
                              >
                                <Ionicons name="checkmark" size={16} color="#fffaf7" />
                                <Text style={styles.requestApproveText}>Accept</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.requestReject}
                                onPress={() =>
                                  onRejectJoinRequest?.(request.serverId, request.userId)
                                }
                                activeOpacity={0.82}
                              >
                                <Ionicons name="close" size={16} color="#c0392b" />
                                <Text style={styles.requestRejectText}>Reject</Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        ))}
                      </View>
                    )}

                    {canLeaveServer && (
                      <View style={styles.accessCard}>
                        <TouchableOpacity
                          style={styles.leaveButton}
                          onPress={() => onLeaveServer?.(selectedServer.id)}
                          activeOpacity={0.82}
                        >
                          <Ionicons name="exit-outline" size={16} color="#fffaf7" />
                          <Text style={styles.joinButtonText}>Leave Server</Text>
                        </TouchableOpacity>
                      </View>
                    )}

                    <View style={styles.sectionHeaderRow}>
                          <Text style={styles.sectionTitle}>Class Channels</Text>
                      {selectedServer.canManage && (
                        <TouchableOpacity
                          style={styles.threadAddButton}
                          onPress={() => setThreadVisible(true)}
                          activeOpacity={0.82}
                        >
                          <Ionicons name="add" size={15} color="#5f0909" />
                          <Text style={styles.threadAddButtonText}>New</Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {selectedServer.sections.flatMap((section) => section.channels).map((channel) => (
                      <ChannelRow
                        key={channel.id}
                        channel={channel}
                        active={channel.id === selectedChannelId}
                        accent={selectedServer.accent}
                        disabled={!canEnterThreads}
                        onPress={() => onSelectChannel(channel.id)}
                      />
                    ))}
                  </ScrollView>
                </>
              ) : (
                <View style={styles.emptyState}>
                  <Ionicons name="server-outline" size={42} color="#c9b0a8" />
                  <Text style={styles.emptyStateText}>Select a server</Text>
                </View>
              )}
            </View>
          </Animated.View>
          </GestureDetector>
        </GestureHandlerRootView>
      </Modal>

      <Modal visible={createVisible} transparent animationType="fade" onRequestClose={() => setCreateVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Create Server</Text>
              <TouchableOpacity onPress={() => setCreateVisible(false)}>
                <Ionicons name="close" size={22} color="#8f3a2b" />
              </TouchableOpacity>
            </View>

            <Text style={styles.fieldLabel}>Server Name</Text>
            <TextInput
              style={styles.input}
              value={createName}
              onChangeText={setCreateName}
              placeholder="Engineering projects"
              placeholderTextColor="#b89a92"
            />

            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput
              style={[styles.input, styles.inputMulti]}
              value={createDesc}
              onChangeText={setCreateDesc}
              placeholder="What makes this server useful?"
              placeholderTextColor="#b89a92"
              multiline
            />

            <Text style={styles.fieldLabel}>Icon Emoji</Text>
            <TextInput
              style={styles.input}
              value={createEmoji}
              onChangeText={setCreateEmoji}
              placeholder="🏫"
              placeholderTextColor="#b89a92"
              maxLength={3}
            />

            <Text style={styles.fieldLabel}>Accent</Text>
            <ColorPicker value={createAccent} onChange={setCreateAccent} />

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchTitle}>Public server</Text>
                <Text style={styles.switchHint}>
                  Anyone can request access, but staff still approves entry.
                </Text>
              </View>
              <Switch
                value={createPublic}
                onValueChange={setCreatePublic}
                trackColor={{ false: "#e4d0ca", true: `${createAccent}99` }}
                thumbColor={createPublic ? createAccent : "#c9b0a8"}
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => setCreateVisible(false)}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: createAccent }]}
                onPress={handleCreate}
                disabled={!createName.trim()}
              >
                <Text style={styles.primaryButtonText}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={editVisible} transparent animationType="fade" onRequestClose={() => setEditVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Manage Server</Text>
              <TouchableOpacity onPress={() => setEditVisible(false)}>
                <Ionicons name="close" size={22} color="#8f3a2b" />
              </TouchableOpacity>
            </View>

            <Text style={styles.fieldLabel}>Server Name</Text>
            <TextInput style={styles.input} value={editName} onChangeText={setEditName} />

            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput
              style={[styles.input, styles.inputMulti]}
              value={editDesc}
              onChangeText={setEditDesc}
              multiline
            />

            <Text style={styles.fieldLabel}>Icon Emoji</Text>
            <TextInput style={styles.input} value={editEmoji} onChangeText={setEditEmoji} maxLength={3} />

            <Text style={styles.fieldLabel}>Accent</Text>
            <ColorPicker value={editAccent} onChange={setEditAccent} />

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchTitle}>Public server</Text>
                <Text style={styles.switchHint}>
                  Public servers still use approval before entry.
                </Text>
              </View>
              <Switch
                value={editPublic}
                onValueChange={setEditPublic}
                trackColor={{ false: "#e4d0ca", true: `${editAccent}99` }}
                thumbColor={editPublic ? editAccent : "#c9b0a8"}
              />
            </View>

            <View style={styles.modalActions}>
              {currentUserRole === "admin" ? (
                <TouchableOpacity style={styles.dangerButton} onPress={handleDeleteServer}>
                  <Ionicons name="trash-outline" size={16} color="#c0392b" />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.secondaryButton} onPress={() => setEditVisible(false)}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: editAccent }]}
                onPress={handleSaveEdit}
                disabled={!editName.trim()}
              >
                <Text style={styles.primaryButtonText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={threadVisible} transparent animationType="fade" onRequestClose={() => setThreadVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Create Channel</Text>
              <TouchableOpacity onPress={() => setThreadVisible(false)}>
                <Ionicons name="close" size={22} color="#8f3a2b" />
              </TouchableOpacity>
            </View>

            <Text style={styles.fieldLabel}>Channel Name</Text>
            <TextInput
              style={styles.input}
              value={threadName}
              onChangeText={setThreadName}
              placeholder="resources"
              placeholderTextColor="#b89a92"
            />

            <Text style={styles.fieldLabel}>Channel Emoji</Text>
            <TextInput
              style={styles.input}
              value={threadEmoji}
              onChangeText={setThreadEmoji}
              placeholder="📚"
              placeholderTextColor="#b89a92"
              maxLength={3}
            />

            <Text style={styles.fieldLabel}>Channel Description</Text>
            <TextInput
              style={[styles.input, styles.inputMulti]}
              value={threadDescription}
              onChangeText={setThreadDescription}
              placeholder="What is this channel for?"
              placeholderTextColor="#b89a92"
              multiline
            />

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => setThreadVisible(false)}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: selectedServer?.accent || "#5f0909" }]}
                onPress={handleCreateThread}
                disabled={!threadName.trim()}
              >
                <Text style={styles.primaryButtonText}>Create Channel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={membersVisible} transparent animationType="fade" onRequestClose={() => setMembersVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Server Members</Text>
                <Text style={styles.memberModalSubtitle}>
                  {selectedServer?.name || "Community"} roster
                </Text>
              </View>
              <TouchableOpacity onPress={() => setMembersVisible(false)}>
                <Ionicons name="close" size={22} color="#8f3a2b" />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.memberList} showsVerticalScrollIndicator={false}>
              {serverMembers.length > 0 ? (
                serverMembers.map((member) => (
                  <TouchableOpacity
                    key={member.id}
                    style={styles.memberRow}
                    onPress={() => onOpenUserProfile?.(member.userId || undefined, member.profileDocId || undefined)}
                    activeOpacity={0.82}
                  >
                    <View style={styles.memberAvatar}>
                      {member.avatarUri ? (
                        <Image source={{ uri: avatarThumb(member.avatarUri, AVATAR_SIZE_SMALL) }} style={styles.memberAvatarImage} />
                      ) : (
                        <Text style={styles.memberAvatarText}>
                          {(member.name?.[0] || "M").toUpperCase()}
                        </Text>
                      )}
                    </View>
                    <View style={styles.memberCopy}>
                      <Text style={styles.memberName}>{member.name}</Text>
                      <Text style={styles.memberMeta}>
                        {[member.role, member.course].filter(Boolean).join(" • ") || "Member"}
                      </Text>
                    </View>
                    {member.isOnline ? <View style={styles.memberOnlineDot} /> : null}
                  </TouchableOpacity>
                ))
              ) : (
                <View style={styles.memberEmptyState}>
                  <Ionicons name="people-outline" size={28} color="#c9b0a8" />
                  <Text style={styles.memberEmptyText}>No member list available yet.</Text>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(8, 2, 2, 0.74)",
  },
  drawerShell: {
    flex: 1,
    flexDirection: "row",
  },
  rail: {
    width: RAIL_WIDTH,
    backgroundColor: "#1e0303",
    alignItems: "center",
  },
  railContent: {
    alignItems: "center",
    gap: 10,
    paddingBottom: 12,
  },
  railAvatarWrap: {
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    width: 66,
    height: 66,
    marginVertical: 2,
    borderRadius: 24,
  },
  railAvatarWrapSelected: {
    width: 72,
  },
  selectedRailBridge: {
    position: "absolute",
    right: -16,
    top: 7,
    bottom: 7,
    width: 32,
    borderTopLeftRadius: 18,
    borderBottomLeftRadius: 18,
    backgroundColor: "#fffaf7",
    shadowColor: "#2a0505",
    shadowOpacity: 0.16,
    shadowRadius: 10,
    elevation: 6,
  },
  activePill: {
    position: "absolute",
    left: -3,
    top: 20,
    width: 5,
    height: 26,
    borderRadius: 999,
    backgroundColor: "#fffaf7",
  },
  railAvatar: {
    width: 48,
    height: 48,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    overflow: "hidden",
  },
  railAvatarSelected: {
    transform: [{ scale: 1.08 }],
    shadowColor: "#fffaf7",
    shadowOpacity: 0.42,
    shadowRadius: 14,
    elevation: 9,
  },
  railAvatarImage: {
    width: "100%",
    height: "100%",
  },
  railAvatarEmoji: {
    fontSize: 24,
  },
  pendingDot: {
    position: "absolute",
    right: 2,
    bottom: 2,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#e0a53d",
    borderWidth: 2,
    borderColor: "#1e0303",
  },
  addServerButton: {
    width: 48,
    height: 48,
    borderRadius: 18,
    backgroundColor: "#5f0909",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#e0a53d",
    marginTop: 8,
  },
  panel: {
    flex: 1,
    backgroundColor: "#f6f1ed",
  },
  panelTopBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingBottom: 10,
    backgroundColor: "#f6f1ed",
  },
  topBarButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: "#f0e7e2",
    borderWidth: 1,
    borderColor: "#dfc9c1",
  },
  topBarButtonText: {
    color: "#5f0909",
    fontSize: 13,
    fontWeight: "700",
  },
  panelScroll: {
    flex: 1,
    paddingHorizontal: 14,
  },
  heroCard: {
    borderRadius: 24,
    padding: 18,
    marginBottom: 16,
  },
  heroBadge: {
    width: 58,
    height: 58,
    borderRadius: 18,
    backgroundColor: "rgba(255,250,247,0.18)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
    overflow: "hidden",
  },
  heroBadgeImage: {
    width: "100%",
    height: "100%",
  },
  heroBadgeEmoji: {
    fontSize: 28,
  },
  heroTitle: {
    color: "#fffaf7",
    fontSize: 22,
    fontWeight: "800",
  },
  heroSubtitle: {
    color: "rgba(255,250,247,0.86)",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  heroMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14,
  },
  metaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,250,247,0.16)",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  metaPillText: {
    color: "#fffaf7",
    fontSize: 12.5,
    fontWeight: "600",
  },
  accessCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#ead7cf",
    marginBottom: 16,
  },
  accessTitle: {
    color: "#5f0909",
    fontSize: 16,
    fontWeight: "800",
  },
  accessText: {
    color: "#8b6b62",
    lineHeight: 19,
    marginTop: 6,
  },
  joinButton: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
    backgroundColor: "#5f0909",
    paddingVertical: 12,
  },
  joinButtonText: {
    color: "#fffaf7",
    fontWeight: "700",
  },
  pendingAccessPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: "#f8f1e5",
    borderWidth: 1,
    borderColor: "#ddb977",
  },
  pendingAccessText: {
    color: "#8a5a10",
    fontSize: 13,
    fontWeight: "700",
  },
  requestSection: {
    marginBottom: 18,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  sectionTitle: {
    color: "#5f0909",
    fontSize: 15,
    fontWeight: "800",
  },
  sectionCount: {
    minWidth: 28,
    textAlign: "center",
    color: "#fffaf7",
    backgroundColor: "#8f3a2b",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    overflow: "hidden",
    fontSize: 12,
    fontWeight: "700",
  },
  requestCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#fffaf7",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#ead7cf",
    padding: 12,
    marginBottom: 8,
  },
  requestName: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "700",
  },
  requestMeta: {
    color: "#9b766c",
    fontSize: 12,
    marginTop: 3,
  },
  requestApprove: {
    minWidth: 96,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2f7d6b",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
  },
  requestReject: {
    minWidth: 96,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff1ef",
    borderWidth: 1,
    borderColor: "#f1c5bf",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
  },
  requestActionColumn: {
    gap: 8,
  },
  requestApproveText: {
    color: "#fffaf7",
    fontSize: 12,
    fontWeight: "700",
  },
  requestRejectText: {
    color: "#c0392b",
    fontSize: 12,
    fontWeight: "700",
  },
  requestProfileLink: {
    marginTop: 8,
    alignSelf: "flex-start",
  },
  requestProfileLinkText: {
    color: "#8f3a2b",
    fontSize: 12,
    fontWeight: "700",
  },
  leaveButton: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
    backgroundColor: "#8f3a2b",
    paddingVertical: 12,
  },
  threadAddButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#f4d7b1",
  },
  threadAddButtonText: {
    color: "#5f0909",
    fontSize: 12,
    fontWeight: "700",
  },
  channelRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#fffaf7",
    borderRadius: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#ead7cf",
    position: "relative",
  },
  channelRowActive: {
    backgroundColor: "#fff5ef",
    borderColor: "#f1c9bd",
  },
  channelRowDisabled: {
    opacity: 0.5,
  },
  channelActiveBar: {
    position: "absolute",
    left: 0,
    top: 8,
    bottom: 8,
    width: 4,
    borderRadius: 999,
  },
  channelGlyph: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  channelGlyphEmoji: {
    fontSize: 18,
  },
  channelCopy: {
    flex: 1,
  },
  channelLabel: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "700",
  },
  channelHint: {
    color: "#9b766c",
    fontSize: 11.5,
    marginTop: 2,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#b64040",
  },
  unreadBadge: {
    minWidth: 24,
    height: 24,
    paddingHorizontal: 7,
    borderRadius: 12,
    backgroundColor: "#8f3a2b",
    alignItems: "center",
    justifyContent: "center",
  },
  unreadBadgeText: {
    color: "#fffaf7",
    fontSize: 11,
    fontWeight: "800",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  emptyStateText: {
    color: "#9b766c",
    fontSize: 14,
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(10,2,2,0.72)",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  modalCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 22,
    padding: 20,
    borderWidth: 1,
    borderColor: "#ecd6bf",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 18,
  },
  modalTitle: {
    color: "#3d0808",
    fontSize: 18,
    fontWeight: "800",
  },
  fieldLabel: {
    color: "#8f3a2b",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 6,
    marginTop: 2,
  },
  input: {
    backgroundColor: "#fdf4ef",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#ecd6bf",
    color: "#4d1b17",
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    marginBottom: 14,
  },
  inputMulti: {
    minHeight: 92,
    textAlignVertical: "top",
  },
  memberModalSubtitle: {
    color: "#9b766c",
    fontSize: 12.5,
    marginTop: 3,
  },
  memberList: {
    maxHeight: 380,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: "#f1e4dc",
    gap: 12,
  },
  memberAvatar: {
    width: 46,
    height: 46,
    borderRadius: 16,
    backgroundColor: "#f4d7b1",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  memberAvatarImage: {
    width: "100%",
    height: "100%",
  },
  memberAvatarText: {
    color: "#5f0909",
    fontSize: 16,
    fontWeight: "800",
  },
  memberCopy: {
    flex: 1,
  },
  memberName: {
    color: "#381713",
    fontSize: 15,
    fontWeight: "700",
  },
  memberMeta: {
    color: "#8d6a61",
    fontSize: 12.5,
    marginTop: 3,
  },
  memberOnlineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#2f7d6b",
  },
  memberEmptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 28,
    gap: 10,
  },
  memberEmptyText: {
    color: "#9b766c",
    fontSize: 13.5,
    textAlign: "center",
  },
  colorRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  colorSwatch: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorSwatchSelected: {
    borderColor: "#3d0808",
    transform: [{ scale: 1.12 }],
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fdf4ef",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#ecd6bf",
    padding: 12,
    marginBottom: 18,
  },
  switchTitle: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "700",
  },
  switchHint: {
    color: "#9b766c",
    fontSize: 11.5,
    marginTop: 2,
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  secondaryButton: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e7d8d0",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    backgroundColor: "#f8f1ec",
  },
  secondaryButtonText: {
    color: "#5f0909",
    fontSize: 14,
    fontWeight: "700",
  },
  primaryButton: {
    flex: 2,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: "#fffaf7",
    fontSize: 14,
    fontWeight: "700",
  },
  dangerButton: {
    width: 46,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#f5c6c2",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff0ef",
  },
});
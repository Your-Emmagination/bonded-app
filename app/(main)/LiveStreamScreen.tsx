// app/(main)/LiveStreamScreen.tsx
//
// Watching a live stream.
//
// The video is only half of this screen, and the less interesting half. What
// makes a stream feel live is the part underneath — comments arriving while
// you read them, hearts from people you cannot see, a count that moves. All
// of that is Firestore, so it works whether or not a video pipe is attached,
// and it keeps working if the pipe is swapped for another one.
//
// The video area handles three cases: an HLS URL plays in expo-video, a
// WebRTC provider shows a placeholder until its native module is wired, and a
// stream with neither shows that it is waiting. A stream is never broken here,
// only quieter than intended.
import { useThemeColors } from "@/contexts/ThemeContext";
import { avatarThumb } from "@/utils/cloudinaryImages";
import {
  blockLiveStream,
  canModerateLive,
  endLiveStream,
  hideLiveComment,
  joinAsViewer,
  pinLiveComment,
  postLiveComment,
  publishViewerCount,
  sendLiveReaction,
  setLiveMediaState,
  subscribeToLiveComments,
  subscribeToStream,
  subscribeToViewerCount,
  unpinLiveComment,
  type LiveComment,
  type LiveStream,
} from "@/utils/liveStreams";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { timestampMs } from "@/utils/supportTickets";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { RtcSurfaceView, VideoSourceType } from "react-native-agora";
import { useAgoraLive } from "@/utils/useAgoraLive";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { auth } from "../../Firebase_configure";
import ConfirmDialog from "./components/ConfirmDialog";
import ContentActionMenu from "./components/ContentActionMenu";
import { getUserData } from "@/utils/rbac";

const getParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

/** At most this many hearts in flight, however hard people are tapping. */
const MAX_FLOATING_HEARTS = 12;

type FloatingHeart = { key: number };

export default function LiveStreamScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const params = useLocalSearchParams<{ streamId?: string | string[] }>();
  const streamId = getParam(params.streamId) || "";

  const user = auth.currentUser;
  const [viewerName, setViewerName] = useState("Someone");
  const [viewerAvatar, setViewerAvatar] = useState<string | null>(null);
  const [viewerRole, setViewerRole] = useState<string | null>(null);

  const [stream, setStream] = useState<LiveStream | null>(null);
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<LiveComment[]>([]);
  const [draft, setDraft] = useState("");
  const [hearts, setHearts] = useState<FloatingHeart[]>([]);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // The comment whose long-press menu is open.
  const [menuComment, setMenuComment] = useState<LiveComment | null>(null);

  const isHost = Boolean(user?.uid && stream && stream.hostId === user.uid);
  const canModerate = canModerateLive(viewerRole);

  // ── Who is watching ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    getUserData(user.uid)
      .then((data) => {
        if (cancelled || !data) return;
        const name =
          `${data.firstname || ""} ${data.lastname || ""}`.trim() ||
          data.email ||
          "Someone";
        setViewerName(name);
        setViewerAvatar(data.profileImage ?? null);
        setViewerRole(data.role ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!streamId) return;
    return subscribeToStream(streamId, (next) => {
      setStream(next);
      setLoading(false);
    });
  }, [streamId]);

  useEffect(() => {
    if (!streamId) return;
    return subscribeToLiveComments(streamId, setComments);
  }, [streamId]);

  // Presence, so the host's count is real. Leaving removes the mark; a client
  // that dies leaves a stale one, which the count already ignores.
  useEffect(() => {
    if (!streamId || !user?.uid || viewerName === "Someone") return;
    return joinAsViewer(streamId, { id: user.uid, name: viewerName });
  }, [streamId, user?.uid, viewerName]);

  // Only the host tallies the audience, then writes the number onto the
  // stream document so every viewer reads it from a snapshot they already
  // have rather than subscribing to each other.
  const peakRef = useRef(0);
  useEffect(() => {
    if (!isHost || !streamId) return;
    return subscribeToViewerCount(streamId, (count) => {
      publishViewerCount(streamId, count, peakRef.current);
      if (count > peakRef.current) peakRef.current = count;
    });
  }, [isHost, streamId]);

  // ── Hearts ──────────────────────────────────────────────────────────────
  // Each increment of the counter floats one heart. Comparing against the
  // previous value means a viewer sees everyone else's taps, not just theirs.
  const heartKeyRef = useRef(0);
  const lastReactionRef = useRef<number | null>(null);
  useEffect(() => {
    const total = stream?.reactionCount ?? 0;
    const previous = lastReactionRef.current;
    lastReactionRef.current = total;
    // The first snapshot carries the whole history; don't replay it.
    if (previous === null || total <= previous) return;

    const burst = Math.min(total - previous, MAX_FLOATING_HEARTS);
    const added = Array.from({ length: burst }, () => ({
      key: heartKeyRef.current++,
    }));
    setHearts((current) =>
      [...current, ...added].slice(-MAX_FLOATING_HEARTS),
    );
  }, [stream?.reactionCount]);

  const removeHeart = useCallback((key: number) => {
    setHearts((current) => current.filter((heart) => heart.key !== key));
  }, []);

  const tapHeart = useCallback(() => {
    if (!streamId) return;
    sendLiveReaction(streamId).catch(() => undefined);
  }, [streamId]);

  // ── Video ───────────────────────────────────────────────────────────────
  // Two pipes, picked by what the stream document says. Both hooks run every
  // render with a null input when unused, because a hook cannot be called
  // conditionally — passing null is how each one stays idle.
  const playbackUrl = stream?.playbackUrl ?? null;
  const player = useVideoPlayer(playbackUrl, (instance) => {
    instance.loop = false;
    instance.play();
  });

  const agoraChannel =
    stream?.provider === "agora" ? stream.channelName ?? stream.id : null;
  const agora = useAgoraLive(
    agoraChannel,
    isHost ? "host" : "audience",
    user?.uid ?? null,
  );

  // The host watches their own camera; everyone else watches the host's.
  const agoraCanvasUid = isHost ? 0 : agora.remoteUid;
  const showAgoraVideo =
    Boolean(agoraChannel) && (isHost ? agora.joined : agora.remoteUid !== null);

  // ── Host controls ───────────────────────────────────────────────────────
  // A freshly joined engine always starts with the mic and camera on, so the
  // document is brought back in line on every join. Without this, a host who
  // left with the camera off and came back would be broadcasting while every
  // viewer was still shown "camera paused".
  const hostJoined = isHost && agora.joined;
  useEffect(() => {
    if (!hostJoined || !streamId) return;
    setLiveMediaState(streamId, { micMuted: false, cameraOff: false }).catch(
      () => undefined,
    );
  }, [hostJoined, streamId]);

  const micMuted = stream?.micMuted ?? false;
  const cameraOff = stream?.cameraOff ?? false;
  const { setMicMuted, setCameraOff, switchCamera } = agora;

  // The engine changes first, the document second: the host should never be
  // told they are muted while their microphone is still going out.
  const toggleMic = useCallback(() => {
    if (!streamId) return;
    const next = !micMuted;
    setMicMuted(next);
    setLiveMediaState(streamId, { micMuted: next }).catch(() => undefined);
  }, [streamId, micMuted, setMicMuted]);

  const toggleCamera = useCallback(() => {
    if (!streamId) return;
    const next = !cameraOff;
    setCameraOff(next);
    setLiveMediaState(streamId, { cameraOff: next }).catch(() => undefined);
  }, [streamId, cameraOff, setCameraOff]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !streamId || !user?.uid) return;
    setDraft("");
    postLiveComment({
      streamId,
      authorId: user.uid,
      authorName: viewerName,
      authorAvatar: viewerAvatar,
      text,
    }).catch(() => undefined);
  }, [draft, streamId, user?.uid, viewerName, viewerAvatar]);

  const confirmEndStream = useCallback(async () => {
    if (!streamId) return;
    setConfirmEnd(false);
    try {
      if (isHost) {
        await endLiveStream(streamId);
      } else if (user?.uid) {
        await blockLiveStream(streamId, { id: user.uid, name: viewerName });
      }
    } catch {
      // The listener will show the real state either way.
    }
  }, [streamId, isHost, user?.uid, viewerName]);

  const pinnedId = stream?.pinnedComment?.id ?? null;

  const hide = useCallback(
    (commentId: string) => {
      if (!streamId) return;
      hideLiveComment(streamId, commentId).catch(() => undefined);
      // A removed comment must not stay on everyone's screen as a pin.
      if (pinnedId === commentId) {
        unpinLiveComment(streamId).catch(() => undefined);
      }
    },
    [streamId, pinnedId],
  );

  const commentActions = useMemo(() => {
    const target = menuComment;
    if (!target || !streamId) return [];
    const close = () => setMenuComment(null);
    const actions: {
      label: string;
      icon: keyof typeof Ionicons.glyphMap;
      onPress: () => void;
      destructive?: boolean;
    }[] = [];
    if (isHost) {
      const pinned = pinnedId === target.id;
      actions.push({
        label: pinned ? "Unpin comment" : "Pin to top",
        icon: pinned ? "pin-outline" : "pin",
        onPress: () => {
          close();
          (pinned
            ? unpinLiveComment(streamId)
            : pinLiveComment(streamId, target)
          ).catch(() => undefined);
        },
      });
    }
    if (isHost || canModerate) {
      actions.push({
        label: "Hide comment",
        icon: "eye-off-outline",
        destructive: true,
        onPress: () => {
          close();
          hide(target.id);
        },
      });
    }
    return actions;
  }, [menuComment, streamId, isHost, canModerate, pinnedId, hide]);

  const renderComment = useCallback(
    ({ item }: { item: LiveComment }) => {
      const avatar = item.authorAvatar ? avatarThumb(item.authorAvatar) : null;
      const hasActions = isHost || canModerate;
      return (
        <Pressable
          style={styles.commentRow}
          onLongPress={hasActions ? () => setMenuComment(item) : undefined}
          delayLongPress={350}
        >
          {avatar ? (
            <Image source={{ uri: avatar }} style={styles.commentAvatar} />
          ) : (
            <View style={[styles.commentAvatar, styles.commentAvatarFallback]}>
              <Text style={styles.commentInitial}>
                {(item.authorName[0] || "?").toUpperCase()}
              </Text>
            </View>
          )}
          <Text style={styles.commentText}>
            <Text style={styles.commentName}>{item.authorName}  </Text>
            {item.text}
          </Text>
        </Pressable>
      );
    },
    [styles, isHost, canModerate],
  );

  // ── States ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      </SafeAreaView>
    );
  }

  if (!stream) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <Ionicons name="videocam-off-outline" size={44} color={theme.textMuted} />
          <Text style={styles.endedTitle}>Stream not found</Text>
          <Pressable style={styles.primaryButton} onPress={() => router.back()}>
            <Text style={styles.primaryButtonText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (stream.status !== "live") {
    const blocked = stream.status === "blocked";
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <Ionicons
            name={blocked ? "shield-outline" : "checkmark-circle-outline"}
            size={44}
            color={blocked ? theme.danger : theme.textMuted}
          />
          <Text style={styles.endedTitle}>
            {blocked ? "This stream was ended" : "Stream ended"}
          </Text>
          <Text style={styles.endedText}>
            {blocked
              ? `A moderator ended this stream${
                  stream.endedByName ? ` (${stream.endedByName})` : ""
                }.`
              : `${stream.hostName} has finished streaming.`}
          </Text>
          <Text style={styles.endedStats}>
            {stream.peakViewers} peak · {stream.commentCount} comments ·{" "}
            {stream.reactionCount} hearts
          </Text>
          <Pressable style={styles.primaryButton} onPress={() => router.back()}>
            <Text style={styles.primaryButtonText}>Back to feed</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        enabled={Platform.OS !== "web"}
      >
        {/* ── Video ─────────────────────────────────────────────────────── */}
        <View style={styles.stage}>
          {cameraOff && !agora.error ? (
            <View style={styles.stagePlaceholder}>
              <Ionicons name="videocam-off-outline" size={40} color={theme.onChromeMuted} />
              <Text style={styles.stagePlaceholderText}>
                {isHost
                  ? "Your camera is off. Viewers can still hear you."
                  : `${stream.hostName} paused their camera.`}
              </Text>
            </View>
          ) : showAgoraVideo && agoraCanvasUid !== null ? (
            <RtcSurfaceView
              style={styles.video}
              canvas={{
                uid: agoraCanvasUid,
                sourceType: isHost
                  ? VideoSourceType.VideoSourceCameraPrimary
                  : VideoSourceType.VideoSourceRemote,
              }}
            />
          ) : playbackUrl ? (
            <VideoView
              style={styles.video}
              player={player}
              nativeControls={false}
              contentFit="contain"
            />
          ) : (
            <View style={styles.stagePlaceholder}>
              <Ionicons
                name={agora.error ? "alert-circle-outline" : "videocam-outline"}
                size={40}
                color={agora.error ? theme.danger : theme.onChromeMuted}
              />
              <Text
                style={[
                  styles.stagePlaceholderText,
                  agora.error && styles.stagePlaceholderError,
                ]}
              >
                {agora.error
                  ? agora.error
                  : agoraChannel
                    ? isHost
                      ? "Starting your camera…"
                      : "Waiting for the host's camera…"
                    : "This stream has no video."}
              </Text>
              {agora.error && !isHost && (
                <Text style={styles.stagePlaceholderHint}>
                  The comments below still work.
                </Text>
              )}
            </View>
          )}

          {/* Overlay chrome sits above the video, not beside it. */}
          <View style={styles.topBar}>
            <Pressable
              style={styles.iconButton}
              onPress={() => router.back()}
              hitSlop={10}
            >
              <Ionicons name="chevron-down" size={24} color={theme.onChrome} />
            </Pressable>

            <View style={styles.hostChip}>
              <View style={styles.liveDot} />
              <Text style={styles.hostChipText} numberOfLines={1}>
                {stream.hostName}
              </Text>
            </View>

            <View style={styles.viewerChip}>
              <Ionicons name="eye" size={13} color={theme.onChrome} />
              <Text style={styles.viewerChipText}>{stream.viewerCount}</Text>
            </View>

            {(isHost || canModerate) && (
              <Pressable
                style={styles.iconButton}
                onPress={() => setConfirmEnd(true)}
                hitSlop={10}
                accessibilityLabel={isHost ? "End stream" : "End this stream"}
              >
                <Ionicons
                  name={isHost ? "stop-circle-outline" : "shield-outline"}
                  size={23}
                  color={theme.danger}
                />
              </Pressable>
            )}
          </View>

          <View style={styles.statusRow}>
            <LiveTimer startedAt={stream.startedAt} />
            {micMuted && (
              <View style={styles.statusPill}>
                <Ionicons name="mic-off" size={12} color={theme.onChrome} />
                <Text style={styles.statusPillText}>Muted</Text>
              </View>
            )}
          </View>

          {isHost && agora.joined && (
            <View style={styles.hostRail}>
              <Pressable
                style={styles.railButton}
                onPress={switchCamera}
                disabled={cameraOff}
                accessibilityLabel="Switch camera"
              >
                <Ionicons
                  name="camera-reverse-outline"
                  size={21}
                  color={cameraOff ? theme.onChromeMuted : theme.onChrome}
                />
              </Pressable>
              <Pressable
                style={[styles.railButton, micMuted && styles.railButtonOff]}
                onPress={toggleMic}
                accessibilityLabel={micMuted ? "Unmute microphone" : "Mute microphone"}
              >
                <Ionicons
                  name={micMuted ? "mic-off" : "mic-outline"}
                  size={21}
                  color={theme.onChrome}
                />
              </Pressable>
              <Pressable
                style={[styles.railButton, cameraOff && styles.railButtonOff]}
                onPress={toggleCamera}
                accessibilityLabel={cameraOff ? "Turn camera on" : "Turn camera off"}
              >
                <Ionicons
                  name={cameraOff ? "videocam-off" : "videocam-outline"}
                  size={21}
                  color={theme.onChrome}
                />
              </Pressable>
            </View>
          )}

          <Text style={styles.title} numberOfLines={2}>
            {stream.title}
          </Text>

          {/* Hearts rise over the video from the bottom-right. */}
          <View pointerEvents="none" style={styles.heartLayer}>
            {hearts.map((heart) => (
              <FloatingHeartView
                key={heart.key}
                heartKey={heart.key}
                color={theme.danger}
                onDone={removeHeart}
              />
            ))}
          </View>
        </View>

        {/* ── Comments ──────────────────────────────────────────────────── */}
        {stream.pinnedComment && (
          <View style={styles.pinned}>
            <Ionicons name="pin" size={15} color={theme.accent} />
            <Text style={styles.pinnedText} numberOfLines={3}>
              <Text style={styles.pinnedAuthor}>
                {stream.pinnedComment.authorName}{"  "}
              </Text>
              {stream.pinnedComment.text}
            </Text>
            {isHost && (
              <Pressable
                onPress={() => unpinLiveComment(stream.id).catch(() => undefined)}
                hitSlop={10}
                accessibilityLabel="Unpin comment"
              >
                <Ionicons name="close" size={16} color={theme.textMuted} />
              </Pressable>
            )}
          </View>
        )}
        <FlatList
          style={styles.commentList}
          contentContainerStyle={styles.commentListContent}
          data={comments}
          renderItem={renderComment}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <Text style={styles.commentEmpty}>
              No comments yet. Say something.
            </Text>
          }
        />

        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Add a comment…"
            placeholderTextColor={theme.textMuted}
            maxLength={200}
            returnKeyType="send"
            onSubmitEditing={send}
            blurOnSubmit={false}
          />
          <Pressable
            style={[styles.sendButton, !draft.trim() && styles.sendButtonIdle]}
            onPress={send}
            disabled={!draft.trim()}
          >
            <Ionicons
              name="send"
              size={17}
              color={draft.trim() ? theme.onPrimary : theme.textMuted}
            />
          </Pressable>
          <Pressable style={styles.heartButton} onPress={tapHeart}>
            <Ionicons name="heart" size={22} color={theme.danger} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <ContentActionMenu
        visible={menuComment !== null && commentActions.length > 0}
        title={menuComment ? `Comment by ${menuComment.authorName}` : ""}
        actions={commentActions}
        onClose={() => setMenuComment(null)}
      />

      <ConfirmDialog
        visible={confirmEnd}
        variant="destructive"
        title={isHost ? "End your stream?" : "End this stream?"}
        description={
          isHost
            ? "Viewers will be told the stream has finished."
            : "Everyone watching will be told a moderator ended it. This cannot be undone."
        }
        confirmText={isHost ? "End stream" : "End it"}
        cancelText="Keep watching"
        onConfirm={confirmEndStream}
        onCancel={() => setConfirmEnd(false)}
      />
    </SafeAreaView>
  );
}

/** "4:07", or "1:02:09" once a stream passes the hour. */
const formatElapsed = (totalSeconds: number) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
};

/**
 * The running clock.
 *
 * Its own component so the once-a-second tick re-renders this pill and
 * nothing else — the video surface and the chat list stay still. Counted from
 * the server's start time, so every viewer sees the same number whenever they
 * joined. It reads 0:00 for the moment before the host's start time has come
 * back from the server.
 */
function LiveTimer({ startedAt }: { startedAt: any }) {
  const { styles } = useStyles();
  const nowMs = useRelativeTimeNow(1000);
  const startedMs = timestampMs(startedAt);
  const elapsed = startedMs
    ? Math.max(0, Math.floor((nowMs - startedMs) / 1000))
    : 0;

  return (
    <View style={[styles.statusPill, styles.livePill]}>
      <View style={styles.livePillDot} />
      <Text style={[styles.statusPillText, styles.livePillText]}>LIVE</Text>
      <Text style={[styles.statusPillText, styles.livePillText, styles.timerText]}>
        {formatElapsed(elapsed)}
      </Text>
    </View>
  );
}

/**
 * One heart, rising and fading, then removing itself.
 *
 * Each lives as its own component so the animation runs on the UI thread and
 * finishing is a single callback rather than a timer the parent has to track.
 */
function FloatingHeartView({
  heartKey,
  color,
  onDone,
}: {
  heartKey: number;
  color: string;
  onDone: (key: number) => void;
}) {
  const progress = useSharedValue(0);
  // A little sideways drift so a burst doesn't rise as one column.
  // Derived from the key rather than randomised: the spread looks the same,
  // and a pure expression survives a re-render without the heart jumping.
  const drift = Math.sin(heartKey * 12.9898) * 35;

  useEffect(() => {
    progress.value = withTiming(
      1,
      { duration: 2200, easing: Easing.out(Easing.quad) },
      (finished) => {
        if (finished) runOnJS(onDone)(heartKey);
      },
    );
  }, [progress, heartKey, onDone]);

  const style = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [
      { translateY: -170 * progress.value },
      { translateX: drift * progress.value },
      { scale: 0.7 + 0.5 * progress.value },
    ],
  }));

  return (
    <Reanimated.View style={[{ position: "absolute", right: 14, bottom: 0 }, style]}>
      <Ionicons name="heart" size={26} color={color} />
    </Reanimated.View>
  );
}

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    flex: { flex: 1 },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
      gap: 12,
    },

    // The stage is black in every theme — it is a video surface, and a cream
    // letterbox around a dark broadcast looks like a bug.
    stage: {
      height: "52%",
      backgroundColor: "#000000",
      overflow: "hidden",
    },
    video: { width: "100%", height: "100%" },
    stagePlaceholder: {
      ...StyleSheet.absoluteFill,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      paddingHorizontal: 28,
    },
    stagePlaceholderText: {
      color: c.onChromeMuted,
      fontSize: 13,
      textAlign: "center",
      lineHeight: 19,
    },
    stagePlaceholderError: { color: c.onChrome, fontSize: 13.5 },
    stagePlaceholderHint: { color: c.onChromeMuted, fontSize: 12 },

    topBar: {
      position: "absolute",
      top: 10,
      left: 10,
      right: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    iconButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(0,0,0,0.45)",
    },
    hostChip: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: "rgba(0,0,0,0.45)",
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 16,
    },
    liveDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: c.danger,
    },
    hostChipText: { color: c.onChrome, fontSize: 13, fontWeight: "700" },
    viewerChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "rgba(0,0,0,0.45)",
      paddingHorizontal: 9,
      paddingVertical: 6,
      borderRadius: 14,
    },
    viewerChipText: { color: c.onChrome, fontSize: 12.5, fontWeight: "800" },
    title: {
      position: "absolute",
      left: 14,
      right: 14,
      bottom: 12,
      color: c.onChrome,
      fontSize: 15,
      fontWeight: "800",
      textShadowColor: "rgba(0,0,0,0.6)",
      textShadowRadius: 5,
    },
    statusRow: {
      position: "absolute",
      top: 54,
      left: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    statusPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: "rgba(0,0,0,0.45)",
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: 10,
    },
    statusPillText: {
      color: c.onChrome,
      fontSize: 11.5,
      fontWeight: "800",
      letterSpacing: 0.3,
    },
    livePill: { backgroundColor: c.danger },
    livePillText: { color: c.onPrimary },
    livePillDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: c.onPrimary,
    },
    // Tabular figures, so the pill doesn't twitch in width every second.
    timerText: { fontVariant: ["tabular-nums"] },
    hostRail: {
      position: "absolute",
      top: 54,
      right: 12,
      gap: 10,
    },
    railButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(0,0,0,0.45)",
    },
    railButtonOff: { backgroundColor: c.danger },
    pinned: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      marginHorizontal: 12,
      marginTop: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 12,
      backgroundColor: c.accentSoft,
      borderWidth: 1,
      borderColor: c.accent,
    },
    pinnedText: { flex: 1, color: c.textPrimary, fontSize: 13.5, lineHeight: 19 },
    pinnedAuthor: { color: c.textSecondary, fontWeight: "800" },
    heartLayer: {
      position: "absolute",
      right: 0,
      bottom: 40,
      width: 90,
      height: 240,
    },

    commentList: { flex: 1 },
    commentListContent: { paddingVertical: 10, paddingHorizontal: 14, gap: 10 },
    commentRow: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
    commentAvatar: { width: 28, height: 28, borderRadius: 14 },
    commentAvatarFallback: {
      backgroundColor: c.surfaceSunken,
      alignItems: "center",
      justifyContent: "center",
    },
    commentInitial: { color: c.textSecondary, fontSize: 12, fontWeight: "800" },
    commentText: { flex: 1, color: c.textPrimary, fontSize: 13.5, lineHeight: 19 },
    commentName: { color: c.textMuted, fontWeight: "800" },
    commentEmpty: {
      color: c.textMuted,
      fontSize: 13,
      textAlign: "center",
      marginTop: 24,
    },

    composer: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.surface,
    },
    input: {
      flex: 1,
      minHeight: 42,
      maxHeight: 96,
      backgroundColor: c.surfaceSunken,
      borderRadius: 21,
      paddingHorizontal: 15,
      paddingVertical: 10,
      color: c.textPrimary,
      fontSize: 14.5,
    },
    sendButton: {
      width: 42,
      height: 42,
      borderRadius: 21,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.primary,
    },
    sendButtonIdle: { backgroundColor: c.surfaceSunken },
    heartButton: {
      width: 42,
      height: 42,
      borderRadius: 21,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.dangerSoft,
    },

    endedTitle: { color: c.textPrimary, fontSize: 18, fontWeight: "900" },
    endedText: { color: c.textSecondary, fontSize: 14, textAlign: "center" },
    endedStats: { color: c.textMuted, fontSize: 12.5, marginTop: 2 },
    primaryButton: {
      marginTop: 10,
      paddingHorizontal: 22,
      paddingVertical: 12,
      borderRadius: 14,
      backgroundColor: c.primary,
    },
    primaryButtonText: { color: c.onPrimary, fontSize: 14.5, fontWeight: "800" },
  });

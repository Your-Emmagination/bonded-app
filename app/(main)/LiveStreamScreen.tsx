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
  isLiveStreamFresh,
  joinAsViewer,
  markBroadcastStarted,
  pinLiveComment,
  postLiveComment,
  publishViewerCount,
  sendLiveReaction,
  setLiveMediaState,
  startHostHeartbeat,
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
import {
  discardRecording,
  replayPostRoute,
  retryLiveReplay,
  saveLiveReplay,
  useReplayJob,
  type LiveRecording,
} from "@/utils/liveReplay";
import { useAppActive } from "@/utils/presence";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
// The keyboard library's own view. It follows the keyboard frame by frame;
// React Native's built-in one stopped lifting anything on Android once
// KeyboardProvider (app/_layout.tsx) took over the keyboard.
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
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

/** Within this many points of the bottom still counts as reading the latest. */
const COMMENTS_BOTTOM_SLACK = 48;

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
  // Which "end" is being confirmed: the stop button, or the host trying to
  // leave the screen, which ends the live too.
  const [confirmEnd, setConfirmEnd] = useState<"stop" | "leave" | null>(null);
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
  // that dies leaves a stale one, which the count already ignores. The host
  // isn't a viewer of their own live, so it waits until the stream says who
  // the host is, and the host never marks themselves.
  const hostId = stream?.hostId ?? null;
  useEffect(() => {
    if (!streamId || !user?.uid || viewerName === "Someone") return;
    if (!hostId || hostId === user.uid) return;
    return joinAsViewer(streamId, { id: user.uid, name: viewerName, avatar: viewerAvatar });
  }, [hostId, streamId, user?.uid, viewerName, viewerAvatar]);

  // Only the host tallies the audience, then writes the number onto the
  // stream document so every viewer reads it from a snapshot they already
  // have rather than subscribing to each other.
  const peakRef = useRef(0);
  useEffect(() => {
    if (!isHost || !streamId || !hostId) return;
    return subscribeToViewerCount(streamId, hostId, (count) => {
      publishViewerCount(streamId, count, peakRef.current);
      if (count > peakRef.current) peakRef.current = count;
    });
  }, [hostId, isHost, streamId]);

  // ── Host still here ─────────────────────────────────────────────────────
  // While the host has this screen open and in front, the stream keeps
  // saying so. In the background the camera stops anyway, so the signal
  // stops with it; a host who doesn't come back drops out of the feed.
  const appActive = useAppActive();
  const hostIsLive = isHost && stream?.status === "live";
  useEffect(() => {
    if (!hostIsLive || !appActive || !streamId) return;
    return startHostHeartbeat(streamId);
  }, [hostIsLive, appActive, streamId]);

  // A viewer on a live whose host has gone quiet is told so, rather than
  // being left on "waiting for the camera" indefinitely.
  const freshnessNow = useRelativeTimeNow(10_000);
  const hostAway = !isHost && !!stream && !isLiveStreamFresh(stream, freshnessNow);

  // Leaving is ending, for the host: the camera stops when this screen
  // closes, so a live left behind would only be an empty card. Every way out
  // — the ⌄ button, Android's back, a swipe — asks first.
  const navigation = useNavigation();
  const pendingLeaveRef = useRef<any>(null);
  const leaveAllowedRef = useRef(false);
  useEffect(() => {
    if (!hostIsLive) return;
    return navigation.addListener("beforeRemove", (event) => {
      if (leaveAllowedRef.current) return;
      event.preventDefault();
      pendingLeaveRef.current = event.data.action;
      setConfirmEnd("leave");
    });
  }, [navigation, hostIsLive]);

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

  // Only while the stream is live. Once it ends, everyone leaves the channel —
  // including the host, whose camera would otherwise keep sending to nobody
  // until they closed the screen — and the host's recording is finished.
  const agoraChannel =
    stream?.status === "live" && stream.provider === "agora"
      ? stream.channelName ?? stream.id
      : null;

  // ── Replay ──────────────────────────────────────────────────────────────
  // The host's broadcast is recorded while live. It becomes a replay post
  // only if the host ended the live themselves; one a moderator stopped is
  // thrown away.
  const hostEndedRef = useRef(false);
  const saveReplayRef = useRef(true);
  const replaySourceRef = useRef<LiveStream | null>(null);
  useEffect(() => {
    replaySourceRef.current = stream;
  });
  const handleRecordingFinished = useCallback((recording: LiveRecording) => {
    const source = replaySourceRef.current;
    const uid = auth.currentUser?.uid;
    if (!hostEndedRef.current || !saveReplayRef.current || !source || !uid || source.hostId !== uid) {
      discardRecording(recording.fileUri);
      return;
    }
    saveLiveReplay({
      streamId: source.id,
      title: source.title,
      recording,
      author: { uid, name: source.hostName, role: source.hostRole },
      stats: {
        peakViewers: Math.max(source.peakViewers, peakRef.current),
        commentCount: source.commentCount,
        reactionCount: source.reactionCount,
      },
    });
  }, []);
  const replayJob = useReplayJob(isHost ? streamId : null);

  const agora = useAgoraLive(
    agoraChannel,
    isHost ? "host" : "audience",
    user?.uid ?? null,
    { record: isHost, onRecordingFinished: handleRecordingFinished },
  );

  // The live really begins when the host's camera joins the video channel —
  // the moment the replay starts recording — so that's when the clock starts,
  // for everyone. It used to count from when the live was created, several
  // seconds earlier, which is why a replay came out shorter than the clock.
  const broadcastMarkedRef = useRef(false);
  useEffect(() => {
    if (!isHost || !agora.joined || !streamId || stream?.status !== "live") return;
    if (stream.broadcastStartedAt !== null || broadcastMarkedRef.current) return;
    broadcastMarkedRef.current = true;
    markBroadcastStarted(streamId).catch((error) =>
      console.warn("Could not mark the live as broadcasting:", error),
    );
  }, [agora.joined, isHost, stream, streamId]);

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

  // ── Following the chat ──────────────────────────────────────────────────
  // New comments scroll into view while you are at the bottom. Scrolled up to
  // read something, you stay put and a pill offers the way back down. Your
  // own comment always brings you to the bottom.
  const commentListRef = useRef<FlatList<LiveComment>>(null);
  const atBottomRef = useRef(true);
  const followOwnRef = useRef(false);
  const newestSeenRef = useRef<string | null>(null);
  const [newCommentsBelow, setNewCommentsBelow] = useState(false);

  const scrollCommentsToEnd = useCallback((animated = true) => {
    commentListRef.current?.scrollToEnd({ animated });
    atBottomRef.current = true;
    setNewCommentsBelow(false);
  }, []);

  const handleCommentsScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const fromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
      atBottomRef.current = fromBottom < COMMENTS_BOTTOM_SLACK;
      if (atBottomRef.current) setNewCommentsBelow(false);
    },
    [],
  );

  // Runs once the list has laid out new content, which is the first moment a
  // scroll to the end reaches the comment that just arrived.
  const newestCommentId = comments[comments.length - 1]?.id ?? null;
  const handleCommentsSizeChange = useCallback(() => {
    if (!newestCommentId || newestCommentId === newestSeenRef.current) return;
    const firstLoad = newestSeenRef.current === null;
    newestSeenRef.current = newestCommentId;
    if (firstLoad || atBottomRef.current || followOwnRef.current) {
      followOwnRef.current = false;
      scrollCommentsToEnd(!firstLoad);
    } else {
      setNewCommentsBelow(true);
    }
  }, [newestCommentId, scrollCommentsToEnd]);

  // The keyboard shrinks the list; someone at the bottom should stay there.
  const handleCommentsLayout = useCallback(() => {
    if (atBottomRef.current) commentListRef.current?.scrollToEnd({ animated: false });
  }, []);

  // ── Actions ─────────────────────────────────────────────────────────────
  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !streamId || !user?.uid) return;
    followOwnRef.current = true;
    setDraft("");
    postLiveComment({
      streamId,
      authorId: user.uid,
      authorName: viewerName,
      authorAvatar: viewerAvatar,
      text,
    }).catch(() => undefined);
  }, [draft, streamId, user?.uid, viewerName, viewerAvatar]);

  const confirmEndStream = useCallback(async (saveReplay: boolean) => {
    if (!streamId) return;
    setConfirmEnd(null);
    // Marked before the stream flips to ended, which is what stops the
    // recording; that is where it is decided whether it becomes a replay.
    if (isHost) {
      hostEndedRef.current = true;
      saveReplayRef.current = saveReplay;
    }

    if (confirmEnd === "leave") {
      // Carry on with the exit that was held back, without waiting for the
      // server: the write is queued either way, and if it never lands (no
      // signal) the quiet heartbeat takes the live off the feed. The replay
      // keeps saving after the screen closes.
      endLiveStream(streamId).catch(() => undefined);
      leaveAllowedRef.current = true;
      const action = pendingLeaveRef.current;
      pendingLeaveRef.current = null;
      if (action) navigation.dispatch(action);
      else router.back();
      return;
    }

    try {
      if (isHost) {
        await endLiveStream(streamId);
      } else if (user?.uid) {
        await blockLiveStream(streamId, { id: user.uid, name: viewerName });
      }
    } catch {
      // The listener will show the real state either way.
    }
  }, [streamId, confirmEnd, isHost, user?.uid, viewerName, navigation, router]);

  const cancelEndStream = useCallback(() => {
    pendingLeaveRef.current = null;
    setConfirmEnd(null);
  }, []);

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
      if (item.kind === "join") {
        return (
          <View style={styles.joinActivity}>
            <Ionicons name="person-add-outline" size={13} color={theme.textMuted} />
            <Text style={styles.joinActivityText} numberOfLines={1}>
              <Text style={styles.joinActivityName}>{item.authorName}</Text> joined the live
            </Text>
          </View>
        );
      }
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
    [styles, theme.textMuted, isHost, canModerate],
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
    // The replay, once there is one people can watch: straight from this
    // phone's upload for the host, or from the stream for everyone else.
    const replayPostId =
      replayJob?.phase === "posted" ? replayJob.postId : stream.replayPostId;
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

          {replayJob && replayJob.phase !== "posted" && (
            <View style={styles.replayCard}>
              {replayJob.phase === "saving" ||
              replayJob.phase === "uploading" ||
              replayJob.phase === "posting" ? (
                <>
                  <View style={styles.replayCardHeader}>
                    <ActivityIndicator size="small" color={theme.primary} />
                    <Text style={styles.replayCardTitle}>
                      {replayJob.phase === "posting"
                        ? "Posting your replay…"
                        : replayJob.phase === "uploading"
                          ? `Uploading your replay… ${Math.round(replayJob.progress * 100)}%`
                          : "Saving your replay…"}
                    </Text>
                  </View>
                  <View
                    style={styles.replayTrack}
                    accessibilityRole="progressbar"
                    accessibilityValue={{ min: 0, max: 100, now: Math.round(replayJob.progress * 100) }}
                  >
                    <View
                      style={[
                        styles.replayFill,
                        { width: `${Math.round(Math.max(0.03, replayJob.progress) * 100)}%` },
                      ]}
                    />
                  </View>
                  <Text style={styles.replayCardText}>
                    Keep BondED open until it finishes. You can leave this screen.
                  </Text>
                </>
              ) : replayJob.phase === "review" ? (
                <>
                  <View style={styles.replayCardHeader}>
                    <Ionicons name="hourglass-outline" size={18} color={theme.warning} />
                    <Text style={styles.replayCardTitle}>Replay sent for review</Text>
                  </View>
                  <Text style={styles.replayCardText}>
                    It will appear on the feed once a moderator approves it.
                  </Text>
                </>
              ) : (
                <>
                  <View style={styles.replayCardHeader}>
                    <Ionicons
                      name={replayJob.phase === "failed" ? "cloud-offline-outline" : "information-circle-outline"}
                      size={18}
                      color={replayJob.phase === "failed" ? theme.danger : theme.textMuted}
                    />
                    <Text style={styles.replayCardTitle}>
                      {replayJob.phase === "failed" ? "Replay not saved yet" : "No replay"}
                    </Text>
                  </View>
                  {!!replayJob.message && (
                    <Text style={styles.replayCardText}>{replayJob.message}</Text>
                  )}
                  {replayJob.phase === "failed" && (
                    <Pressable
                      style={({ pressed }) => [styles.replayRetry, pressed && styles.pressed]}
                      onPress={() => retryLiveReplay(stream.id)}
                      accessibilityRole="button"
                    >
                      <Ionicons name="refresh" size={15} color={theme.onPrimary} />
                      <Text style={styles.replayRetryText}>Try again</Text>
                    </Pressable>
                  )}
                </>
              )}
            </View>
          )}

          {replayPostId && (
            <Pressable
              style={({ pressed }) => [styles.replayButton, pressed && styles.pressed]}
              onPress={() => router.push(replayPostRoute(replayPostId) as any)}
              accessibilityRole="button"
            >
              <Ionicons name="play-circle" size={19} color={theme.primary} />
              <Text style={styles.replayButtonText}>
                {replayJob?.phase === "posted"
                  ? "Your replay is on the feed · View"
                  : "Watch replay"}
              </Text>
            </Pressable>
          )}

          <Pressable style={styles.primaryButton} onPress={() => router.back()}>
            <Text style={styles.primaryButtonText}>Back to feed</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAvoidingView automaticOffset
        style={styles.flex}
        behavior="padding"
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
                  : hostAway
                    ? `${stream.hostName} left the live. It will close if they don't come back soon.`
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
              {isHost && (agora.permission === "denied" || agora.permission === "blocked") && (
                <>
                  <Pressable
                    style={({ pressed }) => [
                      styles.permissionButton,
                      pressed && styles.permissionButtonPressed,
                    ]}
                    // Asked again right here while Android still allows it;
                    // once it has stopped asking, straight to BondED's settings.
                    onPress={
                      agora.permission === "blocked"
                        ? agora.openPermissionSettings
                        : agora.retryPermissions
                    }
                    accessibilityRole="button"
                    accessibilityLabel={
                      agora.permission === "blocked"
                        ? "Open BondED settings to allow camera and microphone"
                        : "Turn on camera and microphone"
                    }
                  >
                    <Ionicons
                      name={agora.permission === "blocked" ? "settings-outline" : "videocam"}
                      size={17}
                      color={theme.onPrimary}
                    />
                    <Text style={styles.permissionButtonText}>
                      {agora.permission === "blocked"
                        ? "Open settings"
                        : "Turn on camera & microphone"}
                    </Text>
                  </Pressable>
                  {agora.permission === "blocked" && (
                    <Text style={styles.stagePlaceholderHint}>
                      Tap Permissions, allow Camera and Microphone, then come back.
                    </Text>
                  )}
                </>
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
                onPress={() => setConfirmEnd("stop")}
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
            <LiveTimer startedAt={stream.broadcastStartedAt} createdAt={stream.startedAt} />
            {isHost && agora.recording && (
              // Only the host sees this; it says the replay is being kept.
              <View
                style={styles.statusPill}
                accessible
                accessibilityLabel="Recording a replay"
              >
                <View style={styles.recDot} />
                <Text style={styles.statusPillText}>REC</Text>
              </View>
            )}
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
        <View style={styles.commentArea}>
          <FlatList
            ref={commentListRef}
            style={styles.commentList}
            contentContainerStyle={styles.commentListContent}
            data={comments}
            renderItem={renderComment}
            keyExtractor={(item) => item.id}
            showsVerticalScrollIndicator={false}
            onScroll={handleCommentsScroll}
            scrollEventThrottle={32}
            onContentSizeChange={handleCommentsSizeChange}
            onLayout={handleCommentsLayout}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <Text style={styles.commentEmpty}>
                No comments yet. Say something.
              </Text>
            }
          />
          {newCommentsBelow && (
            <Pressable
              style={({ pressed }) => [styles.newCommentsPill, pressed && styles.newCommentsPillPressed]}
              onPress={() => scrollCommentsToEnd()}
              accessibilityRole="button"
              accessibilityLabel="Jump to new comments"
            >
              <Text style={styles.newCommentsText}>New comments</Text>
              <Ionicons name="arrow-down" size={14} color={theme.onPrimary} />
            </Pressable>
          )}
        </View>

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
            <Text style={styles.heartCount}>{stream.reactionCount}</Text>
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
        visible={confirmEnd !== null}
        variant="destructive"
        title={
          confirmEnd === "leave"
            ? "End your live?"
            : isHost
              ? "End your stream?"
              : "End this stream?"
        }
        description={
          confirmEnd === "leave"
            ? "Leaving ends your live for everyone. Choose whether to publish the recording as a replay."
            : isHost
              ? "Viewers will be told the stream has finished. You can publish or discard the replay."
              : "Everyone watching will be told a moderator ended it. This cannot be undone."
        }
        confirmText={
          isHost ? "End & save replay" : "End it"
        }
        cancelText={
          confirmEnd === "leave" ? "Stay live" : isHost ? "Keep streaming" : "Keep watching"
        }
        secondaryText={isHost ? "End without replay" : undefined}
        onSecondary={isHost ? () => void confirmEndStream(false) : undefined}
        onConfirm={() => void confirmEndStream(true)}
        onCancel={cancelEndStream}
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
 * If the camera never reports in — it failed, or the moment couldn't be
 * saved — the pill stops saying "Connecting…" after this long and counts from
 * when the live was created, as it used to.
 */
const CONNECTING_FALLBACK_MS = 30_000;

/**
 * The running clock.
 *
 * Its own component so the once-a-second tick re-renders this pill and
 * nothing else — the video surface and the chat list stay still. Counted from
 * the server's time for when the camera went live, so every viewer sees the
 * same number whenever they joined, and it matches the replay. Until then it
 * says "Connecting…" instead of LIVE.
 */
function LiveTimer({ startedAt, createdAt }: { startedAt: any; createdAt: any }) {
  const { styles } = useStyles();
  const nowMs = useRelativeTimeNow(1000);
  const startedMs = timestampMs(startedAt);
  const createdMs = timestampMs(createdAt);
  const clockFromMs =
    startedMs || (createdMs && nowMs - createdMs >= CONNECTING_FALLBACK_MS ? createdMs : 0);

  if (!clockFromMs) {
    return (
      <View style={styles.statusPill} accessible accessibilityLabel="Connecting">
        <View style={styles.connectingDot} />
        <Text style={styles.statusPillText}>Connecting…</Text>
      </View>
    );
  }

  const elapsed = Math.max(0, Math.floor((nowMs - clockFromMs) / 1000));

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
      paddingHorizontal: 20,
    },
    stagePlaceholderText: {
      color: c.onChromeMuted,
      fontSize: 13,
      textAlign: "center",
      lineHeight: 19,
    },
    stagePlaceholderError: { color: c.onChrome, fontSize: 13.5 },
    stagePlaceholderHint: { color: c.onChromeMuted, fontSize: 12, textAlign: "center" },
    permissionButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 6,
      minHeight: 44,
      paddingHorizontal: 20,
      borderRadius: 22,
      backgroundColor: c.danger,
    },
    permissionButtonPressed: { opacity: 0.85 },
    permissionButtonText: { color: c.onPrimary, fontSize: 14, fontWeight: "800" },

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
    // Hollow until the camera is really live, when it becomes LIVE's dot.
    connectingDot: {
      width: 7,
      height: 7,
      borderRadius: 3.5,
      borderWidth: 1.5,
      borderColor: c.onChrome,
    },
    // Tabular figures, so the pill doesn't twitch in width every second.
    timerText: { fontVariant: ["tabular-nums"] },
    recDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: "#ff4d4f",
    },
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

    commentArea: { flex: 1 },
    commentList: { flex: 1 },
    newCommentsPill: {
      position: "absolute",
      bottom: 10,
      alignSelf: "center",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 18,
      backgroundColor: c.primary,
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    },
    newCommentsPillPressed: { opacity: 0.85 },
    newCommentsText: { color: c.onPrimary, fontSize: 12.5, fontWeight: "800" },
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
    joinActivity: {
      alignSelf: "center",
      maxWidth: "92%",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: 14,
      backgroundColor: c.surfaceSunken,
    },
    joinActivityText: { color: c.textMuted, fontSize: 12.5 },
    joinActivityName: { color: c.textSecondary, fontWeight: "800" },
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
      minWidth: 42,
      height: 42,
      borderRadius: 21,
      paddingHorizontal: 10,
      flexDirection: "row",
      gap: 5,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.dangerSoft,
    },
    heartCount: { color: c.danger, fontSize: 12, fontWeight: "900" },

    endedTitle: { color: c.textPrimary, fontSize: 18, fontWeight: "900" },
    endedText: { color: c.textSecondary, fontSize: 14, textAlign: "center" },
    endedStats: { color: c.textMuted, fontSize: 12.5, marginTop: 2 },
    pressed: { opacity: 0.8 },
    replayCard: {
      alignSelf: "stretch",
      marginTop: 10,
      padding: 16,
      gap: 8,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    replayCardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
    replayCardTitle: { flex: 1, color: c.textPrimary, fontSize: 14.5, fontWeight: "800" },
    replayCardText: { color: c.textSecondary, fontSize: 12.5, lineHeight: 18 },
    replayTrack: {
      height: 6,
      borderRadius: 3,
      overflow: "hidden",
      backgroundColor: c.surfaceSunken,
    },
    replayFill: { height: "100%", borderRadius: 3, backgroundColor: c.primary },
    replayRetry: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 2,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 12,
      backgroundColor: c.primary,
    },
    replayRetryText: { color: c.onPrimary, fontSize: 13, fontWeight: "800" },
    replayButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 10,
      paddingHorizontal: 20,
      paddingVertical: 11,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
    },
    replayButtonText: { color: c.primary, fontSize: 14, fontWeight: "800" },
    primaryButton: {
      marginTop: 10,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: 14,
      backgroundColor: c.primary,
    },
    primaryButtonText: { color: c.onPrimary, fontSize: 14.5, fontWeight: "800" },
  });

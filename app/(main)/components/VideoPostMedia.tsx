import {
    VIDEO_QUALITY_TIERS,
    videoUrl,
    type VideoQualityTier,
} from "@/utils/cloudinaryImages";
import {
    getActiveCaption,
    type CaptionSegment,
    type CaptionStatus,
} from "@/utils/videoCaptions";
import {
    setVideoQualityPreference,
    useVideoQuality,
    type VideoQualityPreference,
} from "@/utils/videoQuality";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    AppState,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";

type Props = {
  uri: string;
  width: number;
  /**
   * X-style feed mode. When true the video autoplays MUTED while `isPlaying`
   * is true, pauses when it goes false, and a tap anywhere on it expands to
   * fullscreen and unmutes. Inline UI is minimal (a mute indicator + a
   * quality gear) — full native controls only appear once it's fullscreen.
   *
   * When false/omitted the old behavior is kept: native controls, no
   * autoplay, tap-to-play, pause when `isPlaying` goes false.
   */
  feedAutoplay?: boolean;
  /**
   * Whether this video is allowed to play right now. For feed mode pass
   * `screenFocused && cardScrolledIntoView` — BOTH, so leaving Home still
   * pauses everything. Defaults to true so existing callers keep working.
   */
  isPlaying?: boolean;
  /**
   * Start unmuted (e.g. the moderation review preview, where a reviewer
   * wants audio immediately). Defaults to muted.
   */
  startMuted?: boolean;
  /**
   * Auto-generated caption state for this video (feed posts only). When
   * `captionStatus === "ready"` and `captions` is non-empty, a CC toggle
   * appears; captions are OFF by default (opt-in). Anything else -> no CC
   * button, video plays exactly as before.
   */
  captionStatus?: CaptionStatus;
  captions?: CaptionSegment[];
};

const PREFERENCE_OPTIONS: { value: VideoQualityPreference; label: string; hint: string }[] = [
  { value: "network", label: "Automatic", hint: "Match my connection" },
  ...VIDEO_QUALITY_TIERS.map((t) => ({ value: t.tier as VideoQualityPreference, label: t.label, hint: t.hint })),
];

const HITSLOP = { top: 12, bottom: 12, left: 12, right: 12 } as const;

export default function VideoPostMedia({
  uri,
  width,
  feedAutoplay = false,
  isPlaying = true,
  startMuted = true,
  captionStatus,
  captions,
}: Props) {
  const { tier, preference } = useVideoQuality();

  const captionsReady =
    captionStatus === "ready" && (captions?.length ?? 0) > 0;
  const [captionsOn, setCaptionsOn] = useState(false);
  const [captionLine, setCaptionLine] = useState("");

  // Feed videos are delivered at the resolved quality tier. Non-feed usages
  // (moderation preview) keep the original URL untouched.
  const source = useMemo(() => {
    if (!feedAutoplay) return uri;
    return videoUrl(uri, tier) ?? uri;
  }, [uri, tier, feedAutoplay]);

  const [muted, setMuted] = useState(startMuted);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [progress, setProgress] = useState(0);

  // useVideoPlayer recreates the player whenever `source` changes (its dep is
  // the stringified source), re-running this setup — so a quality-tier change
  // reloads at the new rendition and resumes below. No manual replace needed.
  const player = useVideoPlayer(source, (instance: VideoPlayer) => {
    // Loop short clips in the feed the way X does; leave one-shot elsewhere.
    instance.loop = feedAutoplay;
    // Part A.3: autoplay must start muted to be a reasonable experience.
    instance.muted = startMuted;
  });

  // Re-apply the current mute state after any player (re)creation.
  useEffect(() => {
    player.muted = muted;
  }, [muted, player]);

  // If captions stop being available (e.g. status flips away from "ready"),
  // don't leave a dangling toggle on.
  useEffect(() => {
    if (!captionsReady) {
      setCaptionsOn(false);
      setCaptionLine("");
    }
  }, [captionsReady]);

  // Buffering / loading state, for the spinner overlay.
  useEffect(() => {
    const sub = player.addListener("statusChange", ({ status }) => {
      setBuffering(status === "loading");
    });
    setBuffering(player.status === "loading");
    return () => sub.remove();
  }, [player]);

  // One timeUpdate listener drives BOTH the caption line and the inline
  // progress bar. It only runs while captions are on OR this is the feed
  // video currently in view — off-screen feed cards (which now stay mounted)
  // don't keep a ticking listener. Interval tightens only for captions.
  useEffect(() => {
    const wantCaptions = captionsOn && captionsReady;
    const wantProgress = feedAutoplay && isPlaying;
    if (!wantCaptions && !wantProgress) return;

    player.timeUpdateEventInterval = wantCaptions ? 0.25 : 0.5;
    const sub = player.addListener("timeUpdate", ({ currentTime }) => {
      if (wantCaptions) {
        setCaptionLine(getActiveCaption(captions, currentTime));
      }
      if (wantProgress) {
        const total = player.duration || 0;
        setProgress(total > 0 ? Math.min(1, currentTime / total) : 0);
      }
    });
    if (wantCaptions) {
      setCaptionLine(getActiveCaption(captions, player.currentTime || 0));
    }
    return () => {
      sub.remove();
      player.timeUpdateEventInterval = 0;
      if (wantCaptions) setCaptionLine("");
    };
  }, [captionsOn, captionsReady, captions, feedAutoplay, isPlaying, player]);

  // Autoplay / pause + scroll mute. Facebook-style: `muted` is the user's
  // sticky choice and is NEVER reset by scrolling. Scrolling away just mutes
  // the *player* immediately (so no audio bleeds while it's off-screen);
  // scrolling it back re-applies the user's choice, so a video they unmuted
  // returns with sound.
  useEffect(() => {
    if (isPlaying) {
      if (feedAutoplay && !isFullscreen) {
        player.muted = muted;
        player.play();
      }
    } else {
      player.pause();
      if (feedAutoplay) player.muted = true;
    }
  }, [isPlaying, feedAutoplay, isFullscreen, muted, player]);

  // Pause when the app is backgrounded (audio + battery); resume on return if
  // the card is still the one in view.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") {
        player.pause();
      } else if (isPlaying && feedAutoplay && !isFullscreen) {
        player.play();
      }
    });
    return () => sub.remove();
  }, [player, isPlaying, feedAutoplay, isFullscreen]);

  const openFullscreen = useCallback(() => {
    setMuted(false);
    player.muted = false;
    player.play();
    setIsFullscreen(true);
  }, [player]);

  const closeFullscreen = useCallback(() => {
    setIsFullscreen(false);
    if (feedAutoplay) {
      player.muted = true;
      setMuted(true);
    }
  }, [player, feedAutoplay]);

  const toggleMuted = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      player.muted = next; // apply now so audio flips without a render hop
      return next;
    });
  }, [player]);

  const toggleCaptions = useCallback(() => setCaptionsOn((on) => !on), []);

  const pickPreference = (value: VideoQualityPreference) => {
    setVideoQualityPreference(value);
    setQualityMenuOpen(false);
  };

  // Feed mode: while the custom fullscreen modal is up, the inline VideoView
  // is unmounted so exactly one VideoView is ever bound to the player (no
  // two-view handoff flicker). The player instance survives the swap, so
  // playback position carries over both ways.
  const showInlineVideo = !(feedAutoplay && isFullscreen);
  const inlineChromeVisible = feedAutoplay && !isFullscreen;

  return (
    <View style={[styles.container, { width }]}>
      {showInlineVideo && (
        <VideoView
          player={player}
          style={styles.video}
          // Feed videos get minimal inline UI; non-feed keeps the native bar
          // and the OS fullscreen button.
          nativeControls={!feedAutoplay}
          fullscreenOptions={{ enable: !feedAutoplay }}
          contentFit="contain"
          onFullscreenEnter={() => setIsFullscreen(true)}
          onFullscreenExit={() => {
            setIsFullscreen(false);
            if (feedAutoplay) {
              player.muted = true;
              setMuted(true);
            }
          }}
        />
      )}

      {inlineChromeVisible && (
        <>
          {/* Tap the video body (not a control) -> immersive fullscreen. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={openFullscreen}
            accessibilityLabel="Open video fullscreen"
          />

          {/* Speaker -> toggle sound inline (X-style); sits above the body
              Pressable so its tap never falls through to fullscreen. */}
          <TouchableOpacity
            style={styles.muteBadge}
            onPress={toggleMuted}
            hitSlop={HITSLOP}
            accessibilityLabel={muted ? "Unmute video" : "Mute video"}
            accessibilityState={{ selected: !muted }}
          >
            <Ionicons
              name={muted ? "volume-mute" : "volume-high"}
              size={14}
              color="#fff"
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.qualityButton}
            onPress={() => setQualityMenuOpen(true)}
            hitSlop={HITSLOP}
            accessibilityLabel="Video quality"
          >
            <Ionicons name="settings-outline" size={14} color="#fff" />
          </TouchableOpacity>

          {buffering && (
            <View style={styles.bufferOverlay} pointerEvents="none">
              <ActivityIndicator color="#fff" />
            </View>
          )}

          {/* Thin scrub-position line along the bottom edge. */}
          <View style={styles.progressTrack} pointerEvents="none">
            <View
              style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]}
            />
          </View>
        </>
      )}

      {/* CC toggle — captions are opt-in-visible (standard convention). */}
      {captionsReady && inlineChromeVisible && (
        <TouchableOpacity
          style={[styles.ccButton, captionsOn && styles.ccButtonOn]}
          onPress={toggleCaptions}
          hitSlop={HITSLOP}
          accessibilityLabel={captionsOn ? "Hide captions" : "Show captions"}
          accessibilityState={{ selected: captionsOn }}
        >
          <Text style={[styles.ccText, captionsOn && styles.ccTextOn]}>CC</Text>
        </TouchableOpacity>
      )}

      {/* Still transcribing — the video plays fine, captions arrive later. */}
      {captionStatus === "pending" && inlineChromeVisible && (
        <View style={styles.captionPending} pointerEvents="none">
          <Ionicons name="sync-outline" size={11} color="#e7d9cf" />
          <Text style={styles.captionPendingText}>Generating captions…</Text>
        </View>
      )}

      {/* Caption line, synced to playback position (inline). */}
      {captionsOn && inlineChromeVisible && !!captionLine && (
        <View style={styles.captionBar} pointerEvents="none">
          <Text style={styles.captionText}>{captionLine}</Text>
        </View>
      )}

      {/* ── X-style custom fullscreen (feed videos only) ─────────────────── */}
      <Modal
        visible={feedAutoplay && isFullscreen}
        animationType="fade"
        supportedOrientations={[
          "portrait",
          "landscape",
          "landscape-left",
          "landscape-right",
        ]}
        onRequestClose={closeFullscreen}
        statusBarTranslucent
      >
        <View style={styles.fsRoot}>
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            nativeControls
            fullscreenOptions={{ enable: false }}
            contentFit="contain"
          />

          <View style={styles.fsTopBar}>
            <TouchableOpacity
              onPress={closeFullscreen}
              style={styles.fsBtn}
              hitSlop={HITSLOP}
              accessibilityLabel="Close fullscreen"
            >
              <Ionicons name="chevron-down" size={26} color="#fff" />
            </TouchableOpacity>

            <View style={styles.fsFlex} />

            <TouchableOpacity
              onPress={toggleMuted}
              style={styles.fsBtn}
              hitSlop={HITSLOP}
              accessibilityLabel={muted ? "Unmute video" : "Mute video"}
            >
              <Ionicons
                name={muted ? "volume-mute" : "volume-high"}
                size={22}
                color="#fff"
              />
            </TouchableOpacity>

            {captionsReady && (
              <TouchableOpacity
                onPress={toggleCaptions}
                style={[styles.fsBtn, styles.fsCc, captionsOn && styles.fsCcOn]}
                hitSlop={HITSLOP}
                accessibilityLabel={captionsOn ? "Hide captions" : "Show captions"}
                accessibilityState={{ selected: captionsOn }}
              >
                <Text style={[styles.fsCcText, captionsOn && styles.fsCcTextOn]}>
                  CC
                </Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              onPress={() => setQualityMenuOpen(true)}
              style={styles.fsBtn}
              hitSlop={HITSLOP}
              accessibilityLabel="Video quality"
            >
              <Ionicons name="settings-outline" size={22} color="#fff" />
            </TouchableOpacity>
          </View>

          {buffering && (
            <View style={styles.bufferOverlay} pointerEvents="none">
              <ActivityIndicator size="large" color="#fff" />
            </View>
          )}

          {captionsOn && !!captionLine && (
            <View style={styles.fsCaptionBar} pointerEvents="none">
              <Text style={styles.captionText}>{captionLine}</Text>
            </View>
          )}
        </View>
      </Modal>

      <Modal
        visible={qualityMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setQualityMenuOpen(false)}
      >
        <Pressable
          style={styles.menuOverlay}
          onPress={() => setQualityMenuOpen(false)}
        >
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>Video quality</Text>
            {PREFERENCE_OPTIONS.map((option) => {
              const selected = preference === option.value;
              return (
                <TouchableOpacity
                  key={option.value}
                  style={styles.menuRow}
                  onPress={() => pickPreference(option.value)}
                  activeOpacity={0.8}
                >
                  <View style={styles.menuRowText}>
                    <Text style={styles.menuLabel}>{option.label}</Text>
                    <Text style={styles.menuHint}>{option.hint}</Text>
                  </View>
                  {selected && (
                    <Ionicons name="checkmark" size={18} color="#5f0909" />
                  )}
                </TouchableOpacity>
              );
            })}
            <Text style={styles.menuFooter}>
              Now delivering: {tierLabel(tier)}
            </Text>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const tierLabel = (tier: VideoQualityTier) =>
  VIDEO_QUALITY_TIERS.find((t) => t.tier === tier)?.label ?? tier;

const styles = StyleSheet.create({
  container: {
    height: 260,
    marginVertical: 10,
    overflow: "hidden",
    borderRadius: 18,
    backgroundColor: "#111827",
  },
  video: {
    width: "100%",
    height: "100%",
  },
  muteBadge: {
    position: "absolute",
    left: 10,
    bottom: 10,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  qualityButton: {
    position: "absolute",
    right: 10,
    bottom: 10,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  ccButton: {
    position: "absolute",
    right: 10,
    top: 10,
    minWidth: 30,
    height: 22,
    borderRadius: 5,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  ccButtonOn: {
    backgroundColor: "rgba(255,255,255,0.92)",
    borderColor: "#fff",
  },
  ccText: { color: "#fff", fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  ccTextOn: { color: "#111827" },
  captionPending: {
    position: "absolute",
    left: 10,
    top: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  captionPendingText: { color: "#e7d9cf", fontSize: 10.5, fontWeight: "600" },
  captionBar: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 44,
    alignItems: "center",
  },
  captionText: {
    color: "#fff",
    fontSize: 14,
    lineHeight: 19,
    textAlign: "center",
    backgroundColor: "rgba(0,0,0,0.72)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: "hidden",
  },
  bufferOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  progressTrack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 2.5,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#e0a53d",
  },
  fsRoot: {
    flex: 1,
    backgroundColor: "#000",
  },
  fsTopBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 44,
    paddingBottom: 10,
    paddingHorizontal: 12,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  fsFlex: { flex: 1 },
  fsBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  fsCc: {
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  fsCcOn: {
    backgroundColor: "rgba(255,255,255,0.92)",
    borderColor: "#fff",
  },
  fsCcText: { color: "#fff", fontSize: 13, fontWeight: "800", letterSpacing: 0.5 },
  fsCcTextOn: { color: "#111827" },
  fsCaptionBar: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 72,
    alignItems: "center",
  },
  menuOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10,2,2,0.45)",
    paddingHorizontal: 32,
  },
  menuCard: {
    width: "100%",
    backgroundColor: "#fffaf7",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#ecd6bf",
    paddingVertical: 8,
  },
  menuTitle: {
    color: "#4d1b17",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.3,
    textTransform: "uppercase",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 11,
    gap: 12,
  },
  menuRowText: { flex: 1 },
  menuLabel: { color: "#3f1712", fontSize: 14.5, fontWeight: "700" },
  menuHint: { color: "#8a6c62", fontSize: 12, marginTop: 2 },
  menuFooter: {
    color: "#9b7d72",
    fontSize: 11,
    fontStyle: "italic",
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 10,
  },
});

// app/(main)/GoLiveScreen.tsx
//
// The step before going live.
//
// Separate from the watching screen on purpose. Starting a broadcast is a
// decision — it puts your name and face in front of the whole campus — and a
// screen that asks for a title and waits for a deliberate tap is the last
// point at which somebody can change their mind. Folding it into the viewer
// would mean the camera opens the instant a menu is tapped.
//
// No video is attached here. The stream document is created first, so the feed
// card and the comment room exist before the camera does; whichever provider
// is wired later calls attachLiveVideo() with its identifiers.
import { useThemeColors } from "@/contexts/ThemeContext";
import { isAgoraConfigured } from "@/utils/agoraConfig";
import {
  attachLiveVideo,
  endLiveStream,
  findMyLiveStreams,
  isLiveStreamFresh,
  startLiveStream,
  type LiveStream,
} from "@/utils/liveStreams";
import { getUserData } from "@/utils/rbac";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { auth } from "../../Firebase_configure";

const TITLE_MAX = 120;

/**
 * The live this person already has running, if any.
 *
 * Lives whose host has gone quiet are ended on the way — nobody is on the
 * other end of them, and they are what used to pile up as duplicate cards.
 * A fresh one is returned instead, for the person to resume or end.
 */
async function settleMyLiveStreams(hostId: string): Promise<LiveStream | null> {
  const mine = await findMyLiveStreams(hostId);
  const now = Date.now();
  const stale = mine.filter((stream) => !isLiveStreamFresh(stream, now));
  await Promise.all(stale.map((stream) => endLiveStream(stream.id).catch(() => undefined)));
  return mine.find((stream) => isLiveStreamFresh(stream, now)) ?? null;
}

export default function GoLiveScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const user = auth.currentUser;

  const [title, setTitle] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<{
    name: string;
    avatar: string | null;
    role: string;
  } | null>(null);
  // A live this person already has open. Starting another is blocked until
  // they resume it or end it.
  const [existing, setExisting] = useState<LiveStream | null>(null);
  const [checking, setChecking] = useState(Boolean(user?.uid));
  const [endingExisting, setEndingExisting] = useState(false);

  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    settleMyLiveStreams(user.uid)
      .then((open) => {
        if (!cancelled) setExisting(open);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  const resumeExisting = () => {
    if (!existing) return;
    router.replace({
      pathname: "/(main)/LiveStreamScreen",
      params: { streamId: existing.id },
    } as any);
  };

  const endExisting = async () => {
    if (!existing || endingExisting) return;
    setEndingExisting(true);
    try {
      await endLiveStream(existing.id);
      setExisting(null);
    } catch {
      setError("Could not end your other live. Check your connection and try again.");
    } finally {
      setEndingExisting(false);
    }
  };

  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    getUserData(user.uid)
      .then((data) => {
        if (cancelled || !data) return;
        setHost({
          name:
            `${data.firstname || ""} ${data.lastname || ""}`.trim() ||
            data.email ||
            "Someone",
          avatar: data.profileImage ?? null,
          role: data.role || "student",
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  const start = async () => {
    if (!user?.uid || !host || starting || existing || checking) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Give your stream a title so people know what it is.");
      return;
    }

    setStarting(true);
    setError(null);
    try {
      // Checked again right before creating: another phone signed in to the
      // same account may have gone live since this screen opened.
      const open = await settleMyLiveStreams(user.uid);
      if (open) {
        setExisting(open);
        setStarting(false);
        return;
      }

      const streamId = await startLiveStream({
        hostId: user.uid,
        hostName: host.name,
        hostAvatar: host.avatar,
        hostRole: host.role,
        title: trimmed,
      });

      // The channel is named for the stream, so the two can never drift apart
      // and no second identifier has to be stored or looked up. Attached as a
      // separate write because the id only exists once the document does.
      if (isAgoraConfigured()) {
        await attachLiveVideo(streamId, {
          provider: "agora",
          channelName: streamId,
        }).catch(() => undefined);
      }
      // Replace rather than push: backing out of a live stream should return
      // to the feed, not to the screen that started it.
      router.replace({
        pathname: "/(main)/LiveStreamScreen",
        params: { streamId },
      } as any);
    } catch {
      setError("Could not start the stream. Check your connection and try again.");
      setStarting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          style={styles.iconButton}
          onPress={() => router.back()}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={24} color={theme.onChrome} />
        </Pressable>
        <Text style={styles.headerTitle}>Go Live</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        enabled={Platform.OS !== "web"}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.noticeCard}>
            <Ionicons name="radio-outline" size={22} color={theme.danger} />
            <Text style={styles.noticeText}>
              Your stream appears at the top of the Home feed for everyone on
              campus. Moderators can end it at any time.
              {isAgoraConfigured()
                ? " When you end it, the first 10 minutes are posted to the feed as a replay — keep BondED open while it saves."
                : " Live video is not configured for this build, so viewers will see comments only."}
            </Text>
          </View>

          {existing && (
            <View style={styles.existingCard}>
              <View style={styles.existingHeader}>
                <View style={styles.existingDot} />
                <Text style={styles.existingTitle}>You’re already live</Text>
              </View>
              <Text style={styles.existingText} numberOfLines={2}>
                “{existing.title}” is still running. Go back to it, or end it
                before starting a new one.
              </Text>
              <View style={styles.existingActions}>
                <Pressable
                  style={({ pressed }) => [styles.resumeButton, pressed && styles.pressed]}
                  onPress={resumeExisting}
                  accessibilityRole="button"
                  accessibilityLabel="Resume your live"
                >
                  <Ionicons name="play" size={15} color={theme.onPrimary} />
                  <Text style={styles.resumeButtonText}>Resume</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.endExistingButton, pressed && styles.pressed]}
                  onPress={endExisting}
                  disabled={endingExisting}
                  accessibilityRole="button"
                  accessibilityLabel="End your other live"
                >
                  {endingExisting ? (
                    <ActivityIndicator size="small" color={theme.danger} />
                  ) : (
                    <Text style={styles.endExistingText}>End it</Text>
                  )}
                </Pressable>
              </View>
            </View>
          )}

          <Text style={styles.label}>What is this stream about?</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={(next) => {
              setTitle(next);
              if (error) setError(null);
            }}
            placeholder="e.g. Intramurals opening ceremony"
            placeholderTextColor={theme.textMuted}
            maxLength={TITLE_MAX}
            multiline
            autoFocus
          />
          <Text style={styles.counter}>
            {title.length}/{TITLE_MAX}
          </Text>

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[
              styles.goButton,
              (!title.trim() || starting || !!existing || checking) && styles.goButtonIdle,
            ]}
            onPress={start}
            disabled={!title.trim() || starting || !host || !!existing || checking}
          >
            {starting || checking ? (
              <ActivityIndicator color={theme.onPrimary} />
            ) : (
              <>
                <Ionicons name="videocam" size={19} color={theme.onPrimary} />
                <Text style={styles.goButtonText}>Start streaming</Text>
              </>
            )}
          </Pressable>

          <Text style={styles.hint}>
            You can end the stream at any time from the stream screen.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 12,
      backgroundColor: c.chrome,
    },
    iconButton: {
      width: 34,
      height: 34,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: {
      flex: 1,
      textAlign: "center",
      color: c.onChrome,
      fontSize: 17,
      fontWeight: "800",
    },
    headerSpacer: { width: 34 },

    content: { padding: 18, gap: 12 },
    noticeCard: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 11,
      backgroundColor: c.dangerSoft,
      borderRadius: 14,
      padding: 14,
      marginBottom: 4,
    },
    noticeText: { flex: 1, color: c.textSecondary, fontSize: 13, lineHeight: 19 },

    existingCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.borderStrong,
      padding: 14,
      gap: 8,
    },
    existingHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
    existingDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: c.danger },
    existingTitle: { color: c.textPrimary, fontSize: 15, fontWeight: "800" },
    existingText: { color: c.textSecondary, fontSize: 13, lineHeight: 19 },
    existingActions: { flexDirection: "row", gap: 10, marginTop: 4 },
    resumeButton: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      minHeight: 42,
      borderRadius: 12,
      backgroundColor: c.primary,
    },
    resumeButtonText: { color: c.onPrimary, fontSize: 14, fontWeight: "800" },
    endExistingButton: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 42,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.danger,
    },
    endExistingText: { color: c.danger, fontSize: 14, fontWeight: "800" },
    pressed: { opacity: 0.8 },

    label: { color: c.textPrimary, fontSize: 14.5, fontWeight: "800" },
    input: {
      minHeight: 88,
      backgroundColor: c.surfaceSunken,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: c.textPrimary,
      fontSize: 15.5,
      textAlignVertical: "top",
    },
    counter: { alignSelf: "flex-end", color: c.textMuted, fontSize: 11.5 },
    error: { color: c.danger, fontSize: 13 },

    goButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
      marginTop: 8,
      paddingVertical: 15,
      borderRadius: 15,
      backgroundColor: c.danger,
    },
    goButtonIdle: { opacity: 0.55 },
    goButtonText: { color: c.onPrimary, fontSize: 16, fontWeight: "900" },
    hint: {
      color: c.textMuted,
      fontSize: 12.5,
      textAlign: "center",
      marginTop: 4,
    },
  });

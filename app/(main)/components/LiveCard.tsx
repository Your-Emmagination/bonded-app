// app/(main)/components/LiveCard.tsx
//
// The "someone is live" row in the Home feed.
//
// Deliberately louder than a post card and deliberately smaller. A live stream
// is worth interrupting the feed for, but only while it is happening — so the
// card leans on the one thing a post can never show, which is that this is
// going on right now. Hence the pulsing dot and the running viewer count
// rather than a large preview image.
import { useThemeColors } from "@/contexts/ThemeContext";
import { avatarThumb } from "@/utils/cloudinaryImages";
import type { LiveStream } from "@/utils/liveStreams";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

type LiveCardProps = {
  stream: LiveStream;
  onPress: (stream: LiveStream) => void;
};

/** "2.4k watching" reads better than a five-digit number on a small card. */
const formatViewers = (count: number) => {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
};

export default function LiveCard({ stream, onPress }: LiveCardProps) {
  const { styles, theme } = useStyles();

  // The dot breathes rather than blinks. A hard on/off draws the eye away from
  // the feed every second, which is too aggressive for something the reader
  // may well scroll past.
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 850, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => cancelAnimation(pulse);
  }, [pulse]);

  const dotStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.value, [0, 1], [1, 0.35]),
    transform: [{ scale: interpolate(pulse.value, [0, 1], [1, 1.35]) }],
  }));

  const avatar = stream.hostAvatar ? avatarThumb(stream.hostAvatar) : null;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => onPress(stream)}
      accessibilityRole="button"
      accessibilityLabel={`${stream.hostName} is live: ${stream.title}`}
    >
      <View style={styles.avatarRing}>
        {avatar ? (
          <Image source={{ uri: avatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarInitial}>
              {(stream.hostName[0] || "?").toUpperCase()}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.body}>
        <View style={styles.badgeRow}>
          <View style={styles.liveBadge}>
            <Reanimated.View style={[styles.liveDot, dotStyle]} />
            <Text style={styles.liveBadgeText}>LIVE</Text>
          </View>
          <View style={styles.viewerPill}>
            <Ionicons name="eye-outline" size={12} color={theme.textMuted} />
            <Text style={styles.viewerText}>
              {formatViewers(stream.viewerCount)}
            </Text>
          </View>
        </View>

        <Text style={styles.title} numberOfLines={1}>
          {stream.title}
        </Text>
        <Text style={styles.host} numberOfLines={1}>
          {stream.hostName}
        </Text>
      </View>

      <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
    </Pressable>
  );
}

/** Themed stylesheet for this component. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: c.surface,
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    cardPressed: { backgroundColor: c.surfaceSunken },
    avatarRing: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2.5,
      borderColor: c.danger,
    },
    avatar: { width: 44, height: 44, borderRadius: 22 },
    avatarFallback: {
      backgroundColor: c.surfaceSunken,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarInitial: { color: c.textSecondary, fontSize: 18, fontWeight: "800" },
    body: { flex: 1, minWidth: 0, gap: 3 },
    badgeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    liveBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: c.danger,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    liveDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: c.onPrimary,
    },
    liveBadgeText: {
      color: c.onPrimary,
      fontSize: 10,
      fontWeight: "900",
      letterSpacing: 0.6,
    },
    viewerPill: { flexDirection: "row", alignItems: "center", gap: 4 },
    viewerText: { color: c.textMuted, fontSize: 12, fontWeight: "700" },
    title: { color: c.textPrimary, fontSize: 15, fontWeight: "800" },
    host: { color: c.textMuted, fontSize: 12.5 },
  });

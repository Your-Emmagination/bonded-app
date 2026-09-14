import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import React, { useEffect, useMemo, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { avatarThumb } from "@/utils/cloudinaryImages";

export default function ChatTypingIndicator({ name, avatar }: { name: string; avatar?: string | null }) {
  const { styles } = useStyles();
  const [dots] = useState(() => [new Animated.Value(0.3), new Animated.Value(0.3), new Animated.Value(0.3)]);
  useEffect(() => {
    const animation = Animated.loop(Animated.stagger(130, dots.map((value) => Animated.sequence([
      Animated.timing(value, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.timing(value, { toValue: 0.3, duration: 280, useNativeDriver: true }),
      Animated.delay(260),
    ]))));
    animation.start();
    return () => animation.stop();
  }, [dots]);
  return <View style={styles.row} accessibilityLabel={`${name} is typing`} accessibilityLiveRegion="polite">
    {avatar ? <Image source={{ uri: avatarThumb(avatar, 28) }} style={styles.avatar} />
      : <View style={[styles.avatar, styles.initial]}><Text>{name[0]?.toUpperCase() || "?"}</Text></View>}
    <View style={styles.bubble}>{dots.map((opacity, index) => <Animated.View key={index} style={[styles.dot, { opacity }]} />)}</View>
  </View>;
}
const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 6 },
  avatar: { width: 28, height: 28, borderRadius: 14 },
  initial: { alignItems: "center", justifyContent: "center", backgroundColor: c.surfaceSunken },
  bubble: { flexDirection: "row", gap: 5, paddingHorizontal: 15, paddingVertical: 13, backgroundColor: c.surfaceSunken, borderRadius: 18 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.textMuted },
});

/** Themed stylesheet for this file. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

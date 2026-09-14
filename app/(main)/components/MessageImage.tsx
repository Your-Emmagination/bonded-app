// app/(main)/components/MessageImage.tsx
//
// A photo or video thumbnail inside a chat bubble, shaped to the picture.
//
// Both chat screens used to draw media into a fixed box — 180pt tall in
// server channels, a hardcoded 220x160 in direct messages — and fill it with
// `contentFit: "cover"`. Cover keeps the box and throws away whatever does
// not fit, so a portrait photo lost its top and bottom and a wide one lost
// its sides. That is the cropping people noticed at the edges.
//
// Here the width is fixed and the height follows the image's own ratio, the
// way Messenger and Telegram do it.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Image } from "expo-image";
import React, { useMemo, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

/**
 * Beyond these the picture stops being shown whole.
 *
 * Without a clamp a full-length phone screenshot — around 9:19.5 — would be
 * taller than the screen and push every other message out of view, and a
 * panorama would become an unreadable sliver. Past the limits it falls back
 * to cropping, exactly as Messenger does; the full image is still one tap
 * away in the viewer.
 */
const MIN_ASPECT = 0.55; // tallest allowed, a little narrower than 9:16
const MAX_ASPECT = 1.9; // widest allowed, a little wider than 16:9

/** Used until the real ratio is known, so the bubble does not start as a sliver. */
const FALLBACK_ASPECT = 4 / 3;

type MessageImageProps = {
  uri: string;
  /** Width of the bubble's media column. Height is derived from it. */
  width: number;
  /** Real pixel size, when the sender's client recorded it at upload. */
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  style?: StyleProp<ViewStyle>;
  /** Passed through so FlatList recycling does not show the previous photo. */
  recyclingKey?: string;
};

export default function MessageImage({
  uri,
  width,
  sourceWidth,
  sourceHeight,
  style,
  recyclingKey,
}: MessageImageProps) {
  const { styles } = useStyles();
  // Messages sent before dimensions were stored have none, so the image is
  // measured as it loads instead. That settles a moment after it appears;
  // anything sent since arrives already the right shape.
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(
    null,
  );

  const known =
    sourceWidth && sourceHeight
      ? { width: sourceWidth, height: sourceHeight }
      : measured;

  const { aspect, cropped } = useMemo(() => {
    if (!known?.width || !known?.height) {
      return { aspect: FALLBACK_ASPECT, cropped: false };
    }
    const raw = known.width / known.height;
    const clamped = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, raw));
    // Only crop when the clamp actually had to change the shape.
    return { aspect: clamped, cropped: Math.abs(clamped - raw) > 0.001 };
  }, [known?.width, known?.height]);

  return (
    <View style={[styles.frame, { width, aspectRatio: aspect }, style]}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        // "contain" once the shape is known, because the frame already matches
        // the picture and nothing needs trimming. Only a clamped extreme
        // falls back to cover.
        contentFit={cropped ? "cover" : "contain"}
        recyclingKey={recyclingKey}
        onLoad={(event) => {
          // expo-image reports the source's natural size here. Skipped when
          // the sender already told us, to avoid a needless re-render.
          if (sourceWidth && sourceHeight) return;
          const { width: w, height: h } = event.source ?? {};
          if (w && h) setMeasured({ width: w, height: h });
        }}
      />
    </View>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  frame: {
    borderRadius: 14,
    overflow: "hidden",
    // Shows through while the image loads and behind a "contain" fit, so a
    // photo never appears on a bare white gap.
    backgroundColor: c.surfaceSunken,
  },
});

/** Themed stylesheet for this file. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

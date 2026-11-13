// app/(main)/components/ShapedGif.tsx
//
// A GIF at its own shape. Comments and replies used to force every GIF into
// a fixed box and crop it to fill, so a tall or wide one lost its edges. The
// GIF's real size isn't saved with it, so it's measured when it loads; until
// then it holds a typical 4:3 shape.
import { Image } from "expo-image";
import React, { useState } from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";

type ShapedGifProps = {
  uri: string;
  placeholderUri?: string | null;
  /** How wide it may be: a number, or "100%" to fill its container. */
  width: number | "100%";
  /** Tall GIFs stop here and are shown whole, with space either side. */
  maxHeight: number;
  backgroundColor: string;
  style?: StyleProp<ViewStyle>;
};

const DEFAULT_RATIO = 4 / 3;

export default function ShapedGif({
  uri,
  placeholderUri,
  width,
  maxHeight,
  backgroundColor,
  style,
}: ShapedGifProps) {
  // Width ÷ height, once the GIF has loaded.
  const [ratio, setRatio] = useState<number>(DEFAULT_RATIO);

  return (
    <View style={[{ width, maxWidth: "100%" }, style]}>
      <Image
        source={{ uri }}
        placeholder={placeholderUri ? { uri: placeholderUri } : undefined}
        placeholderContentFit="contain"
        contentFit="contain"
        recyclingKey={uri}
        onLoad={(event) => {
          const { width: w, height: h } = event.source;
          if (w > 0 && h > 0) setRatio(w / h);
        }}
        style={[styles.gif, { aspectRatio: ratio, maxHeight, backgroundColor }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  gif: { width: "100%" },
});

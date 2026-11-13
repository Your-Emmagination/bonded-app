// app/(main)/components/PostMediaCarousel.tsx
//
// A post's photos and videos, Threads-style: one strip at a shared height,
// portrait cards narrower, the next card peeking in, only the video in view
// playing (muted). With several items, tapping any of them opens one
// fullscreen viewer that swipes through all of them, starting at that one.
// Double-tap a photo to like the post.
import { useThemeColors } from "@/contexts/ThemeContext";
import { FEED_IMAGE_WIDTH, feedImage } from "@/utils/cloudinaryImages";
import { normalizeCaptions, type CaptionStatus } from "@/utils/videoCaptions";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useIsFocused } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, ScrollView, StyleSheet, TouchableOpacity, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import HorizontalSwipeRegion from "./HorizontalSwipeRegion";
import VideoPostMedia from "./VideoPostMedia";

type MediaFile = { url: string; mimeType: string };
type Props = {
  files: MediaFile[];
  width: number;
  postId: string;
  compact?: boolean;
  cardVisible?: boolean;
  captionStatus?: CaptionStatus;
  captions?: unknown;
  onImagePress?: (images: string[], startIndex: number, postId?: string) => void;
  /** Double-tap a photo: like the post (the card leaves an existing like alone). */
  onDoubleTapLike?: () => void;
};

const GAP = 8;
/** A second tap within this long is a double-tap; a single tap waits for it. */
const DOUBLE_TAP_MS = 260;

function MediaItem({
  item, width, height, active, cardVisible, captions, captionStatus, onRatio, onOpen, openVideoInViewer, onDoubleTap, label,
}: {
  item: MediaFile;
  width: number;
  height: number;
  active: boolean;
  cardVisible?: boolean;
  captions: ReturnType<typeof normalizeCaptions>;
  captionStatus?: CaptionStatus;
  onRatio: (url: string, ratio: number) => void;
  /** Opens the fullscreen viewer at this item. */
  onOpen: () => void;
  /** A video opens the shared viewer (several items) or its own player (just one). */
  openVideoInViewer: boolean;
  onDoubleTap?: () => void;
  label: string;
}) {
  const theme = useThemeColors();
  const focused = useIsFocused();
  const reportRatio = useCallback((ratio: number) => onRatio(item.url, ratio), [item.url, onRatio]);
  const video = item.mimeType.startsWith("video/");

  // One tap opens the photo; two like the post. The single tap waits a
  // moment to see whether a second is coming.
  const lastTapRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    },
    [],
  );
  const [heart] = useState(() => new Animated.Value(0));
  const popHeart = useCallback(() => {
    heart.setValue(0);
    Animated.sequence([
      Animated.spring(heart, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }),
      Animated.delay(320),
      Animated.timing(heart, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [heart]);
  const handleImagePress = () => {
    if (!onDoubleTap) {
      onOpen();
      return;
    }
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      onDoubleTap();
      popHeart();
      return;
    }
    lastTapRef.current = now;
    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = null;
      onOpen();
    }, DOUBLE_TAP_MS);
  };

  return (
    <View style={[styles.card, { width, height, backgroundColor: theme.surfaceSunken }]}>
      {video ? (
        <VideoPostMedia
          uri={item.url}
          width={width}
          height={height}
          onAspectRatio={reportRatio}
          feedAutoplay={cardVisible !== undefined}
          isPlaying={focused && active && (cardVisible ?? true)}
          captions={captions}
          captionStatus={captionStatus}
          onOpenFullscreen={openVideoInViewer ? onOpen : undefined}
        />
      ) : (
        <TouchableOpacity
          style={styles.fill}
          activeOpacity={0.95}
          onPress={handleImagePress}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={onDoubleTap ? "Open fullscreen. Double-tap to like." : "Open fullscreen"}
        >
          <Image
            recyclingKey={item.url}
            source={{ uri: feedImage(item.url, FEED_IMAGE_WIDTH) }}
            style={styles.fill}
            contentFit="contain"
            onLoad={({ source }) => {
              if (source.width > 0 && source.height > 0) reportRatio(source.width / source.height);
            }}
          />
          <Animated.View
            pointerEvents="none"
            style={[
              styles.heart,
              {
                opacity: heart,
                transform: [{ scale: heart.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }],
              },
            ]}
          >
            <Ionicons name="heart" size={84} color="#ffffff" />
          </Animated.View>
        </TouchableOpacity>
      )}
    </View>
  );
}

/** One shared-height strip: portrait cards are narrower and the next card peeks in. */
export default function PostMediaCarousel({
  files, width, postId, compact = false, cardVisible, captions, captionStatus, onImagePress, onDoubleTapLike,
}: Props) {
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollX = useRef(0);
  const safeCaptions = useMemo(() => normalizeCaptions(captions), [captions]);
  const multiple = files.length > 1;
  // What the fullscreen viewer swipes through: with several items, all of
  // them (photos and videos, in order); with one photo, just that.
  const viewerUrls = useMemo(() => files.map((item) => item.url), [files]);
  const aspectRatios = files.map((item) => ratios[item.url] ?? (item.mimeType.startsWith("video/") ? 16 / 9 : 4 / 5));
  // Keep ordinary landscape and portrait media uncropped at a shared height.
  // Extreme panoramas/tall images fit inside bounded cards instead of dominating the feed.
  const maxWidth = Math.max(1, width - 28);
  const widestRatio = Math.min(16 / 9, Math.max(1, ...aspectRatios));
  const height = Math.round(Math.min(compact ? 180 : 300, width * (compact ? 0.62 : 0.88), maxWidth / widestRatio));
  const widths = aspectRatios.map((ratio) => {
    return multiple
      ? Math.round(Math.max(width * 0.32, Math.min(maxWidth, height * ratio)))
      : width;
  });
  const itemOffsets: number[] = [];
  let total = 0;
  widths.forEach((itemWidth, index) => {
    itemOffsets.push(total);
    total += itemWidth + (index < widths.length - 1 ? GAP : 0);
  });
  // The content ends with the final card. Clamp snap points to its real scroll
  // limit so the last card stays at the right edge without a blank trailing page.
  const maxScroll = Math.max(0, total - width);
  const snapOffsets = itemOffsets
    .map((offset) => Math.min(offset, maxScroll))
    .filter((offset, index, values) => index === 0 || offset > values[index - 1]);
  const reportRatio = useCallback((url: string, ratio: number) => {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    setRatios((previous) => Math.abs((previous[url] ?? 0) - ratio) < 0.01
      ? previous : { ...previous, [url]: ratio });
  }, []);
  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollX.current = Math.min(maxScroll, Math.max(0, event.nativeEvent.contentOffset.x));
    let closest = 0;
    if (multiple && maxScroll > 0 && scrollX.current >= maxScroll - 1) {
      closest = files.length - 1;
    } else {
      itemOffsets.forEach((offset, index) => {
        if (Math.abs(offset - scrollX.current) < Math.abs(itemOffsets[closest] - scrollX.current)) closest = index;
      });
    }
    setActiveIndex((previous) => previous === closest ? previous : closest);
  };

  // Several items swipe sideways, so a swipe on them is theirs — on Home it
  // never opens Community. A single photo doesn't swipe, so it needs no guard.
  return (
    <HorizontalSwipeRegion enabled={multiple}>
    <ScrollView
      horizontal
      style={[styles.strip, { width }]}
      contentContainerStyle={{ gap: GAP }}
      showsHorizontalScrollIndicator={false}
      scrollEnabled={multiple}
      snapToOffsets={snapOffsets}
      snapToAlignment="start"
      decelerationRate="fast"
      directionalLockEnabled
      nestedScrollEnabled
      bounces={false}
      overScrollMode="never"
      onScroll={handleScroll}
      scrollEventThrottle={32}
    >
      {files.map((item, index) => (
        <MediaItem
          key={`${item.url}-${index}`}
          item={item}
          width={widths[index]}
          height={multiple ? height : compact ? height : Math.min(420, width / (ratios[item.url] ?? (item.mimeType.startsWith("video/") ? 16 / 9 : 4 / 5)))}
          active={index === activeIndex}
          cardVisible={cardVisible}
          captions={safeCaptions}
          captionStatus={captionStatus}
          onRatio={reportRatio}
          label={`${item.mimeType.startsWith("video/") ? "Video" : "Photo"} ${index + 1} of ${files.length}`}
          onOpen={() => onImagePress?.(viewerUrls, index, postId)}
          openVideoInViewer={multiple && !!onImagePress}
          onDoubleTap={onDoubleTapLike}
        />
      ))}
    </ScrollView>
    </HorizontalSwipeRegion>
  );
}

const styles = StyleSheet.create({
  strip: { marginVertical: 10 },
  card: { borderRadius: 18, overflow: "hidden" },
  fill: { width: "100%", height: "100%" },
  heart: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
  },
});

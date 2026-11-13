// app/(main)/components/HomeLiveSection.tsx
//
// TikTok / Instagram style Live section on Home:
// 1. Horizontal stories row with vibrant animated pulsing red rings and LIVE badges.
// 2. Click to open a bottom sheet showing all current live broadcasters.
// 3. Completely hidden when no one is live.

import React, { useEffect, useMemo } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import Reanimated, {
  cancelAnimation,
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import type { LiveStream } from "@/utils/liveStreams";
import { avatarThumb } from "@/utils/cloudinaryImages";
import HorizontalSwipeRegion from "./HorizontalSwipeRegion";
import DragToCloseSheet from "./DragToCloseSheet";

type HomeLiveSectionProps = {
  streams: LiveStream[];
  onOpenStream: (stream: LiveStream) => void;
  isSheetOpen: boolean;
  onOpenSheet: () => void;
  onCloseSheet: () => void;
};

const formatViewers = (count: number) => {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
};

/** A single story-style avatar circle (Instagram/TikTok live style). */
function LiveStoryItem({
  stream,
  onPress,
  pulse,
}: {
  stream: LiveStream;
  onPress: (stream: LiveStream) => void;
  pulse: SharedValue<number>;
}) {
  const { styles, theme } = useStyles();
  const avatar = stream.hostAvatar ? avatarThumb(stream.hostAvatar) : null;

  const ringAnimStyle = useAnimatedStyle(() => ({
    borderColor: "#e11d48",
    opacity: interpolate(pulse.value, [0, 1], [0.75, 1]),
    transform: [{ scale: interpolate(pulse.value, [0, 1], [1, 1.05]) }],
  }));

  return (
    <Pressable
      style={({ pressed }) => [styles.storyItem, pressed && styles.storyItemPressed]}
      onPress={() => onPress(stream)}
      accessibilityRole="button"
      accessibilityLabel={`${stream.hostName} is live: ${stream.title}`}
    >
      <View style={styles.storyAvatarContainer}>
        <Reanimated.View style={[styles.storyRing, ringAnimStyle]}>
          {avatar ? (
            <Image source={{ uri: avatar }} style={styles.storyAvatar} />
          ) : (
            <View style={[styles.storyAvatar, styles.storyAvatarFallback]}>
              <Text style={styles.storyAvatarInitial}>
                {(stream.hostName[0] || "?").toUpperCase()}
              </Text>
            </View>
          )}
        </Reanimated.View>
        <View style={styles.storyLiveBadge}>
          <Text style={styles.storyLiveBadgeText}>LIVE</Text>
        </View>
      </View>

      <Text style={styles.storyHostName} numberOfLines={1}>
        {stream.hostName}
      </Text>

      <View style={styles.storyViewerChip}>
        <Ionicons name="eye" size={10} color="#e11d48" />
        <Text style={styles.storyViewerText}>
          {formatViewers(stream.viewerCount)}
        </Text>
      </View>
    </Pressable>
  );
}

export default function HomeLiveSection({
  streams,
  onOpenStream,
  isSheetOpen,
  onOpenSheet,
  onCloseSheet,
}: HomeLiveSectionProps) {
  const { styles, theme } = useStyles();

  // Subtle breathing pulse for live indicators
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

  // When no one is live, hide the entire section completely
  if (!streams || streams.length === 0) {
    return null;
  }

  return (
    <>
      <View style={styles.container}>
        {/* Section Header */}
        <View style={styles.headerRow}>
          <View style={styles.titleGroup}>
            <View style={styles.liveDotWrap}>
              <Reanimated.View style={[styles.pulseDot, dotStyle]} />
            </View>
            <Text style={styles.sectionTitle}>LIVE NOW</Text>
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{streams.length}</Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.seeAllButton}
            onPress={onOpenSheet}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="View all live streams"
          >
            <Text style={styles.seeAllText}>View list</Text>
            <Ionicons name="chevron-forward" size={14} color={theme.accent} />
          </TouchableOpacity>
        </View>

        {/* Option A: Horizontal Stories Row */}
        <HorizontalSwipeRegion>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.storyListContent}
          >
            {streams.map((stream) => (
              <LiveStoryItem
                key={stream.id}
                stream={stream}
                onPress={onOpenStream}
                pulse={pulse}
              />
            ))}
          </ScrollView>
        </HorizontalSwipeRegion>
      </View>

      {/* Option B: Live Broadcasters Bottom Sheet */}
      <DragToCloseSheet
        visible={isSheetOpen}
        onClose={onCloseSheet}
        handleColor={theme.borderStrong}
        closeLabel="Close live streams list"
        sheetStyle={styles.sheetContainer}
        header={
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitleRow}>
              <Ionicons name="videocam" size={20} color="#e11d48" />
              <Text style={styles.sheetTitle}>
                Live Broadcasters ({streams.length})
              </Text>
            </View>
            <TouchableOpacity
              onPress={onCloseSheet}
              style={styles.sheetCloseButton}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={22} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
        }
      >
        <FlatList
          data={streams}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.sheetListContent}
          renderItem={({ item }) => {
            const avatar = item.hostAvatar ? avatarThumb(item.hostAvatar) : null;
            return (
              <TouchableOpacity
                style={styles.sheetItemRow}
                onPress={() => {
                  onCloseSheet();
                  onOpenStream(item);
                }}
                activeOpacity={0.75}
              >
                <View style={styles.sheetItemAvatarContainer}>
                  <View style={styles.sheetItemRing}>
                    {avatar ? (
                      <Image source={{ uri: avatar }} style={styles.sheetItemAvatar} />
                    ) : (
                      <View style={[styles.sheetItemAvatar, styles.storyAvatarFallback]}>
                        <Text style={styles.storyAvatarInitial}>
                          {(item.hostName[0] || "?").toUpperCase()}
                        </Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.sheetItemLiveBadge}>
                    <Text style={styles.sheetItemLiveText}>LIVE</Text>
                  </View>
                </View>

                <View style={styles.sheetItemInfo}>
                  <Text style={styles.sheetItemHostName} numberOfLines={1}>
                    {item.hostName}
                  </Text>
                  <Text style={styles.sheetItemStreamTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <View style={styles.sheetItemViewerRow}>
                    <Ionicons name="eye" size={12} color="#e11d48" />
                    <Text style={styles.sheetItemViewerText}>
                      {formatViewers(item.viewerCount)} watching
                    </Text>
                  </View>
                </View>

                <View style={styles.watchPill}>
                  <Ionicons name="play" size={13} color={theme.onAccent} />
                  <Text style={styles.watchPillText}>Watch</Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </DragToCloseSheet>
    </>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    container: {
      marginHorizontal: 16,
      marginTop: 10,
      marginBottom: 10,
      paddingVertical: 12,
      borderRadius: 18,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: "rgba(225, 29, 72, 0.2)",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 6,
      elevation: 2,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      marginBottom: 10,
    },
    titleGroup: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    liveDotWrap: {
      width: 12,
      height: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    pulseDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: "#e11d48",
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: "800",
      letterSpacing: 0.6,
      color: "#e11d48",
    },
    countBadge: {
      backgroundColor: "rgba(225, 29, 72, 0.12)",
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 10,
    },
    countBadgeText: {
      fontSize: 11,
      fontWeight: "700",
      color: "#e11d48",
    },
    seeAllButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      paddingVertical: 2,
      paddingHorizontal: 4,
    },
    seeAllText: {
      fontSize: 12.5,
      fontWeight: "600",
      color: c.accent,
    },
    storyListContent: {
      paddingHorizontal: 10,
      gap: 12,
    },
    storyItem: {
      alignItems: "center",
      width: 74,
    },
    storyItemPressed: {
      opacity: 0.82,
    },
    storyAvatarContainer: {
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 5,
    },
    storyRing: {
      width: 62,
      height: 62,
      borderRadius: 31,
      borderWidth: 2.4,
      borderColor: "#e11d48",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceSunken,
      padding: 2,
    },
    storyAvatar: {
      width: 52,
      height: 52,
      borderRadius: 26,
    },
    storyAvatarFallback: {
      backgroundColor: c.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    storyAvatarInitial: {
      color: c.onAccent,
      fontSize: 18,
      fontWeight: "800",
    },
    storyLiveBadge: {
      position: "absolute",
      bottom: -4,
      backgroundColor: "#e11d48",
      paddingHorizontal: 5,
      paddingVertical: 1,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: c.surface,
    },
    storyLiveBadgeText: {
      color: "#ffffff",
      fontSize: 8.5,
      fontWeight: "900",
      letterSpacing: 0.5,
    },
    storyHostName: {
      fontSize: 12,
      fontWeight: "600",
      color: c.textPrimary,
      textAlign: "center",
      width: "100%",
    },
    storyViewerChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      marginTop: 2,
    },
    storyViewerText: {
      fontSize: 10.5,
      fontWeight: "500",
      color: c.textMuted,
    },
    sheetContainer: {
      height: "70%",
      maxHeight: 620,
      backgroundColor: c.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      overflow: "hidden",
    },
    sheetHeader: {
      width: "100%",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    sheetTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    sheetTitle: {
      fontSize: 17,
      fontWeight: "700",
      color: c.textPrimary,
    },
    sheetCloseButton: {
      padding: 4,
    },
    sheetListContent: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 12,
    },
    sheetItemRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surfaceSunken,
      padding: 12,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      gap: 12,
    },
    sheetItemAvatarContainer: {
      alignItems: "center",
      justifyContent: "center",
    },
    sheetItemRing: {
      width: 52,
      height: 52,
      borderRadius: 26,
      borderWidth: 2,
      borderColor: "#e11d48",
      alignItems: "center",
      justifyContent: "center",
      padding: 2,
    },
    sheetItemAvatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
    },
    sheetItemLiveBadge: {
      position: "absolute",
      bottom: -3,
      backgroundColor: "#e11d48",
      paddingHorizontal: 4,
      paddingVertical: 0.5,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: c.surface,
    },
    sheetItemLiveText: {
      color: "#ffffff",
      fontSize: 7.5,
      fontWeight: "900",
    },
    sheetItemInfo: {
      flex: 1,
      gap: 2,
    },
    sheetItemHostName: {
      fontSize: 14.5,
      fontWeight: "700",
      color: c.textPrimary,
    },
    sheetItemStreamTitle: {
      fontSize: 12.5,
      color: c.textSecondary,
    },
    sheetItemViewerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 2,
    },
    sheetItemViewerText: {
      fontSize: 11.5,
      fontWeight: "600",
      color: "#e11d48",
    },
    watchPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: c.accent,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 20,
    },
    watchPillText: {
      color: c.onAccent,
      fontSize: 12.5,
      fontWeight: "700",
    },
  });

const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

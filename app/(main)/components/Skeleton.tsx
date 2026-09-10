// Skeleton loaders — gray placeholder shapes with a looping shimmer sweep,
// used in place of a bare centered ActivityIndicator for initial content /
// list loading. Built on react-native-reanimated so the shimmer runs on the
// native UI thread.
//
// Building blocks:
//   <SkeletonBlock />   generic rounded rectangle
//   <SkeletonCircle />  circle (avatars / icons)
//   <SkeletonGroup>     shimmer-sync provider + "taking longer than usual"
//                       fallback after a timeout
// Screen layouts (composed from the blocks):
//   <FeedSkeleton />          post-card shaped rows (Home feed, profile posts)
//   <ListSkeleton />          avatar + 1–2 text lines rows (list screens)
//   <ProfileHeaderSkeleton /> avatar + name + stat blocks
//   <DashboardSkeleton />     header + stat grid + action rows
//   <ChatSkeleton />          alternating chat bubble blocks
import React, {
    createContext,
    useContext,
    useEffect,
    useState,
} from "react";
import {
    LayoutChangeEvent,
    StyleProp,
    StyleSheet,
    Text,
    View,
    ViewStyle,
} from "react-native";
import Reanimated, {
    cancelAnimation,
    Easing,
    interpolate,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from "react-native-reanimated";

// Warm grey that reads as "placeholder" against the app's cream surfaces.
const SKELETON_BASE = "#e9ddd5";
const SKELETON_HIGHLIGHT = "rgba(255, 255, 255, 0.55)";
const SWEEP_DURATION_MS = 1150;
// After this long the shimmer is joined by a quiet "still working" line so a
// genuinely hung load doesn't just shimmer forever.
const DEFAULT_SLOW_TIMEOUT_MS = 6000;

type ShimmerValue = ReturnType<typeof useSharedValue<number>>;
const ShimmerContext = createContext<ShimmerValue | null>(null);

/** One shared 0→1 loop, so every block in a group shimmers in sync. */
function useShimmerProgress(): ShimmerValue {
  const fromContext = useContext(ShimmerContext);
  const local = useSharedValue(0);

  useEffect(() => {
    if (fromContext) return; // a parent SkeletonGroup already drives one
    local.value = withRepeat(
      withTiming(1, { duration: SWEEP_DURATION_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(local);
  }, [fromContext, local]);

  return fromContext ?? local;
}

type SkeletonBlockProps = {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

/** Generic shimmering rounded rectangle. */
export function SkeletonBlock({
  width,
  height = 14,
  radius = 7,
  style,
}: SkeletonBlockProps) {
  const progress = useShimmerProgress();
  const measured = useSharedValue(0);

  const onLayout = (event: LayoutChangeEvent) => {
    measured.value = event.nativeEvent.layout.width;
  };

  const bandStyle = useAnimatedStyle(() => {
    const w = measured.value;
    const band = w * 0.45;
    return {
      width: band,
      opacity: w
        ? interpolate(progress.value, [0, 0.5, 1], [0, 0.85, 0])
        : 0,
      transform: [
        { translateX: interpolate(progress.value, [0, 1], [-band, w]) },
        { skewX: "-18deg" },
      ],
    };
  });

  return (
    <View
      onLayout={onLayout}
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: SKELETON_BASE,
          overflow: "hidden",
        },
        style,
      ]}
    >
      <Reanimated.View
        pointerEvents="none"
        style={[styles.shimmerBand, bandStyle]}
      />
    </View>
  );
}

export function SkeletonCircle({
  size,
  style,
}: {
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <SkeletonBlock width={size} height={size} radius={size / 2} style={style} />
  );
}

/**
 * Wraps a set of skeletons: keeps their shimmer in sync and, after
 * `timeoutMs`, adds a subtle "this is taking longer than usual" line so a
 * stuck load has a visible signal instead of shimmering forever.
 */
export function SkeletonGroup({
  children,
  timeoutMs = DEFAULT_SLOW_TIMEOUT_MS,
  slowMessage = "This is taking longer than usual…",
  style,
}: {
  children: React.ReactNode;
  timeoutMs?: number | null;
  slowMessage?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const progress = useSharedValue(0);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: SWEEP_DURATION_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [progress]);

  useEffect(() => {
    if (timeoutMs == null) return;
    const id = setTimeout(() => setSlow(true), timeoutMs);
    return () => clearTimeout(id);
  }, [timeoutMs]);

  return (
    <ShimmerContext.Provider value={progress}>
      <View style={style}>
        {children}
        {slow && (
          <Text style={styles.slowText} accessibilityLiveRegion="polite">
            {slowMessage}
          </Text>
        )}
      </View>
    </ShimmerContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Screen-shaped layouts                                              */
/* ------------------------------------------------------------------ */

/** One post-card-shaped skeleton — mirrors PostCard's hanging layout. */
export function PostCardSkeleton() {
  return (
    <View style={styles.postCard}>
      <View style={styles.postRow}>
        <SkeletonCircle size={40} style={{ marginRight: 12 }} />
        <View style={styles.postBody}>
          <SkeletonBlock width="55%" height={13} />
          <SkeletonBlock width="35%" height={10} style={{ marginTop: 7 }} />
          <SkeletonBlock width="92%" height={12} style={{ marginTop: 14 }} />
          <SkeletonBlock width="80%" height={12} style={{ marginTop: 8 }} />
          <SkeletonBlock
            width="100%"
            height={170}
            radius={14}
            style={{ marginTop: 14 }}
          />
          <View style={styles.postActionsRow}>
            <SkeletonCircle size={18} />
            <SkeletonCircle size={18} />
            <SkeletonCircle size={18} />
          </View>
        </View>
      </View>
    </View>
  );
}

export function FeedSkeleton({
  count = 4,
  style,
}: {
  count?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <SkeletonGroup style={style}>
      {Array.from({ length: count }).map((_, i) => (
        <PostCardSkeleton key={i} />
      ))}
    </SkeletonGroup>
  );
}

/** One list row — avatar/icon circle + one or two text lines. */
export function ListRowSkeleton({
  avatarSize = 44,
  avatarRadius,
  lines = 2,
  showAvatar = true,
  style,
}: {
  avatarSize?: number;
  avatarRadius?: number;
  lines?: 1 | 2;
  showAvatar?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.listRow, style]}>
      {showAvatar && (
        <SkeletonBlock
          width={avatarSize}
          height={avatarSize}
          radius={avatarRadius ?? avatarSize / 2}
          style={{ marginRight: 12 }}
        />
      )}
      <View style={styles.listRowBody}>
        <SkeletonBlock width="62%" height={12} />
        {lines === 2 && (
          <SkeletonBlock width="90%" height={10} style={{ marginTop: 8 }} />
        )}
      </View>
    </View>
  );
}

export function ListSkeleton({
  count = 7,
  rowStyle,
  contentStyle,
  avatarSize,
  avatarRadius,
  lines,
  showAvatar,
}: {
  count?: number;
  rowStyle?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  avatarSize?: number;
  avatarRadius?: number;
  lines?: 1 | 2;
  showAvatar?: boolean;
}) {
  return (
    <SkeletonGroup style={[styles.listContent, contentStyle]}>
      {Array.from({ length: count }).map((_, i) => (
        <ListRowSkeleton
          key={i}
          style={rowStyle}
          avatarSize={avatarSize}
          avatarRadius={avatarRadius}
          lines={lines}
          showAvatar={showAvatar}
        />
      ))}
    </SkeletonGroup>
  );
}

export function ProfileHeaderSkeleton() {
  return (
    <SkeletonGroup style={styles.profileHeader}>
      <SkeletonCircle size={92} />
      <SkeletonBlock width={160} height={16} style={{ marginTop: 16 }} />
      <SkeletonBlock width={110} height={11} style={{ marginTop: 10 }} />
      <View style={styles.profileStatsRow}>
        <SkeletonBlock width={70} height={44} radius={12} />
        <SkeletonBlock width={70} height={44} radius={12} />
        <SkeletonBlock width={70} height={44} radius={12} />
      </View>
    </SkeletonGroup>
  );
}

export function DashboardSkeleton() {
  return (
    <SkeletonGroup style={styles.dashboard}>
      <SkeletonBlock width="60%" height={20} />
      <SkeletonBlock width="40%" height={12} style={{ marginTop: 10 }} />
      <View style={styles.dashboardGrid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonBlock key={i} width="31%" height={78} radius={16} />
        ))}
      </View>
      <SkeletonBlock
        width="45%"
        height={14}
        style={{ marginTop: 24, marginBottom: 6 }}
      />
      {Array.from({ length: 4 }).map((_, i) => (
        <SkeletonBlock
          key={i}
          width="100%"
          height={52}
          radius={14}
          style={{ marginTop: 10 }}
        />
      ))}
    </SkeletonGroup>
  );
}

export function ChatSkeleton({
  count = 6,
  style,
}: {
  count?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <SkeletonGroup style={[styles.chat, style]}>
      {Array.from({ length: count }).map((_, i) => {
        const mine = i % 3 === 0;
        return (
          <View
            key={i}
            style={[
              styles.chatRow,
              { justifyContent: mine ? "flex-end" : "flex-start" },
            ]}
          >
            {!mine && (
              <SkeletonCircle size={30} style={{ marginRight: 8 }} />
            )}
            <SkeletonBlock
              width={i % 2 === 0 ? 180 : 240}
              height={i % 2 === 0 ? 40 : 62}
              radius={16}
            />
          </View>
        );
      })}
    </SkeletonGroup>
  );
}

const styles = StyleSheet.create({
  shimmerBand: {
    position: "absolute",
    top: -20,
    bottom: -20,
    left: 0,
    backgroundColor: SKELETON_HIGHLIGHT,
  },
  slowText: {
    textAlign: "center",
    color: "#9b7d72",
    fontSize: 12,
    marginTop: 18,
    paddingHorizontal: 24,
  },
  // Post-card skeleton — matches PostCard.postCard spacing.
  postCard: {
    backgroundColor: "#fffaf7",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#ead8cf",
  },
  postRow: { flexDirection: "row" },
  postBody: { flex: 1 },
  postActionsRow: {
    flexDirection: "row",
    gap: 22,
    marginTop: 14,
  },
  // List row skeleton.
  listContent: { paddingVertical: 8 },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  listRowBody: { flex: 1 },
  // Profile header skeleton.
  profileHeader: {
    alignItems: "center",
    paddingVertical: 32,
    paddingHorizontal: 24,
  },
  profileStatsRow: {
    flexDirection: "row",
    gap: 14,
    marginTop: 22,
  },
  // Dashboard skeleton.
  dashboard: { padding: 20 },
  dashboardGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 12,
    marginTop: 18,
  },
  // Chat skeleton.
  chat: { padding: 16 },
  chatRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginBottom: 14,
  },
});

export default function SkeletonRoutePlaceholder() {
  return null;
}

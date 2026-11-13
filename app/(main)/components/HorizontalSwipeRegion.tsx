// app/(main)/components/HorizontalSwipeRegion.tsx
//
// Wraps content on Home that swipes sideways (a carousel, Trending, the flair
// filters). A touch that starts in here belongs to the content: it raises
// homeHorizontalTouch, which makes Home's swipe-to-Community fail, and lowers
// it again when the touch ends or is cancelled.
//
// The gesture only watches — it never activates — so the content inside
// scrolls, snaps and takes taps exactly as before.
import React, { useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { makeMutable } from "react-native-reanimated";

/**
 * True while a touch that started in Home's horizontal content is down.
 * That touch belongs to the content, so Home's opening swipe fails at once —
 * even at a carousel's first or last card, where the content itself has
 * nowhere further to scroll.
 */
export const homeHorizontalTouch = makeMutable(false);

type Props = {
  children: React.ReactNode;
  /** Off for content that can't swipe (a single photo): no guard needed. */
  enabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function HorizontalSwipeRegion({ children, enabled = true, style }: Props) {
  const guard = useMemo(
    () =>
      Gesture.Manual()
        .onTouchesDown(() => {
          homeHorizontalTouch.set(true);
        })
        .onTouchesUp((_event, manager) => {
          homeHorizontalTouch.set(false);
          manager.fail();
        })
        .onTouchesCancelled((_event, manager) => {
          homeHorizontalTouch.set(false);
          manager.fail();
        })
        .onFinalize(() => {
          homeHorizontalTouch.set(false);
        }),
    [],
  );

  if (!enabled) return <>{children}</>;
  return (
    <GestureDetector gesture={guard}>
      {/* A real native view for the detector to attach to. */}
      <View collapsable={false} style={style}>
        {children}
      </View>
    </GestureDetector>
  );
}

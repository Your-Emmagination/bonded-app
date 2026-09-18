import React, { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Easing, type StyleProp, type ViewStyle } from "react-native";

/** One restrained entrance when content mounts; it never replays on scroll. */
export default function CampusReveal({
  children,
  delay = 0,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    let active = true;
    let animation: Animated.CompositeAnimation | undefined;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((reducedMotion) => {
        if (!active) return;
        if (reducedMotion) {
          progress.setValue(1);
          return;
        }
        animation = Animated.sequence([
          Animated.delay(delay),
          Animated.timing(progress, {
            toValue: 1,
            duration: 260,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]);
        animation.start();
      })
      .catch(() => {
        if (active) progress.setValue(1);
      });
    return () => {
      active = false;
      animation?.stop();
    };
  }, [delay, progress]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [{
            translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }),
          }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** Defaults to still charts until the system preference is known. */
export function useReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => { if (active) setReducedMotion(enabled); })
      .catch(() => { if (active) setReducedMotion(false); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reducedMotion;
}

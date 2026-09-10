// AppToast.tsx
//
// One short message bar for the whole app (e.g. "Post saved"). Mounted once in
// the root layout; any screen shows a message with showAppToast().
import { subscribeAppToast, type AppToastOptions } from "@/utils/toastEvents";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const VISIBLE_MS = 2500;
const FADE_MS = 160;

export default function AppToast() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<AppToastOptions | null>(null);
  const [progress] = useState(() => new Animated.Value(0));
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const hide = () => {
      Animated.timing(progress, {
        toValue: 0,
        duration: FADE_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        // A newer message interrupts this fade, so only clear when it completes.
        if (finished) setToast(null);
      });
    };

    const subscription = subscribeAppToast((options) => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setToast(options);
      Animated.timing(progress, {
        toValue: 1,
        duration: FADE_MS,
        useNativeDriver: true,
      }).start();
      hideTimerRef.current = setTimeout(hide, VISIBLE_MS);
    });

    return () => {
      subscription.remove();
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [progress]);

  if (!toast) return null;

  const handleAction = () => {
    if (!toast.actionHref) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    progress.setValue(0);
    setToast(null);
    router.push(toast.actionHref as any);
  };

  return (
    <View
      pointerEvents="box-none"
      // Sits just above Home's + button, which sits above the tab bar.
      style={[styles.wrap, { bottom: Math.max(insets.bottom + 68, 80) + 72 }]}
    >
      <Animated.View
        style={[
          styles.toast,
          {
            opacity: progress,
            transform: [
              {
                translateY: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [10, 0],
                }),
              },
            ],
          },
        ]}
      >
        <Text style={styles.message} numberOfLines={2}>
          {toast.message}
        </Text>
        {toast.actionLabel && toast.actionHref ? (
          <TouchableOpacity onPress={handleAction} activeOpacity={0.7} hitSlop={8}>
            <Text style={styles.action}>{toast.actionLabel}</Text>
          </TouchableOpacity>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 16,
    right: 16,
    alignItems: "center",
    zIndex: 1000,
  },
  // Same look as the "Saved to Photos" message in ImageZoomViewer.
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    maxWidth: "100%",
    backgroundColor: "rgba(0,0,0,0.72)",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  message: {
    flexShrink: 1,
    color: "#FFFFFF",
    fontSize: 13.5,
    fontWeight: "600",
  },
  action: {
    color: "#e0a53d",
    fontSize: 13.5,
    fontWeight: "800",
  },
});

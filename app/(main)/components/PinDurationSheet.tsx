// app/(main)/components/PinDurationSheet.tsx
//
// "Pin to Important Announcements" — shown when staff pin a post or poll
// from its ⋯ menu. Staff set the exact date and time the pin ends, or pin it
// with no end. Swipe it down to close.
//
// It measures its own safe area: a sheet in a Modal draws under the phone's
// navigation bar, whatever kind it has (three buttons, gesture pill, none),
// and the screen's own measurement doesn't reach inside a Modal on Android.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import React, { useMemo, useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Reanimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

type PinDurationSheetProps = {
  visible: boolean;
  /** "post" or "poll", for the wording. */
  kind: "post" | "poll";
  /** The chosen end, or null for "No end". */
  onPin: (endsAt: Date | null) => void;
  onClose: () => void;
};

/** Where the end starts each time the sheet opens: three days out, 11:59 PM. */
const defaultPinEnd = () => {
  const end = new Date();
  end.setDate(end.getDate() + 3);
  end.setHours(23, 59, 0, 0);
  return end;
};

const formatDay = (date: Date) =>
  date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

const formatTime = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A drag past this far down, or a flick faster than this, closes the sheet. */
const SWIPE_CLOSE_DISTANCE = 110;
const SWIPE_CLOSE_VELOCITY = 900;

export default function PinDurationSheet({ visible, kind, onPin, onClose }: PinDurationSheetProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <SafeAreaProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <PinSheetBody kind={kind} onPin={onPin} onClose={onClose} />
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </Modal>
  );
}

function PinSheetBody({ kind, onPin, onClose }: Omit<PinDurationSheetProps, "visible">) {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // This Modal's own insets, from the provider just above.
  const insets = useSafeAreaInsets();
  // Home mounts the sheet each time it opens, so every pin starts from the
  // default end rather than the last pin's.
  const [endsAt, setEndsAt] = useState(defaultPinEnd);
  // "Now" as of the last change, so a time that passed while it was open counts.
  const [checkedAtMs, setCheckedAtMs] = useState(() => Date.now());
  const [picker, setPicker] = useState<"date" | "time" | null>(null);

  const inPast = endsAt.getTime() <= checkedAtMs;

  // Swipe down to close: the sheet follows the finger down (never up), and
  // the dimmed backdrop lightens with it. Let go far or fast enough and it
  // slides away and closes; otherwise it springs back. Taps and the date and
  // time buttons are unaffected: it only starts after 8 px of downward drag.
  const dragY = useSharedValue(0);
  const sheetHeight = useSharedValue(600);
  const swipeDown = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(8)
        .failOffsetX([-20, 20])
        .onUpdate((event) => {
          dragY.set(Math.max(0, event.translationY));
        })
        .onEnd((event) => {
          if (event.translationY > SWIPE_CLOSE_DISTANCE || event.velocityY > SWIPE_CLOSE_VELOCITY) {
            dragY.set(
              withTiming(sheetHeight.get(), { duration: 180 }, (finished) => {
                if (finished) runOnJS(onClose)();
              }),
            );
          } else {
            dragY.set(withSpring(0, { damping: 22, stiffness: 260, overshootClamping: true }));
          }
        }),
    [dragY, onClose, sheetHeight],
  );
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dragY.get() }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, dragY.get() / Math.max(1, sheetHeight.get())),
  }));

  return (
      <View style={styles.overlay}>
        <Reanimated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Cancel" />
        </Reanimated.View>
        <GestureDetector gesture={swipeDown}>
        <Reanimated.View
          onLayout={(event) => sheetHeight.set(event.nativeEvent.layout.height)}
          style={[
            styles.sheet,
            // Clear of the navigation bar, whichever kind the phone has.
            { paddingBottom: Math.max(insets.bottom, 12) + 8 },
            sheetStyle,
          ]}
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Ionicons name="pin" size={18} color={theme.accent} />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.title}>Pin to Important Announcements</Text>
              <Text style={styles.subtitle}>
                Set when this {kind} leaves Important Announcements. It stays in the feed either way.
              </Text>
            </View>
          </View>

          <Text style={styles.sectionLabel}>Pinned until</Text>
          <View style={styles.whenRow}>
            <TouchableOpacity
              style={styles.whenField}
              onPress={() => setPicker("date")}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={`End date, ${formatDay(endsAt)}. Change it`}
            >
              <Ionicons name="calendar-outline" size={18} color={theme.primary} />
              <Text style={styles.whenText} numberOfLines={1}>
                {formatDay(endsAt)}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.whenField, styles.whenFieldTime]}
              onPress={() => setPicker("time")}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={`End time, ${formatTime(endsAt)}. Change it`}
            >
              <Ionicons name="time-outline" size={18} color={theme.primary} />
              <Text style={styles.whenText} numberOfLines={1}>
                {formatTime(endsAt)}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={[styles.hint, inPast && styles.hintError]}>
            {inPast
              ? "That time has already passed. Pick a later one."
              : kind === "poll"
                ? "It unpins on its own then, or when voting closes if that's sooner."
                : "It unpins on its own then."}
          </Text>

          {picker && (
            <DateTimePicker
              value={endsAt}
              mode={picker}
              display={Platform.OS === "ios" ? "spinner" : "default"}
              minimumDate={picker === "date" ? new Date() : undefined}
              onChange={(_, selected) => {
                // Android shows a dialog, closed by now; iOS shows the
                // spinner in place until Pin or No end is tapped.
                if (Platform.OS !== "ios") setPicker(null);
                if (!selected) return;
                const next = new Date(endsAt);
                if (picker === "date") {
                  next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
                } else {
                  next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
                }
                setEndsAt(next);
                setCheckedAtMs(Date.now());
              }}
            />
          )}

          <TouchableOpacity
            style={[styles.pinButton, inPast && styles.pinButtonDisabled]}
            onPress={() => {
              // Checked again now: the sheet may have been open a while.
              if (endsAt.getTime() > Date.now()) onPin(endsAt);
              else setCheckedAtMs(Date.now());
            }}
            disabled={inPast}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ disabled: inPast }}
          >
            <Ionicons name="pin" size={17} color={theme.onPrimary} />
            <Text style={styles.pinButtonText}>Pin until then</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.noEnd}
            onPress={() => onPin(null)}
            activeOpacity={0.75}
            accessibilityRole="button"
          >
            <Ionicons name="infinite-outline" size={20} color={theme.primary} />
            <View style={styles.noEndText}>
              <Text style={styles.noEndLabel}>No end</Text>
              <Text style={styles.noEndHint}>Stays pinned until staff unpin it</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity style={styles.cancel} onPress={onClose} activeOpacity={0.75} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Reanimated.View>
        </GestureDetector>
      </View>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    overlay: { flex: 1, justifyContent: "flex-end" },
    backdrop: { ...StyleSheet.absoluteFill, backgroundColor: c.scrim },
    sheet: {
      backgroundColor: c.surfaceRaised,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      paddingTop: 10,
      paddingHorizontal: 16,
    },
    handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: c.borderStrong, marginBottom: 14 },
    header: { flexDirection: "row", gap: 12, alignItems: "center", marginBottom: 14 },
    headerIcon: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: c.accentSoft,
      alignItems: "center",
      justifyContent: "center",
    },
    headerText: { flex: 1 },
    title: { color: c.textPrimary, fontSize: 16, fontWeight: "800" },
    subtitle: { color: c.textMuted, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
    sectionLabel: {
      color: c.textSecondary,
      fontSize: 12,
      fontWeight: "800",
      letterSpacing: 0.4,
      textTransform: "uppercase",
      marginBottom: 8,
    },
    whenRow: { flexDirection: "row", gap: 10 },
    whenField: {
      flex: 1.6,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
    },
    whenFieldTime: { flex: 1 },
    whenText: { flexShrink: 1, color: c.textPrimary, fontSize: 14.5, fontWeight: "700" },
    hint: { color: c.textMuted, fontSize: 12, marginTop: 8, lineHeight: 16 },
    hintError: { color: c.danger, fontWeight: "700" },
    pinButton: {
      marginTop: 14,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 13,
      borderRadius: 12,
      backgroundColor: c.primary,
    },
    pinButtonDisabled: { opacity: 0.45 },
    pinButtonText: { color: c.onPrimary, fontSize: 15, fontWeight: "800" },
    noEnd: {
      marginTop: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 11,
      paddingHorizontal: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    noEndText: { flex: 1 },
    noEndLabel: { color: c.textPrimary, fontSize: 15, fontWeight: "700" },
    noEndHint: { color: c.textMuted, fontSize: 12, marginTop: 1 },
    cancel: {
      marginTop: 10,
      paddingVertical: 12,
      borderRadius: 12,
      alignItems: "center",
      backgroundColor: c.surfaceSunken,
    },
    cancelText: { color: c.textSecondary, fontSize: 14.5, fontWeight: "700" },
  });

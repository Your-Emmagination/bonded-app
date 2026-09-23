// app/(main)/components/DragToCloseSheet.tsx
//
// A bottom sheet you can pull down to close, the way Messenger's sheets work.
// Only the top of the sheet — its handle and header — listens for the drag,
// so lists, buttons and text boxes inside keep working as they always did.
// Pull past a short distance, or flick, and it closes; a smaller pull springs
// back. Tapping the dimmed background, or pressing Back, closes it too.
import { useEffect, useMemo, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Reanimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

/** How far a pull has to travel, in points, before letting go closes the sheet. */
const CLOSE_DISTANCE = 110;
/** A downward flick this fast, in points per second, closes it from any distance. */
const CLOSE_VELOCITY = 900;

type DragToCloseSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** The top of the sheet, under the handle — title, close button. A drag here closes. */
  header?: ReactNode;
  children?: ReactNode;
  /** The sheet itself: background, corners, padding, height. */
  sheetStyle?: StyleProp<ViewStyle>;
  handleColor: string;
  /** The dimmed background behind the sheet. */
  backdropColor?: string;
  /** What a screen reader says for the background, which closes the sheet. */
  closeLabel?: string;
};

export default function DragToCloseSheet({
  visible,
  onClose,
  header,
  children,
  sheetStyle,
  handleColor,
  backdropColor = "rgba(10,2,2,0.45)",
  closeLabel = "Close",
}: DragToCloseSheetProps) {
  const drag = useSharedValue(0);

  // A sheet closed by dragging is left pulled down; it opens in place again.
  useEffect(() => {
    if (visible) drag.set(0);
  }, [drag, visible]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Downward and mostly vertical, so taps on the header's buttons and
        // sideways swipes still reach them.
        .activeOffsetY(8)
        .failOffsetX([-24, 24])
        .onUpdate((event) => {
          drag.set(Math.max(0, event.translationY));
        })
        .onEnd((event) => {
          if (event.translationY > CLOSE_DISTANCE || event.velocityY > CLOSE_VELOCITY) {
            runOnJS(onClose)();
            return;
          }
          drag.set(withSpring(0, { damping: 22, stiffness: 260 }));
        }),
    [drag, onClose],
  );

  const sheetDragStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drag.get() }],
  }));
  // The background lightens as the sheet is pulled away.
  const backdropDragStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(drag.get() / 500, 0.7),
  }));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Gestures inside a Modal need their own root on Android. */}
      <GestureHandlerRootView style={styles.overlay}>
        <Reanimated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: backdropColor }, backdropDragStyle]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
          />
        </Reanimated.View>

        <Reanimated.View style={[sheetStyle, sheetDragStyle]}>
          <GestureDetector gesture={pan}>
            <View collapsable={false}>
              <View style={styles.handleZone}>
                <View style={[styles.handle, { backgroundColor: handleColor }]} />
              </View>
              {header}
            </View>
          </GestureDetector>
          {children}
        </Reanimated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  handleZone: {
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 10,
  },
  handle: {
    width: 44,
    height: 5,
    borderRadius: 999,
  },
});

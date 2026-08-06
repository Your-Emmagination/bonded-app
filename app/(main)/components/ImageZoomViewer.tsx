// components/ImageZoomViewer.tsx
// Full-screen pinch-to-zoom + swipe-to-dismiss image viewer.
// Drop-in for any screen that already passes onImagePress.

import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  FlatList,
  Modal,
  PanResponder,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const { width: SW, height: SH } = Dimensions.get("window");

interface Props {
  images: string[];
  startIndex?: number;
  visible: boolean;
  onClose: () => void;
}

// One zoomable image page
const ZoomPage: React.FC<{ uri: string; onClose: () => void }> = ({ uri, onClose }) => {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const dismissTranslateY = useRef(new Animated.Value(0)).current;
  const lastScale = useRef(1);
  const lastTranslateX = useRef(0);
  const lastTranslateY = useRef(0);
  const scaleValue = useRef(1);
  const initialDistance = useRef<number | null>(null);

  React.useEffect(() => {
    const listenerId = scale.addListener(({ value }) => {
      scaleValue.current = value;
    });
    return () => {
      scale.removeListener(listenerId);
    };
  }, [scale]);

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (evt, gestureState) => {
        const touches = evt.nativeEvent.touches || [];
        if (touches.length >= 2) return true;
        if (lastScale.current > 1.05) return true;
        return (
          Math.abs(gestureState.dy) > 10 &&
          Math.abs(gestureState.dy) > Math.abs(gestureState.dx) * 1.5
        );
      },
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        const touches = evt.nativeEvent.touches || [];
        if (touches.length >= 2) return true;
        if (lastScale.current > 1.05) return true;
        return (
          Math.abs(gestureState.dy) > 10 &&
          Math.abs(gestureState.dy) > Math.abs(gestureState.dx) * 1.5
        );
      },
      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches || [];
        if (touches.length >= 2) {
          const [a, b] = touches;
          const dx = a.pageX - b.pageX;
          const dy = a.pageY - b.pageY;
          initialDistance.current = Math.sqrt(dx * dx + dy * dy);
        } else {
          initialDistance.current = null;
        }
      },
      onPanResponderMove: (evt, gestureState) => {
        const touches = evt.nativeEvent.touches || [];
        if (touches.length >= 2 && initialDistance.current) {
          const [a, b] = touches;
          const dx = a.pageX - b.pageX;
          const dy = a.pageY - b.pageY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const nextScale = clamp(
            lastScale.current * (distance / initialDistance.current),
            1,
            4,
          );
          scale.setValue(nextScale);
        } else if (lastScale.current > 1.05) {
          translateX.setValue(lastTranslateX.current + gestureState.dx);
          translateY.setValue(lastTranslateY.current + gestureState.dy);
        } else {
          dismissTranslateY.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (scaleValue.current <= 1.05) {
          if (Math.abs(gestureState.dy) > 120 || Math.abs(gestureState.vy) > 0.8) {
            onClose();
            return;
          }
          Animated.spring(dismissTranslateY, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
          Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
          lastScale.current = 1;
          lastTranslateX.current = 0;
          lastTranslateY.current = 0;
          return;
        }

        lastScale.current = scaleValue.current;
        lastTranslateX.current += gestureState.dx;
        lastTranslateY.current += gestureState.dy;
      },
      onPanResponderTerminate: (_, gestureState) => {
        if (scaleValue.current <= 1.05) {
          Animated.spring(dismissTranslateY, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
          Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
          lastScale.current = 1;
          lastTranslateX.current = 0;
          lastTranslateY.current = 0;
        }
      },
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  return (
    <Animated.View
      style={[styles.page, { transform: [{ translateY: dismissTranslateY }] }]}
      {...panResponder.panHandlers}
    >
      <Animated.Image
        source={{ uri }}
        style={[
          styles.zoomImage,
          { transform: [{ scale }, { translateX }, { translateY }] },
        ]}
        resizeMode="contain"
      />
    </Animated.View>
  );
};

const ImageZoomViewer: React.FC<Props> = ({
  images,
  startIndex = 0,
  visible,
  onClose,
}) => {
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const listRef = useRef<FlatList>(null);

  // Reset to startIndex each time viewer opens
  React.useEffect(() => {
    if (visible) {
      setCurrentIndex(startIndex);
      listRef.current?.scrollToIndex({ index: startIndex, animated: false });
    }
  }, [visible, startIndex]);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: any) => {
      if (viewableItems.length > 0) {
        setCurrentIndex(viewableItems[0].index ?? 0);
      }
    },
    [],
  );

  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 51 }).current;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {Platform.OS === "android" && <StatusBar hidden />}
      <View style={styles.overlay}>
        {/* Close button */}
        <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.82}>
          <Ionicons name="close" size={26} color="#fffaf7" />
        </TouchableOpacity>

        {/* Counter */}
        {images.length > 1 && (
          <View style={styles.counter}>
            <Text style={styles.counterText}>
              {currentIndex + 1} / {images.length}
            </Text>
          </View>
        )}

        {/* Swipe hint */}
        <View style={styles.hintRow}>
          <Text style={styles.hintText}>Swipe down to close</Text>
        </View>

        <FlatList
          ref={listRef}
          data={images}
          keyExtractor={(_, i) => String(i)}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={startIndex}
          getItemLayout={(_, index) => ({ length: SW, offset: SW * index, index })}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          renderItem={({ item }) => <ZoomPage uri={item} onClose={onClose} />}
        />
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.96)",
  },
  page: {
    width: SW,
    height: SH,
    justifyContent: "center",
    alignItems: "center",
  },
  zoomImage: {
    width: SW,
    height: SH,
  },
  closeBtn: {
    position: "absolute",
    top: 52,
    right: 18,
    zIndex: 10,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 999,
    padding: 10,
  },
  counter: {
    position: "absolute",
    top: 56,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 10,
  },
  counterText: {
    color: "#fffaf7",
    fontSize: 14,
    fontWeight: "700",
    backgroundColor: "rgba(0,0,0,0.44)",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
  },
  hintRow: {
    position: "absolute",
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 10,
  },
  hintText: {
    color: "rgba(255,250,247,0.45)",
    fontSize: 12,
    fontWeight: "500",
  },
});

export default ImageZoomViewer;

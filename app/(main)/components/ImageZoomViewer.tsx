// components/ImageZoomViewer.tsx
import { FULLSCREEN_IMAGE_WIDTH, fullscreenImage } from "@/utils/cloudinaryImages";
import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library/legacy";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Modal,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import {
  GestureHandlerRootView,
  PanGestureHandler,
  PinchGestureHandler,
  State,
  TapGestureHandler,
} from "react-native-gesture-handler";

type SaveState = "idle" | "saving" | "saved" | "error";

// Save the ORIGINAL image (not the Cloudinary-resized preview) to the device
// gallery: request add-only permission, stream it to the cache, hand the
// local file to MediaLibrary, then clean up.
const saveImageToLibrary = async (remoteUrl: string): Promise<SaveState> => {
  try {
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) return "error";

    const cacheDir = FileSystem.cacheDirectory;
    if (!cacheDir) return "error";

    const extMatch = /\.(jpe?g|png|gif|webp|heic)(?:[?#]|$)/i.exec(remoteUrl);
    const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
    const localUri = `${cacheDir}bonded-${Date.now()}.${ext}`;

    // A messenger draft is still a local camera/gallery file. Copy it so
    // cleanup never deletes the attachment that the composer needs to send.
    if (remoteUrl.startsWith("file://") || remoteUrl.startsWith("content://")) {
      await FileSystem.copyAsync({ from: remoteUrl, to: localUri });
    } else {
      await FileSystem.downloadAsync(remoteUrl, localUri);
    }
    await MediaLibrary.saveToLibraryAsync(localUri);
    await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {
      // Best effort — a leftover cache file is harmless.
    });
    return "saved";
  } catch (error) {
    console.warn("[ImageZoomViewer] save failed:", error);
    return "error";
  }
};

interface Props {
  images: string[];
  startIndex?: number;
  visible: boolean;
  onClose: () => void;
  likesCount?: number;
  commentsCount?: number;
  isLiked?: boolean;
  isBookmarked?: boolean;
  onLike?: () => void;
  onComment?: () => void;
  onBookmark?: () => void;
  showActions?: boolean;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const ZoomPage: React.FC<{
  uri: string;
  width: number;
  height: number;
  onZoomChange: (isZoomed: boolean) => void;
}> = ({ uri, width, height, onZoomChange }) => {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  const baseScale = useRef(1);
  const lastOffset = useRef({ x: 0, y: 0 });
  const isZoomed = useRef(false);

  const doubleTapRef = useRef(null);
  const pinchRef = useRef(null);
  const panRef = useRef(null);

  const resetPosition = useCallback(() => {
    baseScale.current = 1;
    lastOffset.current = { x: 0, y: 0 };
    isZoomed.current = false;
    onZoomChange(false);

    // Crucial fix: Clear offsets before spring animation
    translateX.setOffset(0);
    translateY.setOffset(0);

    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
    ]).start();
  }, [onZoomChange, scale, translateX, translateY]);

  // Reset image position when image source changes
  React.useEffect(() => {
    resetPosition();
  }, [uri, resetPosition]);

  // Double Tap Handler (Facebook-style toggle zoom)
  const onDoubleTap = ({ nativeEvent }: any) => {
    if (nativeEvent.state === State.ACTIVE) {
      if (isZoomed.current) {
        resetPosition();
      } else {
        baseScale.current = 2.5;
        isZoomed.current = true;
        onZoomChange(true);

        translateX.setOffset(0);
        translateY.setOffset(0);
        lastOffset.current = { x: 0, y: 0 };

        Animated.parallel([
          Animated.spring(scale, {
            toValue: 2.5,
            useNativeDriver: true,
            bounciness: 2,
          }),
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
        ]).start();
      }
    }
  };

  // Pinch Handler
  const onPinchEvent = Animated.event(
    [{ nativeEvent: { scale } }],
    { useNativeDriver: true }
  );

  const onPinchStateChange = ({ nativeEvent }: any) => {
    if (
      nativeEvent.oldState === State.ACTIVE ||
      nativeEvent.state === State.END ||
      nativeEvent.state === State.CANCELLED
    ) {
      const currentScale = baseScale.current * (nativeEvent.scale || 1);

      if (currentScale <= 1.05) {
        resetPosition();
      } else {
        baseScale.current = Math.min(Math.max(currentScale, 1), 4);
        isZoomed.current = true;
        onZoomChange(true);

        Animated.spring(scale, {
          toValue: baseScale.current,
          useNativeDriver: true,
        }).start();
      }
    }
  };

  // Pan Handler (For moving zoomed image around)
  const onPanEvent = Animated.event(
    [
      {
        nativeEvent: {
          translationX: translateX,
          translationY: translateY,
        },
      },
    ],
    { useNativeDriver: true }
  );

  const onPanStateChange = ({ nativeEvent }: any) => {
    if (nativeEvent.oldState === State.ACTIVE) {
      const maxOffsetX = (width * (baseScale.current - 1)) / 2;
      const maxOffsetY = (height * (baseScale.current - 1)) / 2;

      lastOffset.current.x = clamp(
        lastOffset.current.x + nativeEvent.translationX,
        -maxOffsetX,
        maxOffsetX
      );
      lastOffset.current.y = clamp(
        lastOffset.current.y + nativeEvent.translationY,
        -maxOffsetY,
        maxOffsetY
      );

      translateX.setOffset(lastOffset.current.x);
      translateX.setValue(0);
      translateY.setOffset(lastOffset.current.y);
      translateY.setValue(0);
    }
  };

  return (
    <View style={[styles.page, { width, height }]}>
      <TapGestureHandler
        ref={doubleTapRef}
        numberOfTaps={2}
        onHandlerStateChange={onDoubleTap}
      >
        <Animated.View style={styles.flex}>
          <PanGestureHandler
            ref={panRef}
            simultaneousHandlers={[pinchRef, doubleTapRef]}
            onGestureEvent={onPanEvent}
            onHandlerStateChange={onPanStateChange}
            enabled={isZoomed.current}
          >
            <Animated.View style={styles.flex}>
              <PinchGestureHandler
                ref={pinchRef}
                simultaneousHandlers={[panRef, doubleTapRef]}
                onGestureEvent={onPinchEvent}
                onHandlerStateChange={onPinchStateChange}
              >
                <Animated.Image
                  // Pinch-zoom here goes up to 4x (see baseScale clamp
                  // above); request extra width so zoomed-in detail stays
                  // sharp, while still capping well below arbitrary
                  // original resolutions. Uses the shared constant (not the
                  // actual device width) so this matches what
                  // utils/cloudinaryUpload.ts eagerly warms at upload time.
                  source={{ uri: fullscreenImage(uri, FULLSCREEN_IMAGE_WIDTH * 3) }}
                  style={[
                    { width, height },
                    {
                      transform: [
                        { translateX },
                        { translateY },
                        { scale },
                      ],
                    },
                  ]}
                  resizeMode="contain"
                />
              </PinchGestureHandler>
            </Animated.View>
          </PanGestureHandler>
        </Animated.View>
      </TapGestureHandler>
    </View>
  );
};

const ImageZoomViewer: React.FC<Props> = ({
  images,
  startIndex = 0,
  visible,
  onClose,
  likesCount = 0,
  commentsCount = 0,
  isLiked = false,
  isBookmarked = false,
  onLike,
  onComment,
  onBookmark,
  showActions = true,
}) => {
  const { width, height } = useWindowDimensions();
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [isZoomed, setIsZoomed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const listRef = useRef<FlatList>(null);

  const handleSave = useCallback(async () => {
    if (saveState === "saving") return;
    const target = images[currentIndex];
    if (!target) return;
    setSaveState("saving");
    setSaveState(await saveImageToLibrary(target));
  }, [images, currentIndex, saveState]);

  // Auto-clear the save toast; also reset it when the page changes.
  useEffect(() => {
    if (saveState === "saved" || saveState === "error") {
      const timer = setTimeout(() => setSaveState("idle"), 1800);
      return () => clearTimeout(timer);
    }
  }, [saveState]);
  useEffect(() => {
    setSaveState("idle");
  }, [currentIndex, visible]);

  const dismissY = useRef(new Animated.Value(0)).current;
  const hasImages = images.length > 0;
  const safeStartIndex = images.length
    ? Math.min(Math.max(startIndex, 0), images.length - 1)
    : 0;

  React.useEffect(() => {
    if (visible) {
      setCurrentIndex(safeStartIndex);
      setIsZoomed(false);
      dismissY.setValue(0);
      requestAnimationFrame(() => {
        listRef.current?.scrollToIndex({ index: safeStartIndex, animated: false });
      });
    }
  }, [safeStartIndex, visible]);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: any) => {
      if (viewableItems.length > 0) {
        setCurrentIndex(viewableItems[0].index ?? 0);
      }
    },
    []
  );

  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 50 }).current;

  // Swipe Down To Dismiss Handler
  const onPanGestureEvent = Animated.event(
    [{ nativeEvent: { translationY: dismissY } }],
    { useNativeDriver: true }
  );

  const onPanHandlerStateChange = ({ nativeEvent }: any) => {
    if (nativeEvent.oldState === State.ACTIVE) {
      if (nativeEvent.translationY > 120 || nativeEvent.velocityY > 800) {
        onClose();
      } else {
        Animated.spring(dismissY, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 5,
        }).start();
      }
    }
  };

  // Closed is the normal state: screens keep this mounted all the time, so
  // returning early here keeps a closed viewer out of their render work.
  // Every hook above still runs, so the order never changes.
  if (!visible) return null;

  return (
    <Modal
      visible={visible && hasImages}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {Platform.OS === "android" && <StatusBar hidden />}
      <GestureHandlerRootView style={styles.overlay}>
        {/* Top Header - Save + Close */}
        <TouchableOpacity
          style={styles.saveBtn}
          onPress={handleSave}
          activeOpacity={0.8}
          disabled={saveState === "saving"}
        >
          <Ionicons
            name={
              saveState === "saved"
                ? "checkmark"
                : saveState === "error"
                  ? "alert-circle-outline"
                  : "download-outline"
            }
            size={22}
            color="#FFFFFF"
          />
        </TouchableOpacity>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.8}>
          <Ionicons name="close" size={26} color="#FFFFFF" />
        </TouchableOpacity>

        {saveState !== "idle" && (
          <View style={styles.saveToast} pointerEvents="none">
            <Text style={styles.saveToastText}>
              {saveState === "saving"
                ? "Saving…"
                : saveState === "saved"
                  ? "Saved to Photos"
                  : "Couldn't save photo"}
            </Text>
          </View>
        )}

        {/* Outer Swipe Down Dismiss Handler */}
        <PanGestureHandler
          activeOffsetY={[-15, 15]}
          failOffsetX={[-15, 15]}
          enabled={!isZoomed}
          onGestureEvent={onPanGestureEvent}
          onHandlerStateChange={onPanHandlerStateChange}
        >
          <Animated.View
            style={[
              styles.flex,
              { transform: [{ translateY: dismissY }] },
            ]}
          >
            <FlatList
              ref={listRef}
              data={images}
              keyExtractor={(_, i) => String(i)}
              horizontal
              pagingEnabled
              scrollEnabled={!isZoomed}
              showsHorizontalScrollIndicator={false}
              scrollEventThrottle={16}
              initialScrollIndex={hasImages ? safeStartIndex : undefined}
              windowSize={3}
              maxToRenderPerBatch={2}
              removeClippedSubviews={Platform.OS === "android"}
              getItemLayout={(_, index) => ({
                length: width,
                offset: width * index,
                index,
              })}
              onViewableItemsChanged={onViewableItemsChanged}
              viewabilityConfig={viewabilityConfig}
              renderItem={({ item }) => (
                <ZoomPage
                  uri={item}
                  width={width}
                  height={height}
                  onZoomChange={setIsZoomed}
                />
              )}
            />
          </Animated.View>
        </PanGestureHandler>

        {/* Bottom Bar: Action Row + Pagination Dots */}
        <View style={styles.bottomContainer}>
          {images.length > 1 && (
            <View style={styles.paginationContainer}>
              {images.map((_, index) => (
                <View
                  key={index}
                  style={[
                    styles.dot,
                    currentIndex === index ? styles.activeDot : styles.inactiveDot,
                  ]}
                />
              ))}
            </View>
          )}

          {showActions && (
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.actionBtn} onPress={onLike} activeOpacity={0.7}>
                <Ionicons
                  name={isLiked ? "heart" : "heart-outline"}
                  size={22}
                  color={isLiked ? "#F91880" : "#FFFFFF"}
                />
                {likesCount > 0 && (
                  <Text style={[styles.actionCount, isLiked && { color: "#F91880" }]}>
                    {likesCount}
                  </Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity style={styles.actionBtn} onPress={onComment} activeOpacity={0.7}>
                <Ionicons name="chatbubble-outline" size={20} color="#FFFFFF" />
                {commentsCount > 0 && (
                  <Text style={styles.actionCount}>{commentsCount}</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity style={styles.actionBtn} onPress={onBookmark} activeOpacity={0.7}>
                <Ionicons
                  name={isBookmarked ? "bookmark" : "bookmark-outline"}
                  size={22}
                  color={isBookmarked ? "#1D9BF0" : "#FFFFFF"}
                />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    backgroundColor: "#000000",
  },
  page: {
    justifyContent: "center",
    alignItems: "center",
  },
  closeBtn: {
    position: "absolute",
    top: Platform.OS === "ios" ? 54 : 20,
    right: 16,
    zIndex: 20,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 999,
    padding: 8,
  },
  saveBtn: {
    position: "absolute",
    top: Platform.OS === "ios" ? 54 : 20,
    right: 62,
    zIndex: 20,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 999,
    padding: 9,
  },
  saveToast: {
    position: "absolute",
    top: Platform.OS === "ios" ? 100 : 66,
    alignSelf: "center",
    zIndex: 20,
    backgroundColor: "rgba(0,0,0,0.72)",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  saveToastText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
  },
  bottomContainer: {
    position: "absolute",
    bottom: Platform.OS === "ios" ? 54 : 36,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 20,
  },
  paginationContainer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  activeDot: {
    backgroundColor: "#FFFFFF",
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  inactiveDot: {
    backgroundColor: "rgba(255, 255, 255, 0.35)",
  },
  actionRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    width: "100%",
    paddingHorizontal: 32,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 8,
  },
  actionCount: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "500",
  },
});

export default ImageZoomViewer;

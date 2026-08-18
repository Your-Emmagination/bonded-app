import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";

type Props = {
  uri: string;
  width: number;
  /**
   * Whether this video is allowed to play right now. Pass the screen's
   * focus state (e.g. from useIsFocused()) so the video pauses itself when
   * you navigate away — otherwise it just keeps playing in the background
   * off-screen (e.g. after switching to Notifications or Profile).
   * Defaults to true so existing callers that don't pass it keep working.
   */
  isPlaying?: boolean;
};

export default function VideoPostMedia({ uri, width, isPlaying = true }: Props) {
  const player = useVideoPlayer(uri, (instance: VideoPlayer) => {
    instance.loop = false;
    instance.muted = false;
  });

  // Pause playback whenever this video is no longer allowed to play (screen
  // lost focus). We intentionally don't auto-resume when isPlaying flips
  // back to true — the user taps play again via the native controls.
  useEffect(() => {
    if (!isPlaying) {
      player.pause();
    }
  }, [isPlaying, player]);

  return (
    <View style={[styles.container, { width }]}>
      <VideoView
        player={player}
        style={styles.video}
        nativeControls
        allowsFullscreen
        contentFit="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 260,
    marginVertical: 10,
    overflow: "hidden",
    borderRadius: 18,
    backgroundColor: "#111827",
  },
  video: {
    width: "100%",
    height: "100%",
  },
});
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import React from "react";
import { StyleSheet, View } from "react-native";

type Props = {
  uri: string;
  width: number;
};

export default function VideoPostMedia({ uri, width }: Props) {
  const player = useVideoPlayer(uri, (instance: VideoPlayer) => {
    instance.loop = false;
    instance.muted = false;
  });

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

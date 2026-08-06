import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useLocalSearchParams } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from "react-native-webrtc";
import { io, type Socket } from "socket.io-client";

type Audience = "global" | "server";
type StreamMode = "host" | "viewer";
type ConnectionStatus = "idle" | "connecting" | "live" | "error";

type LiveStreamRouteParams = {
  serverId?: string | string[];
  serverName?: string | string[];
  channelId?: string | string[];
  channelLabel?: string | string[];
};

type SignalPayload = {
  senderId: string;
  signal: any;
};

const defaultSignalingUrl =
  process.env.EXPO_PUBLIC_SIGNALING_SERVER_URL || "http://localhost:5000";

const configuration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const getSingleParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const makeRoomId = () =>
  `bonded-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

export default function LiveStreamScreen() {
  const { serverId, serverName, channelLabel } =
    useLocalSearchParams<LiveStreamRouteParams>();
  const navigation = useNavigation();
  const resolvedServerId = getSingleParam(serverId) || "";
  const resolvedServerName = getSingleParam(serverName) || "";
  const resolvedChannelLabel = getSingleParam(channelLabel) || "";
  const hasServerContext = Boolean(resolvedServerId);

  const [mode, setMode] = useState<StreamMode>("host");
  const [audience, setAudience] = useState<Audience>(
    hasServerContext ? "server" : "global",
  );
  const [roomId, setRoomId] = useState(makeRoomId);
  const [signalingUrl, setSignalingUrl] = useState(defaultSignalingUrl);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [localStreamUrl, setLocalStreamUrl] = useState<string | null>(null);
  const [remoteStreamUrl, setRemoteStreamUrl] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [errorText, setErrorText] = useState("");

  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<any>(null);
  const hostPeerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  const viewerPeerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const viewerHostIdRef = useRef<string | null>(null);

  const isBusy = status === "connecting";
  const isLive = status === "live";

  const audienceLabel = useMemo(() => {
    if (audience === "server" && resolvedServerName) {
      return resolvedChannelLabel
        ? `${resolvedServerName} #${resolvedChannelLabel}`
        : resolvedServerName;
    }

    return "Home feed";
  }, [audience, resolvedChannelLabel, resolvedServerName]);

  const handleBack = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    }
  };

  const resetConnections = () => {
    Object.values(hostPeerConnectionsRef.current).forEach((connection) =>
      connection.close(),
    );
    hostPeerConnectionsRef.current = {};
    viewerPeerConnectionRef.current?.close();
    viewerPeerConnectionRef.current = null;
    viewerHostIdRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    localStreamRef.current?.getTracks().forEach((track: any) => track.stop());
    localStreamRef.current = null;
    setLocalStreamUrl(null);
    setRemoteStreamUrl(null);
    setViewerCount(0);
  };

  useEffect(() => resetConnections, []);

  const createSocket = () => {
    const socket = io(signalingUrl.trim(), {
      transports: ["websocket"],
      reconnectionAttempts: 3,
    });

    socket.on("connect_error", (error) => {
      setStatus("error");
      setErrorText(error.message || "Could not connect to the signaling server.");
    });

    socket.on("host-left", () => {
      setStatus("idle");
      setRemoteStreamUrl(null);
      Alert.alert("Stream ended", "The host disconnected from this room.");
    });

    socketRef.current = socket;
    return socket;
  };

  const handleHostSignal = async ({ senderId, signal }: SignalPayload) => {
    const peerConnection = hostPeerConnectionsRef.current[senderId];
    if (!peerConnection) return;

    if (signal.type === "answer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
      return;
    }

    if (signal.candidate) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  };

  const handleViewerSignal = async ({ senderId, signal }: SignalPayload) => {
    const peerConnection = viewerPeerConnectionRef.current;
    if (!peerConnection) return;

    if (signal.type === "offer") {
      viewerHostIdRef.current = senderId;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socketRef.current?.emit("signal", { targetId: senderId, signal: answer });
      setStatus("live");
      return;
    }

    if (signal.candidate) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  };

  const handleStartHost = async () => {
    if (Platform.OS === "web") {
      Alert.alert("Native only", "WebRTC live streaming is available in the native app.");
      return;
    }

    const trimmedUrl = signalingUrl.trim();
    const trimmedRoomId = roomId.trim();
    if (!trimmedUrl || !trimmedRoomId) {
      Alert.alert("Missing info", "Add a signaling URL and room ID.");
      return;
    }

    resetConnections();
    setStatus("connecting");
    setErrorText("");

    try {
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: "user",
          frameRate: 30,
        },
      });

      localStreamRef.current = stream;
      setLocalStreamUrl(stream.toURL());

      const socket = createSocket();
      socket.on("signal", handleHostSignal);
      socket.on("viewer-joined", async ({ viewerId }: { viewerId: string }) => {
        const peerConnection = new RTCPeerConnection(configuration);
        hostPeerConnectionsRef.current[viewerId] = peerConnection;

        stream.getTracks().forEach((track: any) => {
          peerConnection.addTrack(track, stream);
        });

        peerConnection.onicecandidate = (event: any) => {
          if (event.candidate) {
            socket.emit("signal", {
              targetId: viewerId,
              signal: { candidate: event.candidate },
            });
          }
        };

        const offer = await peerConnection.createOffer({});
        await peerConnection.setLocalDescription(offer);
        socket.emit("signal", { targetId: viewerId, signal: offer });
        setViewerCount((current) => current + 1);
      });

      socket.emit("join-as-host", trimmedRoomId);
      setRoomId(trimmedRoomId);
      setStatus("live");
    } catch (error: any) {
      resetConnections();
      setStatus("error");
      setErrorText(error?.message || "Could not start the WebRTC live stream.");
      Alert.alert("Error", "Could not start the WebRTC live stream.");
    }
  };

  const handleStartViewer = async () => {
    if (Platform.OS === "web") {
      Alert.alert("Native only", "WebRTC live streaming is available in the native app.");
      return;
    }

    const trimmedUrl = signalingUrl.trim();
    const trimmedRoomId = roomId.trim();
    if (!trimmedUrl || !trimmedRoomId) {
      Alert.alert("Missing info", "Add a signaling URL and room ID.");
      return;
    }

    resetConnections();
    setStatus("connecting");
    setErrorText("");

    try {
      const socket = createSocket();
      const peerConnection = new RTCPeerConnection(configuration);
      viewerPeerConnectionRef.current = peerConnection;

      peerConnection.ontrack = (event: any) => {
        if (event.streams?.[0]) {
          setRemoteStreamUrl(event.streams[0].toURL());
          setStatus("live");
        }
      };

      peerConnection.onicecandidate = (event: any) => {
        const targetId = viewerHostIdRef.current;
        if (event.candidate && targetId) {
          socket.emit("signal", {
            targetId,
            signal: { candidate: event.candidate },
          });
        }
      };

      socket.on("signal", handleViewerSignal);
      socket.on("host-unavailable", () => {
        setStatus("error");
        setErrorText("No host is live in this room yet.");
      });
      socket.emit("join-as-viewer", trimmedRoomId);
      setRoomId(trimmedRoomId);
    } catch (error: any) {
      resetConnections();
      setStatus("error");
      setErrorText(error?.message || "Could not join the WebRTC live stream.");
      Alert.alert("Error", "Could not join the WebRTC live stream.");
    }
  };

  const handleStop = () => {
    resetConnections();
    setStatus("idle");
    setErrorText("");
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.iconButton} onPress={handleBack}>
          <Ionicons name="arrow-back" size={23} color="#5f0909" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Live Stream</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.previewPanel, isLive && styles.previewPanelLive]}>
          <View style={styles.previewTopRow}>
            <View style={[styles.livePill, isLive && styles.livePillActive]}>
              <View style={[styles.liveDot, isLive && styles.liveDotActive]} />
              <Text style={styles.livePillText}>
                {isLive ? "LIVE" : status === "connecting" ? "CONNECTING" : "READY"}
              </Text>
            </View>
            <Text style={styles.audienceText}>{audienceLabel}</Text>
          </View>

          <View style={styles.videoFrame}>
            {mode === "host" && localStreamUrl ? (
              <RTCView
                streamURL={localStreamUrl}
                style={styles.video}
                objectFit="cover"
                mirror
              />
            ) : mode === "viewer" && remoteStreamUrl ? (
              <RTCView
                streamURL={remoteStreamUrl}
                style={styles.video}
                objectFit="cover"
              />
            ) : (
              <View style={styles.videoPlaceholder}>
                <Ionicons name="radio-outline" size={54} color="#fffaf7" />
                <Text style={styles.videoTitle}>
                  {mode === "host" ? "Host camera" : "Viewer room"}
                </Text>
                <Text style={styles.videoSubtitle}>
                  {mode === "host"
                    ? "Start hosting to publish your camera over WebRTC."
                    : "Join a room ID after the host starts streaming."}
                </Text>
              </View>
            )}
          </View>
        </View>

        <View style={styles.formSection}>
          <Text style={styles.label}>Mode</Text>
          <View style={styles.segmentRow}>
            <TouchableOpacity
              style={[styles.segmentButton, mode === "host" && styles.segmentButtonActive]}
              onPress={() => setMode("host")}
              disabled={isBusy || isLive}
            >
              <Ionicons
                name="videocam-outline"
                size={18}
                color={mode === "host" ? "#fffaf7" : "#5f0909"}
              />
              <Text style={[styles.segmentText, mode === "host" && styles.segmentTextActive]}>
                Host
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.segmentButton,
                mode === "viewer" && styles.segmentButtonActive,
              ]}
              onPress={() => setMode("viewer")}
              disabled={isBusy || isLive}
            >
              <Ionicons
                name="eye-outline"
                size={18}
                color={mode === "viewer" ? "#fffaf7" : "#5f0909"}
              />
              <Text
                style={[styles.segmentText, mode === "viewer" && styles.segmentTextActive]}
              >
                Viewer
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.label}>Room ID</Text>
          <TextInput
            value={roomId}
            onChangeText={(value) => setRoomId(value.toUpperCase())}
            editable={!isBusy && !isLive}
            autoCapitalize="characters"
            placeholder="BONDED-ROOM"
            placeholderTextColor="#a9867c"
            style={styles.input}
          />

          <Text style={styles.label}>Signaling Server</Text>
          <TextInput
            value={signalingUrl}
            onChangeText={setSignalingUrl}
            editable={!isBusy && !isLive}
            autoCapitalize="none"
            keyboardType="url"
            placeholder="http://192.168.1.10:5000"
            placeholderTextColor="#a9867c"
            style={styles.input}
          />

          <Text style={styles.label}>Audience</Text>
          <View style={styles.segmentRow}>
            <TouchableOpacity
              style={[
                styles.segmentButton,
                audience === "global" && styles.segmentButtonActive,
              ]}
              onPress={() => setAudience("global")}
              disabled={isBusy || isLive}
            >
              <Ionicons
                name="home-outline"
                size={18}
                color={audience === "global" ? "#fffaf7" : "#5f0909"}
              />
              <Text
                style={[
                  styles.segmentText,
                  audience === "global" && styles.segmentTextActive,
                ]}
              >
                Home
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.segmentButton,
                audience === "server" && styles.segmentButtonActive,
                !hasServerContext && styles.segmentButtonDisabled,
              ]}
              onPress={() => setAudience("server")}
              disabled={!hasServerContext || isBusy || isLive}
            >
              <Ionicons
                name="people-outline"
                size={18}
                color={audience === "server" ? "#fffaf7" : "#5f0909"}
              />
              <Text
                style={[
                  styles.segmentText,
                  audience === "server" && styles.segmentTextActive,
                ]}
              >
                Group
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {!!errorText && (
          <View style={styles.errorBox}>
            <Ionicons name="warning-outline" size={18} color="#8f2117" />
            <Text style={styles.errorText}>{errorText}</Text>
          </View>
        )}

        {isLive ? (
          <View style={styles.liveControls}>
            <View style={styles.roomCard}>
              <Text style={styles.roomLabel}>Share this room ID</Text>
              <Text style={styles.roomValue}>{roomId}</Text>
              {mode === "host" && (
                <Text style={styles.roomHint}>{viewerCount} viewer connection(s)</Text>
              )}
            </View>
            <TouchableOpacity style={styles.endButton} onPress={handleStop}>
              <Ionicons name="stop-circle-outline" size={21} color="#fffaf7" />
              <Text style={styles.primaryButtonText}>End Live</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.primaryButton, isBusy && styles.buttonDisabled]}
            onPress={mode === "host" ? handleStartHost : handleStartViewer}
            disabled={isBusy}
          >
            {isBusy ? (
              <ActivityIndicator color="#fffaf7" />
            ) : (
              <>
                <Ionicons name="radio-outline" size={21} color="#fffaf7" />
                <Text style={styles.primaryButtonText}>
                  {mode === "host" ? "Start Hosting" : "Join Stream"}
                </Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#5f0909",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#f6f1ed",
    borderBottomWidth: 1,
    borderBottomColor: "#ead7cf",
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#ead7cf",
  },
  headerTitle: {
    color: "#5f0909",
    fontSize: 18,
    fontWeight: "800",
  },
  headerSpacer: {
    width: 42,
  },
  scroll: {
    flex: 1,
    backgroundColor: "#f6f1ed",
  },
  content: {
    padding: 16,
    paddingBottom: 36,
  },
  previewPanel: {
    backgroundColor: "#3d0808",
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#8f3a2b",
    marginBottom: 18,
  },
  previewPanelLive: {
    borderColor: "#ff4d4d",
  },
  previewTopRow: {
    minHeight: 48,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "rgba(255,250,247,0.14)",
  },
  livePillActive: {
    backgroundColor: "#ff2d2d",
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#e0a53d",
  },
  liveDotActive: {
    backgroundColor: "#fffaf7",
  },
  livePillText: {
    color: "#fffaf7",
    fontSize: 12,
    fontWeight: "800",
  },
  audienceText: {
    color: "#f0d2c2",
    fontSize: 12.5,
    fontWeight: "700",
    flexShrink: 1,
    textAlign: "right",
  },
  videoFrame: {
    aspectRatio: 16 / 9,
    overflow: "hidden",
    backgroundColor: "#5f0909",
  },
  video: {
    flex: 1,
  },
  videoPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 22,
  },
  videoTitle: {
    color: "#fffaf7",
    fontSize: 20,
    fontWeight: "800",
    marginTop: 12,
    textAlign: "center",
  },
  videoSubtitle: {
    color: "#f0d2c2",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
    textAlign: "center",
  },
  formSection: {
    backgroundColor: "#fffaf7",
    borderRadius: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: "#ead7cf",
    marginBottom: 16,
  },
  label: {
    color: "#8f3a2b",
    fontSize: 11.5,
    fontWeight: "800",
    textTransform: "uppercase",
    marginBottom: 7,
    marginTop: 4,
  },
  input: {
    minHeight: 46,
    backgroundColor: "#fdf4ef",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ecd6bf",
    color: "#4d1b17",
    fontSize: 14.5,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginBottom: 14,
  },
  segmentRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 14,
  },
  segmentButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e4cfc6",
    backgroundColor: "#fff4ee",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  segmentButtonActive: {
    backgroundColor: "#5f0909",
    borderColor: "#5f0909",
  },
  segmentButtonDisabled: {
    opacity: 0.45,
  },
  segmentText: {
    color: "#5f0909",
    fontSize: 14,
    fontWeight: "800",
  },
  segmentTextActive: {
    color: "#fffaf7",
  },
  errorBox: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    backgroundColor: "#fff0eb",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#efc9bd",
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: "#8f2117",
    flex: 1,
    fontSize: 13.5,
    lineHeight: 19,
  },
  primaryButton: {
    minHeight: 54,
    borderRadius: 8,
    backgroundColor: "#b64040",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  endButton: {
    minHeight: 54,
    borderRadius: 8,
    backgroundColor: "#5f0909",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  buttonDisabled: {
    opacity: 0.65,
  },
  primaryButtonText: {
    color: "#fffaf7",
    fontSize: 16,
    fontWeight: "800",
  },
  liveControls: {
    gap: 10,
  },
  roomCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ead7cf",
    padding: 14,
  },
  roomLabel: {
    color: "#8f3a2b",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  roomValue: {
    color: "#5f0909",
    fontSize: 24,
    fontWeight: "900",
    marginTop: 4,
  },
  roomHint: {
    color: "#8f3a2b",
    fontSize: 13,
    marginTop: 4,
  },
});

// utils/useAgoraLive.ts
//
// The Agora engine, as one hook that both sides of a stream use.
//
// Host and viewer differ by exactly one thing — which client role they join
// as — so they share this rather than duplicating engine setup twice with a
// subtle difference in the middle. The hook owns the engine's whole life: it
// is created on mount, joined once permissions and a token are in hand, and
// destroyed on unmount whatever route the screen left by.
//
// Nothing here writes to Firestore. The stream document is already the record
// of who is live; this only carries pictures. If Agora is swapped out later,
// this file goes and nothing else does.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, PermissionsAndroid, Platform } from "react-native";
import {
  ChannelProfileType,
  ClientRoleType,
  createAgoraRtcEngine,
  MediaRecorderContainerFormat,
  MediaRecorderStreamType,
  RecorderState,
  RecorderStreamType,
  type IMediaRecorder,
  type IRtcEngine,
} from "react-native-agora";

import {
  AgoraTokenError,
  agoraUidFor,
  fetchAgoraToken,
  getAgoraAppId,
} from "./agoraConfig";
import {
  discardRecording,
  fileUriToPath,
  newReplayFileUri,
  REPLAY_MAX_DURATION_MS,
  sweepStaleReplayFiles,
  type LiveRecording,
} from "./liveReplay";

/**
 * The host's video bitrate, in Kbps. Pinned rather than left to Agora's
 * default so a recorded replay has a predictable size (see liveReplay.ts),
 * and so a broadcast holds up on campus Wi-Fi. 960×540 at 15 fps looks sharp
 * on a phone at this rate.
 */
const HOST_VIDEO_BITRATE_KBPS = 900;

/**
 * Turns an Agora error code into something a person can act on.
 *
 * Agora's own message is frequently empty, which leaves only the number — and
 * a number on a black screen tells nobody anything. The codes worth naming are
 * the ones caused by configuration rather than by the network, because those
 * are the ones somebody can go and fix. The code is always appended: when the
 * cause is not one of these, the number is what makes it searchable.
 */
function agoraErrorMessage(code: number, message?: string): string {
  const detail = (message || "").trim();
  const withCode = (text: string) => `${text} (Agora error ${code})`;

  switch (code) {
    case 110: // ErrInvalidToken
      return withCode(
        "Agora rejected the live video token. The App ID and certificate on the server must belong to the same Agora project as this app.",
      );
    case 109: // ErrTokenExpired
      return withCode("The live video session expired. Leave and open the stream again.");
    case 101: // ErrInvalidAppId
      return withCode("The Agora App ID in this build is not valid.");
    case 17: // ErrJoinChannelRejected
      return withCode("Could not join the broadcast channel.");
    case 2: // ErrInvalidArgument
      return withCode("The broadcast was started with an invalid setting.");
    case 7: // ErrNotInitialized
      return withCode("Live video was not ready in time.");
    default:
      return withCode(detail || "The broadcast ran into a problem.");
  }
}

export type AgoraRole = "host" | "audience";

/**
 * Where the host's camera and microphone access stands.
 * "denied" can be asked again in the app; "blocked" means Android has stopped
 * showing its prompt and only the system settings can change the answer.
 */
export type MediaPermission = "unknown" | "granted" | "denied" | "blocked";

export type AgoraLiveState = {
  /** True once this client is in the channel. */
  joined: boolean;
  /** The broadcaster's uid, once one is publishing. Null while waiting. */
  remoteUid: number | null;
  /** This client's own uid, for rendering the local preview. */
  localUid: number;
  /** Set when the stream could not start, phrased for a person. */
  error: string | null;
  /** False while permissions, token and join are still in flight. */
  ready: boolean;

  /** The host's camera and microphone access. Viewers are never asked. */
  permission: MediaPermission;
  /** Asks for camera and microphone again, and joins if they are given. */
  retryPermissions: () => void;
  /** Opens BondED's page in the system settings, for a blocked permission. */
  openPermissionSettings: () => void;

  /** True while the host's broadcast is being recorded for a replay. */
  recording: boolean;

  /**
   * Host controls. Each acts on the running engine and is a no-op before the
   * engine exists, so a button pressed during start-up does nothing rather
   * than throwing.
   */
  switchCamera: () => void;
  setMicMuted: (muted: boolean) => void;
  setCameraOff: (off: boolean) => void;
};

/** What a host needs from Android before broadcasting. */
const hostPermissions = () => [
  PermissionsAndroid.PERMISSIONS.CAMERA,
  PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
];

/**
 * Camera and microphone, which Android must ask for at runtime.
 *
 * Only a host is asked. A viewer publishes nothing, and asking them for the
 * microphone anyway meant somebody who tapped "Don't allow" could not watch.
 */
async function ensureMediaPermissions(role: AgoraRole): Promise<MediaPermission> {
  if (Platform.OS !== "android" || role !== "host") return "granted";
  const wanted = hostPermissions();
  const result = await PermissionsAndroid.requestMultiple(wanted);
  const outcomes = wanted.map((permission) => result[permission]);
  if (outcomes.every((outcome) => outcome === PermissionsAndroid.RESULTS.GRANTED)) {
    return "granted";
  }
  // After a second refusal Android answers for the person without showing
  // anything, so asking again from the app can no longer work.
  return outcomes.some((outcome) => outcome === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)
    ? "blocked"
    : "denied";
}

/** Whether the host's permissions are in place, without prompting. */
async function hasHostPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const checks = await Promise.all(
    hostPermissions().map((permission) => PermissionsAndroid.check(permission)),
  );
  return checks.every(Boolean);
}

export type AgoraLiveOptions = {
  /** Record the host's broadcast, for a replay. Ignored for viewers. */
  record?: boolean;
  /**
   * Called with the finished recording when the engine shuts down — the live
   * ended, or the screen closed. Without it the file is thrown away.
   */
  onRecordingFinished?: (recording: LiveRecording) => void;
};

/**
 * Joins `channelName` in the given role and keeps the engine alive for as long
 * as the component is mounted.
 *
 * Passing a null channel is valid and does nothing — a screen can render
 * before the stream document has loaded, and that should not be an error.
 */
export function useAgoraLive(
  channelName: string | null,
  role: AgoraRole,
  firebaseUid: string | null,
  options: AgoraLiveOptions = {},
): AgoraLiveState {
  const engineRef = useRef<IRtcEngine | null>(null);
  const [joined, setJoined] = useState(false);
  const [remoteUid, setRemoteUid] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [permission, setPermission] = useState<MediaPermission>("unknown");
  // Bumped to run the whole start-up again after permissions change.
  const [attempt, setAttempt] = useState(0);
  const [recording, setRecording] = useState(false);

  const record = role === "host" && options.record === true;
  // The latest handler, read when the engine shuts down rather than being a
  // reason to restart it.
  const onRecordingFinishedRef = useRef(options.onRecordingFinished);
  useEffect(() => {
    onRecordingFinishedRef.current = options.onRecordingFinished;
  });

  const localUid = firebaseUid ? agoraUidFor(firebaseUid) : 0;

  // Reading the config is pure, so a build with no App ID is a derived fact
  // rather than something the effect has to announce by setting state.
  const appId = getAgoraAppId();
  const unconfigured = Boolean(channelName && firebaseUid && !appId);

  useEffect(() => {
    if (!channelName || !firebaseUid || !appId) return;

    let cancelled = false;
    let engine: IRtcEngine | null = null;

    // ── Replay recording ────────────────────────────────────────────────
    // Agora writes the host's own outgoing audio and video to a file on the
    // phone. It starts once the host is in the channel and stops when the
    // engine shuts down; whoever asked for it decides what the file becomes.
    let recorder: IMediaRecorder | null = null;
    let recordingUri: string | null = null;
    let recordingStartedAt = 0;
    let recordedMs = 0;

    const startRecording = (uid: number) => {
      if (!record || !engine || recorder) return;
      const fileUri = newReplayFileUri(channelName);
      if (!fileUri) return;
      try {
        const next = engine.createMediaRecorder({
          channelId: channelName,
          uid,
          type: RecorderStreamType.Rtc,
        });
        next.setMediaRecorderObserver({
          onRecorderStateChanged: (_channel, _uid, state) => {
            // A stop is always worth hearing, even after shutdown began.
            if (cancelled && state === RecorderState.RecorderStateStart) return;
            setRecording(state === RecorderState.RecorderStateStart);
          },
          onRecorderInfoUpdated: (_channel, _uid, info) => {
            if (typeof info.durationMs === "number") recordedMs = info.durationMs;
          },
        });
        const code = next.startRecording({
          storagePath: fileUriToPath(fileUri),
          containerFormat: MediaRecorderContainerFormat.FormatMp4,
          streamType: MediaRecorderStreamType.StreamTypeBoth,
          maxDurationMs: REPLAY_MAX_DURATION_MS,
          recorderInfoUpdateInterval: 1000,
        });
        if (code < 0) {
          engine.destroyMediaRecorder(next);
          return;
        }
        recorder = next;
        recordingUri = fileUri;
        recordingStartedAt = Date.now();
        void sweepStaleReplayFiles();
      } catch {
        // A live without a replay is still a live.
      }
    };

    const finishRecording = () => {
      const current = recorder;
      const fileUri = recordingUri;
      recorder = null;
      recordingUri = null;
      if (!current || !fileUri) return;
      try {
        current.stopRecording();
      } catch {
        // Stopping a recorder that already hit its time limit can throw.
      }
      try {
        engine?.destroyMediaRecorder(current);
      } catch {
        // Nothing depends on this having worked.
      }
      const durationMs =
        recordedMs || Math.min(Date.now() - recordingStartedAt, REPLAY_MAX_DURATION_MS);
      const handler = onRecordingFinishedRef.current;
      if (handler) handler({ fileUri, durationMs });
      else discardRecording(fileUri);
    };

    const start = async () => {
      const access = await ensureMediaPermissions(role);
      if (cancelled) return;
      setPermission(access);
      if (access !== "granted") {
        setError(
          access === "blocked"
            ? "Camera or microphone access is turned off for BondED. Turn both on in Settings to go live."
            : "BondED needs your camera and microphone to go live.",
        );
        setReady(true);
        return;
      }

      engine = createAgoraRtcEngine();
      engineRef.current = engine;
      engine.initialize({ appId });

      engine.registerEventHandler({
        onJoinChannelSuccess: (connection) => {
          if (!cancelled) {
            setJoined(true);
            setReady(true);
            startRecording(connection?.localUid ?? localUid);
          }
        },
        // The host is the only publisher, so the first remote user to appear
        // is the one worth rendering.
        onUserJoined: (_connection, uid) => {
          if (!cancelled) setRemoteUid(uid);
        },
        onUserOffline: (_connection, uid) => {
          if (!cancelled) {
            setRemoteUid((current) => (current === uid ? null : current));
          }
        },
        onError: (code, message) => {
          if (!cancelled) {
            setError(agoraErrorMessage(code, message));
            setReady(true);
          }
        },
        // Tokens last three hours. Agora warns shortly before one lapses, and
        // again if it already has; either way a fresh one keeps the stream up
        // without anybody being dropped from it.
        onTokenPrivilegeWillExpire: () => {
          renew();
        },
        onRequestToken: () => {
          renew();
        },
      });

      engine.setChannelProfile(ChannelProfileType.ChannelProfileLiveBroadcasting);
      engine.enableVideo();

      if (role === "host") {
        engine.setVideoEncoderConfiguration({
          dimensions: { width: 960, height: 540 },
          frameRate: 15,
          bitrate: HOST_VIDEO_BITRATE_KBPS,
        });
        engine.startPreview();
      }

      let grant;
      try {
        grant = await fetchAgoraToken(channelName, role);
      } catch (tokenError) {
        if (!cancelled) {
          setError(
            tokenError instanceof AgoraTokenError
              ? tokenError.message
              : "Could not get permission to join the broadcast.",
          );
          setReady(true);
        }
        return;
      }
      if (cancelled) return;

      // Join as whatever the server granted, not what was asked for. The two
      // only differ if somebody requested host rights they don't have, and a
      // client that publishes anyway would just be refused by Agora.
      const publishing = grant.role === "host";
      engine.joinChannel(grant.token, channelName, grant.uid, {
        clientRoleType: publishing
          ? ClientRoleType.ClientRoleBroadcaster
          : ClientRoleType.ClientRoleAudience,
        // An audience member should not be heard or seen by anyone.
        publishMicrophoneTrack: publishing,
        publishCameraTrack: publishing,
        autoSubscribeAudio: true,
        autoSubscribeVideo: true,
      });
    };

    const renew = () => {
      fetchAgoraToken(channelName, role)
        .then((grant) => {
          if (!cancelled) engineRef.current?.renewToken(grant.token);
        })
        .catch(() => {
          // A failed renewal surfaces on its own: Agora reports the expiry
          // through onError, which already explains it.
        });
    };

    start().catch(() => {
      if (!cancelled) {
        setError("Could not start live video.");
        setReady(true);
      }
    });

    return () => {
      cancelled = true;
      // Before leaving: the recorder needs the engine to close its file.
      finishRecording();
      const current = engineRef.current;
      engineRef.current = null;
      if (!current) return;
      try {
        if (role === "host") current.stopPreview();
        current.leaveChannel();
        current.unregisterEventHandler({});
        current.release();
      } catch {
        // Leaving a channel that never joined throws; there is nothing to do
        // about it and nothing depends on it having worked.
      }
    };
  }, [channelName, role, firebaseUid, localUid, appId, attempt, record]);

  // Starts over from the permission prompt. The state is cleared here, in the
  // handler, so the screen goes back to "starting" the moment it is tapped.
  const retryPermissions = useCallback(() => {
    setError(null);
    setReady(false);
    setPermission("unknown");
    setAttempt((count) => count + 1);
  }, []);

  const openPermissionSettings = useCallback(() => {
    Linking.openSettings().catch(() => undefined);
  }, []);

  // Coming back from the settings page with access turned on joins without
  // another tap. Only listened for while access is missing.
  const needsAccess = permission === "denied" || permission === "blocked";
  useEffect(() => {
    if (!needsAccess) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      hasHostPermissions()
        .then((granted) => {
          if (granted) retryPermissions();
        })
        .catch(() => undefined);
    });
    return () => subscription.remove();
  }, [needsAccess, retryPermissions]);

  const switchCamera = useCallback(() => {
    engineRef.current?.switchCamera();
  }, []);

  // Muting stops sending sound but keeps the microphone open, so unmuting is
  // instant — there is no device to reacquire.
  const setMicMuted = useCallback((muted: boolean) => {
    engineRef.current?.muteLocalAudioStream(muted);
  }, []);

  // Turning the camera off actually releases it rather than just not sending
  // frames, so the phone's camera indicator goes out too. Somebody who turns
  // their camera off should be able to trust that it is off.
  const setCameraOff = useCallback((off: boolean) => {
    engineRef.current?.enableLocalVideo(!off);
  }, []);

  return {
    joined,
    remoteUid,
    localUid,
    error: unconfigured ? "Live video is not configured for this build." : error,
    ready: unconfigured ? true : ready,
    permission,
    retryPermissions,
    openPermissionSettings,
    recording,
    switchCamera,
    setMicMuted,
    setCameraOff,
  };
}

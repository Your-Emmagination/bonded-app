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
import { PermissionsAndroid, Platform } from "react-native";
import {
  ChannelProfileType,
  ClientRoleType,
  createAgoraRtcEngine,
  type IRtcEngine,
} from "react-native-agora";

import {
  AgoraTokenError,
  agoraUidFor,
  fetchAgoraToken,
  getAgoraAppId,
} from "./agoraConfig";

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

  /**
   * Host controls. Each acts on the running engine and is a no-op before the
   * engine exists, so a button pressed during start-up does nothing rather
   * than throwing.
   */
  switchCamera: () => void;
  setMicMuted: (muted: boolean) => void;
  setCameraOff: (off: boolean) => void;
};

/** Camera and microphone, which Android must ask for at runtime. */
async function ensureMediaPermissions(role: AgoraRole): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const wanted = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  // An audience member publishes nothing, so asking for their camera would be
  // a prompt with no purpose behind it.
  if (role === "host") wanted.push(PermissionsAndroid.PERMISSIONS.CAMERA);

  const result = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every(
    (permission) => result[permission] === PermissionsAndroid.RESULTS.GRANTED,
  );
}

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
): AgoraLiveState {
  const engineRef = useRef<IRtcEngine | null>(null);
  const [joined, setJoined] = useState(false);
  const [remoteUid, setRemoteUid] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const localUid = firebaseUid ? agoraUidFor(firebaseUid) : 0;

  // Reading the config is pure, so a build with no App ID is a derived fact
  // rather than something the effect has to announce by setting state.
  const appId = getAgoraAppId();
  const unconfigured = Boolean(channelName && firebaseUid && !appId);

  useEffect(() => {
    if (!channelName || !firebaseUid || !appId) return;

    let cancelled = false;
    let engine: IRtcEngine | null = null;

    const start = async () => {
      if (!(await ensureMediaPermissions(role))) {
        if (!cancelled) {
          setError(
            role === "host"
              ? "Camera and microphone access are needed to go live."
              : "Microphone access is needed to join.",
          );
          setReady(true);
        }
        return;
      }

      engine = createAgoraRtcEngine();
      engineRef.current = engine;
      engine.initialize({ appId });

      engine.registerEventHandler({
        onJoinChannelSuccess: () => {
          if (!cancelled) {
            setJoined(true);
            setReady(true);
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
  }, [channelName, role, firebaseUid, localUid, appId]);

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
    switchCamera,
    setMicMuted,
    setCameraOff,
  };
}

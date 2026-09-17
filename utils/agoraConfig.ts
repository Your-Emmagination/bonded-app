// utils/agoraConfig.ts
//
// Where the Agora App ID comes from, and whether tokens are in play.
//
// Same shape as aiConfig.ts: an env var wins, then app.json's `extra`, then
// nothing. There is deliberately no hardcoded fallback — an App ID identifies
// a billable project, and one baked into the repo is one that follows the code
// anywhere it is copied.
//
// Tokens come from the Worker. The Agora project has an App Certificate, so
// every join needs a token signed with it, and the certificate can only live
// on a server. The app proves who it is with its Firebase ID token; the Worker
// checks the stream and signs a token for that user and channel only.
import Constants from "expo-constants";

import { auth } from "../Firebase_configure";
import { getAiWorkerUrl } from "./aiConfig";

type ExtraConfig = {
  agoraAppId?: string;
  agoraTokenEndpoint?: string;
};

const trimmed = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const getExpoExtra = (): ExtraConfig => {
  const fromConfig = (Constants.expoConfig?.extra ?? {}) as ExtraConfig;
  if (fromConfig.agoraAppId) return fromConfig;
  return (Constants.manifest2?.extra ?? {}) as ExtraConfig;
};

/** The App ID, or "" when this build has not been given one. */
export const getAgoraAppId = (): string =>
  trimmed(process.env.EXPO_PUBLIC_AGORA_APP_ID) ||
  trimmed(getExpoExtra().agoraAppId);

/**
 * Where tokens are minted. The same Worker the app already uses, unless a
 * build points somewhere else.
 */
export const getAgoraTokenEndpoint = (): string =>
  trimmed(process.env.EXPO_PUBLIC_AGORA_TOKEN_ENDPOINT) ||
  trimmed(getExpoExtra().agoraTokenEndpoint) ||
  getAiWorkerUrl();

export const isAgoraConfigured = (): boolean => getAgoraAppId().length > 0;

export type AgoraTokenGrant = {
  token: string;
  /** The uid the token was signed for. Join with exactly this. */
  uid: number;
  /** What the server agreed to: a viewer asking for host rights gets audience. */
  role: "host" | "audience";
};

/** Why a token could not be had, in words a person can act on. */
export class AgoraTokenError extends Error {}

/**
 * Asks the Worker for a token for this channel.
 *
 * The uid is not sent: the server derives it from the verified Firebase user,
 * so nobody can ask for a token under someone else's identity.
 */
export async function fetchAgoraToken(
  channelName: string,
  role: "host" | "audience",
): Promise<AgoraTokenGrant> {
  const endpoint = getAgoraTokenEndpoint();
  const user = auth.currentUser;
  if (!user) throw new AgoraTokenError("Sign in again to watch live streams.");

  let response: Response;
  try {
    const idToken = await user.getIdToken();
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ mode: "agora-token", channelName, role }),
    });
  } catch {
    throw new AgoraTokenError("Could not reach the live video server. Check your connection.");
  }

  const payload = (await response.json().catch(() => null)) as
    | (Partial<AgoraTokenGrant> & { error?: string })
    | null;

  if (!response.ok || !payload?.token || typeof payload.uid !== "number") {
    throw new AgoraTokenError(
      payload?.error || `The live video server refused the request (${response.status}).`,
    );
  }
  return {
    token: payload.token,
    uid: payload.uid,
    role: payload.role === "host" ? "host" : "audience",
  };
}

/**
 * A numeric Agora uid derived from the Firebase uid.
 *
 * Agora identifies participants by a 32-bit number, and Firebase by a string,
 * so one has to be folded into the other. A plain hash is enough: it only has
 * to be stable for one person within one channel, and zero is reserved by
 * Agora for "assign me one", so it is mapped away.
 */
export function agoraUidFor(firebaseUid: string): number {
  let hash = 0;
  for (let i = 0; i < firebaseUid.length; i += 1) {
    hash = (hash << 5) - hash + firebaseUid.charCodeAt(i);
    hash |= 0;
  }
  const positive = Math.abs(hash) % 2_147_483_646;
  return positive === 0 ? 1 : positive;
}

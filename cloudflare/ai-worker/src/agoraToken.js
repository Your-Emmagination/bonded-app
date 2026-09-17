// Agora RTC tokens for live streams.
//
// The project behind the app has an App Certificate, which means Agora refuses
// any join that does not carry a token signed with it — and the certificate is
// exactly the thing that must never ship inside the app. So the app asks here,
// proves who it is with its Firebase ID token, and gets back a short-lived
// token for one channel and one uid.
//
// Two checks decide what is issued, both against the stream document rather
// than anything the client says about itself:
//   • the stream must exist and still be live, so a token can't be minted for
//     a channel nobody is broadcasting on;
//   • only the stream's host gets publish rights. Everyone else is issued a
//     subscriber token, so a viewer who tampers with their client still cannot
//     put video into somebody else's stream.
//
// The token format is Agora's AccessToken2 ("007"), implemented on Web Crypto
// because the Worker has no Node crypto. It was checked against Agora's own
// reference builder (the agora-token package) with pinned timestamps and salts:
// the decompressed payloads, signature included, match byte for byte.

const VERSION = "007";

const SERVICE_RTC = 1;
const PRIV_JOIN_CHANNEL = 1;
const PRIV_PUBLISH_AUDIO = 2;
const PRIV_PUBLISH_VIDEO = 3;
const PRIV_PUBLISH_DATA = 4;

/** Long enough for any single stream; the client renews before it lapses. */
export const TOKEN_TTL_SECONDS = 3 * 60 * 60;

const encoder = new TextEncoder();

// ── Binary packing (little-endian, as Agora's reference implementation) ─────

const uint16 = (value) => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
};

const uint32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const packBytes = (bytes) => concat(uint16(bytes.length), bytes);

/** Privileges are written in ascending key order, as the reference does. */
const packPrivileges = (privileges) => {
  const keys = Object.keys(privileges)
    .map(Number)
    .sort((a, b) => a - b);
  return concat(
    uint16(keys.length),
    ...keys.flatMap((key) => [uint16(key), uint32(privileges[key])]),
  );
};

async function hmacSha256(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, messageBytes));
}

/** zlib (RFC 1950) — CompressionStream's "deflate" is the zlib-wrapped form. */
async function zlibCompress(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const toBase64 = (bytes) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const randomSalt = () => {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] % 99999999) + 1;
};

/**
 * Builds an AccessToken2 for one RTC channel.
 *
 * `issueTs` and `salt` are only passed by the test, which pins them so the
 * output can be compared with Agora's own builder byte for byte.
 */
export async function buildRtcToken({
  appId,
  appCertificate,
  channelName,
  uid,
  publisher,
  expireSeconds = TOKEN_TTL_SECONDS,
  issueTs = Math.floor(Date.now() / 1000),
  salt = randomSalt(),
}) {
  const privileges = { [PRIV_JOIN_CHANNEL]: expireSeconds };
  if (publisher) {
    privileges[PRIV_PUBLISH_AUDIO] = expireSeconds;
    privileges[PRIV_PUBLISH_VIDEO] = expireSeconds;
    privileges[PRIV_PUBLISH_DATA] = expireSeconds;
  }

  // Agora treats uid 0 as "any uid", written as an empty string.
  const uidBytes = uid === 0 ? new Uint8Array(0) : encoder.encode(String(uid));
  const service = concat(
    uint16(SERVICE_RTC),
    packPrivileges(privileges),
    packBytes(encoder.encode(channelName)),
    packBytes(uidBytes),
  );

  const signingInfo = concat(
    packBytes(encoder.encode(appId)),
    uint32(issueTs),
    uint32(expireSeconds),
    uint32(salt),
    uint16(1), // one service
    service,
  );

  // The signing key is derived in two steps — issue time, then salt — so a
  // leaked token says nothing about the certificate behind it.
  let signingKey = await hmacSha256(uint32(issueTs), encoder.encode(appCertificate));
  signingKey = await hmacSha256(uint32(salt), signingKey);
  const signature = await hmacSha256(signingKey, signingInfo);

  const body = await zlibCompress(concat(packBytes(signature), signingInfo));
  return VERSION + toBase64(body);
}

/**
 * The same folding as agoraUidFor() in the app's utils/agoraConfig.ts.
 *
 * Worked out here rather than taken from the request: the token is only valid
 * for the uid it names, so letting the client choose would let one user mint a
 * token under another's identity.
 */
export function agoraUidFor(firebaseUid) {
  let hash = 0;
  for (let i = 0; i < firebaseUid.length; i += 1) {
    hash = (hash << 5) - hash + firebaseUid.charCodeAt(i);
    hash |= 0;
  }
  const positive = Math.abs(hash) % 2147483646;
  return positive === 0 ? 1 : positive;
}

const bearer = (request) => {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

/**
 * Handles `mode: "agora-token"`.
 *
 * deps.verifyUser(env, idToken) → Firebase uid, throws when invalid
 * deps.readStream(env, streamId) → the liveStreams document, or null
 */
export async function issueAgoraToken(env, request, body, deps) {
  const appId = String(env.AGORA_APP_ID || "").trim();
  const appCertificate = String(env.AGORA_APP_CERTIFICATE || "").trim();
  if (!appId || !appCertificate) {
    return {
      status: 503,
      body: { error: "Live video tokens are not configured on the server." },
    };
  }

  const idToken = bearer(request);
  if (!idToken) {
    return { status: 401, body: { error: "Missing Firebase ID token." } };
  }

  let callerUid;
  try {
    callerUid = await deps.verifyUser(env, idToken);
  } catch {
    return { status: 401, body: { error: "Your session has expired. Sign in again." } };
  }

  const channelName = typeof body?.channelName === "string" ? body.channelName.trim() : "";
  // Firestore document ids, which is what channels are named after.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(channelName)) {
    return { status: 400, body: { error: "Invalid channel." } };
  }

  const stream = await deps.readStream(env, channelName);
  if (!stream) {
    return { status: 404, body: { error: "This stream does not exist." } };
  }
  if (stream.status !== "live") {
    return { status: 409, body: { error: "This stream has ended." } };
  }

  const isHost = stream.hostId === callerUid;
  // Asking for host rights on someone else's stream isn't an error worth
  // refusing outright — it is answered with what the caller is allowed.
  const publisher = body?.role === "host" && isHost;

  const uid = agoraUidFor(callerUid);
  const token = await buildRtcToken({
    appId,
    appCertificate,
    channelName,
    uid,
    publisher,
  });

  return {
    status: 200,
    body: {
      token,
      uid,
      role: publisher ? "host" : "audience",
      expiresInSeconds: TOKEN_TTL_SECONDS,
    },
  };
}

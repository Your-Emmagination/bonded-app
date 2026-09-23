// utils/liveStreams.ts
//
// Live streams in the Home feed.
//
// Everything here is Firestore: who is live, the running comments, the hearts,
// the viewer count and the moderator kill switch. None of it knows how the
// video itself is carried, which is the point — the `provider` and
// `playbackUrl` fields describe the pipe, and swapping Agora for Cloudflare
// (or the reverse) changes those two fields and nothing else in this file.
//
// That separation is deliberate: the social half is what makes a stream feel
// live, it costs nothing, and it works in Expo Go. The video half needs a
// native module and a vendor. Building them apart means the feature still
// demos if the vendor falls through.
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import { db } from "../Firebase_configure";
import { timestampMs } from "./supportTickets";

/**
 * "live" is the only state the feed shows. "ended" is a finished stream, kept
 * so a replay can be watched. "blocked" is a moderator ending someone else's
 * stream — separate from "ended" so the difference survives in the record.
 */
export type LiveStatus = "live" | "ended" | "blocked";

/** Which service is carrying the video. Null until a stream actually starts. */
export type LiveProvider = "agora" | "cloudflare";

export type LiveStream = {
  id: string;
  hostId: string;
  hostName: string;
  hostAvatar: string | null;
  hostRole: string;
  title: string;
  status: LiveStatus;

  /** The video pipe. Everything else in this file ignores these. */
  provider: LiveProvider | null;
  /** Agora channel name, or the Cloudflare live input id. */
  channelName: string | null;
  /** HLS URL for Cloudflare. Null for Agora, which viewers join by channel. */
  playbackUrl: string | null;
  /** Set once a recording of a finished stream exists. */
  replayUrl: string | null;
  /**
   * The feed post carrying the replay. Written only once that post is
   * approved, so an unreviewed video is never reachable from the stream.
   */
  replayPostId: string | null;

  /** When the live was created — before any video, while the camera connects. */
  startedAt: any;
  /**
   * When the host's camera actually joined the video channel, which is also
   * when the replay recording starts. The clock counts from here. Null while
   * connecting; a stream from an older app version, which never set it, uses
   * startedAt.
   */
  broadcastStartedAt: any;
  endedAt: any;
  /**
   * The host's last "still here", refreshed while their live screen is open.
   * Null for a moment after the host's own write; missing on streams started
   * before the signal existed.
   */
  hostSeenAt: any;
  /** Who ended it, when that was not the host. */
  endedBy: string | null;
  endedByName: string | null;

  viewerCount: number;
  peakViewers: number;
  commentCount: number;
  reactionCount: number;

  /**
   * What the host has switched off. Kept on the document, not read from the
   * video pipe, so somebody who joins late sees the right state at once
   * rather than a frozen frame until the next change.
   */
  micMuted: boolean;
  cameraOff: boolean;

  /** The comment the host has pinned above the chat, if any. */
  pinnedComment: PinnedLiveComment | null;
};

/**
 * A copy of the pinned comment, not a reference to it. Chat only keeps the
 * newest comments on screen, so a pin that pointed at an old one would vanish
 * as the conversation moved on — which is the opposite of what pinning is for.
 */
export type PinnedLiveComment = {
  id: string;
  authorName: string;
  text: string;
};

/** How many comments a viewer keeps on screen. Live chat is not a transcript. */
export const LIVE_COMMENT_WINDOW = 100;

/** A viewer is counted as present if they checked in within this long. */
export const VIEWER_STALE_MS = 45_000;

/** How often a watching client refreshes its presence doc. */
export const VIEWER_HEARTBEAT_MS = 20_000;

/** How often the host's screen says it is still there. */
export const HOST_HEARTBEAT_MS = 20_000;

/**
 * A live whose host has been silent this long is treated as over. Long enough
 * to ride out a couple of missed heartbeats on weak Wi-Fi, short enough that
 * a crashed app doesn't leave a dead card at the top of the feed for long.
 */
export const HOST_STALE_MS = 90_000;

export type LiveComment = {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  text: string;
  createdAt: any;
  /** Hidden by the host or a moderator; kept rather than deleted. */
  hidden: boolean;
  kind: "comment" | "join";
};

const toStream = (id: string, data: any): LiveStream => ({
  id,
  hostId: String(data?.hostId || ""),
  hostName: String(data?.hostName || "Unknown"),
  hostAvatar: data?.hostAvatar ?? null,
  hostRole: String(data?.hostRole || "student"),
  title: String(data?.title || ""),
  status: (data?.status || "ended") as LiveStatus,
  provider: (data?.provider ?? null) as LiveProvider | null,
  channelName: data?.channelName ?? null,
  playbackUrl: data?.playbackUrl ?? null,
  replayUrl: data?.replayUrl ?? null,
  replayPostId: typeof data?.replayPostId === "string" ? data.replayPostId : null,
  startedAt: data?.startedAt,
  broadcastStartedAt:
    data && "broadcastStartedAt" in data ? data.broadcastStartedAt ?? null : data?.startedAt ?? null,
  endedAt: data?.endedAt,
  // Undefined and null mean different things here; see isLiveStreamFresh.
  hostSeenAt: data?.hostSeenAt,
  endedBy: data?.endedBy ?? null,
  endedByName: data?.endedByName ?? null,
  viewerCount: Number(data?.viewerCount || 0),
  peakViewers: Number(data?.peakViewers || 0),
  commentCount: Number(data?.commentCount || 0),
  reactionCount: Number(data?.reactionCount || 0),
  micMuted: data?.micMuted === true,
  cameraOff: data?.cameraOff === true,
  pinnedComment:
    data?.pinnedComment && typeof data.pinnedComment.id === "string"
      ? {
          id: data.pinnedComment.id,
          authorName: String(data.pinnedComment.authorName || ""),
          text: String(data.pinnedComment.text || ""),
        }
      : null,
});

const toComment = (id: string, data: any): LiveComment => ({
  id,
  authorId: String(data?.authorId || ""),
  authorName: String(data?.authorName || "Unknown"),
  authorAvatar: data?.authorAvatar ?? null,
  text: String(data?.text || ""),
  createdAt: data?.createdAt,
  hidden: data?.hidden === true,
  kind: data?.kind === "join" ? "join" : "comment",
});

// ── Starting and ending ───────────────────────────────────────────────────

export type StartLiveInput = {
  hostId: string;
  hostName: string;
  hostAvatar?: string | null;
  hostRole?: string | null;
  title: string;
  provider?: LiveProvider | null;
  channelName?: string | null;
  playbackUrl?: string | null;
};

/**
 * Opens a stream and returns its id.
 *
 * The document is created before any video exists, so the feed card and the
 * comment room are ready the moment the camera connects. A stream that never
 * gets video is just a stream with no pictures — the rest still works.
 */
export async function startLiveStream(input: StartLiveInput): Promise<string> {
  const ref = await addDoc(collection(db, "liveStreams"), {
    hostId: input.hostId,
    hostName: input.hostName,
    hostAvatar: input.hostAvatar ?? null,
    hostRole: input.hostRole || "student",
    title: input.title.trim().slice(0, 120) || "Live",
    status: "live" as LiveStatus,
    provider: input.provider ?? null,
    channelName: input.channelName ?? null,
    playbackUrl: input.playbackUrl ?? null,
    replayUrl: null,
    startedAt: serverTimestamp(),
    // Set by the host's screen once the camera is really broadcasting.
    broadcastStartedAt: null,
    hostSeenAt: serverTimestamp(),
    endedAt: null,
    endedBy: null,
    endedByName: null,
    viewerCount: 0,
    peakViewers: 0,
    commentCount: 0,
    reactionCount: 0,
    micMuted: false,
    cameraOff: false,
    pinnedComment: null,
  });
  return ref.id;
}

/**
 * The host's camera has joined the video channel: the live has really begun.
 * Everyone's clock counts from this, matching the replay, which starts
 * recording at the same moment.
 */
export async function markBroadcastStarted(streamId: string): Promise<void> {
  await updateDoc(doc(db, "liveStreams", streamId), {
    broadcastStartedAt: serverTimestamp(),
  });
}

/** The host closing their own stream. */
export async function endLiveStream(streamId: string): Promise<void> {
  await updateDoc(doc(db, "liveStreams", streamId), {
    status: "ended" as LiveStatus,
    endedAt: serverTimestamp(),
    viewerCount: 0,
  });
}

/**
 * Keeps telling everyone the host is still on their live screen. Returns the
 * function that stops it.
 *
 * Needed because a host can vanish without ending anything — the app crashes,
 * is swiped away, or the phone dies — and the stream document would otherwise
 * say "live" forever. Rather than trusting the app to clean up after itself,
 * the feed trusts only a host it has heard from recently.
 */
export function startHostHeartbeat(streamId: string): () => void {
  const touch = () =>
    updateDoc(doc(db, "liveStreams", streamId), {
      hostSeenAt: serverTimestamp(),
    }).catch(() => undefined);

  touch();
  const timer = setInterval(touch, HOST_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/**
 * A moderator ending someone else's stream.
 *
 * The one control that matters most here. None of the app's text moderation
 * reaches live video — no keyword list reads a camera — so the only real
 * defence is a person watching and a button that works immediately. Viewers
 * are already subscribed to this document, so the status change reaches every
 * screen on the next snapshot without anything else being notified.
 */
export async function blockLiveStream(
  streamId: string,
  moderator: { id: string; name: string },
): Promise<void> {
  await updateDoc(doc(db, "liveStreams", streamId), {
    status: "blocked" as LiveStatus,
    endedAt: serverTimestamp(),
    endedBy: moderator.id,
    endedByName: moderator.name,
    viewerCount: 0,
  });
}

/** Attaches the video pipe once the vendor hands back its identifiers. */
export async function attachLiveVideo(
  streamId: string,
  video: {
    provider: LiveProvider;
    channelName?: string | null;
    playbackUrl?: string | null;
  },
): Promise<void> {
  await updateDoc(doc(db, "liveStreams", streamId), {
    provider: video.provider,
    channelName: video.channelName ?? null,
    playbackUrl: video.playbackUrl ?? null,
  });
}

/** The host switching their mic or camera; only the fields passed change. */
export async function setLiveMediaState(
  streamId: string,
  patch: { micMuted?: boolean; cameraOff?: boolean },
): Promise<void> {
  const update: Record<string, boolean> = {};
  if (typeof patch.micMuted === "boolean") update.micMuted = patch.micMuted;
  if (typeof patch.cameraOff === "boolean") update.cameraOff = patch.cameraOff;
  if (Object.keys(update).length === 0) return;
  await updateDoc(doc(db, "liveStreams", streamId), update);
}

export async function pinLiveComment(
  streamId: string,
  comment: Pick<LiveComment, "id" | "authorName" | "text">,
): Promise<void> {
  await updateDoc(doc(db, "liveStreams", streamId), {
    pinnedComment: {
      id: comment.id,
      authorName: comment.authorName,
      text: comment.text.slice(0, 200),
    },
  });
}

/** Also what hiding a pinned comment does, so a removed comment can't stay pinned. */
export async function unpinLiveComment(streamId: string): Promise<void> {
  await updateDoc(doc(db, "liveStreams", streamId), { pinnedComment: null });
}

/**
 * Links a finished stream to its replay: the video, and the feed post that
 * carries it. See utils/liveReplay.ts.
 */
export async function setLiveReplay(
  streamId: string,
  replay: { replayUrl: string; replayPostId: string },
): Promise<void> {
  await updateDoc(doc(db, "liveStreams", streamId), {
    replayUrl: replay.replayUrl,
    replayPostId: replay.replayPostId,
  });
}

// ── Reading ───────────────────────────────────────────────────────────────

/**
 * Whoever is live right now, newest first — the Home feed's source.
 *
 * Ordering happens in memory rather than in the query: a where + orderBy on
 * different fields needs a deployed composite index, and the number of
 * simultaneous streams on one campus is small enough that it never matters.
 */
export function subscribeToActiveStreams(
  onStreams: (streams: LiveStream[]) => void,
): () => void {
  return onSnapshot(
    query(collection(db, "liveStreams"), where("status", "==", "live")),
    (snapshot) => {
      const rows = snapshot.docs.map((item) => toStream(item.id, item.data()));
      rows.sort((a, b) => timestampMs(b.startedAt) - timestampMs(a.startedAt));
      onStreams(rows);
    },
    (error) => console.error("Live streams listener failed:", error),
  );
}

/**
 * Whether a live's host has been heard from recently enough to show it.
 *
 * A null `hostSeenAt` is the host's own device, a moment after writing it and
 * before the server has stamped it, so it counts as fresh. A missing one is a
 * stream from before the signal existed, which nothing will ever refresh.
 */
export function isLiveStreamFresh(stream: LiveStream, nowMs: number): boolean {
  if (stream.status !== "live") return false;
  if (stream.hostSeenAt === null) return true;
  const seen = timestampMs(stream.hostSeenAt);
  return seen > 0 && nowMs - seen < HOST_STALE_MS;
}

/**
 * The lives this person has open, fresh or not. Used before going live, so
 * nobody ends up broadcasting twice.
 *
 * Two equality filters need no composite index.
 */
export async function findMyLiveStreams(hostId: string): Promise<LiveStream[]> {
  const snapshot = await getDocs(
    query(
      collection(db, "liveStreams"),
      where("hostId", "==", hostId),
      where("status", "==", "live"),
    ),
  );
  return snapshot.docs
    .map((item) => toStream(item.id, item.data()))
    .sort((a, b) => timestampMs(b.startedAt) - timestampMs(a.startedAt));
}

/** One stream. Also how viewers learn it was ended or blocked. */
export function subscribeToStream(
  streamId: string,
  onStream: (stream: LiveStream | null) => void,
): () => void {
  return onSnapshot(
    doc(db, "liveStreams", streamId),
    (snapshot) =>
      onStream(snapshot.exists() ? toStream(snapshot.id, snapshot.data()) : null),
    (error) => console.error("Live stream listener failed:", error),
  );
}

export async function getLiveStream(streamId: string): Promise<LiveStream | null> {
  const snapshot = await getDoc(doc(db, "liveStreams", streamId));
  return snapshot.exists() ? toStream(snapshot.id, snapshot.data()) : null;
}

// ── Comments ──────────────────────────────────────────────────────────────

/**
 * The running comments, oldest first so the list reads downward.
 *
 * Firestore can only take the *newest* N with a descending order, so the
 * window is fetched descending and reversed here.
 */
export function subscribeToLiveComments(
  streamId: string,
  onComments: (comments: LiveComment[]) => void,
): () => void {
  return onSnapshot(
    query(
      collection(db, "liveStreams", streamId, "comments"),
      orderBy("createdAt", "desc"),
      fsLimit(LIVE_COMMENT_WINDOW),
    ),
    (snapshot) => {
      const rows = snapshot.docs.map((item) => toComment(item.id, item.data()));
      rows.reverse();
      onComments(rows.filter((row) => !row.hidden));
    },
    (error) => console.error("Live comments listener failed:", error),
  );
}

export async function postLiveComment(input: {
  streamId: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  text: string;
}): Promise<void> {
  const text = input.text.trim().slice(0, 200);
  if (!text) return;

  await addDoc(collection(db, "liveStreams", input.streamId, "comments"), {
    authorId: input.authorId,
    authorName: input.authorName,
    authorAvatar: input.authorAvatar ?? null,
    text,
    kind: "comment",
    createdAt: serverTimestamp(),
    hidden: false,
  });
  await updateDoc(doc(db, "liveStreams", input.streamId), {
    commentCount: increment(1),
  });
}

/**
 * Takes a comment off screen.
 *
 * Hidden rather than deleted, so a moderator reviewing a stream afterwards can
 * still see what was said and by whom.
 */
export async function hideLiveComment(
  streamId: string,
  commentId: string,
): Promise<void> {
  await updateDoc(doc(db, "liveStreams", streamId, "comments", commentId), {
    hidden: true,
  });
}

// ── Reactions ─────────────────────────────────────────────────────────────

/**
 * Hearts, as a counter rather than a document each.
 *
 * People tap these continuously, and a document per tap would be thousands of
 * writes for something nobody ever reads back. Clients watch the counter and
 * float one heart per increment they see, which looks the same and costs a
 * fraction as much.
 */
export async function sendLiveReaction(
  streamId: string,
  count = 1,
): Promise<void> {
  if (count < 1) return;
  await updateDoc(doc(db, "liveStreams", streamId), {
    reactionCount: increment(count),
  });
}

// ── Presence ──────────────────────────────────────────────────────────────

/**
 * Marks this viewer present, and keeps the mark fresh.
 *
 * Returns a function that removes the presence document. A client that dies
 * without calling it leaves a stale document instead of an inflated count —
 * `countActiveViewers` ignores anything that has stopped checking in.
 */
export function joinAsViewer(
  streamId: string,
  viewer: { id: string; name: string; avatar?: string | null },
): () => void {
  const ref = doc(db, "liveStreams", streamId, "viewers", viewer.id);
  const activityRef = doc(db, "liveStreams", streamId, "comments", `joined_${viewer.id}`);
  // One activity row per viewer per live. Reconnects do not announce twice.
  void runTransaction(db, async (transaction) => {
    const existing = await transaction.get(activityRef);
    if (existing.exists()) return;
    transaction.set(activityRef, {
      authorId: viewer.id,
      authorName: viewer.name,
      authorAvatar: viewer.avatar ?? null,
      text: "joined the live",
      kind: "join",
      createdAt: serverTimestamp(),
      hidden: false,
    });
  }).catch(() => undefined);
  const touch = () =>
    setDoc(
      ref,
      {
        userId: viewer.id,
        name: viewer.name,
        joinedAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      },
      { merge: true },
    ).catch(() => undefined);

  touch();
  const timer = setInterval(touch, VIEWER_HEARTBEAT_MS);

  return () => {
    clearInterval(timer);
    deleteDoc(ref).catch(() => undefined);
  };
}

/**
 * Watches who is present and reports the live count.
 *
 * The host is never part of it: like TikTok or Facebook, a live starts at 0
 * and goes to 1 when somebody else is watching. The host's screen doesn't
 * mark itself present, and an old mark from a build that did is ignored.
 *
 * Only the host's screen should call this. Every viewer subscribing to every
 * other viewer is a read for each pair, which grows with the square of the
 * audience; instead the host publishes the number onto the stream document,
 * which viewers are already watching and get for free.
 */
export function subscribeToViewerCount(
  streamId: string,
  hostId: string,
  onCount: (count: number) => void,
): () => void {
  return onSnapshot(
    collection(db, "liveStreams", streamId, "viewers"),
    (snapshot) => {
      const cutoff = Date.now() - VIEWER_STALE_MS;
      const active = snapshot.docs.filter((item) => {
        if (item.id === hostId) return false;
        const seen = timestampMs(item.data()?.lastSeenAt);
        // A document written moments ago has no server timestamp yet; treat
        // that as present rather than blinking the count down.
        return seen === 0 || seen >= cutoff;
      }).length;
      onCount(active);
    },
    (error) => console.error("Viewer presence listener failed:", error),
  );
}

/** Publishes the count onto the stream, and raises the peak when passed. */
export async function publishViewerCount(
  streamId: string,
  count: number,
  previousPeak: number,
): Promise<void> {
  const patch: Record<string, unknown> = { viewerCount: count };
  if (count > previousPeak) patch.peakViewers = count;
  await updateDoc(doc(db, "liveStreams", streamId), patch).catch(() => undefined);
}

/** Whether this person may end somebody else's stream. */
export function canModerateLive(role: string | null | undefined): boolean {
  const normalized = String(role || "").toLowerCase();
  return normalized === "admin" || normalized === "moderator" || normalized === "teacher";
}

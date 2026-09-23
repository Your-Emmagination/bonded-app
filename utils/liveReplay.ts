// utils/liveReplay.ts
//
// Turning a finished live into a replay post.
//
// The host's phone records its own broadcast while it is live (see
// useAgoraLive). When the host ends it, the file is uploaded to Cloudinary and
// posted to the Home feed as an ordinary video post — liked, commented on and
// moderated like any other. A student's replay waits for the Worker exactly
// as their other video posts do.
//
// The work runs here rather than inside the live screen so it carries on
// after the host leaves that screen. It lasts as long as the app does: a
// replay the app was closed in the middle of saving is lost, which the host
// is told before going live.
import * as FileSystem from "expo-file-system/legacy";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { useCallback, useSyncExternalStore } from "react";

import { db } from "../Firebase_configure";
import { requestServerPostModeration, requestVideoTranscription } from "./aiWorker";
import { uploadVideoWithProgress } from "./cloudinaryUpload";
import { setLiveReplay } from "./liveStreams";
import { DEFAULT_POST_FLAIR } from "./postFlairs";
import { buildPostSearchTerms } from "./postSearchTerms";
import { showAppToast } from "./toastEvents";

/**
 * Only this much of a live is kept. At the bitrate the host broadcasts at
 * (see useAgoraLive) ten minutes comes to roughly 70 MB, safely under the
 * 100 MB Cloudinary's free plan accepts in one upload.
 */
export const REPLAY_MAX_DURATION_MS = 10 * 60 * 1000;
const REPLAY_MAX_BYTES = 95 * 1024 * 1024;
/** Anything shorter is a false start, not worth a post. */
const REPLAY_MIN_DURATION_MS = 3_000;
const REPLAY_MIN_BYTES = 50 * 1024;

const REPLAY_FILE_PREFIX = "live-replay-";
/** A recording this old was never going to be uploaded. */
const STALE_REPLAY_FILE_MS = 6 * 60 * 60 * 1000;
/** Redraw the progress bar in steps, not on every chunk sent. */
const PROGRESS_STEP = 0.02;

export type LiveRecording = {
  /** file:// URI of the finished MP4. */
  fileUri: string;
  durationMs: number;
};

export type ReplayPhase =
  | "saving"
  | "uploading"
  | "posting"
  | "posted"
  | "review"
  | "skipped"
  | "failed";

export type ReplayJob = {
  streamId: string;
  phase: ReplayPhase;
  /** 0 to 1 while uploading. */
  progress: number;
  postId: string | null;
  message: string | null;
};

export type LiveReplayInput = {
  streamId: string;
  title: string;
  recording: LiveRecording;
  author: { uid: string; name: string; role: string };
  stats: { peakViewers: number; commentCount: number; reactionCount: number };
};

// ── Where a job stands ──────────────────────────────────────────────────
// Kept outside React so it survives the live screen closing. Each stream has
// its own listeners, which doubles as "is anybody looking at this job": when
// nobody is, progress is told through toasts instead.

const jobs = new Map<string, ReplayJob>();
const inputs = new Map<string, LiveReplayInput>();
/** Videos already uploaded, so a retry after a later failure doesn't upload twice. */
const uploaded = new Map<string, UploadedReplay>();

/** The uploaded video, and its length as Cloudinary measured it when known. */
type UploadedReplay = { url: string; durationMs: number | null };
const running = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

const setJob = (streamId: string, patch: Partial<Omit<ReplayJob, "streamId">>) => {
  const current: ReplayJob = jobs.get(streamId) ?? {
    streamId,
    phase: "saving",
    progress: 0,
    postId: null,
    message: null,
  };
  jobs.set(streamId, { ...current, ...patch });
  listeners.get(streamId)?.forEach((listener) => listener());
};

const isWatched = (streamId: string) => (listeners.get(streamId)?.size ?? 0) > 0;

const subscribeToJob = (streamId: string, listener: () => void) => {
  const set = listeners.get(streamId) ?? new Set();
  set.add(listener);
  listeners.set(streamId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(streamId);
  };
};

/** The replay being saved for this stream on this phone, if any. */
export function useReplayJob(streamId: string | null): ReplayJob | null {
  const subscribe = useCallback(
    (listener: () => void) => (streamId ? subscribeToJob(streamId, listener) : () => undefined),
    [streamId],
  );
  return useSyncExternalStore(subscribe, () => (streamId ? jobs.get(streamId) ?? null : null));
}

/** Where a replay post opens: the single-post screen. */
export const replayPostRoute = (postId: string) => ({
  pathname: "/(main)/NotificationTargetScreen" as const,
  params: { entityType: "post", entityId: postId, origin: "live-replay" },
});

const replayPostHref = (postId: string) =>
  `/(main)/NotificationTargetScreen?entityType=post&entityId=${encodeURIComponent(postId)}&origin=live-replay`;

// ── Files ───────────────────────────────────────────────────────────────

/** A fresh file to record a live into, as a file:// URI. */
export function newReplayFileUri(streamId: string): string | null {
  const directory = FileSystem.cacheDirectory;
  if (!directory) return null;
  return `${directory}${REPLAY_FILE_PREFIX}${streamId}-${Date.now()}.mp4`;
}

/** Agora writes to a plain path, not a URI. */
export const fileUriToPath = (uri: string) => decodeURI(uri.replace(/^file:\/\//, ""));

export function discardRecording(fileUri: string): void {
  FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => undefined);
}

/** Recordings left behind by an app that was closed before it could upload them. */
export async function sweepStaleReplayFiles(): Promise<void> {
  const directory = FileSystem.cacheDirectory;
  if (!directory) return;
  const names = await FileSystem.readDirectoryAsync(directory).catch(() => [] as string[]);
  const inUse = new Set([...inputs.values()].map((input) => input.recording.fileUri));
  const now = Date.now();
  await Promise.all(
    names
      .filter((name) => name.startsWith(REPLAY_FILE_PREFIX))
      .map(async (name) => {
        const uri = `${directory}${name}`;
        if (inUse.has(uri)) return;
        const info = await FileSystem.getInfoAsync(uri).catch(() => null);
        if (info?.exists && now - info.modificationTime * 1000 > STALE_REPLAY_FILE_MS) {
          await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
        }
      }),
  );
}

/**
 * The recorder finishes writing just after it is stopped. Waits until the
 * file's size stops changing, and returns it.
 */
async function waitForFinishedFile(uri: string): Promise<number> {
  let lastSize = -1;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    const size = info?.exists ? info.size : 0;
    if (size > 0 && size === lastSize) return size;
    lastSize = size;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return Math.max(lastSize, 0);
}

// ── The post ────────────────────────────────────────────────────────────

/**
 * The replay as a normal video post, in the same shape Create Post writes, so
 * the feed, search, moderation and captions all treat it like any other. It
 * starts pending; the Worker decides, as for every post.
 */
async function createReplayPost(input: LiveReplayInput, video: UploadedReplay): Promise<string> {
  const content = `Live replay: ${input.title}`;
  const ref = await addDoc(collection(db, "posts"), {
    content,
    searchTerms: buildPostSearchTerms(content, ["live", "replay"]),
    flair: DEFAULT_POST_FLAIR,
    files: [{ url: video.url, mimeType: "video/mp4", name: "live-replay.mp4" }],
    captionStatus: "pending",
    userId: input.author.uid,
    realUserId: input.author.uid,
    username: input.author.name,
    authorName: input.author.name,
    ...(input.author.role === "student" ? { userRole: "student" } : {}),
    isAnonymous: false,
    taggedUsers: [],
    createdAt: serverTimestamp(),
    likeCount: 0,
    commentCount: 0,
    likedBy: [],
    bookmarkedBy: [],
    serverId: null,
    channelId: null,
    // What PostCard shows in the "Live replay" badge.
    liveReplay: {
      streamId: input.streamId,
      // The video's real length; the recorder's own count is only a backup.
      durationMs: Math.round(video.durationMs ?? input.recording.durationMs),
      peakViewers: input.stats.peakViewers,
      commentCount: input.stats.commentCount,
      reactionCount: input.stats.reactionCount,
    },
    moderationStatus: "pending",
    moderationReasons: [],
    moderatedAtMs: null,
  });
  return ref.id;
}

// ── The job ─────────────────────────────────────────────────────────────

const finish = (input: LiveReplayInput, patch: Partial<Omit<ReplayJob, "streamId">>) => {
  setJob(input.streamId, patch);
  discardRecording(input.recording.fileUri);
  inputs.delete(input.streamId);
  uploaded.delete(input.streamId);
};

async function runReplayJob(input: LiveReplayInput): Promise<void> {
  const { streamId, recording } = input;
  if (running.has(streamId)) return;
  running.add(streamId);
  setJob(streamId, { phase: "saving", progress: 0, message: null });

  try {
    let video = uploaded.get(streamId);
    if (!video) {
      const size = await waitForFinishedFile(recording.fileUri);
      if (size < REPLAY_MIN_BYTES || recording.durationMs < REPLAY_MIN_DURATION_MS) {
        finish(input, {
          phase: "skipped",
          message: "The live was too short to save as a replay.",
        });
        return;
      }
      if (size > REPLAY_MAX_BYTES) {
        finish(input, {
          phase: "skipped",
          message: "The recording was too large to upload as a replay.",
        });
        if (!isWatched(streamId)) {
          showAppToast({ message: "Your live was too large to save as a replay." });
        }
        return;
      }

      if (!isWatched(streamId)) {
        showAppToast({ message: "Saving your live replay… keep BondED open." });
      }
      setJob(streamId, { phase: "uploading", progress: 0 });
      let reported = 0;
      video = await uploadVideoWithProgress(recording.fileUri, (fraction) => {
        const next = Math.min(1, Math.max(0, fraction));
        if (next - reported >= PROGRESS_STEP || next === 1) {
          reported = next;
          setJob(streamId, { progress: next });
        }
      });
      uploaded.set(streamId, video);
    }

    setJob(streamId, { phase: "posting", progress: 1 });
    const postId = await createReplayPost(input, video);

    let approved = false;
    try {
      approved = (await requestServerPostModeration(postId)).status === "approved";
    } catch (error) {
      // The post stays pending, and a moderator reviews it like any other.
      console.warn("[LiveReplay] Moderation unavailable; replay stays pending:", error);
    }

    if (approved) {
      // Linked from the stream only now, so an unreviewed video can never be
      // reached through the ended live.
      await setLiveReplay(streamId, { replayUrl: video.url, replayPostId: postId }).catch(
        (error) => console.warn("[LiveReplay] Could not link the replay to the live:", error),
      );
      void requestVideoTranscription(postId);
    }

    finish(input, { phase: approved ? "posted" : "review", postId, message: null });
    if (!isWatched(streamId)) {
      showAppToast(
        approved
          ? {
              message: "Your live replay is on the feed.",
              actionLabel: "View",
              actionHref: replayPostHref(postId),
            }
          : { message: "Your live replay was sent for review." },
      );
    }
  } catch (error) {
    console.warn("[LiveReplay] Saving the replay failed:", error);
    setJob(streamId, {
      phase: "failed",
      message: "Couldn't save the replay. Check your connection and try again.",
    });
    if (!isWatched(streamId)) {
      showAppToast({
        message: "Couldn't save your live replay.",
        actionLabel: "Retry",
        onAction: () => retryLiveReplay(streamId),
      });
    }
  } finally {
    running.delete(streamId);
  }
}

/** Uploads a finished live's recording and posts it as a replay. */
export function saveLiveReplay(input: LiveReplayInput): void {
  inputs.set(input.streamId, input);
  void runReplayJob(input);
}

/** Tries a failed replay again from where it stopped. */
export function retryLiveReplay(streamId: string): void {
  const input = inputs.get(streamId);
  if (input) void runReplayJob(input);
}

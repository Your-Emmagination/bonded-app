// utils/composerUploads.ts
//
// The photos and files attached to a comment, reply or server message.
//
// The composers used to upload every attachment, one after another, before
// handing the message to the screen, so nothing appeared until the last
// upload had finished. Now the composer hands the message over at once with
// the attachments as they sit on the phone. The screen shows it straight away
// and calls upload() before saving it — the same order DMs already use.

import {
  readLastUploadSize,
  uploadPostFile,
  uploadPostGif,
  uploadPostImage,
} from "@/utils/cloudinaryUpload";

export type ComposerFile = {
  url: string;
  mimeType: string;
  name?: string;
  /** Pixel size, when the upload reported one, so a bubble is the right shape on first paint. */
  width?: number;
  height?: number;
};

export type ComposerAttachments = {
  /** The attachments as they sit on the phone, for the copy shown while sending. */
  local: ComposerFile[];
  /**
   * Uploads them, a few at a time, and resolves to what the saved message
   * carries, in the order they were attached. Calling it again returns the
   * same uploads rather than starting new ones.
   */
  upload: () => Promise<ComposerFile[]>;
};

type PickedFile = { uri: string; mimeType: string; name: string };

/**
 * How many attachments upload at the same time. A phone's connection gains
 * little past this, and on weak campus Wi-Fi a wall of parallel uploads is
 * more likely to time out than to finish sooner.
 */
const UPLOADS_AT_ONCE = 3;

/** Uploaded URL → the file on this phone it was uploaded from. */
const localCopies = new Map<string, string>();

/**
 * The file on this phone an uploaded attachment came from, when this phone
 * sent it during this session. Shown while the uploaded copy downloads, so a
 * photo you just sent doesn't blink out when the saved message replaces the
 * copy shown while it was sending.
 */
export const localCopyOf = (url: string | null | undefined): string | undefined =>
  url ? localCopies.get(url) : undefined;

/** Runs `work` over `items`, at most `limit` at a time, keeping their order. */
async function mapInOrder<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Packs a composer's attachments for sending: the picked files, then the
 * chosen GIF. Nothing is uploaded until the screen calls upload().
 */
export function prepareComposerAttachments(
  files: PickedFile[],
  gifUrl: string | null,
): ComposerAttachments {
  const jobs = [
    ...files.map((file) => ({
      local: { url: file.uri, mimeType: file.mimeType, name: file.name },
      send: file.mimeType.startsWith("image/") ? uploadPostImage : uploadPostFile,
    })),
    ...(gifUrl
      ? [{ local: { url: gifUrl, mimeType: "image/gif", name: "animated.gif" }, send: uploadPostGif }]
      : []),
  ];

  let uploads: Promise<ComposerFile[]> | null = null;
  return {
    local: jobs.map((job) => job.local),
    upload: () => {
      if (!uploads) {
        uploads = mapInOrder(jobs, UPLOADS_AT_ONCE, async ({ local, send }) => {
          const url = await send(local.url);
          // Read straight after the upload resolves; it describes only the
          // most recent one, and checks the URL to be sure.
          const size = readLastUploadSize(url);
          localCopies.set(url, local.url);
          return {
            ...local,
            url,
            ...(size?.width && size?.height ? { width: size.width, height: size.height } : {}),
          };
        });
      }
      return uploads;
    },
  };
}

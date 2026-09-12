// Short, single-line summary of a message, used by the "replying to …" bar and
// by the quoted snapshot stored on a reply.
//
// Wording follows Messenger's convention: a message with no words is described
// by what it actually is ("Photo", "GIF", "Video", "Audio") rather than by a
// raw camera filename like IMG_20260912_133500.jpg. Real documents keep their
// file name, since that is the useful part for a file.
//
// Shared by the server channel and direct chat so a reply reads the same in
// both. The preview is saved onto the reply when it is sent, so changing this
// only affects replies sent from now on.

type ReplyPreviewFile = {
  url?: string | null;
  mimeType?: string | null;
  name?: string | null;
};

export type ReplyPreviewSource = {
  text?: string | null;
  files?: ReplyPreviewFile[] | null;
  link?: { url?: string | null; title?: string | null } | null;
};

export const replyPreviewText = (message: ReplyPreviewSource): string => {
  const text = message.text?.trim();
  if (text) return text;

  const files = message.files || [];
  const mimeTypes = files.map((file) => (file?.mimeType || "").toLowerCase());

  // GIFs are checked before images: a GIF is an image/* too, and "GIF" is the
  // more precise word.
  if (mimeTypes.some((type) => type.includes("gif"))) return "GIF";
  if (mimeTypes.some((type) => type.startsWith("image/"))) return "Photo";
  if (mimeTypes.some((type) => type.startsWith("video/"))) return "Video";
  if (mimeTypes.some((type) => type.startsWith("audio/"))) return "Audio";

  const namedFile = files.find((file) => file?.name);
  if (namedFile?.name) return namedFile.name;
  if (files.length > 0) return "Attachment";

  if (message.link) return message.link.title || message.link.url || "Link";
  return "Message";
};

export type ReplyPreviewMedia = { url: string; type: "image" | "video" };

/**
 * The picture to show inside a quoted reply, like Messenger shows a small
 * thumbnail of the photo you replied to. Returns nothing for text, documents
 * and audio, which are described by words instead (see replyPreviewText).
 *
 * The result is stored on the reply when it is sent, so replies sent before
 * this existed simply have no thumbnail and keep showing their words.
 */
export const replyPreviewMedia = (
  message: ReplyPreviewSource,
): ReplyPreviewMedia | undefined => {
  const files = message.files || [];

  const image = files.find(
    (file) => file?.url && (file.mimeType || "").toLowerCase().startsWith("image/"),
  );
  if (image?.url) return { url: image.url, type: "image" };

  const video = files.find(
    (file) => file?.url && (file.mimeType || "").toLowerCase().startsWith("video/"),
  );
  if (video?.url) return { url: video.url, type: "video" };

  return undefined;
};

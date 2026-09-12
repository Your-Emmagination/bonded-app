export const MESSAGE_MAX_LENGTH = 2000;

export type TextSelection = { start: number; end: number };

/** Native TextInput selection offsets and maxLength use UTF-16 code units. */
export function insertEmojiInDraft(text: string, emoji: string, selection: TextSelection) {
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  const nextText = text.slice(0, start) + emoji + text.slice(end);
  if (nextText.length > MESSAGE_MAX_LENGTH) return null;
  const cursor = start + emoji.length;
  return { text: nextText, selection: { start: cursor, end: cursor } };
}

export type DraftAttachment = {
  uri: string;
  name: string;
  mimeType: string;
  source: "camera" | "gallery" | "file" | "gif";
  uploaded?: { url: string; name: string; mimeType: string };
};

/** Keep a successful upload on the draft so a failed message send can retry
 * without uploading the same attachment again. */
export async function prepareDraftAttachment(
  attachment: DraftAttachment,
  upload: (options: { uri: string; folder: "post_images" | "post_files"; resourceType: "image" | "raw" }) => Promise<string>,
) {
  if (attachment.uploaded) return attachment.uploaded;
  const image = attachment.mimeType.startsWith("image/");
  const url = await upload({ uri: attachment.uri, folder: image ? "post_images" : "post_files", resourceType: image ? "image" : "raw" });
  if (!url) throw new Error("The attachment could not be uploaded.");
  return { url, name: attachment.name, mimeType: attachment.mimeType };
}

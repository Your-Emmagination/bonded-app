import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

const ATTACHMENT_UNAVAILABLE = "ATTACHMENT_UNAVAILABLE";
const attachmentUnavailable = () => Object.assign(
  new Error("The selected attachment cannot be read. Remove it and select it again."),
  { code: ATTACHMENT_UNAVAILABLE },
);

export function isAttachmentUnavailableError(error: unknown): boolean {
  const details = error as { code?: string; message?: string } | null;
  return details?.code === ATTACHMENT_UNAVAILABLE ||
    /isn't readable|not readable|cannot be read|no such file|does not exist/i.test(details?.message || "");
}

/** Fail before starting a network upload if a cached attachment is gone or inaccessible. */
export function assertReadableUpload(uri: string): void {
  if (Platform.OS === "web" || !uri.startsWith("file://")) return;
  try {
    if (new File(uri).exists) return;
  } catch {
    // Expo Go can reject paths outside this experience's scoped cache.
  }
  throw attachmentUnavailable();
}

let selectionSequence = 0;

/**
 * Android's DocumentPicker cache can be outside Expo Go's scoped filesystem.
 * Read the user-granted content URI immediately and make our own scoped copy.
 * Keep the copy for previews and retries; the OS can reclaim it as cache later.
 */
export async function pickUploadDocuments(
  options: Omit<DocumentPicker.DocumentPickerOptions, "copyToCacheDirectory">,
): Promise<DocumentPicker.DocumentPickerResult> {
  const result = await DocumentPicker.getDocumentAsync({
    ...options,
    copyToCacheDirectory: Platform.OS !== "android",
  });
  if (result.canceled || Platform.OS !== "android") return result;

  const copies: File[] = [];
  try {
    const assets: DocumentPicker.DocumentPickerAsset[] = [];
    for (const asset of result.assets) {
      // Preserve the extension for MIME detection, without treating names as paths.
      const safeName = (asset.name || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);
      const copy = new File(Paths.cache, `upload_${Date.now()}_${++selectionSequence}_${safeName}`);
      copies.push(copy);
      await new File(asset.uri).copy(copy);
      assertReadableUpload(copy.uri);
      assets.push({ ...asset, uri: copy.uri });
    }
    return { ...result, assets };
  } catch {
    // A failed selection must not leave partially copied attachments behind.
    for (const copy of copies) {
      try {
        if (copy.exists) copy.delete();
      } catch {
        // Best effort; only these newly created cache files are eligible.
      }
    }
    throw attachmentUnavailable();
  }
}

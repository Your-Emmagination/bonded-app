import AsyncStorage from "@react-native-async-storage/async-storage";
import { File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import type { DraftAttachment } from "./messageComposer";

const PICKER_INTENT_KEY = "bonded:direct-photo-picker-intent";
const RECOVERED_PHOTO_KEY = "bonded:direct-photo-picker-recovered";

export type DirectPhotoIntent = {
  userId: string;
  conversationId: string;
  recipientId?: string;
  recipientName?: string;
  recipientAvatar?: string;
  recipientRole?: string;
  recipientStudentID?: string;
  source: "camera" | "gallery";
};

type RecoveredDirectPhoto = {
  intent: DirectPhotoIntent;
  attachment: DraftAttachment | null;
  error?: string;
};

let photoSequence = 0;

/** ImagePicker's URI is temporary. Keep a scoped copy for preview, upload and retry. */
export async function stageDirectPhoto(
  asset: ImagePicker.ImagePickerAsset,
  source: DirectPhotoIntent["source"],
): Promise<DraftAttachment> {
  if (!asset.uri) throw new Error("The selected photo is unavailable. Choose it again.");
  const extension = asset.fileName?.match(/\.(jpe?g|png|webp|heic|heif)$/i)?.[1]?.toLowerCase()
    || asset.uri.split("?")[0].match(/\.(jpe?g|png|webp|heic|heif)$/i)?.[1]?.toLowerCase()
    || "jpg";
  const mimeType = asset.mimeType || ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" } as Record<string, string>)[extension];
  const name = asset.fileName || `${source}_${Date.now()}.${extension}`;
  let uri = asset.uri;
  if (Platform.OS !== "web") {
    try {
      const copy = new File(Paths.cache, `direct_photo_${Date.now()}_${++photoSequence}.${extension}`);
      await new File(asset.uri).copy(copy);
      if (!copy.exists) throw new Error("Photo copy was not created.");
      uri = copy.uri;
    } catch (error) {
      console.warn("[directPhotoAttachment] Could not keep selected photo:", error);
      throw new Error("The selected photo could not be read. Choose it again.");
    }
  }
  return {
    uri,
    name,
    mimeType,
    source,
    ...(typeof asset.fileSize === "number" ? { size: asset.fileSize } : {}),
  };
}

export async function rememberDirectPhotoIntent(intent: DirectPhotoIntent): Promise<void> {
  if (Platform.OS === "android") {
    await AsyncStorage.setItem(PICKER_INTENT_KEY, JSON.stringify(intent));
  }
}

export async function forgetDirectPhotoIntent(): Promise<void> {
  if (Platform.OS === "android") await AsyncStorage.removeItem(PICKER_INTENT_KEY);
}

/** Android can destroy MainActivity while the camera/gallery is open. Recover its result on restart. */
export async function recoverPendingDirectPhoto(userId: string): Promise<RecoveredDirectPhoto | null> {
  if (Platform.OS !== "android") return null;

  const saved = await AsyncStorage.getItem(RECOVERED_PHOTO_KEY);
  if (saved) {
    try {
      const recovered = JSON.parse(saved) as RecoveredDirectPhoto;
      if (recovered.intent.userId === userId && recovered.intent.conversationId) return recovered;
    } catch {
      // A malformed old value must not prevent normal navigation.
    }
    await AsyncStorage.removeItem(RECOVERED_PHOTO_KEY);
  }

  const pendingIntent = await AsyncStorage.getItem(PICKER_INTENT_KEY);
  if (!pendingIntent) return null;
  let intent: DirectPhotoIntent;
  try {
    intent = JSON.parse(pendingIntent) as DirectPhotoIntent;
    if (!intent.conversationId || !intent.userId || !["camera", "gallery"].includes(intent.source)) {
      throw new Error("Invalid photo destination.");
    }
  } catch {
    await AsyncStorage.removeItem(PICKER_INTENT_KEY);
    return null;
  }
  if (intent.userId !== userId) {
    await AsyncStorage.removeItem(PICKER_INTENT_KEY);
    return null;
  }

  let recovered: RecoveredDirectPhoto = { intent, attachment: null };
  try {
    const result = await ImagePicker.getPendingResultAsync();
    if (result && "code" in result) {
      recovered = { ...recovered, error: "The photo could not be opened. Please try again." };
    } else if (result && !result.canceled && result.assets[0]) {
      recovered = { ...recovered, attachment: await stageDirectPhoto(result.assets[0], intent.source) };
    }
  } catch (error) {
    recovered = {
      ...recovered,
      error: error instanceof Error ? error.message : "The photo could not be opened. Please try again.",
    };
  }
  await AsyncStorage.setItem(RECOVERED_PHOTO_KEY, JSON.stringify(recovered));
  await AsyncStorage.removeItem(PICKER_INTENT_KEY);
  return recovered;
}

export async function takeRecoveredDirectPhoto(
  userId: string,
  conversationId: string,
): Promise<RecoveredDirectPhoto | null> {
  if (Platform.OS !== "android") return null;
  const saved = await AsyncStorage.getItem(RECOVERED_PHOTO_KEY);
  if (!saved) return null;
  let recovered: RecoveredDirectPhoto;
  try {
    recovered = JSON.parse(saved) as RecoveredDirectPhoto;
  } catch {
    await AsyncStorage.removeItem(RECOVERED_PHOTO_KEY);
    return null;
  }
  if (recovered.intent.userId !== userId) {
    await AsyncStorage.removeItem(RECOVERED_PHOTO_KEY);
    return null;
  }
  if (recovered.intent.conversationId !== conversationId) return null;
  await AsyncStorage.removeItem(RECOVERED_PHOTO_KEY);
  return recovered;
}

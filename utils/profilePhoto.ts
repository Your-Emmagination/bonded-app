// utils/profilePhoto.ts
//
// Changing your profile photo: pick one (camera or gallery, cropped square),
// then upload it and save it everywhere the app reads it from. Shared by the
// camera button on Profile and by Edit Profile.
import type { User } from "firebase/auth";
import { updateProfile } from "firebase/auth";
import { doc, updateDoc } from "firebase/firestore";
import * as ImagePicker from "expo-image-picker";
import { db } from "../Firebase_configure";
import { uploadProfileImage } from "./cloudinaryUpload";
import { saveCachedMyProfile } from "./offlineStorage";
import { updateUserDataCache } from "./rbac";

export type PickedPhoto =
  | { status: "picked"; uri: string }
  | { status: "cancelled" }
  | { status: "denied"; source: "camera" | "gallery" };

/** Takes or chooses a photo, cropped square. Throws only if the picker itself fails. */
export async function pickProfilePhoto(useCamera: boolean): Promise<PickedPhoto> {
  const permission = useCamera
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (permission.status !== "granted") {
    return { status: "denied", source: useCamera ? "camera" : "gallery" };
  }
  const result = await (useCamera ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync)({
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.8,
  });
  if (result.canceled || !result.assets?.[0]?.uri) return { status: "cancelled" };
  return { status: "picked", uri: result.assets[0].uri };
}

/**
 * Uploads the photo and saves it on the profile (and the second profile
 * document some accounts keep under the auth uid), the sign-in account, and
 * the cached copies. Returns the uploaded URL. Throws if uploading or saving
 * the profile fails.
 */
export async function saveProfilePhoto({
  user,
  docId,
  localUri,
  cachedProfile,
}: {
  user: User;
  docId: string;
  localUri: string;
  /** This person's cached profile, updated with the new photo if given. */
  cachedProfile?: Record<string, unknown> | null;
}): Promise<string> {
  const url = await uploadProfileImage(localUri);
  await updateDoc(doc(db, "students", docId), { profileImage: url });
  if (user.uid !== docId) {
    updateDoc(doc(db, "students", user.uid), { profileImage: url }).catch(() => undefined);
  }
  updateProfile(user, { photoURL: url }).catch((error) =>
    console.warn("[profilePhoto] Error updating auth photoURL:", error),
  );
  updateUserDataCache(
    [user.uid, docId, user.email?.split("@")[0]?.trim()].filter(Boolean) as string[],
    { profileImage: url },
  );
  if (cachedProfile) void saveCachedMyProfile(user.uid, { ...cachedProfile, profileImage: url });
  return url;
}

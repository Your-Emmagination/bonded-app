import AsyncStorage from "@react-native-async-storage/async-storage";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../Firebase_configure";
import {
  DEFAULT_NOTIFICATION_SOUND_ID,
  NotificationSoundId,
} from "./notificationSounds";

const STORAGE_KEY = "bonded:notificationSoundId";
const COLLECTION = "userNotificationSettings";

const isValidSoundId = (value: unknown): value is NotificationSoundId =>
  typeof value === "string" &&
  ["default", "chime", "pop", "bubble", "alert", "silent"].includes(value);

/** Fast, offline-safe read for use at push-send / app-boot time. */
export const getCachedNotificationSoundId =
  async (): Promise<NotificationSoundId> => {
    try {
      const cached = await AsyncStorage.getItem(STORAGE_KEY);
      return isValidSoundId(cached) ? cached : DEFAULT_NOTIFICATION_SOUND_ID;
    } catch {
      return DEFAULT_NOTIFICATION_SOUND_ID;
    }
  };

/** Authoritative read from Firestore, refreshing the local cache. */
export const fetchNotificationSoundId = async (
  userId: string,
): Promise<NotificationSoundId> => {
  try {
    const snapshot = await getDoc(doc(db, COLLECTION, userId));
    const soundId = snapshot.exists() ? snapshot.data()?.soundId : null;
    const resolved = isValidSoundId(soundId)
      ? soundId
      : DEFAULT_NOTIFICATION_SOUND_ID;

    await AsyncStorage.setItem(STORAGE_KEY, resolved).catch(() => null);
    return resolved;
  } catch (error) {
    console.error("Error fetching notification sound setting:", error);
    return getCachedNotificationSoundId();
  }
};

export const setNotificationSoundId = async (
  userId: string,
  soundId: NotificationSoundId,
) => {
  await setDoc(
    doc(db, COLLECTION, userId),
    { userId, soundId, updatedAt: serverTimestamp() },
    { merge: true },
  );
  await AsyncStorage.setItem(STORAGE_KEY, soundId).catch(() => null);
};

/**
 * Bulk lookup used when fanning out a push to many recipients, so we don't
 * issue one Firestore read per recipient on every send.
 */
export const fetchNotificationSoundIdsForUsers = async (
  userIds: string[],
): Promise<Map<string, NotificationSoundId>> => {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const result = new Map<string, NotificationSoundId>();

  await Promise.all(
    uniqueIds.map(async (userId) => {
      try {
        const snapshot = await getDoc(doc(db, COLLECTION, userId));
        const soundId = snapshot.exists() ? snapshot.data()?.soundId : null;
        result.set(
          userId,
          isValidSoundId(soundId) ? soundId : DEFAULT_NOTIFICATION_SOUND_ID,
        );
      } catch {
        result.set(userId, DEFAULT_NOTIFICATION_SOUND_ID);
      }
    }),
  );

  return result;
};

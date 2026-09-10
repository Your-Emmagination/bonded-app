import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "../Firebase_configure";
import {
  DEFAULT_NOTIFICATION_SOUND_ID,
  NotificationSoundId,
} from "./notificationSounds";

const STORAGE_KEY = "bonded:notificationSoundId";
const COLLECTION = "userNotificationSettings";

// Task 4B: per-user, per-channel notification mute.
//
// This lives in its own `channelMutes/{channelId}_{userId}` collection rather
// than as a field on the owner-only `userNotificationSettings` doc, because a
// message sender has to see *other* members' mutes at mention fan-out time to
// know whom to skip — the same per-user-per-channel doc shape already used for
// channelReads / typingIndicators. Presence of the doc means "muted".
const CHANNEL_MUTES_COLLECTION = "channelMutes";
const channelMuteDocId = (channelId: string, userId: string) =>
  `${channelId}_${userId}`;

/** Is this channel muted for this user? Reads that user's own mute doc. */
export const isChannelMuted = async (
  userId: string,
  channelId: string,
): Promise<boolean> => {
  try {
    const snapshot = await getDoc(
      doc(db, CHANNEL_MUTES_COLLECTION, channelMuteDocId(channelId, userId)),
    );
    return snapshot.exists();
  } catch (error) {
    console.error("Error reading channel mute:", error);
    return false;
  }
};

/** Mute (create the doc) or unmute (delete it) a channel for a user. */
export const setChannelMuted = async ({
  userId,
  serverId,
  channelId,
  muted,
}: {
  userId: string;
  serverId: string;
  channelId: string;
  muted: boolean;
}): Promise<void> => {
  const ref = doc(
    db,
    CHANNEL_MUTES_COLLECTION,
    channelMuteDocId(channelId, userId),
  );
  if (muted) {
    await setDoc(ref, {
      userId,
      serverId,
      channelId,
      updatedAt: serverTimestamp(),
    });
  } else {
    await deleteDoc(ref);
  }
};

/**
 * The subset of `userIds` who have muted this channel — used at mention
 * fan-out time to skip creating notifications they've opted out of. One
 * channel-scoped query instead of a read per recipient.
 */
export const fetchChannelMuterIds = async (
  channelId: string,
  userIds: string[],
): Promise<Set<string>> => {
  const wanted = new Set(userIds.filter(Boolean));
  const muted = new Set<string>();
  if (!channelId || wanted.size === 0) return muted;
  try {
    const snapshot = await getDocs(
      query(
        collection(db, CHANNEL_MUTES_COLLECTION),
        where("channelId", "==", channelId),
      ),
    );
    snapshot.docs.forEach((entry) => {
      const uid = String(entry.data()?.userId || "");
      if (uid && wanted.has(uid)) muted.add(uid);
    });
  } catch (error) {
    console.error("Error fetching channel muters:", error);
  }
  return muted;
};

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

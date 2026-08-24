import Constants from "expo-constants";
import type { User } from "firebase/auth";
import {
  arrayUnion,
  collection,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { Platform, Vibration } from "react-native";
import { db } from "../Firebase_configure";
import { fetchNotificationSoundIdsForUsers } from "./notificationSettings";
import {
  DEFAULT_NOTIFICATION_SOUND_ID,
  NOTIFICATION_SOUND_OPTIONS,
  getNotificationSoundOption,
} from "./notificationSounds";
import { getStudentDocIdFromAuthUser, getUserDataByAuthUser } from "./rbac";

const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";
const ANDROID_CHANNEL_ID = "default";
const EMERGENCY_ANDROID_CHANNEL_ID = "emergency";
const EXPO_GO_EXECUTION_ENVIRONMENT = "storeClient";

/** Android res/raw resource name = filename without extension. */
const toAndroidSoundResourceName = (fileName: string) =>
  fileName.replace(/\.[^/.]+$/, "");

type NotificationsModule = typeof import("expo-notifications");
type NotificationResponse = import("expo-notifications").NotificationResponse;
type NotificationSubscription = { remove: () => void };

type EventPushNotificationInput = {
  entityId: string;
  title: string;
  description?: string | null;
  eventDate?: string | null;
  excludeUserIds?: string[];
};

type EmergencyPushNotificationInput = {
  recipientIds: string[];
  entityId: string;
  title?: string | null;
  message: string;
  serverId?: string | null;
  channelId?: string | null;
  serverName?: string | null;
  channelLabel?: string | null;
  serverAccent?: string | null;
  excludeUserIds?: string[];
};

type PushTokenRecord = {
  userId?: string;
  expoPushTokens?: unknown;
};

type RouterLike = {
  push: (href: any) => void;
};

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  sound: string | null;
  priority: "high";
  channelId: string;
  data: Record<string, string>;
};

let notificationsModulePromise: Promise<NotificationsModule | null> | null = null;
let notificationHandlerConfigured = false;

const isExpoGo =
  Constants.executionEnvironment === EXPO_GO_EXECUTION_ENVIRONMENT ||
  Constants.appOwnership === "expo";

const isNativePushRuntimeAvailable = () =>
  Platform.OS !== "web" && !isExpoGo;

const getExpoProjectId = () => {
  const extra = Constants.expoConfig?.extra as
    | { eas?: { projectId?: string } }
    | undefined;
  return Constants.easConfig?.projectId || extra?.eas?.projectId || null;
};

const normalizeEventBody = ({
  eventDate,
  description,
}: Pick<EventPushNotificationInput, "description" | "eventDate">) => {
  const trimmedDate = eventDate?.trim();
  const trimmedDescription = description?.replace(/\s+/g, " ").trim();

  if (trimmedDate && trimmedDescription) {
    return `${trimmedDate} - ${trimmedDescription}`;
  }

  if (trimmedDate) {
    return trimmedDate;
  }

  if (trimmedDescription) {
    return trimmedDescription;
  }

  return "Open the calendar to view the new event.";
};

const isExpoPushToken = (value: string) =>
  /^Expo(nent)?PushToken\[[A-Za-z0-9\-_]+\]$/.test(value);

const chunkArray = <T,>(items: T[], size: number) => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const loadNotificationsModule = async () => {
  if (!isNativePushRuntimeAvailable()) {
    return null;
  }

  if (!notificationsModulePromise) {
    notificationsModulePromise = import("expo-notifications")
      .then((module) => {
        if (!notificationHandlerConfigured) {
          module.setNotificationHandler({
            handleNotification: async () => ({
              shouldShowBanner: true,
              shouldShowList: true,
              shouldPlaySound: true,
              shouldSetBadge: true,
            }),
          });
          notificationHandlerConfigured = true;
        }

        return module;
      })
      .catch((error) => {
        notificationsModulePromise = null;
        console.error("Failed to load expo-notifications:", error);
        return null;
      });
  }

  return notificationsModulePromise;
};

const ensureAndroidNotificationChannel = async (
  notifications: NotificationsModule,
) => {
  if (Platform.OS !== "android") {
    return;
  }

  await notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: "Default",
    importance: notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: "#e0a53d",
    sound: "default",
  });

  // One channel per sound option — Android locks a channel's sound at
  // creation time, so a per-user sound choice means a per-sound channel.
  await Promise.all(
    NOTIFICATION_SOUND_OPTIONS.map((option) =>
      notifications.setNotificationChannelAsync(option.androidChannelId, {
        name: `Notifications - ${option.label}`,
        importance: notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#e0a53d",
        sound: option.iosFileName
          ? toAndroidSoundResourceName(option.iosFileName)
          : undefined,
      }),
    ),
  );

  await notifications.setNotificationChannelAsync(EMERGENCY_ANDROID_CHANNEL_ID, {
    name: "Emergency alerts",
    importance: notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 500, 200, 500, 200, 900],
    lightColor: "#ff2d2d",
    lockscreenVisibility: notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
    sound: "default",
  });
};

const playBrowserEmergencyTone = () => {
  if (Platform.OS !== "web") {
    return false;
  }

  const browserWindow = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextCtor =
    browserWindow.AudioContext || browserWindow.webkitAudioContext;

  if (!AudioContextCtor) {
    return false;
  }

  const audioContext = new AudioContextCtor();
  const startAt = audioContext.currentTime;
  const beepDurations = [0, 0.32, 0.64];

  beepDurations.forEach((offset) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(880, startAt + offset);
    gain.gain.setValueAtTime(0.0001, startAt + offset);
    gain.gain.exponentialRampToValueAtTime(0.24, startAt + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.24);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(startAt + offset);
    oscillator.stop(startAt + offset + 0.26);
  });

  globalThis.setTimeout(() => {
    audioContext.close().catch(() => null);
  }, 1200);

  return true;
};

const persistPushTokenForUser = async (user: User, pushToken: string) => {
  const profile = await getUserDataByAuthUser(user);
  const fallbackDocId = getStudentDocIdFromAuthUser(user) || user.uid;

  await setDoc(
    doc(db, "userPushTokens", user.uid),
    {
      userId: user.uid,
      studentID: profile?.studentID || fallbackDocId,
      email: user.email || profile?.email || null,
      expoPushTokens: arrayUnion(pushToken),
      pushNotificationsEnabled: true,
      pushNotificationsUpdatedAt: serverTimestamp(),
    },
    { merge: true },
  );
};

const extractPushTokens = (value: unknown) => {
  if (typeof value === "string") {
    return isExpoPushToken(value) ? [value] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string =>
      typeof item === "string" && isExpoPushToken(item),
  );
};

const readEventIdFromNotificationData = (data: unknown) => {
  if (!data || typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;
  const screen = typeof record.screen === "string" ? record.screen : null;
  const entityType =
    typeof record.entityType === "string" ? record.entityType : null;
  const entityId = typeof record.entityId === "string" ? record.entityId : null;

  if (!entityId) {
    return null;
  }

  if (screen === "event-calendar" || entityType === "event") {
    return entityId;
  }

  return null;
};

const readEmergencyAlertTargetFromNotificationData = (data: unknown) => {
  if (!data || typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;
  const screen = typeof record.screen === "string" ? record.screen : null;
  const entityType =
    typeof record.entityType === "string" ? record.entityType : null;
  const serverId = typeof record.serverId === "string" ? record.serverId : null;
  const channelId =
    typeof record.channelId === "string" ? record.channelId : null;
  const serverName =
    typeof record.serverName === "string" ? record.serverName : "Emergency";
  const channelLabel =
    typeof record.channelLabel === "string" ? record.channelLabel : "alerts";
  const serverAccent =
    typeof record.serverAccent === "string" ? record.serverAccent : "#b64040";

  if (screen !== "emergency-alert" && entityType !== "emergency") {
    return null;
  }

  if (!serverId || !channelId) {
    return {
      pathname: "/(main)/(tabs)/NotificationsScreen",
    };
  }

  return {
    pathname: "/(main)/ServerChannelScreen",
    params: {
      serverId,
      channelId,
      serverName,
      channelLabel,
      serverAccent,
    },
  };
};

const navigateFromNotificationResponse = (
  response: NotificationResponse | null | undefined,
  router: RouterLike,
) => {
  const notificationData = response?.notification.request.content.data;
  const emergencyTarget =
    readEmergencyAlertTargetFromNotificationData(notificationData);

  if (emergencyTarget) {
    router.push(emergencyTarget);
    return true;
  }

  const eventId = readEventIdFromNotificationData(notificationData);

  if (eventId) {
    router.push({
      pathname: "/(main)/EventCalendarScreen",
      params: { eventId },
    });
    return true;
  }

  // Likes, comments, replies, mentions, and moderation notifications use the
  // existing in-app notification resolver, which already knows how to open
  // posts and show the correct deleted-content message.
  router.push({
    pathname: "/(main)/(tabs)/NotificationsScreen",
  });
  return true;
};

export const isPushNotificationsSupported = () => isNativePushRuntimeAvailable();

export const registerDeviceForPushNotifications = async (user: User) => {
  const notifications = await loadNotificationsModule();
  if (!notifications) {
    return null;
  }

  await ensureAndroidNotificationChannel(notifications);

  const { status: existingStatus } = await notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (finalStatus !== "granted") {
    const permissionResponse = await notifications.requestPermissionsAsync();
    finalStatus = permissionResponse.status;
  }

  if (finalStatus !== "granted") {
    return null;
  }

  const projectId = getExpoProjectId();
  if (!projectId) {
    console.warn("Expo push registration skipped: missing EAS project ID.");
    return null;
  }

  const expoPushToken = await notifications.getExpoPushTokenAsync({ projectId });
  const pushToken = expoPushToken.data;

  if (!pushToken) {
    return null;
  }

  await persistPushTokenForUser(user, pushToken);
  return pushToken;
};

export const getLastPushNotificationResponse = async () => {
  const notifications = await loadNotificationsModule();
  if (!notifications) {
    return null;
  }

  return notifications.getLastNotificationResponseAsync();
};

export const addPushNotificationResponseListener = async (
  listener: (response: NotificationResponse) => void,
) => {
  const notifications = await loadNotificationsModule();
  if (!notifications) {
    return null;
  }

  return notifications.addNotificationResponseReceivedListener(
    listener,
  ) as NotificationSubscription;
};

export const handlePushNotificationNavigation = (
  response: NotificationResponse | null | undefined,
  router: RouterLike,
) => navigateFromNotificationResponse(response, router);

export const playEmergencyAlertSound = async ({
  title = "Emergency alert",
  body = "Open BondED for details.",
  data = {},
}: {
  title?: string;
  body?: string;
  data?: Record<string, string>;
}) => {
  const playedBrowserTone = playBrowserEmergencyTone();
  Vibration.vibrate([0, 500, 200, 500, 200, 900]);

  const notifications = await loadNotificationsModule();
  if (!notifications) {
    return playedBrowserTone;
  }

  await ensureAndroidNotificationChannel(notifications);
  await notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: "default",
      priority: notifications.AndroidNotificationPriority.MAX,
      data: {
        screen: "emergency-alert",
        entityType: "emergency",
        ...data,
      },
    },
    trigger: null,
  });

  return true;
};

export const sendBroadcastEventPushNotifications = async ({
  entityId,
  title,
  description,
  eventDate,
  excludeUserIds = [],
}: EventPushNotificationInput) => {
  const pushTokensSnapshot = await getDocs(collection(db, "userPushTokens"));
  const excludedIds = new Set(excludeUserIds.filter(Boolean));
  const tokensByUserId = new Map<string, Set<string>>();

  pushTokensSnapshot.docs.forEach((item) => {
    const data = item.data() as PushTokenRecord;
    const userId = String(data?.userId || item.id || "").trim();

    if (!userId || excludedIds.has(userId)) {
      return;
    }

    const userTokens = extractPushTokens(data?.expoPushTokens);
    if (userTokens.length === 0) {
      return;
    }

    const existing = tokensByUserId.get(userId) || new Set<string>();
    userTokens.forEach((token) => existing.add(token));
    tokensByUserId.set(userId, existing);
  });

  if (tokensByUserId.size === 0) {
    return 0;
  }

  const soundIdsByUserId = await fetchNotificationSoundIdsForUsers([
    ...tokensByUserId.keys(),
  ]);

  const pushBody = normalizeEventBody({ description, eventDate });
  const notificationTitle = title.trim()
    ? `New event: ${title.trim()}`
    : "New calendar event";

  const messages: ExpoPushMessage[] = [];
  let tokenCount = 0;

  tokensByUserId.forEach((userTokens, userId) => {
    const soundOption = getNotificationSoundOption(
      soundIdsByUserId.get(userId) || DEFAULT_NOTIFICATION_SOUND_ID,
    );

    userTokens.forEach((token) => {
      tokenCount += 1;
      messages.push({
        to: token,
        title: notificationTitle,
        body: pushBody,
        sound: soundOption.iosFileName,
        priority: "high",
        channelId: soundOption.androidChannelId,
        data: {
          screen: "event-calendar",
          entityType: "event",
          entityId,
        },
      });
    });
  });

  for (const batch of chunkArray(messages, 100)) {
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Expo push send failed with status ${response.status}: ${errorBody}`,
      );
    }
  }

  return tokenCount;
};

export const sendEmergencyPushNotifications = async ({
  recipientIds,
  entityId,
  title,
  message,
  serverId,
  channelId,
  serverName,
  channelLabel,
  serverAccent,
  excludeUserIds = [],
}: EmergencyPushNotificationInput) => {
  const allowedRecipientIds = new Set(recipientIds.filter(Boolean));
  const excludedIds = new Set(excludeUserIds.filter(Boolean));

  if (allowedRecipientIds.size === 0) {
    return 0;
  }

  const pushTokensSnapshot = await getDocs(collection(db, "userPushTokens"));
  const tokens = new Set<string>();

  pushTokensSnapshot.docs.forEach((item) => {
    const data = item.data() as PushTokenRecord;
    const userId = String(data?.userId || item.id || "").trim();

    if (!userId || excludedIds.has(userId) || !allowedRecipientIds.has(userId)) {
      return;
    }

    extractPushTokens(data?.expoPushTokens).forEach((token) => {
      tokens.add(token);
    });
  });

  if (tokens.size === 0) {
    return 0;
  }

  const notificationTitle = title?.trim() || "Emergency alert";
  const notificationBody = message.trim() || "Open BondED for details.";

  const messages: ExpoPushMessage[] = Array.from(tokens).map((token) => ({
    to: token,
    title: notificationTitle,
    body: notificationBody,
    sound: "default",
    priority: "high",
    channelId: EMERGENCY_ANDROID_CHANNEL_ID,
    data: {
      screen: "emergency-alert",
      entityType: "emergency",
      entityId,
      serverId: serverId || "",
      channelId: channelId || "",
      serverName: serverName || "",
      channelLabel: channelLabel || "",
      serverAccent: serverAccent || "",
    },
  }));

  for (const batch of chunkArray(messages, 100)) {
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Expo emergency push send failed with status ${response.status}: ${errorBody}`,
      );
    }
  }

  return tokens.size;
};

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
import { Platform } from "react-native";
import { db } from "../Firebase_configure";
import { getStudentDocIdFromAuthUser, getUserDataByAuthUser } from "./rbac";

const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";
const ANDROID_CHANNEL_ID = "default";
const EXPO_GO_EXECUTION_ENVIRONMENT = "storeClient";

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

type PushTokenRecord = {
  userId?: string;
  expoPushTokens?: unknown;
};

type RouterLike = {
  push: (href: {
    pathname: "/(main)/EventCalendarScreen";
    params: { eventId: string };
  }) => void;
};

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  sound: "default";
  priority: "high";
  channelId: string;
  data: {
    screen: "event-calendar";
    entityType: "event";
    entityId: string;
  };
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

const navigateFromNotificationResponse = (
  response: NotificationResponse | null | undefined,
  router: RouterLike,
) => {
  const eventId = readEventIdFromNotificationData(
    response?.notification.request.content.data,
  );

  if (!eventId) {
    return false;
  }

  router.push({
    pathname: "/(main)/EventCalendarScreen",
    params: { eventId },
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

export const sendBroadcastEventPushNotifications = async ({
  entityId,
  title,
  description,
  eventDate,
  excludeUserIds = [],
}: EventPushNotificationInput) => {
  const pushTokensSnapshot = await getDocs(collection(db, "userPushTokens"));
  const excludedIds = new Set(excludeUserIds.filter(Boolean));
  const tokens = new Set<string>();

  pushTokensSnapshot.docs.forEach((item) => {
    const data = item.data() as PushTokenRecord;
    const userId = String(data?.userId || item.id || "").trim();

    if (userId && excludedIds.has(userId)) {
      return;
    }

    extractPushTokens(data?.expoPushTokens).forEach((token) => {
      tokens.add(token);
    });
  });

  if (tokens.size === 0) {
    return 0;
  }

  const pushBody = normalizeEventBody({ description, eventDate });
  const notificationTitle = title.trim()
    ? `New event: ${title.trim()}`
    : "New calendar event";

  const messages: ExpoPushMessage[] = Array.from(tokens).map((token) => ({
    to: token,
    title: notificationTitle,
    body: pushBody,
    sound: "default",
    priority: "high",
    channelId: ANDROID_CHANNEL_ID,
    data: {
      screen: "event-calendar",
      entityType: "event",
      entityId,
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
        `Expo push send failed with status ${response.status}: ${errorBody}`,
      );
    }
  }

  return tokens.size;
};

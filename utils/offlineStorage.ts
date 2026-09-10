// utils/offlineStorage.ts
import AsyncStorage from "@react-native-async-storage/async-storage";

// Helper to re-attach Firestore Timestamp methods (.toMillis(), .toDate()) after JSON deserialization
export const restoreFirestoreTimestamp = (val: any): any => {
  if (!val || typeof val !== "object") return val;

  // Check for Firestore Timestamp representation { seconds: number, nanoseconds?: number }
  if (typeof val.seconds === "number") {
    const seconds = val.seconds;
    const nanoseconds = val.nanoseconds || 0;
    const millis = seconds * 1000 + Math.floor(nanoseconds / 1e6);
    return {
      ...val,
      seconds,
      nanoseconds,
      toMillis: () => millis,
      toDate: () => new Date(millis),
    };
  }

  // Handle arrays
  if (Array.isArray(val)) {
    return val.map(restoreFirestoreTimestamp);
  }

  // Handle generic objects
  const result: Record<string, any> = {};
  for (const key of Object.keys(val)) {
    result[key] = restoreFirestoreTimestamp(val[key]);
  }
  return result;
};

// Safe JSON parser with timestamp restoration
const parseJsonSafely = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return restoreFirestoreTimestamp(parsed) as T;
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] JSON parse error:", error);
    return fallback;
  }
};

// Keys
const FEED_CACHE_KEY = "@bonded_offline_feed_items";
const CHANNEL_MSGS_PREFIX = "@bonded_offline_chan_msgs_";
const COMMENTS_PREFIX = "@bonded_offline_comments_";
const REPLIES_PREFIX = "@bonded_offline_replies_";
const AI_CONVERSATIONS_PREFIX = "@bonded_offline_ai_convs_";
const AI_MSGS_PREFIX = "@bonded_offline_ai_msgs_";
const BOOKMARKS_PREFIX = "@bonded_offline_bookmarks_";
const SERVERS_PREFIX = "@bonded_offline_servers_";
const NOTIFICATIONS_PREFIX = "@bonded_offline_notifs_";
const MY_PROFILE_PREFIX = "@bonded_offline_my_profile_";
const MY_POSTS_PREFIX = "@bonded_offline_my_posts_";
const USER_PROFILE_PREFIX = "@bonded_offline_user_profile_";
const CALENDAR_EVENTS_KEY = "@bonded_offline_cal_events";
const DASHBOARD_DATA_PREFIX = "@bonded_offline_dashboard_";

// Maximum items to keep in disk cache per category to prevent unbounded storage growth
const MAX_FEED_ITEMS = 100;
const MAX_CHANNEL_MESSAGES = 100;
const MAX_COMMENTS = 50;
const MAX_REPLIES = 50;
const MAX_AI_MESSAGES = 100;
const MAX_NOTIFICATIONS = 100;
const MAX_MY_POSTS = 100;
const MAX_USER_POSTS = 50;
const MAX_CALENDAR_EVENTS = 100;

// ─── 1. Feed (Posts, Announcements, Events, Polls) ───────────────────────────

export async function saveCachedFeed<T>(items: T[]): Promise<void> {
  try {
    if (!Array.isArray(items) || items.length === 0) return;
    const trimmed = items.slice(0, MAX_FEED_ITEMS);
    await AsyncStorage.setItem(FEED_CACHE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedFeed error:", error);
  }
}

export async function getCachedFeed<T>(): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(FEED_CACHE_KEY);
    return parseJsonSafely<T[]>(raw, []);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedFeed error:", error);
    return [];
  }
}

// ─── 2. Server Channel Messages ──────────────────────────────────────────────

export async function saveCachedChannelMessages<T>(
  serverId: string,
  channelId: string,
  messages: T[],
): Promise<void> {
  try {
    if (!serverId || !channelId || !Array.isArray(messages) || messages.length === 0) return;
    const key = `${CHANNEL_MSGS_PREFIX}${serverId}_${channelId}`;
    const trimmed = messages.slice(-MAX_CHANNEL_MESSAGES);
    await AsyncStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedChannelMessages error:", error);
  }
}

export async function getCachedChannelMessages<T>(
  serverId: string,
  channelId: string,
): Promise<T[]> {
  try {
    if (!serverId || !channelId) return [];
    const key = `${CHANNEL_MSGS_PREFIX}${serverId}_${channelId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<T[]>(raw, []);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedChannelMessages error:", error);
    return [];
  }
}

// ─── 3. Post Comments ────────────────────────────────────────────────────────

export async function saveCachedComments<T>(postId: string, comments: T[]): Promise<void> {
  try {
    if (!postId || !Array.isArray(comments) || comments.length === 0) return;
    const key = `${COMMENTS_PREFIX}${postId}`;
    const trimmed = comments.slice(0, MAX_COMMENTS);
    await AsyncStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedComments error:", error);
  }
}

export async function getCachedComments<T>(postId: string): Promise<T[]> {
  try {
    if (!postId) return [];
    const key = `${COMMENTS_PREFIX}${postId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<T[]>(raw, []);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedComments error:", error);
    return [];
  }
}

// ─── 4. Comment Replies ──────────────────────────────────────────────────────

export async function saveCachedReplies<T>(commentId: string, replies: T[]): Promise<void> {
  try {
    if (!commentId || !Array.isArray(replies) || replies.length === 0) return;
    const key = `${REPLIES_PREFIX}${commentId}`;
    const trimmed = replies.slice(0, MAX_REPLIES);
    await AsyncStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedReplies error:", error);
  }
}

export async function getCachedReplies<T>(commentId: string): Promise<T[]> {
  try {
    if (!commentId) return [];
    const key = `${REPLIES_PREFIX}${commentId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<T[]>(raw, []);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedReplies error:", error);
    return [];
  }
}

// ─── 5. AI Conversations & Messages ──────────────────────────────────────────

export async function saveCachedAiConversations<T>(userId: string, conversations: T[]): Promise<void> {
  try {
    if (!userId || !Array.isArray(conversations) || conversations.length === 0) return;
    const key = `${AI_CONVERSATIONS_PREFIX}${userId}`;
    await AsyncStorage.setItem(key, JSON.stringify(conversations));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedAiConversations error:", error);
  }
}

export async function getCachedAiConversations<T>(userId: string): Promise<T[]> {
  try {
    if (!userId) return [];
    const key = `${AI_CONVERSATIONS_PREFIX}${userId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<T[]>(raw, []);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedAiConversations error:", error);
    return [];
  }
}

export async function saveCachedAiMessages<T>(
  userId: string,
  conversationId: string,
  messages: T[],
): Promise<void> {
  try {
    if (!userId || !conversationId || !Array.isArray(messages) || messages.length === 0) return;
    const key = `${AI_MSGS_PREFIX}${userId}_${conversationId}`;
    const trimmed = messages.slice(-MAX_AI_MESSAGES);
    await AsyncStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedAiMessages error:", error);
  }
}

export async function getCachedAiMessages<T>(
  userId: string,
  conversationId: string,
): Promise<T[]> {
  try {
    if (!userId || !conversationId) return [];
    const key = `${AI_MSGS_PREFIX}${userId}_${conversationId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<T[]>(raw, []);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedAiMessages error:", error);
    return [];
  }
}

// ─── 6. Bookmarks (Saved Posts) ──────────────────────────────────────────────

export type CachedBookmarksData<T> = {
  bookmarkedPostIds: string[];
  postsById: Record<string, T>;
};

export async function saveCachedBookmarks<T>(
  userId: string,
  data: CachedBookmarksData<T>,
): Promise<void> {
  try {
    if (!userId) return;
    const key = `${BOOKMARKS_PREFIX}${userId}`;
    await AsyncStorage.setItem(key, JSON.stringify(data));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedBookmarks error:", error);
  }
}

export async function getCachedBookmarks<T>(
  userId: string,
): Promise<CachedBookmarksData<T>> {
  try {
    if (!userId) return { bookmarkedPostIds: [], postsById: {} };
    const key = `${BOOKMARKS_PREFIX}${userId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<CachedBookmarksData<T>>(raw, {
      bookmarkedPostIds: [],
      postsById: {},
    });
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedBookmarks error:", error);
    return { bookmarkedPostIds: [], postsById: {} };
  }
}

// ─── 7. Servers & Memberships ────────────────────────────────────────────────

export type CachedServersData<S, M> = {
  servers: S[];
  memberships: M[];
};

export async function saveCachedServers<S, M>(
  userId: string,
  data: CachedServersData<S, M>,
): Promise<void> {
  try {
    if (!userId) return;
    const key = `${SERVERS_PREFIX}${userId}`;
    await AsyncStorage.setItem(key, JSON.stringify(data));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedServers error:", error);
  }
}

export async function getCachedServers<S, M>(
  userId: string,
): Promise<CachedServersData<S, M>> {
  try {
    if (!userId) return { servers: [], memberships: [] };
    const key = `${SERVERS_PREFIX}${userId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<CachedServersData<S, M>>(raw, {
      servers: [],
      memberships: [],
    });
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedServers error:", error);
    return { servers: [], memberships: [] };
  }
}

// ─── 8. Notifications ────────────────────────────────────────────────────────

export async function saveCachedNotifications<T>(userId: string, notifications: T[]): Promise<void> {
  try {
    if (!userId || !Array.isArray(notifications)) return;
    const key = `${NOTIFICATIONS_PREFIX}${userId}`;
    const trimmed = notifications.slice(0, MAX_NOTIFICATIONS);
    await AsyncStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedNotifications error:", error);
  }
}

export async function getCachedNotifications<T>(userId: string): Promise<T[]> {
  try {
    if (!userId) return [];
    const key = `${NOTIFICATIONS_PREFIX}${userId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<T[]>(raw, []);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedNotifications error:", error);
    return [];
  }
}

// ─── 9. My Profile & Posts ───────────────────────────────────────────────────

export async function saveCachedMyProfile<T>(userId: string, profile: T): Promise<void> {
  try {
    if (!userId || !profile) return;
    const key = `${MY_PROFILE_PREFIX}${userId}`;
    await AsyncStorage.setItem(key, JSON.stringify(profile));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedMyProfile error:", error);
  }
}

export async function getCachedMyProfile<T>(userId: string): Promise<T | null> {
  try {
    if (!userId) return null;
    const key = `${MY_PROFILE_PREFIX}${userId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<T | null>(raw, null);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedMyProfile error:", error);
    return null;
  }
}

export async function saveCachedMyPosts<T>(userId: string, posts: T[]): Promise<void> {
  try {
    if (!userId || !Array.isArray(posts)) return;
    const key = `${MY_POSTS_PREFIX}${userId}`;
    const trimmed = posts.slice(0, MAX_MY_POSTS);
    await AsyncStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedMyPosts error:", error);
  }
}

export async function getCachedMyPosts<T>(userId: string): Promise<T[]> {
  try {
    if (!userId) return [];
    const key = `${MY_POSTS_PREFIX}${userId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<T[]>(raw, []);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedMyPosts error:", error);
    return [];
  }
}

// ─── 10. Public User Profile & Posts ─────────────────────────────────────────

export type CachedUserProfileData<P, T> = {
  profile: P | null;
  posts: T[];
};

export async function saveCachedUserProfile<P, T>(
  targetUserId: string,
  data: CachedUserProfileData<P, T>,
): Promise<void> {
  try {
    if (!targetUserId) return;
    const key = `${USER_PROFILE_PREFIX}${targetUserId}`;
    const trimmed = {
      profile: data.profile,
      posts: (data.posts || []).slice(0, MAX_USER_POSTS),
    };
    await AsyncStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedUserProfile error:", error);
  }
}

export async function getCachedUserProfile<P, T>(
  targetUserId: string,
): Promise<CachedUserProfileData<P, T>> {
  try {
    if (!targetUserId) return { profile: null, posts: [] };
    const key = `${USER_PROFILE_PREFIX}${targetUserId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<CachedUserProfileData<P, T>>(raw, {
      profile: null,
      posts: [],
    });
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedUserProfile error:", error);
    return { profile: null, posts: [] };
  }
}

// ─── 11. Event Calendar ──────────────────────────────────────────────────────

export async function saveCachedCalendarEvents<T>(events: T[]): Promise<void> {
  try {
    if (!Array.isArray(events)) return;
    const trimmed = events.slice(0, MAX_CALENDAR_EVENTS);
    await AsyncStorage.setItem(CALENDAR_EVENTS_KEY, JSON.stringify(trimmed));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedCalendarEvents error:", error);
  }
}

export async function getCachedCalendarEvents<T>(): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(CALENDAR_EVENTS_KEY);
    return parseJsonSafely<T[]>(raw, []);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedCalendarEvents error:", error);
    return [];
  }
}

// ─── 12. Staff Dashboard ─────────────────────────────────────────────────────

export async function saveCachedDashboardData<T>(userId: string, data: T): Promise<void> {
  try {
    if (!userId || !data) return;
    const key = `${DASHBOARD_DATA_PREFIX}${userId}`;
    await AsyncStorage.setItem(key, JSON.stringify(data));
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] saveCachedDashboardData error:", error);
  }
}

export async function getCachedDashboardData<T>(userId: string): Promise<T | null> {
  try {
    if (!userId) return null;
    const key = `${DASHBOARD_DATA_PREFIX}${userId}`;
    const raw = await AsyncStorage.getItem(key);
    return parseJsonSafely<T | null>(raw, null);
  } catch (error) {
    if (__DEV__) console.warn("[offlineStorage] getCachedDashboardData error:", error);
    return null;
  }
}


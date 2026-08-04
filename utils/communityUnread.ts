import AsyncStorage from "@react-native-async-storage/async-storage";

const CHANNEL_LAST_SEEN_KEY = "bonded.communityChannelLastSeen";

export type CommunityChannelLastSeenMap = Record<string, number>;

export const getCommunityChannelKey = (serverId?: string | null, channelId?: string | null) =>
  `${serverId || ""}:${channelId || ""}`;

export async function readCommunityChannelLastSeenMap(): Promise<CommunityChannelLastSeenMap> {
  try {
    const rawValue = await AsyncStorage.getItem(CHANNEL_LAST_SEEN_KEY);
    if (!rawValue) return {};
    const parsedValue = JSON.parse(rawValue);
    return parsedValue && typeof parsedValue === "object" ? parsedValue : {};
  } catch (error) {
    console.error("Error reading channel last-seen map:", error);
    return {};
  }
}

export async function writeCommunityChannelLastSeenMap(
  value: CommunityChannelLastSeenMap,
) {
  try {
    await AsyncStorage.setItem(CHANNEL_LAST_SEEN_KEY, JSON.stringify(value));
  } catch (error) {
    console.error("Error saving channel last-seen map:", error);
  }
}

export async function markCommunityChannelViewed(
  serverId?: string | null,
  channelId?: string | null,
  viewedAtMs = Date.now(),
) {
  if (!serverId || !channelId) return;

  const channelKey = getCommunityChannelKey(serverId, channelId);
  const currentMap = await readCommunityChannelLastSeenMap();
  const currentValue = currentMap[channelKey] || 0;
  if (currentValue >= viewedAtMs) return;

  await writeCommunityChannelLastSeenMap({
    ...currentMap,
    [channelKey]: viewedAtMs,
  });
}

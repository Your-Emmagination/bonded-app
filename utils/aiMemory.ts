import { collection, getDocs, Timestamp } from "firebase/firestore";
import { db } from "../Firebase_configure";

export type AiMemoryScopeType = "global" | "server" | "channel";

export type AiMemoryEntry = {
  id: string;
  title: string;
  content: string;
  scopeType: AiMemoryScopeType;
  scopeId?: string | null;
  tags: string[];
  priority: number;
  active: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
};

type AiMemoryContextArgs = {
  serverId?: string | null;
  channelId?: string | null;
  maxChars?: number;
};

const MEMORY_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_MEMORY_CHAR_LIMIT = 7000;

let cachedEntries: AiMemoryEntry[] | null = null;
let cachedAtMs = 0;

const normalizeTags = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((tag) => String(tag || "").trim())
        .filter(Boolean)
    : [];

const mapAiMemoryEntry = (item: any): AiMemoryEntry | null => {
  if (item?.recordType !== "aiMemory") return null;
  const title = String(item.title || "").trim();
  const content = String(item.content || "").trim();
  const scopeType = item.scopeType as AiMemoryScopeType | undefined;

  if (!title || !content || !scopeType) return null;

  return {
    id: String(item.id || ""),
    title,
    content,
    scopeType,
    scopeId: item.scopeId ? String(item.scopeId) : null,
    tags: normalizeTags(item.tags),
    priority: Number(item.priority || 0),
    active: item.active !== false,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
};

export const makeAiMemoryChannelScopeId = (
  serverId?: string | null,
  channelId?: string | null,
) => `${serverId || ""}:${channelId || ""}`;

export const readAiMemoryEntries = async (forceRefresh = false) => {
  const now = Date.now();
  if (!forceRefresh && cachedEntries && now - cachedAtMs < MEMORY_CACHE_TTL_MS) {
    return cachedEntries;
  }

  const snapshot = await getDocs(collection(db, "communityServers"));
  const entries = snapshot.docs
    .map((doc) => mapAiMemoryEntry({ id: doc.id, ...doc.data() }))
    .filter((entry): entry is AiMemoryEntry => !!entry && entry.active)
    .sort((first, second) => {
      if (second.priority !== first.priority) return second.priority - first.priority;
      const firstUpdated = first.updatedAt?.toMillis?.() || 0;
      const secondUpdated = second.updatedAt?.toMillis?.() || 0;
      return secondUpdated - firstUpdated;
    });

  cachedEntries = entries;
  cachedAtMs = now;
  return entries;
};

export const buildAiMemoryBlocks = (
  entries: AiMemoryEntry[],
  maxChars = DEFAULT_MEMORY_CHAR_LIMIT,
) => {
  const blocks: string[] = [];
  let totalChars = 0;

  for (const entry of entries) {
    const tagSuffix = entry.tags.length ? `\nTags: ${entry.tags.join(", ")}` : "";
    const block = `${entry.title}\n${entry.content}${tagSuffix}`.trim();
    if (!block) continue;

    if (totalChars + block.length > maxChars && blocks.length > 0) {
      break;
    }

    blocks.push(block);
    totalChars += block.length;
  }

  return blocks;
};

export const getAiMemoryContext = async ({
  serverId,
  channelId,
  maxChars,
}: AiMemoryContextArgs) => {
  const entries = await readAiMemoryEntries();
  const matchedEntries = entries.filter((entry) => entry.scopeType === "global");

  return {
    entries: matchedEntries,
    memoryBlocks: buildAiMemoryBlocks(matchedEntries, maxChars),
  };
};

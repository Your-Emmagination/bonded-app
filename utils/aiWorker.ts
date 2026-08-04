import AsyncStorage from "@react-native-async-storage/async-storage";
import { getAiMemoryContext } from "./aiMemory";
import { getAiConfigDiagnostics, getAiWorkerUrl } from "./aiConfig";

export const AI_REQUEST_COOLDOWN_MS = 0;
const AI_CONTEXT_LIMIT = 12;
const AI_REQUEST_TIMEOUT_MS = 25000;
const AI_LOCAL_COOLDOWN_PREFIX = "bonded.aiCooldown";

export type AiContextMessage = {
  role: "user" | "assistant";
  name: string;
  content: string;
};

export type ReserveAiCooldownResult = {
  allowed: boolean;
  remainingMs: number;
};

type RequestAiReplyParams = {
  serverId: string;
  channelId: string;
  sourceMessageId: string;
  sourceUserId: string;
  prompt: string;
  contextMessages: AiContextMessage[];
};

export const getAiContextLimit = () => AI_CONTEXT_LIMIT;

export const reserveAiCooldown = async (
  serverId: string,
  channelId: string,
  cooldownMs = AI_REQUEST_COOLDOWN_MS,
): Promise<ReserveAiCooldownResult> => {
  if (cooldownMs <= 0) {
    return {
      allowed: true,
      remainingMs: 0,
    };
  }

  const storageKey = `${AI_LOCAL_COOLDOWN_PREFIX}.${serverId}.${channelId}`;
  const now = Date.now();
  const cachedValue = await AsyncStorage.getItem(storageKey);
  const lastRequestedAtMs = Number(cachedValue || 0);
  const remainingMs = Math.max(0, cooldownMs - (now - lastRequestedAtMs));

  if (remainingMs > 0) {
    return {
      allowed: false,
      remainingMs,
    };
  }

  await AsyncStorage.setItem(storageKey, String(now));

  return {
    allowed: true,
    remainingMs: 0,
  };
};

export const requestAiReplyFromWorker = async ({
  serverId,
  channelId,
  sourceMessageId,
  sourceUserId,
  prompt,
  contextMessages,
}: RequestAiReplyParams) => {
  const workerUrl = getAiWorkerUrl();
  if (!workerUrl) {
    throw new Error("Missing EXPO_PUBLIC_AI_WORKER_URL.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);

  try {
    const { memoryBlocks } = await getAiMemoryContext({
      serverId,
      channelId,
    }).catch((error) => {
      console.error("AI memory load failed:", error);
      return { memoryBlocks: [] };
    });

    const response = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        serverId,
        channelId,
        sourceMessageId,
        sourceUserId,
        prompt,
        memoryBlocks,
        contextMessages: contextMessages.slice(-AI_CONTEXT_LIMIT),
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || "AI worker request failed.");
    }

    const reply = payload?.reply?.trim();
    if (!reply) {
      throw new Error("AI worker returned an empty reply.");
    }

    return {
      reply,
      model: payload?.model || null,
    };
  } catch (error) {
    const diagnostics = getAiConfigDiagnostics();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `AI request failed (${diagnostics.source}: ${diagnostics.resolvedUrl}): ${reason}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
};

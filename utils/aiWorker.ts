import AsyncStorage from "@react-native-async-storage/async-storage";
import { getAiConfigDiagnostics, getAiWorkerUrl } from "./aiConfig";
import { requestNonGenerativeChatbotReply } from "./nonGenerativeChatbot";
import { auth } from "../Firebase_configure";

export const AI_REQUEST_COOLDOWN_MS = 0;
const AI_CONTEXT_LIMIT = 12;
const AI_REQUEST_TIMEOUT_MS = 25000;
const AI_LOCAL_COOLDOWN_PREFIX = "bonded.aiCooldown";

export type AiContextMessage = { role: "user" | "assistant"; name: string; content: string };
export type ReserveAiCooldownResult = { allowed: boolean; remainingMs: number };
export const getAiContextLimit = () => AI_CONTEXT_LIMIT;

export const reserveAiCooldown = async (serverId: string, channelId: string, cooldownMs = AI_REQUEST_COOLDOWN_MS): Promise<ReserveAiCooldownResult> => {
  if (cooldownMs <= 0) return { allowed: true, remainingMs: 0 };
  const storageKey = `${AI_LOCAL_COOLDOWN_PREFIX}.${serverId}.${channelId}`;
  const now = Date.now();
  const lastRequestedAtMs = Number((await AsyncStorage.getItem(storageKey)) || 0);
  const remainingMs = Math.max(0, cooldownMs - (now - lastRequestedAtMs));
  if (remainingMs > 0) return { allowed: false, remainingMs };
  await AsyncStorage.setItem(storageKey, String(now));
  return { allowed: true, remainingMs: 0 };
};

export const requestServerPostModeration = async (postId: string) => {
  const workerUrl = getAiWorkerUrl();
  const currentUser = auth.currentUser;
  if (!workerUrl) throw new Error("Missing EXPO_PUBLIC_AI_WORKER_URL.");
  if (!currentUser) throw new Error("You must be signed in to moderate a post.");
  const idToken = await currentUser.getIdToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      signal: controller.signal,
      body: JSON.stringify({ mode: "moderate-firestore-post", postId }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `Moderation worker failed (${response.status}).`);
    return {
      status: payload?.status || "pending",
      reasons: Array.isArray(payload?.reasons) ? payload.reasons : [],
      moderationSource: payload?.moderationSource || "server",
    };
  } catch (error) {
    const diagnostics = getAiConfigDiagnostics();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Server moderation failed (${diagnostics.source}: ${diagnostics.resolvedUrl}): ${reason}`);
  } finally {
    clearTimeout(timeoutId);
  }
};

export const requestAiReplyFromWorker = async ({ prompt }: {
  serverId: string;
  channelId: string;
  sourceMessageId: string;
  sourceUserId: string;
  prompt: string;
  contextMessages: AiContextMessage[];
}) => {
  const result = await requestNonGenerativeChatbotReply(prompt);
  return {
    reply: result.reply,
    model: result.model,
    intent: result.intent,
    confidence: result.confidence,
  };
};

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

/**
 * Ask the Worker to generate speech-to-text captions for a video post. The
 * Worker responds immediately ("processing") and does the Groq transcription
 * in the background, writing `captionStatus` / `captions` back to the post
 * doc when done. Fire-and-forget from the caller — video publishing must
 * never wait on this, and a failure here just means no captions.
 */
export const requestVideoTranscription = async (postId: string) => {
  const workerUrl = getAiWorkerUrl();
  const currentUser = auth.currentUser;
  if (!workerUrl || !currentUser) return;
  const idToken = await currentUser.getIdToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  try {
    await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      signal: controller.signal,
      body: JSON.stringify({ mode: "transcribe-video", postId }),
    });
  } catch (error) {
    // Non-fatal: the post/video is already published; captions just won't
    // appear. The status field stays "pending" and can be retried later.
    console.warn("[Captions] transcription trigger failed:", error);
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Ask the Worker to run the analytics daily rollup now (staff only). With no
 * `date` it rolls up "today so far"; with a YYYY-MM-DD it backfills that whole
 * UTC day. Used by the Analytics screen's "Run rollup now" action and for
 * verification — the scheduled cron does this automatically once a day.
 */
export const requestDailyRollup = async (date?: string) => {
  const workerUrl = getAiWorkerUrl();
  const currentUser = auth.currentUser;
  if (!workerUrl) throw new Error("Missing EXPO_PUBLIC_AI_WORKER_URL.");
  if (!currentUser) throw new Error("You must be signed in.");
  const idToken = await currentUser.getIdToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      signal: controller.signal,
      body: JSON.stringify({ mode: "run-daily-rollup", ...(date ? { date } : {}) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || `Rollup worker failed (${response.status}).`);
    }
    return payload?.stats ?? null;
  } finally {
    clearTimeout(timeoutId);
  }
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
    const categories = Array.isArray(payload?.categories)
      ? payload.categories.map(String)
      : [];
    const selfHarm =
      payload?.selfHarm === true ||
      categories.some((category: string) => category.toLowerCase().startsWith("self-harm"));

    return {
      status: payload?.status === "approved" ? "approved" : "pending",
      reasons: Array.isArray(payload?.reasons) ? payload.reasons : [],
      categories,
      selfHarm,
      priority: selfHarm || payload?.priority === "critical" ? "critical" : "normal",
      model: typeof payload?.model === "string" ? payload.model : null,
      provider: typeof payload?.provider === "string" ? payload.provider : null,
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

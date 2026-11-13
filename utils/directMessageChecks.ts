// utils/directMessageChecks.ts
//
// The two times a DM goes to the Worker (see "Direct messages" in
// cloudflare/ai-worker/src/index.js). DM text is otherwise never checked or
// stored anywhere but the conversation.
//
//   checkDirectMessageMedia — a photo or video is checked before it's sent;
//     one that breaks the rules is blocked outright. When the check can't run
//     (offline Worker, provider down, hourly allowance used) it's sent anyway,
//     so a moderation outage never stops people from sharing photos.
//   requestBeaDmReply — a message that mentions @bea gets a reply from B.E.A.,
//     written into the conversation by the Worker. Only that one message is
//     read.
import { auth } from "../Firebase_configure";
import { getAiWorkerUrl } from "./aiConfig";

/** "@bea" at the start of the message or after a space. */
export const BEA_DM_MENTION = /(^|\s)@bea\b/i;

export const mentionsBea = (text: string | null | undefined) => BEA_DM_MENTION.test(text || "");

export type DirectMediaVerdict =
  | { verdict: "allowed" }
  | { verdict: "unchecked" }
  | { verdict: "blocked"; labels: string[]; selfHarm: boolean };

/** Images take a few seconds; a video's frames a little longer. */
const MEDIA_CHECK_TIMEOUT_MS = 25_000;
const BEA_REPLY_TIMEOUT_MS = 45_000;

async function callWorker(body: Record<string, unknown>, timeoutMs: number) {
  const token = await auth.currentUser?.getIdToken().catch(() => null);
  if (!token) throw new Error("Not signed in.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(getAiWorkerUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: response.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

/** Is this uploaded photo or video OK to send? Never throws. */
export async function checkDirectMessageMedia(
  conversationId: string,
  url: string,
  kind: "image" | "video",
): Promise<DirectMediaVerdict> {
  try {
    const { ok, data } = await callWorker({ mode: "moderate-dm-media", conversationId, url, kind }, MEDIA_CHECK_TIMEOUT_MS);
    if (ok && data?.verdict === "blocked") {
      return {
        verdict: "blocked",
        labels: Array.isArray(data.labels) ? data.labels.filter((label): label is string => typeof label === "string") : [],
        selfHarm: data.selfHarm === true,
      };
    }
    if (ok && data?.verdict === "allowed") return { verdict: "allowed" };
  } catch (error) {
    console.warn("[directMessageChecks] media check unavailable:", error);
  }
  return { verdict: "unchecked" };
}

/**
 * Asks B.E.A. to answer a message that mentions @bea. The reply arrives in
 * the conversation like any message; this resolves when it's there, or with
 * an error the screen can show.
 */
export async function requestBeaDmReply(
  conversationId: string,
  messageId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { ok, data } = await callWorker({ mode: "bea-dm-reply", conversationId, messageId }, BEA_REPLY_TIMEOUT_MS);
    if (ok) return { ok: true };
    if (data?.code === "not_configured") return { ok: false, message: "B.E.A. can't answer in chats yet." };
    return {
      ok: false,
      message: typeof data?.error === "string" && data.error ? data.error : "B.E.A. couldn't answer right now.",
    };
  } catch {
    return { ok: false, message: "B.E.A. couldn't answer right now." };
  }
}

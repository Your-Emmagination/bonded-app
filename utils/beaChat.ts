// utils/beaChat.ts
//
// B.E.A.'s answers, the AI (GPT on Groq) first. The Worker (mode "bea-chat") understands
// the question and fetches school data through its approved tools; this
// phone never talks to Groq and never holds its key.
//
// Anything that stops the Worker answering — no key set yet, switched off,
// over quota, offline, too slow — falls back to the on-phone bot in
// nonGenerativeChatbot.ts, so B.E.A. always answers something.
import { doc, getDoc } from "firebase/firestore";

import { auth, db } from "../Firebase_configure";
import { getAiWorkerUrl } from "./aiConfig";
import {
  answerPhoneFirst,
  answerQuickLocally,
  requestNonGenerativeChatbotReply,
} from "./nonGenerativeChatbot";

export type BeaTurn = { role: "user" | "assistant"; text: string };

export type BeaReply = {
  reply: string;
  model: string;
  intent: string;
  confidence: number;
  /**
   * "ai" or "cache" from the Worker; "local" for small talk, the date and
   * time, and sums, answered on the phone; "fallback" from the on-phone bot.
   */
  source: "ai" | "cache" | "local" | "fallback";
};

const BEA_TIMEOUT_MS = 25_000;
const HISTORY_TURNS = 10;
const SWITCH_TTL_MS = 5 * 60 * 1000;

let switchState: { on: boolean; checkedAtMs: number } | null = null;

/**
 * Whether to try the AI at all. An admin can turn it off from the Firebase
 * console with appSettings/bea { aiEnabled: false } — no new APK needed.
 * (geminiEnabled, from when B.E.A. used Gemini, is still honoured.)
 * A missing document, or one the rules don't let us read yet, means on.
 */
async function aiSwitchedOn(): Promise<boolean> {
  if (switchState && Date.now() - switchState.checkedAtMs < SWITCH_TTL_MS) return switchState.on;
  const on = await getDoc(doc(db, "appSettings", "bea"))
    .then((snapshot) => snapshot.data()?.aiEnabled !== false && snapshot.data()?.geminiEnabled !== false)
    .catch(() => true);
  switchState = { on, checkedAtMs: Date.now() };
  return on;
}

/** Stop asking the Worker for a while, e.g. when it has no key yet. */
function pauseAi() {
  switchState = { on: false, checkedAtMs: Date.now() };
}

async function fallbackReply(message: string): Promise<BeaReply> {
  const result = await requestNonGenerativeChatbotReply(message);
  return { ...result, source: "fallback" };
}

/**
 * B.E.A.'s reply to `message`. `history` is the conversation so far, oldest
 * first, so follow-up questions make sense; only the last few turns are sent.
 */
export async function requestBeaReply(message: string, history: BeaTurn[] = []): Promise<BeaReply> {
  // "hi", "thanks", "what time is it", "25 * 4": answered here, so the AI's
  // quota goes to questions that need it.
  const quick = answerQuickLocally(message);
  if (quick) return { ...quick, source: "local" };
  // "What is my student ID", "who is Ana Lopez": BondED's own records,
  // which this phone has and the AI doesn't.
  const phoneFirst = await answerPhoneFirst(message).catch(() => null);
  if (phoneFirst) return { ...phoneFirst, source: "local" };

  if (!(await aiSwitchedOn())) return fallbackReply(message);
  const token = await auth.currentUser?.getIdToken().catch(() => null);
  if (!token) return fallbackReply(message);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BEA_TIMEOUT_MS);
  try {
    const response = await fetch(getAiWorkerUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        mode: "bea-chat",
        message,
        history: history
          .filter((turn) => turn.text.trim())
          .slice(-HISTORY_TURNS)
          .map((turn) => ({ role: turn.role === "user" ? "user" : "model", text: turn.text })),
      }),
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => null)) as {
      reply?: unknown;
      model?: unknown;
      source?: unknown;
      code?: unknown;
    } | null;

    if (!response.ok || typeof data?.reply !== "string" || !data.reply.trim()) {
      if (data?.code === "not_configured") pauseAi();
      return fallbackReply(message);
    }
    return {
      reply: data.reply.trim(),
      model: typeof data.model === "string" ? data.model : "gpt-oss",
      intent: "ai",
      confidence: 1,
      source: data.source === "cache" ? "cache" : "ai",
    };
  } catch {
    return fallbackReply(message);
  } finally {
    clearTimeout(timer);
  }
}

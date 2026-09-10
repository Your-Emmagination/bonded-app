// Firestore cache for general-knowledge answers retrieved from public APIs
// (utils/generalKnowledgeApi.ts). Once a question is answered from Wikipedia /
// Wiktionary / REST Countries, the { question, answer, source } is stored so a
// later identical (or token-equivalent) question is answered from Firestore
// without another API round-trip — the cache "learns" from real usage.
//
// Live-data providers (weather, FX) are never written here.
import {
    doc,
    getDoc,
    increment,
    serverTimestamp,
    setDoc,
    updateDoc,
} from "firebase/firestore";
import { db } from "../Firebase_configure";
import type { GeneralKnowledgeAnswer } from "./generalKnowledgeApi";

const COLLECTION = "chatbotKnowledgeCache";
// Re-fetch (ignore the cached row) once it's older than this (7 days).
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CACHE_VERSION = "v3";

const KEY_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "of", "in", "on", "at",
  "to", "for", "and", "or", "what", "whats", "who", "whos", "when", "where",
  "why", "how", "does", "do", "did", "can", "could", "would", "please", "tell",
  "me", "about", "give", "explain", "i", "you", "your", "my", "s",
]);

/**
 * A stable doc-id key: lowercase, de-accented, punctuation-stripped, stopwords
 * removed, remaining words sorted — so "capital of Japan" and "japan capital?"
 * map to the same cache entry. Prefixed with CACHE_VERSION so stale/inaccurate
 * legacy entries are immediately bypassed. Returns "" for a query too thin to key on.
 */
export const normalizeGeneralKnowledgeKey = (prompt: string): string => {
  const base = prompt
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/@(?:ai|bondedai)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !KEY_STOPWORDS.has(word))
    .sort()
    .join("_")
    .slice(0, 470);
  return base.length >= 3 ? `${CACHE_VERSION}_${base}` : "";
};

export type CachedGeneralAnswer = {
  answer: string;
  sourceLabel: string;
  sourceUrl?: string;
  provider: string;
};

/** Returns the cached answer for `key`, or null on miss / stale / error. */
export const getCachedGeneralAnswer = async (
  key: string,
): Promise<CachedGeneralAnswer | null> => {
  try {
    const snapshot = await getDoc(doc(db, COLLECTION, key));
    if (!snapshot.exists()) return null;
    const data = snapshot.data() as Record<string, any>;

    const createdMs = Number(data.createdAtMs || 0);
    if (createdMs && Date.now() - createdMs > TTL_MS) return null;
    if (typeof data.answer !== "string" || data.answer.length === 0) return null;

    return {
      answer: data.answer,
      sourceLabel: String(data.sourceLabel || "Source"),
      sourceUrl: data.sourceUrl ? String(data.sourceUrl) : undefined,
      provider: String(data.provider || ""),
    };
  } catch (error) {
    console.warn("[knowledgeCache] read failed:", error);
    return null;
  }
};

/** Fire-and-forget: store a freshly retrieved answer. Never awaited. */
export const putCachedGeneralAnswer = (
  key: string,
  prompt: string,
  answer: GeneralKnowledgeAnswer,
): void => {
  setDoc(
    doc(db, COLLECTION, key),
    {
      normalizedKey: key,
      question: prompt.slice(0, 500),
      answer: answer.answer.slice(0, 3800),
      sourceLabel: answer.sourceLabel,
      sourceUrl: answer.sourceUrl ?? null,
      provider: answer.provider,
      hitCount: 1,
      createdAt: serverTimestamp(),
      createdAtMs: Date.now(),
      lastUsedAt: serverTimestamp(),
    },
    { merge: true },
  ).catch((error) => console.warn("[knowledgeCache] write failed:", error));
};

/** Fire-and-forget: bump usage stats on a cache hit. Never awaited. */
export const touchCachedGeneralAnswer = (key: string): void => {
  updateDoc(doc(db, COLLECTION, key), {
    hitCount: increment(1),
    lastUsedAt: serverTimestamp(),
  }).catch(() => undefined);
};

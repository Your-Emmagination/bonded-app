import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../Firebase_configure";
import { getLostFoundStatus, updateLostFoundStatus } from "./lostFoundStatus";
import { RESOLUTION_DETECTOR_MODEL } from "./resolutionDetectorModel";

/**
 * Background-only helpers for Part 4 of the Lost & Found feature set. This
 * is NOT part of the @ai chat flow — nothing here ever generates a chat
 * reply. It only classifies a single comment and, if it sounds like the
 * item has been resolved, flags a dismissible UI prompt for the ORIGINAL
 * POSTER. Nothing is ever auto-resolved.
 */

const termIndex = new Map<string, number>(
  RESOLUTION_DETECTOR_MODEL.model.terms.map((term, index) => [term, index]),
);

// A false positive here just shows an easily-dismissed prompt to the
// poster; a false negative means a resolved item keeps surfacing in
// searches. That asymmetry favors a moderate rather than strict threshold.
const RESOLUTION_CONFIDENCE_THRESHOLD = 0.55;

const normalizeCommentText = (value: string) =>
  value
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const vectorizeComment = (input: string) => {
  const normalized = normalizeCommentText(input);
  const tokens = normalized.match(/\b[a-z0-9]+\b/g) || [];
  const counts = new Map<number, number>();

  const addTerm = (term: string) => {
    const index = termIndex.get(term);
    if (index == null) return;
    counts.set(index, (counts.get(index) || 0) + 1);
  };

  for (const token of tokens) addTerm(token);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    addTerm(`${tokens[index]} ${tokens[index + 1]}`);
  }

  const weighted = new Map<number, number>();
  let squaredNorm = 0;

  for (const [featureIndex, count] of counts) {
    const tf = 1 + Math.log(count);
    const idf = Number(RESOLUTION_DETECTOR_MODEL.model.idf[featureIndex] || 0);
    const value = tf * idf;
    weighted.set(featureIndex, value);
    squaredNorm += value * value;
  }

  const norm = Math.sqrt(squaredNorm) || 1;
  for (const [featureIndex, value] of weighted) {
    weighted.set(featureIndex, value / norm);
  }

  return weighted;
};

/**
 * True if the comment sounds like the lost item has been found/returned/
 * claimed ("found na po", "already returned", "thank you nakuha ko na").
 * Deterministic TF-IDF + Logistic Regression, same technique as the intent
 * model — not a new endpoint on it, a separate small trained classifier
 * (see chatbot_training/train_resolution_detector.py).
 */
export const classifyCommentResolution = (commentText: string): boolean => {
  const trimmed = (commentText || "").trim();
  if (!trimmed) return false;

  const features = vectorizeComment(trimmed);
  if (features.size === 0) return false;

  const { classes, coef, intercept } = RESOLUTION_DETECTOR_MODEL.model;
  if (classes.length !== 2 || coef.length !== 1) return false;

  let z = Number(intercept[0] || 0);
  const coefficients = coef[0];
  for (const [featureIndex, featureValue] of features) {
    z += Number(coefficients?.[featureIndex] || 0) * featureValue;
  }

  // sklearn's binary LogisticRegression stores one coefficient row scoring
  // classes_[1] (classes_ is sorted alphabetically: ["not_resolved",
  // "resolved"]) — verify which index that actually is rather than
  // assuming, so a training-data change can't silently flip the meaning.
  const classOneProbability = 1 / (1 + Math.exp(-z));
  const resolvedProbability =
    classes[1] === "resolved" ? classOneProbability : 1 - classOneProbability;

  return resolvedProbability >= RESOLUTION_CONFIDENCE_THRESHOLD;
};

type ResolutionPrompt = {
  commentId: string;
  commentText: string;
  flaggedAtMs: number;
};

export type LostAndFoundPostFields = {
  flair?: string;
  resolvedAt?: unknown;
  lostFoundStatus?: unknown;
  resolutionPrompt?: ResolutionPrompt | null;
};

/**
 * Fire-and-forget: call after a comment is successfully created on a post.
 * No-ops for anything that isn't an un-resolved lost_found post. Never
 * throws into the caller — callers should still wrap this in .catch() as
 * defense in depth, matching this codebase's existing fire-and-forget
 * pattern (see logUnansweredQuestion in nonGenerativeChatbot.ts).
 */
export const flagPotentialResolution = async (input: {
  postId: string;
  commentId: string;
  commentText: string;
}): Promise<void> => {
  const { postId, commentId, commentText } = input;
  if (!postId || !commentText.trim()) return;
  if (!classifyCommentResolution(commentText)) return;

  const postSnap = await getDoc(doc(db, "posts", postId));
  if (!postSnap.exists()) return;
  const post = postSnap.data() as LostAndFoundPostFields;
  if (post.flair !== "lost_found") return;
  // Already returned: nothing left to ask the poster about.
  if (getLostFoundStatus(post) === "returned") return;

  const prompt: ResolutionPrompt = {
    commentId,
    commentText: commentText.trim(),
    flaggedAtMs: Date.now(),
  };

  await updateDoc(doc(db, "posts", postId), { resolutionPrompt: prompt });
};

/**
 * Poster confirms the item is back with its owner. Goes through the status
 * update, which sets resolvedAt alongside "returned" so every reader of either
 * field agrees. Firestore rules check the caller may change this post.
 */
export const confirmLostAndFoundResolution = async (
  postId: string,
  actorUserId: string,
): Promise<void> => {
  await updateLostFoundStatus(postId, "returned", actorUserId);
};

/**
 * Poster dismisses the prompt without confirming — clears it so it stops
 * showing for this specific comment. A later comment can still flag a new
 * prompt (flagPotentialResolution always overwrites this field).
 */
export const dismissLostAndFoundResolutionPrompt = async (postId: string): Promise<void> => {
  await updateDoc(doc(db, "posts", postId), { resolutionPrompt: null });
};

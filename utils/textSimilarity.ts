// utils/textSimilarity.ts
//
// Deterministic word-overlap similarity, shared by the features that need to
// answer "have we seen this before?" — the duplicate-question hint on Create
// Post and the repeated-poll hint on Create Poll.
//
// Same spirit as utils/unansweredClustering.ts: no model, no network, no
// inference cost. Two texts are similar when they share enough significant
// words, which is cheap, explainable, and works offline. It will miss
// paraphrases that share no vocabulary ("where do I pay" vs "cashier
// location") — an accepted tradeoff, since both callers only ever show a
// dismissible hint and never block anything.

// Deliberately a superset of the postSearchTerms stoplist: this one also drops
// question scaffolding ("what", "when", "how"), because almost every question
// contains it and leaving it in makes unrelated questions look alike.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "of", "to", "in",
  "on", "at", "by", "for", "is", "am", "are", "was", "were", "be", "been",
  "being", "it", "its", "this", "that", "these", "those", "as", "with", "from",
  "we", "you", "i", "he", "she", "they", "our", "your", "my", "me", "us",
  "do", "does", "did", "not", "no", "yes", "can", "will", "just", "have", "has",
  "what", "when", "where", "who", "why", "how", "which", "there", "here",
  "any", "some", "about", "please", "thanks", "thank", "hi", "hello", "po",
]);

const MIN_TERM_LENGTH = 3;

/** Lowercase, de-punctuated significant words. Order and duplicates dropped. */
export function tokenizeForSimilarity(text: string): Set<string> {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= MIN_TERM_LENGTH && !STOPWORDS.has(word)),
  );
}

/**
 * Jaccard overlap: shared words divided by total distinct words. 0 = nothing
 * in common, 1 = the same set of significant words.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  // Walk the smaller set so the cost is bounded by the shorter text.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  small.forEach((term) => {
    if (large.has(term)) shared += 1;
  });

  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Convenience wrapper for the common "compare two raw strings" case. */
export function textSimilarity(a: string, b: string): number {
  return jaccardSimilarity(tokenizeForSimilarity(a), tokenizeForSimilarity(b));
}

export type SimilarCandidate<T> = { item: T; score: number };

/**
 * The single closest match above `threshold`, or null.
 *
 * Both callers want "did we already have this one?", not a ranked list, so
 * returning the best match keeps the surface small and the hint unambiguous.
 */
export function findMostSimilar<T>(
  text: string,
  candidates: T[],
  getText: (item: T) => string,
  threshold: number,
): SimilarCandidate<T> | null {
  const source = tokenizeForSimilarity(text);
  if (source.size < 2) return null; // too short to judge

  let best: SimilarCandidate<T> | null = null;

  for (const item of candidates) {
    const score = jaccardSimilarity(source, tokenizeForSimilarity(getText(item)));
    if (score >= threshold && (!best || score > best.score)) {
      best = { item, score };
    }
  }

  return best;
}

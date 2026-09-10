// App-wide search: post content is preprocessed at write time (post create /
// edit) into a lowercase, de-punctuated array of its significant words, stored
// on the post as `searchTerms`. Global search then queries it with
// `where("searchTerms", "array-contains", term)`, which matches a word
// ANYWHERE in the post — unlike a prefix range on the raw `content` field,
// which would only match the post's opening words.
//
// Known, accepted tradeoff: this matches whole words only (searching "mid"
// will not find "midterm"). Matching anywhere in the text is more useful for
// post bodies than partial-word matches from the start.

// A short stoplist of filler words dropped from `searchTerms` — keeps the
// array smaller and avoids near-useless matches. Nice-to-have, not essential.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "of", "to", "in",
  "on", "at", "by", "for", "is", "am", "are", "was", "were", "be", "been",
  "being", "it", "its", "this", "that", "these", "those", "as", "with", "from",
  "we", "you", "i", "he", "she", "they", "our", "your", "my", "me", "us",
  "do", "does", "did", "not", "no", "yes", "can", "will", "just", "have", "has",
]);

// Keep the array bounded so a very long post doesn't bloat its document.
const MAX_TERMS = 60;

/**
 * Build the `searchTerms` array for a post from its text content (plus any
 * extra strings worth indexing, e.g. a link title). Safe to call on every
 * create/edit; returns `[]` for empty input.
 */
export function buildPostSearchTerms(
  content: string | null | undefined,
  extra: (string | null | undefined)[] = [],
): string[] {
  const raw = [content, ...extra].filter(Boolean).join(" ");
  if (!raw.trim()) return [];

  const words = raw
    .toLowerCase()
    // strip everything that isn't a letter/number/space (handles punctuation,
    // emoji, etc.); keep unicode letters so non-ASCII names still index.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));

  // De-duplicate while preserving first-seen order, then cap.
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const word of words) {
    if (seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

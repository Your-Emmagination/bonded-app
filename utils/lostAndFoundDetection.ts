/**
 * First-person possessive phrasing ("my", "I lost", "I can't find my")
 * signals someone is describing their OWN lost item, as opposed to
 * searching for one someone else reported finding ("has anyone found a...",
 * no first-person possessive).
 *
 * Shared by:
 * - utils/nonGenerativeChatbot.ts — the @ai chat nudge ("post this in
 *   Lost & Found?") when a message matches and no existing post covers it.
 * - app/(main)/CreatePostScreen.tsx — suggesting the Lost & Found flair
 *   while composing a post, before it's even submitted.
 *
 * Kept in one place so the two surfaces can never quietly drift out of
 * sync with each other.
 */
export const LOST_FOUND_FIRST_PERSON_PATTERN =
  /\b(i\s*(?:'m|am)?\s*lost|lost\s+my|missing\s+my|misplaced\s+my|i\s*can'?t\s+find\s+my|i\s+cannot\s+find\s+my|has\s+anyone\s+(?:seen|found)\s+my)\b/;

export const looksLikeLostItemDescription = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return LOST_FOUND_FIRST_PERSON_PATTERN.test(normalized);
};

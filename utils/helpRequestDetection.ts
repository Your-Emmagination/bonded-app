/**
 * Explicit "I'm asking for help / advice" phrasing — someone who needs a hand
 * with something, as opposed to starting an ordinary Discussion or Question
 * post. The pattern is deliberately narrow: it only matches phrases that are
 * unambiguously a request for help ("i need help", "can someone explain",
 * "i'm struggling with", "does anyone know how to"). Generic openers like
 * "how do i" or a bare trailing "?" are left out on purpose — those fire on
 * everyday Question/Discussion posts too, which would turn the suggestion
 * into a nag instead of a genuinely useful nudge. Precision matters more
 * than recall here.
 *
 * Used by:
 * - app/(main)/CreatePostScreen.tsx — suggesting the Help / Advice flair
 *   while composing a post, before it's submitted (mirrors the Lost & Found
 *   flair suggestion — see utils/lostAndFoundDetection.ts).
 *
 * The chatbot (utils/nonGenerativeChatbot.ts) does NOT import this pattern.
 * Its Help / Advice post lookup is gated by a separate, broader keyword list
 * (HELP_REQUEST_KEYWORDS) so it still triggers on the wider variety of
 * phrasings people type at an assistant; the compose-time regex stays tight
 * so the banner only appears when the post really is a help request.
 */
export const HELP_REQUEST_PATTERN =
  /\b(i\s+need\s+help|i\s+could\s+use\s+(?:some\s+)?help|can\s+(?:you|someone|anyone)\s+help|help\s+me\s+(?:understand|figure\s+out)|does\s+anyone\s+know\s+how\s+to|can\s+someone\s+explain|i'?m\s+struggling\s+with|i\s+am\s+struggling\s+with|i'?m\s+stuck\s+on|i\s+am\s+stuck\s+on|i\s+don'?t\s+understand|i\s+do\s+not\s+understand|(?:need|any)\s+advice)\b/;

export const looksLikeHelpRequest = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return HELP_REQUEST_PATTERN.test(normalized);
};

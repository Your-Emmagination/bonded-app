// utils/emojiMessages.ts
//
// Messenger shows a message that is only an emoji or three big and without a
// bubble, and sends a like at the size its button was held to. These are the
// rules for both, kept apart from the screen so they can be tested.
import type { DirectEmojiSize } from "./directMessages";

/** More emoji than this in one message reads as text, so it stays normal size. */
export const MAX_BIG_EMOJI = 3;

// Built at run time rather than written as a /literal/: a JavaScript engine
// without these Unicode properties then shows emoji at their normal size,
// instead of the whole app failing to load.
const EMOJI_ONLY: RegExp | null = (() => {
  try {
    const part = "\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?";
    // One emoji: a picture with an optional skin tone or presentation mark,
    // joined families (ZWJ sequences), or a flag's two regional letters.
    const emoji = `(?:${part}(?:\\u200D${part})*|\\p{Regional_Indicator}{2})`;
    return new RegExp(`^\\s*(?:${emoji}\\s*){1,${MAX_BIG_EMOJI}}$`, "u");
  } catch {
    return null;
  }
})();

/** Nothing but one to three emoji. */
export function isEmojiOnly(text: string | null | undefined): boolean {
  return !!text && !!EMOJI_ONLY && EMOJI_ONLY.test(text);
}

/** Point sizes for a like sent at each size. A plain tap sends small. */
export const EMOJI_SIZE_POINTS: Record<DirectEmojiSize, number> = {
  small: 40,
  medium: 64,
  large: 96,
};

/** An emoji-only message typed in the message box. */
export const TYPED_BIG_EMOJI_POINTS = 38;

/** The size to draw a message's emoji at, or null when it's an ordinary message. */
export function bigEmojiFontSize(
  text: string | null | undefined,
  emojiSize?: DirectEmojiSize | null,
): number | null {
  if (!text?.trim()) return null;
  if (emojiSize && EMOJI_SIZE_POINTS[emojiSize]) return EMOJI_SIZE_POINTS[emojiSize];
  return isEmojiOnly(text) ? TYPED_BIG_EMOJI_POINTS : null;
}

// ── Holding the like button ───────────────────────────────────────────────
// Timed from when the hold is recognised, not from the first touch.

/** Held at least this long, the like is sent medium. */
export const EMOJI_HOLD_MEDIUM_MS = 450;
/** Held at least this long, it's sent large. */
export const EMOJI_HOLD_LARGE_MS = 1100;
/** Held this long, it pops and nothing is sent — Messenger's way to cancel. */
export const EMOJI_HOLD_POP_MS = 3000;

/** The size for a hold of this length, or null when it went on long enough to pop. */
export function emojiSizeForHold(heldMs: number): DirectEmojiSize | null {
  if (heldMs >= EMOJI_HOLD_POP_MS) return null;
  if (heldMs >= EMOJI_HOLD_LARGE_MS) return "large";
  if (heldMs >= EMOJI_HOLD_MEDIUM_MS) return "medium";
  return "small";
}

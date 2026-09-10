// cloudflare/ai-worker/src/keywordModeration.js
//
// Deterministic keyword backstop for text moderation, layered ON TOP OF
// OpenModeration — not a replacement for it. OpenModeration scores context
// and intent (e.g. it will not flag "gun" in "the movie has a gun fight
// scene" the same way it flags an actual threat), which is the right
// behavior for most language but leaves a gap for school-safety terms where
// the policy is "any mention gets a human look, regardless of context."
// This module closes that specific gap: any post/comment/reply/message
// containing one of these terms is forced to `pending` even if
// OpenModeration's category scores come back low.
//
// Edit KEYWORD_CATEGORIES freely — it's just data. Each category:
//   - terms: exact words/phrases to match (case-insensitive, whole-word)
//   - priority: "critical" (jumps to the top of the moderation queue,
//     same lane as self-harm — never hidden behind pagination) or "normal"
//   - label: shown to moderators in the flagged reason
//
// Deliberately NOT included: "knife", "blade", "cutter" and similar dual-use
// words — they appear constantly in ordinary contexts (cooking, crafts) and
// would generate far more false positives than genuine catches. Add them
// here if your policy wants that tradeoff anyway.

export const KEYWORD_CATEGORIES = Object.freeze({
  weapons: {
    label: "weapon-related term",
    priority: "critical",
    terms: [
      "gun",
      "guns",
      "firearm",
      "firearms",
      "rifle",
      "rifles",
      "pistol",
      "pistols",
      "shotgun",
      "shotguns",
      "revolver",
      "revolvers",
      "handgun",
      "handguns",
      "ammo",
      "ammunition",
      "grenade",
      "grenades",
      "bomb",
      "bombs",
      "explosive",
      "explosives",
    ],
  },
  // Not "critical" like weapons/self-harm — this is a real policy violation
  // worth a human review, but not the same acute-danger tier (nobody is in
  // immediate physical danger from a drug mention the way they might be
  // from a weapon or self-harm one). Still routes to `pending`; just doesn't
  // jump the queue or fire a staff safety alert. Change to "critical" below
  // if that's the wrong call for your policy.
  drugs: {
    label: "illicit substance term",
    priority: "normal",
    terms: [
      "drugs",
      "marijuana",
      "weed",
      "cannabis",
      "cocaine",
      "heroin",
      "meth",
      "methamphetamine",
      "shabu", // common Philippine slang for methamphetamine
      "ecstasy",
      "mdma",
      "lsd",
      "vape",
      "vapes",
      "vaping",
    ],
  },
});

// Escapes a literal string for safe use inside a RegExp.
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Built once at module load: one whole-word, case-insensitive regex per
// term, keyed by category, so checkKeywordFlags() doesn't rebuild patterns
// on every call. \b word boundaries mean "gun" matches "gun" and "guns" (via
// the separate plural entry) but not "begun" or "Gunther".
const COMPILED_CATEGORIES = Object.entries(KEYWORD_CATEGORIES).map(([name, config]) => ({
  name,
  label: config.label,
  priority: config.priority,
  patterns: config.terms.map((term) => ({
    term,
    regex: new RegExp(`\\b${escapeRegExp(term)}\\b`, "i"),
  })),
}));

/**
 * Checks `text` against every configured keyword category.
 *
 * Returns:
 *   {
 *     flagged: boolean,
 *     priority: "critical" | "normal",   // highest priority among matches
 *     matches: [{ category, label, term }],
 *   }
 */
export function checkKeywordFlags(text) {
  const input = String(text || "");
  const matches = [];
  let priority = "normal";

  for (const category of COMPILED_CATEGORIES) {
    for (const { term, regex } of category.patterns) {
      if (regex.test(input)) {
        matches.push({ category: category.name, label: category.label, term });
        if (category.priority === "critical") priority = "critical";
      }
    }
  }

  return {
    flagged: matches.length > 0,
    priority,
    matches,
  };
}

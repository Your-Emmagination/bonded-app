// cloudflare/ai-worker/src/keywordModeration.js
//
// Deterministic keyword backstop for text moderation, layered ON TOP OF
// OpenModeration — not a replacement for it. OpenModeration scores context
// and intent (e.g. it will not flag "gun" in "the movie has a gun fight
// scene" the same way it flags an actual threat), which is the right
// behavior for most language but leaves a gap for terms where the school's
// policy is "any mention gets a human look, regardless of context."
// This module closes that specific gap: any post/comment/reply/message
// containing one of these terms is forced to `pending` even if
// OpenModeration's category scores come back low.
//
// WHY PROFANITY IS A LIST AND NOT A MODEL SCORE:
// OpenModeration's categories are all *harm* categories — sexual, hate,
// harassment, violence, self-harm, illicit. Vulgarity is not one of them.
// So "putangina" or "fuck" on its own scores low in every category and comes
// back approved, while the same words aimed at a person cross the harassment
// threshold and go pending. That is exactly why testers saw some bad words
// held and others published. "A bad word is a bad word" is a policy, and a
// policy needs a list.
//
// Edit KEYWORD_CATEGORIES freely — it's just data. Each category:
//   - terms: words to match (see MATCHING below for how forgiving it is)
//   - priority: "critical" (jumps to the top of the moderation queue,
//     same lane as self-harm — never hidden behind pagination) or "normal"
//   - label: shown to moderators in the flagged reason
//
// MATCHING is deliberately tolerant, because a student who wants to swear
// will space it out or star it out. Every term matches:
//   - any capitalization, and accented letters ("pütä")
//   - repeated letters: "gagooo", "shiiit"
//   - leetspeak: "g4go", "sh1t", "b0bo", "@ss"
//   - separators between letters: "g a g o", "p.u.t.a", "put-angina"
//   - one starred-out middle letter: "f*ck", "p*ta", "t*ngina"
// A term written compactly also covers its spaced form, so "putangina"
// matches "putang ina" and "hayopka" matches "hayop ka" — there is no need
// to list both. Whole-word only: "ass" never matches inside "class", and
// "gun" never matches inside "begun".
//
// NOT caught, so you know the edges: two or more masked letters ("p**a"),
// and creative respellings that aren't in the list ("puta ngina" split
// across a sentence). Those stay with the AI layer and user reports.

export const KEYWORD_CATEGORIES = Object.freeze({
  weapons: {
    label: "Weapon-related term",
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
    label: "Illicit substance term",
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
  // Normal priority on purpose: swearing is a conduct matter for a reviewer,
  // not a safety emergency, so it queues without paging anyone. The content
  // is still held back from the feed until a moderator approves it.
  //
  // A held item is a student blocked from posting until a human looks, so
  // the list stays on words that are unambiguously profanity or an insult.
  // Deliberately NOT included, because each has an ordinary meaning that
  // would hold innocent posts: "leche" (leche flan), "atay" (liver),
  // "peste", "unggoy", "buang", "bogo" (a city in Cebu), "pepe" (a common
  // nickname), and the mild English "damn", "hell", "crap", "wtf". Add them
  // if your policy wants that tradeoff anyway.
  profanity: {
    label: "Profanity or insult",
    priority: "normal",
    terms: [
      // English
      "fuck",
      "fuk",
      "fucked",
      "fucker",
      "fucking",
      "motherfucker",
      "shit",
      "shitty",
      "shithead",
      "bullshit",
      "bitch",
      "bitches",
      "bastard",
      "asshole",
      "dumbass",
      "jackass",
      "ass",
      "dick",
      "dickhead",
      "pussy",
      "cunt",
      "whore",
      "slut",
      "tits",
      "douchebag",
      "wanker",
      "twat",
      "retard",
      "retarded",
      "faggot",
      "nigga",
      "nigger",
      // Filipino / Tagalog — compact spellings also cover the spaced forms
      // ("putangina" matches "putang ina", "hayopka" matches "hayop ka").
      "putangina",
      "tangina",
      "kingina",
      "puta",
      "pota",
      "gago",
      "gaga",
      "gagu",
      "gagong",
      "tanga",
      "bobo",
      "ulol",
      "ulul",
      "punyeta",
      "lintik",
      "hinayupak",
      "hayopka",
      "pakshet",
      "pakyu",
      "kupal",
      "tarantado",
      "tarantada",
      "siraulo",
      "inutil",
      "bwisit",
      "buwisit",
      "yawa",
      "pisti",
      // Crude sexual slang
      "burat",
      "tite",
      "titi",
      "puke",
      "kantot",
      "jakol",
      "bayag",
      "etits",
      "tamod",
      "libog",
      "malandi",
    ],
  },
});

// Characters that commonly stand in for a letter. Only symbols that are safe
// inside a regex character class are listed (no "-", "]", "^" or backslash).
const LETTER_EQUIVALENTS = Object.freeze({
  a: "a4@",
  b: "b8",
  c: "c(",
  e: "e3",
  g: "g69",
  i: "i1!|",
  l: "l1|",
  o: "o0",
  s: "s5$",
  t: "t7+",
  z: "z2",
});

// Up to three non-alphanumeric characters may sit between letters, so
// "p.u.t.a" and "g a g o" match. Because every letter must still appear in
// order and the match is anchored to word edges, this does not bleed across
// ordinary words: the "p" in "sharp. Utah" is preceded by a letter, so the
// left edge fails before anything else is tried.
const SEPARATOR = "[^a-z0-9]{0,3}";

// One starred-out letter: "f*ck", "t*ngina".
const MASK = "[*#@$%!?]{1,2}";

// Word edges by alphanumerics rather than \b, because a term may begin with
// a leet symbol ("@ss") and \b would then test the wrong side.
const LEFT_EDGE = "(?<![a-z0-9])";
const RIGHT_EDGE = "(?![a-z0-9])";

const letterClass = (letter) => {
  const equivalents = LETTER_EQUIVALENTS[letter];
  return equivalents ? `[${equivalents}]+` : `${letter}+`;
};

const buildPattern = (parts) => `${LEFT_EDGE}${parts.join(SEPARATOR)}${RIGHT_EDGE}`;

// One variant per maskable position. The first and last letters are never
// masked: they anchor the match and keep "p**a"-style noise from matching
// unrelated words.
const maskedPatterns = (parts) => {
  if (parts.length < 4) return [];
  const variants = [];
  for (let index = 1; index < parts.length - 1; index += 1) {
    const copy = parts.slice();
    copy[index] = MASK;
    variants.push(buildPattern(copy));
  }
  return variants;
};

// Built once at module load so checkKeywordFlags() doesn't recompile
// patterns on every request.
const COMPILED_CATEGORIES = Object.entries(KEYWORD_CATEGORIES).map(([name, config]) => ({
  name,
  label: config.label,
  priority: config.priority,
  patterns: config.terms
    .map((term) => {
      const letters = String(term)
        .toLowerCase()
        .replace(/[^a-z]/g, "")
        .split("");
      if (letters.length === 0) return null;
      const parts = letters.map(letterClass);
      const sources = [buildPattern(parts), ...maskedPatterns(parts)];
      return { term, regex: new RegExp(sources.join("|"), "i") };
    })
    .filter(Boolean),
}));

// Accents stripped so "pütä" is tested as "puta"; lowercased so the patterns
// only ever deal with one case.
const normalizeForMatching = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

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
  const input = normalizeForMatching(text);
  const matches = [];
  let priority = "normal";

  if (!input) return { flagged: false, priority, matches };

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

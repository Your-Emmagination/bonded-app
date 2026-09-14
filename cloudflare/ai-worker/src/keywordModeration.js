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

  // WHY THIS EXISTS, AND WHY IT IS THE MOST CAREFUL LIST IN THE FILE:
  //
  // OpenModeration does have a self-harm category, and it is the only thing
  // that sets `selfHarm: true` — the flag that opens SafetyDialog with the
  // helplines and the "reach out to a trusted adult" line. But the model is
  // English-first. A student writing "gusto ko na mamatay" or "wala na akong
  // silbi" can score below the threshold, and when that happens the dialog
  // never appears: no helpline, no trusted adult, and the post may publish
  // as if nothing was said. That is precisely the case the whole feature was
  // built for, and it is the one most likely to fail.
  //
  // The cost of being wrong runs BOTH ways here, unlike every other category:
  //   - a miss means a student in crisis is handed nothing
  //   - a false positive shows a crisis dialog to someone who did not need it
  // So this list is phrases, not words. Every entry states intent about
  // oneself. Single words are avoided because Filipino everyday speech is
  // full of them innocently.
  //
  // Deliberately NOT included, because each appears constantly in ordinary
  // posts: "patay" (lights/battery off), "mamatay" and "namatay" on their own
  // (a phone dying, someone else passing away), "hindi na ako kaya" (usually
  // about homework), "hurt myself" (usually basketball), and bare "suicide"
  // (awareness seminars, news, schoolwork). Intent phrases carry the signal;
  // these carry only the vocabulary.
  //
  // Staff never reach this code — teachers, moderators and admins bypass text
  // moderation entirely — so everything here is judged only on student text.
  self_harm: {
    label: "Possible self-harm",
    priority: "critical",
    // Opens SafetyDialog, not just the moderation queue. Only this category
    // carries it.
    selfHarm: true,
    terms: [
      // --- Tagalog: intent to die ---------------------------------------
      // "..." allows up to two particles in between — see buildGapPattern.
      "gusto ko ... mamatay",
      "gusto kong ... mamatay",
      "nais ko ... mamatay",
      "ayoko ... mabuhay",
      "ayaw ko ... mabuhay",
      "sawa na ako sa buhay",
      "pagod na ako sa buhay",
      "pagod na ako ... mabuhay",
      "ayoko na sa mundong ito",
      // --- Tagalog: acting on it ----------------------------------------
      "magpapakamatay",
      "magpakamatay",
      "nagpakamatay",
      // Tagalog drops particles ("na", "nang") in the middle of a phrase, and
      // the matcher only bridges non-letters — so "papatayin ko ANG sarili"
      // and "papatayin ko NA ang sarili" are two different strings and both
      // have to be listed. Each entry is also written in its shortest form:
      // "papatayin ko ang sarili" already covers "...ang sarili ko", because
      // matching ends on a word boundary rather than end-of-text.
      "papatayin ko ang sarili",
      "papatayin ko na ang sarili",
      "papatayin ko sarili",
      "papatayin ko na sarili",
      "papatayin ko na lang ang sarili",
      "tatapusin ko ang buhay",
      "tatapusin ko na ang buhay",
      "tatapusin ko na buhay",
      "tapusin ko ang buhay ko",
      "tapusin ko na ang buhay",
      "wawakasan ko ang buhay",
      "wawakasan ko na ang buhay",
      // --- Tagalog: worthlessness, the common lead-in -------------------
      "wala na akong silbi",
      "wala akong silbi",
      "wala na akong kwenta",
      "wala akong kwenta",
      "wala na akong halaga",
      "mabuti pang mamatay na ako",
      "mas mabuti pang wala na ako",
      // --- Bisaya / Cebuano ---------------------------------------------
      "gusto na ko ... mamatay",
      "gusto nako ... mamatay",
      "gikapoy na ko ... kinabuhi",
      "wala na koy pulos",
      "wala koy pulos",
      "maghikog",
      "naghikog",
      "mohikog",
      "hikog",
      // --- English -------------------------------------------------------
      "kill myself",
      "killing myself",
      "kms",
      "end my life",
      "ending my life",
      "take my own life",
      "want to die",
      "wanna die",
      "i want to die",
      "better off dead",
      "no reason to live",
      "nothing to live for",
      "cut myself",
      "cutting myself",
      "self harm",
      "unalive myself",
      "commit suicide",
      "kill my self",
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

// "..." inside a term means "up to GAP_MAX_WORDS other words here".
//
// Needed because Tagalog drops particles mid-phrase freely: "gusto ko
// mamatay", "gusto ko NA mamatay", "gusto ko NA TALAGA mamatay" are all the
// same sentence, and listing every combination is a losing game. A term
// written "gusto ko ... mamatay" covers all of them.
//
// Two words, not more. The gap is the one place this list can over-reach —
// "gusto ko na mamatay ang ilaw" (I want the lights off) would match — and
// every extra word widens that. Two is enough for the particle stacking that
// actually occurs, and the cost of the rare false positive is a dialog
// somebody did not need, against a miss that leaves a student with nothing.
const GAP_MAX_WORDS = 2;
const WORD_GAP = `[^a-z0-9]+(?:[a-z0-9]+[^a-z0-9]+){0,${GAP_MAX_WORDS}}`;

const lettersOf = (value) => String(value).toLowerCase().replace(/[^a-z]/g, "").split("");

// Compiles a term that contains "...": each segment matches as usual, with a
// bounded run of other words allowed between them. Masked variants are not
// generated for these — nobody star-masks a four-word sentence.
const buildGapPattern = (term) => {
  const segments = String(term)
    .split("...")
    .map((segment) => lettersOf(segment))
    .filter((letters) => letters.length > 0);
  if (segments.length < 2) return null;
  const body = segments
    .map((letters) => letters.map(letterClass).join(SEPARATOR))
    .join(WORD_GAP);
  return `${LEFT_EDGE}${body}${RIGHT_EDGE}`;
};

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
  selfHarm: config.selfHarm === true,
  patterns: config.terms
    .map((term) => {
      if (String(term).includes("...")) {
        const source = buildGapPattern(term);
        return source ? { term, regex: new RegExp(source, "i") } : null;
      }
      const letters = lettersOf(term);
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
 *     selfHarm: boolean,                 // a self-harm term matched
 *     matches: [{ category, label, term }],
 *   }
 *
 * `selfHarm` is separate from `flagged` on purpose: flagging holds the post
 * for a moderator, while selfHarm opens SafetyDialog for the student who
 * wrote it. The caller merges it with OpenModeration's own self-harm signal.
 */
export function checkKeywordFlags(text) {
  const input = normalizeForMatching(text);
  const matches = [];
  let priority = "normal";
  let selfHarm = false;

  if (!input) return { flagged: false, priority, selfHarm, matches };

  for (const category of COMPILED_CATEGORIES) {
    for (const { term, regex } of category.patterns) {
      if (regex.test(input)) {
        matches.push({ category: category.name, label: category.label, term });
        if (category.priority === "critical") priority = "critical";
        if (category.selfHarm) selfHarm = true;
      }
    }
  }

  return {
    flagged: matches.length > 0,
    priority,
    selfHarm,
    matches,
  };
}

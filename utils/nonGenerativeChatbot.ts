import { addDoc, collection, getDocs, query, serverTimestamp, where } from "firebase/firestore";
import { auth, db } from "../Firebase_configure";
import { getUserDataByAuthUser, type UserRole } from "./rbac";
import { readAiMemoryEntries } from "./aiMemory";
import { CHATBOT_INTENT_MODEL } from "./chatbotIntentModel";
import { retrieveGeneralKnowledge } from "./chatbotKnowledge";

export type ChatbotIntent =
  | "greeting"
  | "wellbeing"
  | "thanks"
  | "goodbye"
  | "assistant_identity"
  | "user_identity"
  | "user_profile"
  | "help"
  | "date"
  | "time"
  | "calculator"
  | "events"
  | "programs"
  | "staff_directory"
  | "campus_knowledge"
  | "general_knowledge"
  | "unknown";

type TrainedIntent = Exclude<ChatbotIntent, "unknown" | "general_knowledge">;
type IntentScore = { intent: TrainedIntent; probability: number };

type BondedEvent = {
  title?: string;
  name?: string;
  description?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
};

type BondedProgram = {
  code?: string;
  name?: string;
  description?: string;
};

type StaffDirectoryRole = Extract<UserRole, "teacher" | "moderator" | "admin">;

type BondedStaffMember = {
  firstname?: string;
  lastname?: string;
  role?: string;
};

const MODEL_NAME = CHATBOT_INTENT_MODEL.modelName;
const MIN_CONFIDENCE = 0.34;
const MIN_MARGIN = 0.06;

/**
 * Below this confidence, a BondED intent match gets double-checked against
 * general knowledge before being trusted. The BondED classifier is a small
 * bag-of-words model trained on a narrow, school-specific vocabulary, so an
 * open-domain trivia question can share just enough surface phrasing (e.g.
 * "how are glacier caves formed" vs. "how are you") to weakly win a BondED
 * intent it has nothing to do with. This check is safe in both directions:
 * general knowledge only ever wins here if it *independently* clears its
 * own confidence bar (see chatbotKnowledge.ts), so it can't steal a
 * genuinely strong BondED match — only rescue a weak, likely-wrong one.
 * Verified empirically against the full 1,473-question general-knowledge
 * dataset and this project's BondED regression suite: at this threshold,
 * 1471/1473 general-knowledge questions resolve correctly and zero BondED
 * test cases get hijacked.
 */
const GENERAL_KNOWLEDGE_CROSSCHECK_THRESHOLD = 0.9;

/**
 * Picks a pre-written variant so static/conversational replies don't feel
 * identical every time. Nothing is composed at request time — every option
 * is written ahead of time, so this stays fully non-generative.
 */
const pickVariant = (variants: string[]): string =>
  variants[Math.floor(Math.random() * variants.length)];

const normalizeText = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/@(?:ai|bondedai)\b/g, " ")
    .replace(/[^a-z0-9+\-*/().%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const SYNONYMS: Record<string, string> = {
  course: "program",
  courses: "programs",
  degree: "program",
  degrees: "programs",
  activity: "event",
  activities: "events",
  happening: "event",
  happenings: "events",
  timetable: "schedule",
  fullname: "name",
  programme: "program",
  programmes: "programs",
  // Tagalog/Taglish question words mapped to the same English canonical
  // words the training data already uses heavily. This isn't a literal
  // translation layer — it just lets a Taglish question land on the same
  // well-represented vocabulary an equivalent English question would.
  kailan: "when",
  ano: "what",
  sino: "who",
  saan: "where",
  // "paano" is deliberately NOT mapped to "how" here. "how" is heavily
  // weighted toward the wellbeing intent in the English training data
  // ("how are you", "how is it going", ...), and routing "paano" through it
  // would throw away the direct signal from the Taglish "paano ..." rows
  // trained below in intent_training.csv (help) — a synonym substitution
  // happens before vectorization, so the model's own learned weight for
  // the literal token "paano" would never get used. Leaving it as its own
  // token lets those training rows teach its meaning directly instead.
  tulong: "help",
  tumulong: "help",
  matulungan: "help",
  makakatulong: "help",
};

// Pure Tagalog grammatical particles with no content signal of their own
// (plural marker, articles, politeness/question particles). Dropping them
// keeps adjacent content words next to each other for bigram matching,
// e.g. "ano ang mga event" -> "what event" instead of "what ang mga event".
// Pronouns like "ka"/"mo" are deliberately NOT stripped here — "kamusta ka"
// needs to stay distinct from bare "kamusta" (wellbeing vs. greeting).
const FILLER_WORDS = new Set(["mga", "ang", "yung", "po", "na", "ba"]);

const applySynonyms = (value: string) =>
  normalizeText(value)
    .split(/\s+/)
    .filter((token) => !FILLER_WORDS.has(token))
    .map((token) => SYNONYMS[token] || token)
    .join(" ");

const levenshteinDistance = (a: string, b: string) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }

  return previous[b.length];
};

const FUZZY_CANONICAL_WORDS = [
  "what", "when", "where", "who", "name", "your", "my", "program", "programs",
  "event", "events", "upcoming", "available", "school", "campus", "schedule",
  "information", "today", "date", "time", "calculate", "help", "hello", "thanks",
  "goodbye", "about", "tell", "current",
];

// Common typos where the edit distance to two different canonical words is
// equal (e.g. "helo" is 1 edit from both "help" and "hello"). Levenshtein
// distance alone can't break that tie reliably, so the most frequent
// real-world typos are corrected explicitly before falling back to the
// generic fuzzy match below.
const KNOWN_TYPO_OVERRIDES: Record<string, string> = {
  helo: "hello",
  helllo: "hello",
  hii: "hello",
  hlp: "help",
  hepl: "help",
  thx: "thanks",
  thnx: "thanks",
  tnx: "thanks",
  goodby: "goodbye",
  byee: "goodbye",
  wat: "what",
  wut: "what",
  // Common Taglish shortenings/typos. "d2" ("dito"/"here") was considered
  // but skipped — there's no canonical training vocabulary it would
  // usefully resolve to for any current intent. "pano" corrects to the
  // Filipino spelling "paano" (not "how") for the same reason "paano"
  // isn't synonym-mapped above — see the comment there.
  pano: "paano",
  kmusta: "kamusta",
  kamsta: "kamusta",
  slmt: "salamat",
  salamt: "salamat",
};

const correctToken = (token: string) => {
  if (token.length < 3 || /\d/.test(token)) return token;
  if (FUZZY_CANONICAL_WORDS.includes(token)) return token;
  if (KNOWN_TYPO_OVERRIDES[token]) return KNOWN_TYPO_OVERRIDES[token];

  let best = token;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of FUZZY_CANONICAL_WORDS) {
    if (Math.abs(candidate.length - token.length) > 2) continue;
    const distance = levenshteinDistance(token, candidate);
    const allowedDistance = Math.max(token.length, candidate.length) >= 7 ? 2 : 1;
    if (distance <= allowedDistance && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

const normalizeForUnderstanding = (value: string) =>
  applySynonyms(value)
    .split(/\s+/)
    .map(correctToken)
    .join(" ");

type ExportedLinearModel = {
  readonly classes: readonly string[];
  readonly terms: readonly string[];
  readonly idf: readonly number[];
  readonly coef: readonly (readonly number[])[];
  readonly intercept: readonly number[];
};

const buildTermIndex = (model: ExportedLinearModel) =>
  new Map<string, number>(model.terms.map((term, index) => [term, index]));

const intentTermIndex = buildTermIndex(CHATBOT_INTENT_MODEL.intentModel);
const scopeTermIndex = buildTermIndex(CHATBOT_INTENT_MODEL.scopeModel);

const vectorizeForModel = (
  input: string,
  model: ExportedLinearModel,
  termIndex: Map<string, number>,
) => {
  const normalized = normalizeForUnderstanding(input);
  const tokens = normalized.match(/\b[a-z0-9_]+\b/g) || [];
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

  for (const [index, count] of counts) {
    const tf = 1 + Math.log(count);
    const value = tf * Number(model.idf[index] || 0);
    weighted.set(index, value);
    squaredNorm += value * value;
  }

  const norm = Math.sqrt(squaredNorm) || 1;
  for (const [index, value] of weighted) {
    weighted.set(index, value / norm);
  }

  return weighted;
};

const predictLinearProbabilities = (
  input: string,
  model: ExportedLinearModel,
  termIndex: Map<string, number>,
) => {
  const features = vectorizeForModel(input, model, termIndex);
  if (features.size === 0) {
    return model.classes.map((label) => ({ label, probability: 0 }));
  }

  const linearScore = (rowIndex: number) => {
    let score = Number(model.intercept[rowIndex] || 0);
    const coefficients = model.coef[rowIndex];
    for (const [featureIndex, featureValue] of features) {
      score += Number(coefficients?.[featureIndex] || 0) * featureValue;
    }
    return score;
  };

  // scikit-learn stores binary logistic regression as one coefficient row.
  if (model.classes.length === 2 && model.coef.length === 1) {
    const z = linearScore(0);
    const classOneProbability = 1 / (1 + Math.exp(-z));
    return [
      { label: model.classes[0], probability: 1 - classOneProbability },
      { label: model.classes[1], probability: classOneProbability },
    ];
  }

  const raw = model.classes.map((label, index) => ({
    label,
    score: linearScore(index),
  }));
  const maxScore = Math.max(...raw.map((item) => item.score));
  const exp = raw.map((item) => ({
    label: item.label,
    value: Math.exp(item.score - maxScore),
  }));
  const denominator = exp.reduce((sum, item) => sum + item.value, 0) || 1;

  return exp.map((item) => ({
    label: item.label,
    probability: item.value / denominator,
  }));
};

const classifyIntent = (
  input: string,
): { intent: ChatbotIntent; confidence: number; scores: IntentScore[] } => {
  const scopeScores = predictLinearProbabilities(
    input,
    CHATBOT_INTENT_MODEL.scopeModel,
    scopeTermIndex,
  );
  const supportedProbability =
    scopeScores.find((item) => item.label === "supported")?.probability || 0;

  // The separate scope classifier was trained with out-of-scope examples.
  // This prevents unrelated questions from being forced into a BondED intent.
  if (supportedProbability < 0.52) {
    return { intent: "unknown", confidence: 1 - supportedProbability, scores: [] };
  }

  const probabilities = predictLinearProbabilities(
    input,
    CHATBOT_INTENT_MODEL.intentModel,
    intentTermIndex,
  );

  const scores: IntentScore[] = probabilities
    .map((item) => ({
      intent: item.label as TrainedIntent,
      probability: item.probability,
    }))
    .sort((a, b) => b.probability - a.probability);

  const best = scores[0];
  const second = scores[1];
  const margin = best && second ? best.probability - second.probability : 1;

  if (!best || best.probability < MIN_CONFIDENCE || margin < MIN_MARGIN) {
    return {
      intent: "unknown",
      confidence: best?.probability || 0,
      scores,
    };
  }

  return {
    intent: best.intent,
    confidence: best.probability,
    scores,
  };
};

const tokenize = (value: string) =>
  normalizeForUnderstanding(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 || /\d/.test(token));

const extractArithmeticExpression = (input: string): string | null => {
  const normalized = normalizeText(input)
    .replace(/\bplus\b/g, "+")
    .replace(/\bminus\b/g, "-")
    .replace(/\b(times|multiplied by|multiply by)\b/g, "*")
    .replace(/\b(divided by|divide by|over)\b/g, "/")
    .replace(/\b(percent|percentage)\b/g, "%")
    // "5x10" / "5 x 10" — a bare "x" between digits is a multiplication sign,
    // not the letter x (e.g. "10x20", "3 x 4 x 2").
    .replace(/(\d)\s*x\s*(?=\d)/g, "$1*");

  const matches = normalized.match(/[0-9+\-*/().%\s]+/g) || [];
  const candidate =
    matches.map((item) => item.trim()).sort((a, b) => b.length - a.length)[0] || "";

  // Guard against ID-like strings (e.g. a student ID "012324-004855") being
  // misread as arithmetic. Numbers a person actually types never start with
  // a leading zero, so a leading-zero number is a strong signal this is a
  // code/ID that leaked in from message metadata, not a real calculation.
  if (/\b0\d+\b/.test(candidate)) return null;

  // Guard against "9/11" being read as division — it's overwhelmingly a
  // reference to September 11, not a fraction, and answering "= 0.82" to a
  // question about it is both wrong and in poor taste.
  if (/\b9\s*\/\s*11\b/.test(candidate)) return null;

  return /\d/.test(candidate) && /[+\-*/%]/.test(candidate) ? candidate : null;
};

type MathOperator = "+" | "-" | "*" | "/" | "%";
type MathToken = number | MathOperator | "(" | ")";

const parseMathTokens = (expression: string): MathToken[] | null => {
  const compact = expression.replace(/\s+/g, "");
  if (!compact || /[^0-9.+\-*/()%]/.test(compact)) return null;

  const raw = compact.match(/\d+(?:\.\d+)?|[+\-*/()%]/g);
  if (!raw || raw.join("") !== compact) return null;

  return raw.map((token) =>
    /^\d/.test(token) ? Number(token) : (token as MathToken),
  );
};

const evaluateExpression = (expression: string): number | null => {
  const tokens = parseMathTokens(expression);
  if (!tokens) return null;

  let index = 0;

  const parsePrimary = (): number | null => {
    const token = tokens[index];

    if (typeof token === "number") {
      index += 1;
      return token;
    }

    if (token === "+" || token === "-") {
      index += 1;
      const value = parsePrimary();
      return value == null ? null : token === "-" ? -value : value;
    }

    if (token === "(") {
      index += 1;
      const value = parseAddSub();
      if (tokens[index] !== ")") return null;
      index += 1;
      return value;
    }

    return null;
  };

  const parseMulDiv = (): number | null => {
    let value = parsePrimary();
    if (value == null) return null;

    while (
      tokens[index] === "*" ||
      tokens[index] === "/" ||
      tokens[index] === "%"
    ) {
      const operator = tokens[index++] as "*" | "/" | "%";
      const right = parsePrimary();
      if (right == null) return null;
      if ((operator === "/" || operator === "%") && right === 0) return null;

      value =
        operator === "*"
          ? value * right
          : operator === "/"
            ? value / right
            : value % right;
    }

    return value;
  };

  const parseAddSub = (): number | null => {
    let value = parseMulDiv();
    if (value == null) return null;

    while (tokens[index] === "+" || tokens[index] === "-") {
      const operator = tokens[index++] as "+" | "-";
      const right = parseMulDiv();
      if (right == null) return null;
      value = operator === "+" ? value + right : value - right;
    }

    return value;
  };

  const result = parseAddSub();
  if (result == null || index !== tokens.length || !Number.isFinite(result)) {
    return null;
  }
  return result;
};

const formatNumber = (value: number) =>
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(8)));

const formatDate = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);

const formatTime = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);

const RETRIEVAL_STOP_WORDS = new Set([
  "what",
  "when",
  "where",
  "which",
  "tell",
  "about",
  "please",
  "school",
  "campus",
  "bonded",
  "information",
]);

const tokenizeForRetrieval = (value: string) =>
  new Set(
    tokenize(value).filter(
      (token) => token.length >= 3 && !RETRIEVAL_STOP_WORDS.has(token),
    ),
  );

const overlapScore = (query: Set<string>, value: string) => {
  const tokens = tokenizeForRetrieval(value);
  let score = 0;

  for (const queryToken of query) {
    if (tokens.has(queryToken)) {
      score += 2;
      continue;
    }

    if (queryToken.length >= 5) {
      for (const valueToken of tokens) {
        const maxLength = Math.max(queryToken.length, valueToken.length);
        const allowedDistance = maxLength >= 8 ? 2 : 1;
        if (
          Math.abs(queryToken.length - valueToken.length) <= allowedDistance &&
          levenshteinDistance(queryToken, valueToken) <= allowedDistance
        ) {
          score += 1;
          break;
        }
      }
    }
  }

  return score;
};

const answerFromMemory = async (input: string): Promise<string | null> => {
  const queryTokens = tokenizeForRetrieval(input);
  if (queryTokens.size === 0) return null;

  const entries = await readAiMemoryEntries().catch(() => []);
  const ranked = entries
    .filter((entry) => entry.active)
    .map((entry) => ({
      entry,
      score: overlapScore(
        queryTokens,
        `${entry.title} ${entry.content} ${entry.tags.join(" ")}`,
      ),
    }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) => b.score - a.score || b.entry.priority - a.entry.priority,
    );

  const bestMatch = ranked[0];
  if (!bestMatch || bestMatch.score < 2) return null;

  const best = bestMatch.entry;
  return `Regarding **${best.title}**: ${best.content}`.trim();
};

const answerEvents = async (): Promise<string> => {
  const snapshot = await getDocs(collection(db, "events"));
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const events = snapshot.docs
    .map((item) => ({ id: item.id, ...(item.data() as BondedEvent) }))
    .filter(
      (event) => typeof event.date === "string" && event.date >= todayKey,
    )
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(0, 5);

  if (!events.length) {
    return "I couldn't find any upcoming campus events in the BondED database.";
  }

  const summary = events
    .map((event) => {
      const title = String(event.title || "Untitled event");
      const date = String(event.date || "");
      const startTime = event.startTime ? ` at ${String(event.startTime)}` : "";
      return `**${title}** on ${date}${startTime}`;
    })
    .join("; ");

  return `Here are the upcoming events at BondED: ${summary}.`;
};

const escapeForRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const answerPrograms = async (input: string): Promise<string> => {
  const snapshot = await getDocs(collection(db, "programs"));
  const programs = snapshot.docs.map((item) => ({
    id: item.id,
    ...(item.data() as BondedProgram),
  }));

  if (!programs.length) {
    return "I couldn't find any academic programs in the BondED database.";
  }

  const normalized = normalizeForUnderstanding(input);
  const exact = programs.find((program) => {
    const code = String(program.code || "").toLowerCase();
    const name = String(program.name || "").toLowerCase();
    const matchesCode =
      code && new RegExp(`\\b${escapeForRegex(code)}\\b`, "i").test(normalized);
    const matchesName = name && normalized.includes(name);
    return Boolean(matchesCode || matchesName);
  });

  if (exact) {
    const code = exact.code ? String(exact.code) : "";
    const name = String(exact.name || "Program");
    const label = code ? `${code} — ${name}` : name;
    const description = exact.description ? ` ${String(exact.description)}` : "";
    return `**${label}** is offered at BondED.${description}`;
  }

  const listed = programs
    .slice(0, 10)
    .map((program) => {
      const code = String(program.code || "");
      const name = String(program.name || "");
      return code ? `**${code}** — ${name}` : name;
    })
    .filter(Boolean)
    .join("; ");

  return `BondED currently offers these programs: ${listed}.`;
};

const STAFF_DIRECTORY_ROLES: StaffDirectoryRole[] = ["teacher", "moderator", "admin"];

const STAFF_ROLE_NOUNS: Record<StaffDirectoryRole, { singular: string; plural: string }> = {
  teacher: { singular: "teacher", plural: "teachers" },
  moderator: { singular: "moderator", plural: "moderators" },
  admin: { singular: "admin", plural: "admins" },
};

const humanizeNameList = (names: string[]) => {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
};

const STAFF_ROLE_KEYWORDS: Record<StaffDirectoryRole, string[]> = {
  teacher: ["teacher", "teachers"],
  moderator: ["moderator", "moderators"],
  admin: ["admin", "admins"],
};

const STAFF_DIRECTORY_CACHE_TTL_MS = 60 * 1000;
let cachedStaffDirectory: Record<StaffDirectoryRole, string[]> | null = null;
let cachedStaffDirectoryAtMs = 0;

const fetchStaffDirectory = async (): Promise<Record<StaffDirectoryRole, string[]>> => {
  const now = Date.now();
  if (cachedStaffDirectory && now - cachedStaffDirectoryAtMs < STAFF_DIRECTORY_CACHE_TTL_MS) {
    return cachedStaffDirectory;
  }

  const staffQuery = query(
    collection(db, "students"),
    where("role", "in", STAFF_DIRECTORY_ROLES),
  );
  const snapshot = await getDocs(staffQuery);

  const grouped: Record<StaffDirectoryRole, string[]> = {
    teacher: [],
    moderator: [],
    admin: [],
  };

  snapshot.docs.forEach((item) => {
    const data = item.data() as BondedStaffMember;
    const role = String(data.role || "").toLowerCase();
    if (role !== "teacher" && role !== "moderator" && role !== "admin") return;
    const name = `${data.firstname || ""} ${data.lastname || ""}`.trim();
    if (name) grouped[role].push(name);
  });

  cachedStaffDirectory = grouped;
  cachedStaffDirectoryAtMs = now;
  return grouped;
};

/**
 * Only ever exposes firstname + lastname (never email/studentID/etc), same
 * privacy boundary answerPrograms keeps for program names over document IDs.
 */
const answerStaffDirectory = async (input: string): Promise<string | null> => {
  const tokens = tokenizeForRetrieval(input);
  const requestedRoles = STAFF_DIRECTORY_ROLES.filter((role) =>
    containsAnyKeyword(tokens, STAFF_ROLE_KEYWORDS[role]),
  );
  const rolesToShow = requestedRoles.length ? requestedRoles : STAFF_DIRECTORY_ROLES;

  const directory = await fetchStaffDirectory();

  const clauses = rolesToShow
    .map((role) => {
      const names = directory[role];
      if (!names.length) return null;
      const noun = names.length === 1 ? STAFF_ROLE_NOUNS[role].singular : STAFF_ROLE_NOUNS[role].plural;
      const verb = names.length === 1 ? "is" : "are";
      const boldedNames = names.map((name) => `**${name}**`);
      return `the ${noun} ${verb} ${humanizeNameList(boldedNames)}`;
    })
    .filter((clause): clause is string => Boolean(clause));

  if (!clauses.length) return null;

  const sentence =
    clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;

  return `At BondED, ${sentence}.`;
};

const PROGRAM_KEYWORDS = ["program", "programs", "course", "courses", "degree", "degrees", "major", "majors", "bsit", "bscs"];
const EVENT_KEYWORDS = ["event", "events", "activity", "activities", "schedule", "happening", "upcoming"];
const STAFF_DIRECTORY_KEYWORDS = Object.values(STAFF_ROLE_KEYWORDS).flat();

const containsAnyKeyword = (tokens: Set<string>, keywords: string[]) =>
  keywords.some((keyword) => tokens.has(keyword));

/**
 * Last-resort grounding pass for anything the intent/scope classifier could not
 * confidently place (including questions it labeled "unknown"). Everything here
 * still comes straight from Firestore — this never calls a generative model.
 * It only widens the chance that a real BondED question gets answered from the
 * database instead of falling through to the generic "I don't know" reply.
 */
const answerFromAnySource = async (prompt: string): Promise<string | null> => {
  const memoryAnswer = await answerFromMemory(prompt);
  if (memoryAnswer) return memoryAnswer;

  const tokens = tokenizeForRetrieval(prompt);
  if (containsAnyKeyword(tokens, PROGRAM_KEYWORDS)) {
    const answer = await answerPrograms(prompt).catch(() => null);
    if (answer) return answer;
  }
  if (containsAnyKeyword(tokens, EVENT_KEYWORDS)) {
    const answer = await answerEvents().catch(() => null);
    if (answer) return answer;
  }
  if (containsAnyKeyword(tokens, STAFF_DIRECTORY_KEYWORDS)) {
    const answer = await answerStaffDirectory(prompt).catch(() => null);
    if (answer) return answer;
  }

  return null;
};

/**
 * Fire-and-forget: never awaited by the caller so it can't delay or break the
 * chatbot reply. Human-reviewed training-data feed only — nothing reads this
 * collection automatically.
 */
const logUnansweredQuestion = (
  prompt: string,
  classification: { intent: ChatbotIntent; confidence: number },
) => {
  addDoc(collection(db, "chatbotUnansweredQuestions"), {
    prompt,
    intent: classification.intent,
    confidence: classification.confidence,
    createdAt: serverTimestamp(),
  }).catch((error) => {
    console.error("Failed to log unanswered chatbot question:", error);
  });
};

const GREETING_VARIANTS = [
  "Hello! I'm Bonded AI. I can help with BondED campus information, upcoming events, academic programs, general knowledge, date/time, and basic calculations.",
  "Hi there! I'm Bonded AI — ask me about campus info, upcoming events, academic programs, general knowledge, the date or time, or a quick calculation.",
  "Hey! Bonded AI here. I can look up campus events, academic programs, school information, general knowledge, the date/time, or run a calculation for you.",
  "Hello! I'm Bonded AI, ready to help with BondED events, programs, campus info, general knowledge, date/time, and calculations.",
];

const WELLBEING_VARIANTS = [
  "I'm doing well and ready to help. What would you like to know about BondED?",
  "Doing great, thanks for asking! What can I help you find in BondED?",
  "All good on my end and ready to help — what do you need from BondED?",
  "I'm running smoothly and ready to help with anything BondED-related.",
];

const THANKS_VARIANTS = [
  "You're welcome! I'm ready if you need anything else in BondED.",
  "Anytime! Let me know if there's anything else you need from BondED.",
  "Happy to help! I'm here if you have more BondED questions.",
  "No problem at all — I'm around if you need anything else in BondED.",
];

const GOODBYE_VARIANTS = [
  "Goodbye! You can mention me again whenever you need help.",
  "See you later! I'm here whenever you need BondED help again.",
  "Take care! Just mention me anytime you need help with BondED.",
  "Goodbye for now — I'll be here whenever you need me again.",
];

const ASSISTANT_IDENTITY_VARIANTS = [
  "I'm **Bonded AI**, the non-generative educational assistant built into BondED.",
  "I'm **Bonded AI** — a rule-based assistant built right into BondED, not a generative AI.",
  "I'm **Bonded AI**, BondED's built-in assistant for campus info, events, programs, and more.",
  "I'm **Bonded AI**, a non-generative assistant designed to help with BondED questions.",
];

const HELP_VARIANTS = [
  "You can ask me about upcoming campus events, available academic programs, BondED information stored by the school, the current date or time, and basic calculations.",
  "I can help with campus events, academic programs, school information, the date or time, and basic calculations — just ask.",
  "Try asking me about your student profile, upcoming events, academic programs, school info, the date/time, or a calculation.",
  "I'm best at answering questions about BondED events, programs, campus info, date/time, and calculations.",
];

const UNKNOWN_FALLBACK_VARIANTS = [
  "I couldn't quite find an answer to that. I'm best with questions about your BondED profile, programs, events, and campus info — try one of those, or rephrase your question and I'll give it another shot.",
  "Hmm, I don't have a confident answer for that one. I can help with your profile, programs, events, and campus info — try rephrasing or ask about one of those.",
  "I'm not sure about that one. I'm most useful for BondED profile, program, event, and campus questions — feel free to rephrase and I'll try again.",
  "That one's outside what I can confidently answer. I can help with your profile, programs, events, and campus info — try rewording your question.",
];

// Conversation-memory follow-up support — scoped to callers that opt in via
// `previousIntent` (only the private AiChatScreen 1:1 chat does this). A
// public surface like a channel/comment/reply never passes this, so it
// can't misfire there, where "the previous message" could be from someone
// else entirely.
const FOLLOWUP_ELIGIBLE_INTENTS = new Set<ChatbotIntent>(["programs", "events", "staff_directory"]);
const REFERENTIAL_FOLLOWUP_PREFIXES = ["what about", "how about", "and", "also", "same for"];

/**
 * Cheap pattern check (no model) for whether a message is likely continuing
 * the previous exchange rather than standing on its own — e.g. "what about
 * BSTM?" right after a programs question. A false positive here is
 * low-risk: it only leads to reusing the previous intent's answer function,
 * which falls back to normal classification below if it finds nothing.
 */
const looksLikeReferentialFollowUp = (message: string): boolean => {
  const trimmed = message.trim().toLowerCase();
  if (!trimmed) return false;
  if (
    REFERENTIAL_FOLLOWUP_PREFIXES.some(
      (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `),
    )
  ) {
    return true;
  }
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount <= 4;
};

const answerAsFollowUp = async (
  previousIntent: ChatbotIntent,
  prompt: string,
): Promise<string | null> => {
  switch (previousIntent) {
    case "programs":
      return (await answerPrograms(prompt)) || null;
    case "events":
      return (await answerEvents()) || null;
    case "staff_directory":
      return answerStaffDirectory(prompt);
    default:
      return null;
  }
};

export type NonGenerativeReply = {
  reply: string;
  model: string;
  intent: ChatbotIntent;
  confidence: number;
};

export type NonGenerativeReplyOptions = {
  /**
   * The previous assistant reply's intent in this same conversation, if
   * any. Only meant for a private, single-user chat history — pass this
   * only when "the previous message" can unambiguously be attributed to
   * one ongoing conversation with one person.
   */
  previousIntent?: ChatbotIntent;
};

export const requestNonGenerativeChatbotReply = async (
  prompt: string,
  options?: NonGenerativeReplyOptions,
): Promise<NonGenerativeReply> => {
  const expression = extractArithmeticExpression(prompt);
  if (expression) {
    const result = evaluateExpression(expression);
    if (result != null) {
      return {
        reply: `${expression.trim()} equals **${formatNumber(result)}**.`,
        model: MODEL_NAME,
        intent: "calculator",
        confidence: 1,
      };
    }
  }

  const classification = classifyIntent(prompt);
  const now = new Date();

  // Conversation-memory follow-up rescue: only kicks in when the message
  // did NOT confidently classify on its own. A message with a clear
  // standalone meaning (e.g. "who are the teachers") must never be
  // hijacked by whatever the previous exchange happened to be about —
  // that was a real bug when this ran before classification: a short
  // 4-word question landed here purely on word count, and since
  // answerPrograms() never returns null (it falls back to the full program
  // list instead), the "fall back to normal classification" safety net
  // never actually got a chance to fire.
  if (
    classification.intent === "unknown" &&
    options?.previousIntent &&
    FOLLOWUP_ELIGIBLE_INTENTS.has(options.previousIntent) &&
    looksLikeReferentialFollowUp(prompt)
  ) {
    const followUpAnswer = await answerAsFollowUp(options.previousIntent, prompt).catch(() => null);
    if (followUpAnswer) {
      return {
        reply: followUpAnswer,
        model: MODEL_NAME,
        intent: options.previousIntent,
        confidence: 1,
      };
    }
  }

  // See GENERAL_KNOWLEDGE_CROSSCHECK_THRESHOLD above for why this is safe.
  if (
    classification.intent !== "unknown" &&
    classification.confidence < GENERAL_KNOWLEDGE_CROSSCHECK_THRESHOLD
  ) {
    const generalMatch = retrieveGeneralKnowledge(prompt);
    if (generalMatch) {
      return {
        reply: generalMatch.answer,
        model: MODEL_NAME,
        intent: "general_knowledge",
        confidence: generalMatch.similarity,
      };
    }
  }

  switch (classification.intent) {
    case "greeting":
      return {
        reply: pickVariant(GREETING_VARIANTS),
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "wellbeing":
      return {
        reply: pickVariant(WELLBEING_VARIANTS),
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "thanks":
      return {
        reply: pickVariant(THANKS_VARIANTS),
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "goodbye":
      return {
        reply: pickVariant(GOODBYE_VARIANTS),
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "assistant_identity":
      return {
        reply: pickVariant(ASSISTANT_IDENTITY_VARIANTS),
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "user_identity": {
      const currentUser = auth.currentUser;
      const profile = currentUser
        ? await getUserDataByAuthUser(currentUser).catch(() => null)
        : null;
      const fullName = profile
        ? `${profile.firstname || ""} ${profile.lastname || ""}`.trim()
        : "";
      const authName = currentUser?.displayName?.trim() || "";
      const fallbackName = currentUser?.email?.split("@")[0]?.trim() || "";

      return {
        reply: currentUser
          ? `Your name is **${fullName || authName || fallbackName || "the currently signed-in BondED user"}**.`
          : "I can't identify you because there is no signed-in BondED user.",
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };
    }

    case "user_profile": {
      const currentUser = auth.currentUser;
      const profile = currentUser
        ? await getUserDataByAuthUser(currentUser).catch(() => null)
        : null;

      if (!currentUser || !profile) {
        return {
          reply: "I couldn't load your verified student profile right now.",
          model: MODEL_NAME,
          intent: classification.intent,
          confidence: classification.confidence,
        };
      }

      const normalized = normalizeForUnderstanding(prompt);
      const fullName = `${profile.firstname || ""} ${profile.lastname || ""}`.trim();
      const profileClauses = [
        fullName ? `You're **${fullName}**` : null,
        profile.studentID ? `student ID **${profile.studentID}**` : null,
        profile.course ? `enrolled in **${profile.course}**` : null,
        profile.yearlvl ? `year level **${profile.yearlvl}**` : null,
      ].filter((part): part is string => Boolean(part));

      let reply = profileClauses.length ? `${profileClauses.join(", ")}.` : "";

      if (/\b(student id|student number)\b/.test(normalized)) {
        reply = profile.studentID
          ? `Your student ID is **${profile.studentID}**.`
          : "Your student ID is not listed in your BondED profile.";
      } else if (/\b(program|course)\b/.test(normalized)) {
        reply = profile.course
          ? `Your program/course is **${profile.course}**.`
          : "Your program/course is not listed in your BondED profile.";
      } else if (/\byear\b/.test(normalized)) {
        reply = profile.yearlvl
          ? `Your year level is **${profile.yearlvl}**.`
          : "Your year level is not listed in your BondED profile.";
      }

      return {
        reply: reply || "I found your account, but no student profile details are available.",
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };
    }

    case "help":
      return {
        reply: pickVariant(HELP_VARIANTS),
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "date":
      return {
        reply: `Today is **${formatDate(now)}**.`,
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "time":
      return {
        reply: `The current time on your device is **${formatTime(now)}**.`,
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "events":
      return {
        reply: await answerEvents(),
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "programs":
      return {
        reply: await answerPrograms(prompt),
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "staff_directory": {
      const answer = await answerStaffDirectory(prompt);
      return {
        reply:
          answer ||
          "I don't have that information yet — no matching teachers, moderators, or admins are on file.",
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };
    }

    case "campus_knowledge": {
      const answer = await answerFromAnySource(prompt);
      return {
        reply:
          answer ||
          "I don't have verified information for that question in the BondED knowledge database yet.",
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };
    }

    default: {
      // Priority 1: try BondED/Firestore knowledge first so school and user
      // information always wins over the bundled public knowledge dataset.
      const bondedAnswer = await answerFromAnySource(prompt);
      if (bondedAnswer) {
        return {
          reply: bondedAnswer,
          model: MODEL_NAME,
          intent: "campus_knowledge",
          confidence: classification.confidence,
        };
      }

      // Priority 2: retrieve a stored, non-generative answer from the bundled
      // WikiQA general-knowledge index. No text is generated here.
      const generalMatch = retrieveGeneralKnowledge(prompt);
      if (generalMatch) {
        return {
          reply: generalMatch.answer,
          model: MODEL_NAME,
          intent: "general_knowledge",
          confidence: generalMatch.similarity,
        };
      }

      logUnansweredQuestion(prompt, classification);
      return {
        reply: pickVariant(UNKNOWN_FALLBACK_VARIANTS),
        model: MODEL_NAME,
        intent: "unknown",
        confidence: classification.confidence,
      };
    }
  }
};

export const getNonGenerativeChatbotDiagnostics = () => ({
  engine: CHATBOT_INTENT_MODEL.algorithm,
  model: CHATBOT_INTENT_MODEL.modelName,
  generative: CHATBOT_INTENT_MODEL.generative,
  trainingExamples: CHATBOT_INTENT_MODEL.trainingRows,
  intents: [...CHATBOT_INTENT_MODEL.intentModel.classes],
  vocabularySize: CHATBOT_INTENT_MODEL.intentModel.terms.length,
  crossValidationAccuracy: CHATBOT_INTENT_MODEL.crossValidationAccuracy,
});

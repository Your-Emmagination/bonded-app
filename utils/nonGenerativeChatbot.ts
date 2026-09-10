import { addDoc, collection, getDocs, query, serverTimestamp, where } from "firebase/firestore";
import { auth, db } from "../Firebase_configure";
import { readAiMemoryEntries } from "./aiMemory";
import { retrieveCampusKnowledge, type CampusFaqEntry } from "./campusKnowledge";
import { CHATBOT_INTENT_MODEL } from "./chatbotIntentModel";
import {
    hasGeneralKnowledgeTrigger,
    lookupGeneralKnowledge,
} from "./generalKnowledgeApi";
import {
    getCachedGeneralAnswer,
    normalizeGeneralKnowledgeKey,
    putCachedGeneralAnswer,
    touchCachedGeneralAnswer,
} from "./knowledgeCache";
import { LOST_FOUND_FIRST_PERSON_PATTERN } from "./lostAndFoundDetection";
import { getUserDataByAuthUser, isStaff, resolveUserRoleForAuthUser, type UserRole } from "./rbac";
import { routeChatbotSource } from "./sourceRouter";

export type ChatbotIntent =
  | "greeting"
  | "wellbeing"
  | "thanks"
  | "goodbye"
  | "joke"
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
  | "directory"
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

// Part 2 (directory): only ever firstname/lastname/course/yearlvl/role are
// read — never email, studentID, phone, or address.
type BondedStudentRecord = {
  firstname?: string;
  lastname?: string;
  course?: string;
  yearlvl?: string;
  role?: string;
};

const MODEL_NAME = CHATBOT_INTENT_MODEL.modelName;
const MIN_CONFIDENCE = 0.34;
const MIN_MARGIN = 0.06;

/**
 * Picks a pre-written variant so static/conversational replies don't feel
 * identical every time. Nothing is composed at request time — every option
 * is written ahead of time, so this stays fully non-generative.
 */
const pickVariant = (variants: string[]): string =>
  variants[Math.floor(Math.random() * variants.length)];

// Same idea as pickVariant, for templates that need one or more values
// interpolated into the chosen phrasing (e.g. a name or a computed result)
// rather than a plain fixed string.
const pickTemplate = <T,>(templates: readonly T[]): T =>
  templates[Math.floor(Math.random() * templates.length)];

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

const EVENTS_INTRO_VARIANTS = [
  "Here are the upcoming events at BondED",
  "Coming up at BondED",
  "These are the upcoming BondED events",
  "Here's what's on the BondED events calendar",
];

// event.date is stored as a plain "YYYY-MM-DD" calendar string (see
// CreateEventScreen.tsx), never a timestamp — parsed as calendar
// year/month/day (not `new Date(dateKey)`, which reads an ISO date-only
// string as UTC midnight and can print as the wrong day in timezones behind
// UTC) and rendered as "September 4, 2026" per request, no weekday.
const formatEventDate = (dateKey: string): string => {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return dateKey;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(year, month - 1, day));
};

// event.startTime is stored as a plain 24-hour "HH:mm" string. Rendered as
// 12-hour with a lowercase am/pm, minutes only shown when non-zero, e.g.
// "15:00" -> "3 pm", "15:30" -> "3:30 pm".
const formatEventTime = (time: string): string => {
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return time;
  const hour24 = Number(match[1]);
  const minute = Number(match[2]);
  if (Number.isNaN(hour24) || Number.isNaN(minute)) return time;
  const period = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 || 12;
  const minuteText = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;
  return `${hour12}${minuteText} ${period}`;
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
      const date = formatEventDate(String(event.date || ""));
      const startTime = event.startTime
        ? ` at ${formatEventTime(String(event.startTime))}`
        : "";
      return `**${title}** on ${date}${startTime}`;
    })
    .join("; ");

  return `${pickVariant(EVENTS_INTRO_VARIANTS)}: ${summary}.`;
};

const escapeForRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PROGRAM_EXACT_MATCH_TEMPLATES: Array<(label: string) => string> = [
  (label) => `**${label}** is offered at BondED.`,
  (label) => `Yes — **${label}** is one of BondED's programs.`,
  (label) => `**${label}** — that's one of the programs BondED offers.`,
  (label) => `BondED does offer **${label}**.`,
];

const PROGRAMS_LIST_INTRO_VARIANTS = [
  "BondED currently offers these programs",
  "Here are the programs available at BondED",
  "These are BondED's academic programs",
  "BondED's current program lineup includes",
];

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
    return `${pickTemplate(PROGRAM_EXACT_MATCH_TEMPLATES)(label)}${description}`;
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

  return `${pickVariant(PROGRAMS_LIST_INTRO_VARIANTS)}: ${listed}.`;
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

const STAFF_DIRECTORY_INTRO_VARIANTS = ["At BondED", "Here at BondED", "In BondED's staff directory"];

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

  return `${pickVariant(STAFF_DIRECTORY_INTRO_VARIANTS)}, ${sentence}.`;
};

const PROGRAM_KEYWORDS = ["program", "programs", "course", "courses", "degree", "degrees", "major", "majors", "bsit", "bscs"];
const EVENT_KEYWORDS = ["event", "events", "activity", "activities", "schedule", "happening", "upcoming"];
const STAFF_DIRECTORY_KEYWORDS = Object.values(STAFF_ROLE_KEYWORDS).flat();

const containsAnyKeyword = (tokens: Set<string>, keywords: string[]) =>
  keywords.some((keyword) => tokens.has(keyword));

type BondedPost = {
  content?: string;
  flair?: string;
  moderationStatus?: string;
  createdAt?: { toMillis?: () => number } | null;
  resolvedAt?: unknown;
};

type FlairPost = { content: string; createdAtMs: number; resolved: boolean };

/**
 * Shared read for both answerFromAnnouncements and answerLostAndFound — a
 * single equality filter (flair) only, matching the rest of this file's
 * Firestore access (answerPrograms/answerEvents/fetchStaffDirectory all read
 * a whole collection or filter on one field, never a compound query), so no
 * composite index is needed. Approval, recency, and resolution are all
 * filtered client-side by the caller.
 */
const fetchApprovedPostsByFlair = async (flair: string): Promise<FlairPost[]> => {
  const flairQuery = query(collection(db, "posts"), where("flair", "==", flair));
  const snapshot = await getDocs(flairQuery);

  return snapshot.docs
    .map((item) => item.data() as BondedPost)
    .filter(
      (post) =>
        post.moderationStatus === "approved" &&
        typeof post.content === "string" &&
        post.content.trim().length > 0,
    )
    .map((post) => ({
      content: post.content!.trim(),
      createdAtMs:
        typeof post.createdAt?.toMillis === "function" ? post.createdAt.toMillis() : 0,
      resolved: post.resolvedAt != null,
    }));
};

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Part 1: Announcement posts as a knowledge source ──────────────────────

const ANNOUNCEMENTS_CACHE_TTL_MS = 60 * 1000;
const ANNOUNCEMENTS_WINDOW_DAYS = 90;
let cachedAnnouncementPosts: FlairPost[] | null = null;
let cachedAnnouncementPostsAtMs = 0;

const ANNOUNCEMENT_INTRO_VARIANTS = [
  "According to a recent announcement",
  "There's a recent BondED announcement about this",
  "A recent announcement covers this",
  "Here's what a recent announcement says",
];

/**
 * Last-resort grounding pass over staff-authored announcement posts, same
 * shape as answerFromMemory(): unconditional token-overlap scoring against
 * everything in the cache, no keyword pre-filter. Staff-authored content is
 * returned unedited — only the intro sentence around it is templated.
 */
const answerFromAnnouncements = async (input: string): Promise<string | null> => {
  const queryTokens = tokenizeForRetrieval(input);
  if (queryTokens.size === 0) return null;

  const now = Date.now();
  if (!cachedAnnouncementPosts || now - cachedAnnouncementPostsAtMs >= ANNOUNCEMENTS_CACHE_TTL_MS) {
    cachedAnnouncementPosts = await fetchApprovedPostsByFlair("announcement").catch(() => []);
    cachedAnnouncementPostsAtMs = now;
  }

  const cutoffMs = now - ANNOUNCEMENTS_WINDOW_DAYS * DAY_MS;
  const withinWindow = cachedAnnouncementPosts.filter((post) => post.createdAtMs >= cutoffMs);

  const ranked = withinWindow
    .map((post) => ({ post, score: overlapScore(queryTokens, post.content) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  // Same minimum match threshold as answerFromMemory.
  const best = ranked[0];
  if (!best || best.score < 2) return null;

  return `${pickVariant(ANNOUNCEMENT_INTRO_VARIANTS)}: ${best.post.content}`;
};

// ─── Part 3: Lost & Found search + nudge ────────────────────────────────────

const LOST_AND_FOUND_CACHE_TTL_MS = 60 * 1000;
// Shorter than announcements' 90-day window — lost items go stale faster;
// an old post is likely already resolved or forgotten.
const LOST_AND_FOUND_WINDOW_DAYS = 21;
let cachedLostAndFoundPosts: FlairPost[] | null = null;
let cachedLostAndFoundPostsAtMs = 0;

const LOST_FOUND_KEYWORDS = ["lost", "found", "missing", "misplaced"];

const LOST_FOUND_SINGLE_MATCH_VARIANTS = [
  "I found a Lost & Found post that might match",
  "There's a Lost & Found post that could be about this",
  "This Lost & Found post looks related",
];

const LOST_FOUND_MULTI_MATCH_VARIANTS = [
  "I found a few Lost & Found posts that might match",
  "These Lost & Found posts could be related",
  "A few Lost & Found posts look like they might match",
];

const LOST_FOUND_NUDGE_VARIANTS = [
  "It sounds like you might want to post this in **Lost & Found** so others can help look out for it — want me to explain how?",
  "You could post about this in **Lost & Found** so other students can keep an eye out — want me to walk you through it?",
  "That sounds like a job for **Lost & Found** — posting it there means more people can help you look. Want the steps?",
];

// First-person possessive phrasing ("my", "I lost", "I can't find my") signals
// the person is describing their OWN lost item rather than searching for one
// someone else reported finding — that's the nudge case, distinguished from a
// search like "has anyone found a..." which has no first-person possessive.
// Shared with app/(main)/CreatePostScreen.tsx's flair suggestion — see
// utils/lostAndFoundDetection.ts.

/**
 * Same shape as answerFromAnnouncements — token-overlap scoring over cached,
 * approved, in-window posts — but gated behind LOST_FOUND_KEYWORDS since this
 * is topic-specific enough that it shouldn't compete with more general
 * campus knowledge for every unrelated query. Posts resolvedAt is set on
 * (Part 4, utils/lostAndFoundResolution.ts) are excluded via
 * fetchApprovedPostsByFlair's `resolved` mapping above.
 */
const answerLostAndFound = async (input: string): Promise<string | null> => {
  const queryTokens = tokenizeForRetrieval(input);
  if (queryTokens.size === 0) return null;

  const now = Date.now();
  if (!cachedLostAndFoundPosts || now - cachedLostAndFoundPostsAtMs >= LOST_AND_FOUND_CACHE_TTL_MS) {
    cachedLostAndFoundPosts = await fetchApprovedPostsByFlair("lost_found").catch(() => []);
    cachedLostAndFoundPostsAtMs = now;
  }

  const cutoffMs = now - LOST_AND_FOUND_WINDOW_DAYS * DAY_MS;
  const candidates = cachedLostAndFoundPosts.filter(
    (post) => post.createdAtMs >= cutoffMs && !post.resolved,
  );

  const ranked = candidates
    .map((post) => ({ post, score: overlapScore(queryTokens, post.content) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 2) return null;

  const top = ranked.slice(0, 3);
  if (top.length === 1) {
    return `${pickVariant(LOST_FOUND_SINGLE_MATCH_VARIANTS)}: ${top[0].post.content}`;
  }

  const list = top.map((item, index) => `(${index + 1}) ${item.post.content}`).join(" ");
  return `${pickVariant(LOST_FOUND_MULTI_MATCH_VARIANTS)}: ${list}`;
};

/**
 * Deterministic keyword-pattern nudge, not a trained intent. Only fires when
 * 1) the message looks lost-and-found related, 2) no existing post matched
 * it (answerLostAndFound already tried), and 3) the phrasing is first-person
 * ("my item is lost") rather than a search of others' posts.
 */
const answerLostAndFoundNudge = (input: string): string | null => {
  const normalized = normalizeText(input);
  if (!LOST_FOUND_FIRST_PERSON_PATTERN.test(normalized)) return null;
  return pickVariant(LOST_FOUND_NUDGE_VARIANTS);
};

// ─── Part 5: Help / Advice posts as a knowledge source ─────────────────────

const HELP_POSTS_CACHE_TTL_MS = 60 * 1000;
// Between announcements (90d) and lost items (21d): a peer's "can someone
// explain recursion" can stay unanswered and relevant for a while, but a
// term-old help request usually isn't worth surfacing any more.
const HELP_POSTS_WINDOW_DAYS = 45;
let cachedHelpPosts: FlairPost[] | null = null;
let cachedHelpPostsAtMs = 0;

// Gate for answerFromHelpPosts. Unlike Lost & Found, help posts carry no
// fixed vocabulary (any subject a student is stuck on), so there's no
// topic keyword to filter on — instead we key off the request itself
// sounding like a plea for help.
const HELP_REQUEST_KEYWORDS = [
  "help",
  "advice",
  "struggling",
  "explain",
  "stuck",
  "confused",
];

const HELP_POST_SINGLE_MATCH_VARIANTS = [
  "Another student asked something similar in a Help / Advice post",
  "There's a Help / Advice post that looks related",
  "This Help / Advice post covers something close to what you're asking",
];

const HELP_POST_MULTI_MATCH_VARIANTS = [
  "A few Help / Advice posts look related",
  "These Help / Advice posts cover something close to your question",
  "Some other students asked about this in Help / Advice posts",
];

/**
 * Same token-overlap-over-cached-posts shape as answerLostAndFound, and gated
 * the same way rather than scanned unconditionally like answerFromAnnouncements.
 * Help / Advice posts are student-authored and cover arbitrary subject matter,
 * so an unconditional scan would let a stale peer question outrank real campus
 * knowledge on unrelated factual queries. It only runs when the user's own
 * message is help-seeking (HELP_REQUEST_KEYWORDS) — the one case where pointing
 * at a related Help post genuinely helps. Content is returned unedited; only
 * the intro sentence is templated.
 */
const answerFromHelpPosts = async (input: string): Promise<string | null> => {
  const queryTokens = tokenizeForRetrieval(input);
  if (queryTokens.size === 0) return null;

  const now = Date.now();
  if (!cachedHelpPosts || now - cachedHelpPostsAtMs >= HELP_POSTS_CACHE_TTL_MS) {
    cachedHelpPosts = await fetchApprovedPostsByFlair("help").catch(() => []);
    cachedHelpPostsAtMs = now;
  }

  const cutoffMs = now - HELP_POSTS_WINDOW_DAYS * DAY_MS;
  const withinWindow = cachedHelpPosts.filter((post) => post.createdAtMs >= cutoffMs);

  const ranked = withinWindow
    .map((post) => ({ post, score: overlapScore(queryTokens, post.content) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  // Same minimum match threshold as answerFromAnnouncements / answerLostAndFound.
  const best = ranked[0];
  if (!best || best.score < 2) return null;

  const top = ranked.slice(0, 3);
  if (top.length === 1) {
    return `${pickVariant(HELP_POST_SINGLE_MATCH_VARIANTS)}: ${top[0].post.content}`;
  }

  const list = top.map((item, index) => `(${index + 1}) ${item.post.content}`).join(" ");
  return `${pickVariant(HELP_POST_MULTI_MATCH_VARIANTS)}: ${list}`;
};

// ─── Part 2: Directory lookups, role-gated ──────────────────────────────────

const DIRECTORY_CACHE_TTL_MS = 60 * 1000;
let cachedRoster: (BondedStudentRecord & { fullName: string })[] | null = null;
let cachedRosterAtMs = 0;

/**
 * Full students collection, same read pattern as fetchStaffDirectory (a
 * whole-collection read, filtered/grouped client-side) — but unlike that
 * function, this is never returned directly to a caller; every access goes
 * through answerDirectory's role gate or answerPersonLookup's single-person
 * lookup, both of which only ever surface firstname/lastname/course/yearlvl.
 */
const fetchRoster = async (): Promise<(BondedStudentRecord & { fullName: string })[]> => {
  const now = Date.now();
  if (cachedRoster && now - cachedRosterAtMs < DIRECTORY_CACHE_TTL_MS) {
    return cachedRoster;
  }

  const snapshot = await getDocs(collection(db, "students"));
  const roster = snapshot.docs.map((item) => {
    const data = item.data() as BondedStudentRecord;
    return {
      firstname: data.firstname,
      lastname: data.lastname,
      course: data.course,
      yearlvl: data.yearlvl,
      role: data.role,
      fullName: `${data.firstname || ""} ${data.lastname || ""}`.trim(),
    };
  });

  cachedRoster = roster;
  cachedRosterAtMs = now;
  return roster;
};

const DIRECTORY_STAFF_ONLY_REFUSAL =
  "I can only share the full member directory with school staff. I can tell you about **your own profile**, or about **teachers and moderators** if you'd like.";

const DIRECTORY_UNRECOGNIZED_FALLBACK =
  "I can look up one person by name, or — for school staff — list all students, all staff, or all registered users. Could you rephrase your question?";

const DIRECTORY_SIZE_GUARD = 40;

const DIRECTORY_ALL_USERS_KEYWORDS = ["users", "registered", "everyone", "system"];
const DIRECTORY_STUDENT_LISTING_KEYWORDS = [
  "students",
  "student",
  "enrolled",
  "enrollees",
  "enrollment",
];

const DIRECTORY_ROLE_NOUNS: Record<string, { singular: string; plural: string }> = {
  student: { singular: "student", plural: "students" },
  teacher: { singular: "teacher", plural: "teachers" },
  moderator: { singular: "moderator", plural: "moderators" },
  admin: { singular: "admin", plural: "admins" },
};

const roleNoun = (role: string, count: number) => {
  const noun = DIRECTORY_ROLE_NOUNS[role] || { singular: role, plural: `${role}s` };
  return count === 1 ? noun.singular : noun.plural;
};

/** ALL STUDENTS listing (2B-a). Grouped by program; size-guarded past ~40 names. */
const answerAllStudents = async (): Promise<string> => {
  const roster = await fetchRoster();
  const students = roster.filter(
    (person) => String(person.role || "student").toLowerCase() === "student" && person.fullName,
  );

  if (!students.length) {
    return "There are no student records on file yet.";
  }

  const grouped = new Map<string, string[]>();
  for (const student of students) {
    const course = String(student.course || "").trim() || "Unspecified program";
    if (!grouped.has(course)) grouped.set(course, []);
    grouped.get(course)!.push(student.fullName);
  }

  const totalLabel = `**${students.length} student${students.length === 1 ? "" : "s"}**`;

  if (students.length > DIRECTORY_SIZE_GUARD) {
    const breakdown = [...grouped.entries()]
      .map(([course, names]) => `**${course}**: ${names.length}`)
      .join(", ");
    return `There are ${totalLabel} enrolled. By program — ${breakdown}. The full list is available in the admin screens.`;
  }

  const groupClauses = [...grouped.entries()].map(
    ([course, names]) => `in **${course}**: ${humanizeNameList(names)}`,
  );

  return `There are ${totalLabel} enrolled. ${groupClauses.join("; ")}.`;
};

/** ALL REGISTERED USERS listing (2B-c). Every students doc, grouped by role with a total count. */
const answerAllRegisteredUsers = async (): Promise<string> => {
  const roster = await fetchRoster();
  const withNames = roster.filter((person) => person.fullName);

  if (!withNames.length) {
    return "There are no registered users on file yet.";
  }

  const counts = new Map<string, number>();
  for (const person of withNames) {
    const role = String(person.role || "student").toLowerCase();
    counts.set(role, (counts.get(role) || 0) + 1);
  }

  const ROLE_ORDER = ["student", "teacher", "moderator", "admin"];
  const orderedRoles = [
    ...ROLE_ORDER.filter((role) => counts.has(role)),
    ...[...counts.keys()].filter((role) => !ROLE_ORDER.includes(role)),
  ];

  const parts = orderedRoles.map((role) => `**${counts.get(role)} ${roleNoun(role, counts.get(role)!)}**`);

  return `There are **${withNames.length} registered users**: ${humanizeNameList(parts)}.`;
};

/**
 * Role-gated bulk directory listings (2B). Person lookup (2C) is handled
 * separately by answerPersonLookup and is NOT role-gated.
 */
const answerDirectory = async (
  input: string,
  askerRole: UserRole,
): Promise<string | null> => {
  const tokens = tokenizeForRetrieval(input);

  const wantsStaff = containsAnyKeyword(tokens, STAFF_DIRECTORY_KEYWORDS);
  const wantsAllUsers = containsAnyKeyword(tokens, DIRECTORY_ALL_USERS_KEYWORDS);
  const wantsStudents = containsAnyKeyword(tokens, DIRECTORY_STUDENT_LISTING_KEYWORDS);

  if (!wantsStaff && !wantsAllUsers && !wantsStudents) return null;

  if (!isStaff(askerRole)) {
    return DIRECTORY_STAFF_ONLY_REFUSAL;
  }

  if (wantsStaff) {
    const answer = await answerStaffDirectory(input);
    return answer || "I don't have that information yet — no matching teachers, moderators, or admins are on file.";
  }

  if (wantsAllUsers) {
    return answerAllRegisteredUsers();
  }

  return answerAllStudents();
};

// ─── Part 2C: Individual person lookup (unrestricted — see UserProfileScreen) ──

const PERSON_LOOKUP_PATTERNS: RegExp[] = [
  /what\s+(?:program|course)\s+is\s+(.+?)\s+(?:in|taking|enrolled\s+in)\s*\??$/i,
  /what\s+(?:program|course)\s+does\s+(.+?)\s+take\s*\??$/i,
  /what\s+year(?:\s+level)?\s+is\s+(.+?)(?:\s+in)?\s*\??$/i,
  /who\s+is\s+(.+?)\s*\??$/i,
];

// Includes third-person pronouns — "what program is she in" matches the
// lookup pattern structurally but can never resolve to a roster name, so
// it's better rejected here (falls through to normal classification) than
// answered with a confusing "couldn't find anyone named **she**" reply.
const PERSON_LOOKUP_EXCLUDED_CANDIDATES = new Set([
  "i",
  "me",
  "my",
  "myself",
  "you",
  "your",
  "he",
  "she",
  "him",
  "her",
  "they",
  "them",
  "it",
  "bonded",
  "bonded ai",
  "bea",
  "bondedai",
]);

/**
 * Only tries to extract a name from RAW input (no synonym substitution or
 * fuzzy typo-correction — those are tuned toward BondED vocabulary like
 * "program"/"help" and would risk mangling a real name). Matching against
 * the roster is likewise exact-normalized-string only, never fuzzy — see
 * answerPersonLookup below.
 */
const extractPersonNameCandidate = (input: string): string | null => {
  const cleaned = input.replace(/@(?:ai|bondedai)\b/gi, " ").replace(/\s+/g, " ").trim();

  for (const pattern of PERSON_LOOKUP_PATTERNS) {
    const match = cleaned.match(pattern);
    const candidate = match?.[1]?.trim();
    if (!candidate || candidate.length < 3) continue;
    if (PERSON_LOOKUP_EXCLUDED_CANDIDATES.has(candidate.toLowerCase())) continue;
    return candidate;
  }

  return null;
};

const normalizeNameForMatch = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const personProgramClause = (person: BondedStudentRecord): string => {
  const role = String(person.role || "student").toLowerCase();
  if (role !== "student") return `a **${role}** at BondED, not enrolled in a program`;

  const course = person.course ? `**${person.course}**` : "a program that isn't listed";
  const year = person.yearlvl ? `, year level **${person.yearlvl}**` : "";
  return `enrolled in ${course}${year}`;
};

const formatSinglePersonLookupReply = (
  person: BondedStudentRecord & { fullName: string },
): string => `${person.fullName} is ${personProgramClause(person)}.`;

const answerPersonLookup = async (input: string): Promise<string | null> => {
  const candidate = extractPersonNameCandidate(input);
  if (!candidate) return null;

  const normalizedCandidate = normalizeNameForMatch(candidate);
  if (!normalizedCandidate) return null;

  const roster = await fetchRoster();
  const matches = roster.filter((person) => {
    if (!person.fullName) return false;
    const normalizedFull = normalizeNameForMatch(person.fullName);
    const normalizedReversed = normalizeNameForMatch(
      `${person.lastname || ""} ${person.firstname || ""}`,
    );
    const normalizedFirst = normalizeNameForMatch(person.firstname || "");
    const normalizedLast = normalizeNameForMatch(person.lastname || "");
    return (
      normalizedFull === normalizedCandidate ||
      normalizedReversed === normalizedCandidate ||
      normalizedFirst === normalizedCandidate ||
      normalizedLast === normalizedCandidate
    );
  });

  if (matches.length === 0) {
    return `I couldn't find anyone named **${candidate}** in BondED. Double-check the spelling, or try their full name as it's registered.`;
  }

  if (matches.length === 1) {
    return formatSinglePersonLookupReply(matches[0]);
  }

  if (matches.length <= 3) {
    const clauses = matches.map((person, index) => {
      const prefix =
        index === 0
          ? "One is"
          : matches.length === 2
            ? "the other is"
            : index === matches.length - 1
              ? "the last is"
              : "another is";
      return `${prefix} ${personProgramClause(person)}`;
    });
    return `I found **${matches.length} people** named ${candidate}. ${clauses.join("; ")}. Could you give me more detail to narrow it down?`;
  }

  return `I found **${matches.length} people** named ${candidate}. Could you give me their full name to narrow it down?`;
};

/**
 * Last-resort grounding pass for anything the intent/scope classifier could not
 * confidently place (including questions it labeled "unknown"). Everything here
 * still comes straight from Firestore — this never calls a generative model.
 * It only widens the chance that a real BondED question gets answered from the
 * database instead of falling through to the generic "I don't know" reply.
 */
/**
 * Live staff-maintained campus FAQ. Read failures (offline, rules) fall back
 * to an empty list so the bundled offline index still answers.
 */
const fetchCampusFaqEntries = async (): Promise<CampusFaqEntry[]> => {
  try {
    const snapshot = await getDocs(collection(db, "campusFaq"));
    return snapshot.docs
      .map((entry) => {
        const data = entry.data() as Record<string, unknown>;
        return {
          question: String(data.question || "").trim(),
          answer: String(data.answer || "").trim(),
        };
      })
      .filter((entry) => entry.question.length > 0 && entry.answer.length > 0);
  } catch {
    return [];
  }
};

/**
 * Campus FAQ answer. Live Firestore `campusFaq` entries (staff-editable) take
 * precedence; the bundled offline index is the fallback. Non-generative — a
 * stored answer is returned verbatim, or null.
 */
const answerCampusKnowledge = async (prompt: string): Promise<string | null> => {
  const liveEntries = await fetchCampusFaqEntries();
  const match = retrieveCampusKnowledge(prompt, liveEntries);
  return match ? match.answer : null;
};

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

  const announcementAnswer = await answerFromAnnouncements(prompt).catch(() => null);
  if (announcementAnswer) return announcementAnswer;

  if (containsAnyKeyword(tokens, LOST_FOUND_KEYWORDS)) {
    const lostAndFoundAnswer = await answerLostAndFound(prompt).catch(() => null);
    if (lostAndFoundAnswer) return lostAndFoundAnswer;

    const nudge = answerLostAndFoundNudge(prompt);
    if (nudge) return nudge;
  }

  const campusAnswer = await answerCampusKnowledge(prompt).catch(() => null);
  if (campusAnswer) return campusAnswer;

  // Peer content, lower authority than curated campus knowledge — checked
  // last, and only when the message itself sounds like a request for help.
  if (containsAnyKeyword(tokens, HELP_REQUEST_KEYWORDS)) {
    const helpPostAnswer = await answerFromHelpPosts(prompt).catch(() => null);
    if (helpPostAnswer) return helpPostAnswer;
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

// Defensive whitespace cleanup only — deliberately does NOT collapse blank
// lines, so a multi-paragraph Wikipedia intro keeps its paragraph breaks.
// The answer text itself is never shortened here.
const tidyApiAnswer = (value: string) =>
  value
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .trim();

/**
 * General-knowledge answers come verbatim from a live source (Wikipedia,
 * Wiktionary, Frankfurter, Open-Meteo). The full retrieved text is shown,
 * never truncated and never re-worded — still non-generative, nothing here
 * is composed by a model.
 *
 * No citation line is appended: the reply is just the sentences themselves.
 * The source is still recorded on the answer object and in the Firestore
 * cache (utils/knowledgeCache.ts) for provenance, it simply isn't printed
 * into the chat bubble.
 */
const formatGeneralKnowledgeReply = (answer: string): string =>
  tidyApiAnswer(answer);

const GREETING_VARIANTS = [
  "Hello! I'm B.E.A. I can help with BondED campus information, upcoming events, academic programs, general knowledge, and date/time.",
  "Hi there! I'm B.E.A. — ask me about campus info, upcoming events, academic programs, general knowledge, or the date and time.",
  "Hey! B.E.A. here. I can look up campus events, academic programs, school information, general knowledge, or the date/time for you.",
  "Hello! I'm B.E.A., ready to help with BondED events, programs, campus info, general knowledge, and date/time.",
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

// Pre-written, hand-vetted, school-appropriate jokes. Same non-generative
// pattern as GREETING_VARIANTS etc. — one is picked at random, nothing is
// composed at request time. Sourced from the Hugging Face `gnumanth/dad-jokes`
// dataset plus the classic clean pun canon; every entry was reviewed by hand
// for a K-12 audience (no references to sex, alcohol, drugs, religion, race,
// politics, crime, or violence). Add more here and they take effect on the
// next app reload — no retraining needed for new joke text.
const JOKE_VARIANTS = [
  "Why don't scientists trust atoms? Because they make up everything.",
  "What do you call a fake noodle? An impasta.",
  "Why did the scarecrow win an award? He was outstanding in his field.",
  "I only know 25 letters of the alphabet. I don't know y.",
  "What do you call cheese that isn't yours? Nacho cheese.",
  "What did one wall say to the other wall? Meet you at the corner.",
  "Why did the math book look so sad? It had too many problems.",
  "What do you call a bear with no teeth? A gummy bear.",
  "How do you organize a space party? You planet.",
  "Why can't your nose be 12 inches long? Because then it would be a foot.",
  "What did the ocean say to the beach? Nothing, it just waved.",
  "Why did the cookie go to the nurse? It was feeling crumby.",
  "What kind of shoes do spies wear? Sneakers.",
  "Why are elevator jokes so good? They work on many levels.",
  "I used to dislike facial hair, but then it grew on me.",
  "How does a penguin build its house? Igloos it together.",
  "What's orange and sounds like a parrot? A carrot.",
  "Why don't eggs tell jokes? They'd crack each other up.",
  "What do you call a pile of cats? A meow-ntain.",
  "Why did the student eat his homework? The teacher said it was a piece of cake.",
  "What do you call a sleeping bull? A bulldozer.",
  "I'd tell you a chemistry joke, but I know I wouldn't get a reaction.",
  "Why was the math class so long? The teacher kept going off on a tangent.",
  "What do you call a fish wearing a bowtie? Sofishticated.",
  "How do you make a tissue dance? Put a little boogie in it.",
  "What's a computer's favorite snack? Microchips.",
  "Why did the tomato turn red? It saw the salad dressing.",
  "What do you call two birds in love? Tweethearts.",
  "What did the janitor shout when he jumped out of the closet? Supplies!",
  "How do trees get online? They log in.",
  "What do you call a dog that does magic tricks? A labracadabrador.",
  "Why do bees have sticky hair? They use honeycombs.",
  "What do you call an alligator in a vest? An investigator.",
  "Why did the gym close down? It just didn't work out.",
  "What do you call a boomerang that won't come back? A stick.",
  "What did the buffalo say to his son leaving for college? Bison.",
  "What's brown and sticky? A stick.",
  "Why can't you trust stairs? They're always up to something.",
  "What do you call a dinosaur that crashes his car? Tyrannosaurus wrecks.",
  "Why did the bicycle fall over? It was two tired.",
  "What do you call a cow on a trampoline? A milkshake.",
  "Where are the Andes? At the end of your armies.",
  "My friend's bakery burned down. Now his business is toast.",
  "Who is the fastest draw in the ocean? Billy the Squid.",
  "My cat threw up on the carpet. I don't think it's feline well.",
  "Whiteboards are remarkable.",
  "Why did the octopus win the wrestling match? It was well armed.",
  "Why did the golfer bring two pairs of pants? In case he got a hole in one.",
  "Where are average things manufactured? In the satisfactory.",
  "Yesterday a clown held the door open for me. It was a nice jester.",
  "What lies at the bottom of the ocean and shivers? A nervous wreck.",
  "What was Beethoven's favorite fruit? Ba-na-na-na.",
  "People keep making apocalypse jokes like there's no tomorrow.",
  "Singing in the shower is fun until you get soap in your mouth. Then it's a soap opera.",
  "How do you count a herd of cows? With a cow-culator.",
  "What's the best thing about Switzerland? I'm not sure, but the flag is a big plus.",
  "Milk is the fastest liquid on earth. It's pasteurized before you even see it.",
  "I used to be a banker, but I lost interest.",
  "How do you find Will Smith in the snow? Follow the fresh prints.",
  "How do you make toast in the jungle? Put your bread under a gorilla.",
  "I went to the doctor and he said I had type A blood, but it was a typo.",
  "Why did the banana visit the doctor? It wasn't peeling well.",
  "Two atoms are walking along. One says it lost an electron. The other asks if it is sure. The first replies, yes, I'm positive.",
  "I hate perforated paper. It's tearable.",
  "I dreamed I was swimming in an ocean of orange soda. It was just a Fanta sea.",
];

const ASSISTANT_IDENTITY_VARIANTS = [
  "I'm **B.E.A.**, the educational assistant built into BondED.",
  "I'm **B.E.A.** — an assistant built right into BondED, not a generative AI.",
  "I'm **B.E.A.**, BondED's built-in assistant for campus info, events, programs, and more.",
  "I'm **B.E.A.**, an assistant designed to help with BondED questions.",
];

const HELP_VARIANTS = [
  "You can ask me about upcoming campus events, available academic programs, BondED information stored by the school, and the current date or time.",
  "I can help with campus events, academic programs, school information, or the date and time — just ask.",
  "Try asking me about your student profile, upcoming events, academic programs, school info, or the date/time.",
  "I'm best at answering questions about BondED events, programs, campus info, and date/time.",
];

const DATE_REPLY_TEMPLATES: Array<(date: string) => string> = [
  (date) => `Today is **${date}**.`,
  (date) => `It's **${date}** today.`,
  (date) => `The date today is **${date}**.`,
  (date) => `Today's date: **${date}**.`,
];

const TIME_REPLY_TEMPLATES: Array<(time: string) => string> = [
  (time) => `The current time on your device is **${time}**.`,
  (time) => `Right now it's **${time}** on your device.`,
  (time) => `Your device shows **${time}** as the current time.`,
  (time) => `It's currently **${time}**.`,
];

const CALCULATOR_REPLY_TEMPLATES: Array<(expression: string, result: string) => string> = [
  (expression, result) => `${expression} equals **${result}**.`,
  (expression, result) => `${expression} = **${result}**.`,
  (expression, result) => `That works out to **${result}** (${expression}).`,
  (expression, result) => `${expression} comes out to **${result}**.`,
];

const USER_IDENTITY_TEMPLATES: Array<(name: string) => string> = [
  (name) => `Your name is **${name}**.`,
  (name) => `You're **${name}**.`,
  (name) => `This account belongs to **${name}**.`,
  (name) => `You're signed in as **${name}**.`,
];

const UNKNOWN_FALLBACK_VARIANTS = [
  "I couldn't quite find an answer to that. I'm best with questions about your BondED profile, programs, events, and campus info — try one of those, or rephrase your question and I'll give it another shot.",
  "Hmm, I don't have a confident answer for that one. I can help with your profile, programs, events, and campus info — try rephrasing or ask about one of those.",
  "I'm not sure about that one. I'm most useful for BondED profile, program, event, and campus questions — feel free to rephrase and I'll try again.",
  "That one's outside what I can confidently answer. I can help with your profile, programs, events, and campus info — try rewording your question.",
];

export type NonGenerativeReply = {
  reply: string;
  model: string;
  intent: ChatbotIntent;
  confidence: number;
};

/**
 * Below this, the source router is judged too unsure of its own answer to
 * let it be the last word. Correct BondED routings in the regression set sit
 * around 0.9-0.99; a genuine misroute like "which planet is the largest"
 * came back at 0.45, i.e. the model was close to a coin flip. See the
 * general-knowledge second chance in the `default` branch below.
 */
const ROUTER_UNSURE_BELOW = 0.6;

/**
 * The general-knowledge path: Firestore cache first (a question answered
 * before costs no API call), then the live providers, caching a fresh
 * answer fire-and-forget for whoever asks next. Live data (weather, FX) is
 * marked non-cacheable by the provider and skips the cache.
 *
 * Returns null when nothing could be retrieved, so callers decide whether
 * that means the unknown-question fallback or another path.
 */
const answerFromGeneralKnowledge = async (
  prompt: string,
  confidence: number,
): Promise<NonGenerativeReply | null> => {
  const knowledgeKey = normalizeGeneralKnowledgeKey(prompt);

  const cached = knowledgeKey ? await getCachedGeneralAnswer(knowledgeKey) : null;
  if (cached) {
    touchCachedGeneralAnswer(knowledgeKey);
    return {
      reply: formatGeneralKnowledgeReply(cached.answer),
      model: MODEL_NAME,
      intent: "general_knowledge",
      confidence,
    };
  }

  const apiAnswer = await lookupGeneralKnowledge(prompt).catch((error) => {
    console.error("General-knowledge API lookup failed:", error);
    return null;
  });
  if (!apiAnswer) return null;

  if (apiAnswer.cacheable && knowledgeKey) {
    putCachedGeneralAnswer(knowledgeKey, prompt, apiAnswer);
  }
  return {
    reply: formatGeneralKnowledgeReply(apiAnswer.answer),
    model: MODEL_NAME,
    intent: "general_knowledge",
    confidence,
  };
};

export const requestNonGenerativeChatbotReply = async (
  prompt: string,
): Promise<NonGenerativeReply> => {
  const expression = extractArithmeticExpression(prompt);
  if (expression) {
    const result = evaluateExpression(expression);
    if (result != null) {
      return {
        reply: pickTemplate(CALCULATOR_REPLY_TEMPLATES)(expression.trim(), formatNumber(result)),
        model: MODEL_NAME,
        intent: "calculator",
        confidence: 1,
      };
    }
  }

  const sourceRoute = routeChatbotSource(prompt);
  const classification = classifyIntent(prompt);
  const now = new Date();

  // The source router is authoritative for everything it was trained on, so
  // a BondED question can't be hijacked by a superficially similar public
  // answer. The one gap is that the router is retrained periodically and
  // lags behind capabilities added straight to generalKnowledgeApi.ts — it
  // has no signal for "define X" phrasing, for instance — so an
  // unmistakable currency/weather/dictionary trigger rescues that case.
  // This can only ever ADD a question to the general branch; it never takes
  // a campus question away from its own handler.
  const forcedGeneral =
    sourceRoute.source !== "general" && hasGeneralKnowledgeTrigger(prompt);

  // Retrieval order: Firestore cache (a question answered before) -> the live
  // public APIs (utils/generalKnowledgeApi.ts: Frankfurter, Open-Meteo,
  // Wiktionary, Wikipedia) -> unknown-question fallback. A fresh API answer
  // is cached (fire-and-forget) so the next person asking the same thing
  // gets it instantly with no extra API call. Live-data answers (weather, FX
  // rates) are marked non-cacheable and skip the cache.
  if (sourceRoute.source === "general" || forcedGeneral) {
    const answer = await answerFromGeneralKnowledge(prompt, sourceRoute.confidence);
    if (answer) return answer;

    logUnansweredQuestion(prompt, classification);
    return {
      reply: pickVariant(UNKNOWN_FALLBACK_VARIANTS),
      model: MODEL_NAME,
      intent: "unknown",
      confidence: sourceRoute.confidence,
    };
  }

  // Utility questions are also isolated from general retrieval. The existing
  // deterministic calculator/date/time handlers remain the source of truth.
  if (sourceRoute.source === "utility") {
    if (classification.intent === "date") {
      return {
        reply: pickTemplate(DATE_REPLY_TEMPLATES)(formatDate(now)),
        model: MODEL_NAME,
        intent: "date",
        confidence: sourceRoute.confidence,
      };
    }
    if (classification.intent === "time") {
      return {
        reply: pickTemplate(TIME_REPLY_TEMPLATES)(formatTime(now)),
        model: MODEL_NAME,
        intent: "time",
        confidence: sourceRoute.confidence,
      };
    }
    // Arithmetic was already handled above. If a utility-looking request is
    // still unsupported, fail safely instead of searching unrelated knowledge.
    if (classification.intent === "unknown") {
      logUnansweredQuestion(prompt, classification);
      return {
        reply: pickVariant(UNKNOWN_FALLBACK_VARIANTS),
        model: MODEL_NAME,
        intent: "unknown",
        confidence: sourceRoute.confidence,
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

    case "joke":
      return {
        reply: pickVariant(JOKE_VARIANTS),
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
          ? pickTemplate(USER_IDENTITY_TEMPLATES)(
              fullName || authName || fallbackName || "the currently signed-in BondED user",
            )
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
        reply: pickTemplate(DATE_REPLY_TEMPLATES)(formatDate(now)),
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "time":
      return {
        reply: pickTemplate(TIME_REPLY_TEMPLATES)(formatTime(now)),
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

    case "directory": {
      // Person lookup (2C) is unrestricted — try it first regardless of the
      // asker's role, same as UserProfileScreen already allows any signed-in
      // user to open another user's profile.
      const personAnswer = await answerPersonLookup(prompt).catch(() => null);
      if (personAnswer) {
        return {
          reply: personAnswer,
          model: MODEL_NAME,
          intent: classification.intent,
          confidence: classification.confidence,
        };
      }

      // Bulk listings (2B) are staff-only — resolve the asker's role before
      // returning anything.
      const currentUser = auth.currentUser;
      const askerRole = currentUser
        ? await resolveUserRoleForAuthUser(currentUser).catch(() => "student" as UserRole)
        : "student";
      const directoryAnswer = await answerDirectory(prompt, askerRole).catch(() => null);

      return {
        reply: directoryAnswer || DIRECTORY_UNRECOGNIZED_FALLBACK,
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
      // We are on the BondED branch because the router selected it, so
      // BondED's own live sources get first refusal — a campus question is
      // never answered from Wikipedia.
      const bondedAnswer = await answerFromAnySource(prompt);
      if (bondedAnswer) {
        return {
          reply: bondedAnswer,
          model: MODEL_NAME,
          intent: "campus_knowledge",
          confidence: sourceRoute.confidence,
        };
      }

      // Nothing in BondED's data answered it, and the router wasn't
      // confident it belonged here in the first place — "which planet is
      // the largest" lands here at 0.45. Rather than tell a student we
      // can't help, give general knowledge the question the router was
      // unsure about. Ordering keeps the two from conflicting: BondED data
      // always answers first when it has anything, and a confident bonded
      // routing never reaches this at all.
      if (sourceRoute.confidence < ROUTER_UNSURE_BELOW) {
        const generalAnswer = await answerFromGeneralKnowledge(
          prompt,
          sourceRoute.confidence,
        );
        if (generalAnswer) return generalAnswer;
      }

      logUnansweredQuestion(prompt, classification);
      return {
        reply: pickVariant(UNKNOWN_FALLBACK_VARIANTS),
        model: MODEL_NAME,
        intent: "unknown",
        confidence: sourceRoute.confidence,
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
  sourceRouting: "epoch-trained MLP -> bonded | general | utility",
});

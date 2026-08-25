import { collection, getDocs } from "firebase/firestore";
import { auth, db } from "../Firebase_configure";
import { getUserDataByAuthUser } from "./rbac";
import { readAiMemoryEntries } from "./aiMemory";
import { CHATBOT_INTENT_MODEL } from "./chatbotIntentModel";

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
  | "campus_knowledge"
  | "unknown";

type TrainedIntent = Exclude<ChatbotIntent, "unknown">;
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

const MODEL_NAME = CHATBOT_INTENT_MODEL.modelName;
const MIN_CONFIDENCE = 0.34;
const MIN_MARGIN = 0.06;

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
};

const applySynonyms = (value: string) =>
  normalizeText(value)
    .split(/\s+/)
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
  return `${best.title}: ${best.content}`.trim();
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
      return `${title} on ${date}${startTime}`;
    })
    .join("; ");

  return `Upcoming events: ${summary}.`;
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
    const code = exact.code ? `${String(exact.code)} — ` : "";
    const name = String(exact.name || "Program");
    const description = exact.description ? `: ${String(exact.description)}` : "";
    return `${code}${name}${description}`;
  }

  const listed = programs
    .slice(0, 10)
    .map((program) => {
      const code = String(program.code || "");
      const name = String(program.name || "");
      return code ? `${code} — ${name}` : name;
    })
    .filter(Boolean)
    .join("; ");

  return `Programs currently listed in BondED: ${listed}.`;
};

const PROGRAM_KEYWORDS = ["program", "programs", "course", "courses", "degree", "degrees", "major", "majors", "bsit", "bscs"];
const EVENT_KEYWORDS = ["event", "events", "activity", "activities", "schedule", "happening", "upcoming"];

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

  return null;
};

export type NonGenerativeReply = {
  reply: string;
  model: string;
  intent: ChatbotIntent;
  confidence: number;
};

export const requestNonGenerativeChatbotReply = async (
  prompt: string,
): Promise<NonGenerativeReply> => {
  const expression = extractArithmeticExpression(prompt);
  if (expression) {
    const result = evaluateExpression(expression);
    if (result != null) {
      return {
        reply: `${expression.trim()} = ${formatNumber(result)}`,
        model: MODEL_NAME,
        intent: "calculator",
        confidence: 1,
      };
    }
  }

  const classification = classifyIntent(prompt);
  const now = new Date();

  switch (classification.intent) {
    case "greeting":
      return {
        reply:
          "Hello! I'm Bonded AI. I can help with BondED campus information, upcoming events, academic programs, date/time, and basic calculations.",
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "wellbeing":
      return {
        reply: "I'm doing well and ready to help. What would you like to know about BondED?",
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "thanks":
      return {
        reply: "You're welcome! I'm ready if you need anything else in BondED.",
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "goodbye":
      return {
        reply: "Goodbye! You can mention me again whenever you need help.",
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "assistant_identity":
      return {
        reply: "I'm Bonded AI, the non-generative educational assistant built into BondED.",
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
          ? `Your name is ${fullName || authName || fallbackName || "the currently signed-in BondED user"}.`
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

      let reply = [
        `${profile.firstname || ""} ${profile.lastname || ""}`.trim()
          ? `Name: ${`${profile.firstname || ""} ${profile.lastname || ""}`.trim()}`
          : null,
        profile.studentID ? `Student ID: ${profile.studentID}` : null,
        profile.course ? `Program/Course: ${profile.course}` : null,
        profile.yearlvl ? `Year level: ${profile.yearlvl}` : null,
      ]
        .filter(Boolean)
        .join("; ");

      if (/\b(student id|student number)\b/.test(normalized)) {
        reply = profile.studentID
          ? `Your student ID is ${profile.studentID}.`
          : "Your student ID is not listed in your BondED profile.";
      } else if (/\b(program|course)\b/.test(normalized)) {
        reply = profile.course
          ? `Your program/course is ${profile.course}.`
          : "Your program/course is not listed in your BondED profile.";
      } else if (/\byear\b/.test(normalized)) {
        reply = profile.yearlvl
          ? `Your year level is ${profile.yearlvl}.`
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
        reply:
          "You can ask me about upcoming campus events, available academic programs, BondED information stored by the school, the current date or time, and basic calculations.",
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "date":
      return {
        reply: `Today is ${formatDate(now)}.`,
        model: MODEL_NAME,
        intent: classification.intent,
        confidence: classification.confidence,
      };

    case "time":
      return {
        reply: `The current time on your device is ${formatTime(now)}.`,
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
      const answer = await answerFromAnySource(prompt);
      return {
        reply:
          answer ||
          "I’m not confident enough to answer that correctly. Try rephrasing your question or ask about your student profile, campus events, academic programs, school information, date/time, or a basic calculation.",
        model: MODEL_NAME,
        intent: answer ? "campus_knowledge" : "unknown",
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

// General-knowledge answers, retrieved live from free public APIs.
//
// Still non-generative: every answer is text RETRIEVED verbatim from a
// public source (Wikipedia, Wiktionary, Frankfurter/ECB, Open-Meteo), never
// composed by a language model. Answers are returned in full — the caller
// does not truncate them.
//
// The question itself is also handled without phrasing rules: Wikipedia's
// full-text search is handed the user's question as typed, so "who founded
// amazon company", "when was python created" and "tallest mountain in the
// world" all work without this file knowing those shapes in advance. Only
// the three narrow non-Wikipedia providers (currency, weather, dictionary)
// keep a trigger pattern, because they hit different APIs entirely.
//
// English only. A Tagalog/Cebuano translation layer was tried here and
// removed: Wikipedia's index is English, so translated fragments produced
// confidently wrong matches rather than better ones. Non-English questions
// now stay with the campus/bonded handlers instead of being force-fed to
// Wikipedia.
//
// Only reached when the source router (utils/sourceRouter.ts) decides a
// question is `general` (or `hasGeneralKnowledgeTrigger` below overrides it
// for an unmistakable currency/weather/dictionary phrasing). Campus /
// utility / events / programs / lost&found / help all keep their existing
// deterministic handlers untouched.

export type GeneralKnowledgeProvider =
  | "wikipedia"
  | "restcountries"
  | "wiktionary"
  | "frankfurter"
  | "open-meteo";

export type GeneralKnowledgeAnswer = {
  /** The full answer text from the source — not shortened. */
  answer: string;
  sourceLabel: string;
  sourceUrl?: string;
  provider: GeneralKnowledgeProvider;
  /** false for live data (weather, FX) that must not be permanently cached. */
  cacheable: boolean;
};

// Wikipedia's extract call can return several KB of prose (multi-paragraph
// intros aren't truncated), and on a slow connection that's meaningfully
// bigger than the compact JSON the other providers return — 7s was clipping
// legitimate slow-but-working requests, so this gives them more room.
const TIMEOUT_MS = 12000;

// Wikimedia's API etiquette asks every client to identify itself (a
// descriptive User-Agent, ideally with contact info) and warns that
// unidentified traffic is more likely to be throttled under load — hit a
// real "too many requests" rate-limit response first-hand while verifying
// this file's own fixes. Doesn't affect Frankfurter/Open-Meteo, but costs
// nothing to send everywhere.
const APP_USER_AGENT = "BondedApp/1.0 (school community app; general-knowledge chatbot lookups)";

const fetchJson = async (url: string): Promise<any | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": APP_USER_AGENT },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "of", "in", "on",
  "at", "to", "for", "and", "or", "what", "whats", "what's", "who", "whos",
  "who's", "when", "where", "why", "how", "does", "do", "did", "can", "could",
  "would", "please", "tell", "me", "about", "give", "explain", "i", "you",
  "your", "my", "it", "its", "it's", "much", "many", "there",
]);

/**
 * Strip diacritics so accented titles still match a plainly-typed question.
 * Wikipedia titles carry them ("Noli Me Tángere", "José Rizal", "Pokémon")
 * while students type ASCII; without folding, the accented letter split the
 * word in two and the title looked unrelated. Same NFKD approach the source
 * router already uses on its own input.
 */
const foldAccents = (value: string): string =>
  value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

/**
 * Lightweight English stemmer handling inflectional & common derivational suffixes.
 * Normalizes plurals (-s, -es, -ies), verb tenses (-ed, -ing), and agent/adjective endings
 * (-tion, -ian, -al, -est, -ment, -ness) so related forms match (e.g. "bones" <=> "bone",
 * "invented" <=> "invention", "australian" <=> "australia").
 */
export const stemWord = (raw: string): string => {
  let w = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length <= 2) return w;

  // Plurals & s-endings
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "i";
  else if (w.endsWith("ss")) {}
  else if (w.endsWith("s") && w.length > 3) w = w.slice(0, -1);

  // Verb inflections
  if (w.endsWith("eed")) {
    if (w.length > 4) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && w.length > 4) {
    w = w.slice(0, -2);
    if (w.endsWith("i")) w = w.slice(0, -1) + "y";
  } else if (w.endsWith("ing") && w.length > 5) {
    w = w.slice(0, -3);
  }

  // Common derivational suffixes
  if (w.endsWith("tion") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ian") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("al") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ment") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("ness") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("est") && w.length > 5) w = w.slice(0, -3);

  return w;
};

/**
 * The question's meaningful words, used to rank search results (see
 * titleCoverage). NOT used to build the search query itself — Wikipedia's
 * full-text search does better with the question as the user typed it.
 */
const contentWords = (text: string): string[] =>
  foldAccents(text)
    .toLowerCase()
    .replace(/@(?:ai|bondedai)\b/g, " ")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !STOPWORDS.has(word));

const stripFiller = (text: string): string => contentWords(text).join(" ").trim();

const htmlToText = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ── Frankfurter (ECB reference rates) ────────────────────────────────────

const CURRENCY_ALIASES: Record<string, string> = {
  usd: "USD", dollar: "USD", dollars: "USD", "us dollar": "USD", "us dollars": "USD",
  php: "PHP", peso: "PHP", pesos: "PHP", "philippine peso": "PHP",
  eur: "EUR", euro: "EUR", euros: "EUR",
  gbp: "GBP", pound: "GBP", pounds: "GBP", sterling: "GBP",
  jpy: "JPY", yen: "JPY",
  aud: "AUD", cad: "CAD", chf: "CHF", cny: "CNY", yuan: "CNY", rmb: "CNY",
  inr: "INR", rupee: "INR", rupees: "INR",
  krw: "KRW", won: "KRW", sgd: "SGD", hkd: "HKD", myr: "MYR", ringgit: "MYR",
  thb: "THB", baht: "THB", idr: "IDR", rupiah: "IDR", nzd: "NZD",
};

const findCurrencies = (lower: string): string[] => {
  const hits: string[] = [];
  for (const [alias, code] of Object.entries(CURRENCY_ALIASES)) {
    const re = new RegExp(`\\b${alias.replace(/ /g, "\\s+")}\\b`, "g");
    if (re.test(lower) && !hits.includes(code)) hits.push(code);
  }
  return hits;
};

const lookupFx = async (
  prompt: string,
): Promise<GeneralKnowledgeAnswer | null> => {
  const lower = prompt.toLowerCase();
  const looksLikeFx =
    /\b(exchange rate|convert|currency|forex|how much is)\b/.test(lower) ||
    /\b[a-z]{3}\s+(to|in|into|vs)\s+[a-z]{3}\b/.test(lower);
  if (!looksLikeFx) return null;

  const currencies = findCurrencies(lower);
  if (currencies.length < 2) return null;
  const [from, to] = currencies;

  const amountMatch = lower.match(/(\d[\d,]*(?:\.\d+)?)/);
  const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, "")) : 1;

  const data = await fetchJson(
    `https://api.frankfurter.app/latest?amount=${amount}&from=${from}&to=${to}`,
  );
  const rate = data?.rates?.[to];
  if (typeof rate !== "number") return null;

  const perUnit = amount === 1 ? rate : rate / amount;
  const answer =
    `As of ${data.date}, ${amount.toLocaleString()} ${from} = ` +
    `${rate.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${to} ` +
    `(1 ${from} ≈ ${perUnit.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${to}). ` +
    `Rates are European Central Bank reference rates and update once per business day.`;

  return {
    answer,
    sourceLabel: "Frankfurter (ECB reference rates)",
    sourceUrl: "https://www.frankfurter.app",
    provider: "frankfurter",
    cacheable: false,
  };
};

// ── Open-Meteo (weather) ─────────────────────────────────────────────────

const WMO_CODES: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "depositing rime fog",
  51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
  56: "light freezing drizzle", 57: "dense freezing drizzle",
  61: "slight rain", 63: "moderate rain", 65: "heavy rain",
  66: "light freezing rain", 67: "heavy freezing rain",
  71: "slight snowfall", 73: "moderate snowfall", 75: "heavy snowfall",
  77: "snow grains",
  80: "slight rain showers", 81: "moderate rain showers", 82: "violent rain showers",
  85: "slight snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with slight hail", 99: "thunderstorm with heavy hail",
};

const lookupWeather = async (
  prompt: string,
): Promise<GeneralKnowledgeAnswer | null> => {
  // Strip trailing punctuation FIRST — "is it raining in Baguio?" was
  // failing because the place regex below anchors on end-of-string, and a
  // literal "?" right after the place name broke that match every time,
  // falling through to a much weaker fallback that left "it"/"raining" stuck
  // to the place guess (e.g. geocoding "it raining baguio" instead of
  // "baguio", which finds nothing).
  const lower = prompt.toLowerCase().replace(/[?!.]+$/, "").trim();
  if (!/\b(weather|temperature|forecast|how hot|how cold|is it raining|raining)\b/.test(lower)) {
    return null;
  }

  const placeMatch = lower.match(/\b(?:in|at|for|near)\s+([a-z][a-z .,'-]+)$/);
  const place = (
    placeMatch
      ? placeMatch[1]
      : stripFiller(
          lower.replace(
            /\b(weather|temperature|forecast|today|now|right now|currently|raining|how hot|how cold)\b/g,
            " ",
          ),
        )
  )
    .replace(/[.,]+$/, "")
    .trim();
  if (place.length < 2) return null;

  const geocode = async (name: string) => {
    const geo = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,
    );
    return geo?.results?.[0];
  };

  // Some PH localities are geocoded under their bare name rather than the
  // "___ City" form people actually say (e.g. Open-Meteo/GeoNames has
  // "Danao", not "Danao City", while it does have "Baguio City" verbatim) —
  // retry once with a trailing "city" dropped before giving up.
  let spot = await geocode(place);
  if (!spot?.latitude && /\bcity$/i.test(place)) {
    spot = await geocode(place.replace(/\s*\bcity$/i, "").trim());
  }
  if (!spot?.latitude) return null;

  const weather = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}&longitude=${spot.longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`,
  );
  const current = weather?.current;
  if (!current || typeof current.temperature_2m !== "number") return null;

  const where = [spot.name, spot.admin1, spot.country].filter(Boolean).join(", ");
  const condition = WMO_CODES[current.weather_code] ?? "unknown conditions";
  const answer =
    `Current weather in ${where}: ${condition}, ${Math.round(current.temperature_2m)}°C ` +
    `(feels like ${Math.round(current.apparent_temperature)}°C), ` +
    `humidity ${Math.round(current.relative_humidity_2m)}%, ` +
    `wind ${Math.round(current.wind_speed_10m)} km/h. Observed ${current.time} local time.`;

  return {
    answer,
    sourceLabel: "Open-Meteo",
    sourceUrl: "https://open-meteo.com",
    provider: "open-meteo",
    cacheable: false,
  };
};

// ── Wiktionary (definitions) ─────────────────────────────────────────────

const lookupDictionary = async (
  prompt: string,
): Promise<GeneralKnowledgeAnswer | null> => {
  const lower = prompt.toLowerCase().trim();
  let word: string | null = null;

  const define = lower.match(/^(?:define|definition of|meaning of|what is the meaning of)\s+(.+?)[?.!]*$/);
  const mean = lower.match(/^what does\s+(.+?)\s+mean[?.!]*$/);
  if (define) word = define[1];
  else if (mean) word = mean[1];
  if (!word) return null;

  word = word.replace(/^(a|an|the)\s+/, "").replace(/["']/g, "").trim();
  if (!word || /\s{2,}/.test(word) || word.split(/\s+/).length > 3) return null;

  const data = await fetchJson(
    `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`,
  );
  const entries = Array.isArray(data?.en) ? data.en : [];
  if (entries.length === 0) return null;

  const blocks: string[] = [];
  for (const entry of entries) {
    const defs = Array.isArray(entry?.definitions) ? entry.definitions : [];
    const lines = defs
      .map((d: any) => htmlToText(String(d?.definition || "")))
      .filter(Boolean)
      .map((line: string, index: number) => `${index + 1}. ${line}`);
    if (lines.length > 0) {
      blocks.push(`${entry.partOfSpeech || "definition"}:\n${lines.join("\n")}`);
    }
  }
  if (blocks.length === 0) return null;

  return {
    answer: `${word} —\n${blocks.join("\n\n")}`,
    sourceLabel: "Wiktionary",
    sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
    provider: "wiktionary",
    cacheable: true,
  };
};

// ── Wikipedia ───────────────────────────────────────────────────────────

type WikipediaHit = { title: string; extract: string; url: string };

type SearchCandidate = {
  title: string;
  snippet: string;
};

// MediaWiki flags a disambiguation page ("Python" -> "Python may refer
// to:...") with this pageprops key. Without the check, that list of links
// gets served as though it were an answer whenever a bare ambiguous word
// ("python", "mercury", "amazon") is the best title match.
const isDisambiguationPage = (pageprops: unknown): boolean =>
  !!pageprops && typeof pageprops === "object" && "disambiguation" in pageprops;

const SEARCH_LIMIT = 10;
const CANDIDATES_TO_OPEN = 5;

const PENALTY_PATTERNS = [
  /^list of\b/i,
  /^timeline of\b/i,
  /\bpunishment\b/i,
  /\bcontroversy\b/i,
  /\bin popular culture\b/i,
  /\bdiscography\b/i,
  /\bfilmography\b/i,
  /\bcrime in\b/i,
  /\(film\b/i,
  /\(soundtrack\b/i,
  /\(video game\b/i,
];

/**
 * Wikipedia's full-text search with snippet retrieval.
 * MediaWiki ranks by BM25 relevance across article text, while snippets
 * highlight matched keywords in context.
 */
const searchWikipedia = async (query: string): Promise<SearchCandidate[]> => {
  const data = await fetchJson(
    `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
      `&list=search&srnamespace=0&srlimit=${SEARCH_LIMIT}` +
      `&srsearch=${encodeURIComponent(query)}`,
  );
  const results = data?.query?.search;
  if (!Array.isArray(results)) return [];
  return results
    .map((row: any) => ({
      title: String(row?.title || ""),
      snippet: String(row?.snippet || ""),
    }))
    .filter((c) => Boolean(c.title));
};

const fetchExtract = async (
  title: string,
): Promise<{ extract: string; isDisambiguation: boolean } | null> => {
  const extractData = await fetchJson(
    `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
      `&prop=extracts%7Cpageprops&exintro&explaintext&redirects=1` +
      `&titles=${encodeURIComponent(title)}`,
  );
  const pages = extractData?.query?.pages;
  const first = pages ? (Object.values(pages)[0] as any) : null;
  if (!first) return null;
  return {
    extract: String(first.extract || "").trim(),
    isDisambiguation: isDisambiguationPage(first.pageprops),
  };
};

/**
 * Score search candidates combining:
 * 1. Stemmed title subject matching (e.g. "bones" <=> "bone", "invented" <=> "invention").
 * 2. Question keyword coverage.
 * 3. Search snippet matching (detects answer context within the article).
 * 4. Primary canonical topic preference over media adaptations / spin-offs.
 * 5. Head-noun alignment (prevents "Ocean sunfish" from beating "Pacific Ocean").
 * 6. Native BM25 search ranking.
 * 7. Down-ranking meta/list/controversy/punishment pages.
 */
const scoreCandidate = (
  candidate: SearchCandidate,
  rank: number,
  questionWords: string[],
) => {
  const folded = foldAccents(candidate.title).toLowerCase();
  const qualifierStart = folded.indexOf("(");
  const subject = qualifierStart === -1 ? folded : folded.slice(0, qualifierStart);
  const qualifier = qualifierStart === -1 ? "" : folded.slice(qualifierStart);

  const words = (value: string) =>
    value
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOPWORDS.has(word));

  const subjectWords = words(subject);
  const subjectStems = subjectWords.map(stemWord);
  const qualifierWords = words(qualifier);
  const qualifierStems = qualifierWords.map(stemWord);

  const qStems = questionWords.map(stemWord);
  const qStemSet = new Set(qStems);

  const matchedSubjectStems = subjectStems.filter((s) => qStemSet.has(s));
  const matchedQualifierStems = qualifierStems.filter((s) => qStemSet.has(s));
  const totalMatchedStems = new Set([...matchedSubjectStems, ...matchedQualifierStems]).size;

  const subjectCoverage = subjectWords.length > 0 ? matchedSubjectStems.length / subjectWords.length : 0;
  const questionCoverage = questionWords.length > 0 ? totalMatchedStems / questionWords.length : 0;

  const cleanSnippet = htmlToText(candidate.snippet).toLowerCase();
  const snippetWords = words(cleanSnippet);
  const snippetStems = new Set(snippetWords.map(stemWord));
  const snippetMatchedCount = qStems.filter((s) => snippetStems.has(s)).length;
  const snippetCoverage = questionWords.length > 0 ? snippetMatchedCount / questionWords.length : 0;

  let penalty = 0;
  for (const pat of PENALTY_PATTERNS) {
    if (pat.test(candidate.title)) {
      penalty += 6.0;
    }
  }

  // Primary topic bonus: unadorned titles without parentheses are the primary encyclopedic topic
  const primaryTopicBonus = qualifier ? 0 : 1.5;

  // Compound noun penalty: e.g. "Ocean sunfish" uses "ocean" as an adjective for "sunfish"
  let headNounAdjustment = 0;
  const lastSubjectStem = subjectStems[subjectStems.length - 1];
  if (subjectStems.length > 1 && qStemSet.has(subjectStems[0]) && !qStemSet.has(lastSubjectStem)) {
    headNounAdjustment = -4.0;
  }

  const rankBonus = (SEARCH_LIMIT - rank) * 0.3;

  const finalScore =
    matchedSubjectStems.length * 3.0 +
    questionCoverage * 2.5 +
    subjectCoverage * 2.0 +
    snippetCoverage * 5.0 +
    primaryTopicBonus +
    headNounAdjustment +
    rankBonus -
    penalty;

  return { finalScore };
};

/**
 * Search, re-rank candidates, and open candidates best-first.
 * Takes the first valid non-disambiguation article.
 */
const bestWikipediaArticle = async (query: string): Promise<WikipediaHit | null> => {
  const candidates = await searchWikipedia(query);
  if (candidates.length === 0) return null;

  const questionWords = contentWords(query);
  const ranked = candidates
    .map((candidate, rank) => ({
      ...candidate,
      rank,
      ...scoreCandidate(candidate, rank, questionWords),
    }))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, CANDIDATES_TO_OPEN);

  for (const candidate of ranked) {
    const page = await fetchExtract(candidate.title);
    if (!page || page.isDisambiguation || !page.extract) continue;
    return {
      title: candidate.title,
      extract: page.extract,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(candidate.title.replace(/ /g, "_"))}`,
    };
  }
  return null;
};

/**
 * Extracts the first 2 to 3 sentences from a Wikipedia lead section.
 * Preserves common abbreviations (e.g. "U.S.", "Dr.", "approx.") and
 * author/personal initials (e.g. "J. K. Rowling") without splitting prematurely.
 */
export const extractLeadingSentences = (
  text: string,
  targetCount = 3,
): string => {
  const cleaned = text.trim();
  if (!cleaned) return "";

  const protectedText = cleaned
    .replace(/\b([A-Z])\./g, "$1__INIT__")
    .replace(/\b(e\.g|i\.e|u\.s|u\.k|dr|mr|mrs|ms|st|prof|approx|est|vs|etc|al)\./gi, "$1__DOT__")
    .replace(/(\d+)\.(\d+)/g, "$1__DEC__$2");

  const rawSentences = protectedText
    .split(/(?<=[.?!])(?:\s+|\n+)(?=[A-Z0-9"'(])/g)
    .map((s) =>
      s
        .replace(/__INIT__/g, ".")
        .replace(/__DOT__/g, ".")
        .replace(/__DEC__/g, ".")
        .trim(),
    )
    .filter(Boolean);

  if (rawSentences.length <= 2) {
    return rawSentences.join(" ");
  }

  const firstTwo = rawSentences.slice(0, 2).join(" ");
  // If first 2 sentences already provide a substantial explanation (>= 220 chars),
  // stop at 2 sentences for mobile readability; otherwise take 3 sentences.
  if (firstTwo.length >= 220 || rawSentences.length === 2) {
    return firstTwo;
  }

  return rawSentences.slice(0, Math.min(targetCount, rawSentences.length)).join(" ");
};

/**
 * The catch-all: anything the currency/weather/dictionary providers didn't
 * claim. Searches with natural question first to preserve prepositional context,
 * falling back to stripped filler words if needed.
 */
const lookupWikipedia = async (
  prompt: string,
): Promise<GeneralKnowledgeAnswer | null> => {
  const cleanPrompt = prompt.replace(/[?]+$/, "").trim();
  const stripped = stripFiller(prompt);
  if (cleanPrompt.length < 2) return null;

  let hit = await bestWikipediaArticle(cleanPrompt);
  if (!hit && stripped.length >= 2 && stripped !== cleanPrompt) {
    hit = await bestWikipediaArticle(stripped);
  }
  if (!hit) return null;

  const conciseAnswer = extractLeadingSentences(hit.extract, 3);

  return {
    answer: conciseAnswer || hit.extract,
    // Kept on the record (and in the Firestore cache) for provenance even
    // though the chatbot reply itself no longer prints a citation line.
    sourceLabel: `Wikipedia — ${hit.title}`,
    sourceUrl: hit.url,
    provider: "wikipedia",
    cacheable: true,
  };
};

/**
 * True when the prompt unmistakably matches the currency, weather, or
 * dictionary trigger above — the three providers that hit APIs other than
 * Wikipedia and so still need a phrasing pattern to be recognised.
 *
 * Used by the caller to rescue such a question from the source router's
 * blind spots: the router is retrained periodically and lags behind
 * capabilities added here, so it has no signal for "define X" phrasing, for
 * instance. Kept deliberately narrow — it can only ever ADD a question to
 * the general branch, never take a campus question away from its own
 * handler, and the words it keys on ("forex", "exchange rate", "define")
 * do not appear in ordinary BondED questions.
 */
export function hasGeneralKnowledgeTrigger(prompt: string): boolean {
  const lower = prompt.toLowerCase().trim();
  return (
    /\b(exchange rate|convert|currency|forex|how much is)\b/.test(lower) ||
    /\b[a-z]{3}\s+(to|in|into|vs)\s+[a-z]{3}\b/.test(lower) ||
    /\b(weather|temperature|forecast|how hot|how cold|is it raining|raining)\b/.test(lower) ||
    /^(?:define|definition of|meaning of|what is the meaning of)\s+\S/.test(lower) ||
    /^what does\s+.+\s+mean[?.!]*$/.test(lower)
  );
}

/**
 * Try each provider from most-specific trigger to the Wikipedia catch-all.
 * The first three return null without a network call when their trigger
 * doesn't match; Wikipedia takes everything else. Returns the first full
 * answer found, or null.
 */
export async function lookupGeneralKnowledge(
  prompt: string,
): Promise<GeneralKnowledgeAnswer | null> {
  const clean = prompt.trim();
  if (clean.length < 3) return null;

  return (
    (await lookupFx(clean)) ||
    (await lookupWeather(clean)) ||
    (await lookupDictionary(clean)) ||
    (await lookupWikipedia(clean)) ||
    null
  );
}

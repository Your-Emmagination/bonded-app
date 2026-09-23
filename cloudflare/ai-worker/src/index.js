import {
  handleAnnouncementBroadcast,
  handlePushNotificationRequest,
} from "./push.js";
import { checkKeywordFlags } from "./keywordModeration.js";
import { checkLinkFlags } from "./linkModeration.js";
import { checkAccountPassword } from "./accountSetup.js";
import { issueAgoraToken } from "./agoraToken.js";
import {
  PRIVATE_PROFILE_FIELDS,
  isPersonalEmail,
  planPrivateProfileMove,
} from "./privateProfile.js";

const OPENMODERATION_API_URL = "https://api.openmoderation.com/v1/moderation";
const DEFAULT_OPENMODERATION_PROVIDER = "openai";
const DEFAULT_OPENMODERATION_MODEL = "omni-moderation-latest";
const DEFAULT_OPENMODERATION_THRESHOLD = 0.5;

// These are review thresholds applied to category scores returned by
// OpenModeration. A lower threshold for high-risk school-safety categories
// helps catch contextual NSFW/threat/self-harm content even when the
// provider's single overall `flagged` boolean is false. Unknown categories
// keep the provider/global 0.5 threshold.
//
// As of the keyword backstop (see keywordModeration.js), OpenModeration is
// no longer the ONLY signal for text moderation — a small, explicit keyword
// list runs alongside it for terms where policy is "flag regardless of
// context" (currently: weapons). These thresholds still govern everything
// OpenModeration itself scores; they're unrelated to the keyword list.
const OPENMODERATION_CATEGORY_REVIEW_THRESHOLDS = Object.freeze({
  sexual: 0.08,
  "sexual/minors": 0.01,
  harassment: 0.35,
  "harassment/threatening": 0.15,
  hate: 0.3,
  "hate/threatening": 0.15,
  illicit: 0.3,
  "illicit/violent": 0.15,
  "self-harm": 0.2,
  "self-harm/intent": 0.08,
  "self-harm/instructions": 0.08,
  violence: 0.3,
  "violence/graphic": 0.15,
});

// Plain-language names for the categories the providers return. What the
// model calls "sexual" at 0.734 confidence is, to a teacher reading the
// moderation queue, simply "Sexual content" — the vendor's name, its score
// and our internal threshold are ours to tune, not theirs to read. Items
// moderated before this existed still have the raw text saved on them and
// are cleaned up at display time (see utils/moderationReasons.ts).
const MODERATION_CATEGORY_LABELS = Object.freeze({
  sexual: "Sexual content",
  "sexual/minors": "Sexual content involving a minor",
  harassment: "Harassment",
  "harassment/threatening": "Threatening harassment",
  hate: "Hate speech",
  "hate/threatening": "Threatening hate speech",
  illicit: "Illicit activity",
  "illicit/violent": "Violent illicit activity",
  "self-harm": "Self-harm",
  "self-harm/intent": "Self-harm intent",
  "self-harm/instructions": "Self-harm instructions",
  violence: "Violence",
  "violence/graphic": "Graphic violence",
  nudity: "Nudity",
  weapon: "Weapon",
  recreational_drug: "Drugs",
  medical: "Medical or drug imagery",
  gore: "Graphic content",
  offensive: "Offensive symbol",
});

function moderationCategoryLabel(category) {
  const raw = String(category || "")
    .trim()
    .toLowerCase()
    .replace(/^sightengine:/, "");
  if (!raw) return "";
  return (
    MODERATION_CATEGORY_LABELS[raw] ||
    raw.replace(/[_/]/g, " ").replace(/^./, (character) => character.toUpperCase())
  );
}

// "image" -> "Image", for the front of a media reason.
const capitalizeLabel = (value) =>
  String(value || "").replace(/^./, (character) => character.toUpperCase());

const REVIEWER_ROLES = new Set(["teacher", "moderator", "admin"]);
const TEXT_MODERATION_BYPASS_ROLES = new Set(["teacher", "moderator", "admin"]);

function normalizeAppRole(value) {
  if (typeof value === "number") {
    return ({ 1: "student", 2: "teacher", 3: "moderator", 4: "admin" })[value] || "student";
  }

  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "1") return "student";
  if (normalized === "2") return "teacher";
  if (normalized === "3") return "moderator";
  if (normalized === "4") return "admin";
  if (["student", "teacher", "moderator", "admin"].includes(normalized)) {
    return normalized;
  }
  return "student";
}

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...buildCorsHeaders(init.headers?.["Access-Control-Allow-Origin"]),
      ...(init.headers || {}),
    },
  });

function buildCorsHeaders(allowedOrigin = "*") {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function normalizeCategoryName(value) {
  return String(value || "").trim().toLowerCase();
}

function canonicalModerationCategory(value) {
  const raw = normalizeCategoryName(value)
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");

  if (raw.includes("sexual") && raw.includes("minor")) return "sexual/minors";
  if (raw.includes("self-harm") && raw.includes("intent")) return "self-harm/intent";
  if (raw.includes("self-harm") && (raw.includes("instruction") || raw.includes("instructions"))) {
    return "self-harm/instructions";
  }
  if (raw.includes("harassment") && (raw.includes("threat") || raw.includes("threatening"))) {
    return "harassment/threatening";
  }
  if (raw.includes("hate") && (raw.includes("threat") || raw.includes("threatening"))) {
    return "hate/threatening";
  }
  if (raw.includes("illicit") && raw.includes("violent")) return "illicit/violent";
  if (raw.includes("violence") && raw.includes("graphic")) return "violence/graphic";
  if (raw.includes("self-harm")) return "self-harm";
  if (raw.includes("sexual")) return "sexual";
  if (raw.includes("harassment")) return "harassment";
  if (raw.includes("hate")) return "hate";
  if (raw.includes("illicit")) return "illicit";
  if (raw.includes("violence")) return "violence";
  return raw.replace(/-\/-|\/-/g, "/");
}

function categoryReviewThreshold(category, fallbackThreshold) {
  const canonical = canonicalModerationCategory(category);
  const configured = OPENMODERATION_CATEGORY_REVIEW_THRESHOLDS[canonical];
  return Number.isFinite(configured) ? configured : fallbackThreshold;
}

function isSelfHarmCategory(category) {
  return canonicalModerationCategory(category).startsWith("self-harm");
}

// ── Image / video moderation ─────────────────────────────────────────────
// Same provider, key, model and category thresholds as text moderation —
// OpenModeration accepts an `attachment: { type, url }` alongside `input`,
// so no new vendor or secret. A student post/comment with media is approved
// only when BOTH its text AND every attachment come back clean; anything
// flagged (or any failure to check) holds the item as pending for review.
const VIDEO_FRAME_OFFSETS_SECONDS = [0, 3, 7];

// Turn a Cloudinary video URL into a still-frame JPEG URL at a start offset.
// Returns null for anything that isn't a Cloudinary video upload URL.
function cloudinaryVideoFrameUrl(url, offsetSeconds) {
  const marker = "/video/upload/";
  const at = String(url).indexOf(marker);
  if (at === -1) return null;
  const head = url.slice(0, at + marker.length);
  const tail = url.slice(at + marker.length).replace(/\.[a-z0-9]+(\?|$)/i, ".jpg$1");
  return `${head}so_${offsetSeconds},w_640,h_640,c_limit/${tail}`;
}

function mediaKindOf(file) {
  const mime = String(file?.mimeType || file?.type || "").toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  return /\.(mp4|mov|m4v|webm|avi|mkv|3gp)(\?|$)/i.test(String(file?.url || file || ""))
    ? "video"
    : "image";
}

// The visual media on a document that a student upload needs checked.
function collectModeratableMedia(collectionName, content) {
  if (collectionName === "polls") {
    return content.imageUrl
      ? [{ url: String(content.imageUrl).trim(), kind: "image" }]
      : [];
  }
  const files = Array.isArray(content.files) ? content.files : [];
  return files
    .map((file) => {
      const url = String(file?.url || file || "").trim();
      return url ? { url, kind: mediaKindOf(file) } : null;
    })
    .filter(Boolean);
}

// OpenAI's own moderation endpoint, called directly. Documented to analyse
// `image_url` inputs with omni-moderation-latest and free to call. Used for
// image attachments (and sampled video frames, which are images) whenever
// OPENAI_API_KEY is set in the Worker, because it is guaranteed to actually
// look at the pixels — the OpenModeration proxy's `attachment` handling
// depends on the configured provider/plan. Raw (non-Cloudinary) video still
// goes through the proxy.
async function moderateImageDirectOpenAI(env, imageUrl) {
  const model = String(env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL).trim();
  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input: [{ type: "image_url", image_url: { url: String(imageUrl) } }],
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.error ||
        `OpenAI moderation request failed (${response.status}).`,
    );
  }
  const result = Array.isArray(payload?.results) ? payload.results[0] : null;
  if (!result) throw new Error("OpenAI moderation returned no result.");
  const scores = result.category_scores || {};
  return {
    providerFlagged: result.flagged === true,
    scored: Object.keys(scores).map((category) => ({
      category,
      score: Number(scores[category]) || 0,
    })),
  };
}

// One OpenModeration call for a single attachment URL (0 = image, 1 = video).
async function moderateAttachmentWithOpenModeration(env, url, attachmentType, scope) {
  if (!env.OPENMODERATION_API_KEY) {
    throw new Error("Missing OPENMODERATION_API_KEY in Worker environment.");
  }
  const provider = String(
    env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER,
  ).trim();
  const model = String(env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL).trim();
  const thresholdRaw = Number(
    env.OPENMODERATION_THRESHOLD ?? DEFAULT_OPENMODERATION_THRESHOLD,
  );
  const threshold = Number.isFinite(thresholdRaw)
    ? Math.min(1, Math.max(0, thresholdRaw))
    : DEFAULT_OPENMODERATION_THRESHOLD;

  if (attachmentType === 0 && env.OPENAI_API_KEY) {
    const direct = await moderateImageDirectOpenAI(env, url);
    const scored = direct.scored
      .map((item) => ({
        category: item.category,
        score: item.score,
        reviewThreshold: categoryReviewThreshold(item.category, threshold),
        flagged: false,
      }))
      .filter((item) => item.category && Number.isFinite(item.score));
    const flaggedCategories = scored.filter(
      (item) => item.score >= item.reviewThreshold,
    );
    return {
      flagged: direct.providerFlagged || flaggedCategories.length > 0,
      flaggedCategories,
      scored,
    };
  }

  const response = await fetch(OPENMODERATION_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENMODERATION_API_KEY}`,
    },
    body: JSON.stringify({
      // `input` is a required field; there is no caption to judge here.
      input: "[media attachment]",
      attachment: { type: attachmentType, url: String(url) },
      moderation: { provider, model },
      threshold,
      persist: false,
      metadata: scope ? { scope: String(scope) } : undefined,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.error ||
      payload?.message ||
      `OpenModeration attachment request failed (${response.status}).`;
    throw new Error(String(message));
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  const scored = results
    .map((result) => {
      const category = String(result?.category || result?.name || "unknown").trim();
      const score = Number(result?.score ?? result?.confidence ?? 0);
      return {
        category,
        score,
        reviewThreshold: categoryReviewThreshold(category, threshold),
        flagged: result?.flagged === true,
      };
    })
    .filter((result) => result.category && Number.isFinite(result.score));

  const providerFlagged = payload?.flagged === true || payload?.is_flagged === true;
  const flaggedCategories = scored.filter(
    (result) => result.flagged || result.score >= result.reviewThreshold,
  );

  return {
    flagged: providerFlagged || flaggedCategories.length > 0,
    flaggedCategories,
    scored,
  };
}

// Full media decision for one document. NEVER throws: a check that can't be
// completed fails closed (status "pending"), never open.
async function moderateMediaWithOpenModeration(env, media, scope) {
  if (!Array.isArray(media) || media.length === 0) {
    return { status: "approved", reasons: [], categories: [] };
  }

  // Flatten to concrete image URLs; a Cloudinary video becomes sampled frames.
  const targets = [];
  for (const item of media) {
    if (item.kind === "video") {
      const frames = VIDEO_FRAME_OFFSETS_SECONDS.map((offset) => ({
        url: cloudinaryVideoFrameUrl(item.url, offset),
        type: 0,
        label: `video frame @${offset}s`,
      })).filter((frame) => frame.url);
      if (frames.length > 0) {
        targets.push(...frames);
      } else {
        // Non-Cloudinary video we can't sample — ask the provider directly.
        targets.push({ url: item.url, type: 1, label: "video" });
      }
    } else {
      targets.push({ url: item.url, type: 0, label: "image" });
    }
  }

  const reasons = [];
  const categories = new Set();
  let selfHarm = false;

  try {
    for (const target of targets) {
      const res = await moderateAttachmentWithOpenModeration(
        env,
        target.url,
        target.type,
        scope,
      );
      if (!res.flagged) continue;
      res.flaggedCategories.forEach((c) => categories.add(c.category));
      if (res.flaggedCategories.some((c) => isSelfHarmCategory(c.category))) {
        selfHarm = true;
      }
      reasons.push(
        `${capitalizeLabel(target.label)}: ${
          [
            ...new Set(
              res.flaggedCategories
                .slice(0, 4)
                .map((c) => moderationCategoryLabel(c.category))
                .filter(Boolean),
            ),
          ].join(", ") || "Flagged for review"
        }`,
      );
    }
  } catch (error) {
    return {
      status: "pending",
      reasons: [
        `Media moderation could not complete (${String(error?.message || error).slice(0, 160)}). This ${scope || "content"} requires review.`,
      ],
      categories: [],
      selfHarm: false,
    };
  }

  if (reasons.length > 0) {
    return {
      status: "pending",
      reasons: reasons.slice(0, 6),
      categories: [...categories],
      selfHarm,
      priority: selfHarm ? "critical" : "normal",
    };
  }
  return { status: "approved", reasons: [], categories: [] };
}


// -- Sightengine (weapons / drugs / hate symbols) ------------------------
// A second image layer for exactly the categories OpenAI's moderation model
// has NO class for. It runs alongside moderateMediaWithOpenModeration, not
// instead of it: OpenAI still covers sexual / violence / graphic / self-harm
// on images, Sightengine adds weapon / recreational_drug / medical /
// offensive (nazi, confederate, supremacist, terrorist symbols, gestures).
//
// Additive: if SIGHTENGINE_API_USER / SIGHTENGINE_API_SECRET are not set,
// this layer is skipped and the OpenAI layer still runs. If they ARE set but
// a check fails, it fails closed (pending), same as the OpenAI layer.
//
// Free tier is 2,000 operations/month and one operation is one model on one
// image/frame -- so "weapon,recreational_drug,medical,offensive" is 4 ops
// per image and 12 per video (3 frames). Trim SIGHTENGINE_MODELS to stretch
// it.
const SIGHTENGINE_CHECK_URL = "https://api.sightengine.com/1.0/check.json";
const DEFAULT_SIGHTENGINE_MODELS = "weapon,recreational_drug,medical,offensive";
const DEFAULT_SIGHTENGINE_THRESHOLD = 0.35;
// Per-signal review thresholds. Hate symbols and weapons are held on a very
// low score on purpose; a photo of pills is more ambiguous so it sits
// higher.
const SIGHTENGINE_SIGNAL_THRESHOLDS = Object.freeze({
  weapon: 0.3,
  recreational_drug: 0.4,
  medical: 0.5,
  offensive: 0.3,
});
// Signals that page a reviewer immediately (same policy the text keyword
// backstop applies to weapons).
const SIGHTENGINE_CRITICAL_SIGNALS = new Set(["weapon", "offensive"]);

function sightengineConfigured(env) {
  return Boolean(env.SIGHTENGINE_API_USER && env.SIGHTENGINE_API_SECRET);
}

// A Sightengine model result is a number, or { prob }, or { classes: {...} },
// or a flat map of named probabilities. Reduce any of those to a single max.
function sightengineSignalScore(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value || typeof value !== "object") return 0;
  let max = 0;
  if (typeof value.prob === "number") max = Math.max(max, value.prob);
  const nested =
    value.classes && typeof value.classes === "object" ? value.classes : value;
  for (const [key, score] of Object.entries(nested)) {
    if (key === "prob" || key === "classes") continue;
    if (typeof score === "number" && Number.isFinite(score)) {
      max = Math.max(max, score);
    }
  }
  return max;
}

async function checkFrameWithSightengine(env, imageUrl, models) {
  const params = new URLSearchParams({
    url: String(imageUrl),
    models,
    api_user: String(env.SIGHTENGINE_API_USER),
    api_secret: String(env.SIGHTENGINE_API_SECRET),
  });
  const response = await fetch(`${SIGHTENGINE_CHECK_URL}?${params.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status === "failure") {
    const message =
      payload?.error?.message ||
      payload?.error ||
      `Sightengine request failed (${response.status}).`;
    throw new Error(String(message));
  }

  const thresholdFallback = Number(
    env.SIGHTENGINE_THRESHOLD ?? DEFAULT_SIGHTENGINE_THRESHOLD,
  );
  const flags = [];
  for (const model of models.split(",").map((m) => m.trim()).filter(Boolean)) {
    const score = sightengineSignalScore(payload?.[model]);
    const threshold = Number.isFinite(SIGHTENGINE_SIGNAL_THRESHOLDS[model])
      ? SIGHTENGINE_SIGNAL_THRESHOLDS[model]
      : Number.isFinite(thresholdFallback)
        ? thresholdFallback
        : DEFAULT_SIGHTENGINE_THRESHOLD;
    if (score >= threshold) flags.push({ signal: model, score, threshold });
  }
  return flags;
}

async function moderateMediaWithSightengine(env, media, scope) {
  if (!Array.isArray(media) || media.length === 0 || !sightengineConfigured(env)) {
    return { status: "approved", reasons: [], categories: [] };
  }

  const models = String(env.SIGHTENGINE_MODELS || DEFAULT_SIGHTENGINE_MODELS).trim();

  const targets = [];
  for (const item of media) {
    if (item.kind === "video") {
      const frames = VIDEO_FRAME_OFFSETS_SECONDS.map((offset) => ({
        url: cloudinaryVideoFrameUrl(item.url, offset),
        label: `video frame @${offset}s`,
      })).filter((frame) => frame.url);
      // A non-Cloudinary video cannot be sampled into frames here; the OpenAI
      // layer still sends it as a video attachment.
      targets.push(...frames);
    } else {
      targets.push({ url: item.url, label: "image" });
    }
  }
  if (targets.length === 0) {
    return { status: "approved", reasons: [], categories: [] };
  }

  const reasons = [];
  const categories = new Set();
  let critical = false;

  try {
    for (const target of targets) {
      const flags = await checkFrameWithSightengine(env, target.url, models);
      for (const flag of flags) {
        categories.add(`sightengine:${flag.signal}`);
        if (SIGHTENGINE_CRITICAL_SIGNALS.has(flag.signal)) critical = true;
      }
      if (flags.length > 0) {
        reasons.push(
          `${capitalizeLabel(target.label)}: ${[
            ...new Set(
              flags
                .slice(0, 4)
                .map((f) => moderationCategoryLabel(f.signal))
                .filter(Boolean),
            ),
          ].join(", ")}`,
        );
      }
    }
  } catch (error) {
    return {
      status: "pending",
      reasons: [
        `Sightengine media check could not complete (${String(error?.message || error).slice(0, 160)}). This ${scope || "content"} requires review.`,
      ],
      categories: [],
      selfHarm: false,
    };
  }

  if (reasons.length > 0) {
    return {
      status: "pending",
      reasons: reasons.slice(0, 6),
      categories: [...categories],
      selfHarm: false,
      priority: critical ? "critical" : "normal",
    };
  }
  return { status: "approved", reasons: [], categories: [] };
}

// Run both image layers and combine: approved only if BOTH are clean; held
// for review if EITHER flags (or fails while configured).
async function moderateMedia(env, media, scope) {
  const [openModeration, sightengine] = await Promise.all([
    moderateMediaWithOpenModeration(env, media, scope),
    moderateMediaWithSightengine(env, media, scope),
  ]);

  if (
    openModeration.status === "approved" &&
    sightengine.status === "approved"
  ) {
    return { status: "approved", reasons: [], categories: [] };
  }

  return {
    status: "pending",
    reasons: [
      ...(openModeration.reasons || []),
      ...(sightengine.reasons || []),
    ].slice(0, 8),
    categories: [
      ...new Set([
        ...(openModeration.categories || []),
        ...(sightengine.categories || []),
      ]),
    ],
    selfHarm:
      openModeration.selfHarm === true || sightengine.selfHarm === true,
    priority:
      openModeration.priority === "critical" ||
      sightengine.priority === "critical"
        ? "critical"
        : "normal",
  };
}

async function moderateTextWithOpenModeration(env, text, scope) {
  // Nothing to moderate (e.g. an image-only post with no caption) — the text
  // dimension is clean by definition. Any media is checked separately by the
  // caller before this runs.
  if (!String(text || "").trim()) {
    return {
      status: "approved",
      reasons: [],
      categories: [],
      selfHarm: false,
      priority: "normal",
      model: String(env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL),
      provider: String(env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER),
      threshold: DEFAULT_OPENMODERATION_THRESHOLD,
      moderationId: null,
      ruleSource: "ai",
    };
  }
  if (!env.OPENMODERATION_API_KEY) {
    throw new Error("Missing OPENMODERATION_API_KEY in Worker environment.");
  }

  const provider = String(
    env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER,
  ).trim();
  const model = String(env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL).trim();
  const thresholdRaw = Number(
    env.OPENMODERATION_THRESHOLD ?? DEFAULT_OPENMODERATION_THRESHOLD,
  );
  const threshold = Number.isFinite(thresholdRaw)
    ? Math.min(1, Math.max(0, thresholdRaw))
    : DEFAULT_OPENMODERATION_THRESHOLD;

  const response = await fetch(OPENMODERATION_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENMODERATION_API_KEY}`,
    },
    body: JSON.stringify({
      input: String(text || ""),
      moderation: { provider, model },
      // OpenModeration remains the source of all category scores; this
      // threshold maps its provider output to approved vs human-review
      // pending. (A separate keyword check also runs on this same text —
      // see the merge below and keywordModeration.js.)
      threshold,
      persist: false,
      metadata: scope ? { scope: String(scope) } : undefined,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.error ||
      payload?.message ||
      `OpenModeration request failed (${response.status}).`;
    throw new Error(String(message));
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  const scored = results
    .map((result) => {
      const category = String(result?.category || result?.name || "unknown").trim();
      const score = Number(result?.score ?? result?.confidence ?? 0);
      return {
        category,
        canonicalCategory: canonicalModerationCategory(category),
        score,
        flagged: result?.flagged === true,
        reviewThreshold: categoryReviewThreshold(category, threshold),
      };
    })
    .filter((result) => result.category && Number.isFinite(result.score));

  const providerFlagged = payload?.flagged === true || payload?.is_flagged === true;
  const flaggedCategories = scored.filter(
    (result) => result.flagged || result.score >= result.reviewThreshold,
  );

  if (results.length === 0 && !providerFlagged) {
    throw new Error("OpenModeration returned no moderation results.");
  }

  const aiFlagged = providerFlagged || flaggedCategories.length > 0;
  const aiCategories = flaggedCategories.map((result) => result.category);
  const aiSelfHarm = aiCategories.some(isSelfHarmCategory);

  // Deterministic keyword backstop, layered ON TOP of OpenModeration — see
  // keywordModeration.js. OpenModeration judges context/intent; this catches
  // school-safety terms (currently: weapons) that BondED's policy is "flag
  // regardless of context," which a context-aware AI score can legitimately
  // miss for a short, unthreatening-sounding mention.
  const keywordResult = checkKeywordFlags(text);

  // Link rules, layered the same way — see linkModeration.js. OpenModeration
  // scores what the words mean and has nothing to say about where a URL
  // leads, so a phishing post reading "enrollment is open!" is clean text
  // pointing somewhere it should not. This reads the destinations instead.
  const linkResult = checkLinkFlags(text);

  const isFlagged = aiFlagged || keywordResult.flagged || linkResult.flagged;
  const categories = [
    ...aiCategories,
    ...keywordResult.matches.map((match) => `keyword:${match.category}`),
    ...linkResult.matches.map((match) => `link:${match.category}`),
  ];
  // Either signal is enough. OpenModeration scores context but is English-
  // first, so "gusto ko na mamatay" can fall under its threshold; the keyword
  // list covers that phrasing and nothing else covers the model's reach into
  // English the list will never match. Whichever fires, the student sees
  // SafetyDialog.
  const selfHarm = aiSelfHarm || keywordResult.selfHarm === true;
  const priority =
    selfHarm ||
    keywordResult.priority === "critical" ||
    linkResult.priority === "critical"
      ? "critical"
      : "normal";

  // These strings are written to Firestore and read by teachers in the
  // moderation queue, so they say what was found in plain words — no vendor
  // name, no confidence score, no threshold.
  const reasons = [];
  if (flaggedCategories.length > 0) {
    const labels = [
      ...new Set(
        flaggedCategories
          .slice(0, 5)
          .map((result) => moderationCategoryLabel(result.category))
          .filter(Boolean),
      ),
    ];
    if (labels.length > 0) reasons.push(labels.join(", "));
  }
  if (reasons.length === 0 && providerFlagged) {
    reasons.push("Flagged for review");
  }
  if (keywordResult.matches.length > 0) {
    // Grouped by category so a moderator reads one line per kind of match
    // rather than one line per word.
    const termsByLabel = new Map();
    keywordResult.matches.forEach((match) => {
      if (!termsByLabel.has(match.label)) termsByLabel.set(match.label, new Set());
      termsByLabel.get(match.label).add(match.term);
    });
    termsByLabel.forEach((terms, label) => {
      reasons.push(`${label}: ${[...terms].map((term) => `“${term}”`).join(", ")}`);
    });
  }
  if (linkResult.matches.length > 0) {
    // One line per kind of problem, naming the host, so a moderator can
    // decide from the queue without opening the link.
    const hostsByLabel = new Map();
    linkResult.matches.forEach((match) => {
      if (!hostsByLabel.has(match.label)) hostsByLabel.set(match.label, new Set());
      hostsByLabel.get(match.label).add(match.host);
    });
    hostsByLabel.forEach((hosts, label) => {
      reasons.push(`${label}: ${[...hosts].join(", ")}`);
    });
  }

  // Category scores come from OpenModeration; the keyword list is a
  // separate, deterministic check layered on top — see keywordModeration.js.
  // Either one alone is enough to send content to pending.
  if (scored.length > 0 || keywordResult.matches.length > 0 || linkResult.matches.length > 0) {
    console.log(
      "[Moderation] OpenModeration scores:",
      scored
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((item) =>
          `${item.category}=${item.score.toFixed(3)} (review>=${item.reviewThreshold.toFixed(3)})`,
        )
        .join(", ") || "(none)",
      "| Keyword matches:",
      keywordResult.matches.map((match) => match.term).join(", ") || "(none)",
      "| Link matches:",
      linkResult.matches.map((match) => `${match.category}:${match.host}`).join(", ") || "(none)",
    );
  }

  const ruleSource =
    aiFlagged && (keywordResult.flagged || linkResult.flagged)
      ? "ai+keyword"
      : keywordResult.flagged || linkResult.flagged
        ? "keyword"
        : "ai";

  return {
    status: isFlagged ? "pending" : "approved",
    reasons,
    categories,
    selfHarm,
    priority,
    model: String(payload?.model || model),
    provider: String(payload?.provider || provider),
    threshold,
    moderationId: payload?.id ? String(payload.id) : null,
    ruleSource,
  };
}

let firebaseTokenCache = null;
let firebaseTokenExpires = 0;

const b64url = (bytes) => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

async function firebaseAccessToken(env) {
  if (firebaseTokenCache && Date.now() < firebaseTokenExpires - 60000) {
    return firebaseTokenCache;
  }
  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new Error("Missing Firebase service-account Worker secrets.");
  }

  const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n").replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
    "",
  );
  const raw = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    raw.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: env.FIREBASE_CLIENT_EMAIL,
      scope:
        "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${head}.${claim}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned),
  );
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(new Uint8Array(sig))}`,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || "Firebase service authentication failed.");
  }
  firebaseTokenCache = payload.access_token;
  firebaseTokenExpires = Date.now() + Number(payload.expires_in || 3600) * 1000;
  return firebaseTokenCache;
}

async function lookupFirebaseUser(env, idToken) {
  if (!env.FIREBASE_WEB_API_KEY) {
    throw new Error("Missing FIREBASE_WEB_API_KEY Worker secret.");
  }
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(
      env.FIREBASE_WEB_API_KEY,
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.users?.[0]?.localId) {
    throw new Error("Invalid or expired Firebase ID token.");
  }
  return payload.users[0];
}

async function verifyFirebaseUser(env, idToken) {
  return (await lookupFirebaseUser(env, idToken)).localId;
}

const fsValue = (v) => {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return !!v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(fsValue);
  if (v.mapValue) {
    return Object.fromEntries(
      Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fsValue(x)]),
    );
  }
  if (v.nullValue !== undefined) return null;
  return null;
};

const fsDoc = (d) =>
  Object.fromEntries(Object.entries(d?.fields || {}).map(([k, v]) => [k, fsValue(v)]));

const toFs = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  return {
    mapValue: {
      fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])),
    },
  };
};

const firestoreUrl = (env, path = "") =>
  `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    env.FIREBASE_PROJECT_ID,
  )}/databases/(default)/documents${path}`;

async function firestore(env, path, options = {}) {
  const token = await firebaseAccessToken(env);
  const response = await fetch(firestoreUrl(env, path), {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Firestore request failed (${response.status}).`);
  }
  return payload;
}

// `removeFields` are deleted: in the update mask but not in the body.
async function patchFirestore(env, collectionName, id, fields, removeFields = []) {
  const params = new URLSearchParams();
  Object.keys(fields).forEach((k) => params.append("updateMask.fieldPaths", k));
  removeFields.forEach((k) => params.append("updateMask.fieldPaths", k));
  return firestore(env, `/${collectionName}/${encodeURIComponent(id)}?${params}`, {
    method: "PATCH",
    body: JSON.stringify({
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFs(v)])),
    }),
  });
}

async function createFirestore(env, collectionName, id, fields) {
  const path = id
    ? `/${collectionName}/${encodeURIComponent(id)}`
    : `/${collectionName}`;
  return firestore(env, path, {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify({
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFs(v)])),
    }),
  });
}

async function queryFirestore(env, collectionId, fieldPath, value) {
  const token = await firebaseAccessToken(env);
  const response = await fetch(firestoreUrl(env) + ":runQuery", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath },
            op: "EQUAL",
            value: toFs(value),
          },
        },
      },
    }),
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Firestore query failed (${response.status}).`);
  }
  return Array.isArray(payload)
    ? payload.filter((x) => x.document).map((x) => fsDoc(x.document))
    : [];
}

// ==========================================================================
// FIRESTORE SERVER-SIDE COUNT / PROJECTION (for the analytics rollup)
// ==========================================================================

// Shape a REST filter value. Date -> timestampValue; an already-shaped
// {stringValue|integerValue|...} object passes through; else via toFs().
function fsFilterValue(value) {
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (
    value &&
    typeof value === "object" &&
    ("stringValue" in value ||
      "integerValue" in value ||
      "doubleValue" in value ||
      "timestampValue" in value ||
      "booleanValue" in value)
  ) {
    return value;
  }
  return toFs(value);
}

// Build a structuredQuery `where` from [{ field, op, value }, ...] (AND-ed).
function fsWhere(filters) {
  const fieldFilters = filters.map(({ field, op, value }) => ({
    fieldFilter: { field: { fieldPath: field }, op, value: fsFilterValue(value) },
  }));
  if (fieldFilters.length === 0) return undefined;
  if (fieldFilters.length === 1) return fieldFilters[0];
  return { compositeFilter: { op: "AND", filters: fieldFilters } };
}

// Server-side COUNT — the Worker's getCountFromServer. Never downloads docs.
async function firestoreCount(env, collectionId, filters = []) {
  const token = await firebaseAccessToken(env);
  const where = fsWhere(filters);
  const response = await fetch(firestoreUrl(env) + ":runAggregationQuery", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredAggregationQuery: {
        aggregations: [{ alias: "count", count: {} }],
        structuredQuery: {
          from: [{ collectionId }],
          ...(where ? { where } : {}),
        },
      },
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error?.message || `Aggregation query failed (${response.status}).`,
    );
  }
  const row = (Array.isArray(payload) ? payload : []).find((x) => x.result);
  return Number(row?.result?.aggregateFields?.count?.integerValue || 0);
}

// Bounded field-projection read — ONLY the named fields, for docs matching
// `filters`. Used for the distinct-author count where a COUNT can't help.
// Always scoped to a single day of content, so the payload stays small.
async function firestoreSelect(env, collectionId, fields, filters = [], max = 5000) {
  const token = await firebaseAccessToken(env);
  const where = fsWhere(filters);
  const response = await fetch(firestoreUrl(env) + ":runQuery", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        ...(where ? { where } : {}),
        select: { fields: fields.map((fieldPath) => ({ fieldPath })) },
        limit: max,
      },
    }),
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(
      payload?.error?.message || `Select query failed (${response.status}).`,
    );
  }
  return (Array.isArray(payload) ? payload : [])
    .filter((x) => x.document)
    .map((x) => fsDoc(x.document));
}

async function resolveTextModerationRole(env, userId) {
  const uid = String(userId || "").trim();
  if (!uid) return "student";

  // The role is resolved from trusted Firestore data. We intentionally ignore
  // any role supplied by the React Native client so a student cannot spoof a
  // staff role to bypass text moderation. Unknown/missing profiles fail safe
  // to student and therefore still go through OpenModeration.
  const byUserId = await queryFirestore(env, "students", "userId", uid);
  const byUid = byUserId.length > 0
    ? []
    : await queryFirestore(env, "students", "uid", uid);
  let profile = byUserId[0] || byUid[0] || null;

  if (!profile) {
    try {
      profile = fsDoc(
        await firestore(env, `/students/${encodeURIComponent(uid)}`),
      );
    } catch (_) {
      profile = null;
    }
  }

  return normalizeAppRole(profile?.role);
}

function shouldRunStudentTextModeration(role) {
  return !TEXT_MODERATION_BYPASS_ROLES.has(normalizeAppRole(role));
}

async function approveStaffTextBypass(env, collectionName, documentId) {
  await patchFirestore(env, collectionName, documentId, {
    moderationStatus: "approved",
    moderationReasons: [],
    moderationCategories: [],
    moderationPriority: "normal",
    moderationSafetyType: null,
    moderatedAtMs: Date.now(),
    moderationModel: null,
    moderationProvider: null,
    moderationRuleSource: "staff-role-bypass",
    moderationRequestId: null,
  });

  return {
    status: "approved",
    reasons: [],
    categories: [],
    selfHarm: false,
    priority: "normal",
    moderationSource: "staff-role-bypass",
    model: null,
    provider: null,
    ruleSource: "staff-role-bypass",
  };
}

async function listReviewerProfiles(env) {
  const roleProfiles = await Promise.all(
    [...REVIEWER_ROLES].map((role) => queryFirestore(env, "students", "role", role)),
  );
  const unique = new Map();
  roleProfiles.flat().forEach((profile) => {
    const key = String(profile.userId || profile.uid || profile.email || "").trim();
    if (key) unique.set(key, profile);
  });
  return [...unique.values()];
}

function notificationEntityTypeForCollection(collectionName) {
  if (collectionName === "comments") return "comment";
  if (collectionName === "replies") return "reply";
  return "post";
}

async function createCriticalReviewerAlerts(
  env,
  collectionName,
  documentId,
  content,
  safetyType,
) {
  const authorId = String(content.realUserId || content.userId || "");
  const reviewers = await listReviewerProfiles(env);
  const entityType = notificationEntityTypeForCollection(collectionName);
  const contentLabel =
    collectionName === "communityThreadMessages"
      ? "server message"
      : collectionName === "polls"
        ? "poll"
        : collectionName.endsWith("s")
          ? collectionName.slice(0, -1)
          : collectionName;

  const wording = SAFETY_ALERT_WORDING[safetyType];
  const alertMessage = wording
    ? `Priority safety review: ${wording} a ${contentLabel}.`
    : `Priority safety review: a ${contentLabel} was flagged for urgent review.`;

  await Promise.all(
    reviewers.map(async (reviewer) => {
      const recipientId = String(reviewer.userId || reviewer.uid || "").trim();
      if (!recipientId || recipientId === authorId) return;

      const safeRecipient = recipientId.replace(/[/.#$[\]]/g, "_");
      const safeDocument = String(documentId).replace(/[/.#$[\]]/g, "_");
      const notificationId = `safety_${collectionName}_${safeDocument}_${safeRecipient}`;

      await createFirestore(env, "notifications", notificationId, {
        recipientId,
        actorId: "moderation-system",
        actorName: "BondED Safety",
        actorProfileImage: null,
        actorIsAnonymous: false,
        type: "moderation",
        entityType,
        entityId: String(documentId),
        parentId: "moderation-queue",
        message: alertMessage,
        preview: "Open the moderation queue to review this safety alert.",
        read: false,
        createdAt: new Date().toISOString(),
        priority: "critical",
      });
    }),
  );
}

async function runApprovedPostSideEffects(env, postId, post) {
  const tagged = Array.isArray(post.taggedUsers) ? post.taggedUsers : [];
  const actorId = String(post.realUserId || "");
  const actorName = post.isAnonymous
    ? String(post.anonymousHandle || post.username || "Anonymous").replace(
        /^Anonymous\s+([1-9][0-9]{3,4})$/,
        "Anonymous$1",
      )
    : String(post.authorName || post.username || "Someone");
  const recipients = new Set(
    tagged
      .map((x) => String(x?.id || ""))
      .filter(
        (x) =>
          x && x !== actorId && x !== "ai-assistant" && x !== "everyone-mention",
      ),
  );

  if (tagged.some((x) => String(x?.id || "") === "everyone-mention")) {
    if (post.serverId) {
      const memberships = await queryFirestore(
        env,
        "communityServerMemberships",
        "serverId",
        post.serverId,
      );
      memberships.forEach((x) => {
        if (x.userId && String(x.status || "joined") !== "removed") {
          recipients.add(String(x.userId));
        }
      });
      try {
        const server = fsDoc(
          await firestore(env, `/communityServers/${encodeURIComponent(post.serverId)}`),
        );
        if (server.ownerId || server.createdBy) {
          recipients.add(String(server.ownerId || server.createdBy));
        }
      } catch (_) {}
    } else {
      const students = await firestore(env, "/students");
      (students.documents || []).forEach((d) => {
        const x = fsDoc(d);
        const id = String(x.userId || "");
        if (id) recipients.add(id);
      });
    }
  }

  recipients.delete(actorId);

  const preview = String(post.content || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 117);
  await Promise.all(
    [...recipients].map((recipientId) => {
      const safe = recipientId.replace(/[/.#$[\]]/g, "_");
      const actorSafe = actorId.replace(/[/.#$[\]]/g, "_");
      const notificationId = `mention_${safe}_${actorSafe}_${postId}`;
      return createFirestore(env, "notifications", notificationId, {
        recipientId,
        actorId,
        actorName,
        actorProfileImage: null,
        actorIsAnonymous: !!post.isAnonymous,
        type: "mention",
        entityType: "post",
        entityId: postId,
        parentId: null,
        message: "mentioned you in a post",
        preview: preview || null,
        read: false,
        createdAt: new Date().toISOString(),
      });
    }),
  );

  // @BondedAI replies remain non-generative and are produced by the React
  // Native chatbot only after this worker returns approved.
}

function extractContentText(collectionName, content) {
  if (collectionName === "polls") {
    return [
      String(content.question || "").trim(),
      ...(Array.isArray(content.options)
        ? content.options.map((option) => String(option?.text || "").trim())
        : []),
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (collectionName === "posts") {
    // The attached link is a separate field from the body. Appending it means
    // link rules see the URL a student deliberately attached — previously the
    // only URL in a post that moderation could not read.
    return [
      String(content.content || "").trim(),
      String(content.link?.url || "").trim(),
      String(content.link?.title || "").trim(),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    String(content.text || "").trim(),
    String(content.link?.url || "").trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

function hasMediaRequiringSeparateReview(collectionName, content, callerRole = "student") {
  // The role comes from trusted Firestore data resolved from the authenticated
  // Firebase UID. Authorized staff bypass media moderation for posts, polls,
  // comments, replies, and community/server messages. Students keep the
  // existing media-review behavior unchanged.
  if (!shouldRunStudentTextModeration(callerRole)) return false;

  if (collectionName === "polls") return Boolean(content.imageUrl);

  const files = Array.isArray(content.files) ? content.files : [];
  return files.length > 0;
}

// Why an item jumped the queue, in terms a reviewer can act on. Every
// critical item used to be labelled "weapon" unless it was self-harm, so an
// offensive photo or an adult link reached reviewers announced as a weapon.
// The categories already say which check fired; this reads them.
//
//   self-harm        keyword or model self-harm signal
//   weapon-term      the weapons keyword list matched the text
//   weapon-image     Sightengine saw a weapon in an image or video
//   offensive-image  Sightengine saw an offensive gesture or symbol
//   adult-link       a link to an adult site
//   flagged          critical for some other reason
function criticalSafetyType(decision) {
  if (decision.selfHarm === true) return "self-harm";
  const categories = Array.isArray(decision.categories) ? decision.categories : [];
  if (categories.includes("keyword:weapons")) return "weapon-term";
  if (categories.includes("sightengine:weapon")) return "weapon-image";
  if (categories.includes("sightengine:offensive")) return "offensive-image";
  if (categories.includes("link:adult_link")) return "adult-link";
  return "flagged";
}

const SAFETY_ALERT_WORDING = {
  "self-harm": "possible self-harm/intent detected in",
  "weapon-term": "weapon-related term detected in",
  "weapon-image": "a weapon detected in an image in",
  "offensive-image": "an offensive image detected in",
  "adult-link": "a link to an adult site detected in",
};

async function applyModerationDecision(
  env,
  collectionName,
  documentId,
  content,
  decision,
) {
  const status = decision.status === "approved" ? "approved" : "pending";
  const selfHarm = decision.selfHarm === true;
  // decision.priority already accounts for both self-harm AND the keyword
  // backstop (see moderateTextWithOpenModeration) — recomputing it from
  // selfHarm alone here would silently drop keyword-triggered critical
  // priority before it ever reaches Firestore, which is exactly what used
  // to happen before this fix.
  const priority = decision.priority === "critical" ? "critical" : "normal";
  const safetyType =
    selfHarm || priority === "critical" ? criticalSafetyType(decision) : null;

  await patchFirestore(env, collectionName, documentId, {
    moderationStatus: status,
    moderationReasons: decision.reasons || [],
    moderationCategories: decision.categories || [],
    moderationPriority: priority,
    moderationSafetyType: safetyType,
    moderatedAtMs: Date.now(),
    moderationModel:
      decision.model || env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL,
    moderationProvider:
      decision.provider || env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER,
    moderationRuleSource: decision.ruleSource || "ai",
    moderationRequestId: decision.moderationId || null,
  });

  if (priority === "critical") {
    try {
      await createCriticalReviewerAlerts(env, collectionName, documentId, content, safetyType);
    } catch (error) {
      console.warn(
        `[Moderation] Failed to create critical reviewer alerts for ${collectionName}/${documentId}:`,
        error?.message || error,
      );
    }
  }

  return status;
}

async function moderateFirestoreContent(env, request, body) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!idToken) return json({ error: "Missing Firebase ID token." }, { status: 401 });

  const callerUid = await verifyFirebaseUser(env, idToken);
  const callerRole = await resolveTextModerationRole(env, callerUid);
  const collectionName = String(body?.collection || "").trim();
  const documentId = String(body?.documentId || "").trim();
  const scope = String(body?.scope || "general").trim();

  const supportedCollections = [
    "comments",
    "replies",
    "polls",
    "communityThreadMessages",
  ];
  if (!supportedCollections.includes(collectionName)) {
    return json(
      { error: `collection must be one of: ${supportedCollections.join(", ")}.` },
      { status: 400 },
    );
  }
  if (!documentId) return json({ error: "documentId is required." }, { status: 400 });

  const document = await firestore(
    env,
    `/${collectionName}/${encodeURIComponent(documentId)}`,
  );
  const content = fsDoc(document);
  const ownerId = String(content.realUserId || content.userId || "");
  if (ownerId !== callerUid) {
    return json({ error: "You are not allowed to moderate this content." }, { status: 403 });
  }

  if (String(content.moderationStatus || "pending") === "approved") {
    return json({
      status: "approved",
      reasons: [],
      categories: [],
      selfHarm: false,
      priority: "normal",
      moderationSource: "server",
    });
  }

  const text = extractContentText(collectionName, content);

  // Media (images/video) is checked with the same OpenModeration provider,
  // key and category thresholds as text. When text is also clean the item is
  // approved; anything flagged here (or a check that can't run) holds it for
  // review.
  if (hasMediaRequiringSeparateReview(collectionName, content, callerRole)) {
    const mediaDecision = await moderateMedia(
      env,
      collectModeratableMedia(collectionName, content),
      scope,
    );
    if (mediaDecision.status !== "approved") {
      await applyModerationDecision(env, collectionName, documentId, content, {
        ...mediaDecision,
        ruleSource: "ai",
        model: env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL,
        provider: env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER,
      });
      return json({
        status: "pending",
        reasons: mediaDecision.reasons,
        categories: mediaDecision.categories,
        selfHarm: mediaDecision.selfHarm === true,
        priority: mediaDecision.priority === "critical" ? "critical" : "normal",
        moderationSource: "media",
      });
    }
    // Media clean — continue to text moderation below.
  }

  // Student-only text moderation policy: teachers, moderators, and admins are
  // not sent to OpenModeration. The Worker still verifies their Firebase UID
  // and resolves the role from Firestore before approving the text.
  if (!shouldRunStudentTextModeration(callerRole)) {
    const bypassDecision = await approveStaffTextBypass(
      env,
      collectionName,
      documentId,
    );
    return json({ ...bypassDecision, role: callerRole });
  }

  let decision;
  try {
    decision = await moderateTextWithOpenModeration(env, text, scope);
  } catch (error) {
    console.warn(
      `[Moderation] ${collectionName} OpenModeration failed; keeping content pending:`,
      error?.message || error,
    );
    decision = {
      status: "pending",
      reasons: ["Automatic moderation could not complete. This content requires review."],
      categories: [],
      selfHarm: false,
      priority: "normal",
      model: env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL,
      provider: env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER,
    };
  }

  const status = await applyModerationDecision(
    env,
    collectionName,
    documentId,
    content,
    decision,
  );

  return json({
    status,
    reasons: decision.reasons || [],
    categories: decision.categories || [],
    selfHarm: decision.selfHarm === true,
    priority: decision.priority === "critical" ? "critical" : "normal",
    moderationSource: "openmoderation",
    model: decision.model || env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL,
    ruleSource: decision.ruleSource || "ai",
    provider:
      decision.provider || env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER,
  });
}

async function moderateFirestorePost(env, request, body) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!idToken) return json({ error: "Missing Firebase ID token." }, { status: 401 });

  const callerUid = await verifyFirebaseUser(env, idToken);
  const callerRole = await resolveTextModerationRole(env, callerUid);
  const postId = String(body?.postId || "").trim();
  if (!postId) return json({ error: "postId is required." }, { status: 400 });

  const document = await firestore(env, `/posts/${encodeURIComponent(postId)}`);
  const post = fsDoc(document);
  if (String(post.realUserId || post.userId || "") !== callerUid) {
    return json({ error: "You are not allowed to moderate this post." }, { status: 403 });
  }
  if (String(post.moderationStatus || "") === "approved") {
    return json({
      status: "approved",
      reasons: [],
      categories: [],
      selfHarm: false,
      priority: "normal",
      moderationSource: "server",
    });
  }

  if (hasMediaRequiringSeparateReview("posts", post, callerRole)) {
    const mediaDecision = await moderateMedia(
      env,
      collectModeratableMedia("posts", post),
      "post",
    );
    if (mediaDecision.status !== "approved") {
      await applyModerationDecision(env, "posts", postId, post, {
        ...mediaDecision,
        ruleSource: "ai",
        model: env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL,
        provider: env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER,
      });
      return json({
        status: "pending",
        reasons: mediaDecision.reasons,
        categories: mediaDecision.categories,
        selfHarm: mediaDecision.selfHarm === true,
        priority: mediaDecision.priority === "critical" ? "critical" : "normal",
        moderationSource: "media",
      });
    }
    // Media is clean — fall through to text moderation below. The post is
    // approved only if that also comes back clean.
  }

  if (!shouldRunStudentTextModeration(callerRole)) {
    const bypassDecision = await approveStaffTextBypass(env, "posts", postId);
    try {
      await runApprovedPostSideEffects(env, postId, post);
    } catch (error) {
      console.warn(
        "[Moderation] staff-bypass publication side effect failed:",
        error?.message || error,
      );
    }
    await patchFirestore(env, "posts", postId, {
      publishedSideEffectsAtMs: Date.now(),
      publishedSideEffectsAt: new Date().toISOString(),
    }).catch(() => undefined);
    return json({ ...bypassDecision, role: callerRole });
  }

  let decision;
  try {
    decision = await moderateTextWithOpenModeration(env, extractContentText("posts", post), "post");
  } catch (error) {
    console.warn(
      "[Moderation] OpenModeration failed; keeping post pending:",
      error?.message || error,
    );
    decision = {
      status: "pending",
      reasons: ["Automatic moderation could not complete. This post requires review."],
      categories: [],
      selfHarm: false,
      priority: "normal",
      model: env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL,
      provider: env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER,
    };
  }

  const status = await applyModerationDecision(
    env,
    "posts",
    postId,
    post,
    decision,
  );

  if (status === "approved") {
    try {
      await runApprovedPostSideEffects(env, postId, post);
    } catch (error) {
      console.warn(
        "[Moderation] publication side effect failed:",
        error?.message || error,
      );
    }
    await patchFirestore(env, "posts", postId, {
      publishedSideEffectsAtMs: Date.now(),
      publishedSideEffectsAt: new Date().toISOString(),
    }).catch(() => undefined);
  }

  return json({
    status,
    reasons: decision.reasons || [],
    categories: decision.categories || [],
    selfHarm: decision.selfHarm === true,
    priority: decision.priority === "critical" ? "critical" : "normal",
    moderationSource: "openmoderation",
    model: decision.model || env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL,
    ruleSource: decision.ruleSource || "ai",
    provider:
      decision.provider || env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER,
  });
}

/* ==========================================================================
 * VIDEO CAPTIONS (speech-to-text via Groq Whisper)
 *
 * Triggered once, from the client, right after a video post is approved. The
 * actual transcription runs here (server-side) so the Groq key never ships
 * in the app bundle — same trust boundary as moderation. It runs in
 * ctx.waitUntil() so the client request returns immediately and video
 * publishing is never blocked on captions.
 *
 * COST: this bills per second of audio processed by Groq. Whisper large-v3
 * on Groq is cheaper than OpenAI's own Whisper endpoint and has a free tier,
 * but it is a real recurring per-video-minute operating cost.
 *
 * Fields written back to posts/{id}:
 *   captionStatus:   "pending" | "ready" | "unavailable"
 *   captions:        [{ start, end, text }]   (timed segments; [] when none)
 *   captionLanguage: Whisper's auto-detected language code (e.g. "en", "tl")
 * ========================================================================== */

const GROQ_TRANSCRIBE_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
// Default to the full multilingual model, not turbo: this student body speaks
// Taglish (code-switched Filipino/English) and large-v3 handles code-switch
// and non-English audio meaningfully better than the speed-tuned turbo model.
// Override with GROQ_TRANSCRIBE_MODEL if speed/cost matter more than accuracy.
const DEFAULT_TRANSCRIBE_MODEL = "whisper-large-v3";
// Groq's free tier caps uploads at 25MB; audio-only mp3 from Cloudinary is
// ~1MB/min, so this comfortably covers short feed clips.
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 120000;

function groqApiKey(env) {
  const raw = env.GROQ_API_KEY || env.GROQ_API_KEYS || "";
  // Support a comma/space-separated list (matches GROQ_API_KEYS naming) —
  // just use the first non-empty entry.
  const key = String(raw).split(/[\s,]+/).filter(Boolean)[0];
  if (!key) throw new Error("Missing GROQ_API_KEY Worker secret.");
  return key;
}

// Turn a Cloudinary video delivery URL into a small audio-only mp3 URL so the
// worker downloads ~1MB/min instead of the full video, and Groq gets a clean
// audio file. Non-Cloudinary URLs are returned unchanged (best effort).
function cloudinaryAudioUrl(url) {
  const marker = "/video/upload/";
  const i = url.indexOf(marker);
  if (i === -1) return url;
  const after = url.slice(i + marker.length);
  const firstSegment = after.split("/")[0];
  const alreadyTransformed = /(^|,)(w_|h_|c_|q_|f_|so_)/.test(firstSegment);
  const rest = alreadyTransformed
    ? after.slice(firstSegment.length + 1)
    : after;
  const withoutExt = rest.replace(/\.[a-zA-Z0-9]+$/, "");
  return `${url.slice(0, i)}${marker}f_mp3/${withoutExt}.mp3`;
}

async function runVideoTranscription(env, postId, videoUrl) {
  try {
    await patchFirestore(env, "posts", postId, { captionStatus: "pending" });

    const audioUrl = cloudinaryAudioUrl(videoUrl);
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) {
      throw new Error(`Audio fetch failed (${audioResp.status}).`);
    }
    const audioBlob = await audioResp.blob();
    if (audioBlob.size > MAX_AUDIO_BYTES) {
      throw new Error(
        `Audio too large for transcription (${audioBlob.size} bytes).`,
      );
    }

    const form = new FormData();
    form.append("file", audioBlob, "audio.mp3");
    form.append("model", env.GROQ_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL);
    // verbose_json is what carries the per-segment start/end timings we store.
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    // Deliberately NOT forcing language: an explicit "en" would mis-transcribe
    // the Filipino half of Taglish speech, and an explicit "tl" would mangle
    // the English half. Auto-detect is the least-bad option for code-switched
    // audio. GROQ_TRANSCRIBE_LANGUAGE can pin it if testing shows one is better.
    if (env.GROQ_TRANSCRIBE_LANGUAGE) {
      form.append("language", env.GROQ_TRANSCRIBE_LANGUAGE);
    }
    // A gentle vocabulary/style nudge toward code-switching.
    form.append(
      "prompt",
      "Casual conversation that may mix English and Filipino (Taglish).",
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    let payload;
    try {
      const groqResp = await fetch(GROQ_TRANSCRIBE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${groqApiKey(env)}` },
        body: form,
        signal: controller.signal,
      });
      payload = await groqResp.json().catch(() => null);
      if (!groqResp.ok) {
        throw new Error(
          payload?.error?.message || `Groq transcription failed (${groqResp.status}).`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }

    const segments = (Array.isArray(payload?.segments) ? payload.segments : [])
      .map((segment) => ({
        start: Number(segment?.start) || 0,
        end: Number(segment?.end) || 0,
        text: String(segment?.text || "").trim(),
      }))
      .filter((segment) => segment.text.length > 0);

    await patchFirestore(env, "posts", postId, {
      captions: segments,
      captionLanguage: payload?.language ? String(payload.language) : null,
      captionStatus: segments.length > 0 ? "ready" : "unavailable",
      captionedAtMs: Date.now(),
    });
  } catch (error) {
    console.warn(
      `[Captions] Transcription failed for posts/${postId}:`,
      error?.message || error,
    );
    // The video is untouched — it stays fully playable, just without captions.
    await patchFirestore(env, "posts", postId, {
      captionStatus: "unavailable",
      captionError: String(error?.message || error).slice(0, 300),
      captionedAtMs: Date.now(),
    }).catch(() => undefined);
  }
}

async function transcribeFirestoreVideo(env, request, body, ctx) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!idToken) return json({ error: "Missing Firebase ID token." }, { status: 401 });

  const callerUid = await verifyFirebaseUser(env, idToken);
  const postId = String(body?.postId || "").trim();
  if (!postId) return json({ error: "postId is required." }, { status: 400 });

  const post = fsDoc(
    await firestore(env, `/posts/${encodeURIComponent(postId)}`),
  );
  const ownerId = String(post.realUserId || post.userId || "");
  if (ownerId !== callerUid) {
    return json(
      { error: "You are not allowed to caption this post." },
      { status: 403 },
    );
  }

  // Idempotent: never re-transcribe (and re-bill) a post that's already done.
  if (post.captionStatus === "ready") {
    return json({ status: "ready" });
  }

  const files = Array.isArray(post.files) ? post.files : [];
  const video = files.find((file) =>
    String(file?.mimeType || "").startsWith("video/"),
  );
  if (!video?.url) {
    return json({ status: "no-video" });
  }

  // Fire-and-forget: respond now, transcribe in the background so the client
  // (and video publishing) is never blocked on it.
  ctx.waitUntil(runVideoTranscription(env, postId, String(video.url)));
  return json({ status: "processing" });
}

// ==========================================================================
// DAILY ANALYTICS ROLLUP
// ==========================================================================
//
// Firestore answers "how many X right now" (aggregation queries) but not
// "how many X existed on each of the last 30 days" after the fact. A Cron
// Trigger (see wrangler.toml [triggers]) runs runDailyRollup() once a day
// and writes one dailyStats/{YYYY-MM-DD} document so the Analytics screen
// can chart trends without ever scanning a whole collection.
//
// activeUsers definition — kept identical everywhere it's used: the number
// of DISTINCT author ids that created a post, poll or comment during that
// UTC day. It's a "contributors that day" count; a student who only
// read/scrolled is not counted, because there's no reliable per-day read
// signal to count them by.

const startOfUtcDay = (date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const utcDateId = (date) => startOfUtcDay(date).toISOString().slice(0, 10);

// Count distinct contributors in [start, end). Uses a field-projection read
// (author ids only) because COUNT can't do DISTINCT — bounded to one day.
async function countDistinctContributors(env, start, end) {
  const seen = new Set();
  const sources = [
    { collectionId: "posts", authorFields: ["realUserId", "userId"] },
    { collectionId: "polls", authorFields: ["userId", "realUserId"] },
    { collectionId: "comments", authorFields: ["userId", "realUserId"] },
  ];
  for (const { collectionId, authorFields } of sources) {
    const rows = await firestoreSelect(env, collectionId, authorFields, [
      { field: "createdAt", op: "GREATER_THAN_OR_EQUAL", value: start },
      { field: "createdAt", op: "LESS_THAN", value: end },
    ]);
    for (const row of rows) {
      const id = authorFields.map((field) => row[field]).find(Boolean);
      if (id) seen.add(String(id));
    }
  }
  return seen.size;
}

// Tally moderationCategories across the posts moderated in [start, end).
// Bounded field-projection read (categories array only) — one day of
// moderated posts. Feeds the Analytics "moderation reasons" bar chart, which
// sums this over a trailing window rather than scanning posts live. Stored
// as an array of { category, count } (not a map) so category strings like
// "self-harm/intent" or "keyword:weapons" need no key sanitizing.
async function tallyModerationCategories(env, start, end) {
  const rows = await firestoreSelect(env, "posts", ["moderationCategories"], [
    { field: "moderatedAtMs", op: "GREATER_THAN_OR_EQUAL", value: start.getTime() },
    { field: "moderatedAtMs", op: "LESS_THAN", value: end.getTime() },
  ]);
  const counts = new Map();
  for (const row of rows) {
    const categories = Array.isArray(row.moderationCategories)
      ? row.moderationCategories
      : [];
    for (const category of categories) {
      const key = String(category || "").trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count }));
}

// Compute every metric for the window [start, end). Moderation metrics are
// keyed off `moderatedAtMs` (when the decision landed that day), content
// metrics off `createdAt`.
async function computeDailyStats(env, dateId, start, end) {
  const createdWindow = [
    { field: "createdAt", op: "GREATER_THAN_OR_EQUAL", value: start },
    { field: "createdAt", op: "LESS_THAN", value: end },
  ];
  const moderatedWindow = (extra) => [
    ...extra,
    { field: "moderatedAtMs", op: "GREATER_THAN_OR_EQUAL", value: start.getTime() },
    { field: "moderatedAtMs", op: "LESS_THAN", value: end.getTime() },
  ];

  const [
    postsCreated,
    pollsCreated,
    commentsCreated,
    moderationPending,
    moderationApproved,
    moderationRejected,
    criticalFlags,
    reportsSubmitted,
    activeUsers,
    moderationCategoryCounts,
  ] = await Promise.all([
    firestoreCount(env, "posts", createdWindow),
    firestoreCount(env, "polls", createdWindow),
    firestoreCount(env, "comments", createdWindow),
    firestoreCount(
      env,
      "posts",
      moderatedWindow([{ field: "moderationStatus", op: "EQUAL", value: "pending" }]),
    ),
    firestoreCount(
      env,
      "posts",
      moderatedWindow([{ field: "moderationStatus", op: "EQUAL", value: "approved" }]),
    ),
    firestoreCount(
      env,
      "posts",
      moderatedWindow([{ field: "moderationStatus", op: "EQUAL", value: "rejected" }]),
    ),
    firestoreCount(
      env,
      "posts",
      moderatedWindow([
        { field: "moderationPriority", op: "EQUAL", value: "critical" },
      ]),
    ),
    firestoreCount(env, "reports", createdWindow),
    countDistinctContributors(env, start, end),
    tallyModerationCategories(env, start, end),
  ]);

  return {
    date: dateId,
    postsCreated,
    pollsCreated,
    commentsCreated,
    activeUsers,
    moderationPending,
    moderationApproved,
    moderationRejected,
    criticalFlags,
    reportsSubmitted,
    moderationCategoryCounts,
    computedAtMs: Date.now(),
  };
}

// Roll up one day and write dailyStats/{dateId}.
//   options.dateId   -> that whole UTC day (clamped to now if it's today)
//   options.mode="today" -> today so far (manual runs, for quick verification)
//   default (cron)   -> the day that just completed
async function runDailyRollup(env, options = {}) {
  const now = new Date();
  let dateId;
  let start;
  let end;
  let partial;

  if (options.dateId && /^\d{4}-\d{2}-\d{2}$/.test(options.dateId)) {
    dateId = options.dateId;
    start = new Date(`${dateId}T00:00:00.000Z`);
    end = new Date(start.getTime() + 86400000);
    if (end.getTime() > now.getTime()) {
      end = now;
      partial = true;
    } else {
      partial = false;
    }
  } else if (options.mode === "today") {
    start = startOfUtcDay(now);
    end = now;
    dateId = utcDateId(now);
    partial = true;
  } else {
    end = startOfUtcDay(now);
    start = new Date(end.getTime() - 86400000);
    dateId = utcDateId(start);
    partial = false;
  }

  const stats = await computeDailyStats(env, dateId, start, end);
  stats.partial = partial;
  stats.windowStartMs = start.getTime();
  stats.windowEndMs = end.getTime();
  await patchFirestore(env, "dailyStats", dateId, stats);
  return stats;
}


// ============================================================================
// PASSWORD RESET / RECOVERY EMAIL (6-digit code by email, via Resend)
// ============================================================================
// BondED accounts sign in with an ID and have a synthetic, undeliverable auth
// email ({id}@student.csap). Self-service reset therefore can't use Firebase's
// sendPasswordResetEmail. Instead:
//   1. The student adds + verifies a real recovery email in Profile
//      (recovery-email-start / recovery-email-confirm).
//   2. "Forgot password" emails a 6-digit code to that recovery email
//      (password-reset-start), the student enters code + new password
//      (password-reset-confirm), and the Worker sets the new password via the
//      Identity Toolkit admin API.
// Codes are stored only as a salted SHA-256 hash in authCodes/{codeId}
// (Worker-only collection), expire in 15 min, and lock after 5 wrong tries.

const AUTH_CODE_TTL_MS = 15 * 60 * 1000;
const AUTH_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
const AUTH_CODE_MAX_ATTEMPTS = 5;
const MIN_NEW_PASSWORD_LEN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SYNTHETIC_EMAIL_RE = /@(?:student|teacher|admin)\.csap$/i;

function sixDigitCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, "0");
}

async function hashAuthCode(env, uid, code) {
  const pepper = env.AUTH_CODE_PEPPER || env.FIREBASE_WEB_API_KEY || "bonded-auth-code";
  const bytes = new TextEncoder().encode(`${uid}:${String(code).trim()}:${pepper}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readFirestoreDocSafe(env, path) {
  try {
    return fsDoc(await firestore(env, path));
  } catch {
    return null;
  }
}

async function deleteFirestoreDoc(env, collectionName, id) {
  return firestore(env, `/${collectionName}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }).catch(() => null);
}

// Look up a student by the ID they type on the login / reset screen. The
// Firestore doc id is the raw studentID; try it as typed and lowercased.
async function resolveStudentByIdentifier(env, identifier) {
  const raw = String(identifier || "").trim();
  if (!raw) return null;
  for (const id of new Set([raw, raw.toLowerCase()])) {
    const doc = await readFirestoreDocSafe(env, `/students/${encodeURIComponent(id)}`);
    if (doc && (doc.userId || doc.uid)) {
      // The private record wins; a profile not moved yet still has these
      // on the public one.
      const secret = await readFirestoreDocSafe(env, `/studentPrivate/${encodeURIComponent(id)}`);
      const pick = (key) => (secret && secret[key] !== undefined ? secret[key] : doc[key]);
      return {
        studentID: id,
        uid: String(doc.userId || doc.uid),
        recoveryEmail: pick("recoveryEmail") ? String(pick("recoveryEmail")) : "",
        recoveryEmailVerified: pick("recoveryEmailVerified") === true,
        accountLocked: doc.accountLocked === true,
      };
    }
  }
  return null;
}

// Sends a transactional email through whichever provider is configured.
// Brevo is tried first (BREVO_API_KEY) because it works with a single
// click-verified sender and no domain; Resend (RESEND_API_KEY) is the
// fallback and is preferred once a domain is verified for better inbox
// delivery. Set one; the flow doesn't care which.
async function sendResetEmail(env, { to, subject, text }) {
  if (env.BREVO_API_KEY) {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: {
          email: env.BREVO_SENDER || "no-reply@bonded.app",
          name: env.BREVO_SENDER_NAME || "BondED",
        },
        to: [{ email: String(to) }],
        subject,
        textContent: text,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(
        payload?.message || `Brevo request failed (${response.status}).`,
      );
    }
    return;
  }

  if (env.RESEND_API_KEY) {
    const from = env.RESEND_FROM || "BondED <onboarding@resend.dev>";
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [String(to)], subject, text }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(
        payload?.message || `Resend request failed (${response.status}).`,
      );
    }
    return;
  }

  throw new Error("No email provider configured (set BREVO_API_KEY or RESEND_API_KEY).");
}

// Identity Toolkit admin: set a user's password by uid. Needs the OAuth token
// to carry the identitytoolkit scope (see firebaseAccessToken).
async function adminSetPassword(env, uid, newPassword) {
  const token = await firebaseAccessToken(env);
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(
      env.FIREBASE_PROJECT_ID,
    )}/accounts:update`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ localId: uid, password: newPassword }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.localId) {
    throw new Error(payload?.error?.message || `Password update failed (${response.status}).`);
  }
}

async function writeAuthCode(env, codeId, fields) {
  return firestore(env, `/authCodes/${encodeURIComponent(codeId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFs(v)])),
    }),
  });
}

// Saves someone's personal email and recovery details to their private
// record, and takes any copy off their public profile (students/{id}),
// which every signed-in user can read. The private record is written first,
// so nothing is lost if the second write fails. `publicUpdates` are other
// changes to the public profile, made in the same write.
async function savePrivateProfile(env, studentID, uid, fields, publicProfile, publicUpdates = {}) {
  await patchFirestore(env, "studentPrivate", studentID, {
    ...fields,
    userId: uid,
    updatedAt: new Date(),
  });
  const remove = PRIVATE_PROFILE_FIELDS.filter(
    (key) =>
      publicProfile?.[key] !== undefined &&
      !(key in publicUpdates) &&
      (key !== "email" || isPersonalEmail(publicProfile.email)),
  );
  if (remove.length || Object.keys(publicUpdates).length) {
    await patchFirestore(env, "students", studentID, publicUpdates, remove);
  }
}

// -- recovery-email-start : signed in, send a code to a new recovery email ----
async function handleRecoveryEmailStart(env, request, body) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!idToken) return json({ error: "Missing Firebase ID token." }, { status: 401 });

  const uid = await verifyFirebaseUser(env, idToken);
  const studentID = String(body?.studentID || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();

  if (!studentID) return json({ error: "studentID is required." }, { status: 400 });
  if (!EMAIL_RE.test(email) || SYNTHETIC_EMAIL_RE.test(email) || email.length > 200) {
    return json({ error: "Enter a valid personal email address." }, { status: 400 });
  }

  const student = await readFirestoreDocSafe(env, `/students/${encodeURIComponent(studentID)}`);
  if (!student || String(student.userId || student.uid || "") !== uid) {
    return json({ error: "Account mismatch." }, { status: 403 });
  }

  const codeId = `${uid}__recovery`;
  const existing = await readFirestoreDocSafe(env, `/authCodes/${encodeURIComponent(codeId)}`);
  if (existing && Date.now() - Number(existing.createdAtMs || 0) < AUTH_CODE_RESEND_COOLDOWN_MS) {
    return json({ error: "Please wait a minute before requesting another code." }, { status: 429 });
  }

  const code = sixDigitCode();
  try {
    await sendResetEmail(env, {
      to: email,
      subject: "BondED recovery email verification code",
      text:
        `Your BondED verification code is ${code}\n\n` +
        `Enter it in the app to confirm this recovery email. It expires in 15 minutes.\n` +
        `If you didn't request this, you can ignore this email.`,
    });
  } catch (error) {
    console.error("[auth] recovery-email send failed:", error?.message || error);
    return json({ error: "Could not send the verification email. Try again shortly." }, { status: 502 });
  }

  await writeAuthCode(env, codeId, {
    purpose: "recovery-email",
    uid,
    studentID,
    email,
    codeHash: await hashAuthCode(env, uid, code),
    attempts: 0,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + AUTH_CODE_TTL_MS,
  });

  return json({ ok: true });
}

// -- recovery-email-confirm : signed in, verify the code, save the email ------
async function handleRecoveryEmailConfirm(env, request, body) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!idToken) return json({ error: "Missing Firebase ID token." }, { status: 401 });

  const uid = await verifyFirebaseUser(env, idToken);
  const studentID = String(body?.studentID || "").trim();
  const code = String(body?.code || "").trim();
  if (!studentID || !/^\d{6}$/.test(code)) {
    return json({ error: "Enter the 6-digit code." }, { status: 400 });
  }

  const student = await readFirestoreDocSafe(env, `/students/${encodeURIComponent(studentID)}`);
  if (!student || String(student.userId || student.uid || "") !== uid) {
    return json({ error: "Account mismatch." }, { status: 403 });
  }

  const codeId = `${uid}__recovery`;
  const record = await readFirestoreDocSafe(env, `/authCodes/${encodeURIComponent(codeId)}`);
  if (!record || Date.now() > Number(record.expiresAtMs || 0)) {
    return json({ error: "That code has expired. Request a new one." }, { status: 400 });
  }
  if (Number(record.attempts || 0) >= AUTH_CODE_MAX_ATTEMPTS) {
    return json({ error: "Too many attempts. Request a new code." }, { status: 429 });
  }
  const matches = timingSafeEqualHex(
    String(record.codeHash || ""),
    await hashAuthCode(env, uid, code),
  );
  if (!matches) {
    await writeAuthCode(env, codeId, { attempts: Number(record.attempts || 0) + 1 });
    return json({ error: "Incorrect code." }, { status: 400 });
  }

  const verifiedEmail = String(record.email || "");
  await savePrivateProfile(
    env,
    studentID,
    uid,
    {
      email: verifiedEmail,
      recoveryEmail: verifiedEmail,
      recoveryEmailVerified: true,
      recoveryEmailVerifiedAt: new Date(),
    },
    student,
  );
  await deleteFirestoreDoc(env, "authCodes", codeId);

  return json({ ok: true, recoveryEmail: String(record.email || "") });
}

// -- password-reset-start : NOT signed in, email a reset code ----------------
// Always returns { ok: true } no matter what, so it can't be used to probe
// which IDs exist or which have a recovery email.
async function handlePasswordResetStart(env, request, body) {
  const identifier = String(body?.studentID || body?.identifier || "").trim();
  if (!identifier) return json({ error: "Enter your ID." }, { status: 400 });

  const student = await resolveStudentByIdentifier(env, identifier);
  // A locked account gets no code: it was locked because someone else may
  // have its email.
  if (
    student &&
    !student.accountLocked &&
    student.recoveryEmailVerified &&
    EMAIL_RE.test(student.recoveryEmail)
  ) {
    const codeId = `${student.uid}__pwreset`;
    const existing = await readFirestoreDocSafe(env, `/authCodes/${encodeURIComponent(codeId)}`);
    const onCooldown =
      existing && Date.now() - Number(existing.createdAtMs || 0) < AUTH_CODE_RESEND_COOLDOWN_MS;

    if (!onCooldown) {
      const code = sixDigitCode();
      try {
        await sendResetEmail(env, {
          to: student.recoveryEmail,
          subject: "BondED password reset code",
          text:
            `Your BondED password reset code is ${code}\n\n` +
            `Enter it in the app with your new password. It expires in 15 minutes.\n` +
            `If you didn't request a password reset, you can ignore this email.`,
        });
        await writeAuthCode(env, codeId, {
          purpose: "password-reset",
          uid: student.uid,
          studentID: student.studentID,
          codeHash: await hashAuthCode(env, student.uid, code),
          attempts: 0,
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + AUTH_CODE_TTL_MS,
        });
      } catch (error) {
        console.error("[auth] password-reset send failed:", error?.message || error);
      }
    }
  }

  return json({ ok: true });
}

// -- signin-help-request : NOT signed in, ask the school for help ------------
// Someone who can't sign in sends the school a request from the Sign-in Help
// screen. The Worker files it in the admins' support queue — the database
// itself stays closed to signed-out users — and limits how often it can be
// sent, per ID and per connection, so the queue can't be flooded. Admins
// reply by the email or phone left here, after confirming who it really is.
// The answer never says whether the ID exists.
const SIGNIN_HELP_PROBLEMS = {
  forgot_password: "Forgot password",
  no_recovery_email: "No recovery email",
  id_not_recognised: "ID not recognised",
  other: "Something else",
};
const SIGNIN_HELP_WINDOW_MS = 24 * 60 * 60 * 1000;
const SIGNIN_HELP_MAX_PER_ID = 3;
const SIGNIN_HELP_MAX_PER_CONNECTION = 10;

/** Counts one request against `key`; false once it has used up the day. */
async function takeSignInHelpSlot(env, key, max) {
  const id = key.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 140);
  const existing = await readFirestoreDocSafe(env, `/signInHelpLimits/${encodeURIComponent(id)}`);
  const now = Date.now();
  const windowStartMs = Number(existing?.windowStartMs || 0);
  const fresh = !existing || now - windowStartMs >= SIGNIN_HELP_WINDOW_MS;
  const count = fresh ? 0 : Number(existing.count || 0);
  if (count >= max) return false;
  await createFirestore(env, "signInHelpLimits", id, {
    windowStartMs: fresh ? now : windowStartMs,
    count: count + 1,
  });
  return true;
}

/**
 * The next "SR-00125" number, from the same counter the app uses, raised in
 * one atomic write. Falls back to a dated number, like the app does, so a
 * counter problem never stops a request being filed.
 */
async function nextSupportTicketNumber(env) {
  try {
    const token = await firebaseAccessToken(env);
    const base = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
    const response = await fetch(`https://firestore.googleapis.com/v1/${base}:commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        writes: [
          {
            transform: {
              document: `${base}/counters/supportTickets`,
              fieldTransforms: [{ fieldPath: "value", increment: { integerValue: "1" } }],
            },
          },
        ],
      }),
    });
    const payload = await response.json().catch(() => null);
    const result = payload?.writeResults?.[0]?.transformResults?.[0];
    const value = Number(result?.integerValue ?? result?.doubleValue);
    if (!response.ok || !Number.isFinite(value) || value <= 0) throw new Error("counter");
    return `SR-${String(Math.round(value)).padStart(5, "0")}`;
  } catch {
    const now = new Date();
    const stamp =
      `${String(now.getFullYear()).slice(2)}` +
      `${String(now.getMonth() + 1).padStart(2, "0")}` +
      `${String(now.getDate()).padStart(2, "0")}`;
    return `SR-${stamp}-${String(now.getTime() % 10000).padStart(4, "0")}`;
  }
}

async function handleSignInHelpRequest(env, request, body) {
  const studentID = String(body?.studentID || "").trim().slice(0, 40);
  const fullName = String(body?.fullName || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const contact = String(body?.contact || "").trim().slice(0, 120);
  const problem = Object.prototype.hasOwnProperty.call(SIGNIN_HELP_PROBLEMS, body?.problem)
    ? body.problem
    : "other";
  const message = String(body?.message || "").trim().slice(0, 600);

  if (studentID.length < 3) return json({ error: "Enter your ID." }, { status: 400 });
  if (fullName.length < 2) return json({ error: "Enter your full name." }, { status: 400 });
  const reachable =
    EMAIL_RE.test(contact) ||
    (/^[+\d][\d\s-]*$/.test(contact) && contact.replace(/\D/g, "").length >= 7);
  if (!reachable) {
    return json(
      { error: "Enter an email or phone number the school can reach you on." },
      { status: 400 },
    );
  }

  // One connection asking about many IDs is the flood to stop; one ID asked
  // about again and again is the other.
  const connection = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed =
    (await takeSignInHelpSlot(env, `ip_${connection}`, SIGNIN_HELP_MAX_PER_CONNECTION)) &&
    (await takeSignInHelpSlot(env, `id_${studentID.toLowerCase()}`, SIGNIN_HELP_MAX_PER_ID));
  if (!allowed) {
    return json(
      {
        error:
          "You've already sent several requests today. The school will contact you — or email or call them directly.",
      },
      { status: 429 },
    );
  }

  // For the admin only: whether the ID matches a real account, and whose.
  // Never sent back, so the form can't be used to find out which IDs exist.
  const account = await resolveStudentByIdentifier(env, studentID).catch(() => null);
  const profile = account
    ? await readFirestoreDocSafe(env, `/students/${encodeURIComponent(account.studentID)}`)
    : null;
  const accountName = profile
    ? `${profile.firstname || ""} ${profile.lastname || ""}`.trim() || null
    : null;

  const label = SIGNIN_HELP_PROBLEMS[problem];
  const ticketNo = await nextSupportTicketNumber(env);
  const now = new Date();
  await createFirestore(env, "supportTickets", null, {
    ticketNo,
    // No account is signed in; the app treats an empty userId with this
    // source as a sign-in request that can only be answered off the app.
    userId: "",
    userName: fullName,
    userRole: "signed out",
    userCourse: null,
    userYearLevel: null,
    userStudentId: studentID,
    category: "account",
    subject: `Sign-in help: ${label}`,
    description: message || label,
    source: "signin-help",
    contact,
    verified: false,
    accountFound: Boolean(account),
    accountName,
    accountRole: profile?.role ? String(profile.role) : null,
    status: "open",
    priority: "normal",
    assignedTo: null,
    assignedToName: null,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    lastMessagePreview: (message || label).slice(0, 120),
    unreadForUser: false,
    unreadForStaff: true,
    appVersion: typeof body?.appVersion === "string" ? body.appVersion.slice(0, 20) : null,
    platform: typeof body?.platform === "string" ? body.platform.slice(0, 20) : null,
    imageUrl: null,
    sourceQuestion: null,
  });

  return json({ ok: true, ticketNo });
}

// -- password-reset-confirm : NOT signed in, verify code, set new password ----
async function handlePasswordResetConfirm(env, request, body) {
  const identifier = String(body?.studentID || body?.identifier || "").trim();
  const code = String(body?.code || "").trim();
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!identifier || !/^\d{6}$/.test(code)) {
    return json({ error: "Invalid or expired code." }, { status: 400 });
  }
  if (newPassword.length < MIN_NEW_PASSWORD_LEN || newPassword.length > 4096) {
    return json(
      { error: `Password must be at least ${MIN_NEW_PASSWORD_LEN} characters.` },
      { status: 400 },
    );
  }
  if (!/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
    return json(
      {
        error:
          "Password must include at least one number and one special character.",
      },
      { status: 400 },
    );
  }

  const student = await resolveStudentByIdentifier(env, identifier);
  if (!student) return json({ error: "Invalid or expired code." }, { status: 400 });

  const codeId = `${student.uid}__pwreset`;
  const record = await readFirestoreDocSafe(env, `/authCodes/${encodeURIComponent(codeId)}`);
  if (!record || Date.now() > Number(record.expiresAtMs || 0)) {
    return json({ error: "Invalid or expired code." }, { status: 400 });
  }
  if (Number(record.attempts || 0) >= AUTH_CODE_MAX_ATTEMPTS) {
    return json({ error: "Too many attempts. Request a new code." }, { status: 429 });
  }
  const matches = timingSafeEqualHex(
    String(record.codeHash || ""),
    await hashAuthCode(env, student.uid, code),
  );
  if (!matches) {
    await writeAuthCode(env, codeId, { attempts: Number(record.attempts || 0) + 1 });
    return json({ error: "Incorrect code." }, { status: 400 });
  }

  try {
    await adminSetPassword(env, student.uid, newPassword);
    await patchFirestore(env, "students", student.studentID, {
      mustChangePassword: false,
      passwordCheckedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[auth] adminSetPassword failed:", error?.message || error);
    return json({ error: "Could not update the password. Please try again." }, { status: 502 });
  }
  await deleteFirestoreDoc(env, "authCodes", codeId);

  return json({ ok: true });
}

// -- admin-account-recovery : signed-in ADMIN, rescue someone's account -------
// For when someone has lost both their password and their recovery email —
// or someone else has taken the email. An admin, after confirming who the
// person is, can:
//   reset-password         set a random temporary password, shown to the
//                          admin once; it must be replaced on next sign-in
//   remove-recovery-email  drop the recovery email so no reset code can go
//                          to it; they add a new one on next sign-in
//   sign-out-all           end every session on every device
//   lock / unlock          block (or allow again) signing in at all
// Only the Worker can do these: they change the sign-in account itself,
// which the app can't touch. Every action is logged in accountRecoveryLog
// with who did it and when.
const ACCOUNT_RECOVERY_ACTIONS = new Set([
  "reset-password",
  "remove-recovery-email",
  "sign-out-all",
  "lock",
  "unlock",
]);

// No 0/O, 1/l/I: the admin may read it out over the phone.
const TEMPORARY_PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/** Three groups of four, e.g. "Hq7M-t4Rk-9wPe". About 69 bits of randomness. */
function temporaryPassword() {
  const alphabet = TEMPORARY_PASSWORD_ALPHABET;
  // Bytes at or above this would favour the first few characters.
  const unbiased = 256 - (256 % alphabet.length);
  for (;;) {
    const chars = [];
    while (chars.length < 12) {
      for (const byte of crypto.getRandomValues(new Uint8Array(24))) {
        if (byte < unbiased && chars.length < 12) chars.push(alphabet[byte % alphabet.length]);
      }
    }
    const password = [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)]
      .map((group) => group.join(""))
      .join("-");
    if (/[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password)) {
      return password;
    }
  }
}

/** The stored hash of the temporary password an admin last issued. */
const temporaryPasswordCodeId = (uid) => `${uid}__temppw`;

/**
 * Whether `password` is still the temporary one an admin issued. Called only
 * after Firebase has accepted the password, so any other password means the
 * temporary one has been replaced and its record can go.
 */
async function isTemporaryPassword(env, uid, password) {
  const codeId = temporaryPasswordCodeId(uid);
  const record = await readFirestoreDocSafe(env, `/authCodes/${encodeURIComponent(codeId)}`);
  if (!record?.codeHash) return false;
  const same = timingSafeEqualHex(String(record.codeHash), await hashAuthCode(env, uid, password));
  if (!same) await deleteFirestoreDoc(env, "authCodes", codeId);
  return same;
}

/** Changes the sign-in account itself: password, disabled, sessions. */
async function adminUpdateAccount(env, uid, changes) {
  const token = await firebaseAccessToken(env);
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(
      env.FIREBASE_PROJECT_ID,
    )}/accounts:update`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ localId: uid, ...changes }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.localId) {
    throw new Error(payload?.error?.message || `Account update failed (${response.status}).`);
  }
  return payload;
}

/** The profile of whoever is signed in behind an ID token's account. */
async function findProfileByAccount(env, account) {
  const uid = String(account?.localId || "");
  if (!uid) return null;
  for (const field of ["userId", "uid"]) {
    const found = await queryFirestore(env, "students", field, uid).catch(() => []);
    if (found[0]) return found[0];
  }
  const docId = String(account?.email || "").split("@")[0];
  const byEmail = docId
    ? await readFirestoreDocSafe(env, `/students/${encodeURIComponent(docId)}`)
    : null;
  return byEmail && String(byEmail.userId || byEmail.uid || "") === uid ? byEmail : null;
}

/**
 * Detaches every phone from the account's notifications. A phone that was
 * signed out — perhaps someone else's — must stop showing this person's
 * messages on its lock screen. Their own phones sign up again at sign-in.
 */
async function clearPushTokens(env, uid) {
  await patchFirestore(env, "userPushTokens", uid, {
    expoPushTokens: [],
    pushNotificationsUpdatedAt: new Date(),
  }).catch((error) => {
    console.warn("[recovery] could not clear push tokens:", error?.message || error);
  });
}

async function handleAdminAccountRecovery(env, request, body) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!idToken) return json({ error: "Sign in to continue." }, { status: 401 });

  const caller = await lookupFirebaseUser(env, idToken);
  const callerProfile = await findProfileByAccount(env, caller);
  if (!callerProfile || normalizeAppRole(callerProfile.role) !== "admin") {
    return json({ error: "Only administrators can do this." }, { status: 403 });
  }

  const action = String(body?.action || "");
  if (!ACCOUNT_RECOVERY_ACTIONS.has(action)) {
    return json({ error: "Unknown account recovery action." }, { status: 400 });
  }
  const studentID = String(body?.studentID || "").trim();
  if (!studentID) return json({ error: "Choose an account." }, { status: 400 });

  const target = await readFirestoreDocSafe(env, `/students/${encodeURIComponent(studentID)}`);
  const uid = String(target?.userId || target?.uid || "");
  if (!target || !uid) {
    return json({ error: "This account has no sign-in linked to it." }, { status: 404 });
  }
  // An admin locking or resetting themselves could lock the school out.
  if (uid === caller.localId) {
    return json(
      { error: "Use Settings for your own account. Another admin can do this for you." },
      { status: 400 },
    );
  }

  const now = new Date();
  const nowSeconds = String(Math.floor(now.getTime() / 1000));
  let temporary = null;

  try {
    if (action === "reset-password") {
      temporary = temporaryPassword();
      // Remembered (as a hash, never the password) before it's set, so the
      // sign-in check can never mistake it for one they chose.
      await writeAuthCode(env, temporaryPasswordCodeId(uid), {
        purpose: "temporary-password",
        uid,
        studentID,
        codeHash: await hashAuthCode(env, uid, temporary),
        createdAtMs: now.getTime(),
      });
      // A new password also ends every session, so whoever else was signed
      // in is out as well.
      await adminUpdateAccount(env, uid, { password: temporary, validSince: nowSeconds });
      await patchFirestore(env, "students", studentID, {
        mustChangePassword: true,
        passwordCheckedAt: now.toISOString(),
        sessionsRevokedAt: now,
      });
      await clearPushTokens(env, uid);
    } else if (action === "remove-recovery-email") {
      // The profile email goes back to the school sign-in address. The
      // person is asked to add and verify a new one when they next sign in.
      // Everyone is signed out first: whoever took the email may be signed
      // in, and would otherwise be asked to add an email right away — and
      // could simply add theirs again.
      await adminUpdateAccount(env, uid, { validSince: nowSeconds });
      let signInEmail = "";
      try {
        const token = await firebaseAccessToken(env);
        const response = await fetch(
          `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(
            env.FIREBASE_PROJECT_ID,
          )}/accounts:lookup`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ localId: [uid] }),
          },
        );
        const payload = await response.json().catch(() => null);
        signInEmail = String(payload?.users?.[0]?.email || "");
      } catch {
        signInEmail = "";
      }
      // The school sign-in address may go back on the public profile; an
      // account that signs in with a personal address keeps it private.
      await savePrivateProfile(
        env,
        studentID,
        uid,
        { email: "", recoveryEmail: "", recoveryEmailVerified: false, recoveryEmailVerifiedAt: null },
        target,
        {
          sessionsRevokedAt: now,
          ...(signInEmail && !isPersonalEmail(signInEmail) ? { email: signInEmail } : {}),
        },
      );
      await clearPushTokens(env, uid);
    } else if (action === "sign-out-all") {
      await adminUpdateAccount(env, uid, { validSince: nowSeconds });
      await patchFirestore(env, "students", studentID, { sessionsRevokedAt: now });
      await clearPushTokens(env, uid);
    } else if (action === "lock") {
      await adminUpdateAccount(env, uid, { disableUser: true, validSince: nowSeconds });
      await patchFirestore(env, "students", studentID, {
        accountLocked: true,
        accountLockedAt: now,
        sessionsRevokedAt: now,
      });
      await clearPushTokens(env, uid);
    } else if (action === "unlock") {
      await adminUpdateAccount(env, uid, { disableUser: false });
      await patchFirestore(env, "students", studentID, {
        accountLocked: false,
        accountLockedAt: null,
      });
    }
  } catch (error) {
    console.error(`[recovery] ${action} failed:`, error?.message || error);
    return json({ error: "Couldn't update the account. Please try again." }, { status: 502 });
  }

  // Any reset or verification code already sent — possibly to an email
  // someone else controls — stops working. Unlocking leaves them alone.
  if (action !== "unlock" && action !== "sign-out-all") {
    await deleteFirestoreDoc(env, "authCodes", `${uid}__pwreset`);
    await deleteFirestoreDoc(env, "authCodes", `${uid}__recovery`);
  }

  const name = (profile) =>
    `${profile?.firstname || ""} ${profile?.lastname || ""}`.trim() || null;
  await createFirestore(env, "accountRecoveryLog", null, {
    studentID,
    targetUid: uid,
    targetName: name(target),
    action,
    byUid: caller.localId,
    byStudentID: callerProfile.studentID ? String(callerProfile.studentID) : null,
    byName: name(callerProfile),
    at: now,
  }).catch((error) => {
    console.error("[recovery] could not write the log:", error?.message || error);
  });

  return json({ ok: true, action, ...(temporary ? { temporaryPassword: temporary } : {}) });
}

// -- migrate-private-profile : admin, move personal emails off public profiles
// Profiles saved before private records existed still carry the personal
// email on the public profile. This moves them, a few pages per call; the
// app calls again with `next` until `done`. Safe to run any number of times:
// a profile with nothing private left is skipped.
const PRIVATE_MIGRATION_PAGE = 200;
const PRIVATE_MIGRATION_MAX_PAGES = 8;

async function handleMigratePrivateProfile(env, request, body) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!idToken) return json({ error: "Sign in to continue." }, { status: 401 });

  const caller = await lookupFirebaseUser(env, idToken);
  const callerProfile = await findProfileByAccount(env, caller);
  if (!callerProfile || normalizeAppRole(callerProfile.role) !== "admin") {
    return json({ error: "Only administrators can do this." }, { status: 403 });
  }

  const token = await firebaseAccessToken(env);
  const base = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const api = (path, payload) =>
    fetch(`https://firestore.googleapis.com/v1/${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async (response) => {
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          (Array.isArray(result) ? result[0]?.error?.message : result?.error?.message) ||
            `Firestore request failed (${response.status}).`,
        );
      }
      return result;
    });

  let after =
    typeof body?.after === "string" && body.after.startsWith(`${base}/students/`)
      ? body.after
      : null;
  let scanned = 0;
  let moved = 0;
  let done = false;

  try {
    for (let page = 0; page < PRIVATE_MIGRATION_MAX_PAGES; page += 1) {
      const rows = await api(":runQuery", {
        structuredQuery: {
          from: [{ collectionId: "students" }],
          select: {
            fields: [...PRIVATE_PROFILE_FIELDS, "userId", "uid"].map((fieldPath) => ({ fieldPath })),
          },
          orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
          ...(after ? { startAt: { values: [{ referenceValue: after }], before: false } } : {}),
          limit: PRIVATE_MIGRATION_PAGE,
        },
      });
      const docs = (Array.isArray(rows) ? rows : []).filter((row) => row.document).map((row) => row.document);
      scanned += docs.length;

      const candidates = docs.filter((document) =>
        PRIVATE_PROFILE_FIELDS.some((key) => document.fields?.[key] !== undefined),
      );
      if (candidates.length) {
        const privateName = (document) => `${base}/studentPrivate/${document.name.split("/").pop()}`;
        const existing = new Map();
        const found = await api(":batchGet", { documents: candidates.map(privateName) });
        for (const entry of Array.isArray(found) ? found : []) {
          if (entry.found) existing.set(entry.found.name, entry.found.fields || {});
        }

        const writes = [];
        for (const document of candidates) {
          const plan = planPrivateProfileMove(
            document.fields || {},
            existing.get(privateName(document)) || {},
          );
          if (!plan) continue;
          const uid = document.fields?.userId?.stringValue || document.fields?.uid?.stringValue || "";
          const privateFields = {
            ...plan.privateFields,
            ...(uid ? { userId: { stringValue: uid } } : {}),
            updatedAt: { timestampValue: new Date().toISOString() },
          };
          writes.push({
            update: { name: privateName(document), fields: privateFields },
            updateMask: { fieldPaths: Object.keys(privateFields) },
          });
          writes.push({
            update: { name: document.name, fields: {} },
            updateMask: { fieldPaths: plan.publicRemove },
            currentDocument: { exists: true },
          });
          moved += 1;
        }
        // Private record and public removal together, or neither.
        if (writes.length) await api(":commit", { writes });
      }

      if (docs.length < PRIVATE_MIGRATION_PAGE) {
        done = true;
        after = null;
        break;
      }
      after = docs[docs.length - 1].name;
    }
  } catch (error) {
    console.error("[privacy] moving personal emails failed:", error?.message || error);
    return json({ error: "Couldn't move the emails. Please try again." }, { status: 502 });
  }

  return json({ ok: true, scanned, moved, done, next: done ? null : after });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runDailyRollup(env).catch((error) => {
        console.error(
          "[Rollup] scheduled daily rollup failed:",
          error?.message || error,
        );
      }),
    );
  },

  async fetch(request, env, ctx) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(allowedOrigin),
      });
    }

    if (request.method !== "POST") {
      return json(
        { error: "Method not allowed." },
        { status: 405, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
      );
    }

    try {
      const body = await request.json();

      if (body?.mode === "moderate-firestore-post") {
        return await moderateFirestorePost(env, request, body);
      }

      if (body?.mode === "moderate-firestore-content") {
        return await moderateFirestoreContent(env, request, body);
      }

      if (body?.mode === "recovery-email-start") {
        return await handleRecoveryEmailStart(env, request, body);
      }
      if (body?.mode === "account-password-check") {
        const result = await checkAccountPassword(env, request, body, {
          lookupUser: lookupFirebaseUser,
          readProfile: (environment, id) => readFirestoreDocSafe(environment, `/students/${encodeURIComponent(id)}`),
          patchProfile: (environment, id, fields) => patchFirestore(environment, "students", id, fields),
          isTemporaryPassword,
        });
        return json(result.body, { status: result.status, headers: { "Access-Control-Allow-Origin": allowedOrigin } });
      }
      if (body?.mode === "agora-token") {
        const result = await issueAgoraToken(env, request, body, {
          verifyUser: verifyFirebaseUser,
          readStream: (environment, id) =>
            readFirestoreDocSafe(environment, `/liveStreams/${encodeURIComponent(id)}`),
        });
        return json(result.body, {
          status: result.status,
          headers: { "Access-Control-Allow-Origin": allowedOrigin },
        });
      }
      if (body?.mode === "recovery-email-confirm") {
        return await handleRecoveryEmailConfirm(env, request, body);
      }
      if (body?.mode === "password-reset-start") {
        return await handlePasswordResetStart(env, request, body);
      }
      if (body?.mode === "signin-help-request") {
        return await handleSignInHelpRequest(env, request, body);
      }
      if (body?.mode === "admin-account-recovery") {
        return await handleAdminAccountRecovery(env, request, body);
      }
      if (body?.mode === "migrate-private-profile") {
        return await handleMigratePrivateProfile(env, request, body);
      }
      if (body?.mode === "password-reset-confirm") {
        return await handlePasswordResetConfirm(env, request, body);
      }

      if (body?.mode === "transcribe-video") {
        return await transcribeFirestoreVideo(env, request, body, ctx);
      }

      if (body?.mode === "run-daily-rollup") {
        // Manual trigger for the analytics rollup (verification / backfill).
        // Staff only — students and unknown roles are rejected.
        const authHeader = request.headers.get("Authorization") || "";
        const idToken = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!idToken) {
          return json(
            { error: "Missing Firebase ID token." },
            { status: 401, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
          );
        }
        const callerUid = await verifyFirebaseUser(env, idToken);
        const callerRole = await resolveTextModerationRole(env, callerUid);
        if (shouldRunStudentTextModeration(callerRole)) {
          return json(
            { error: "Staff only." },
            { status: 403, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
          );
        }
        const requestedDate =
          typeof body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
            ? body.date
            : undefined;
        const stats = await runDailyRollup(
          env,
          requestedDate ? { dateId: requestedDate } : { mode: "today" },
        );
        return json(
          { ok: true, stats },
          { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
        );
      }

      if (body?.mode === "push-notification") {
        const result = await handlePushNotificationRequest(
          new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(body),
          }),
          env,
        );
        return json(result.body, {
          status: result.status,
          headers: { "Access-Control-Allow-Origin": allowedOrigin },
        });
      }

      if (body?.mode === "push-announcement") {
        const result = await handleAnnouncementBroadcast(
          new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(body),
          }),
          env,
        );
        return json(result.body, {
          status: result.status,
          headers: { "Access-Control-Allow-Origin": allowedOrigin },
        });
      }

      if (body?.mode === "moderate") {
        const authHeader = request.headers.get("Authorization") || "";
        const idToken = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!idToken) {
          return json(
            { error: "Missing Firebase ID token." },
            { status: 401, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
          );
        }

        const callerUid = await verifyFirebaseUser(env, idToken);
        const callerRole = await resolveTextModerationRole(env, callerUid);
        const requestedAuthorId = String(body?.authorId || "").trim();
        if (requestedAuthorId && requestedAuthorId !== callerUid) {
          return json(
            { error: "authorId does not match the authenticated user." },
            { status: 403, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
          );
        }

        if (!shouldRunStudentTextModeration(callerRole)) {
          return json(
            {
              status: "approved",
              reasons: [],
              categories: [],
              selfHarm: false,
              priority: "normal",
              moderationSource: "staff-role-bypass",
              role: callerRole,
              model: null,
              provider: null,
              ruleSource: "staff-role-bypass",
            },
            { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
          );
        }

        const text = String(body?.text || "").trim();
        if (!text) {
          return json(
            {
              status: "approved",
              reasons: [],
              categories: [],
              selfHarm: false,
              priority: "normal",
              moderationSource: "empty",
            },
            { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
          );
        }

        let decision;
        try {
          decision = await moderateTextWithOpenModeration(env, text, body?.scope);
        } catch (error) {
          console.warn(
            "[Moderation] OpenModeration failed; using pending fallback.",
            error?.message || error,
          );
          decision = {
            status: "pending",
            reasons: [
              "Automatic moderation could not complete. This content requires review.",
            ],
            categories: [],
            selfHarm: false,
            priority: "normal",
            moderationSource: "provider-fallback",
            model: env.OPENMODERATION_MODEL || DEFAULT_OPENMODERATION_MODEL,
            provider:
              env.OPENMODERATION_PROVIDER || DEFAULT_OPENMODERATION_PROVIDER,
          };
        }

        return json(
          {
            ...decision,
            moderationSource: decision.moderationSource || "openmoderation",
          },
          { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
        );
      }

      return json(
        {
          error:
            "Unsupported mode. Generative chat is disabled in this Worker; BondED uses its non-generative chatbot separately.",
        },
        { status: 400, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
      );
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Unexpected worker error." },
        { status: 500, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
      );
    }
  },
};

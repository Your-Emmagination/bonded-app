// utils/moderationReasons.ts
//
// Turns a stored `moderationReasons` entry into something a teacher can read.
//
// The Worker used to write its raw provider output into Firestore, e.g.
//   "OpenModeration flagged: sexual (0.734 >= 0.080), harassment (0.4 >= 0.35)."
// which leaks the vendor name, the model's confidence and the internal
// threshold into the moderation queue. The Worker now writes plain labels
// instead, but every item already sitting in the queue still has the old
// text saved on it — so the cleanup also has to happen at display time.
//
// New-style reasons pass through untouched; old-style ones are rewritten.

const CATEGORY_LABELS: Record<string, string> = {
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
  "recreational_drug": "Drugs",
  drug: "Drugs",
  gore: "Graphic content",
  offensive: "Offensive symbol",
  "self-harm-image": "Self-harm imagery",
};

/** "sexual (0.734 >= 0.080)" -> "Sexual content" */
const labelForCategory = (raw: string): string => {
  const name = raw
    .replace(/\([^)]*\)/g, "")
    .replace(/^sightengine:/i, "")
    .trim()
    .toLowerCase();
  if (!name) return "";
  return CATEGORY_LABELS[name] || name.replace(/[_/]/g, " ").replace(/^./, (c) => c.toUpperCase());
};

const splitCategories = (list: string): string[] =>
  list
    .split(",")
    .map(labelForCategory)
    .filter(Boolean);

/**
 * One raw reason -> one reader-friendly reason. Returns "" for entries that
 * carry no information worth showing.
 */
const friendlyReason = (raw: string): string => {
  const reason = String(raw || "").trim();
  if (!reason) return "";

  // "OpenModeration flagged: sexual (0.7 >= 0.08), hate (0.4 >= 0.3)."
  const textMatch = reason.match(/^openmoderation flagged:\s*(.+?)\.?$/i);
  if (textMatch) {
    const labels = splitCategories(textMatch[1]);
    return labels.length ? labels.join(", ") : "Flagged for review";
  }

  // "OpenModeration flagged this content for human review."
  if (/^openmoderation flagged this content/i.test(reason)) {
    return "Flagged for review";
  }

  // "Keyword match: weapon-related term ("gun")."
  const keywordMatch = reason.match(/^keyword match:\s*(.+?)\s*\((.+)\)\.?$/i);
  if (keywordMatch) {
    const label = keywordMatch[1].trim();
    return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${keywordMatch[2].trim()}`;
  }

  // "Image 1 flagged: sexual (0.9 >= 0.08)." / "Video 1 flagged by Sightengine: weapon (…)."
  const mediaMatch = reason.match(/^(.+?) flagged(?: by [a-z]+)?:\s*(.+?)\.?$/i);
  if (mediaMatch) {
    const target = mediaMatch[1].trim().replace(/^./, (c) => c.toUpperCase());
    const labels = splitCategories(mediaMatch[2]);
    return labels.length ? `${target}: ${labels.join(", ")}` : target;
  }

  // Already clean (or a sentence like "Automatic moderation could not
  // complete…") — just make sure no score pair survives.
  return reason.replace(/\s*\([\d.]+\s*>=\s*[\d.]+\)/g, "").trim();
};

/**
 * Cleans a whole `moderationReasons` array for display: rewrites the legacy
 * provider strings, drops empties, and removes duplicates that collapse into
 * the same label.
 */
export const friendlyModerationReasons = (reasons?: string[] | null): string[] => {
  if (!Array.isArray(reasons)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];

  reasons.forEach((raw) => {
    const reason = friendlyReason(raw);
    if (!reason || seen.has(reason)) return;
    seen.add(reason);
    cleaned.push(reason);
  });

  return cleaned;
};

/**
 * A one-word description of an item's attachment, for places that would
 * otherwise show a blank line: "📷 Photo", "🎬 Video", "🔗 Link", or "".
 */
export const moderationMediaSummary = (data: any): string => {
  const files: any[] = Array.isArray(data?.files) ? data.files : [];
  const kinds = files.map((file) => String(file?.mimeType || ""));
  if (kinds.some((kind) => kind.startsWith("video/"))) return "🎬 Video";
  if (kinds.some((kind) => kind.startsWith("image/")) || typeof data?.imageUrl === "string") {
    return "📷 Photo";
  }
  if (files.length > 0) return "📎 File";
  if (data?.link?.url) return "🔗 Link";
  return "";
};

const SAFETY_LABELS: Record<string, string> = {
  "self-harm": "SELF-HARM / INTENT",
  "weapon-term": "WEAPON-RELATED TERM",
  "weapon-image": "WEAPON IN IMAGE",
  "offensive-image": "OFFENSIVE IMAGE",
  "adult-link": "ADULT LINK",
};

/**
 * The banner on a priority item.
 *
 * Older items were all written as "weapon" unless they were self-harm, so an
 * offensive photo in the queue today still carries that label. For those the
 * reason is worked out again from the categories the checks recorded, which
 * corrects them without re-running moderation.
 */
export const safetyReviewLabel = (
  safetyType?: string | null,
  categories: string[] = [],
): string => {
  if (safetyType && SAFETY_LABELS[safetyType]) return SAFETY_LABELS[safetyType];
  if (safetyType === "weapon" || !safetyType) {
    if (categories.includes("keyword:weapons")) return SAFETY_LABELS["weapon-term"];
    if (categories.includes("sightengine:weapon")) return SAFETY_LABELS["weapon-image"];
    if (categories.includes("sightengine:offensive")) return SAFETY_LABELS["offensive-image"];
    if (categories.includes("link:adult_link")) return SAFETY_LABELS["adult-link"];
  }
  return "FLAGGED FOR REVIEW";
};

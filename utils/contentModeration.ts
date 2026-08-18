// ─── Types ────────────────────────────────────────────────────────────────────

import { getAiWorkerUrl, getMediaAiUrl } from "./aiConfig";

export type ModerationStatus = "approved" | "pending" | "rejected";

export type ModerationScope = "post" | "comment" | "reply" | "thread" | "profile" | "dm";

export type ModerationRuleSource = "exact" | "substring" | "pattern" | "ai";

export type ModerationSeverity = "low" | "medium" | "high" | "critical";

export type ModerationDecision = {
  status: ModerationStatus;
  reasons: string[];
  matchedKeywords?: string[];
  matchedPatterns?: string[];
  severity?: ModerationSeverity;
  ruleSource?: ModerationRuleSource;
  model?: string | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
};

export type ModerationPreviewInput = {
  text?: string | null;
  linkTitle?: string | null;
  fileCount?: number;
  fileTypes?: string[];
};

export type ModerationRequestInput = {
  text?: string | null;
  scope: ModerationScope;
  serverId?: string | null;
  channelId?: string | null;
  authorId?: string | null;
  authorRole?: string | null;
  locale?: string | null;
  timeoutMs?: number;
};

export type ModerationViewerInput = {
  moderationStatus?: string | null;
  moderationSeverity?: ModerationSeverity | null;
  realUserId?: string | null;
  userId?: string | null;
  viewerUserId?: string | null;
  viewerRole?: string | null;
  viewerPermissions?: string[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Words that must match on a word boundary (no partial hits). */
const EXACT_BLOCKLIST: string[] = [
  "shabu",
  "weed",
  "marijuana",
  "cannabis",
  "vape",
  "nudes",
  "porn",
  "pornography",
  "suicide",
  "meth",
  "cocaine",
  "heroin",
  "fentanyl",
  "mdma",
  "ecstasy",
];

/** Phrases matched anywhere as a substring. */
const SUBSTRING_BLOCKLIST: string[] = [
  "kill yourself",
  "kys",
  "sex video",
  "bomb threat",
  "sexual assault",
  "drug dealer",
  "escort service",
  "explicit content",
  "child porn",
  "cp link",
  "onlyfans link",
  "snapchat nudes",
  "buy drugs",
  "sell drugs",
];

/** Regex patterns for more nuanced detection. */
const PATTERN_BLOCKLIST: { label: string; pattern: RegExp }[] = [
  // Obfuscated "kill yourself" variants (k1ll, k!ll, etc.)
  { label: "self-harm phrase", pattern: /k[i1!][l1][l1]\s*y(our)?s(elf)?/i },
  // Suspicious URL patterns (e.g. t.me/drugs, t.me/nudes)
  { label: "suspicious link", pattern: /\b(t\.me|telegram\.me)\/[a-z0-9_]{3,}\b/i },
];

const SEVERITY_MAP: Record<string, ModerationSeverity> = {
  suicide: "critical",
  "kill yourself": "critical",
  "kys": "critical",
  "self-harm phrase": "critical",
  "child porn": "critical",
  "cp link": "critical",
  "bomb threat": "high",
  "sexual assault": "high",
  "drug transaction": "high",
  shabu: "high",
  meth: "high",
  heroin: "high",
  fentanyl: "high",
  cocaine: "high",
  "drug dealer": "high",
  "buy drugs": "high",
  "sell drugs": "high",
  porn: "medium",
  pornography: "medium",
  nudes: "medium",
  "sex video": "medium",
  "onlyfans link": "medium",
  "snapchat nudes": "medium",
  "suspicious link": "medium",
  solicitation: "medium",
  weed: "low",
  marijuana: "low",
  cannabis: "low",
  vape: "low",
  mdma: "low",
  ecstasy: "low",
};

const STAFF_ROLES = new Set([
  "teacher",
  "moderator",
  "admin",
  "superadmin",
  "trust-and-safety",
]);

const DEFAULT_TIMEOUT_MS = 5_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const escapeForRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getNormalizedText = (value?: string | null): string =>
  (value ?? "")
    .toLowerCase()
    // Collapse common leet-speak / homoglyph substitutions before matching
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/\s+/g, " ")
    .trim();

const getHighestSeverity = (labels: string[]): ModerationSeverity => {
  const order: ModerationSeverity[] = ["critical", "high", "medium", "low"];
  for (const level of order) {
    if (labels.some((l) => SEVERITY_MAP[l] === level)) return level;
  }
  return "low";
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Moderation request timed out after ${ms}ms`)), ms),
  );
  return Promise.race([promise, timer]);
};

// ─── Preview text ─────────────────────────────────────────────────────────────

export const getModerationPreviewText = (input: ModerationPreviewInput): string => {
  const trimmed = input.text?.trim();
  if (trimmed) return trimmed;

  const linkTitle = input.linkTitle?.trim();
  if (linkTitle) return linkTitle;

  if (input.fileCount && input.fileCount > 0) {
    const label =
      input.fileTypes && input.fileTypes.length > 0
        ? input.fileTypes.join(", ")
        : `attachment${input.fileCount === 1 ? "" : "s"}`;
    return `[shared ${input.fileCount} ${label}]`;
  }

  return "";
};

// ─── Local rules ──────────────────────────────────────────────────────────────

export const runLocalModerationRules = (value?: string | null): ModerationDecision => {
  const normalized = getNormalizedText(value);

  if (!normalized) {
    return { status: "approved", reasons: [], severity: undefined, ruleSource: undefined };
  }

  const matchedKeywords: string[] = [
    ...EXACT_BLOCKLIST.filter((keyword) =>
      new RegExp(`(^|\\b)${escapeForRegex(keyword)}(\\b|$)`, "i").test(normalized),
    ),
    ...SUBSTRING_BLOCKLIST.filter((keyword) => normalized.includes(keyword)),
  ];

  const matchedPatterns: string[] = PATTERN_BLOCKLIST
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ label }) => label);

  const allMatches = [...matchedKeywords, ...matchedPatterns];

  if (allMatches.length === 0) {
    return { status: "approved", reasons: [], ruleSource: undefined };
  }

  const severity = getHighestSeverity(allMatches);

  return {
    status: severity === "critical" ? "rejected" : "pending",
    reasons: buildReasonMessages(allMatches, severity),
    matchedKeywords: matchedKeywords.length > 0 ? matchedKeywords : undefined,
    matchedPatterns: matchedPatterns.length > 0 ? matchedPatterns : undefined,
    severity,
    ruleSource: "exact",
  };
};

const buildReasonMessages = (
  matches: string[],
  severity: ModerationSeverity,
): string[] => {
  const reasons: string[] = ["Matched restricted campus-safety keywords."];
  if (severity === "critical") {
    reasons.push("Content flagged as critical — requires immediate review.");
  }
  if (severity === "high") {
    reasons.push("Content flagged as high severity — pending staff review.");
  }
  return reasons;
};

// ─── Remote moderation ────────────────────────────────────────────────────────

export const requestModerationDecision = async (
  input: ModerationRequestInput,
): Promise<ModerationDecision> => {
  const previewText = input.text?.trim() ?? "";
  const normalizedRole = String(input.authorRole ?? "student").toLowerCase();

  if (normalizedRole && normalizedRole !== "student") {
    return { status: "approved", reasons: [], ruleSource: undefined };
  }

  const localDecision = runLocalModerationRules(previewText);

  // Short-circuit: critical local matches don't need an AI call
  if (localDecision.status === "rejected") {
    return localDecision;
  }

  // Also short-circuit pending when already flagged locally
  if (localDecision.status === "pending") {
    return localDecision;
  }

  const workerUrl = getAiWorkerUrl();
  if (!workerUrl || !previewText) {
    return localDecision;
  }

  try {
    const fetchPromise = fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "moderate",
        text: previewText,
        scope: input.scope,
        serverId: input.serverId ?? null,
        channelId: input.channelId ?? null,
        authorId: input.authorId ?? null,
        authorRole: normalizedRole,
        locale: input.locale ?? null,
      }),
    });

    const response = await withTimeout(fetchPromise, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let payload: Record<string, unknown> | null = null;
    try {
      payload = await response.json();
    } catch {
      // non-JSON body — fall through to localDecision
    }

    if (!response.ok) {
      const msg = typeof payload?.error === "string" ? payload.error : "Moderation request failed.";
      throw new Error(msg);
    }

    if (
      payload?.status === "pending" ||
      payload?.status === "approved" ||
      payload?.status === "rejected"
    ) {
      return {
        status: payload.status as ModerationStatus,
        reasons: Array.isArray(payload.reasons) ? (payload.reasons as string[]) : [],
        matchedKeywords: Array.isArray(payload.matchedKeywords)
          ? (payload.matchedKeywords as string[])
          : [],
        matchedPatterns: Array.isArray(payload.matchedPatterns)
          ? (payload.matchedPatterns as string[])
          : [],
        severity: isValidSeverity(payload.severity) ? payload.severity : undefined,
        ruleSource: "ai",
        model: typeof payload.model === "string" ? payload.model : null,
      } satisfies ModerationDecision;
    }
  } catch (error) {
    console.error("[Moderation] Remote call failed, using local decision:", error);
  }

  return localDecision;
};

const isValidSeverity = (value: unknown): value is ModerationSeverity =>
  ["low", "medium", "high", "critical"].includes(value as string);

export type MediaModerationResult = {
  decision: "approved" | "review" | "blocked";
  inappropriate_probability: number;
  appropriate_probability: number;
};

export const requestImageModeration = async (
  uri: string,
): Promise<MediaModerationResult> => {
  const workerUrl = getMediaAiUrl();

  if (!workerUrl) {
    // No media AI configured at all — nothing to check against, so don't
    // block posting, but don't rubber-stamp it as "safe" either.
    return {
      decision: "review",
      inappropriate_probability: 0,
      appropriate_probability: 0,
    };
  }

  try {
    const formData = new FormData();

    formData.append("file", {
      uri,
      name: `moderation_${Date.now()}.jpg`,
      type: "image/jpeg",
    } as any);

    const response = await withTimeout(
      fetch(`${workerUrl}/moderate/image`, {
        method: "POST",
        body: formData,
      }),
      DEFAULT_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(`Image moderation failed: ${response.status}`);
    }

    const result = await response.json();

    return {
      decision:
        result.decision === "blocked"
          ? "blocked"
          : result.decision === "review"
            ? "review"
            : "approved",
      inappropriate_probability:
        Number(result.inappropriate_probability) || 0,
      appropriate_probability:
        Number(result.appropriate_probability) || 0,
    };
  } catch (error) {
    console.error(
      "[Moderation] Image AI request failed:",
      error,
    );

    // Do not break the application if the AI server is unavailable — but
    // fail CLOSED, not open. Auto-approving every image whenever the AI
    // server is down/unreachable means an outage silently disables image
    // moderation entirely. Sending it to manual review instead keeps a
    // human in the loop until the AI server is reachable again.
    return {
      decision: "review",
      inappropriate_probability: 0,
      appropriate_probability: 0,
    };
  }
};

export const requestVideoModeration = async (
  uri: string,
): Promise<MediaModerationResult> => {
  const workerUrl = getMediaAiUrl();

  if (!workerUrl) {
    return {
      decision: "review",
      inappropriate_probability: 0,
      appropriate_probability: 0,
    };
  }

  try {
    const formData = new FormData();

    formData.append("file", {
      uri,
      name: `moderation_${Date.now()}.mp4`,
      type: "video/mp4",
    } as any);

    const response = await withTimeout(
      fetch(`${workerUrl}/moderate/video`, {
        method: "POST",
        body: formData,
      }),
      30_000,
    );

    if (!response.ok) {
      throw new Error(`Video moderation failed: ${response.status}`);
    }

    const result = await response.json();

    return {
      decision:
        result.decision === "blocked"
          ? "blocked"
          : result.decision === "review"
            ? "review"
            : "approved",
      inappropriate_probability:
        Number(result.inappropriate_probability) || 0,
      appropriate_probability:
        Number(result.appropriate_probability) || 0,
    };
  } catch (error) {
    console.error(
      "[Moderation] Video AI request failed:",
      error,
    );

    // Fail closed to manual review rather than silently auto-approving —
    // see the matching comment in requestImageModeration above.
    return {
      decision: "review",
      inappropriate_probability: 0,
      appropriate_probability: 0,
    };
  }
};

// ─── Viewer access ────────────────────────────────────────────────────────────

export const canViewModeratedContent = (input: ModerationViewerInput): boolean => {
  const status = (input.moderationStatus ?? "approved") as ModerationStatus;

  // Approved or no status → always visible
  if (status === "approved") return true;

  // Staff can see moderated content for review
  const role = String(input.viewerRole ?? "").toLowerCase();
  if (STAFF_ROLES.has(role)) return true;

  // Explicit permission override
  if (input.viewerPermissions?.includes("view_moderated_content")) return true;

  // Rejected content: only admins/superadmins can see it, not regular mods
  if (status === "rejected") {
    return ["admin", "superadmin"].includes(role);
  }

  return false;
};

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Returns true if the decision represents any non-approved outcome. */
export const isFlagged = (decision: ModerationDecision): boolean =>
  decision.status !== "approved";

/** Returns true only for critical decisions that should be auto-rejected. */
export const isAutoRejected = (decision: ModerationDecision): boolean =>
  decision.status === "rejected";

/** Merge a local and remote decision, taking the stricter outcome. */
export const mergeDecisions = (
  local: ModerationDecision,
  remote: ModerationDecision,
): ModerationDecision => {
  const statusPriority: Record<ModerationStatus, number> = {
    approved: 0,
    pending: 1,
    rejected: 2,
  };

  const winner =
    statusPriority[remote.status] >= statusPriority[local.status] ? remote : local;

  return {
    ...winner,
    reasons: [...new Set([...local.reasons, ...remote.reasons])],
    matchedKeywords: [
      ...new Set([...(local.matchedKeywords ?? []), ...(remote.matchedKeywords ?? [])]),
    ],
    matchedPatterns: [
      ...new Set([...(local.matchedPatterns ?? []), ...(remote.matchedPatterns ?? [])]),
    ],
    severity: getHighestSeverity([
      ...(local.matchedKeywords ?? []),
      ...(local.matchedPatterns ?? []),
      ...(remote.matchedKeywords ?? []),
      ...(remote.matchedPatterns ?? []),
    ]),
  };
};

/** Summarise a decision for logging / audit trails without PII. */
export const summariseDecision = (decision: ModerationDecision): string => {
  const parts = [
    `status=${decision.status}`,
    decision.severity ? `severity=${decision.severity}` : null,
    decision.ruleSource ? `source=${decision.ruleSource}` : null,
    decision.matchedKeywords?.length
      ? `keywords=[${decision.matchedKeywords.join(", ")}]`
      : null,
    decision.matchedPatterns?.length
      ? `patterns=[${decision.matchedPatterns.join(", ")}]`
      : null,
    decision.model ? `model=${decision.model}` : null,
  ].filter(Boolean);
  return parts.join(" | ");
};
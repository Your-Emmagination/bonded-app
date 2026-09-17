import { getAiWorkerUrl } from "./aiConfig";
import { auth } from "../Firebase_configure";

/**
 * Text moderation policy:
 * - Only student-authored text is sent to OpenModeration.
 * - Teacher, moderator, and admin text bypasses text moderation after the
 *   trusted Worker verifies the Firebase user and resolves their Firestore role.
 * - No local keyword/block/regex moderation is used for students.
 * - Student text has only two outcomes: approved or pending.
 * - Student @AI/@everyone/@username mentions never bypass moderation.
 */
export const AI_TRIGGER_BYPASSES_MODERATION = false;

// The line that matters most. SafetyDialog sets this as the loudest text in
// the dialog, above the moderation outcome.
export const SELF_HARM_TRUSTED_ADULT_MESSAGE =
  "Please reach out to someone you trust — a parent, a teacher, or another trusted adult.";

// Follows "Your post wasn't posted." inside SafetyDialog, so it reads as a
// continuation rather than a standalone paragraph.
export const SELF_HARM_SAFETY_MESSAGE =
  "A school counselor or mental health professional can help too. If you're in immediate danger, contact local emergency services.";

export type ModerationStatus = "approved" | "pending";
export type ModerationScope = "post" | "poll" | "comment" | "reply" | "thread" | "profile" | "dm";
export type ModerationRuleSource = "ai";
export type ModerationSeverity = "low" | "medium" | "high" | "critical";

export type ModerationDecision = {
  status: ModerationStatus;
  reasons: string[];
  categories?: string[];
  severity?: ModerationSeverity;
  priority?: "normal" | "critical";
  selfHarm?: boolean;
  ruleSource?: ModerationRuleSource;
  model?: string | null;
  provider?: string | null;
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

const STAFF_ROLES = new Set(["teacher", "moderator", "admin"]);
const DEFAULT_TIMEOUT_MS = 8_000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Moderation request timed out after ${ms}ms`)),
      ms,
    );
  });

  return Promise.race([promise, timer]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  }) as Promise<T>;
};

export const approvedModerationDecision = (): ModerationDecision => ({
  status: "approved",
  reasons: [],
  categories: [],
  priority: "normal",
  selfHarm: false,
  ruleSource: "ai",
});

/**
 * The moderation fields a new comment, reply or server message starts with.
 *
 * The Worker approves teacher, moderator and admin content without reading it
 * (TEXT_MODERATION_BYPASS_ROLES), so for staff the round trip only ever wrote
 * "approved" a second later. Writing it at creation puts their message in
 * front of everyone immediately. Students' content still starts pending and
 * waits for the Worker, and the rules only accept "approved" from staff.
 */
export const initialModerationFields = (authorIsStaff: boolean) =>
  authorIsStaff
    ? {
        moderationStatus: "approved" as const,
        moderationReasons: [] as string[],
        moderatedAtMs: Date.now(),
        moderationRuleSource: "staff-role-bypass",
      }
    : {
        moderationStatus: "pending" as const,
        moderationReasons: [] as string[],
        moderatedAtMs: null,
      };

/**
 * The decision for content that was just written with
 * initialModerationFields(). Staff get the answer the Worker would have given
 * without asking it; everyone else is checked as before.
 */
export const moderateNewContent = (
  authorIsStaff: boolean,
  input: Parameters<typeof requestFirestoreModerationDecision>[0],
): Promise<ModerationDecision> =>
  authorIsStaff
    ? Promise.resolve(approvedModerationDecision())
    : requestFirestoreModerationDecision(input);

export const requestModerationDecisionForAiTrigger = async (
  input: ModerationRequestInput,
  _options: { shouldTriggerAi: boolean },
): Promise<ModerationDecision> => requestModerationDecision(input);

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

const normalizeDecisionPayload = (payload: Record<string, unknown> | null): ModerationDecision => {
  const rawStatus = payload?.status;
  if (rawStatus !== "approved" && rawStatus !== "pending") {
    throw new Error("Server moderation returned an invalid decision.");
  }

  const categories = Array.isArray(payload?.categories)
    ? (payload?.categories as unknown[]).map(String)
    : Array.isArray(payload?.matchedKeywords)
      ? (payload?.matchedKeywords as unknown[]).map(String)
      : [];

  const selfHarm =
    payload?.selfHarm === true ||
    categories.some((category) => category.toLowerCase().startsWith("self-harm"));

  return {
    status: rawStatus,
    reasons: Array.isArray(payload?.reasons)
      ? (payload?.reasons as unknown[]).map(String)
      : [],
    categories,
    selfHarm,
    priority: selfHarm || payload?.priority === "critical" ? "critical" : "normal",
    severity: selfHarm ? "critical" : undefined,
    ruleSource: "ai",
    model: typeof payload?.model === "string" ? payload.model : null,
    provider: typeof payload?.provider === "string" ? payload.provider : null,
  };
};

/**
 * Server-authoritative moderation for content already saved as pending.
 * The Worker verifies the Firebase caller, re-reads the Firestore document,
 * and calls OpenModeration. No client-side text classification is performed.
 */
export const requestFirestoreModerationDecision = async (input: {
  collectionName: "comments" | "replies" | "polls" | "communityThreadMessages";
  documentId: string;
  scope: ModerationScope;
}): Promise<ModerationDecision> => {
  const workerUrl = getAiWorkerUrl();
  const currentUser = auth.currentUser;
  if (!workerUrl) throw new Error("Moderation Worker URL is not configured.");
  if (!currentUser) throw new Error("You must be signed in to moderate this content.");

  const idToken = await currentUser.getIdToken();
  const response = await withTimeout(
    fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        mode: "moderate-firestore-content",
        collection: input.collectionName,
        documentId: input.documentId,
        scope: input.scope,
      }),
    }),
    DEFAULT_TIMEOUT_MS,
  );

  const responseText = await response.text();
  let payload: Record<string, unknown> | null = null;
  try {
    payload = responseText ? (JSON.parse(responseText) as Record<string, unknown>) : null;
  } catch {
    // Raw text is used in the error below.
  }

  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : responseText.trim() || `HTTP ${response.status}`;
    throw new Error(`Server moderation failed: ${message.slice(0, 500)}`);
  }

  return normalizeDecisionPayload(payload);
};

/**
 * Direct moderation request through the trusted Worker. Students are checked
 * by OpenModeration; teacher/moderator/admin callers are approved by the
 * Worker's trusted role-bypass policy without sending their text to the model.
 */
export const requestModerationDecision = async (
  input: ModerationRequestInput,
): Promise<ModerationDecision> => {
  const previewText = input.text?.trim() ?? "";
  if (!previewText) return approvedModerationDecision();

  const workerUrl = getAiWorkerUrl();
  if (!workerUrl) {
    return {
      status: "pending",
      reasons: ["Automatic moderation is unavailable. This content requires review."],
      categories: [],
      priority: "normal",
      selfHarm: false,
      ruleSource: "ai",
    };
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    return {
      status: "pending",
      reasons: ["You must be signed in for automatic moderation."],
      categories: [],
      priority: "normal",
      selfHarm: false,
      ruleSource: "ai",
    };
  }

  try {
    const idToken = await currentUser.getIdToken();
    const response = await withTimeout(
      fetch(workerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          mode: "moderate",
          text: previewText,
          scope: input.scope,
          serverId: input.serverId ?? null,
          channelId: input.channelId ?? null,
          authorId: input.authorId ?? currentUser.uid,
          authorRole: input.authorRole ?? null,
          locale: input.locale ?? null,
        }),
      }),
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const responseText = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      payload = responseText ? (JSON.parse(responseText) as Record<string, unknown>) : null;
    } catch {
      // Raw response is included in the error below.
    }

    if (!response.ok) {
      const serverMessage =
        typeof payload?.error === "string"
          ? payload.error
          : typeof payload?.message === "string"
            ? payload.message
            : responseText.trim();
      throw new Error(
        `Moderation request failed: HTTP ${response.status}${
          serverMessage ? ` — ${serverMessage.slice(0, 500)}` : ""
        }`,
      );
    }

    return normalizeDecisionPayload(payload);
  } catch (error) {
    console.error("[Moderation] OpenModeration call failed; keeping content pending:", error);
    return {
      status: "pending",
      reasons: ["Automatic moderation could not complete. This content requires review."],
      categories: [],
      priority: "normal",
      selfHarm: false,
      ruleSource: "ai",
    };
  }
};

export const isSelfHarmDecision = (decision: ModerationDecision): boolean =>
  decision.selfHarm === true ||
  (decision.categories || []).some((category) =>
    String(category).toLowerCase().startsWith("self-harm"),
  );

// Image/video moderation now runs server-side in the Cloudflare Worker on
// the same pass as text (see cloudflare/ai-worker/src/index.js
// moderateMediaWithOpenModeration). There is no client-side media call:
// a post/comment with attachments is saved pending and the Worker checks
// every attachment via OpenModeration before approving.

export const canViewModeratedContent = (input: ModerationViewerInput): boolean => {
  const status = String(input.moderationStatus ?? "approved").toLowerCase();
  if (status === "approved") return true;

  const ownerId = String(input.realUserId || input.userId || "");
  if (input.viewerUserId && ownerId === input.viewerUserId) return true;

  const role = String(input.viewerRole ?? "").toLowerCase();
  if (STAFF_ROLES.has(role)) return true;
  if (input.viewerPermissions?.includes("view_moderated_content")) return true;

  return false;
};

export const isFlagged = (decision: ModerationDecision): boolean =>
  decision.status === "pending";

/** Kept for backward compatibility; text moderation no longer auto-rejects. */
export const isAutoRejected = (_decision: ModerationDecision): boolean => false;

export const mergeDecisions = (
  first: ModerationDecision,
  second: ModerationDecision,
): ModerationDecision => {
  const pending = first.status === "pending" || second.status === "pending";
  const categories = [...new Set([...(first.categories || []), ...(second.categories || [])])];
  const selfHarm = first.selfHarm === true || second.selfHarm === true ||
    categories.some((category) => category.toLowerCase().startsWith("self-harm"));

  return {
    ...(pending ? (first.status === "pending" ? first : second) : second),
    status: pending ? "pending" : "approved",
    reasons: [...new Set([...first.reasons, ...second.reasons])],
    categories,
    selfHarm,
    priority: selfHarm ? "critical" : "normal",
    severity: selfHarm ? "critical" : undefined,
    ruleSource: "ai",
  };
};

export const summariseDecision = (decision: ModerationDecision): string => {
  const parts = [
    `status=${decision.status}`,
    decision.priority ? `priority=${decision.priority}` : null,
    decision.categories?.length ? `categories=[${decision.categories.join(", ")}]` : null,
    decision.model ? `model=${decision.model}` : null,
  ].filter(Boolean);
  return parts.join(" | ");
};

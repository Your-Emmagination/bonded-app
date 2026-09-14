// utils/yearLevels.ts
//
// Single source of truth for the academic year ladder.
//
// Before this file the same array was copy-pasted into ManageUsersScreen,
// DashboardScreen and AdminRegisterUserScreen. Automatic promotion turns that
// list into logic (the next year level is "the next item"), so the three
// copies had to become one.
//
// IMPORTANT: functions/index.js carries a hand-mirrored copy of the ladder and
// of evaluatePromotion()'s rules, because Cloud Functions is CommonJS and
// cannot import this module. If you change the ladder or the skip rules here,
// change them there too — otherwise the in-app preview and the scheduled run
// will disagree about who gets promoted.

export const YEAR_LEVELS = [
  "1st Year",
  "2nd Year",
  "3rd Year",
  "4th Year",
  "Graduated",
] as const;

export type YearLevel = (typeof YEAR_LEVELS)[number];

export const GRADUATED: YearLevel = "Graduated";

export function normalizeYearLevel(value: unknown): YearLevel | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  return YEAR_LEVELS.find((level) => level.toLowerCase() === raw) ?? null;
}

/**
 * The next rung up the ladder, or null when there is nowhere to go — the
 * student is already Graduated, or the stored value isn't on the ladder at all
 * (blank, or free text an old import left behind).
 */
export function nextYearLevel(value: unknown): YearLevel | null {
  const current = normalizeYearLevel(value);
  if (!current) return null;
  const index = YEAR_LEVELS.indexOf(current);
  if (index < 0 || index >= YEAR_LEVELS.length - 1) return null;
  return YEAR_LEVELS[index + 1];
}

/**
 * Only students and student-moderators climb the ladder. Teachers and admins
 * may carry a year level from an old registration; it is meaningless for them
 * and promotion must leave it alone.
 *
 * Accepts the legacy numeric roles still present on older student documents
 * (1 = student, 3 = moderator), matching parseUserRole() in rbac.ts.
 */
export function isPromotableRole(value: unknown): boolean {
  if (typeof value === "number") return value === 1 || value === 3;
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "student" || raw === "moderator" || raw === "1" || raw === "3";
}

/**
 * Whether this account has finished their programme.
 *
 * Alumni keep every capability a student has — they can still be mentioned,
 * messaged and found in search. The only difference is that the interface says
 * so, and that campus metrics count them separately instead of quietly
 * inflating the student body every June.
 */
export function isAlumni(yearlvl: unknown): boolean {
  return normalizeYearLevel(yearlvl) === GRADUATED;
}

export const ALUMNI_LABEL = "Alumni";

export type PromotionSkipReason =
  | "not_a_student"
  | "no_year_level"
  | "already_graduated"
  | "on_hold"
  | "registered_after_scheduling";

export type PromotionCandidate = {
  role?: unknown;
  yearlvl?: unknown;
  promotionHold?: unknown;
  /** Student document createdAt, in ms. Null for legacy docs without one. */
  createdAtMs?: number | null;
};

export type PromotionDecision =
  | { promote: false; reason: PromotionSkipReason }
  | { promote: true; from: YearLevel; to: YearLevel };

/**
 * Decides what happens to one student on a promotion run.
 *
 * `scheduleCreatedAtMs` is when the *schedule* was created, not when it runs.
 * Anyone registered after an admin set the promotion up has not lived through
 * the year that promotion represents, so they stay where they are. Legacy
 * documents with no createdAt are treated as long-standing and do advance.
 */
export function evaluatePromotion(
  candidate: PromotionCandidate,
  scheduleCreatedAtMs: number | null,
): PromotionDecision {
  if (!isPromotableRole(candidate.role)) {
    return { promote: false, reason: "not_a_student" };
  }

  const current = normalizeYearLevel(candidate.yearlvl);
  if (!current) return { promote: false, reason: "no_year_level" };

  if (candidate.promotionHold === true) {
    return { promote: false, reason: "on_hold" };
  }

  if (
    scheduleCreatedAtMs !== null &&
    candidate.createdAtMs !== null &&
    candidate.createdAtMs !== undefined &&
    candidate.createdAtMs > scheduleCreatedAtMs
  ) {
    return { promote: false, reason: "registered_after_scheduling" };
  }

  const next = nextYearLevel(current);
  if (!next) return { promote: false, reason: "already_graduated" };

  return { promote: true, from: current, to: next };
}

/** "June 15, 2026 at 12:01 AM" — 12-hour, matching the picker. */
export function formatPromotionMoment(date: Date): string {
  const day = date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${day} at ${time}`;
}

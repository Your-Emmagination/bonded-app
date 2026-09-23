// utils/eventAudience.ts
//
// Who an event is for. An empty list means the whole campus; naming programs
// ("BSIT") keeps it out of everyone else's way. This decides what is shown
// first and who is notified — never what Firestore allows — so another
// program's event is always one tap away rather than hidden.
export const WHOLE_CAMPUS: string[] = [];

export type AudienceViewer = {
  /** The student's program, from their profile (students/{id}.course). */
  course?: string | null;
  /** Staff have no program and are shown everything. */
  isStaff?: boolean;
};

/** Cleans whatever is on the document into a list of program names. */
export function normalizeAudience(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return [...new Set(names)];
}

/** Whether this event belongs in `viewer`'s own list. */
export function matchesEventAudience(forPrograms: unknown, viewer: AudienceViewer): boolean {
  const programs = normalizeAudience(forPrograms);
  if (programs.length === 0) return true;
  if (viewer.isStaff) return true;
  const course = String(viewer.course || "").trim().toLowerCase();
  if (!course) return true;
  return programs.some((program) => program.toLowerCase() === course);
}

/** The chip on the card: "Whole campus", "BSIT only", "BSIT · BSED". */
export function audienceLabel(forPrograms: unknown): string {
  const programs = normalizeAudience(forPrograms);
  if (programs.length === 0) return "Whole campus";
  if (programs.length === 1) return `${programs[0]} only`;
  if (programs.length === 2) return programs.join(" · ");
  return `${programs[0]} +${programs.length - 1} more`;
}

/** True when the event is limited, i.e. worth drawing attention to. */
export function isLimitedAudience(forPrograms: unknown): boolean {
  return normalizeAudience(forPrograms).length > 0;
}

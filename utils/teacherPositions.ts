// utils/teacherPositions.ts
//
// A teacher's position in the school. Students have a year level; teachers
// have this instead. Stored on the profile as `position`, set by admins only
// (firestore.rules keeps teachers from changing their own).

export const TEACHER_POSITIONS = ["Faculty", "Program Chair", "Dean"] as const;

export type TeacherPosition = (typeof TEACHER_POSITIONS)[number];

/** A new teacher starts here until an admin says otherwise. */
export const DEFAULT_TEACHER_POSITION: TeacherPosition = "Faculty";

/** Accepts the positions in any case ("dean", "program chair"); anything else is "". */
export function normalizeTeacherPosition(value: unknown): TeacherPosition | "" {
  const raw = String(value ?? "").trim().toLowerCase();
  return TEACHER_POSITIONS.find((position) => position.toLowerCase() === raw) ?? "";
}

/** True for a teacher, whether the role is stored as a word or as its number (2). */
export function isTeacherRole(role: unknown): boolean {
  if (typeof role === "number") return role === 2;
  const raw = String(role ?? "").trim().toLowerCase();
  return raw === "teacher" || raw === "2";
}

/** An admin's position, fixed: every admin account is the system administrator. */
export const ADMIN_POSITION = "System Administrator";

/** True for an admin, whether the role is stored as a word or as its number (4). */
export function isAdminRole(role: unknown): boolean {
  if (typeof role === "number") return role === 4;
  const raw = String(role ?? "").trim().toLowerCase();
  return raw === "admin" || raw === "4";
}

/** Teachers and admins show a Position where students show a Year Level. */
export function hasPosition(role: unknown): boolean {
  return isTeacherRole(role) || isAdminRole(role);
}

/** The Position to show for this account, or "" when there's none to show. */
export function positionLabel(role: unknown, position?: string | null): string {
  if (isAdminRole(role)) return ADMIN_POSITION;
  if (isTeacherRole(role)) return normalizeTeacherPosition(position) || "";
  return "";
}

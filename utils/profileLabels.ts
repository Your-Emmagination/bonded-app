export function getProfileIdLabel(role?: string): string {
  switch ((role || "").toLowerCase()) {
    case "teacher":
      return "Teacher ID";
    case "admin":
      return "Admin ID";
    case "moderator":
      return "Moderator ID";
    default:
      return "Student ID";
  }
}

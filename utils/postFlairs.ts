export const POST_FLAIRS = [
  { id: "discussion", label: "Discussion", emoji: "💬", staffOnly: false },
  { id: "question", label: "Question", emoji: "❓", staffOnly: false },
  { id: "academic", label: "Academic", emoji: "🎓", staffOnly: false },
  { id: "study", label: "Study", emoji: "📚", staffOnly: false },
  { id: "help", label: "Help / Advice", emoji: "🆘", staffOnly: false },
  { id: "event_moments", label: "Event Moments", emoji: "📸", staffOnly: false },
  { id: "community", label: "Community", emoji: "🤝", staffOnly: false },
  { id: "fun_humor", label: "Fun / Humor", emoji: "😂", staffOnly: false },
  { id: "achievement", label: "Achievement", emoji: "🏆", staffOnly: false },
  { id: "lost_found", label: "Lost & Found", emoji: "🔎", staffOnly: false },
  { id: "projects", label: "Projects", emoji: "💻", staffOnly: false },
  { id: "sports", label: "Sports", emoji: "🏀", staffOnly: false },
  { id: "announcement", label: "Announcement", emoji: "📢", staffOnly: true },
] as const;
export type PostFlairId = (typeof POST_FLAIRS)[number]["id"];
export const DEFAULT_POST_FLAIR: PostFlairId = "discussion";
export const STAFF_POST_FLAIR_ROLES = new Set(["admin", "teacher", "moderator", "superadmin"]);
export const normalizePostFlair = (value?: string | null): PostFlairId => {
  const normalized = String(value || "").trim().toLowerCase();
  return POST_FLAIRS.find((flair) => flair.id === normalized)?.id || DEFAULT_POST_FLAIR;
};
export const getPostFlair = (value?: string | null) => {
  const id = normalizePostFlair(value);
  return POST_FLAIRS.find((flair) => flair.id === id) || POST_FLAIRS[0];
};
export const canUsePostFlair = (flairId: PostFlairId, role?: string | null) => {
  const flair = getPostFlair(flairId);
  return !flair.staffOnly || STAFF_POST_FLAIR_ROLES.has(String(role || "").toLowerCase());
};

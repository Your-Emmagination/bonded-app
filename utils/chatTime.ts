// utils/chatTime.ts
//
// How time is written inside conversations — DMs and Help & Support.
//
// Relative times ("5m", "2h") are right for a feed, where what matters is how
// fresh something is. In a conversation people look back to find out *when*
// something was said, and "2h" stops meaning anything by tomorrow. These give
// real clock times, with the day spelled out only once it isn't today.

export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** "3:42 PM". */
export function formatClockTime(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const startOfDay = (date: Date) => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

/** 0 for today, 1 for yesterday, and so on. */
const daysAgo = (date: Date, now: Date) =>
  Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000);

/**
 * A day on its own, for the label that opens each day of a conversation:
 * "Today", "Yesterday", "Friday", "Sep 2", "Sep 2, 2025".
 */
export function formatDayLabel(ms: number, nowMs: number): string {
  const date = new Date(ms);
  const now = new Date(nowMs);
  const ago = daysAgo(date, now);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago > 1 && ago < 7) return date.toLocaleDateString("en-US", { weekday: "long" });
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * A moment, the way Messenger labels a break in a conversation: just the time
 * today, then "Yesterday 9:30 PM", "Fri 8:00 AM", and "Sep 2, 2:00 PM".
 */
export function formatChatTimeLabel(ms: number, nowMs: number): string {
  const date = new Date(ms);
  const now = new Date(nowMs);
  const time = formatClockTime(ms);
  const ago = daysAgo(date, now);
  if (ago === 0) return time;
  if (ago === 1) return `Yesterday ${time}`;
  if (ago > 1 && ago < 7) {
    return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  }
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day}, ${time}`;
}

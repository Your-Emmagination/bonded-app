export type TimedEvent = {
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  category: string;
};

const localDate = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1]) &&
    date.getMonth() === Number(match[2]) - 1 &&
    date.getDate() === Number(match[3]) ? date : null;
};

const clock = (value?: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value || "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 24 && minute <= 59 && (hour !== 24 || minute === 0) ? hour * 60 + minute : null;
};

export const getEventTimingWindow = (event: TimedEvent, allowLegacyOvernight = true) => {
  const startDate = localDate(event.date);
  const endDate = localDate(event.endDate || event.date);
  if (!startDate || !endDate) return null;
  const allDay = event.category === "all-day" || (!event.startTime && !event.endTime);
  if (allDay) {
    return {
      startMs: startDate.getTime(),
      endMs: new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1).getTime(),
      allDay: true,
    };
  }
  const hasStart = Boolean(event.startTime?.trim());
  const hasEnd = Boolean(event.endTime?.trim());
  const startMinutes = clock(event.startTime);
  const endMinutes = clock(event.endTime);
  if ((hasStart && startMinutes === null) || (hasEnd && endMinutes === null)) return null;
  if (event.endDate && (!hasStart || !hasEnd)) return null;
  const startMs = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, startMinutes || 0).getTime();
  let endMs = hasEnd
    ? new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 0, endMinutes || 0).getTime()
    : new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1).getTime();
  // Old records have no endDate and intentionally interpreted an earlier end
  // clock as the next day. New records always specify endDate and are validated.
  if (!event.endDate && allowLegacyOvernight && hasStart && hasEnd && endMs <= startMs) {
    endMs = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1, 0, endMinutes || 0).getTime();
  }
  return { startMs, endMs, allDay: false };
};

export const getEventTimingStatus = (event: TimedEvent, nowMs: number) => {
  const window = getEventTimingWindow(event);
  if (!window) return null;
  const format = (timestamp: number) => new Date(timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (nowMs >= window.endMs) return { status: "ended" as const, label: "Ended", supportingText: window.allDay ? "" : `Ended at ${format(window.endMs)}` };
  if (nowMs >= window.startMs) {
    const remaining = window.endMs - nowMs;
    return { status: "ongoing" as const, label: "Ongoing", supportingText: window.allDay ? "All day" : remaining <= 30 * 60_000 ? `Ends in ${Math.max(1, Math.ceil(remaining / 60_000))} min` : `Ends at ${format(window.endMs)}` };
  }
  const remaining = window.startMs - nowMs;
  if (!window.allDay && remaining <= 30 * 60_000) {
    return { status: "starting-soon" as const, label: remaining < 60_000 ? "Starting now" : `Starting in ${Math.ceil(remaining / 60_000)} min`, supportingText: `Starts at ${format(window.startMs)}` };
  }
  const start = new Date(window.startMs);
  const today = new Date(nowMs);
  const sameDay = start.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const dayLabel = sameDay ? "today" : start.toDateString() === tomorrow.toDateString() ? "tomorrow" : start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { status: "upcoming" as const, label: "Upcoming", supportingText: window.allDay ? `Starts ${dayLabel}` : `Starts ${dayLabel} at ${format(window.startMs)}` };
};

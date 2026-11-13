// utils/eventAnswers.ts
//
// "What are the upcoming events?" for B.E.A.'s on-phone bot, read the way the
// calendar shows them: a main event and its timed parts are one event with a
// program, drafts and cancelled events are left out, and something that ended
// an hour ago is no longer "upcoming". Pure, so scripts/test-event-answers.ts
// can check it. (The Worker's events tool does the same for the AI.)
import { getEventTimingWindow, type TimedEvent } from "./eventTiming";

export type AnswerableEvent = {
  id: string;
  title?: string;
  date?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  category?: string;
  venue?: string;
  status?: string;
  cancelled?: boolean;
  parentEventId?: string | null;
  forPrograms?: string[];
};

type EventWindow = { startMs: number; endMs: number; allDay: boolean };

export type UpcomingEvent<T extends AnswerableEvent> = {
  event: T;
  /** Its timed parts, in start order (any that can't be read are left out). */
  parts: { part: T; window: EventWindow }[];
  /** From its first start to its last end, parts included. */
  window: EventWindow;
  /** The event's own dates and times, or null when they can't be read. */
  ownWindow: EventWindow | null;
};

const timingOf = (event: AnswerableEvent): TimedEvent => ({
  date: String(event.date || ""),
  endDate: event.endDate || undefined,
  startTime: event.startTime || undefined,
  endTime: event.endTime || undefined,
  category: String(event.category || ""),
});

const windowOf = (event: AnswerableEvent): EventWindow | null => getEventTimingWindow(timingOf(event));

/** Shown on the calendar: published (or older events with no status), not cancelled. */
const isListed = (event: AnswerableEvent) =>
  !event.cancelled && String(event.status || "published") === "published";

/** The events still to come or running at nowMs, soonest first, at most `limit`. */
export function upcomingEvents<T extends AnswerableEvent>(
  events: T[],
  nowMs: number,
  limit = 5,
): UpcomingEvent<T>[] {
  const listed = events.filter(isListed);
  const ids = new Set(listed.map((event) => event.id));
  const partsOf = new Map<string, T[]>();
  const mains: T[] = [];
  listed.forEach((event) => {
    const parentId = String(event.parentEventId || "");
    // A part whose main event isn't here (archived, or older than what was
    // read) stands on its own rather than disappearing.
    if (parentId && ids.has(parentId)) partsOf.set(parentId, [...(partsOf.get(parentId) || []), event]);
    else mains.push(event);
  });

  return mains
    .map((event): UpcomingEvent<T> | null => {
      const parts = (partsOf.get(event.id) || [])
        .map((part) => ({ part, window: windowOf(part) }))
        .filter((entry): entry is { part: T; window: EventWindow } => Boolean(entry.window))
        .sort((a, b) => a.window.startMs - b.window.startMs);
      const ownWindow = windowOf(event);
      const windows = [ownWindow, ...parts.map((entry) => entry.window)].filter(
        (window): window is EventWindow => Boolean(window),
      );
      if (!windows.length) return null;
      return {
        event,
        parts,
        ownWindow,
        window: {
          startMs: Math.min(...windows.map((window) => window.startMs)),
          endMs: Math.max(...windows.map((window) => window.endMs)),
          allDay: ownWindow ? ownWindow.allDay : false,
        },
      };
    })
    .filter((item): item is UpcomingEvent<T> => Boolean(item) && item!.window.endMs > nowMs)
    .sort((a, b) => a.window.startMs - b.window.startMs)
    .slice(0, limit);
}

// ── Wording ─────────────────────────────────────────────────────────────

const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** "8 am", "3:30 pm". */
const timeLabel = (ms: number) => {
  const date = new Date(ms);
  const hour = date.getHours();
  const minute = date.getMinutes();
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour >= 12 ? "pm" : "am"}`;
};

const sameDay = (first: number, second: number) => dayLabel(first) === dayLabel(second);

/** "Fri, Sep 26, 8 am – 5 pm", "Fri, Sep 26 – Sat, Sep 27", "Fri, Sep 26 (all day)". */
export function describeWindow(window: EventWindow, event?: AnswerableEvent): string {
  const firstDay = dayLabel(window.startMs);
  const lastDay = dayLabel(window.endMs - 1);
  if (window.allDay) return firstDay === lastDay ? `${firstDay} (all day)` : `${firstDay} – ${lastDay}`;
  const start = `${firstDay}, ${timeLabel(window.startMs)}`;
  // A start time alone: the event runs "until the end of the day", which
  // isn't a real end to announce.
  if (event && event.startTime && !event.endTime) return start;
  return firstDay === lastDay
    ? `${start} – ${timeLabel(window.endMs)}`
    : `${start} – ${lastDay}, ${timeLabel(window.endMs)}`;
}

/** When a part happens, said briefly next to its main event: "at 9:30 am", or "on Sat, Sep 27 at 1 pm". */
const partTime = (window: EventWindow, nowMs: number) =>
  sameDay(window.startMs, nowMs)
    ? `at ${timeLabel(window.startMs)}`
    : `on ${dayLabel(window.startMs)} at ${timeLabel(window.startMs)}`;

/**
 * One line for one event: when, where, for whom, and for a main event what's
 * on now or next in its program.
 */
export function describeUpcomingEvent<T extends AnswerableEvent>(
  item: UpcomingEvent<T>,
  nowMs: number,
): string {
  const { event, parts, window } = item;
  const title = String(event.title || "Untitled event").trim();
  const happeningNow = nowMs >= window.startMs;
  let when: string;
  if (!happeningNow) {
    when = describeWindow(window, parts.length ? undefined : event);
  } else if (!sameDay(window.endMs - 1, nowMs)) {
    when = `happening now, until ${dayLabel(window.endMs - 1)}`;
  } else if (window.allDay) {
    when = "today (all day)";
  } else if (!parts.length && event.startTime && !event.endTime) {
    when = "happening now";
  } else {
    when = `happening now, until ${timeLabel(window.endMs)}`;
  }
  const venue = String(event.venue || "").trim();
  const programs = (event.forPrograms || []).map((program) => String(program).trim()).filter(Boolean);

  let line = `**${title}** — ${when}`;
  if (venue) line += ` · ${venue}`;
  if (programs.length) line += ` · for ${programs.join(", ")}`;

  if (parts.length) {
    const running = parts.filter((entry) => nowMs >= entry.window.startMs && nowMs < entry.window.endMs);
    const next = parts.find((entry) => entry.window.startMs > nowMs);
    if (running.length) {
      line += `. Now: ${running
        .slice(0, 2)
        .map((entry) => `**${String(entry.part.title || "").trim()}** (until ${timeLabel(entry.window.endMs)})`)
        .join(" and ")}`;
    }
    if (next) {
      line += `. ${running.length || happeningNow ? "Next" : "First up"}: **${String(next.part.title || "").trim()}** ${partTime(next.window, nowMs)}`;
    }
  }
  return `${line}.`;
}

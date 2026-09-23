// utils/eventProgram.ts
//
// A main event's program: the timed sub-events ("parts") under it, and what
// is running right now. Pure functions on top of getEventTimingWindow, so the
// calendar can say "NOW Holy Mass · ends 9:00" without keeping any of it in
// Firestore — a stored status would go stale the moment nobody opened the app.
import { getEventTimingWindow, type TimedEvent } from "./eventTiming";

/** What the Now / Up next strip on a main event card is showing. */
export type ProgramState =
  /** The program hasn't started. */
  | "before"
  /** Exactly one part is running. */
  | "now"
  /** Two or more parts are running in different places. */
  | "many"
  /** Nothing is running, but something follows. */
  | "gap"
  /** Everything has finished. */
  | "done"
  /** No part has a readable schedule. */
  | "empty";

export type ProgramSummary<T> = {
  state: ProgramState;
  /** Everything running right now, in start order. Often more than one. */
  running: T[];
  /** The next part to start, which may be on a later day. */
  next: T | null;
};

/**
 * What is happening inside a main event at `nowMs`.
 *
 * Parts with a broken or missing schedule are skipped rather than guessed at,
 * so one bad row never takes the strip down with it.
 */
export function summarizeProgram<T extends TimedEvent>(
  parts: T[],
  nowMs: number,
): ProgramSummary<T> {
  const scheduled = parts
    .map((part) => ({ part, window: getEventTimingWindow(part) }))
    .filter((entry): entry is { part: T; window: NonNullable<typeof entry.window> } =>
      Boolean(entry.window),
    )
    .sort((first, second) => first.window.startMs - second.window.startMs);

  if (scheduled.length === 0) return { state: "empty", running: [], next: null };

  const running = scheduled
    .filter((entry) => nowMs >= entry.window.startMs && nowMs < entry.window.endMs)
    .map((entry) => entry.part);
  const next = scheduled.find((entry) => entry.window.startMs > nowMs)?.part ?? null;
  const started = nowMs >= scheduled[0].window.startMs;

  if (running.length > 1) return { state: "many", running, next };
  if (running.length === 1) return { state: "now", running, next };
  if (next) return { state: started ? "gap" : "before", running: [], next };
  return { state: "done", running: [], next: null };
}

export type ProgramSlot<T> = {
  /** Stable key for the row list. */
  key: string;
  startMs: number;
  /** Two or more means they run at the same time, in different venues. */
  parts: T[];
};

/**
 * The program in time order, with everything that starts at the same moment
 * kept together. A sports day runs three games at once; listed one under the
 * other they read as a queue, and a student walks to the wrong place.
 */
export function groupPartsByStart<T extends TimedEvent>(parts: T[]): ProgramSlot<T>[] {
  const slots = new Map<number, T[]>();
  const unscheduled: T[] = [];

  parts.forEach((part) => {
    const window = getEventTimingWindow(part);
    if (!window) {
      unscheduled.push(part);
      return;
    }
    const existing = slots.get(window.startMs);
    if (existing) existing.push(part);
    else slots.set(window.startMs, [part]);
  });

  const ordered = [...slots.entries()]
    .sort((first, second) => first[0] - second[0])
    .map(([startMs, group]) => ({ key: String(startMs), startMs, parts: group }));

  // A part with no usable time still has to be reachable, so it sits at the
  // end rather than disappearing from the program.
  if (unscheduled.length) {
    ordered.push({ key: "unscheduled", startMs: Number.MAX_SAFE_INTEGER, parts: unscheduled });
  }
  return ordered;
}

/** One card in the calendar timeline: see buildTimelineCards. */
export type TimelineCard<T> = {
  key: string;
  date: string;
  event: T;
  /** That day's parts, in time order. Empty for an ordinary event. */
  dayParts: T[];
  /** "Day 2 of 5", counted over the days that actually have parts. */
  dayIndex: number;
  totalDays: number;
};

type TimelineEvent = {
  id: string;
  date: string;
  startTime?: string;
  parentEventId?: string | null;
};

/**
 * Turns the calendar's events into the cards a day list should draw.
 *
 * A main event gets one card for every day it has parts on, carrying that
 * day's parts — so a five-day Siglakas appears on each of its five days and
 * counts down that day's program. Its parts never get cards of their own,
 * which is what stopped "Siglakas 2027" and "Foot parade" sitting side by side
 * as if they were separate events. A part whose main event is missing — 
 * archived, or filtered out of this view — still gets its own card, so nothing
 * disappears from the calendar.
 */
export function buildTimelineCards<T extends TimelineEvent>(events: T[]): TimelineCard<T>[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const partsByParentDay = new Map<string, T[]>();
  const daysByParent = new Map<string, string[]>();

  events.forEach((event) => {
    const parentId = String(event.parentEventId || "");
    if (!parentId || !byId.has(parentId)) return;
    const dayKey = `${parentId}|${event.date}`;
    const sameDay = partsByParentDay.get(dayKey);
    if (sameDay) sameDay.push(event);
    else partsByParentDay.set(dayKey, [event]);
    const days = daysByParent.get(parentId) || [];
    if (!days.includes(event.date)) {
      days.push(event.date);
      daysByParent.set(parentId, days);
    }
  });
  daysByParent.forEach((days) => days.sort());
  partsByParentDay.forEach((parts) =>
    parts.sort((first, second) => (first.startTime || "").localeCompare(second.startTime || "")),
  );

  const cards: TimelineCard<T>[] = [];
  events.forEach((event) => {
    const parentId = String(event.parentEventId || "");
    if (parentId && byId.has(parentId)) return;

    const days = daysByParent.get(event.id);
    if (!days || days.length === 0) {
      cards.push({ key: event.id, date: event.date, event, dayParts: [], dayIndex: 0, totalDays: 0 });
      return;
    }
    days.forEach((day, index) => {
      cards.push({
        key: `${event.id}|${day}`,
        date: day,
        event,
        dayParts: partsByParentDay.get(`${event.id}|${day}`) || [],
        dayIndex: index + 1,
        totalDays: days.length,
      });
    });
  });
  return cards;
}

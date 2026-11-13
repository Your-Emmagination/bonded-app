/// <reference types="node" />
// B.E.A.'s on-phone answer to "what are the upcoming events?"
// (utils/eventAnswers.ts): events read the way the calendar shows them.
//
// Run with: npx tsx scripts/test-event-answers.ts
import assert from "node:assert/strict";
import { describeUpcomingEvent, upcomingEvents, type AnswerableEvent } from "../utils/eventAnswers";

// Wednesday, Sep 23 2026, 10:00 AM on this machine's clock, like the phone's.
const NOW = new Date(2026, 8, 23, 10, 0).getTime();
const day = (offset: number) => {
  const date = new Date(2026, 8, 23 + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

const events: AnswerableEvent[] = [
  // A two-day main event with its program. At 10:00 the Mass is over and the
  // parade is on.
  { id: "sig", title: "Siglakas 2027", date: day(0), endDate: day(1), startTime: "08:00", endTime: "17:00", venue: "Campus grounds", forPrograms: ["BSIT"], status: "published" },
  { id: "p1", title: "Holy Mass", date: day(0), endDate: day(0), startTime: "08:00", endTime: "09:00", parentEventId: "sig", status: "published" },
  { id: "p2", title: "Parade", date: day(0), endDate: day(0), startTime: "09:30", endTime: "11:00", parentEventId: "sig", status: "published" },
  { id: "p3", title: "Games", date: day(1), endDate: day(1), startTime: "13:00", endTime: "17:00", parentEventId: "sig", status: "published" },
  { id: "p4", title: "Draft part", date: day(1), startTime: "18:00", endTime: "19:00", parentEventId: "sig", status: "draft" },
  // Ended an hour ago: today, but not upcoming.
  { id: "am", title: "Morning Assembly", date: day(0), endDate: day(0), startTime: "07:00", endTime: "09:00" },
  // A start time and no end.
  { id: "fd", title: "Foundation Day", date: day(2), startTime: "08:00", venue: "Gym" },
  { id: "x1", title: "Cancelled Seminar", date: day(1), startTime: "09:00", endTime: "10:00", cancelled: true },
  { id: "x2", title: "Draft Event", date: day(1), status: "draft" },
  { id: "old", title: "Old Seminar", date: day(-3) },
  // All day, and an older event with no status at all.
  { id: "it", title: "IT Summit", date: day(5), category: "all-day" },
  // A part whose main event isn't among these: it stands on its own.
  { id: "orphan", title: "Awarding", date: day(6), startTime: "15:00", endTime: "16:00", parentEventId: "gone" },
];

const upcoming = upcomingEvents(events, NOW, 5);
assert.deepEqual(
  upcoming.map((item) => item.event.title),
  ["Siglakas 2027", "Foundation Day", "IT Summit", "Awarding"],
  "Soonest first; parts inside their event; no drafts, cancelled or ended events",
);
assert.deepEqual(upcoming[0].parts.map((entry) => entry.part.title), ["Holy Mass", "Parade", "Games"]);
assert.equal(upcomingEvents(events, NOW, 2).length, 2, "The limit holds");

const lines = upcoming.map((item) => describeUpcomingEvent(item, NOW));
assert.equal(
  lines[0],
  "**Siglakas 2027** — happening now, until Thu, Sep 24 · Campus grounds · for BSIT. Now: **Parade** (until 11 am). Next: **Games** on Thu, Sep 24 at 1 pm.",
);
assert.equal(lines[1], "**Foundation Day** — Fri, Sep 25, 8 am · Gym.");
assert.equal(lines[2], "**IT Summit** — Mon, Sep 28 (all day).");
assert.equal(lines[3], "**Awarding** — Tue, Sep 29, 3 pm – 4 pm.");

// Before a program starts: its first part.
const early = new Date(2026, 8, 23, 7, 30).getTime();
const before = describeUpcomingEvent(upcomingEvents(events, early, 5).find((item) => item.event.id === "sig")!, early);
assert.equal(
  before,
  "**Siglakas 2027** — Wed, Sep 23, 8 am – Thu, Sep 24, 5 pm · Campus grounds · for BSIT. First up: **Holy Mass** at 8 am.",
);

// After everything: nothing.
assert.deepEqual(upcomingEvents(events, new Date(2026, 9, 30).getTime(), 5), []);

console.log("Event answers: 9 checks passed.");

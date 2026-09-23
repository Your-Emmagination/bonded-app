import assert from "node:assert/strict";
import test from "node:test";
import { getEventTimingStatus, getEventTimingWindow } from "../utils/eventTiming";
import { buildTimelineCards, groupPartsByStart, summarizeProgram } from "../utils/eventProgram";
import { audienceLabel, matchesEventAudience, normalizeAudience } from "../utils/eventAudience";

const local = (day: number, hour = 0, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const event = { date: "2026-09-20", endDate: "2026-09-20", startTime: "10:00", endTime: "11:00", category: "morning" };

test("timed events move through upcoming, starting soon, ongoing and ended", () => {
  assert.equal(getEventTimingStatus(event, local(20, 9, 29))?.status, "upcoming");
  for (const minutes of [30, 15, 5, 1]) {
    assert.equal(getEventTimingStatus(event, local(20, 10, 0) - minutes * 60_000)?.label, `Starting in ${minutes} min`);
  }
  assert.equal(getEventTimingStatus(event, local(20, 10, 0) - 30_000)?.label, "Starting now");
  assert.equal(getEventTimingStatus(event, local(20, 10, 0))?.status, "ongoing");
  assert.equal(getEventTimingStatus(event, local(20, 10, 45))?.supportingText, "Ends in 15 min");
  assert.equal(getEventTimingStatus(event, local(20, 11, 0))?.status, "ended");
});

test("all-day spans include their end date without minute countdowns", () => {
  const allDay = { date: "2026-09-20", endDate: "2026-09-22", category: "all-day" };
  assert.equal(getEventTimingStatus(allDay, local(19))?.status, "upcoming");
  assert.equal(getEventTimingStatus(allDay, local(22, 23, 59))?.status, "ongoing");
  assert.equal(getEventTimingStatus(allDay, local(23))?.status, "ended");
  assert.equal(getEventTimingStatus(allDay, local(22, 23, 59))?.supportingText, "All day");
});

test("timed events can end on a later calendar date", () => {
  const overnight = { ...event, endDate: "2026-09-21", startTime: "22:00", endTime: "01:00" };
  assert.equal(getEventTimingStatus(overnight, local(20, 23))?.status, "ongoing");
  assert.equal(getEventTimingStatus(overnight, local(21, 0, 45))?.supportingText, "Ends in 15 min");
  assert.equal(getEventTimingStatus(overnight, local(21, 1))?.status, "ended");
});

test("new invalid ranges fail while legacy overnight events remain readable", () => {
  assert.ok((getEventTimingWindow({ ...event, endDate: "2026-09-19" }, false)?.endMs || 0) < local(20, 10));
  assert.ok((getEventTimingWindow({ ...event, endTime: "09:00" }, false)?.endMs || 0) < local(20, 10));
  assert.equal(getEventTimingWindow({ ...event, startTime: "broken" }), null);
  const legacy = getEventTimingWindow({ ...event, endDate: undefined, endTime: "09:00" });
  assert.equal(legacy?.endMs, local(21, 9));
});

const part = (title: string, startTime: string, endTime: string, venue = "", day = 20) => ({
  id: title, title, venue, date: `2026-09-${day}`, endDate: `2026-09-${day}`,
  startTime, endTime, category: "morning",
});

test("a program knows what is running, and what follows", () => {
  const parts = [part("Foot parade", "07:00", "08:00"), part("Holy Mass", "08:00", "09:00"), part("Opening", "09:00", "10:00")];
  assert.equal(summarizeProgram(parts, local(20, 6, 30)).state, "before");
  assert.equal(summarizeProgram(parts, local(20, 6, 30)).next?.title, "Foot parade");
  const during = summarizeProgram(parts, local(20, 8, 24));
  assert.equal(during.state, "now");
  assert.deepEqual(during.running.map((item) => item.title), ["Holy Mass"]);
  assert.equal(during.next?.title, "Opening");
  assert.equal(summarizeProgram(parts, local(20, 10)).state, "done");
  assert.equal(summarizeProgram([], local(20, 10)).state, "empty");
});

test("games in three venues at once are all reported, and a gap is a gap", () => {
  const parts = [
    part("Basketball", "08:00", "09:30", "Covered court"),
    part("Volleyball", "09:00", "10:30", "Open field"),
    part("Chess", "09:00", "10:00", "AVR"),
    part("Championship", "13:00", "15:00", "Covered court"),
  ];
  const clash = summarizeProgram(parts, local(20, 9, 20));
  assert.equal(clash.state, "many");
  assert.deepEqual(clash.running.map((item) => item.title), ["Basketball", "Volleyball", "Chess"]);
  const gap = summarizeProgram(parts, local(20, 11));
  assert.equal(gap.state, "gap");
  assert.equal(gap.next?.title, "Championship");
  assert.equal(gap.running.length, 0);
});

test("parts that start together are grouped, in time order", () => {
  const slots = groupPartsByStart([
    part("Championship", "13:00", "15:00"),
    part("Chess", "09:00", "10:00"),
    part("Volleyball", "09:00", "10:30"),
    { ...part("Unscheduled", "", ""), date: "broken" },
  ]);
  assert.deepEqual(slots.map((slot) => slot.parts.map((item) => item.title)),
    [["Chess", "Volleyball"], ["Championship"], ["Unscheduled"]]);
  assert.equal(slots[0].startMs, local(20, 9));
});

test("an audience limits who sees an event without hiding it from staff", () => {
  assert.equal(matchesEventAudience([], { course: "BSIT" }), true);
  assert.equal(matchesEventAudience(["BSIT"], { course: "BSIT" }), true);
  assert.equal(matchesEventAudience(["BSIT"], { course: "bsit" }), true);
  assert.equal(matchesEventAudience(["BSIT"], { course: "BSED" }), false);
  assert.equal(matchesEventAudience(["BSIT"], { course: "BSED", isStaff: true }), true);
  // A profile with no program yet must never end up with an empty calendar.
  assert.equal(matchesEventAudience(["BSIT"], { course: "" }), true);
  assert.equal(audienceLabel([]), "Whole campus");
  assert.equal(audienceLabel(["BSIT"]), "BSIT only");
  assert.equal(audienceLabel(["BSIT", "BSED"]), "BSIT · BSED");
  assert.equal(audienceLabel(["BSIT", "BSED", "BSBA"]), "BSIT +2 more");
  assert.deepEqual(normalizeAudience(["BSIT", " BSIT ", "", 4]), ["BSIT"]);
});

test("a five-day event gets one card per day, and its parts get none", () => {
  const main = { id: "siglakas", date: "2027-02-01", parentEventId: null };
  const events = [
    main,
    { id: "parade", date: "2027-02-01", startTime: "07:00", parentEventId: "siglakas" },
    { id: "mass", date: "2027-02-01", startTime: "08:00", parentEventId: "siglakas" },
    { id: "chess", date: "2027-02-03", startTime: "09:00", parentEventId: "siglakas" },
    { id: "basketball", date: "2027-02-03", startTime: "08:00", parentEventId: "siglakas" },
    { id: "foundation", date: "2027-02-20", parentEventId: null },
  ];
  const cards = buildTimelineCards(events);

  // Two days of Siglakas, plus the standalone event. No card for any part.
  assert.deepEqual(cards.map((card) => card.key),
    ["siglakas|2027-02-01", "siglakas|2027-02-03", "foundation"]);
  assert.deepEqual(cards[0].dayParts.map((part) => part.id), ["parade", "mass"]);
  // Same day, earlier start first.
  assert.deepEqual(cards[1].dayParts.map((part) => part.id), ["basketball", "chess"]);
  assert.deepEqual([cards[1].dayIndex, cards[1].totalDays], [2, 2]);
  assert.deepEqual([cards[2].dayIndex, cards[2].totalDays, cards[2].dayParts.length], [0, 0, 0]);
});

test("a part whose main event is missing still gets its own card", () => {
  const cards = buildTimelineCards([
    { id: "orphan", date: "2027-02-02", startTime: "08:00", parentEventId: "archived-event" },
  ]);
  assert.deepEqual(cards.map((card) => card.key), ["orphan"]);
  assert.equal(cards[0].totalDays, 0);
});

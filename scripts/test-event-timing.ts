import assert from "node:assert/strict";
import test from "node:test";
import { getEventTimingStatus, getEventTimingWindow } from "../utils/eventTiming";

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

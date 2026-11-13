/// <reference types="node" />
// B.E.A.'s database tools (cloudflare/ai-worker/src/beaTools.js), with no
// network: a fake select() stands in for Firestore. The fake rows carry
// fields no tool may pass on — emails, IDs, phone numbers — to prove the
// allowlists hold even if the database hands them over.
import assert from "node:assert/strict";
import {
  BEA_FORBIDDEN_KEYS,
  BEA_TOOL_DECLARATIONS,
  BEA_TOOL_NAMES,
  clampLimit,
  cleanText,
  keywordsOf,
  pickFields,
  rankByKeywords,
  runBeaTool,
  schoolDate,
} from "../cloudflare/ai-worker/src/beaTools.js";

const NOW = Date.parse("2026-09-23T02:00:00Z"); // 10:00 AM in the Philippines
const day = (offset: number) => schoolDate(NOW, offset);
const secret = { email: "juan@gmail.com", phone: "09171234567", studentID: "2023-001", uid: "abc", userId: "abc", realUserId: "abc", id: "doc1" };

const data: Record<string, Record<string, unknown>[]> = {
  events: [
    { title: "Foundation Day", date: day(2), startTime: "08:00", venue: "Gym", forPrograms: [], ...secret },
    { title: "IT Summit", date: day(5), forPrograms: ["Bachelor of Science in Information Systems"] },
    { title: "Old Seminar", date: day(-3) },
    { title: "Intramurals", date: day(-2), endDate: day(1), cancelled: true },
    { title: "Draft Event", date: day(1), status: "draft" },
    // A main event with its program; at NOW (10:00 AM) the Mass is over and
    // the parade is on.
    { __docId: "sig", title: "Siglakas 2027", date: day(0), endDate: day(1), startTime: "08:00", endTime: "17:00", venue: "Campus grounds", forPrograms: ["BSIT"] },
    { __docId: "p1", title: "Holy Mass", date: day(0), endDate: day(0), startTime: "08:00", endTime: "09:00", parentEventId: "sig", forPrograms: [] },
    { __docId: "p2", title: "Parade", date: day(0), endDate: day(0), startTime: "09:30", endTime: "11:00", venue: "Main road", parentEventId: "sig", forPrograms: [] },
    { __docId: "p3", title: "Games", date: day(1), endDate: day(1), startTime: "13:00", endTime: "17:00", parentEventId: "sig", forPrograms: [] },
    { __docId: "p4", title: "Draft part", date: day(1), startTime: "18:00", endTime: "19:00", parentEventId: "sig", status: "draft" },
    // Ended an hour before NOW: no longer upcoming, though it's today.
    { __docId: "am", title: "Morning Assembly", date: day(0), endDate: day(0), startTime: "07:00", endTime: "09:00" },
  ],
  programs: [{ name: "Bachelor of Science in Nursing", code: "BSN", ...secret }],
  campusFaq: [
    { question: "Where is the registrar's office?", answer: "Ground floor of the Admin building.", ...secret },
    { question: "What time does the library open?", answer: "7:30 AM to 6 PM on weekdays." },
  ],
  aiMemory: [
    { recordType: "aiMemory", title: "Uniform policy", content: "Wear the prescribed uniform Monday to Thursday.", scopeType: "global", active: true },
    { recordType: "aiMemory", title: "Private server note", content: "Uniform secret.", scopeType: "server", active: true },
  ],
  posts: [
    { flair: "announcement", content: "Classes are suspended tomorrow.", moderationStatus: "approved", createdAt: new Date(NOW - 3600e3).toISOString(), username: "Ms. Reyes", ...secret },
    { flair: "announcement", content: "Pending post", moderationStatus: "pending", createdAt: new Date(NOW).toISOString() },
    { flair: "lost_found", content: "Lost a black umbrella near the canteen", moderationStatus: "approved", createdAt: new Date(NOW - 86400e3).toISOString(), lostFoundStatus: "lost", username: "Juan", ...secret },
    { flair: "lost_found", content: "Found a blue umbrella", moderationStatus: "approved", createdAt: new Date(NOW - 86400e3).toISOString(), lostFoundStatus: "returned" },
  ],
  profiles: [
    { firstname: "Ana", lastname: "Reyes", role: "teacher", ...secret },
    { firstname: "Ben", lastname: "Cruz", role: "admin" },
    { firstname: "Carla", lastname: "Santos", role: "teacher", position: "Dean" },
  ],
  schoolOfficers: [],
};

const deps = {
  nowMs: NOW,
  select: async (key: string, filters: { field: string; op: string; value: unknown }[]) => {
    // Enough of Firestore's filtering for these tools: EQUAL, IN, >=.
    return (data[key] || []).filter((row) =>
      filters.every(({ field, op, value }) => {
        const actual = row[field];
        if (op === "EQUAL") return actual === value;
        if (op === "IN") return Array.isArray(value) && value.includes(actual);
        if (op === "GREATER_THAN_OR_EQUAL") return String(actual ?? "") >= String(value);
        return true;
      }),
    );
  },
};
const student = { uid: "stu", role: "student", course: "Bachelor of Science in Information Systems" };

/** No forbidden key anywhere in a tool's answer, however deep. */
function assertNoSecrets(value: unknown, where: string) {
  const text = JSON.stringify(value);
  for (const key of BEA_FORBIDDEN_KEYS) {
    assert.ok(!text.includes(`"${key}":`), `${where} leaked ${key}`);
  }
  for (const secretValue of ["juan@gmail.com", "09171234567", "2023-001"]) {
    assert.ok(!text.includes(secretValue), `${where} leaked ${secretValue}`);
  }
}

(async () => {
  // Helpers.
  assert.equal(cleanText("  hello   world  "), "hello world");
  assert.equal(cleanText(42), "");
  assert.equal(cleanText("x".repeat(300)).length, 100);
  assert.equal(clampLimit(undefined), 5);
  assert.equal(clampLimit(99), 10);
  assert.equal(clampLimit(-3), 1);
  assert.equal(clampLimit("abc", 3), 3);
  assert.deepEqual(keywordsOf("Where is the Registrar's office?"), ["registrar", "office"]);
  assert.deepEqual(pickFields({ name: "A", email: "x@y.z" }, ["name", "email"]), { name: "A" }, "Forbidden keys are dropped even when listed");
  assert.deepEqual(
    rankByKeywords("library hours", [{ t: "Library opening" }, { t: "Gym rules" }], { titleOf: (e: { t: string }) => e.t, bodyOf: () => "" }),
    [{ t: "Library opening" }],
  );
  assert.equal(schoolDate(Date.parse("2026-09-23T17:00:00Z")), "2026-09-24", "Philippine date, not UTC");

  // Every tool the AI is told about exists.
  assert.deepEqual(BEA_TOOL_DECLARATIONS.map((tool) => tool.name), BEA_TOOL_NAMES);

  // Events: upcoming and ongoing only, no drafts, cancellations marked,
  // audience shown, and a main event's parts inside it rather than beside it.
  const events = await runBeaTool("get_upcoming_events", {}, student, deps);
  assertNoSecrets(events, "events");
  assert.ok(!JSON.stringify(events).includes("__docId"), "Document ids stay inside the Worker");
  assert.deepEqual(
    events.events.map((e: { title: string }) => e.title),
    ["Intramurals", "Siglakas 2027", "Foundation Day", "IT Summit"],
    "Soonest first; parts and the ended assembly aren't separate events",
  );
  assert.equal(events.events[0].cancelled, true);
  const siglakas = events.events[1];
  assert.equal(siglakas.status, "happening now");
  assert.deepEqual(siglakas.program.map((p: { title: string }) => p.title), ["Parade", "Games"], "Parts still to come, no drafts");
  assert.equal(siglakas.program[0].status, "happening now");
  assert.equal(siglakas.program[1].status, "upcoming");
  assert.equal(siglakas.partsAlreadyDone, 1);
  assert.equal(siglakas.audience, "BSIT");
  assert.equal(siglakas.forYourProgram, false);
  assert.match(siglakas.when, /8:00 AM – .+, 5:00 PM$/, "Two days, in Philippine time");
  assert.equal(events.events[2].audience, "Whole campus");
  assert.match(events.events[2].when, /, 8:00 AM$/, "No end time given");
  assert.equal(events.events[2].status, "upcoming");
  assert.match(events.events[3].when, /\(all day\)$/);
  assert.equal(events.events[3].forYourProgram, true);

  // Programs.
  const programs = await runBeaTool("get_academic_programs", {}, student, deps);
  assertNoSecrets(programs, "programs");
  assert.deepEqual(programs.programs, [{ name: "Bachelor of Science in Nursing", code: "BSN" }]);

  // Campus knowledge: FAQ and global AI Memory only, never a server's memory.
  const registrar = await runBeaTool("search_campus_knowledge", { query: "where is the registrar" }, student, deps);
  assertNoSecrets(registrar, "knowledge");
  assert.equal(registrar.results[0].text, "Ground floor of the Admin building.");
  const uniform = await runBeaTool("search_campus_knowledge", { query: "uniform" }, student, deps);
  assert.deepEqual(uniform.results.map((r: { title: string }) => r.title), ["Uniform policy"], "Server-scoped memory stays out");
  assert.deepEqual(await runBeaTool("search_campus_knowledge", { query: "parking fees" }, student, deps), { found: false });
  assert.deepEqual(await runBeaTool("search_campus_knowledge", {}, student, deps), { error: "bad_arguments" }, "A query is required");

  // Announcements: approved only, newest first.
  const announcements = await runBeaTool("get_announcements", {}, student, deps);
  assertNoSecrets(announcements, "announcements");
  assert.deepEqual(announcements.announcements.map((a: { text: string }) => a.text), ["Classes are suspended tomorrow."]);

  // Lost & Found: open items only, and never who posted.
  const lost = await runBeaTool("find_lost_and_found", { query: "umbrella" }, student, deps);
  assertNoSecrets(lost, "lost and found");
  assert.equal(lost.items.length, 1, "Returned items are left out");
  assert.ok(!JSON.stringify(lost).includes("Juan"), "No poster name");

  // Staff: name and role only; a made-up role is refused.
  const staff = await runBeaTool("find_staff", { name: "reyes" }, student, deps);
  assertNoSecrets(staff, "staff");
  assert.deepEqual(staff.staff, [{ name: "Ana Reyes", role: "teacher" }]);
  assert.deepEqual(await runBeaTool("find_staff", { role: "student" }, student, deps), { error: "bad_arguments" }, "Students can't be listed");
  // A teacher's position: "who is the dean?"
  const dean = await runBeaTool("find_staff", { position: "dean" }, student, deps);
  assert.deepEqual(dean.staff, [{ name: "Carla Santos", role: "teacher", position: "Dean" }]);
  const deanByWord = await runBeaTool("find_staff", { name: "dean" }, student, deps);
  assert.equal(deanByWord.staff[0].name, "Carla Santos", "The word dean finds the Dean");

  // Officers: none saved yet, so "not found" rather than a guess.
  assert.deepEqual(await runBeaTool("get_school_officers", {}, student, deps), { found: false });

  // Unknown tools and database failures come back as small errors.
  assert.deepEqual(await runBeaTool("read_any_collection", { name: "students" }, student, deps), { error: "unknown_tool" });
  const failing = { ...deps, select: async () => { throw new Error("offline"); } };
  assert.deepEqual(await runBeaTool("get_academic_programs", {}, student, failing), { error: "unavailable" });

  console.log("B.E.A. tools: 37 checks passed.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

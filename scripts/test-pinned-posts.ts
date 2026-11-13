/// <reference types="node" />
// Pinned posts ("Important Announcements") and poll voting: which pins show,
// in what order, what their countdown says, and which votes are allowed.
// `npx tsx scripts/test-pinned-posts.ts`
//
// The helpers import the app's Firebase and storage setup, which can't run
// under Node; these stand-ins replace just those imports.
/* eslint-disable @typescript-eslint/no-require-imports */
import assert from "node:assert/strict";

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (/Firebase_configure$/.test(request)) return { auth: { currentUser: null }, db: {} };
  if (request.startsWith("@react-native-async-storage")) {
    return { __esModule: true, default: { getItem: async () => null, setItem: async () => undefined } };
  }
  return originalLoad.call(this, request, ...rest);
};
const { buildPinnedItems, pinEndsAtMs, pinUrgency, urgentPins } = require("../utils/pinnedPosts");
const { isPollClosed, planPollVote } = require("../utils/pollVoting");

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 24, 4, 0, 0);
const at = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000) });
let checks = 0;
const check = (fn: () => void) => { fn(); checks += 1; };

// ── When a pin ends
check(() => assert.equal(pinEndsAtMs("post", { pinnedAt: at(NOW) }), null, "No end"));
check(() => assert.equal(pinEndsAtMs("post", { pinExpiresAt: at(NOW + 5 * HOUR) }), NOW + 5 * HOUR));
check(() => assert.equal(pinEndsAtMs("poll", { expiresAt: at(NOW + 30 * HOUR) }), NOW + 30 * HOUR, "A poll's pin ends with its vote"));
check(() => assert.equal(pinEndsAtMs("poll", { pinExpiresAt: at(NOW + 2 * HOUR), expiresAt: at(NOW + 30 * HOUR) }), NOW + 2 * HOUR, "Whichever comes first"));
check(() => assert.equal(pinEndsAtMs("poll", { targetDate: at(NOW + HOUR) }), null, "targetDate is a post field only"));

// ── Which pins show, and in what order
const posts = [
  { id: "always-old", pinnedAt: at(NOW - 48 * HOUR), moderationStatus: "approved" },
  { id: "always-new", pinnedAt: at(NOW - 1 * HOUR) },
  { id: "soon", pinnedAt: at(NOW - 3 * HOUR), pinExpiresAt: at(NOW + 5 * HOUR), moderationStatus: "approved" },
  { id: "later", pinnedAt: at(NOW - 3 * HOUR), targetDate: at(NOW + 60 * HOUR) },
  { id: "ended", pinnedAt: at(NOW - 72 * HOUR), pinExpiresAt: at(NOW - HOUR) },
  { id: "pending", pinnedAt: at(NOW), moderationStatus: "pending" },
  { id: "server", pinnedAt: at(NOW), serverId: "srv1" },
  { id: "unpinned", pinnedAt: null },
];
const polls = [
  { id: "poll-open", pinnedAt: at(NOW - HOUR), expiresAt: at(NOW + 30 * HOUR) },
  { id: "poll-closed", pinnedAt: at(NOW - HOUR), expiresAt: at(NOW - 1000) },
];
const items = buildPinnedItems(posts, polls, NOW);
check(() => assert.deepEqual(
  items.map((item: { id: string }) => item.id),
  ["soon", "poll-open", "later", "always-new", "always-old"],
  "Ending soonest first, then no-end newest pinned first; ended, pending, server and closed-poll pins left out",
));
check(() => assert.equal(items.find((item: { id: string }) => item.id === "poll-open").kind, "poll"));

// ── Countdown wording (the announcement cards' wording)
check(() => assert.deepEqual(pinUrgency(null, NOW), { label: "No end", tone: "none" }));
check(() => assert.deepEqual(pinUrgency(NOW + 30 * 60 * 1000, NOW), { label: "Ends in < 1h", tone: "red" }));
check(() => assert.deepEqual(pinUrgency(NOW + 5 * HOUR, NOW), { label: "Ends in 5h", tone: "red" }));
check(() => assert.deepEqual(pinUrgency(NOW + 30 * HOUR, NOW), { label: "Ends tomorrow", tone: "amber" }));
check(() => assert.deepEqual(pinUrgency(NOW + 60 * HOUR, NOW), { label: "2 days left", tone: "amber" }));
check(() => assert.equal(pinUrgency(NOW + 10 * 24 * HOUR, NOW).tone, "date"));
check(() => assert.match(pinUrgency(NOW + 10 * 24 * HOUR, NOW).label, /^Until [A-Z][a-z]{2} \d{1,2}$/));

// ── The red chip on Home's bar: pins ending within a day
check(() => assert.deepEqual(urgentPins(items, NOW).map((item: { id: string }) => item.id), ["soon"]));

// ── Voting
const poll = (extra: Record<string, unknown> = {}) => ({
  options: [{ text: "A", votes: 1, voters: ["x"] }, { text: "B", votes: 0, voters: [] }],
  allowMultiple: false,
  maxSelections: 1,
  ...extra,
});
const vote = planPollVote(poll(), "me", 1);
check(() => assert.deepEqual(vote?.options.map((o: { votes: number }) => o.votes), [1, 1]));
check(() => assert.equal(vote?.totalVotes, 2));
check(() => assert.equal(planPollVote(poll({ options: [{ text: "A", voters: ["me"] }, { text: "B", voters: [] }] }), "me", 1), null, "One answer only"));
check(() => assert.equal(planPollVote(poll({ expiresAt: at(Date.now() - 1000) }), "me", 1), null, "Closed poll"));
const multi = poll({ allowMultiple: true, maxSelections: 2, options: [{ voters: ["me"] }, { voters: [] }, { voters: [] }] });
check(() => assert.notEqual(planPollVote(multi, "me", 1), null, "A second answer where two are allowed"));
check(() => assert.equal(planPollVote({ ...multi, options: [{ voters: ["me"] }, { voters: ["me"] }, { voters: [] }] }, "me", 2), null, "Not a third"));
check(() => assert.equal(planPollVote(multi, "me", 0), null, "Not the same option twice"));
check(() => assert.equal(isPollClosed(null), false));
check(() => assert.equal(isPollClosed(at(Date.now() + HOUR)), false));

console.log(`Pinned posts: ${checks} checks passed.`);

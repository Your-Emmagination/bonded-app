/// <reference types="node" />
// Polls inside server channels (utils/channelPolls.ts).
import assert from "node:assert/strict";
import {
  buildChannelPoll,
  appendUserPollOption,
  nextPollAnswer,
  pollIsClosed,
  pollMessageText,
  pollTimeLeft,
  tallyPoll,
  validatePollDraft,
} from "../utils/channelPolls";

const now = 1_800_000_000_000;
const HOUR = 3_600_000;

// Drafts.
assert.equal(validatePollDraft({ question: "", options: ["A", "B"] }), "Write the question.");
assert.equal(validatePollDraft({ question: "Field trip?", options: ["Yes", ""] }), "Add at least two options.");
assert.equal(validatePollDraft({ question: "Field trip?", options: ["Yes", "yes "] }), "Two options say the same thing.");
assert.equal(validatePollDraft({ question: "Field trip?", options: ["1", "2", "3", "4", "5", "6", "7"] }), "A poll can have up to 6 options.");
assert.equal(validatePollDraft({ question: "Field trip?", options: ["Friday", "Saturday", ""] }), null, "Blank extra options are fine");

// Building.
const poll = buildChannelPoll({ question: " Which day? ", options: ["Friday", " ", "Saturday"], allowMultiple: false, allowUsersToAddOption: true, durationMs: HOUR }, now);
assert.equal(poll.question, "Which day?");
assert.deepEqual(poll.options, [{ id: "o0", text: "Friday" }, { id: "o1", text: "Saturday" }], "Blanks dropped, ids in order");
assert.deepEqual(poll.optionIds, ["o0", "o1"]);
assert.equal(poll.allowUsersToAddOption, true);
assert.equal((poll.closesAt as Date).getTime(), now + HOUR);
assert.equal(pollMessageText(poll), "📊 Which day?\n• Friday\n• Saturday");

// Time.
assert.equal(pollIsClosed(poll, now), false);
assert.equal(pollIsClosed(poll, now + HOUR), true);
assert.equal(pollTimeLeft(poll, now), "Ends in 1h");
assert.equal(pollTimeLeft({ closesAt: new Date(now + 45 * 60000) }, now), "Ends in 45m");
assert.equal(pollTimeLeft({ closesAt: new Date(now + 5 * HOUR) }, now), "Ends in 5h");
assert.equal(pollTimeLeft({ closesAt: new Date(now + 72 * HOUR) }, now), "Ends in 3d");
assert.equal(pollTimeLeft(poll, now + 2 * HOUR), "Closed");
assert.equal(pollIsClosed({ closesAt: { seconds: (now + HOUR) / 1000 } }, now), false, "Saved timestamps work too");

// Results.
const voters = { amy: ["o0"], ben: ["o1"], cara: ["o0"], dan: [], eve: ["o9"] };
assert.deepEqual(tallyPoll(poll, voters, "amy"), { counts: { o0: 2, o1: 1 }, voterCount: 3, mine: ["o0"] }, "Empty and unknown answers don't count");
assert.deepEqual(tallyPoll(poll, undefined, "amy").voterCount, 0);

// Answering.
assert.deepEqual(nextPollAnswer({ allowMultiple: false }, [], "o0"), ["o0"]);
assert.deepEqual(nextPollAnswer({ allowMultiple: false }, ["o0"], "o1"), ["o1"], "One-answer polls switch");
assert.deepEqual(nextPollAnswer({ allowMultiple: false }, ["o0"], "o0"), [], "Tapping your answer takes it back");
assert.deepEqual(nextPollAnswer({ allowMultiple: true }, ["o0"], "o1"), ["o0", "o1"]);
assert.deepEqual(nextPollAnswer({ allowMultiple: true }, ["o0", "o1"], "o0"), ["o1"]);

// Member-added choices are append-only, attributed and de-duplicated.
const withMemberOption = appendUserPollOption(poll, "amy", " Sunday ", "abc123");
assert.deepEqual(withMemberOption.options[2], {
  id: "u_amy_abc123",
  text: "Sunday",
  isUserAdded: true,
  addedBy: "amy",
});
assert.deepEqual(withMemberOption.optionIds, ["o0", "o1", "u_amy_abc123"]);
assert.throws(() => appendUserPollOption(withMemberOption, "ben", "sunday", "next"), /already/);
assert.throws(
  () => appendUserPollOption({ ...poll, allowUsersToAddOption: false }, "amy", "Sunday", "x"),
  /not accepting/,
);
assert.equal(
  validatePollDraft({ question: "When?", options: ["Now", "Later"], durationMs: 0 }),
  "Choose a duration from 1 minute up to 30 days, 23 hours and 59 minutes.",
);

console.log("Channel polls: 35 checks passed.");

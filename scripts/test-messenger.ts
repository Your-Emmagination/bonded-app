/// <reference types="node" />
import assert from "node:assert/strict";
import { conversationPinnedMillis, getDirectNotificationTarget, getPresenceState, isConversationArchived, isConversationPinned, isConversationVisible, isMessageAfterDeletion, planOwnReaction, PRESENCE_TIMEOUT_MS, receiptCoversMessage } from "../utils/messengerState";
import { bigEmojiFontSize, EMOJI_HOLD_LARGE_MS, EMOJI_HOLD_MEDIUM_MS, EMOJI_HOLD_POP_MS, emojiSizeForHold, isEmojiOnly } from "../utils/emojiMessages";
import { directMentionsForText, findActiveDirectMention, insertDirectMention, splitDirectMentions } from "../utils/directMentions";
import { manualTaggedUsers, splitTaggedMentions } from "../utils/taggedUsers";

const now = 1_800_000_000_000;
const stamp = (ms: number) => ({ seconds: ms / 1000 });
assert.deepEqual(getPresenceState(null, now), { active: false, label: "Offline" });
assert.equal(getPresenceState({ isOnline: true }, now).active, false);
assert.equal(getPresenceState({ isOnline: true, lastSeen: stamp(now - 30_000) }, now).label, "Active");
assert.equal(getPresenceState({ isOnline: true, lastSeen: stamp(now - PRESENCE_TIMEOUT_MS) }, now).active, false);
assert.equal(getPresenceState({ isOnline: false, lastSeen: stamp(now - 120_000) }, now).label, "Offline · 2 minutes ago");
assert.equal(getPresenceState({ activeStatusEnabled: false, isOnline: true, lastSeen: stamp(now) }, now).label, "Offline");
assert.equal(getPresenceState({ presenceSessions: {
  phone: { isOnline: false, lastSeen: stamp(now) },
  browser: { isOnline: true, lastSeen: stamp(now - 30_000) },
} }, now).active, true, "An inactive device must not hide another active device");
assert.equal(getPresenceState({ presenceSessions: {
  phone: { isOnline: true, lastSeen: stamp(now - 120_000) },
  browser: { isOnline: true, lastSeen: stamp(now - 180_000) },
} }, now).label, "Offline · 2 minutes ago");
assert.equal(receiptCoversMessage(stamp(now), null), false);
assert.equal(receiptCoversMessage(stamp(now - 1_000), stamp(now)), false, "An older receipt must not cover a new message");
assert.equal(receiptCoversMessage(stamp(now), stamp(now)), true);
assert.equal(getDirectNotificationTarget({ entityType: "direct_message", parentId: "alice_bob" }), "alice_bob");
assert.equal(getDirectNotificationTarget({ entityType: "comment", parentId: "alice_bob", message: "sent you a message" }), "alice_bob");
assert.equal(getDirectNotificationTarget({ entityType: "comment", parentId: "post1" }), null);
assert.equal(getDirectNotificationTarget({ entityType: "direct_message", parentId: "invalid/path" }), null);
assert.equal(isConversationVisible({}, "alice"), false, "An empty legacy conversation is hidden");
assert.equal(isConversationVisible({ lastMessage: { createdAt: null } }, "alice"), false, "An uncommitted message must not create an inbox entry");
const deleted = { lastMessage: { createdAt: stamp(now) }, deletedThrough: { alice: stamp(now) } };
assert.equal(isConversationVisible(deleted, "alice"), false);
assert.equal(isConversationVisible(deleted, "bob"), true, "Deletion applies only to its owner");
assert.equal(isConversationVisible({ ...deleted, lastMessage: { createdAt: stamp(now + 1) } }, "alice"), true);
assert.equal(isMessageAfterDeletion(stamp(now), stamp(now)), false);
assert.equal(isMessageAfterDeletion({ seconds: 100, nanoseconds: 2000 }, { seconds: 100, nanoseconds: 1000 }), true, "Messages in the same millisecond retain their order");
const archived = { lastMessage: { createdAt: stamp(now) }, archivedThrough: { alice: stamp(now) } };
assert.equal(isConversationArchived(archived, "alice"), true);
assert.equal(isConversationArchived(archived, "bob"), false);
assert.equal(isConversationArchived({ ...archived, lastMessage: { createdAt: stamp(now + 1) } }, "alice"), false);
assert.equal(isConversationArchived({ ...archived, archivedThrough: { alice: null } }, "alice"), false);
assert.equal(isConversationArchived({ ...archived, deletedThrough: { alice: stamp(now) } }, "alice"), false);
assert.equal(isConversationArchived({ archivedThrough: { alice: stamp(now) } }, "alice"), false);
assert.equal(isConversationArchived(JSON.parse(JSON.stringify(archived)), "alice"), true, "Archive state survives offline-cache serialization");
assert.equal(isConversationArchived({ lastMessage: { createdAt: { seconds: 100, nanoseconds: 2000 } }, archivedThrough: { alice: { seconds: 100, nanoseconds: 1000 } } }, "alice"), false);
// Pinned chats: per person, and a pin still being saved stays pinned and on top.
const pinnedChat = { lastMessage: { createdAt: stamp(now) }, pinnedAt: { alice: stamp(now - 5_000) } };
assert.equal(isConversationPinned(pinnedChat, "alice"), true);
assert.equal(isConversationPinned(pinnedChat, "bob"), false, "A pin is only for the person who pinned");
assert.equal(isConversationPinned({ pinnedAt: { alice: null } }, "alice"), true, "A pin still being saved stays pinned");
assert.equal(isConversationPinned({}, "alice"), false);
assert.equal(conversationPinnedMillis(pinnedChat, "alice"), now - 5_000);
assert.equal(conversationPinnedMillis({ pinnedAt: { alice: null } }, "alice"), Number.MAX_SAFE_INTEGER, "A pin still being saved sorts newest");
assert.equal(isConversationPinned(JSON.parse(JSON.stringify(pinnedChat)), "alice"), true, "Pins survive offline-cache serialization");

// Big emoji and the hold-to-grow like.
assert.equal(isEmojiOnly("👍"), true);
assert.equal(isEmojiOnly("😂😂😂"), true);
assert.equal(isEmojiOnly("😂 😂"), true, "Spaces between emoji are fine");
assert.equal(isEmojiOnly("😂😂😂😂"), false, "Four or more read as text");
assert.equal(isEmojiOnly("ok 👍"), false);
assert.equal(isEmojiOnly("👋🏽"), true, "A skin tone is part of one emoji");
assert.equal(isEmojiOnly("❤️"), true);
assert.equal(isEmojiOnly("👨‍👩‍👧"), true, "A family is one emoji");
assert.equal(isEmojiOnly("🇵🇭"), true, "A flag is one emoji");
assert.equal(isEmojiOnly("1"), false);
assert.equal(isEmojiOnly(""), false);
assert.equal(bigEmojiFontSize("👍", "large"), 96);
assert.equal(bigEmojiFontSize("👍", undefined), 38);
assert.equal(bigEmojiFontSize("hello", undefined), null);
assert.equal(emojiSizeForHold(0), "small");
assert.equal(emojiSizeForHold(EMOJI_HOLD_MEDIUM_MS), "medium");
assert.equal(emojiSizeForHold(EMOJI_HOLD_LARGE_MS), "large");
assert.equal(emojiSizeForHold(EMOJI_HOLD_POP_MS), null, "Held too long, it pops and sends nothing");
// One reaction per person.
assert.deepEqual(planOwnReaction({}, "bob", "👍"), { add: "👍", remove: [] });
assert.deepEqual(planOwnReaction({ "👍": ["bob"] }, "bob", "👍"), { add: null, remove: ["👍"] }, "The same emoji takes it off");
assert.deepEqual(planOwnReaction({ "👍": ["bob", "amy"] }, "bob", "❤️"), { add: "❤️", remove: ["👍"] }, "Another emoji swaps it");
assert.deepEqual(planOwnReaction({ "👍": ["amy"] }, "bob", "👍"), { add: "👍", remove: [] }, "Someone else's reaction is left alone");
assert.deepEqual(planOwnReaction({ "👍": ["bob"], "😆": ["bob"] }, "bob", "❤️"), { add: "❤️", remove: ["👍", "😆"] }, "Old stacked reactions are cleared");
assert.deepEqual(planOwnReaction(undefined, "bob", "😮"), { add: "😮", remove: [] });
// A direct chat offers only its other participant while an @ fragment is active.
const mentionTarget = { id: "bob", name: "Bob Reyes" };
const activeMention = findActiveDirectMention("Hi @Bob R", { start: 9, end: 9 }, mentionTarget.name);
assert.deepEqual(activeMention, { start: 3, end: 9, query: "Bob R" });
assert.equal(findActiveDirectMention("Hi @Bob Reyes ", { start: 14, end: 14 }, mentionTarget.name), null, "A completed mention closes the picker");
assert.equal(findActiveDirectMention("Hi @Alice", { start: 9, end: 9 }, mentionTarget.name), null, "Another person's name is not suggested");
const insertedMention = insertDirectMention("Hi @Bob R today", { start: 9, end: 9 }, activeMention!, mentionTarget.name);
assert.deepEqual(insertedMention, { text: "Hi @Bob Reyes today", selection: { start: 14, end: 14 } });
assert.deepEqual(directMentionsForText("Hi @Bob Reyes!", mentionTarget), [mentionTarget]);
assert.deepEqual(directMentionsForText("Hi @Alice!", mentionTarget), []);
assert.deepEqual(splitDirectMentions("Hi @Bob Reyes!", [mentionTarget]), [
  { text: "Hi " }, { text: "@Bob Reyes", mention: mentionTarget }, { text: "!" },
]);
const taggedPeople = [
  { id: "bob", name: "Bob Reyes", studentID: "2026-001" },
  { id: "amy", name: "Amy Santos", studentID: "2026-002" },
];
assert.deepEqual(manualTaggedUsers("Hi @Bob Reyes!", taggedPeople, ["bob"]), [taggedPeople[1]], "Inline mentions do not repeat in the tag card");
assert.deepEqual(manualTaggedUsers("Hello", taggedPeople, ["bob"]), [taggedPeople[1]], "Mention IDs remain authoritative after text is stored");
assert.deepEqual(manualTaggedUsers("Hi @Bob Reyes.", taggedPeople), [taggedPeople[1]], "Legacy messages without mention IDs still hide duplicate inline mentions");
assert.deepEqual(manualTaggedUsers("Hello everyone", taggedPeople), taggedPeople, "Manual tags remain visible");
assert.deepEqual(splitTaggedMentions("Hi @Bob Reyes!", taggedPeople, ["bob"]), [
  { text: "Hi " },
  { text: "@Bob Reyes", taggedUser: taggedPeople[0] },
  { text: "!" },
]);
assert.deepEqual(splitTaggedMentions("Hi @Bob Reyes!", taggedPeople, ["amy"]), [
  { text: "Hi @Bob Reyes!" },
], "Stored mention IDs decide which post names are interactive");
assert.deepEqual(splitTaggedMentions("Manual @Bob Reyes!", taggedPeople), [
  { text: "Manual " },
  { text: "@Bob Reyes", taggedUser: taggedPeople[0] },
  { text: "!" },
], "Legacy posts still recognize inline names");
console.log("Messenger state: 75 regression assertions passed.");

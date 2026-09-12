/// <reference types="node" />
import assert from "node:assert/strict";
import { getDirectNotificationTarget, getPresenceState, isConversationArchived, isConversationVisible, isMessageAfterDeletion, PRESENCE_TIMEOUT_MS, receiptCoversMessage } from "../utils/messengerState";

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
console.log("Messenger state: 30 regression assertions passed.");

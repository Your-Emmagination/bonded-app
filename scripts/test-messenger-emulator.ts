/// <reference types="node" />
// Run against a local Firestore emulator only:
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 npx tsx scripts/test-messenger-emulator.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeApp, deleteApp } from "firebase/app";
import * as firestore from "firebase/firestore";
import ts from "typescript";
import * as state from "../utils/messengerState";

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error("A localhost Firestore emulator is required.");
const [hostname, port] = host.split(":");
const projectId = "demo-bonded-messenger";
const apps: ReturnType<typeof initializeApp>[] = [];
function client(uid: string, appName = uid) {
  const app = initializeApp({ projectId, apiKey: "emulator-only", appId: `test-${uid}` }, appName);
  apps.push(app);
  const db = firestore.getFirestore(app);
  firestore.connectFirestoreEmulator(db, hostname, Number(port), {
    mockUserToken: uid === "owner" ? "owner" : { sub: uid, email: `${uid}@example.test` },
  });
  return db;
}

const notifications: any[] = [];
function directUtils(db: firestore.Firestore) {
  const source = readFileSync("utils/directMessages.ts", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} as any };
  const requireDependency = (name: string) => {
    if (name === "firebase/firestore") return firestore;
    if (name === "../Firebase_configure") return { db };
    if (name === "./messengerState") return state;
    if (name === "./notifications") return { createNotification: async (input: any) => { notifications.push(input); } };
    throw new Error(`Unexpected dependency: ${name}`);
  };
  new Function("require", "module", "exports", compiled)(requireDependency, module, module.exports);
  return module.exports;
}

async function main() {
  firestore.setLogLevel("silent"); // Expected permission-denied assertions are checked below.
  const reset = await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(reset.ok, true);
  const admin = client("owner");
  const alice = client("alice");
  const bob = client("bob");
  const dave = client("dave");
  const outsider = client("outsider");
  await firestore.setDoc(firestore.doc(admin, "students", "alice"), { userId: "alice", role: "student" });
  await firestore.setDoc(firestore.doc(admin, "students", "bob"), { userId: "bob", role: "student" });
  const a = directUtils(alice);
  const b = directUtils(bob);
  const daveUtils = directUtils(dave);
  const aliceInfo = { uid: "alice", displayName: "Alice", role: "student", studentID: "A001" };
  const bobInfo = { uid: "bob", displayName: "Bob", role: "student", studentID: "B001" };
  const route = a.getDirectChatParams("alice", bobInfo);
  const conversationId = route.conversationId;
  assert.equal(b.getDirectChatParams("bob", aliceInfo).conversationId, conversationId);
  assert.equal(route.recipientId, "bob");
  assert.equal(route.recipientName, "Bob");
  assert.equal(route.recipientStudentID, "B001");
  const conv = (db: firestore.Firestore) => firestore.doc(db, "directConversations", conversationId);
  const message = (db: firestore.Firestore, id: string) => firestore.doc(conv(db), "messages", id);
  const send = async (id: string) => {
    try {
      return await a.sendDirectMessage({ conversationId, messageId: id, sender: aliceInfo, recipient: bobInfo, text: id, recipients: ["outsider"] });
    } catch (error) {
      console.error(`Sending ${id} failed`);
      throw error;
    }
  };
  const deny = async (operation: Promise<unknown>) => assert.rejects(operation, (error: any) => error.code === "permission-denied");

  const inbox = (utils: any, uid: string, expected: string[]) => new Promise<any[]>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Inbox did not become ${expected.join(",") || "empty"} for ${uid}`)); }, 15_000);
    const unsubscribe = utils.subscribeToUserConversations(uid, (items: any[]) => {
      if (JSON.stringify(items.map((item) => item.id).sort()) !== JSON.stringify([...expected].sort())) return;
      clearTimeout(timer); unsubscribe(); resolve(items);
    });
  });
  assert.equal((await firestore.getDoc(conv(alice))).exists(), false, "Opening a person must not create a conversation");
  assert.equal((await firestore.getDoc(conv(bob))).exists(), false);
  const typing = (db: firestore.Firestore, uid = "alice") => firestore.doc(db, "directTyping", conversationId, "users", uid);
  await firestore.setDoc(typing(alice), { userId: "alice", participants: ["alice", "bob"], active: true, updatedAt: firestore.serverTimestamp() });
  assert.equal((await firestore.getDoc(typing(bob))).data()?.active, true);
  assert.equal((await firestore.getDoc(conv(alice))).exists(), false, "Typing must not create an inbox entry");
  await deny(firestore.getDoc(typing(outsider)));
  await deny(firestore.updateDoc(typing(bob), { active: false, updatedAt: firestore.serverTimestamp() }));
  await deny(firestore.updateDoc(typing(alice), { participants: ["alice", "outsider"], updatedAt: firestore.serverTimestamp() }));
  await firestore.updateDoc(typing(alice), { active: false, updatedAt: firestore.serverTimestamp() });
  assert.equal((await firestore.getDoc(typing(bob))).data()?.active, false);
  await assert.rejects(a.sendDirectMessage({ conversationId, sender: aliceInfo, recipient: bobInfo, text: "   ", recipients: ["bob"] }), /empty/);
  assert.equal((await firestore.getDoc(conv(alice))).exists(), false, "An empty send must not create a conversation");
  const legacyEmpty = {
    type: "direct", participants: ["alice", "bob"], participantDetails: {},
    unreadCounts: { alice: 0, bob: 0 }, createdAt: firestore.serverTimestamp(), updatedAt: firestore.serverTimestamp(),
  };
  await firestore.setDoc(firestore.doc(admin, "directConversations", "legacy-empty"), legacyEmpty);
  await deny(firestore.setDoc(firestore.doc(alice, "directConversations", "invalid-empty"), legacyEmpty));
  await inbox(a, "alice", []);
  await inbox(b, "bob", []);

  // A link can be the first and only content in a new conversation. The full
  // normalized URL is saved; the optional title may be empty.
  const carolInfo = { uid: "carol", displayName: "Carol Cruz", role: "student", studentID: "C001" };
  const daveInfo = { uid: "dave", displayName: "Dave Diaz", role: "student", studentID: "D001" };
  const linkConversationId = daveUtils.getDirectChatParams("dave", carolInfo).conversationId;
  const linkConv = firestore.doc(dave, "directConversations", linkConversationId);
  const linkMessage = (id: string) => firestore.doc(linkConv, "messages", id);
  await daveUtils.sendDirectMessage({
    conversationId: linkConversationId,
    messageId: "first-link",
    sender: daveInfo,
    recipient: carolInfo,
    text: "",
    link: { url: "https://facebook.com", title: "" },
    recipients: ["carol"],
  });
  assert.equal((await firestore.getDoc(linkConv)).data()?.lastMessage.text, "Sent a link");
  assert.deepEqual((await firestore.getDoc(linkMessage("first-link"))).data()?.link, {
    url: "https://facebook.com", title: "",
  });
  await daveUtils.sendDirectMessage({
    conversationId: linkConversationId,
    messageId: "valid-mention",
    sender: daveInfo,
    text: "Hi @Carol Cruz",
    mentions: [{ id: "carol", name: "Carol Cruz" }],
    recipients: ["carol"],
  });
  await deny(daveUtils.sendDirectMessage({
    conversationId: linkConversationId,
    messageId: "invalid-mention",
    sender: daveInfo,
    text: "Hi @Outsider",
    mentions: [{ id: "outsider", name: "Outsider" }],
    recipients: ["carol"],
  }));
  await deny(daveUtils.sendDirectMessage({
    conversationId: linkConversationId,
    messageId: "invalid-link",
    sender: daveInfo,
    text: "",
    link: { url: "javascript:alert(1)", title: "Bad" },
    recipients: ["carol"],
  }));
  notifications.length = 0;

  await send("one");
  await send("one");
  await inbox(a, "alice", [conversationId]);
  await inbox(b, "bob", [conversationId]);
  assert.equal((await firestore.getDoc(conv(bob))).data()?.participantDetails.alice.displayName, "Alice");
  assert.equal((await firestore.getDoc(conv(bob))).data()?.unreadCounts.bob, 1, "Retry must be idempotent");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].recipientId, "bob", "Use actual participants, not client-supplied recipients");
  assert.equal(notifications[0].entityType, "direct_message");
  const one = { id: "one", ...(await firestore.getDoc(message(bob, "one"))).data() };
  await send("two");
  await b.markConversationAsSeen(conversationId, "bob", [one]);
  let snapshot = (await firestore.getDoc(conv(bob))).data()!;
  assert.equal(snapshot.unreadCounts.bob, 2, "A read of an older snapshot must not clear newer messages");
  assert.equal(state.receiptCoversMessage(snapshot.lastReadAt.bob, snapshot.lastMessage.createdAt), false);
  const two = { id: "two", ...(await firestore.getDoc(message(bob, "two"))).data() };
  const beforeEdit = (await firestore.getDoc(conv(alice))).data()!;
  const notificationBeforeEdit = notifications.length;
  await a.editDirectMessage(conversationId, "two", "alice", "Edited text https://example.test");
  const edited = (await firestore.getDoc(message(bob, "two"))).data()!;
  const afterEdit = (await firestore.getDoc(conv(bob))).data()!;
  assert.equal(edited.text, "Edited text https://example.test");
  assert.equal(edited.edited, true);
  assert.equal(edited.createdAt.isEqual((two as any).createdAt), true);
  assert.deepEqual(afterEdit.unreadCounts, beforeEdit.unreadCounts);
  assert.deepEqual(afterEdit.lastReadAt, beforeEdit.lastReadAt);
  assert.deepEqual(afterEdit.updatedAt, beforeEdit.updatedAt);
  assert.equal(afterEdit.lastMessage.text, edited.text);
  assert.equal(notifications.length, notificationBeforeEdit, "Edits must not send a new-message notification");
  await a.editDirectMessage(conversationId, "one", "alice", "An older edited message");
  assert.equal((await firestore.getDoc(conv(bob))).data()?.lastMessage.text, edited.text, "Editing older text must preserve the latest preview");
  await assert.rejects(b.editDirectMessage(conversationId, "one", "bob", "Imposter"));
  await deny(firestore.updateDoc(message(alice, "two"), { text: "Non-atomic edit", edited: true, editedAt: firestore.serverTimestamp() }));
  const invalidEdit = firestore.writeBatch(bob);
  invalidEdit.update(message(bob, "two"), { text: "Imposter", edited: true, editedAt: firestore.serverTimestamp() });
  invalidEdit.update(conv(bob), { "lastMessage.text": "Imposter", lastEditedMessageId: "two", contentUpdatedAt: firestore.serverTimestamp() });
  await deny(invalidEdit.commit());
  await b.markConversationAsSeen(conversationId, "bob", [one, two]);
  assert.equal((await firestore.getDoc(conv(bob))).data()?.unreadCounts.bob, 0);

  await b.toggleMuteConversation(conversationId, "bob", true);
  const notificationCount = notifications.length;
  await send("muted");
  assert.equal(notifications.length, notificationCount, "Mute must suppress notifications");
  assert.equal((await firestore.getDoc(conv(bob))).data()?.unreadCounts.bob, 1, "Muted chats still receive messages");
  await b.toggleMuteConversation(conversationId, "bob", false);
  await send("unmuted");
  assert.equal(notifications.length, notificationCount + 1);

  await deny(firestore.getDoc(conv(outsider)));
  await deny(firestore.updateDoc(conv(alice), { participants: ["alice", "bob", "outsider"] }));
  await deny(firestore.updateDoc(message(bob, "one"), { text: "Tampered" }));
  await deny(firestore.updateDoc(message(bob, "one"), { senderId: "bob" }));
  await deny(firestore.updateDoc(conv(alice), { "lastReadAt.bob": firestore.serverTimestamp() }));
  await deny(firestore.updateDoc(conv(alice), { "lastDeliveredAt.bob": firestore.serverTimestamp() }));
  await deny(firestore.updateDoc(conv(alice), { mutedBy: ["bob"] }));
  await deny(firestore.updateDoc(firestore.doc(alice, "students", "bob"), { isOnline: true }));
  await deny(firestore.updateDoc(conv(alice), { "participantDetails.bob.displayName": "Imposter" }));
  await deny(firestore.updateDoc(conv(alice), { "unreadCounts.bob": 999 }));
  await deny(firestore.updateDoc(message(bob, "one"), { "reactions.👍": ["alice"] }));
  await b.toggleDirectMessageReaction(conversationId, "one", "bob", "👍", {});
  await b.toggleDirectMessageReaction(conversationId, "one", "bob", "👍", { "👍": ["bob"] });
  await a.togglePinDirectMessage(conversationId, "one", true, "alice");
  await b.updateConversationTheme(conversationId, "#1d4ed8");
  await b.updateConversationNickname(conversationId, "alice", "Friend");
  await firestore.updateDoc(firestore.doc(alice, "students", "alice"), {
    isOnline: true, lastSeen: firestore.serverTimestamp(),
    "presenceSessions.device": { isOnline: true, lastSeen: firestore.serverTimestamp() },
  });

  const unmuted = { id: "unmuted", ...(await firestore.getDoc(message(alice, "unmuted"))).data() };
  await a.deleteDirectMessage(conversationId, unmuted);
  snapshot = (await firestore.getDoc(conv(bob))).data()!;
  assert.equal(snapshot.lastMessage.text, "Message deleted");
  assert.equal((await firestore.getDoc(message(bob, "unmuted"))).data()?.deleted, true);

  const unreadBeforeRace = snapshot.unreadCounts.bob;
  await Promise.all([send("race-one"), send("race-two")]);
  snapshot = (await firestore.getDoc(conv(bob))).data()!;
  assert.equal(snapshot.unreadCounts.bob, unreadBeforeRace + 2, "Concurrent sends must preserve both increments");
  assert.equal((await firestore.getDoc(message(bob, "race-one"))).exists(), true);
  assert.equal((await firestore.getDoc(message(bob, "race-two"))).exists(), true);

  const stopDelivery = b.subscribeToDirectMessageDelivery("bob");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stopWatching(); reject(new Error("Delivery receipt timed out")); }, 15_000);
      const stopWatching = firestore.onSnapshot(conv(alice), (snap) => {
        const conversation = snap.data();
        if (!state.receiptCoversMessage(conversation?.lastDeliveredAt?.bob, snapshot.lastMessage.createdAt)) return;
        clearTimeout(timer); stopWatching(); resolve();
      }, reject);
    });
  } finally { stopDelivery(); }

  const batch = firestore.writeBatch(admin);
  for (let i = 0; i < 205; i++) batch.set(message(admin, `history-${i}`), {
    senderId: "alice", text: `History ${i}`, createdAt: firestore.Timestamp.fromMillis(1_000 + i),
  });
  await batch.commit();
  const receive = (pageSize: number) => new Promise<any[]>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Listener timed out")); }, 15_000);
    const unsubscribe = b.subscribeToDirectMessages(conversationId, (messages: any[]) => {
      if (messages.length < pageSize) return;
      clearTimeout(timer); unsubscribe(); resolve(messages);
    }, pageSize, reject);
  });
  const recent = await receive(50);
  assert.equal(recent.length, 50);
  assert.equal(recent.some((item) => item.id === "unmuted"), true, "Newest messages remain visible beyond 200 messages");
  const older = await receive(100);
  assert.equal(older.length, 100);
  assert.equal(older.some((item) => item.id === recent[0].id), true);
  assert.equal((await b.searchDirectMessageHistory(conversationId, "History")).length, 205, "Search must cross page boundaries");
  const match = await b.searchDirectMessageHistory(conversationId, "History 0");
  assert.equal(match[0].id, "history-0");
  assert.equal(recent.some((item) => item.id === "history-0"), false);
  const context = await b.getDirectMessageContext(conversationId, "history-0");
  const contextMessages = await new Promise<any[]>((resolve, reject) => {
    const stop = b.subscribeToDirectMessages(conversationId, (items: any[]) => { stop(); resolve(items); }, 50, reject, undefined, context.through);
  });
  assert.equal(contextMessages.some((item) => item.id === "history-0"), true, "Reply jumps must load the original message and nearby context");
  assert.ok(contextMessages.length <= 50);
  const cancelledSearch = new AbortController(); cancelledSearch.abort();
  assert.deepEqual(await b.searchDirectMessageHistory(conversationId, "History", undefined, cancelledSearch.signal), []);
  assert.deepEqual(await b.searchDirectMessageHistory(conversationId, "Message deleted"), [], "Search excludes deleted messages");

  const readVisible = (utils: any, cutoff: any, expectedIds: string[]) => new Promise<any[]>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Visible-history listener timed out")); }, 15_000);
    const unsubscribe = utils.subscribeToDirectMessages(conversationId, (items: any[]) => {
      if (JSON.stringify(items.map((item) => item.id).sort()) !== JSON.stringify([...expectedIds].sort())) return;
      clearTimeout(timer); unsubscribe(); resolve(items);
    }, 300, reject, cutoff);
  });
  const secondAlice = directUtils(client("alice", "alice-other-device"));
  const beforeArchive = (await firestore.getDoc(conv(alice))).data()!;
  const messageCountBeforeArchive = (await firestore.getDocs(firestore.collection(conv(alice), "messages"))).size;
  await a.setDirectConversationArchived(conversationId, "alice", true);
  const archived = (await firestore.getDoc(conv(alice))).data()!;
  assert.deepEqual(archived.unreadCounts, beforeArchive.unreadCounts);
  assert.deepEqual(archived.lastReadAt, beforeArchive.lastReadAt);
  assert.deepEqual(archived.lastDeliveredAt, beforeArchive.lastDeliveredAt);
  assert.deepEqual(archived.mutedBy, beforeArchive.mutedBy);
  assert.deepEqual(archived.updatedAt, beforeArchive.updatedAt);
  assert.deepEqual(archived.lastMessage, beforeArchive.lastMessage);
  await inbox(a, "alice", []);
  await inbox(secondAlice, "alice", []);
  await inbox(b, "bob", [conversationId]);
  const allChats = await new Promise<any[]>((resolve) => {
    const stop = a.subscribeToUserConversations("alice", (items: any[]) => { stop(); resolve(items); }, { includeArchived: true });
  });
  assert.equal(allChats.length, 1, "Archive and search views retain the conversation");
  assert.equal(state.isConversationArchived(allChats[0], "alice"), true);
  assert.equal(a.getDirectChatParams("alice", bobInfo).conversationId, conversationId);
  assert.equal((await a.searchDirectMessageHistory(conversationId, "History")).length, 205, "Archiving preserves full searchable history");
  assert.equal((await firestore.getDocs(firestore.collection(conv(alice), "messages"))).size, messageCountBeforeArchive);
  await a.markConversationAsSeen(conversationId, "alice", recent);
  await b.setDirectConversationArchived(conversationId, "bob", true);
  const unreadInArchive = (await firestore.getDoc(conv(bob))).data()!.unreadCounts.bob;
  assert.ok(unreadInArchive > 0, "Archiving does not mark an unread conversation as read");
  const badge = await new Promise<number>((resolve) => {
    const stop = b.subscribeToTotalUnreadMessages("bob", (count: number) => { stop(); resolve(count); });
  });
  assert.equal(badge, 0, "Archived unread messages do not contribute to the main inbox badge");
  await a.editDirectMessage(conversationId, beforeArchive.lastMessage.id, "alice", "Edited while archived");
  await b.toggleDirectMessageReaction(conversationId, beforeArchive.lastMessage.id, "bob", "👍", {});
  await b.updateConversationTheme(conversationId, "#059669");
  await send(beforeArchive.lastMessage.id); // Idempotent retry is not a new message.
  await inbox(a, "alice", []);
  await inbox(b, "bob", []);
  await deny(firestore.updateDoc(conv(bob), { "archivedThrough.alice": null }));
  await deny(firestore.updateDoc(conv(alice), { "archivedThrough.alice": firestore.Timestamp.fromMillis(Date.now() + 60000) }));
  await assert.rejects(directUtils(outsider).setDirectConversationArchived(conversationId, "outsider", true));
  await assert.rejects(a.setDirectConversationArchived("legacy-empty", "alice", true), /no messages/);
  await a.setDirectConversationArchived(conversationId, "alice", false);
  await inbox(a, "alice", [conversationId]);
  await inbox(b, "bob", []);
  assert.deepEqual((await firestore.getDoc(conv(alice))).data()!.updatedAt, beforeArchive.updatedAt);
  await a.setDirectConversationArchived(conversationId, "alice", true);
  const notificationBeforeUnarchive = notifications.length;
  await b.sendDirectMessage({ conversationId, messageId: "archive-incoming", sender: bobInfo, recipient: aliceInfo, text: "New message restores the chat", recipients: ["alice"] });
  await inbox(a, "alice", [conversationId]);
  await inbox(secondAlice, "alice", [conversationId]);
  await inbox(b, "bob", [conversationId]);
  assert.equal(notifications.length, notificationBeforeUnarchive + 1, "Archiving must not mute new-message notifications");
  await a.setDirectConversationArchived(conversationId, "alice", true);
  await send("archive-outgoing");
  await inbox(a, "alice", [conversationId]);
  await Promise.all([a.setDirectConversationArchived(conversationId, "alice", true), send("archive-race")]);
  const archiveRace = (await firestore.getDoc(conv(alice))).data()!;
  assert.equal(archiveRace.lastMessage.id, "archive-race");
  const archivedAfterRace = archiveRace.archivedThrough.alice.isEqual(archiveRace.lastMessage.createdAt);
  await inbox(a, "alice", archivedAfterRace ? [] : [conversationId]);
  await a.setDirectConversationArchived(conversationId, "alice", false);
  await inbox(secondAlice, "alice", [conversationId]);

  // Pinning a chat: your own entry only, only the server's time, nothing else.
  await a.setDirectConversationPinned(conversationId, "alice", true);
  const pinnedConversation = (await firestore.getDoc(conv(alice))).data()!;
  assert.equal(state.isConversationPinned(pinnedConversation, "alice"), true);
  assert.equal(state.isConversationPinned(pinnedConversation, "bob"), false, "A pin is only for the person who pinned");
  await deny(firestore.updateDoc(conv(bob), { "pinnedAt.alice": firestore.deleteField() }));
  await deny(firestore.updateDoc(conv(alice), { "pinnedAt.alice": firestore.Timestamp.fromMillis(Date.now() + 60000) }));
  await deny(firestore.updateDoc(conv(alice), { "pinnedAt.alice": firestore.serverTimestamp(), themeColor: "#123456" }));
  await assert.rejects(directUtils(outsider).setDirectConversationPinned(conversationId, "outsider", true));
  await a.setDirectConversationPinned(conversationId, "alice", false);
  assert.equal(state.isConversationPinned((await firestore.getDoc(conv(alice))).data()!, "alice"), false);

  // A like held to a size keeps it.
  await a.sendDirectMessage({ conversationId, messageId: "sized-like", sender: aliceInfo, recipient: bobInfo, text: "👍", emojiSize: "large", recipients: ["bob"] });
  assert.equal((await firestore.getDoc(message(alice, "sized-like"))).data()!.emojiSize, "large");

  const beforeDelete = (await firestore.getDoc(conv(alice))).data()!;
  await a.setDirectConversationArchived(conversationId, "alice", true);
  await a.deleteDirectConversationForMe(conversationId, "alice");
  let deleted = (await firestore.getDoc(conv(alice))).data()!;
  assert.equal(deleted.deletedThrough.alice.isEqual(beforeDelete.lastMessage.createdAt), true);
  assert.equal(deleted.unreadCounts.alice, 0);
  assert.equal(deleted.unreadCounts.bob, beforeDelete.unreadCounts.bob, "Deleting must not change the other user's unread count");
  assert.deepEqual(deleted.lastReadAt, beforeDelete.lastReadAt, "Deleting must not send a false read receipt");
  await inbox(a, "alice", []);
  await inbox(b, "bob", [conversationId]);
  await readVisible(a, deleted.deletedThrough.alice, []);
  await assert.rejects(a.setDirectConversationArchived(conversationId, "alice", false), /no messages/);
  assert.equal(state.isConversationArchived(deleted, "alice"), false, "Delete removes a chat from both folders");
  assert.deepEqual(await a.searchDirectMessageHistory(conversationId, "History", deleted.deletedThrough.alice), []);
  await assert.rejects(a.getDirectMessageContext(conversationId, "history-0", deleted.deletedThrough.alice), /no longer/);
  await assert.rejects(a.editDirectMessage(conversationId, "one", "alice", "Restore deleted history"), /no longer/);
  assert.equal((await firestore.getDoc(message(bob, "one"))).exists(), true, "The other person keeps the history");
  assert.equal(a.getDirectChatParams("alice", bobInfo).conversationId, conversationId);
  await b.updateConversationTheme(conversationId, "#059669");
  await send("one"); // Retrying an old committed message must not restore a deleted chat.
  await inbox(a, "alice", []);
  await inbox(secondAlice, "alice", []);
  await deny(firestore.updateDoc(conv(bob), { "deletedThrough.alice": firestore.serverTimestamp() }));
  await deny(firestore.updateDoc(conv(alice), { deletedThrough: {} }));
  await deny(firestore.updateDoc(conv(alice), { "deletedThrough.alice": firestore.serverTimestamp() }));
  await deny(firestore.deleteDoc(conv(alice)));

  aliceInfo.displayName = "Alice Updated";
  await send("after-delete");
  assert.equal((await firestore.getDoc(conv(bob))).data()?.participantDetails.alice.displayName, "Alice Updated");
  assert.equal((await firestore.getDoc(conv(bob))).data()?.participantDetails.bob.displayName, "Bob");
  await inbox(a, "alice", [conversationId]);
  await readVisible(a, deleted.deletedThrough.alice, ["after-delete"]);
  await Promise.all([a.deleteDirectConversationForMe(conversationId, "alice"), b.deleteDirectConversationForMe(conversationId, "bob")]);
  deleted = (await firestore.getDoc(conv(bob))).data()!;
  assert.equal(deleted.deletedThrough.alice.isEqual(deleted.lastMessage.createdAt), true);
  assert.equal(deleted.deletedThrough.bob.isEqual(deleted.lastMessage.createdAt), true);
  await inbox(a, "alice", []);
  await inbox(b, "bob", []);
  await b.sendDirectMessage({ conversationId, messageId: "new-incoming", sender: bobInfo, recipient: aliceInfo, text: "Hello again", recipients: ["alice"] });
  await inbox(a, "alice", [conversationId]);
  await inbox(b, "bob", [conversationId]);
  await readVisible(a, deleted.deletedThrough.alice, ["new-incoming"]);
  await inbox(secondAlice, "alice", [conversationId]);
  await readVisible(b, deleted.deletedThrough.bob, ["new-incoming"]);
  assert.equal((await firestore.getDoc(conv(alice))).data()?.unreadCounts.alice, 1);

  const failedId = a.getDirectChatParams("alice", { uid: "failed" }).conversationId;
  await deny(a.sendDirectMessage({
    conversationId: failedId, sender: aliceInfo, recipient: { uid: "failed" }, text: "", recipients: ["failed"],
    files: Array.from({ length: 11 }, () => ({ url: "https://example.test/photo.jpg", mimeType: "image/jpeg", name: "Photo" })),
  }));
  assert.equal((await firestore.getDoc(firestore.doc(alice, "directConversations", failedId))).exists(), false, "A rejected first send must not leave an inbox entry");
  await inbox(a, "alice", [conversationId]);

  const dana = client("dana");
  const d = directUtils(dana);
  const danaInfo = { uid: "dana", displayName: "Dana" };
  const simultaneousId = a.getDirectChatParams("alice", danaInfo).conversationId;
  await Promise.all([
    a.sendDirectMessage({ conversationId: simultaneousId, messageId: "first-alice", sender: aliceInfo, recipient: danaInfo, text: "Hi", recipients: ["dana"] }),
    d.sendDirectMessage({ conversationId: simultaneousId, messageId: "first-dana", sender: danaInfo, recipient: aliceInfo, text: "Hello", recipients: ["alice"] }),
  ]);
  const simultaneous = (await firestore.getDoc(firestore.doc(alice, "directConversations", simultaneousId))).data()!;
  assert.equal(simultaneous.unreadCounts.alice, 1);
  assert.equal(simultaneous.unreadCounts.dana, 1);
  assert.equal((await firestore.getDocs(firestore.collection(alice, "directConversations", simultaneousId, "messages"))).size, 2);

  for (const [uid, text, files] of [
    ["photo", "", [{ url: "https://example.test/photo.jpg", name: "Photo", mimeType: "image/jpeg" }]],
    ["file", "", [{ url: "https://example.test/file.pdf", name: "File", mimeType: "application/pdf" }]],
    ["gif", "", [{ url: "https://media.giphy.com/media/test/giphy.gif", name: "Hello GIF", mimeType: "image/gif" }]],
    ["emoji", "👍", []],
  ] as const) {
    const id = a.getDirectChatParams("alice", { uid }).conversationId;
    await a.sendDirectMessage({ conversationId: id, sender: aliceInfo, recipient: { uid }, text, files: [...files], recipients: [uid] });
    assert.equal(state.isConversationVisible((await firestore.getDoc(firestore.doc(alice, "directConversations", id))).data()!, "alice"), true);
  }
  console.log("Messenger emulator passed: archive/unarchive, cross-device folders, new-message restoration, archive races, preserved history/receipts/notifications, deleted-history protection, private typing, edits, search, replies, GIF/photo/file/emoji sends, first-send races, rollback, permissions, retries, unread counts and pagination.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.all(apps.map((app) => deleteApp(app)));
});

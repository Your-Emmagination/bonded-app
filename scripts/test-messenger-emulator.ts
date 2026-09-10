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
  const outsider = client("outsider");
  await firestore.setDoc(firestore.doc(admin, "students", "alice"), { userId: "alice", role: "student" });
  await firestore.setDoc(firestore.doc(admin, "students", "bob"), { userId: "bob", role: "student" });
  const a = directUtils(alice);
  const b = directUtils(bob);
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

  const readVisible = (utils: any, cutoff: any, expectedIds: string[]) => new Promise<any[]>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Visible-history listener timed out")); }, 15_000);
    const unsubscribe = utils.subscribeToDirectMessages(conversationId, (items: any[]) => {
      if (JSON.stringify(items.map((item) => item.id).sort()) !== JSON.stringify([...expectedIds].sort())) return;
      clearTimeout(timer); unsubscribe(); resolve(items);
    }, 300, reject, cutoff);
  });
  const secondAlice = directUtils(client("alice", "alice-other-device"));
  await inbox(secondAlice, "alice", [conversationId]);
  const beforeDelete = (await firestore.getDoc(conv(alice))).data()!;
  await a.deleteDirectConversationForMe(conversationId, "alice");
  let deleted = (await firestore.getDoc(conv(alice))).data()!;
  assert.equal(deleted.deletedThrough.alice.isEqual(beforeDelete.lastMessage.createdAt), true);
  assert.equal(deleted.unreadCounts.alice, 0);
  assert.equal(deleted.unreadCounts.bob, beforeDelete.unreadCounts.bob, "Deleting must not change the other user's unread count");
  assert.deepEqual(deleted.lastReadAt, beforeDelete.lastReadAt, "Deleting must not send a false read receipt");
  await inbox(a, "alice", []);
  await inbox(b, "bob", [conversationId]);
  await readVisible(a, deleted.deletedThrough.alice, []);
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
    ["emoji", "👍", []],
  ] as const) {
    const id = a.getDirectChatParams("alice", { uid }).conversationId;
    await a.sendDirectMessage({ conversationId: id, sender: aliceInfo, recipient: { uid }, text, files: [...files], recipients: [uid] });
    assert.equal(state.isConversationVisible((await firestore.getDoc(firestore.doc(alice, "directConversations", id))).data()!, "alice"), true);
  }
  console.log("Messenger emulator passed: opening without writes, legacy empty chats, atomic first sends, photo/file/emoji sends, simultaneous first sends, failed-send rollback, delete for me, reopening, new incoming messages, permissions, retries, receipts, unread counts, mute, and history pagination.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.all(apps.map((app) => deleteApp(app)));
});

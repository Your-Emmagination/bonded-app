/// <reference types="node" />
import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase/app";
import { connectFirestoreEmulator, doc, getDoc, getFirestore, serverTimestamp, setDoc, setLogLevel, updateDoc } from "firebase/firestore";

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error("A local Firestore emulator is required.");
const [hostname, port] = host.split(":");
const apps: ReturnType<typeof initializeApp>[] = [];
function client(uid: string) {
  const app = initializeApp({ projectId: "demo-bonded-messenger", apiKey: "emulator-only", appId: `setup-${uid}` }, `setup-${uid}`);
  apps.push(app);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, hostname, Number(port), { mockUserToken: uid === "owner" ? "owner" : { sub: uid, email: `${uid}@student.csap` } });
  return db;
}
async function main() {
  setLogLevel("silent");
  const admin = client("owner");
  const member = client("setup-member");
  const other = client("setup-other");
  const ref = (db: ReturnType<typeof getFirestore>) => doc(db, "students", "setup-member");
  await setDoc(ref(admin), { userId: "setup-member", studentID: "setup-member", role: "student", lastname: "Example", mustChangePassword: true });
  const deny = (operation: Promise<unknown>) => assert.rejects(operation, (error: { code: string }) => error.code === "permission-denied");
  await updateDoc(ref(member), { email: "member@example.com", profileImage: "https://example.com/avatar.jpg", communityRulesVersion: "2026-09-12", communityRulesAcceptedAt: serverTimestamp() });
  assert.equal((await getDoc(ref(member))).data()?.email, "member@example.com");
  await deny(updateDoc(ref(other), { email: "attacker@example.com" }));
  await deny(updateDoc(ref(member), { mustChangePassword: false }));
  await deny(updateDoc(ref(member), { passwordCheckedAt: new Date().toISOString() }));
  await deny(updateDoc(ref(member), { role: "admin" }));
  await deny(updateDoc(ref(member), { lastname: "Different" }));
  await deny(updateDoc(ref(member), { userId: "someone-else" }));
  await deny(updateDoc(ref(member), { uid: "someone-else" }));
  await deny(updateDoc(ref(member), { recoveryEmail: "attacker@example.com", recoveryEmailVerified: true }));
  await deny(updateDoc(ref(member), { communityRulesVersion: "unrecognized", communityRulesAcceptedAt: serverTimestamp() }));
  await deny(updateDoc(ref(member), { communityRulesAcceptedAt: new Date(0) }));
  await updateDoc(ref(admin), { mustChangePassword: false });
  await updateDoc(ref(member), { isOnline: true, lastSeen: serverTimestamp(), bio: "Hello" });
  assert.equal((await getDoc(ref(member))).data()?.mustChangePassword, false);
  const legacyRef = doc(admin, "students", "MixedCaseSchoolID");
  await setDoc(legacyRef, { userId: "setup-member", studentID: "MixedCaseSchoolID", role: "student" });
  await updateDoc(doc(member, "students", "MixedCaseSchoolID"), { email: "member@example.com" });
  await deny(updateDoc(doc(other, "students", "MixedCaseSchoolID"), { email: "attacker@example.com" }));
  console.log("Profile ownership, rules acceptance, and protected password-state emulator checks passed.");
}
void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await Promise.all(apps.map(deleteApp)); });

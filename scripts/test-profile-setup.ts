/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMMUNITY_RULES_VERSION, getSetupStep, profileEmail, validPersonalEmail } from "../utils/profileSetup";

async function main() {
  const complete = { mustChangePassword: false, email: "member@example.com", profileImage: "https://example.com/avatar.jpg", communityRulesVersion: COMMUNITY_RULES_VERSION, communityRulesAcceptedAt: new Date() };
  assert.equal(getSetupStep(complete), "complete");
  assert.equal(getSetupStep({ ...complete, mustChangePassword: true }), "password");
  assert.equal(getSetupStep({ ...complete, mustChangePassword: undefined }), "password-check");
  assert.equal(getSetupStep({ ...complete, profileImage: "file:///pending.jpg" }), "profile");
  assert.equal(getSetupStep({ ...complete, profileImage: "" }), "profile");
  assert.equal(getSetupStep({ ...complete, email: "001@student.csap" }), "profile");
  assert.equal(getSetupStep({ ...complete, communityRulesAcceptedAt: null }), "profile");
  assert.equal(getSetupStep({ ...complete, communityRulesVersion: "old" }), "profile");
  assert.equal(profileEmail({ email: "001@student.csap", recoveryEmail: "member@example.com" }), "member@example.com");
  for (const invalid of ["", "member@", "x @example.com", "member@example", "001@admin.csap", "x".repeat(255) + "@example.com"]) assert.equal(validPersonalEmail(invalid), false);
  assert.equal(validPersonalEmail("  member+tag@example.com  "), true);

  // Import the isolated Worker handler without initializing production services.
  const source = readFileSync("cloudflare/ai-worker/src/accountSetup.js", "utf8");
  const { checkAccountPassword } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const writes: Record<string, unknown>[] = [];
  let signIns = 0;
  const deps = {
    lookupUser: async () => ({ localId: "member", email: "001@student.csap" }),
    readProfile: async () => ({ userId: "member", lastname: "Example" }),
    patchProfile: async (_env: unknown, id: string, fields: Record<string, unknown>) => { writes.push({ id, ...fields }); },
    fetchImpl: async (_url: unknown, options: { body: string }) => {
      signIns++;
      assert.equal(JSON.parse(options.body).email, "001@student.csap", "Use the Auth email, never a personal email supplied by the caller");
      return { ok: true, json: async () => ({ localId: "member" }) };
    },
  };
  const request = new Request("https://worker.example.test", { headers: { Authorization: "Bearer test-token" } });
  const run = (password: string, overrides = {}) => checkAccountPassword({ FIREBASE_WEB_API_KEY: "test-only" }, request, { studentID: "001", password }, { ...deps, ...overrides });
  const temporary = await run("Example12345");
  assert.equal(temporary.body.mustChangePassword, true);
  const personal = await run("MyChosenPassword!9");
  assert.equal(personal.body.mustChangePassword, false);
  assert.equal(writes.length, 2);
  assert.equal(Object.keys(writes[0]).includes("password"), false, "Never persist passwords");
  const attempts = signIns;
  const otherProfile = await run("MyChosenPassword!9", { readProfile: async () => ({ userId: "someone-else" }) });
  assert.equal(otherProfile.status, 403);
  assert.equal(signIns, attempts, "Reject another user's profile before credential validation");
  const wrongPassword = await run("incorrect", { fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({}) }) });
  assert.equal(wrongPassword.status, 400);
  const swappedAccount = await run("anything", { fetchImpl: async () => ({ ok: true, json: async () => ({ localId: "someone-else" }) }) });
  assert.equal(swappedAccount.status, 400);
  assert.equal(writes.length, 2, "Invalid credentials must not change password state");
  const anonymous = await checkAccountPassword({}, new Request("https://worker.example.test"), {}, deps);
  assert.equal(anonymous.status, 401);
  await assert.rejects(run("MyChosenPassword!9", { patchProfile: async () => { throw new Error("Save failed"); } }));
  console.log("Profile setup and password boundary checks passed.");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

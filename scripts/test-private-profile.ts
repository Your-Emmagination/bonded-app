/// <reference types="node" />
// Moving personal emails off the public profile (cloudflare/ai-worker/src/privateProfile.js).
import assert from "node:assert/strict";
import { isPersonalEmail, planPrivateProfileMove } from "../cloudflare/ai-worker/src/privateProfile.js";

const str = (stringValue: string) => ({ stringValue });
const bool = (booleanValue: boolean) => ({ booleanValue });

assert.equal(isPersonalEmail("juan@gmail.com"), true);
assert.equal(isPersonalEmail("2023-001@student.csap"), false, "The school sign-in address is not personal");
assert.equal(isPersonalEmail("teach-01@teacher.csap"), false);
assert.equal(isPersonalEmail("admin-01@admin.csap"), false);
assert.equal(isPersonalEmail("not an email"), false);
assert.equal(isPersonalEmail(undefined), false);

// Nothing private on the public profile: nothing to do.
assert.equal(planPrivateProfileMove({ firstname: str("Juan") }, {}), null);
assert.equal(planPrivateProfileMove({ email: str("2023-001@student.csap") }, {}), null, "The sign-in address may stay public");

// A verified recovery email moves, with the personal email.
assert.deepEqual(
  planPrivateProfileMove(
    { email: str("juan@gmail.com"), recoveryEmail: str("juan@gmail.com"), recoveryEmailVerified: bool(true) },
    {},
  ),
  {
    privateFields: { email: str("juan@gmail.com"), recoveryEmail: str("juan@gmail.com"), recoveryEmailVerified: bool(true) },
    publicRemove: ["email", "recoveryEmail", "recoveryEmailVerified"],
  },
);

// The sign-in address stays; the recovery fields still move.
assert.deepEqual(
  planPrivateProfileMove({ email: str("2023-001@student.csap"), recoveryEmail: str("juan@gmail.com") }, {}),
  { privateFields: { recoveryEmail: str("juan@gmail.com") }, publicRemove: ["recoveryEmail"] },
);

// A newer private value is never overwritten, but the public copy still goes.
assert.deepEqual(
  planPrivateProfileMove(
    { recoveryEmail: str("old@gmail.com"), recoveryEmailVerified: bool(true) },
    { recoveryEmail: str("new@gmail.com"), recoveryEmailVerified: bool(true) },
  ),
  { privateFields: {}, publicRemove: ["recoveryEmail", "recoveryEmailVerified"] },
);

// A cleared email ("" after an admin removed it) is still taken off the public profile.
assert.deepEqual(
  planPrivateProfileMove({ recoveryEmail: str(""), recoveryEmailVerified: bool(false) }, {}),
  {
    privateFields: { recoveryEmail: str(""), recoveryEmailVerified: bool(false) },
    publicRemove: ["recoveryEmail", "recoveryEmailVerified"],
  },
);

console.log("Private profile: 12 checks passed.");

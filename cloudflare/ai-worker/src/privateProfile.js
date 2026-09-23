// cloudflare/ai-worker/src/privateProfile.js
//
// A person's personal email and recovery details live in
// studentPrivate/{studentID}, which only the account's owner and admins can
// read. The public profile, students/{studentID}, is read by everyone signed
// in (names, photos, who's online), so it must not carry them. Only this
// Worker writes the private record.

/** The fields that belong in the private record, never the public profile. */
export const PRIVATE_PROFILE_FIELDS = [
  "email",
  "recoveryEmail",
  "recoveryEmailVerified",
  "recoveryEmailVerifiedAt",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCHOOL_SIGN_IN_RE = /@(?:student|teacher|admin|moderator)\.csap$/i;

/** A real inbox, as opposed to the school sign-in address ("001@student.csap"). */
export function isPersonalEmail(value) {
  if (typeof value !== "string") return false;
  const email = value.trim();
  return EMAIL_RE.test(email) && !SCHOOL_SIGN_IN_RE.test(email);
}

/**
 * What moving one profile involves, from the raw Firestore REST field maps
 * of its public and private documents:
 *   privateFields — fields to add to the private record. Only ones it
 *     doesn't have yet, so an old public value never overwrites a newer
 *     private one.
 *   publicRemove — field paths to delete from the public profile. The
 *     school sign-in address may stay; a personal email may not.
 * Null when the public profile has nothing private left.
 */
export function planPrivateProfileMove(publicFields = {}, privateFields = {}) {
  const publicRemove = [];
  const moved = {};
  for (const key of PRIVATE_PROFILE_FIELDS) {
    const value = publicFields[key];
    if (value === undefined) continue;
    if (key === "email" && !isPersonalEmail(value?.stringValue)) continue;
    publicRemove.push(key);
    if (privateFields[key] === undefined) moved[key] = value;
  }
  return publicRemove.length ? { privateFields: moved, publicRemove } : null;
}

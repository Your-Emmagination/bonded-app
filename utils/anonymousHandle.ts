// utils/anonymousHandle.ts
//
// Everyone gets one permanent anonymous name — "Anonymous4821" — the way
// Facebook groups number their anonymous participants. Anonymous posts,
// comments, replies and server messages carry it, so a thread can tell two
// anonymous people apart ("that's the same person") without anyone learning
// who either of them is.
//
// The number is unique: it is reserved in anonymousNumbers/{number}, which
// nobody can read, in the same write that saves it to userSecrets/{uid},
// which only its owner can read. So a number can't be looked up to find the
// person behind it, and two people can't hold the same one. The rules check
// that anonymous content carries the writer's own name, so nobody can post
// under somebody else's.
import { doc, getDoc, serverTimestamp, writeBatch } from "firebase/firestore";

import { auth, db } from "../Firebase_configure";

/** The shape the rules accept, so a hand-made name can't slip through. */
export const ANONYMOUS_HANDLE_PATTERN = /^Anonymous[1-9][0-9]{3,4}$/;

/** Previous numeric names included a space. Existing accounts keep their
 * number and remove only that space, so their identity stays stable. */
const SPACED_HANDLE_PATTERN = /^Anonymous ([1-9][0-9]{3,4})$/;

/** The word names ("Brave-Tarsier-4821") from before numbers. An account
 *  that has one switches to a number, once, the next time it is needed. */
const LEGACY_HANDLE_PATTERN = /^[A-Za-z]+-[A-Za-z]+-[0-9]{4}$/;

/** A number from 10000 to 99999. */
export function generateAnonymousNumber(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}

/** A few tries is plenty: a clash needs thousands of numbers already taken. */
const CLAIM_ATTEMPTS = 5;

let cached: { uid: string; handle: string } | null = null;

/**
 * This account's anonymous name, created the first time it is needed.
 * Resolves null only when nobody is signed in or the database can't be
 * reached — anonymous content then falls back to plain "Anonymous".
 */
export async function getMyAnonymousHandle(): Promise<string | null> {
  const uid = auth.currentUser?.uid;
  if (!uid) return null;
  if (cached?.uid === uid) return cached.handle;

  const secretRef = doc(db, "userSecrets", uid);
  try {
    const snapshot = await getDoc(secretRef);
    const existing = snapshot.exists() ? snapshot.data()?.anonymousHandle : null;
    if (typeof existing === "string" && ANONYMOUS_HANDLE_PATTERN.test(existing)) {
      cached = { uid, handle: existing };
      return existing;
    }

    const spacedMatch =
      typeof existing === "string" ? existing.match(SPACED_HANDLE_PATTERN) : null;
    if (spacedMatch) {
      const handle = `Anonymous${spacedMatch[1]}`;
      try {
        const batch = writeBatch(db);
        batch.update(secretRef, { anonymousHandle: handle, migratedAt: serverTimestamp() });
        await batch.commit();
        cached = { uid, handle };
        return handle;
      } catch {
        // Keep the stored value for writes until the updated rules deploy.
        // anonymousName() still displays it without the old space.
        return existing;
      }
    }

    const legacy =
      typeof existing === "string" && LEGACY_HANDLE_PATTERN.test(existing) ? existing : null;

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const number = generateAnonymousNumber();
      const handle = `Anonymous${number}`;
      // The number and the name are saved together or not at all.
      const batch = writeBatch(db);
      batch.set(doc(db, "anonymousNumbers", number), { uid, createdAt: serverTimestamp() });
      if (legacy) {
        batch.update(secretRef, { anonymousHandle: handle, migratedAt: serverTimestamp() });
      } else {
        batch.set(secretRef, { anonymousHandle: handle, createdAt: serverTimestamp() });
      }

      try {
        await batch.commit();
        cached = { uid, handle };
        return handle;
      } catch {
        // Either the number is taken, or another device of ours saved a
        // name first. If it did, that name is permanent: use it.
        const again = await getDoc(secretRef);
        const theirs = again.exists() ? again.data()?.anonymousHandle : null;
        if (typeof theirs === "string" && ANONYMOUS_HANDLE_PATTERN.test(theirs)) {
          cached = { uid, handle: theirs };
          return theirs;
        }
        // Otherwise the number was taken; try another.
      }
    }

    // Couldn't get a number (the new rules may not be deployed yet). An old
    // word name still passes the rules, so keep using it until the switch
    // goes through.
    return legacy;
  } catch (error) {
    console.warn("[anonymousHandle] Could not load the anonymous name:", error);
    return null;
  }
}

/** Keeps old saved numeric handles visually consistent with the new format. */
export function formatAnonymousHandle(value?: string | null): string {
  const handle = value?.trim() || "Anonymous";
  return handle.replace(/^Anonymous\s+([1-9][0-9]{3,4})$/, "Anonymous$1");
}

/**
 * How an anonymous author is shown: their name, or "Anonymous" for anything
 * posted before names existed. Staff seeing their own anonymous content get
 * "(You)" after it, as before.
 */
export function anonymousName(
  item: object | null | undefined,
  options?: { isYou?: boolean },
): string {
  // Any post, poll, comment, reply or message: older ones have no name yet.
  const value = (item as { anonymousHandle?: unknown } | null | undefined)?.anonymousHandle;
  const handle = formatAnonymousHandle(
    typeof value === "string" && value.trim() ? value : null,
  );
  return options?.isYou ? `${handle} (You)` : handle;
}

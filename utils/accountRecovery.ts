// utils/accountRecovery.ts
//
// An admin rescuing someone's account: when the person has lost both their
// password and their recovery email, or someone else has taken the email.
// Everything runs in the Cloudflare Worker (mode "admin-account-recovery"),
// the only place that can change a sign-in account; the Worker checks the
// caller is an admin and logs every action in accountRecoveryLog.
import { collection, getDocs, query, where } from "firebase/firestore";

import { auth, db } from "../Firebase_configure";
import { getAiWorkerUrl } from "./aiConfig";
import { timestampMillis } from "./messengerState";

export type AccountRecoveryAction =
  | "reset-password"
  | "remove-recovery-email"
  | "sign-out-all"
  | "lock"
  | "unlock";

/** How each action reads in the history. */
export const ACCOUNT_RECOVERY_LABELS: Record<AccountRecoveryAction, string> = {
  "reset-password": "Password reset to a temporary one",
  "remove-recovery-email": "Recovery email removed",
  "sign-out-all": "Signed out of all devices",
  lock: "Account locked",
  unlock: "Account unlocked",
};

export type AccountRecoveryResult = {
  /** Only for reset-password: shown to the admin once, never stored. */
  temporaryPassword?: string;
};

export async function runAccountRecovery(
  studentID: string,
  action: AccountRecoveryAction,
): Promise<AccountRecoveryResult> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("You need to be signed in to do that.");

  let response: Response;
  try {
    response = await fetch(getAiWorkerUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode: "admin-account-recovery", studentID, action }),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }

  const data = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    temporaryPassword?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : "Couldn't update the account. Please try again.",
    );
  }
  return typeof data.temporaryPassword === "string"
    ? { temporaryPassword: data.temporaryPassword }
    : {};
}

/**
 * Moves personal emails off public profiles into private records, which
 * only the owner and admins can read. The Worker does a few pages per call,
 * so this keeps calling until it has been through every profile. Resolves
 * with how many profiles were moved. Safe to run again: profiles already
 * moved are skipped.
 */
export async function movePersonalEmailsToPrivate(): Promise<number> {
  let after: string | null = null;
  let moved = 0;
  for (let round = 0; round < 50; round += 1) {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error("You need to be signed in to do that.");

    let response: Response;
    try {
      response = await fetch(getAiWorkerUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "migrate-private-profile", ...(after ? { after } : {}) }),
      });
    } catch {
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    }

    const data = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      moved?: unknown;
      done?: unknown;
      next?: unknown;
    };
    if (!response.ok) {
      throw new Error(
        typeof data.error === "string" ? data.error : "Couldn't move the emails. Please try again.",
      );
    }
    moved += Number(data.moved) || 0;
    if (data.done !== false || typeof data.next !== "string") return moved;
    after = data.next;
  }
  return moved;
}

export type AccountRecoveryLogEntry = {
  id: string;
  action: AccountRecoveryAction;
  byName: string;
  atMs: number;
};

/**
 * The latest recovery actions on one account, newest first. Readable by
 * admins only (see accountRecoveryLog in firestore.rules). Filtered on one
 * field and sorted here, so it needs no composite index.
 */
export async function fetchAccountRecoveryLog(
  studentID: string,
  max = 5,
): Promise<AccountRecoveryLogEntry[]> {
  const snapshot = await getDocs(
    query(collection(db, "accountRecoveryLog"), where("studentID", "==", studentID)),
  );
  return snapshot.docs
    .map((item) => {
      const data = item.data();
      return {
        id: item.id,
        action: data.action as AccountRecoveryAction,
        byName: typeof data.byName === "string" && data.byName ? data.byName : "An admin",
        atMs: timestampMillis(data.at),
      };
    })
    .filter((entry) => entry.action in ACCOUNT_RECOVERY_LABELS)
    .sort((first, second) => second.atMs - first.atMs)
    .slice(0, max);
}

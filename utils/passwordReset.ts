// Client wrappers for the email-code password-reset + recovery-email flow.
// All logic lives in the Cloudflare Worker (see cloudflare/ai-worker/src/
// index.js, modes password-reset-* and recovery-email-*). The Worker is the
// only thing that can read/verify a code or change a password.

import { auth } from "../Firebase_configure";
import { getAiWorkerUrl } from "./aiConfig";

type WorkerResult = Record<string, unknown>;

const callWorker = async (
  mode: string,
  payload: Record<string, unknown>,
  { authed = false }: { authed?: boolean } = {},
): Promise<WorkerResult> => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (authed) {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error("You need to be signed in to do that.");
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(getAiWorkerUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({ mode, ...payload }),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }

  const data = (await response.json().catch(() => ({}))) as WorkerResult;
  if (!response.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : "Something went wrong. Please try again.",
    );
  }
  return data;
};

/** Not signed in. Emails a 6-digit reset code to the account's recovery email
 *  (if the ID exists and has a verified recovery email). Always resolves — it
 *  never reveals whether the account or the email exists. */
export const requestPasswordResetCode = (studentID: string) =>
  callWorker("password-reset-start", { studentID: studentID.trim() });

/** Not signed in. Verifies the code and sets the new password. */
export const confirmPasswordReset = (
  studentID: string,
  code: string,
  newPassword: string,
) =>
  callWorker("password-reset-confirm", {
    studentID: studentID.trim(),
    code: code.trim(),
    newPassword,
  });

/** Signed in. Emails a 6-digit code to a new recovery email to verify it. */
export const startRecoveryEmailVerification = (studentID: string, email: string) =>
  callWorker(
    "recovery-email-start",
    { studentID: studentID.trim(), email: email.trim() },
    { authed: true },
  );

/** Signed in. Confirms the code and saves the recovery email on the account. */
export const confirmRecoveryEmailVerification = (studentID: string, code: string) =>
  callWorker(
    "recovery-email-confirm",
    { studentID: studentID.trim(), code: code.trim() },
    { authed: true },
  );

/** Verify the current credential and classify legacy/admin-issued passwords.
 * The Worker, never a profile edit, controls mustChangePassword. */
export const checkAccountPassword = (studentID: string, password: string) =>
  callWorker("account-password-check", { studentID, password }, { authed: true }) as Promise<{ mustChangePassword: boolean }>;

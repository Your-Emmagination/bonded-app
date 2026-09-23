// utils/signInHelp.ts
//
// Help for someone who can't sign in: how to reach the school, and a request
// they can send without an account. The request goes through the Cloudflare
// Worker (mode "signin-help-request"), which limits how often it can be sent
// and files it in the admins' support queue — the database itself stays
// closed to anyone who isn't signed in.
import Constants from "expo-constants";
import { Platform } from "react-native";

import { getAiWorkerUrl } from "./aiConfig";

/** Where someone who can't sign in is told to go. Shown to anyone, signed in or not. */
export const SUPPORT_CONTACT = {
  email: "bonded.csap@gmail.com",
  phone: "09761914783",
  phoneDisplay: "0976 191 4783",
  hours: "Monday to Friday, 8:00 AM – 5:00 PM",
} as const;

export type SignInProblem =
  | "forgot_password"
  | "no_recovery_email"
  | "id_not_recognised"
  | "other";

export const SIGN_IN_PROBLEMS: { value: SignInProblem; label: string }[] = [
  { value: "forgot_password", label: "Forgot password" },
  { value: "no_recovery_email", label: "No recovery email" },
  { value: "id_not_recognised", label: "ID not recognised" },
  { value: "other", label: "Something else" },
];

/** A ticket filed this way has no account behind it; see SupportTicketScreen. */
export const SIGN_IN_TICKET_SOURCE = "signin-help";

export const SIGN_IN_LIMITS = {
  idMax: 40,
  nameMax: 80,
  contactMax: 120,
  messageMax: 600,
} as const;

export type SignInHelpRequest = {
  studentID: string;
  fullName: string;
  /** An email or phone number the school can use to reply. */
  contact: string;
  problem: SignInProblem;
  message: string;
};

/** Whether a contact is plausibly an email or a phone number. */
export function isReachableContact(value: string): boolean {
  const trimmed = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
  return /^[+\d][\d\s-]*$/.test(trimmed) && trimmed.replace(/\D/g, "").length >= 7;
}

/**
 * Sends the request. Resolves with the ticket number to quote, or throws
 * with a message fit to show — including when too many were sent.
 */
export async function sendSignInHelpRequest(request: SignInHelpRequest): Promise<string> {
  let response: Response;
  try {
    response = await fetch(getAiWorkerUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "signin-help-request",
        studentID: request.studentID.trim(),
        fullName: request.fullName.trim(),
        contact: request.contact.trim(),
        problem: request.problem,
        message: request.message.trim(),
        platform: Platform.OS,
        appVersion: Constants.expoConfig?.version || null,
      }),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }

  const data = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    ticketNo?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : "Couldn't send your request. Please try again.",
    );
  }
  return typeof data.ticketNo === "string" ? data.ticketNo : "";
}

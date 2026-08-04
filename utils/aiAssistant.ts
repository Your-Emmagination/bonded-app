export const AI_ASSISTANT_ID = "ai-assistant";
export const AI_ASSISTANT_NAME = "Bonded AI";
export const AI_ASSISTANT_EMAIL = "ai@bonded.local";
export const AI_ASSISTANT_STUDENT_ID = "AI";
export const EVERYONE_MENTION_ID = "everyone-mention";
export const EVERYONE_MENTION_NAME = "Everyone";
export const EVERYONE_MENTION_TOKEN = "@everyone";

export const AI_ASSISTANT_TAG = {
  id: AI_ASSISTANT_ID,
  name: AI_ASSISTANT_NAME,
  studentID: AI_ASSISTANT_STUDENT_ID,
};

export const EVERYONE_MENTION_TAG = {
  id: EVERYONE_MENTION_ID,
  name: EVERYONE_MENTION_NAME,
  studentID: "ALL",
};

export const AI_ASSISTANT_STUDENT = {
  id: AI_ASSISTANT_ID,
  firstname: "Bonded",
  lastname: "AI",
  email: AI_ASSISTANT_EMAIL,
  studentID: AI_ASSISTANT_STUDENT_ID,
};

export const EVERYONE_MENTION_STUDENT = {
  id: EVERYONE_MENTION_ID,
  firstname: "Everyone",
  lastname: "",
  email: "everyone@bonded.local",
  studentID: "ALL",
};

export const AI_MENTION_PATTERN = /(^|\s)@(?:ai|bondedai)\b/i;
export const AI_MENTION_TOKEN = "@ai";
export const EVERYONE_MENTION_PATTERN = /(^|\s)@everyone\b/i;

export const isAiAssistantId = (value?: string | null) => value === AI_ASSISTANT_ID;
export const isEveryoneMentionId = (value?: string | null) => value === EVERYONE_MENTION_ID;

export const hasAiAssistantMention = (value?: string | null) =>
  AI_MENTION_PATTERN.test(value || "");

export const hasEveryoneMention = (value?: string | null) =>
  EVERYONE_MENTION_PATTERN.test(value || "");

const normalizeMentionHandle = (value?: string | null) =>
  (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const formatMentionDisplayName = (value?: string | null) =>
  (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

export const getMentionTokenForStudent = (
  studentID?: string | null,
  firstname?: string | null,
  lastname?: string | null,
) => {
  const fullNameHandle = formatMentionDisplayName(
    `${firstname || ""} ${lastname || ""}`.trim(),
  );

  if (fullNameHandle) {
    return `@${fullNameHandle}`;
  }

  const fallbackHandle = normalizeMentionHandle(studentID);
  return fallbackHandle ? `@${fallbackHandle}` : "";
};

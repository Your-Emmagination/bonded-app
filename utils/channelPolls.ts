// utils/channelPolls.ts
//
// Polls inside server channels. A poll is a message in its channel, so it
// follows that channel's rules (private servers, Staff only channels) and
// never reaches the Home feed. Each person's answer is kept under their own
// id in `pollVoters`, which the database rules let them change and nobody
// else; the rules also check the answer is one of the poll's options.

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 6;
/** Creator choices plus choices submitted by members after posting. */
export const POLL_MAX_TOTAL_OPTIONS = 10;
export const POLL_QUESTION_MAX = 200;
export const POLL_OPTION_MAX = 80;
export const POLL_MIN_DURATION_MS = 60 * 1000;
export const POLL_MAX_DURATION_MS = (30 * 24 * 60 + 23 * 60 + 59) * 60 * 1000;

const HOUR = 60 * 60 * 1000;
export const POLL_DURATIONS: { label: string; ms: number }[] = [
  { label: "1 hour", ms: HOUR },
  { label: "1 day", ms: 24 * HOUR },
  { label: "3 days", ms: 3 * 24 * HOUR },
  { label: "1 week", ms: 7 * 24 * HOUR },
];

export type ChannelPollOption = {
  id: string;
  text: string;
  isUserAdded?: boolean;
  addedBy?: string;
};

export type ChannelPoll = {
  question: string;
  options: ChannelPollOption[];
  /** The option ids alone, for the database rules to check answers against. */
  optionIds: string[];
  allowMultiple: boolean;
  allowUsersToAddOption: boolean;
  /** A Date when made; a Firestore Timestamp once saved. */
  closesAt: any;
};

/** Everyone's answers: user id → the option ids they chose. */
export type PollVoters = Record<string, string[]>;

export type PollDraft = {
  question: string;
  options: string[];
  allowMultiple: boolean;
  allowUsersToAddOption: boolean;
  durationMs: number;
};

/** What's wrong with a draft, in words for the person making it, or null. */
export function validatePollDraft(
  draft: Pick<PollDraft, "question" | "options"> & Partial<Pick<PollDraft, "durationMs">>,
): string | null {
  const question = draft.question.trim();
  if (!question) return "Write the question.";
  if (question.length > POLL_QUESTION_MAX) return `Keep the question under ${POLL_QUESTION_MAX} characters.`;
  const options = draft.options.map((option) => option.trim()).filter(Boolean);
  if (options.length < POLL_MIN_OPTIONS) return "Add at least two options.";
  if (options.length > POLL_MAX_OPTIONS) return `A poll can have up to ${POLL_MAX_OPTIONS} options.`;
  if (options.some((option) => option.length > POLL_OPTION_MAX)) {
    return `Keep each option under ${POLL_OPTION_MAX} characters.`;
  }
  const lower = options.map((option) => option.toLowerCase());
  if (new Set(lower).size !== lower.length) return "Two options say the same thing.";
  if (
    draft.durationMs !== undefined &&
    (draft.durationMs < POLL_MIN_DURATION_MS || draft.durationMs > POLL_MAX_DURATION_MS)
  ) {
    return "Choose a duration from 1 minute up to 30 days, 23 hours and 59 minutes.";
  }
  return null;
}

/**
 * The poll to save, from a valid draft: blank options dropped, ids o0, o1…
 * in order, and the closing time from now.
 */
export function buildChannelPoll(draft: PollDraft, nowMs: number): ChannelPoll {
  const options = draft.options
    .map((option) => option.trim())
    .filter(Boolean)
    .slice(0, POLL_MAX_OPTIONS)
    .map((text, index) => ({ id: `o${index}`, text }));
  return {
    question: draft.question.trim(),
    options,
    optionIds: options.map((option) => option.id),
    allowMultiple: draft.allowMultiple,
    allowUsersToAddOption: draft.allowUsersToAddOption,
    closesAt: new Date(nowMs + draft.durationMs),
  };
}

/**
 * Appends one member-submitted option without changing existing poll data.
 * The transaction caller supplies a unique suffix and Firestore rules verify
 * the same append-only shape on the server.
 */
export function appendUserPollOption(
  poll: ChannelPoll,
  userId: string,
  rawText: string,
  uniqueSuffix: string,
): ChannelPoll {
  const text = rawText.trim();
  if (!poll.allowUsersToAddOption) throw new Error("This poll is not accepting new options.");
  if (!text) throw new Error("Write an option first.");
  if (text.length > POLL_OPTION_MAX) {
    throw new Error(`Keep the option under ${POLL_OPTION_MAX} characters.`);
  }
  if (poll.options.length >= POLL_MAX_TOTAL_OPTIONS) {
    throw new Error(`This poll already has ${POLL_MAX_TOTAL_OPTIONS} options.`);
  }
  if (poll.options.some((option) => option.text.trim().toLowerCase() === text.toLowerCase())) {
    throw new Error("That option is already in the poll.");
  }

  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "user";
  const safeSuffix = uniqueSuffix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "option";
  const id = `u_${safeUserId}_${safeSuffix}`;
  const option: ChannelPollOption = {
    id,
    text,
    isUserAdded: true,
    addedBy: userId,
  };

  return {
    ...poll,
    options: [...poll.options, option],
    optionIds: [...poll.optionIds, id],
  };
}

/**
 * The message text for a poll: its question and options. Moderation reads
 * it, channel search finds it, and replies, pins and notifications preview it.
 */
export function pollMessageText(poll: Pick<ChannelPoll, "question" | "options">): string {
  return `📊 ${poll.question}\n${poll.options.map((option) => `• ${option.text}`).join("\n")}`;
}

function toMillis(value: any): number {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return typeof value === "number" ? value : 0;
}

export function pollIsClosed(poll: Pick<ChannelPoll, "closesAt">, nowMs: number): boolean {
  const closes = toMillis(poll.closesAt);
  return !closes || nowMs >= closes;
}

/** "Ends in 45m", "Ends in 3h", "Ends in 2d", or "Closed". */
export function pollTimeLeft(poll: Pick<ChannelPoll, "closesAt">, nowMs: number): string {
  if (pollIsClosed(poll, nowMs)) return "Closed";
  const left = toMillis(poll.closesAt) - nowMs;
  const minutes = Math.max(1, Math.ceil(left / 60000));
  if (minutes < 60) return `Ends in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Ends in ${hours}h`;
  return `Ends in ${Math.round(hours / 24)}d`;
}

/**
 * The results: votes per option, how many people answered, and this
 * person's own answer. Answers that name an option the poll doesn't have
 * are ignored.
 */
export function tallyPoll(
  poll: Pick<ChannelPoll, "options">,
  voters: PollVoters | null | undefined,
  userId?: string | null,
): { counts: Record<string, number>; voterCount: number; mine: string[] } {
  const valid = new Set(poll.options.map((option) => option.id));
  const counts: Record<string, number> = {};
  poll.options.forEach((option) => {
    counts[option.id] = 0;
  });
  let voterCount = 0;
  for (const answer of Object.values(voters || {})) {
    const picks = Array.isArray(answer) ? answer.filter((id) => valid.has(id)) : [];
    if (picks.length === 0) continue;
    voterCount += 1;
    picks.forEach((id) => {
      counts[id] += 1;
    });
  }
  const own = userId ? voters?.[userId] : undefined;
  const mine = Array.isArray(own) ? own.filter((id) => valid.has(id)) : [];
  return { counts, voterCount, mine };
}

/**
 * This person's answer after tapping an option. Tapping your answer again
 * takes it back; in a one-answer poll, another option replaces it.
 */
export function nextPollAnswer(
  poll: Pick<ChannelPoll, "allowMultiple">,
  mine: string[],
  optionId: string,
): string[] {
  if (mine.includes(optionId)) return mine.filter((id) => id !== optionId);
  return poll.allowMultiple ? [...mine, optionId] : [optionId];
}

// utils/pollVoting.ts
//
// Voting in a feed poll and adding an option to one. Shared by Home and the
// Pinned page, so a pinned poll is voted on the same way wherever it's shown.
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../Firebase_configure";

type OptionLike = { text?: string; votes?: number; voters?: string[] };

type VotablePoll<T extends OptionLike> = {
  options: T[];
  allowMultiple?: boolean;
  maxSelections?: number;
  expiresAt?: unknown;
};

/** True once a poll's voting deadline has passed. A poll without one never closes. */
export function isPollClosed(expiresAt: unknown): boolean {
  const deadline = expiresAt as { toDate?: () => Date } | null | undefined;
  if (!deadline || typeof deadline.toDate !== "function") return false;
  return new Date() > deadline.toDate();
}

/**
 * The poll's options and total after `uid` votes for `optionIndex`, or null
 * when that vote isn't allowed: voting closed, already voted in a
 * one-answer poll, that option already chosen, or the most answers used.
 */
export function planPollVote<T extends OptionLike>(
  poll: VotablePoll<T>,
  uid: string,
  optionIndex: number,
): { options: T[]; totalVotes: number } | null {
  if (isPollClosed(poll.expiresAt)) return null;
  const myVotes = poll.options
    .map((option, index) => (option.voters?.includes(uid) ? index : -1))
    .filter((index) => index !== -1);
  if (!poll.allowMultiple && myVotes.length > 0) return null;
  if (myVotes.includes(optionIndex)) return null;
  if (poll.allowMultiple && myVotes.length >= (poll.maxSelections ?? Infinity)) return null;

  const options = poll.options.map((option, index) => {
    const voters = Array.isArray(option.voters) ? [...option.voters] : [];
    if (index === optionIndex && !voters.includes(uid)) voters.push(uid);
    return { ...option, voters, votes: voters.length };
  });
  const totalVotes = options.reduce((sum, option) => sum + (option.votes || 0), 0);
  return { options, totalVotes };
}

/** Saves `uid`'s vote. Resolves false when the vote isn't allowed; throws if saving fails. */
export async function submitPollVote<T extends OptionLike>(
  pollId: string,
  poll: VotablePoll<T>,
  uid: string,
  optionIndex: number,
): Promise<boolean> {
  const next = planPollVote(poll, uid, optionIndex);
  if (!next) return false;
  await updateDoc(doc(db, "polls", pollId), next);
  return true;
}

export type AddPollOptionResult = "added" | "empty" | "missing" | "closed";

/** Adds a new option to a poll that allows it. Throws if saving fails. */
export async function addPollOption(pollId: string, text: string): Promise<AddPollOptionResult> {
  if (!text.trim()) return "empty";
  const pollRef = doc(db, "polls", pollId);
  const snapshot = await getDoc(pollRef);
  if (!snapshot.exists()) return "missing";
  const poll = snapshot.data() as VotablePoll<OptionLike>;
  if (isPollClosed(poll.expiresAt)) return "closed";
  const options = [...(poll.options || []), { text: text.trim(), votes: 0, voters: [] }];
  const totalVotes = options.reduce((sum, option) => sum + (option.votes || 0), 0);
  await updateDoc(pollRef, { options, totalVotes });
  return "added";
}

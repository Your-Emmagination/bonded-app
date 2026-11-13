// utils/channelMessageDelete.ts
//
// Deleting a server channel message leaves its place in the conversation,
// like DMs do: everything it said, showed or linked is wiped, and a
// "Message deleted" (or "Removed by a moderator") line stays where it was.
// Who wrote it and when are kept so the conversation still reads in order.
//
// firestore.rules (validMessageTombstone) accepts exactly these fields.
import { deleteField, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../Firebase_configure";

/** "author": the writer deleted it. "moderator": staff removed someone else's. */
export type MessageDeletedBy = "author" | "moderator";

export const deletedMessageLabel = (deletedBy?: string | null) =>
  deletedBy === "moderator" ? "Removed by a moderator" : "Message deleted";

/** The fields that turn a channel message into its placeholder. */
export function channelMessageTombstone(deletedBy: MessageDeletedBy) {
  return {
    deleted: true,
    deletedBy,
    deletedAt: serverTimestamp(),
    text: "",
    files: [],
    taggedUsers: [],
    mentionedUserIds: [],
    reactions: {},
    pinned: false,
    link: deleteField(),
    poll: deleteField(),
    pollVoters: deleteField(),
    replyTo: deleteField(),
    forwarded: deleteField(),
    isForwarded: deleteField(),
    forwardedFrom: deleteField(),
    pinnedAt: deleteField(),
    pinnedBy: deleteField(),
    pinnedByName: deleteField(),
    editedAt: deleteField(),
  };
}

export async function deleteChannelMessage(
  collectionName: "communityThreadMessages" | "communityStaffMessages",
  messageId: string,
  deletedBy: MessageDeletedBy,
) {
  await updateDoc(doc(db, collectionName, messageId), channelMessageTombstone(deletedBy));
}

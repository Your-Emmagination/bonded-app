import ComposerBase, { type ComposerLabels, type ComposerProps } from "./ComposerBase";

export type ReplyComposerProps = ComposerProps;

const labels: ComposerLabels = {
  item: "reply",
  placeholder: "Write a reply...",
  send: "Post reply",
  sending: "Posting reply",
  sendFailure: "Failed to post reply. Please try again.",
  connectionFailure: "Unable to post reply. Please check your internet connection and try again.",
  attachmentFailure: "The selected attachment cannot be read. Remove it and select it again before posting your reply.",
  logPrefix: "Reply composer error",
};

export default function ReplyComposer(props: ReplyComposerProps) {
  return <ComposerBase {...props} labels={labels} />;
}

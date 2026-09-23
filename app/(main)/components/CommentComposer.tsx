import ComposerBase, { type ComposerLabels, type ComposerProps } from "./ComposerBase";

export type CommentComposerProps = ComposerProps;

const labels: ComposerLabels = {
  item: "comment",
  placeholder: "Write a comment...",
  send: "Post comment",
  sending: "Posting comment",
  sendFailure: "Failed to post comment. Please try again.",
  connectionFailure: "Your comment was not posted. Check your connection and try again.",
  attachmentFailure: "The selected attachment is no longer available. Select it again.",
  logPrefix: "Comment error",
};

/** Comment-specific entry point backed by the shared composer behavior. */
export default function CommentComposer(props: CommentComposerProps) {
  return <ComposerBase {...props} labels={labels} />;
}

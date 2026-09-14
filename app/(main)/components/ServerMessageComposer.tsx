import ComposerBase, { type ComposerLabels, type ComposerProps } from "./ComposerBase";

export type ServerMessageComposerProps = ComposerProps;

const labels: ComposerLabels = {
  item: "message",
  placeholder: "Message...",
  send: "Send message",
  sending: "Sending message",
  sendFailure: "Failed to send message. Please try again.",
  connectionFailure: "Unable to send message. Please check your internet connection and try again.",
  attachmentFailure: "The selected attachment cannot be read. Remove it and select it again before sending your message.",
  logPrefix: "Server message composer error",
};

export default function ServerMessageComposer(props: ServerMessageComposerProps) {
  return <ComposerBase {...props} labels={labels} />;
}

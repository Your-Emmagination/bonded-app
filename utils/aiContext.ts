import type { AiContextMessage } from "./aiWorker";
import { isAiAssistantId } from "./aiAssistant";

type TaggedUser = {
  id: string;
  name: string;
  studentID?: string;
};

type AttachedLink = {
  url: string;
  title?: string;
};

type AttachedFile = {
  url: string;
  mimeType: string;
  name?: string;
};

type ReplyReference = {
  id?: string;
  name?: string;
  text?: string;
};

type SummarizeArgs = {
  text?: string | null;
  username?: string | null;
  isAnonymous?: boolean | null;
  link?: AttachedLink | null;
  files?: AttachedFile[] | null;
  taggedUsers?: TaggedUser[] | null;
  replyingTo?: ReplyReference | null;
};

export const summarizeAiVisibleContent = ({
  text,
  link,
  files,
  taggedUsers,
  replyingTo,
}: SummarizeArgs) => {
  const parts: string[] = [];
  const trimmedText = text?.trim();

  if (replyingTo?.text || replyingTo?.name) {
    parts.push(
      `Replying to ${replyingTo.name || "someone"}: ${replyingTo.text || "[message]"}`,
    );
  }

  if (trimmedText) {
    parts.push(trimmedText);
  }

  if (link?.url) {
    parts.push(`[shared link: ${link.title || link.url}]`);
  }

  if (files?.length) {
    parts.push(
      `[shared ${files.length} attachment${files.length === 1 ? "" : "s"}]`,
    );
  }

  // Tagging the AI is how this flow gets triggered, so it isn't meaningful
  // "context" — including it just adds noise that can drown out short
  // prompts like "bye" or "how are you" before they ever reach the intent
  // classifier. Only mention *other* tagged users, if any, and only by name:
  // including their raw student ID (which often looks like "012324-004855")
  // has previously been misread by the calculator as a subtraction problem.
  const otherTaggedUsers = (taggedUsers || []).filter((tag) => !isAiAssistantId(tag.id));
  if (otherTaggedUsers.length) {
    parts.push(`Tagged users: ${otherTaggedUsers.map((tag) => tag.name).join(", ")}`);
  }

  return parts.join("\n").trim() || "[empty message]";
};

export const buildAiConversationContext = <
  T extends {
    text?: string | null;
    username?: string | null;
    isAnonymous?: boolean | null;
    realUserId?: string | null;
    userId?: string | null;
    aiReply?: { text?: string | null } | null;
    link?: AttachedLink | null;
    files?: AttachedFile[] | null;
    taggedUsers?: TaggedUser[] | null;
    replyingTo?: ReplyReference | null;
  },
>(
  items: T[],
): AiContextMessage[] => {
  const context: AiContextMessage[] = [];

  for (const item of items) {
    context.push({
      role: isAiAssistantId(item.realUserId || item.userId) ? "assistant" : "user",
      name: item.isAnonymous ? "Anonymous" : item.username || "User",
      content: summarizeAiVisibleContent(item),
    });

    if (item.aiReply?.text?.trim()) {
      context.push({
        role: "assistant",
        name: "Bonded AI",
        content: item.aiReply.text.trim(),
      });
    }
  }

  return context;
};

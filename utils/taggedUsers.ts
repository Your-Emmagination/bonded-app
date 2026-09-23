export type TaggedUser = {
  id: string;
  name: string;
  studentID: string;
};

export type TaggedTextPart = {
  text: string;
  taggedUser?: TaggedUser;
};

/** Group mentions are highlighted but do not represent a user profile. */
export function canNavigateToTaggedUser(taggedUserId?: string | null): boolean {
  return !!taggedUserId &&
    taggedUserId !== "everyone-mention" &&
    taggedUserId !== "ai-assistant";
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Keeps the people selected with "Tag people" while hiding people whose
 * names are already visible as inline @mentions in the message text.
 *
 * Older messages may not have mentionedUserIds, so the text check preserves
 * the same display behavior for those records too.
 */
export function manualTaggedUsers(
  text: string,
  taggedUsers: TaggedUser[] = [],
  mentionedUserIds: string[] = [],
): TaggedUser[] {
  const inlineIds = new Set(mentionedUserIds);

  return taggedUsers.filter((tag) => {
    if (inlineIds.has(tag.id)) return false;
    const name = tag.name.trim();
    if (!name) return true;
    const inlineMention = new RegExp(
      `(^|\\s)@${escapeRegExp(name)}(?=$|\\s|[.,!?;:])`,
      "i",
    );
    return !inlineMention.test(text || "");
  });
}

const mentionTokenForTaggedUser = (tag: TaggedUser) => {
  if (tag.id === "ai-assistant") return "@ai";
  if (tag.id === "everyone-mention") return "@everyone";
  const name = tag.name.trim().replace(/\s+/g, " ");
  return name ? `@${name}` : "";
};

/** Splits post copy into plain and tappable inline @mention runs. */
export function splitTaggedMentions(
  text: string,
  taggedUsers: TaggedUser[] = [],
  mentionedUserIds: string[] = [],
): TaggedTextPart[] {
  const allowedIds = new Set(mentionedUserIds);
  const candidates = taggedUsers
    .filter((tag) => allowedIds.size === 0 || allowedIds.has(tag.id))
    .map((taggedUser) => ({
      taggedUser,
      token: mentionTokenForTaggedUser(taggedUser),
    }))
    .filter((entry) => entry.token.length > 1)
    .sort((a, b) => b.token.length - a.token.length);

  if (!text || candidates.length === 0) return text ? [{ text }] : [];

  const lowerText = text.toLocaleLowerCase();
  const parts: TaggedTextPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let next:
      | { index: number; token: string; taggedUser: TaggedUser }
      | undefined;

    for (const candidate of candidates) {
      const lowerToken = candidate.token.toLocaleLowerCase();
      let index = lowerText.indexOf(lowerToken, cursor);
      while (index >= 0) {
        const before = index === 0 ? "" : text[index - 1];
        const afterIndex = index + candidate.token.length;
        const after = afterIndex >= text.length ? "" : text[afterIndex];
        const startsAtBoundary = index === 0 || /\s/.test(before);
        const endsAtBoundary = afterIndex === text.length || /[\s.,!?;:]/.test(after);
        if (startsAtBoundary && endsAtBoundary) break;
        index = lowerText.indexOf(lowerToken, index + 1);
      }
      if (index >= 0 && (!next || index < next.index)) {
        next = { index, token: candidate.token, taggedUser: candidate.taggedUser };
      }
    }

    if (!next) {
      parts.push({ text: text.slice(cursor) });
      break;
    }
    if (next.index > cursor) parts.push({ text: text.slice(cursor, next.index) });
    parts.push({
      text: text.slice(next.index, next.index + next.token.length),
      taggedUser: next.taggedUser,
    });
    cursor = next.index + next.token.length;
  }

  return parts;
}

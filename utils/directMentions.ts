export type DirectMentionTarget = {
  id: string;
  name: string;
};

export type DirectMentionMatch = {
  start: number;
  end: number;
  query: string;
};

type Selection = { start: number; end: number };

const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ");

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Returns the @ fragment immediately before the caret. Names may contain
 * spaces, but a completed "@Full Name " closes the picker.
 */
export function findActiveDirectMention(
  text: string,
  selection: Selection,
  recipientName: string,
): DirectMentionMatch | null {
  const name = normalizeName(recipientName);
  if (!name) return null;
  const caret = Math.max(0, Math.min(selection.start, text.length));
  const beforeCaret = text.slice(0, caret);
  const match = beforeCaret.match(/(^|\s)@([^@\n]*)$/);
  if (!match || typeof match.index !== "number") return null;

  const rawQuery = match[2] ?? "";
  const query = normalizeName(rawQuery);
  if (rawQuery.endsWith(" ") && query.toLocaleLowerCase() === name.toLocaleLowerCase()) {
    return null;
  }
  if (query && !name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return null;

  return {
    start: match.index + match[1].length,
    end: caret,
    query,
  };
}

export function insertDirectMention(
  text: string,
  selection: Selection,
  match: DirectMentionMatch,
  recipientName: string,
): { text: string; selection: Selection } {
  const name = normalizeName(recipientName);
  const inserted = `@${name} `;
  let suffixStart = Math.max(match.end, selection.end);
  if (text[suffixStart] === " ") suffixStart += 1;
  const nextText = text.slice(0, match.start) + inserted + text.slice(suffixStart);
  const caret = match.start + inserted.length;
  return { text: nextText, selection: { start: caret, end: caret } };
}

export function directMentionsForText(
  text: string,
  recipient: DirectMentionTarget,
): DirectMentionTarget[] {
  const name = normalizeName(recipient.name);
  if (!recipient.id || !name) return [];
  const pattern = new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=$|\\s|[.,!?;:])`, "i");
  return pattern.test(text) ? [{ id: recipient.id, name }] : [];
}

/** Splits plain text so saved mentions can be styled and opened as profiles. */
export function splitDirectMentions(
  text: string,
  mentions: DirectMentionTarget[] = [],
): { text: string; mention?: DirectMentionTarget }[] {
  const valid = mentions
    .map((mention) => ({ ...mention, name: normalizeName(mention.name) }))
    .filter((mention) => mention.id && mention.name);
  if (valid.length === 0 || !text) return [{ text }];

  const byToken = new Map(valid.map((mention) => [`@${mention.name}`.toLocaleLowerCase(), mention]));
  const alternatives = valid.map((mention) => `@${escapeRegExp(mention.name)}`).join("|");
  const pattern = new RegExp(`(${alternatives})(?=$|\\s|[.,!?;:])`, "gi");
  return text.split(pattern).filter(Boolean).map((part) => {
    const mention = byToken.get(part.toLocaleLowerCase());
    return mention ? { text: part, mention } : { text: part };
  });
}

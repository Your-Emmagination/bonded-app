/**
 * Splits chat text into ordinary text and safe, normalized web links.
 *
 * People commonly paste `facebook.com` without a protocol, so bare domains
 * are accepted alongside `www.` and http(s) URLs. Email domains are excluded
 * because a domain must start at the beginning of the message or after
 * whitespace/opening punctuation.
 */
export function splitMessageLinks(text: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = [];
  const pattern =
    /(^|[\s([{])((?:https?:\/\/|www\.)[^\s<>]+|(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>]*)?)/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const prefix = match[1] || "";
    const rawValue = match[2] || "";
    const index = match.index! + prefix.length;
    if (index > offset) parts.push({ text: text.slice(offset, index) });
    let value = rawValue.replace(/[.,!?;:'"]+$/, "");
    while (value.endsWith(")") && (value.match(/\)/g)?.length || 0) > (value.match(/\(/g)?.length || 0)) value = value.slice(0, -1);
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const parsed = new URL(url);
      parts.push({ text: value, ...(parsed.hostname ? { url } : {}) });
    } catch { parts.push({ text: value }); }
    offset = index + value.length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}

/** Returns a normalized http(s) URL for the link composer. */
export function normalizeMessageUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(normalized);
    if (!parsed.hostname || !parsed.hostname.includes(".")) return null;
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? normalized : null;
  } catch {
    return null;
  }
}

export function messageLinks(message: { text: string; link?: { url: string } }): string[] {
  return [...new Set([...splitMessageLinks(message.text).flatMap((part) => part.url ? [part.url] : []),
    ...(message.link && /^https?:\/\//i.test(message.link.url) ? [message.link.url] : [])])];
}

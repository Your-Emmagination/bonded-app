/** Only web URLs are made tappable; punctuation remains part of the message. */
export function splitMessageLinks(text: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = [];
  const pattern = /(?:https?:\/\/|www\.)[^\s<>]+/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > offset) parts.push({ text: text.slice(offset, index) });
    let value = match[0].replace(/[.,!?;:'"]+$/, "");
    while (value.endsWith(")") && (value.match(/\)/g)?.length || 0) > (value.match(/\(/g)?.length || 0)) value = value.slice(0, -1);
    const url = /^www\./i.test(value) ? `https://${value}` : value;
    try {
      const parsed = new URL(url);
      parts.push({ text: value, ...(parsed.hostname ? { url } : {}) });
    } catch { parts.push({ text: value }); }
    offset = index + value.length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}

export function messageLinks(message: { text: string; link?: { url: string } }): string[] {
  return [...new Set([...splitMessageLinks(message.text).flatMap((part) => part.url ? [part.url] : []),
    ...(message.link && /^https?:\/\//i.test(message.link.url) ? [message.link.url] : [])])];
}

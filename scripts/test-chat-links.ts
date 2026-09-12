import assert from "node:assert/strict";
import { messageLinks, splitMessageLinks } from "../utils/chatLinks";

const text = "Open (https://example.com/a(b)), then www.example.org. Also https://example.net!";
const parts = splitMessageLinks(text);
assert.equal(parts.map((part) => part.text).join(""), text, "Link rendering must preserve all original text and punctuation");
assert.deepEqual(parts.flatMap((part) => part.url ? [part.url] : []), ["https://example.com/a(b)", "https://www.example.org", "https://example.net"]);
assert.deepEqual(messageLinks({ text: "https://example.com https://example.com", link: { url: "https://example.com" } }), ["https://example.com"]);
assert.deepEqual(messageLinks({ text: "javascript:alert(1) file:///private/path", link: { url: "javascript:alert(1)" } }), []);
assert.deepEqual(splitMessageLinks("Plain text"), [{ text: "Plain text" }]);
assert.deepEqual(splitMessageLinks(""), []);
console.log("Chat link regression checks passed.");

/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { DraftAttachment, insertEmojiInDraft, MESSAGE_MAX_LENGTH, prepareDraftAttachment } from "../utils/messageComposer";

test("emoji inserts at the caret and replaces selected text", () => {
  assert.deepEqual(insertEmojiInDraft("Hello world", "😊", { start: 5, end: 5 }), {
    text: "Hello😊 world", selection: { start: 7, end: 7 },
  });
  assert.deepEqual(insertEmojiInDraft("Hello world", "🌎", { start: 6, end: 11 }), {
    text: "Hello 🌎", selection: { start: 8, end: 8 },
  });
});

test("consecutive and joined emojis preserve native UTF-16 caret positions", () => {
  const first = insertEmojiInDraft("", "❤️‍🩹", { start: 0, end: 0 })!;
  const next = insertEmojiInDraft(first.text, "👍🏽", first.selection)!;
  assert.equal(next.text, "❤️‍🩹👍🏽");
  assert.deepEqual(next.selection, { start: next.text.length, end: next.text.length });
  assert.equal(insertEmojiInDraft(next.text, "!", next.selection)?.text, "❤️‍🩹👍🏽!");
});

test("emoji insertion respects the message limit without cutting an emoji", () => {
  const full = "x".repeat(MESSAGE_MAX_LENGTH);
  assert.equal(insertEmojiInDraft(full, "😊", { start: full.length, end: full.length }), null);
  assert.equal(insertEmojiInDraft(full.slice(1), "😊", { start: 0, end: 0 }), null);
  assert.equal(insertEmojiInDraft(full, "😊", { start: 0, end: 2 })?.text.length, MESSAGE_MAX_LENGTH);
});

test("a stale caret after a draft is cleared stays within the text", () => {
  assert.deepEqual(insertEmojiInDraft("", "😊", { start: 40, end: 42 }), {
    text: "😊", selection: { start: 2, end: 2 },
  });
});

test("photos and files use the correct upload types and retain their metadata", async () => {
  for (const image of [true, false]) {
    const draft: DraftAttachment = {
      uri: image ? "file:///photo.png" : "file:///notes.pdf",
      name: image ? "Photo.png" : "Notes.pdf",
      mimeType: image ? "image/png" : "application/pdf",
      source: image ? "camera" : "file",
    };
    const uploaded = await prepareDraftAttachment(draft, async (options) => {
      assert.deepEqual(options, { uri: draft.uri, folder: image ? "post_images" : "post_files", resourceType: image ? "image" : "raw" });
      return "https://example.test/attachment";
    });
    assert.deepEqual(uploaded, { url: "https://example.test/attachment", name: draft.name, mimeType: draft.mimeType });
  }
});

test("a retry after message failure reuses the photo already uploaded", async () => {
  const draft: DraftAttachment = { uri: "file:///photo.jpg", name: "Photo", mimeType: "image/jpeg", source: "camera" };
  let uploads = 0;
  const upload = async () => { uploads += 1; return "https://example.test/photo.jpg"; };
  const first = await prepareDraftAttachment(draft, upload);
  const retry = await prepareDraftAttachment({ ...draft, uploaded: first }, upload);
  assert.deepEqual(retry, first);
  assert.equal(uploads, 1);
});

test("a failed upload keeps the draft usable and an empty upload URL fails", async () => {
  const draft: DraftAttachment = { uri: "file:///photo.jpg", name: "Photo", mimeType: "image/jpeg", source: "camera" };
  await assert.rejects(prepareDraftAttachment(draft, async () => { throw new Error("Offline"); }), /Offline/);
  assert.equal(draft.uri, "file:///photo.jpg");
  assert.equal(draft.uploaded, undefined);
  await assert.rejects(prepareDraftAttachment(draft, async () => ""), /could not be uploaded/);
  assert.equal((await prepareDraftAttachment(draft, async () => "https://example.test/photo.jpg")).url, "https://example.test/photo.jpg");
});

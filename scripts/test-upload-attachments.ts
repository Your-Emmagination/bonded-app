/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Exercise the real TS modules with native I/O mocked; never upload user files.
function loadModule(path: string, dependencies: Record<string, unknown>, fetchMock?: unknown) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", "__DEV__", "fetch", "console", code)(
    (name: string) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    }, module, module.exports, false, fetchMock, { error() {} },
  );
  return module.exports;
}

function fixture(os = "android") {
  const cache = "file:///cache/ExperienceData/bonded/";
  const files = new Set<string>();
  const deleted: string[] = [];
  const copies: string[] = [];
  let pickerOptions: any;
  let pickerResult: any = { canceled: false, assets: [] };
  let failCopy = "";
  let uploadError: Error | undefined;
  let response = { status: 200, body: JSON.stringify({ secure_url: "https://cdn.example/photo.png" }) };
  const uploads: { uri: string; options: any }[] = [];
  class NativeFile {
    uri: string;
    constructor(...parts: string[]) { this.uri = parts.join(""); }
    get exists() {
      if (!this.uri.startsWith(cache)) throw new Error("Location isn't readable");
      return files.has(this.uri);
    }
    async copy(destination: NativeFile) {
      assert.ok(this.uri.startsWith("content://"));
      assert.ok(destination.uri.startsWith(cache));
      copies.push(destination.uri);
      // Simulate async native copy, including a partially written failed copy.
      await Promise.resolve();
      files.add(destination.uri);
      if (this.uri === failCopy) throw new Error("Provider permission expired");
    }
    delete() { deleted.push(this.uri); files.delete(this.uri); }
  }
  const platform = { Platform: { OS: os } };
  const attachments = loadModule("utils/uploadAttachments.ts", {
    "expo-document-picker": {
      getDocumentAsync: async (options: any) => { pickerOptions = options; return pickerResult; },
    },
    "expo-file-system": { File: NativeFile, Paths: { cache } },
    "react-native": platform,
  }) as typeof import("../utils/uploadAttachments");
  const cloudinary = loadModule("utils/cloudinaryUpload.ts", {
    "expo-file-system/legacy": {
      FileSystemUploadType: { MULTIPART: 1 },
      uploadAsync: async (_endpoint: string, uri: string, options: any) => {
        uploads.push({ uri, options });
        if (uploadError) throw uploadError;
        return response;
      },
    },
    "react-native": platform,
    "./uploadAttachments": attachments,
    "./cloudinaryImages": { getCloudinaryUrl: () => undefined },
  }) as typeof import("../utils/cloudinaryUpload");
  return {
    attachments, cloudinary, cache, files, copies, deleted, uploads,
    select: (assets: any[]) => { pickerResult = { canceled: false, assets }; },
    cancel: () => { pickerResult = { canceled: true, assets: null }; },
    failCopy: (uri: string) => { failCopy = uri; },
    failUpload: (error: Error) => { uploadError = error; },
    respond: (value: typeof response) => { response = value; },
    pickerOptions: () => pickerOptions,
  };
}

const photo = { uri: "content://provider/photo/1", name: "My photo.png", mimeType: "image/png", size: 321, lastModified: 123 };

test("Android selection copies the granted URI into scoped cache before native upload", async () => {
  const f = fixture();
  f.select([photo, { ...photo, uri: "content://provider/photo/2" }]);
  const result = await f.attachments.pickUploadDocuments({ type: "image/*", multiple: true });
  assert.equal(result.canceled, false);
  if (result.canceled) return;
  assert.deepEqual(f.pickerOptions(), { type: "image/*", multiple: true, copyToCacheDirectory: false });
  assert.notEqual(result.assets[0].uri, result.assets[1].uri);
  for (const asset of result.assets) {
    assert.ok(f.files.has(asset.uri), "Copy must finish before the attachment can be used");
    assert.deepEqual({ ...asset, uri: photo.uri }, photo, "Retain attachment metadata");
    assert.equal(await f.cloudinary.uploadPostImage(asset.uri), "https://cdn.example/photo.png");
  }
  assert.equal(f.uploads[0].uri, result.assets[0].uri);
  assert.equal(f.uploads[0].options.mimeType, "image/png");
  assert.equal(f.uploads[0].options.fieldName, "file");
  assert.equal(f.uploads[0].options.parameters.folder, "post_images");
  assert.equal(f.files.size, 2, "Cache copies remain available for preview and retry");
});

test("document extension survives unsafe names and still selects the correct MIME type", async () => {
  const f = fixture();
  f.select([{ ...photo, name: "../notes/report.pdf", mimeType: "application/pdf" }]);
  const result = await f.attachments.pickUploadDocuments({ type: "*/*" });
  if (result.canceled) assert.fail("Expected selection");
  const asset = result.assets[0];
  assert.equal(asset.uri.slice(f.cache.length).includes("/"), false);
  await f.cloudinary.uploadPostFile(asset.uri);
  assert.equal(f.uploads[0].options.mimeType, "application/pdf");
});

test("cancel, iOS and web preserve the picker result without Android staging", async () => {
  for (const os of ["android", "ios", "web"]) {
    const f = fixture(os);
    f.cancel();
    assert.deepEqual(await f.attachments.pickUploadDocuments({}), { canceled: true, assets: null });
    assert.equal(f.copies.length, 0);
    if (os !== "android") {
      f.select([photo]);
      const result = await f.attachments.pickUploadDocuments({});
      assert.deepEqual(result.assets, [photo]);
      assert.equal(f.pickerOptions().copyToCacheDirectory, true);
      assert.equal(f.copies.length, 0);
    }
  }
});

test("failed multi-file selection cleans up only its new copies", async () => {
  const f = fixture();
  f.files.add(`${f.cache}existing-draft.pdf`);
  f.select([photo, { ...photo, uri: "content://provider/denied" }]);
  f.failCopy("content://provider/denied");
  await assert.rejects(f.attachments.pickUploadDocuments({ multiple: true }), f.attachments.isAttachmentUnavailableError);
  assert.deepEqual([...f.files], [`${f.cache}existing-draft.pdf`]);
  assert.deepEqual(f.deleted, f.copies);
  assert.equal(f.uploads.length, 0);
});

test("missing or old unscoped attachments fail before any upload with reselect guidance", async () => {
  const f = fixture();
  for (const uri of [`${f.cache}missing.jpg`, "file:///cache/DocumentPicker/old.jpg"]) {
    await assert.rejects(f.cloudinary.uploadPostImage(uri), /Remove it and select it again/);
  }
  assert.equal(f.uploads.length, 0);
});

test("file removed between preflight and upload gets reselect guidance; network failure stays distinct", async () => {
  const f = fixture();
  const uri = `${f.cache}photo.png`;
  f.files.add(uri);
  f.failUpload(new Error("Location isn't readable"));
  await assert.rejects(f.cloudinary.uploadPostImage(uri), f.attachments.isAttachmentUnavailableError);
  f.failUpload(new Error("Network request failed"));
  await assert.rejects(f.cloudinary.uploadPostImage(uri), /internet connection/);
});

test("malformed and failed Cloudinary responses never produce an attachment URL", async () => {
  const f = fixture();
  const uri = `${f.cache}photo.png`;
  f.files.add(uri);
  for (const response of [
    { status: 502, body: "Bad gateway" },
    { status: 400, body: JSON.stringify({ error: { message: "Rejected" } }) },
    { status: 200, body: JSON.stringify({}) },
    { status: 200, body: JSON.stringify({ secure_url: "http://insecure.example/photo.png" }) },
  ]) {
    f.respond(response);
    await assert.rejects(f.cloudinary.uploadPostImage(uri), /Upload failed/);
  }
});

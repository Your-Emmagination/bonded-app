import assert from "node:assert/strict";
import { prepareDraftAttachment, type DraftAttachment } from "../utils/messageComposer";

async function main() {
  const photo: DraftAttachment = {
    uri: "file:///cache/direct_photo.jpg",
    name: "direct_photo.jpg",
    mimeType: "image/jpeg",
    source: "camera",
  };
  let uploads = 0;
  const upload = async () => {
    uploads += 1;
    return "https://res.cloudinary.com/test/image/upload/direct_photo.jpg";
  };
  const sent = await prepareDraftAttachment(photo, upload, () => ({ width: 1200, height: 800 }));
  assert.equal(sent.url, "https://res.cloudinary.com/test/image/upload/direct_photo.jpg");
  assert.equal("size" in sent, false, "A photo without fileSize must not send undefined to Firestore");
  assert.equal(sent.width, 1200);
  assert.equal(sent.height, 800);
  assert.equal(Object.values(sent).every((value) => value !== undefined), true);

  const sized = await prepareDraftAttachment({ ...photo, source: "gallery", size: 12345 }, upload);
  assert.equal(sized.size, 12345);
  assert.equal(Object.values(sized).every((value) => value !== undefined), true);

  const retry = await prepareDraftAttachment({ ...photo, uploaded: sent }, upload);
  assert.deepEqual(retry, sent, "Retry should reuse the uploaded file");
  assert.equal(uploads, 2, "Retry must not upload the photo again");
  console.log("DM photo payload and retry checks passed");
}

void main();

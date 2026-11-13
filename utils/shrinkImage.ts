// utils/shrinkImage.ts
//
// Photos are made smaller on the phone before they upload. Many phone photos
// are 10–15 MB, over the 10 MB Cloudinary's free plan accepts, so they
// failed to send; shrunk to at most 2048 px on the longest side they are
// usually under 1.5 MB, upload faster, and still look sharp full screen.
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

/** The longest side a photo is uploaded at. */
export const MAX_PHOTO_SIDE = 2048;
const JPEG_QUALITY = 0.8;

/**
 * A smaller copy of the photo at `uri`, or `uri` itself if anything goes
 * wrong — a photo that can't be shrunk still gets its chance to upload.
 * PNGs stay PNG so screenshots and transparent images keep their look.
 * GIFs must not come here: this would keep only their first frame.
 */
export async function shrinkPhotoForUpload(uri: string, isPng = false): Promise<string> {
  try {
    const context = ImageManipulator.manipulate(uri);
    const original = await context.renderAsync();
    const longest = Math.max(original.width, original.height);
    let image = original;
    if (longest > MAX_PHOTO_SIDE) {
      context.resize(
        original.width >= original.height ? { width: MAX_PHOTO_SIDE } : { height: MAX_PHOTO_SIDE },
      );
      image = await context.renderAsync();
    }
    const saved = await image.saveAsync(
      isPng ? { format: SaveFormat.PNG } : { format: SaveFormat.JPEG, compress: JPEG_QUALITY },
    );
    return saved.uri || uri;
  } catch (error) {
    console.warn("[shrinkImage] Uploading the original photo:", error);
    return uri;
  }
}

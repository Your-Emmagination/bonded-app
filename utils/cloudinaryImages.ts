// utils/cloudinaryImage.ts
// Central helper for requesting appropriately-sized, compressed images from
// Cloudinary instead of always downloading the full-resolution original.
//
// Every image the app uploads (avatars, post photos, poll images, message
// attachments) goes through utils/cloudinaryUpload.ts and comes back as a
// standard Cloudinary "secure_url", e.g.:
//
//   https://res.cloudinary.com/dutkd2ih4/image/upload/v169.../post_images/post_img_123.jpg
//
// Cloudinary supports on-the-fly transformations by inserting a
// comma-separated transformation string right after "/upload/" in that URL —
// no re-upload needed, the CDN resizes/re-encodes on first request and
// caches the result. This file centralizes that so every screen asks for a
// size appropriate to where the image is actually displayed, instead of a
// 40x40 avatar decoding a multi-megapixel original.
//
// Non-Cloudinary URLs (GIFs from Giphy/Tenor, local file:// picker previews,
// etc.) are returned unchanged — this is safe to apply everywhere.

export type CloudinaryTransformOptions = {
  /** Target width in px (device-independent; dpr_auto handles pixel density). */
  width?: number;
  /** Target height in px. Omit to preserve aspect ratio. */
  height?: number;
  /**
   * "fill" (default when height is set) crops to exactly width x height —
   * use for avatars/thumbnails. "limit" scales down to fit within width
   * (and height, if given) without cropping or upscaling — use for photos
   * where the full image should remain visible.
   */
  crop?: "fill" | "limit";
  /** Crop focal point. "face" recenters on a detected face — ideal for avatars. */
  gravity?: "face" | "auto" | "center";
};

const CLOUDINARY_UPLOAD_MARKER = "/upload/";

/**
 * Returns a resized/compressed delivery URL for a Cloudinary-hosted image.
 * Returns the input unchanged for any URL that isn't a Cloudinary delivery
 * URL (GIFs, local previews, other CDNs), so it's safe to wrap any image
 * source with this.
 */
export const getCloudinaryUrl = (
  url: string | undefined | null,
  { width, height, crop, gravity }: CloudinaryTransformOptions,
): string | undefined => {
  if (!url) return url ?? undefined;

  const markerIndex = url.indexOf(CLOUDINARY_UPLOAD_MARKER);
  if (markerIndex === -1) return url;

  // Already has a transformation applied (e.g. re-processed URL) — don't
  // stack a second transformation segment on top of it.
  const afterMarker = url.slice(markerIndex + CLOUDINARY_UPLOAD_MARKER.length);
  const firstSegment = afterMarker.split("/")[0];
  const looksLikeTransform = /(^|,)(w_|h_|c_|g_|q_|f_|dpr_)/.test(firstSegment);
  if (looksLikeTransform) return url;

  const resolvedCrop = crop ?? (height ? "fill" : "limit");
  const segments: string[] = [];
  if (width) segments.push(`w_${Math.round(width)}`);
  if (height) segments.push(`h_${Math.round(height)}`);
  segments.push(`c_${resolvedCrop}`);
  if (gravity) segments.push(`g_${gravity}`);
  segments.push("q_auto", "f_auto", "dpr_auto");

  const transform = segments.join(",");
  return `${url.slice(0, markerIndex + CLOUDINARY_UPLOAD_MARKER.length)}${transform}/${afterMarker}`;
};

/**
 * Small, face-cropped avatar/profile-picture thumbnail. Use for avatars in
 * feeds, comment lists, member lists, headers — anywhere shown small.
 * Default 96px covers up to a ~48pt avatar at 2x density.
 */
export const avatarThumb = (
  url: string | undefined | null,
  size: number = 96,
): string | undefined =>
  getCloudinaryUrl(url, { width: size, height: size, crop: "fill", gravity: "face" });

/**
 * Post/message/poll image sized for feed display. Scales down to fit
 * within the given width without cropping — preserves the original aspect
 * ratio and framing.
 */
export const feedImage = (
  url: string | undefined | null,
  width: number = 900,
): string | undefined => getCloudinaryUrl(url, { width, crop: "limit" });

/**
 * Larger variant for the fullscreen pinch-zoom viewer. Still capped (not
 * the literal original) since even a fullscreen phone view rarely needs
 * more than ~1600px on the long edge, but detail holds up fine when zoomed.
 */
export const fullscreenImage = (
  url: string | undefined | null,
  width: number = 1600,
): string | undefined => getCloudinaryUrl(url, { width, crop: "limit" });
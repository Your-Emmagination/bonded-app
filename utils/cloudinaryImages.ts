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

import { PixelRatio } from "react-native";

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

// Canonical display sizes, shared across every screen instead of each one
// picking its own ad-hoc number. Two things this buys us:
//  1. Far fewer distinct cache keys overall — faster global CDN warm-up,
//     more cross-user cache hits.
//  2. utils/cloudinaryUpload.ts's eager-warming step can pre-generate
//     exactly these sizes right after upload, so real screens always hit
//     an already-warm URL instead of triggering a cold generation.
// If a new avatar/image spot is added later, reuse one of these rather
// than introducing a new one-off size.
export const AVATAR_SIZE_SMALL = 56; // inline/list avatars (feed, comments, members, headers — displayed 32-58px)
export const AVATAR_SIZE_MEDIUM = 80; // chat headers and user previews (displayed 60-80px)
export const AVATAR_SIZE_LARGE = 120; // profile-screen avatars (displayed 104-120px)
export const FEED_IMAGE_WIDTH = 400; // post/poll/message/comment images and GIFs
export const FULLSCREEN_IMAGE_WIDTH = 430; // baseline logical viewport width for the fullscreen viewer

// React Native's Image component doesn't send DPR client hints the way a
// browser <img> does, so Cloudinary's own "dpr_auto" has nothing to key
// off and would just serve 1x. Instead we read the device's actual pixel
// ratio here and bake it into the requested pixel dimensions — callers
// still just pass logical/CSS-like sizes (e.g. 40 for a 40x40 avatar).
// Capped at 3x since anything beyond that is imperceptible and just wastes
// bandwidth.
const scaleForDevice = (px: number): number =>
  Math.round(px * Math.min(PixelRatio.get(), 3));

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
  segments.push("q_auto", "f_auto");

  const transform = segments.join(",");
  return `${url.slice(0, markerIndex + CLOUDINARY_UPLOAD_MARKER.length)}${transform}/${afterMarker}`;
};

/**
 * Small, face-cropped avatar/profile-picture thumbnail. `size` is the
 * logical size the avatar is displayed at (e.g. pass 40 for a 40x40 style)
 * — device pixel ratio is applied automatically. Use for avatars in feeds,
 * comment lists, member lists, headers — anywhere shown small.
 */
export const avatarThumb = (
  url: string | undefined | null,
  size: number = AVATAR_SIZE_SMALL,
): string | undefined => {
  const px = scaleForDevice(size);
  return getCloudinaryUrl(url, { width: px, height: px, crop: "fill", gravity: "face" });
};

/**
 * Post/message/poll image sized for feed display. `width` is the logical
 * display width — device pixel ratio is applied automatically. Scales down
 * to fit within that width without cropping, preserving aspect ratio.
 */
export const feedImage = (
  url: string | undefined | null,
  width: number = FEED_IMAGE_WIDTH,
): string | undefined => getCloudinaryUrl(url, { width: scaleForDevice(width), crop: "limit" });

/**
 * Larger variant for the fullscreen pinch-zoom viewer. `width` is the
 * logical viewport width — device pixel ratio is applied automatically.
 * Still capped (not the literal original) since even a fullscreen phone
 * view rarely needs more than ~1800px on the long edge after DPR scaling,
 * but detail holds up fine when zoomed.
 */
export const fullscreenImage = (
  url: string | undefined | null,
  width: number = FULLSCREEN_IMAGE_WIDTH,
): string | undefined => getCloudinaryUrl(url, { width: scaleForDevice(width), crop: "limit" });

/**
 * Frame-grab thumbnail for a Cloudinary-hosted video (e.g.
 * `.../video/upload/v169.../post_videos/post_video_123.mp4`), used to show a
 * real preview image instead of a blank/generic card wherever a video
 * attachment needs a lightweight, non-playing preview (moderation queue,
 * list rows). Requests the frame at second 0 and delivers it as a JPEG via
 * Cloudinary's video-to-image delivery — no re-upload or extra storage
 * needed, same on-the-fly transform approach as getCloudinaryUrl above.
 *
 * Returns undefined for any URL that isn't a Cloudinary `/video/upload/`
 * delivery URL — callers should treat a missing result the same as a load
 * failure and fall back to a static placeholder (see ManageModerationScreen).
 */
const CLOUDINARY_VIDEO_UPLOAD_MARKER = "/video/upload/";

export const videoThumb = (
  url: string | undefined | null,
  width: number = FEED_IMAGE_WIDTH,
): string | undefined => {
  if (!url) return undefined;
  const markerIndex = url.indexOf(CLOUDINARY_VIDEO_UPLOAD_MARKER);
  if (markerIndex === -1) return undefined;

  const afterMarker = url.slice(markerIndex + CLOUDINARY_VIDEO_UPLOAD_MARKER.length);
  // Swap the video extension for .jpg — Cloudinary serves a still frame when
  // a video public ID is requested through the image-style delivery params.
  const withoutExtension = afterMarker.replace(/\.[a-zA-Z0-9]+$/, "");
  const transform = [`so_0`, `w_${scaleForDevice(width)}`, "c_limit", "q_auto", "f_jpg"].join(",");

  return `${url.slice(0, markerIndex)}${CLOUDINARY_VIDEO_UPLOAD_MARKER}${transform}/${withoutExtension}.jpg`;
};

/**
 * Video-playback quality tiers. Cloudinary re-encodes on the fly from the
 * same URL — same transform-param approach as getCloudinaryUrl above, no
 * separate transcoding pipeline. `q_auto:*` lets Cloudinary pick the codec
 * bitrate for the target perceptual quality; the `w_*,c_limit` cap keeps a
 * 4K source from being delivered at full resolution to a phone.
 */
export type VideoQualityTier = "saver" | "auto" | "high";

export const VIDEO_QUALITY_TIERS: {
  tier: VideoQualityTier;
  label: string;
  hint: string;
}[] = [
  { tier: "saver", label: "Data saver", hint: "Lowest data use — 480p" },
  { tier: "auto", label: "Auto", hint: "Balanced — up to 720p" },
  { tier: "high", label: "High", hint: "Best quality — up to 1080p" },
];

const VIDEO_QUALITY_TRANSFORMS: Record<VideoQualityTier, string> = {
  saver: "q_auto:eco,w_480,c_limit,f_auto",
  auto: "q_auto:good,w_720,c_limit,f_auto",
  high: "q_auto:best,w_1080,c_limit,f_auto",
};

/**
 * Returns a Cloudinary video delivery URL re-encoded for the given quality
 * tier. Non-Cloudinary `/video/upload/` URLs and URLs that already carry a
 * transform segment are returned unchanged, so this is safe to wrap any
 * video source with.
 */
export const videoUrl = (
  url: string | undefined | null,
  tier: VideoQualityTier = "auto",
): string | undefined => {
  if (!url) return url ?? undefined;
  const markerIndex = url.indexOf(CLOUDINARY_VIDEO_UPLOAD_MARKER);
  if (markerIndex === -1) return url;

  const afterMarker = url.slice(markerIndex + CLOUDINARY_VIDEO_UPLOAD_MARKER.length);
  const firstSegment = afterMarker.split("/")[0];
  if (/(^|,)(w_|h_|c_|q_|f_|so_|dpr_)/.test(firstSegment)) return url;

  return `${url.slice(0, markerIndex)}${CLOUDINARY_VIDEO_UPLOAD_MARKER}${VIDEO_QUALITY_TRANSFORMS[tier]}/${afterMarker}`;
};
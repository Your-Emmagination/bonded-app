// utils/cloudinaryUpload.ts
// Centralized Cloudinary upload utility with folder organization

import {
  AVATAR_SIZE_LARGE,
  AVATAR_SIZE_SMALL,
  FEED_IMAGE_WIDTH,
  FULLSCREEN_IMAGE_WIDTH,
  getCloudinaryUrl,
} from "./cloudinaryImages";

const CLOUDINARY_CLOUD_NAME = "dutkd2ih4";
const CLOUDINARY_UPLOAD_PRESET = "bonded_app_preset"; 

export type UploadFolder = "profile_images" | "post_images" | "post_files" | "post_gifs" | "post_videos";

interface CloudinaryUploadOptions {
  uri: string;
  folder: UploadFolder;
  resourceType?: "image" | "raw" | "video" | "auto";
}

/**
 * Upload file to Cloudinary with specific folder organization
 * @param options - Upload configuration
 * @returns Secure URL of uploaded file
 */
export const uploadToCloudinary = async ({
  uri,
  folder,
  resourceType = "auto",
}: CloudinaryUploadOptions): Promise<string> => {
  try {
    // Validate inputs
    if (!uri) {
      throw new Error("File URI is required");
    }

if (!CLOUDINARY_CLOUD_NAME) {
  throw new Error("Cloudinary cloud name not configured.");
}

if (!CLOUDINARY_UPLOAD_PRESET) {
  throw new Error("Cloudinary upload preset not configured.");
}


    const formData = new FormData();
    
    // Determine file type and name based on folder
    const fileName = generateFileName(folder);
    const mimeType = getMimeType(uri, folder);
    
    formData.append("file", {
      uri: uri,
      type: mimeType,
      name: fileName,
    } as any);
    
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    formData.append("folder", folder); // 📁 Sets the Cloudinary folder
    
    // Determine the correct endpoint based on resource type
    const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;

    console.log(`📤 Uploading to Cloudinary: ${folder}/${fileName}`);

    const response = await fetch(endpoint, {
      method: "POST",
      body: formData,
      headers: {
        "Accept": "application/json",
      },
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      const errorMessage = data.error?.message || response.statusText || "Unknown error";
      throw new Error(`Upload failed: ${errorMessage}`);
    }

    console.log(`✅ Upload successful: ${data.secure_url}`);

    // Eagerly warm the CDN cache for the sizes this image will actually be
    // requested at (avatar/feed/fullscreen), so the first viewer never eats
    // the on-the-fly transform cost. Deliberately not awaited — this must
    // never delay the upload response the caller is waiting on.
    warmCloudinaryCache(data.secure_url, folder);

    return data.secure_url;
  } catch (error: any) {
    console.error("❌ Cloudinary upload error:", error.message);
    
    if (error.message.includes("Network request failed")) {
      throw new Error("Network error. Please check your internet connection.");
    }
    if (error.message.includes("Upload preset")) {
      throw new Error("Invalid upload preset. Check your Cloudinary configuration.");
    }
    if (error.message.includes("Invalid image file")) {
      throw new Error("Invalid file format. Please select a valid image.");
    }
    
    throw error;
  }
};

/**
 * Kick off requests for the sizes this image will actually be displayed at,
 * so Cloudinary generates and caches those variants immediately instead of
 * on whoever happens to view the post first. Fire-and-forget by design:
 * failures here should never surface to the user or affect the upload flow,
 * since the original full-size URL already works fine on its own — this is
 * purely a latency optimization for later reads.
 */
// Real devices in the wild are overwhelmingly DPR 2 or DPR 3 (see
// PixelRatio.get() capping in cloudinaryImages.ts). Warming both means any
// viewer's device — regardless of the uploader's own screen density —
// lands on an already-warm URL.
const DPR_MULTIPLIERS = [2, 3];

const warmAvatarSize = (secureUrl: string, logicalSize: number): (string | undefined)[] =>
  DPR_MULTIPLIERS.map((dpr) => {
    const px = Math.round(logicalSize * dpr);
    return getCloudinaryUrl(secureUrl, { width: px, height: px, crop: "fill", gravity: "face" });
  });

const warmFeedSize = (secureUrl: string, logicalWidth: number): (string | undefined)[] =>
  DPR_MULTIPLIERS.map((dpr) =>
    getCloudinaryUrl(secureUrl, { width: Math.round(logicalWidth * dpr), crop: "limit" }),
  );

const warmCloudinaryCache = (secureUrl: string, folder: UploadFolder): void => {
  let urlsToWarm: (string | undefined)[] = [];

  switch (folder) {
    case "profile_images":
      // Profile photos are shown small (feeds/lists, AVATAR_SIZE_SMALL),
      // large (profile screens, AVATAR_SIZE_LARGE), and fullscreen
      // (pinch-zoom viewer, up to 4x — see ImageZoomViewer.tsx). Warming
      // exactly these — the same constants every screen actually calls
      // avatarThumb/fullscreenImage with — is what makes this warming
      // step actually match real requests instead of guessing.
      urlsToWarm = [
        ...warmAvatarSize(secureUrl, AVATAR_SIZE_SMALL),
        ...warmAvatarSize(secureUrl, AVATAR_SIZE_LARGE),
        ...warmFeedSize(secureUrl, FULLSCREEN_IMAGE_WIDTH * 3),
      ];
      break;
    case "post_images":
      // Post photos are shown in-feed and in the fullscreen viewer.
      urlsToWarm = [
        ...warmFeedSize(secureUrl, FEED_IMAGE_WIDTH),
        ...warmFeedSize(secureUrl, FULLSCREEN_IMAGE_WIDTH * 3),
      ];
      break;
    case "post_gifs":
      // GIFs are only ever shown at feed size.
      urlsToWarm = warmFeedSize(secureUrl, FEED_IMAGE_WIDTH);
      break;
    case "post_videos":
      // Videos are streamed directly from the original Cloudinary URL.
      return;
    case "post_files":
      // Non-image files (PDFs, docs, etc.) have no image transforms to warm.
      return;
  }

  urlsToWarm.forEach((url) => {
    if (!url) return;
    // HEAD still makes Cloudinary generate + cache the variant, but skips
    // downloading the response body — the uploader's own connection
    // shouldn't pay for bytes nobody on their device will ever display.
    fetch(url, { method: "HEAD" }).catch(() => {
      // Swallow errors — this is best-effort pre-warming, not a critical path.
    });
  });
};

/**
 * Generate appropriate filename based on folder type
 */
const generateFileName = (folder: UploadFolder): string => {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000);
  
  switch (folder) {
    case "profile_images":
      return `profile_${timestamp}_${random}.jpg`;
    case "post_images":
      return `post_img_${timestamp}_${random}.jpg`;
    case "post_gifs":
      return `post_gif_${timestamp}_${random}.gif`;
    case "post_videos":
      return `post_video_${timestamp}_${random}.mp4`;
    case "post_files":
      return `post_file_${timestamp}_${random}`;
    default:
      return `file_${timestamp}_${random}`;
  }
};

/**
 * Determine MIME type based on URI and folder
 */
const getMimeType = (uri: string, folder: UploadFolder): string => {
  // For profile images, always use jpeg
  if (folder === "profile_images") {
    return "image/jpeg";
  }
  
  // For posts, detect from URI extension
  const extension = uri.split(".").pop()?.toLowerCase();
  
  const mimeTypes: Record<string, string> = {
    // Images
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    
    // Documents
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    
    // Video
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
  };
  
  return mimeTypes[extension || ""] || "application/octet-stream";
};

/**
 * Upload profile image specifically
 * Usage: const url = await uploadProfileImage(imageUri);
 */
export const uploadProfileImage = async (uri: string): Promise<string> => {
  return uploadToCloudinary({
    uri,
    folder: "profile_images",
    resourceType: "image",
  });
};

/**
 * Upload post image specifically
 * Usage: const url = await uploadPostImage(imageUri);
 */
export const uploadPostImage = async (uri: string): Promise<string> => {
  return uploadToCloudinary({
    uri,
    folder: "post_images",
    resourceType: "image",
  });
};

/**
 * Upload post GIF specifically
 * Usage: const url = await uploadPostGif(gifUri);
 */
export const uploadPostGif = async (uri: string): Promise<string> => {
  return uploadToCloudinary({
    uri,
    folder: "post_gifs",
    resourceType: "image",
  });
};

/** Upload a post video to Cloudinary. */
export const uploadPostVideo = async (uri: string): Promise<string> => {
  return uploadToCloudinary({
    uri,
    folder: "post_videos",
    resourceType: "video",
  });
};

/**
 * Upload post file (non-image) specifically
 * Usage: const url = await uploadPostFile(fileUri);
 */
export const uploadPostFile = async (uri: string): Promise<string> => {
  return uploadToCloudinary({
    uri,
    folder: "post_files",
    resourceType: "auto", // Auto-detects file type
  });
};

/**
 * Batch upload multiple post files
 * Usage: const urls = await uploadMultiplePostFiles([{uri: "...", isImage: true}, ...]);
 */
export const uploadMultiplePostFiles = async (
  files: { uri: string; isImage: boolean }[]
): Promise<string[]> => {
  const uploadPromises = files.map((file) =>
    file.isImage ? uploadPostImage(file.uri) : uploadPostFile(file.uri)
  );
  
  return Promise.all(uploadPromises);
};

/**
 * Get file size from URI (useful for validation before upload)
 * Returns size in bytes
 */
export const getFileSize = async (uri: string): Promise<number> => {
  try {
    const response = await fetch(uri);
    const blob = await response.blob();
    return blob.size;
  } catch (error) {
    console.error("Error getting file size:", error);
    return 0;
  }
};

/**
 * Format file size for display
 * Usage: formatFileSize(1024000) → "1.00 MB"
 */
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
};
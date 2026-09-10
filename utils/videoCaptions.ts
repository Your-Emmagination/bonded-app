// Auto-generated speech-to-text captions for feed videos. The transcription
// itself runs server-side in the Cloudflare Worker (Groq Whisper) — the app
// only stores/reads the result and renders the overlay.
//
// A post document with a video carries:
//   captionStatus:   "pending"  -> transcription in flight, no captions yet
//                    "ready"    -> `captions` populated
//                    "unavailable" -> transcription failed / no speech; the
//                                     video is still fully playable
//   captions:        timed segments, ordered by start time
//   captionLanguage: Whisper's auto-detected language (e.g. "en", "tl")

export type CaptionStatus = "pending" | "ready" | "unavailable";

export type CaptionSegment = {
  /** seconds from the start of the video */
  start: number;
  /** seconds from the start of the video */
  end: number;
  text: string;
};

/**
 * The caption line to show at `positionSeconds`, or "" if none. Segments are
 * assumed sorted by `start`; a tiny lookahead keeps a line from flickering
 * out a frame early between back-to-back segments.
 */
export const getActiveCaption = (
  captions: CaptionSegment[] | undefined | null,
  positionSeconds: number,
): string => {
  if (!captions || captions.length === 0) return "";
  const t = positionSeconds + 0.15;
  for (const segment of captions) {
    if (t >= segment.start && t <= segment.end) return segment.text;
    if (segment.start > t) break;
  }
  return "";
};

/** Normalize whatever came back from Firestore into clean CaptionSegments. */
export const normalizeCaptions = (raw: unknown): CaptionSegment[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) => ({
      start: Number(entry?.start) || 0,
      end: Number(entry?.end) || 0,
      text: String(entry?.text || "").trim(),
    }))
    .filter((segment) => segment.text.length > 0)
    .sort((a, b) => a.start - b.start);
};

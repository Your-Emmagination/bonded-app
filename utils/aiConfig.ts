import Constants from "expo-constants";

const DEFAULT_AI_WORKER_URL = "https://bonded-ai-worker.encaboemmz77.workers.dev";
// Python FastAPI server for image/video moderation.
// NOTE: this is a LAN-only dev IP and only works on the same local network as
// that machine. It must NOT be relied on in production builds — always set
// EXPO_PUBLIC_MEDIA_AI_URL (or extra.mediaAiUrl) to a publicly reachable,
// HTTPS URL before shipping, or every image/video will silently fail closed
// to "approved" (see requestImageModeration/requestVideoModeration).
const DEFAULT_MEDIA_AI_URL = "http://192.168.110.100:8000";
const AI_REQUEST_TIMEOUT_MS = 25_000;

type ExtraConfig = {
  aiWorkerUrl?: string;
  mediaAiUrl?: string;
};

const getTrimmedValue = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const getExpoExtra = (): ExtraConfig => {
  const expoConfigExtra = (Constants.expoConfig?.extra ?? {}) as ExtraConfig;
  if (expoConfigExtra.aiWorkerUrl || expoConfigExtra.mediaAiUrl) {
    return expoConfigExtra;
  }

  const manifestExtra = (Constants.manifest2?.extra ?? {}) as ExtraConfig;
  return manifestExtra;
};

export const getAiWorkerUrl = (): string => {
  const envValue = getTrimmedValue(process.env.EXPO_PUBLIC_AI_WORKER_URL);
  if (envValue) return envValue;

  const extraValue = getTrimmedValue(getExpoExtra().aiWorkerUrl);
  if (extraValue) return extraValue;

  return DEFAULT_AI_WORKER_URL;
};

export const getMediaAiUrl = (): string => {
  const envValue = getTrimmedValue(process.env.EXPO_PUBLIC_MEDIA_AI_URL);
  if (envValue) return envValue;

  const extraValue = getTrimmedValue(getExpoExtra().mediaAiUrl);
  if (extraValue) return extraValue;

  return DEFAULT_MEDIA_AI_URL;
};

/** True when the media AI URL is still the LAN-only dev default. */
export const isUsingDefaultMediaAiUrl = (): boolean =>
  getMediaAiUrl() === DEFAULT_MEDIA_AI_URL;

export const getAiConfigDiagnostics = () => {
  const envValue = getTrimmedValue(process.env.EXPO_PUBLIC_AI_WORKER_URL);
  const extraValue = getTrimmedValue(getExpoExtra().aiWorkerUrl);
  const resolvedUrl = getAiWorkerUrl();

  return {
    resolvedUrl,
    source: envValue ? "env" : extraValue ? "expo-extra" : "fallback",
  } as const;
};

export const getMediaAiConfigDiagnostics = () => {
  const envValue = getTrimmedValue(process.env.EXPO_PUBLIC_MEDIA_AI_URL);
  const extraValue = getTrimmedValue(getExpoExtra().mediaAiUrl);
  const resolvedUrl = getMediaAiUrl();

  return {
    resolvedUrl,
    source: envValue ? "env" : extraValue ? "expo-extra" : "fallback",
    isDefaultLanUrl: resolvedUrl === DEFAULT_MEDIA_AI_URL,
  } as const;
};

export const getAiErrorMessage = (error: unknown): string => {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown AI error.";

  if (message.includes("Missing EXPO_PUBLIC_AI_WORKER_URL")) {
    return "Bonded AI is not configured in this build yet. Rebuild the APK after applying the AI worker URL.";
  }

  if (message.includes("aborted") || message.includes(`${AI_REQUEST_TIMEOUT_MS}`)) {
    return "Bonded AI timed out. The worker may be reachable but too slow to answer right now.";
  }

  if (message.includes("Network request failed") || message.includes("Failed to fetch")) {
    return "Bonded AI could not reach the server. Check the APK's internet access and the AI worker URL.";
  }

  if (message.includes("empty reply")) {
    return "Bonded AI responded with an empty message. The worker is reachable, but the upstream model reply failed.";
  }

  return message;
};
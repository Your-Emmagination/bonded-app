// Feed video quality preference — one small process-wide store shared by
// every VideoPostMedia in the feed, so there's a single NetInfo listener and
// a single AsyncStorage read regardless of how many video cards are mounted.
//
// Preference values:
//   "network"  — default: pick per connection each session (cellular ->
//                data saver, wifi/ethernet -> auto). Autoplay video on a
//                metered plan shouldn't quietly pull full-quality bytes, so
//                the safe choice wins when the connection type is unknown.
//   "saver" | "auto" | "high" — a deliberate user override; it sticks.
import { useEffect, useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import type { VideoQualityTier } from "./cloudinaryImages";

export type VideoQualityPreference = "network" | VideoQualityTier;

const STORAGE_KEY = "bonded:videoQualityPreference";

let preference: VideoQualityPreference = "network";
let netType: string | null = null;
let resolvedTier: VideoQualityTier = "saver";
let initialized = false;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const networkDefault = (): VideoQualityTier =>
  netType === "wifi" || netType === "ethernet" ? "auto" : "saver";

const recompute = () => {
  const next = preference === "network" ? networkDefault() : preference;
  if (next !== resolvedTier) {
    resolvedTier = next;
    emit();
  }
};

const ensureInitialized = () => {
  if (initialized) return;
  initialized = true;

  AsyncStorage.getItem(STORAGE_KEY)
    .then((stored) => {
      if (
        stored === "network" ||
        stored === "saver" ||
        stored === "auto" ||
        stored === "high"
      ) {
        preference = stored;
        emit();
        recompute();
      }
    })
    .catch(() => {});

  NetInfo.fetch()
    .then((state) => {
      netType = state.type ?? null;
      recompute();
    })
    .catch(() => {});

  NetInfo.addEventListener((state) => {
    netType = state.type ?? null;
    recompute();
  });
};

/** Persist a new preference and re-resolve the delivered tier. */
export const setVideoQualityPreference = (next: VideoQualityPreference) => {
  preference = next;
  AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  emit();
  recompute();
};

/**
 * `tier` — the concrete quality tier to deliver right now (feed videos build
 * their Cloudinary URL from this). `preference` / `setPreference` drive the
 * in-player quality menu.
 */
export const useVideoQuality = () => {
  useEffect(ensureInitialized, []);
  const tier = useSyncExternalStore(
    subscribe,
    () => resolvedTier,
    () => resolvedTier,
  );
  const pref = useSyncExternalStore(
    subscribe,
    () => preference,
    () => preference,
  );
  return { tier, preference: pref, setPreference: setVideoQualityPreference };
};

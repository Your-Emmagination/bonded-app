export type NotificationSoundId =
  | "default"
  | "chime"
  | "pop"
  | "bubble"
  | "alert"
  | "silent";

export type NotificationSoundOption = {
  id: NotificationSoundId;
  label: string;
  description: string;
  /** Filename (with extension) as bundled via the expo-notifications config plugin. null = no sound. */
  iosFileName: string | null;
  /** Each sound needs its own Android channel — channel sound is fixed at creation time. */
  androidChannelId: string;
  /** require()'d asset for in-app preview playback. null = no preview (silent). */
  previewAsset: number | null;
};

export const DEFAULT_NOTIFICATION_SOUND_ID: NotificationSoundId = "default";

export const NOTIFICATION_SOUND_OPTIONS: NotificationSoundOption[] = [
  {
    id: "default",
    label: "Default",
    description: "Classic two-tone ding",
    iosFileName: "notif_default.wav",
    androidChannelId: "sound_default",
    previewAsset: require("../assets/sounds/notif_default.wav"),
  },
  {
    id: "chime",
    label: "Chime",
    description: "Bright ascending chime",
    iosFileName: "notif_chime.wav",
    androidChannelId: "sound_chime",
    previewAsset: require("../assets/sounds/notif_chime.wav"),
  },
  {
    id: "pop",
    label: "Pop",
    description: "Quick, subtle blip",
    iosFileName: "notif_pop.wav",
    androidChannelId: "sound_pop",
    previewAsset: require("../assets/sounds/notif_pop.wav"),
  },
  {
    id: "bubble",
    label: "Bubble",
    description: "Soft descending pair",
    iosFileName: "notif_bubble.wav",
    androidChannelId: "sound_bubble",
    previewAsset: require("../assets/sounds/notif_bubble.wav"),
  },
  {
    id: "alert",
    label: "Alert",
    description: "Sharp double-beep",
    iosFileName: "notif_alert.wav",
    androidChannelId: "sound_alert",
    previewAsset: require("../assets/sounds/notif_alert.wav"),
  },
  {
    id: "silent",
    label: "Silent",
    description: "Vibration only, no sound",
    iosFileName: null,
    androidChannelId: "sound_silent",
    previewAsset: null,
  },
];

export const getNotificationSoundOption = (
  id?: string | null,
): NotificationSoundOption =>
  NOTIFICATION_SOUND_OPTIONS.find((option) => option.id === id) ||
  NOTIFICATION_SOUND_OPTIONS[0];

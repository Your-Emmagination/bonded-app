import { DeviceEventEmitter, EmitterSubscription } from "react-native";

const APP_TOAST_EVENT = "bonded.appToast.show";

export type AppToastOptions = {
  message: string;
  // Optional button, e.g. "View", that opens `actionHref` when tapped —
  // or, e.g. "Undo", that runs `onAction`.
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
};

export const showAppToast = (options: AppToastOptions) => {
  DeviceEventEmitter.emit(APP_TOAST_EVENT, options);
};

export const subscribeAppToast = (
  listener: (options: AppToastOptions) => void,
): EmitterSubscription => {
  return DeviceEventEmitter.addListener(APP_TOAST_EVENT, listener);
};

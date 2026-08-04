import { DeviceEventEmitter, EmitterSubscription } from "react-native";

const HOME_FEED_SCROLL_TO_TOP_EVENT = "bonded.homeFeed.scrollToTop";

export const emitHomeFeedScrollToTop = () => {
  DeviceEventEmitter.emit(HOME_FEED_SCROLL_TO_TOP_EVENT);
};

export const subscribeHomeFeedScrollToTop = (
  listener: () => void,
): EmitterSubscription => {
  return DeviceEventEmitter.addListener(HOME_FEED_SCROLL_TO_TOP_EVENT, listener);
};

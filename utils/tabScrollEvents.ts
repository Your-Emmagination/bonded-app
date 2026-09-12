import { DeviceEventEmitter, EmitterSubscription } from "react-native";

// Tapping a bottom tab you're already on asks that screen to scroll back to
// the top. The tab bar can't reach a screen's list directly, so it announces
// the tap by route name and the screen listens for its own name.
// HomeScreen has its own event (see homeFeedEvents) because it also flushes
// staged posts and refreshes the feed.
const TAB_SCROLL_TO_TOP_EVENT = "bonded.tab.scrollToTop";

export const emitTabScrollToTop = (tabName: string) => {
  DeviceEventEmitter.emit(TAB_SCROLL_TO_TOP_EVENT, tabName);
};

export const subscribeTabScrollToTop = (
  tabName: string,
  listener: () => void,
): EmitterSubscription =>
  DeviceEventEmitter.addListener(TAB_SCROLL_TO_TOP_EVENT, (name: string) => {
    if (name === tabName) listener();
  });

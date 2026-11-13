// utils/tabBarVisibility.ts
//
// The bottom tab bar slides down out of the way while Home's feed is
// scrolled down, and back up as soon as it's scrolled up. Only Home calls
// these; every other screen always has the bar.
//
// One shared value (0 = shown, 1 = hidden) drives it on the UI thread, so
// the slide stays smooth while the feed is busy drawing posts.
import { Easing, makeMutable, withTiming } from "react-native-reanimated";

export const tabBarHidden = makeMutable(0);

const SLIDE = { duration: 300, easing: Easing.out(Easing.cubic) };
let hidden = false;

/** Slides the bar down. Does nothing if it's already hidden or going. */
export function hideTabBar() {
  if (hidden) return;
  hidden = true;
  tabBarHidden.set(withTiming(1, SLIDE));
}

/** Slides the bar back up. Does nothing if it's already shown or coming. */
export function showTabBar() {
  if (!hidden) return;
  hidden = false;
  tabBarHidden.set(withTiming(0, SLIDE));
}

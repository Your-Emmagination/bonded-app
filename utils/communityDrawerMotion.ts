// utils/communityDrawerMotion.ts
//
// How the Community drawer moves between Home and Community. One shared
// value, openProgress, drives it: 0 is closed (Home), 1 is open. Home's swipe
// drags it open, the drawer's own swipe drags it closed, and a release
// settles it with one spring that carries on at the finger's speed.
//
// Everything here is a worklet, so the gestures run it on the UI thread and
// the drawer follows the finger without waiting for JavaScript. It imports
// nothing, so scripts/test-community-swipe.ts can check the decisions.

/** The spring every open and close settles with. */
export const DRAWER_SPRING = {
  damping: 24,
  stiffness: 260,
  mass: 0.9,
  overshootClamping: true,
} as const;

/** An opening drag released past this (with its fling) opens; otherwise it closes again. */
export const OPEN_COMMIT = 0.34;
/** A closing drag released below this closes; otherwise it springs back open. */
export const CLOSE_COMMIT = 0.66;
/** How much of a release's speed counts toward where it was heading. */
const VELOCITY_PROJECTION = 0.16;

/** Home's opening swipe fails once the finger drifts this far up/down, or this far left. */
const OPEN_FAIL_DY = 12;
const OPEN_FAIL_DX = -8;
/** ...and starts once it's this far right, and this much more right than down. */
const OPEN_ACTIVATE_DX = 10;
const OPEN_ACTIVATE_RATIO = 1.15;

export const clamp01 = (value: number) => {
  "worklet";
  return Math.min(1, Math.max(0, value));
};

/**
 * Home's opening swipe, from how far the finger has moved since it touched
 * down: still deciding, a swipe to Community, or not one (a tap, a leftward
 * drag, vertical scrolling).
 */
export const openSwipeDecision = (dx: number, dy: number): "wait" | "activate" | "fail" => {
  "worklet";
  if (Math.abs(dy) > OPEN_FAIL_DY || dx < OPEN_FAIL_DX) return "fail";
  if (dx > OPEN_ACTIVATE_DX && dx > Math.abs(dy) * OPEN_ACTIVATE_RATIO) return "activate";
  return "wait";
};

/** Where a released drag is heading: where it is, plus a little of its fling. */
export const projectProgress = (progress: number, velocityX: number, travelWidth: number) => {
  "worklet";
  return progress + (velocityX / travelWidth) * VELOCITY_PROJECTION;
};

/** A released opening drag: true to finish opening, false to go back to Home. */
export const openingSettlesOpen = (progress: number, velocityX: number, travelWidth: number) => {
  "worklet";
  return projectProgress(progress, velocityX, travelWidth) > OPEN_COMMIT;
};

/** A released closing drag: true to finish closing, false to spring back open. */
export const closingSettlesClosed = (progress: number, velocityX: number, travelWidth: number) => {
  "worklet";
  return projectProgress(progress, velocityX, travelWidth) < CLOSE_COMMIT;
};

/** The settling spring, starting at the finger's speed (in progress per second). */
export const settleSpring = (velocityX: number, travelWidth: number) => {
  "worklet";
  return { ...DRAWER_SPRING, velocity: velocityX / travelWidth };
};

/** The drawer's position: fully off to the left when closed, in place when open. */
export const drawerTranslateX = (progress: number, drawerWidth: number) => {
  "worklet";
  return -drawerWidth * (1 - progress);
};

/// <reference types="node" />
// The Home ↔ Community swipe decisions (utils/communityDrawerMotion.ts):
// when Home's swipe starts or gives up, where a released or cancelled drag
// settles, and where the drawer sits. The gestures in HomeScreen and
// ServerDrawer call exactly these; this replays finger paths through them.
//
// Run with: npx tsx scripts/test-community-swipe.ts
import assert from "node:assert/strict";
import {
  CLOSE_COMMIT,
  DRAWER_SPRING,
  OPEN_COMMIT,
  clamp01,
  closingSettlesClosed,
  drawerTranslateX,
  openSwipeDecision,
  openingSettlesOpen,
  settleSpring,
} from "../utils/communityDrawerMotion";

const W = 400; // screen and drawer width
let checks = 0;
const check = (fn: () => void) => {
  fn();
  checks += 1;
};

/**
 * Home's opening swipe over a finger path (points after touch-down at 0,0),
 * as HomeScreen runs it: fails for good, activates, or is still waiting when
 * the finger lifts (a tap). A touch that began in horizontal content fails
 * on its first move.
 */
function replayOpening(path: [number, number][], { inCarousel = false } = {}) {
  for (const [dx, dy] of path) {
    if (inCarousel) return "fail";
    const decision = openSwipeDecision(dx, dy);
    if (decision !== "wait") return decision;
  }
  return "never started";
}

// ── Home → Community: what starts it, and what doesn't ──────────────────
check(() => assert.equal(replayOpening([[0, 0], [1, 1]]), "never started", "A tap opens nothing"));
check(() => assert.equal(replayOpening([[2, 5], [3, 13], [30, 14]]), "fail", "Vertical scrolling"));
check(() => assert.equal(replayOpening([[-3, 0], [-9, 1], [40, 0]]), "fail", "A leftward drag"));
check(() => assert.equal(replayOpening([[4, 0], [11, 2]]), "activate", "A clear rightward swipe"));
check(() => assert.equal(openSwipeDecision(11, 10), "wait", "11 right, 10 down: not yet clearly sideways"));
check(() => assert.equal(replayOpening([[11, 10], [25, 11]]), "activate", "…then clearly sideways"));
check(() => assert.equal(openSwipeDecision(10, 0), "wait", "Exactly 10 px isn't past the line"));
check(() => assert.equal(replayOpening([[4, 0], [30, 0]], { inCarousel: true }), "fail", "Started in a carousel: the carousel's"));
check(() => assert.equal(replayOpening([[-30, 0]], { inCarousel: true }), "fail", "…in either direction"));

// ── Releasing an opening drag ───────────────────────────────────────────
check(() => assert.equal(openingSettlesOpen(0.2, 0, W), false, "A short drag goes back to Home"));
check(() => assert.equal(openingSettlesOpen(0.4, 0, W), true, "Past a third: opens"));
check(() => assert.equal(openingSettlesOpen(0.2, 800, W), true, "A short fling right still opens"));
check(() => assert.equal(openingSettlesOpen(0.5, -1000, W), false, "Flung back left: closes"));
// Cancelled after it started (the app is interrupted): settles, never stuck halfway.
check(() => assert.equal(openingSettlesOpen(0.3, 0, W), false));
check(() => assert.equal(openingSettlesOpen(0.36, 0, W), true));
// Following the finger: progress = translationX / screen width, clamped.
check(() => assert.equal(clamp01(120 / W), 0.3));
check(() => assert.equal(clamp01(520 / W), 1));
check(() => assert.equal(clamp01(-20 / W), 0));

// ── Community → Home ────────────────────────────────────────────────────
// progress = clamp(start + translationX / drawer width)
const afterDrag = (start: number, translationX: number) => clamp01(start + translationX / W);
check(() => assert.equal(closingSettlesClosed(afterDrag(1, -80), 0, W), false, "A short drag springs back open"));
check(() => assert.equal(closingSettlesClosed(afterDrag(1, -160), 0, W), true, "Far enough: back to Home"));
check(() => assert.equal(closingSettlesClosed(afterDrag(1, -40), -1200, W), true, "A quick flick left closes"));
check(() => assert.equal(closingSettlesClosed(afterDrag(1, -20), 200, W), false, "Moving back right: stays open"));
check(() => assert.equal(closingSettlesClosed(1, 0, W), false, "Cancelled with no drag: stays open"));
check(() => assert.equal(afterDrag(0.9, 200), 1, "Can't be dragged past open"));

// ── Where it sits, and how it settles ───────────────────────────────────
check(() => assert.equal(drawerTranslateX(0, W), -W, "Closed: fully off the left"));
check(() => assert.equal(drawerTranslateX(1, W), -0, "Open: in place"));
check(() => assert.equal(drawerTranslateX(0.5, W), -W / 2));
check(() => assert.deepEqual(DRAWER_SPRING, { damping: 24, stiffness: 260, mass: 0.9, overshootClamping: true }));
check(() => assert.deepEqual(settleSpring(800, W), { ...DRAWER_SPRING, velocity: 2 }, "Carries on at the finger's speed"));
check(() => assert.equal(OPEN_COMMIT, 0.34));
check(() => assert.equal(CLOSE_COMMIT, 0.66));

console.log(`Community swipe: ${checks} checks passed.`);

// app/(main)/components/BeaOrb.tsx
//
// B.E.A. as a character: the Scholar Orb.
//
// A glowing sphere in the theme's main colour, with a gold orbit and two
// simple eyes. It is drawn rather than loaded from an image so it recolours
// with every theme — maroon in Light, green in Forest Scholar, navy in Campus
// Navy — and stays sharp at any size.
//
// Motion runs on the UI thread through Reanimated, and only where a screen
// asks for it: most copies, like the face beside an old answer, are still
// drawings. Nothing moves at all for somebody who has turned motion off.
import { useThemeColors } from "@/contexts/ThemeContext";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";

export type BeaMood =
  /** Open eyes; floats and blinks when animated. */
  | "idle"
  /** Eyes up and to the side, a slow sway, sparkles. While an answer is on its way. */
  | "thinking"
  /** Smiling eyes and a small hop. An answer has arrived. */
  | "happy"
  /** Head tilted and a "?". It couldn't answer and is handing over to staff. */
  | "unsure";

type BeaOrbProps = {
  /** Width and height, in points. */
  size: number;
  mood?: BeaMood;
  /** Float, blink, glow and orbit. Leave off for copies that should sit still. */
  animated?: boolean;
  /**
   * Tapping makes B.E.A. react: a squash-and-wiggle, a smile and a light
   * vibration. With motion turned off it still smiles and vibrates.
   */
  tappable?: boolean;
  /** Also run on tap, after the reaction starts. Implies `tappable`. */
  onPress?: () => void;
  /** Read by screen readers when tappable. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

// Everything is drawn on a 108-unit square (x 6–114, y 16–124), which holds
// the orb and its orbit. `u` turns units into points for the overlaid pieces.
const VIEW = { x: 6, y: 16, size: 108 };
const VIEW_BOX = `${VIEW.x} ${VIEW.y} ${VIEW.size} ${VIEW.size}`;
const ORB = { cx: 60, cy: 72, r: 37 };
const RING = { cx: 60, cy: 76, rx: 54, ry: 14, tilt: -14 };
const RING_TRANSFORM = `rotate(${RING.tilt} ${RING.cx} ${RING.cy})`;
/** Below this, the glow, sparkles and "?" are too small to read and are left out. */
const COMPACT_BELOW = 48;

const SPARKLES = [
  { x: 16, y: 40, s: 7, offset: 0 },
  { x: 104, y: 50, s: 6, offset: 1 / 3 },
  { x: 98, y: 20, s: 4.5, offset: 2 / 3 },
];

/** Blends two #rrggbb colours; `t` is how far toward the second. */
function mix(from: string, to: string, t: number): string {
  const channels = (hex: string) => {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    const value = match ? parseInt(match[1], 16) : 0;
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const a = channels(from);
  const b = channels(to);
  return `#${a
    .map((channel, index) =>
      Math.round(channel + (b[index] - channel) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export default function BeaOrb({
  size,
  mood = "idle",
  animated = false,
  tappable = false,
  onPress,
  accessibilityLabel = "B.E.A.",
  style,
}: BeaOrbProps) {
  const theme = useThemeColors();
  const reducedMotion = useReducedMotion();
  const moving = animated && !reducedMotion;
  const compact = size < COMPACT_BELOW;
  // Gradient and clip ids must be unique per orb on screen.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const u = size / VIEW.size;

  const colors = useMemo(
    () => ({
      body: theme.primary,
      lit: mix(theme.primary, "#ffffff", 0.58),
      shade: mix(theme.primary, "#000000", 0.28),
      accent: theme.accent,
      // Light in every theme, which is what makes it right for the eyes.
      face: theme.onPrimary,
    }),
    [theme.accent, theme.onPrimary, theme.primary],
  );

  const float = useSharedValue(0);
  const blink = useSharedValue(1);
  const glow = useSharedValue(0.5);
  const orbit = useSharedValue(0.25);
  const sway = useSharedValue(0);
  const twinkle = useSharedValue(0);
  const hop = useSharedValue(0);
  const pop = useSharedValue(moving && mood === "unsure" ? 0 : 1);
  const reaction = useSharedValue(0);

  // ── Tapping ────────────────────────────────────────────────────────────
  // The smile lasts a moment longer than the wiggle, so it is still there
  // when the orb settles.
  const [cheering, setCheering] = useState(false);
  const cheerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (cheerTimerRef.current) clearTimeout(cheerTimerRef.current);
    },
    [],
  );
  const handlePress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setCheering(true);
    if (cheerTimerRef.current) clearTimeout(cheerTimerRef.current);
    cheerTimerRef.current = setTimeout(() => setCheering(false), 950);
    if (!reducedMotion) {
      // `set` rather than `.value =`, which the React Compiler reads as
      // changing something a hook was given.
      reaction.set(0);
      reaction.set(withTiming(1, { duration: 720, easing: Easing.out(Easing.quad) }));
    }
    onPress?.();
  }, [onPress, reaction, reducedMotion]);
  // While it smiles after a tap, the face is the happy one whatever the mood.
  const face: BeaMood = cheering ? "happy" : mood;

  useEffect(() => {
    const all = [float, blink, glow, orbit, sway, twinkle, hop, pop];
    all.forEach(cancelAnimation);

    if (!moving) {
      float.value = 0;
      blink.value = 1;
      glow.value = 0.5;
      orbit.value = 0.25;
      sway.value = 0;
      twinkle.value = 0.3;
      hop.value = 0;
      pop.value = 1;
      return;
    }

    const breathe = { duration: 1400, easing: Easing.inOut(Easing.quad) };
    float.value = withRepeat(withTiming(1, breathe), -1, true);
    glow.value = withRepeat(withTiming(1, { ...breathe, duration: 1600 }), -1, true);
    orbit.value = 0;
    orbit.value = withRepeat(withTiming(1, { duration: 3600, easing: Easing.linear }), -1, false);
    blink.value = withRepeat(
      withSequence(
        withDelay(3800, withTiming(0.08, { duration: 90 })),
        withTiming(1, { duration: 130 }),
      ),
      -1,
      false,
    );

    if (mood === "thinking") {
      sway.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.quad) }), -1, true);
      twinkle.value = 0;
      twinkle.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.linear }), -1, false);
    }
    if (mood === "happy") {
      // One hop as the answer lands; it doesn't repeat.
      hop.value = withSequence(
        withTiming(1, { duration: 220, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 420, easing: Easing.bounce }),
      );
    }
    if (mood === "unsure") {
      pop.value = 0;
      pop.value = withSequence(
        withDelay(150, withTiming(1.12, { duration: 200 })),
        withTiming(1, { duration: 140 }),
      );
    }

    return () => all.forEach(cancelAnimation);
  }, [blink, float, glow, hop, mood, moving, orbit, pop, sway, twinkle]);

  // A tap squashes the orb, springs it up and wiggles it before it settles.
  const floatStyle = useAnimatedStyle(() => {
    const steps = [0, 0.18, 0.45, 0.72, 1];
    const r = reaction.value;
    return {
      transform: [
        {
          translateY:
            -float.value * size * 0.03 -
            hop.value * size * 0.1 +
            interpolate(r, steps, [0, size * 0.03, -size * 0.09, 0, 0]),
        },
        { rotate: `${interpolate(r, steps, [0, -9, 9, -4, 0])}deg` },
        { scaleX: interpolate(r, steps, [1, 1.12, 0.93, 1.03, 1]) },
        { scaleY: interpolate(r, steps, [1, 0.86, 1.09, 0.98, 1]) },
      ],
    };
  });

  // Unsure tilts the head; thinking sways it slightly while it waits.
  const bodyStyle = useAnimatedStyle(() => {
    const angle = mood === "unsure" ? 8 : mood === "thinking" ? -5 + sway.value * 4 : 0;
    return { transform: [{ rotate: `${angle}deg` }] };
  });

  const eyesStyle = useAnimatedStyle(() => {
    const lookX = mood === "thinking" ? -2 : mood === "unsure" ? 2 : 0;
    const lookY = mood === "thinking" ? -4 : mood === "unsure" ? 1 : 0;
    return {
      transform: [{ translateX: lookX * u }, { translateY: lookY * u }, { scaleY: blink.value }],
    };
  });

  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + glow.value * 0.45,
    transform: [{ scale: 0.94 + glow.value * 0.1 }],
  }));

  // A spark travels round the orbit, visible only across the front half.
  const dot = Math.max(2, 3.4 * u);
  const sparkStyle = useAnimatedStyle(() => {
    const angle = orbit.value * Math.PI * 2;
    const ex = RING.rx * Math.cos(angle);
    const ey = RING.ry * Math.sin(angle);
    const tilt = (RING.tilt * Math.PI) / 180;
    const x = RING.cx + ex * Math.cos(tilt) - ey * Math.sin(tilt);
    const y = RING.cy + ex * Math.sin(tilt) + ey * Math.cos(tilt);
    return {
      opacity: Math.min(1, Math.max(0, Math.sin(angle) * 4)),
      transform: [
        { translateX: (x - VIEW.x) * u - dot / 2 },
        { translateY: (y - VIEW.y) * u - dot / 2 },
      ],
    };
  });

  const popStyle = useAnimatedStyle(() => ({
    opacity: pop.value > 0.05 ? 1 : 0,
    transform: [{ scale: pop.value }],
  }));

  const ringWidth = compact ? 4.5 : 2.4;
  const place = (x: number, y: number, w: number, h: number) => ({
    position: "absolute" as const,
    left: (x - VIEW.x) * u,
    top: (y - VIEW.y) * u,
    width: w * u,
    height: h * u,
  });

  const interactive = tappable || !!onPress;

  const orb = (
    <Reanimated.View
      style={[{ width: size, height: size }, floatStyle, interactive ? null : style]}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {!compact && (
        <Reanimated.View style={[StyleSheet.absoluteFill, glowStyle]}>
          <Svg width={size} height={size} viewBox={VIEW_BOX}>
            <Defs>
              <RadialGradient id={`${id}glow`} cx="50%" cy="50%" rx="50%" ry="50%">
                <Stop offset="0.55" stopColor={colors.accent} stopOpacity={0.32} />
                <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={ORB.cx} cy={ORB.cy} r={54} fill={`url(#${id}glow)`} />
          </Svg>
        </Reanimated.View>
      )}

      <Reanimated.View style={[StyleSheet.absoluteFill, bodyStyle]}>
        <Svg width={size} height={size} viewBox={VIEW_BOX}>
          <Defs>
            <RadialGradient id={`${id}fill`} cx="38%" cy="30%" rx="78%" ry="78%" fx="38%" fy="30%">
              <Stop offset="0" stopColor={colors.lit} />
              <Stop offset="0.55" stopColor={colors.body} />
              <Stop offset="1" stopColor={colors.shade} />
            </RadialGradient>
            {/* The half of the orbit that passes in front of the orb. */}
            <ClipPath id={`${id}front`}>
              <Rect x={-10} y={RING.cy} width={140} height={70} transform={RING_TRANSFORM} />
            </ClipPath>
          </Defs>
          <Ellipse
            cx={RING.cx}
            cy={RING.cy}
            rx={RING.rx}
            ry={RING.ry}
            transform={RING_TRANSFORM}
            fill="none"
            stroke={colors.accent}
            strokeOpacity={0.45}
            strokeWidth={ringWidth}
          />
          <Circle cx={ORB.cx} cy={ORB.cy} r={ORB.r} fill={`url(#${id}fill)`} />
          <Ellipse cx={47} cy={55} rx={11} ry={7} transform="rotate(-28 47 55)" fill="#ffffff" opacity={0.26} />
          <G clipPath={`url(#${id}front)`}>
            <Ellipse
              cx={RING.cx}
              cy={RING.cy}
              rx={RING.rx}
              ry={RING.ry}
              transform={RING_TRANSFORM}
              fill="none"
              stroke={colors.accent}
              strokeWidth={ringWidth}
            />
          </G>
        </Svg>

        {face === "happy" ? (
          <View style={place(43, 64, 34, 26)}>
            <Svg width="100%" height="100%" viewBox="43 64 34 26">
              <Path
                d="M45 74 q5.5 -8 11 0 M64 74 q5.5 -8 11 0"
                stroke={colors.face}
                strokeWidth={3.6}
                fill="none"
                strokeLinecap="round"
              />
              <Path d="M53 84 q7 5 14 0" stroke={colors.face} strokeWidth={3} fill="none" strokeLinecap="round" opacity={0.9} />
            </Svg>
          </View>
        ) : (
          <Reanimated.View style={[place(44, 61, 32, 20), eyesStyle]}>
            <Svg width="100%" height="100%" viewBox="44 61 32 20">
              <Rect x={46} y={63} width={9.5} height={16} rx={4.75} fill={colors.face} />
              <Rect x={64.5} y={63} width={9.5} height={16} rx={4.75} fill={colors.face} />
            </Svg>
          </Reanimated.View>
        )}

        {moving && !compact && (
          <Reanimated.View
            style={[
              { position: "absolute", left: 0, top: 0, width: dot, height: dot, borderRadius: dot / 2, backgroundColor: "#ffffff" },
              sparkStyle,
            ]}
          />
        )}
      </Reanimated.View>

      {mood === "thinking" && !compact &&
        SPARKLES.map((sparkle) => (
          <Sparkle
            key={sparkle.offset}
            {...sparkle}
            unit={u}
            color={colors.accent}
            progress={twinkle}
            moving={moving}
          />
        ))}

      {mood === "unsure" && !compact && (
        <Reanimated.View
          style={[
            place(100 - 12.5, 30 - 12.5, 25, 25),
            {
              borderRadius: 12.5 * u,
              borderWidth: Math.max(1.5, 2.5 * u),
              borderColor: colors.accent,
              backgroundColor: colors.face,
              alignItems: "center",
              justifyContent: "center",
            },
            popStyle,
          ]}
        >
          <Text style={{ color: colors.body, fontSize: 17 * u, lineHeight: 20 * u, fontWeight: "800" }}>?</Text>
        </Reanimated.View>
      )}
    </Reanimated.View>
  );

  if (!interactive) return orb;
  return (
    <Pressable
      onPress={handlePress}
      hitSlop={8}
      style={[{ width: size, height: size }, style]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {orb}
    </Pressable>
  );
}

/** One four-point sparkle that twinkles in turn with the other two. */
function Sparkle({
  x,
  y,
  s,
  offset,
  unit,
  color,
  progress,
  moving,
}: {
  x: number;
  y: number;
  s: number;
  offset: number;
  unit: number;
  color: string;
  progress: SharedValue<number>;
  moving: boolean;
}) {
  const sparkleStyle = useAnimatedStyle(() => {
    if (!moving) return { opacity: 0.9, transform: [{ scale: 1 }] };
    const phase = (progress.value + offset) % 1;
    const opacity =
      phase < 0.4 ? phase / 0.4 : phase < 0.7 ? 1 - ((phase - 0.4) / 0.3) * 0.8 : 0.2 * (1 - (phase - 0.7) / 0.3);
    return { opacity, transform: [{ scale: 0.5 + opacity * 0.5 }] };
  });
  const side = s * 2 * unit;
  return (
    <Reanimated.View
      style={[
        { position: "absolute", left: (x - VIEW.x - s) * unit, top: (y - VIEW.y - s) * unit, width: side, height: side },
        sparkleStyle,
      ]}
    >
      <Svg width="100%" height="100%" viewBox="-1 -1 2 2">
        <Path d="M0 -1 Q0 0 1 0 Q0 0 0 1 Q0 0 -1 0 Q0 0 0 -1 Z" fill={color} />
      </Svg>
    </Reanimated.View>
  );
}

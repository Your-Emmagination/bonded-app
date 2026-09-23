// app/(main)/ThemeScreen.tsx
//
// Every theme in one place, reached from Settings' Theme row: the light and
// dark ones in one list, the campus colours in another. Picking one recolours
// the app at once, so the choice is previewed on this screen as it's made.
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/contexts/ThemeContext";
import {
  THEMES,
  THEME_OPTIONS,
  type ResolvedThemeId,
  type ThemeId,
  type ThemeOption,
  type ThemeTokens,
} from "@/utils/theme";

type Styles = ReturnType<typeof makeStyles>;

const THEME_GROUPS: { key: ThemeOption["group"]; label: string }[] = [
  { key: "brightness", label: "LIGHT & DARK" },
  { key: "campus", label: "CAMPUS COLOURS" },
];

/**
 * A theme's square, top to bottom. Light and dark themes show their page,
 * card and gold; campus colours show their top bar, page and gold, since the
 * bar is what changes — so each square reads like a tiny screen.
 */
function swatchBands(id: ResolvedThemeId, group: ThemeOption["group"]): [string, string, string] {
  const tokens = THEMES[id];
  return group === "campus"
    ? [tokens.chrome, tokens.background, tokens.accent]
    : [tokens.background, tokens.surfaceRaised, tokens.accent];
}

const BAND_FLEX = [42, 25, 33];

function SwatchBands({ id, group, styles }: { id: ResolvedThemeId; group: ThemeOption["group"]; styles: Styles }) {
  return (
    <>
      {swatchBands(id, group).map((shade, index) => (
        <View key={index} style={[styles.swatchBand, { flex: BAND_FLEX[index], backgroundColor: shade }]} />
      ))}
    </>
  );
}

function ThemeSwatch({ option, styles }: { option: ThemeOption; styles: Styles }) {
  if (option.id === "system") {
    // Half Light, half Dim: the two themes "Use system" switches between.
    return (
      <View style={[styles.swatch, styles.swatchSplit]}>
        {(["light", "dim"] as const).map((id) => (
          <View key={id} style={styles.swatchHalf}>
            <SwatchBands id={id} group="brightness" styles={styles} />
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.swatch}>
      <SwatchBands id={option.id} group={option.group} styles={styles} />
    </View>
  );
}

/**
 * One theme in its list: its square, name and description, and a round
 * check on the right. Picking one recolours the whole screen at once, so the
 * square gives a small settle and the check grows in — enough to show which
 * tap took, without animating the app.
 */
const ThemeChoiceRow = React.memo(function ThemeChoiceRow({
  option,
  selected,
  showDivider,
  onSelect,
  styles,
  theme,
}: {
  option: ThemeOption;
  selected: boolean;
  showDivider: boolean;
  onSelect: (id: ThemeId) => void;
  styles: Styles;
  theme: ThemeTokens;
}) {
  const settle = useSharedValue(1);
  const check = useSharedValue(selected ? 1 : 0);
  const firstRunRef = useRef(true);
  useEffect(() => {
    check.value = withTiming(selected ? 1 : 0, { duration: 180 });
    // Not on first show: only a row that has just been picked settles.
    if (selected && !firstRunRef.current) {
      settle.value = withSequence(
        withTiming(0.9, { duration: 70 }),
        withTiming(1, { duration: 160 }),
      );
    }
    firstRunRef.current = false;
  }, [check, selected, settle]);

  const swatchStyle = useAnimatedStyle(() => ({ transform: [{ scale: settle.value }] }));
  const checkStyle = useAnimatedStyle(() => ({
    opacity: check.value,
    transform: [{ scale: 0.5 + 0.5 * check.value }],
  }));

  return (
    <>
      {showDivider && <View style={styles.rowDivider} />}
      <Pressable
        onPress={() => onSelect(option.id)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        accessibilityLabel={`${option.label}. ${option.description}`}
      >
        {/* The palette's own colours: a name alone doesn't say what "Dim"
            or "Campus Teal" looks like. */}
        <Reanimated.View style={swatchStyle}>
          <ThemeSwatch option={option} styles={styles} />
        </Reanimated.View>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {option.label}
          </Text>
          <Text style={styles.rowDesc} numberOfLines={2}>
            {option.description}
          </Text>
        </View>
        {/* An empty ring, filled with the check once chosen, so the choice
            doesn't rest on colour alone. */}
        <View style={styles.radio}>
          <Reanimated.View style={[styles.radioFill, checkStyle]}>
            <Ionicons name="checkmark" size={14} color={theme.onPrimary} />
          </Reanimated.View>
        </View>
      </Pressable>
    </>
  );
});

export default function ThemeScreen() {
  const router = useRouter();
  const { choice, resolved, setChoice, colors: theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const groupHint = (group: ThemeOption["group"]) =>
    group === "campus"
      ? "Your school's colours on a light page."
      : choice === "system"
        ? `Following your phone — currently ${resolved === "light" ? "light" : "dark"}.`
        : "Applies to this phone only.";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Back to Settings"
        >
          <Ionicons name="chevron-back" size={24} color={theme.onChrome} />
        </TouchableOpacity>
        <Text style={styles.header}>Theme</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {THEME_GROUPS.map((group) => {
          const options = THEME_OPTIONS.filter((option) => option.group === group.key);
          return (
            <View key={group.key} style={styles.group}>
              <Text style={styles.groupLabel}>{group.label}</Text>
              <Text style={styles.groupHint}>{groupHint(group.key)}</Text>
              <View style={styles.card} accessibilityRole="radiogroup">
                {options.map((option, index) => (
                  <ThemeChoiceRow
                    key={option.id}
                    option={option}
                    selected={choice === option.id}
                    showDivider={index > 0}
                    onSelect={setChoice}
                    styles={styles}
                    theme={theme}
                  />
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    headerBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: c.chrome,
      paddingHorizontal: 12,
      paddingVertical: 16,
    },
    backBtn: { width: 32, alignItems: "flex-start" },
    header: { color: c.onChrome, fontSize: 18, fontWeight: "700" },
    content: { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 32 },
    group: { marginBottom: 20 },
    // The same headings and gold card as Settings, so this screen reads as
    // part of it.
    groupLabel: {
      color: c.textSecondary,
      fontWeight: "700",
      fontSize: 12,
      letterSpacing: 0.5,
      marginBottom: 4,
    },
    groupHint: { color: c.textMuted, fontSize: 12, marginBottom: 10 },
    card: {
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 2,
      borderColor: c.accent,
      paddingHorizontal: 14,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 5,
      elevation: 3,
    },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
    rowPressed: { opacity: 0.75 },
    rowDivider: { height: 1, backgroundColor: c.border },
    swatch: {
      width: 38,
      height: 38,
      borderRadius: 10,
      overflow: "hidden",
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    swatchSplit: { flexDirection: "row" },
    swatchHalf: { flex: 1 },
    swatchBand: { width: "100%" },
    rowText: { flex: 1, minWidth: 0 },
    rowLabel: { color: c.textPrimary, fontSize: 15, fontWeight: "700" },
    rowDesc: { color: c.textMuted, fontSize: 12, lineHeight: 16, marginTop: 2 },
    radio: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: c.borderStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    // Sits over the ring, border included, when chosen.
    radioFill: {
      position: "absolute",
      top: -2,
      left: -2,
      right: -2,
      bottom: -2,
      borderRadius: 11,
      backgroundColor: c.primary,
      alignItems: "center",
      justifyContent: "center",
    },
  });

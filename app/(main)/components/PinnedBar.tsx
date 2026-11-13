// app/(main)/components/PinnedBar.tsx
//
// The slim "Pinned · Important Announcements" bar at the top of Home. It
// says how many things are pinned, flags any ending within a day, and shows
// a dot for pins this person hasn't opened yet. Tapping it opens the Pinned
// page. Home hides it when nothing is pinned.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type PinnedBarProps = {
  count: number;
  /** How many end within a day, and when the first of them does. */
  urgentCount: number;
  soonestEndsAtMs: number | null;
  hasUnseen: boolean;
  onPress: () => void;
};

const urgentLabel = (count: number, endsAtMs: number | null) => {
  const hours = endsAtMs === null ? 0 : Math.floor((endsAtMs - Date.now()) / (60 * 60 * 1000));
  return `${count} ending in ${hours < 1 ? "< 1h" : `${hours}h`}`;
};

function PinnedBar({ count, urgentCount, soonestEndsAtMs, hasUnseen, onPress }: PinnedBarProps) {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <TouchableOpacity
      style={styles.bar}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`Pinned, ${count} important announcement${count === 1 ? "" : "s"}${
        urgentCount > 0 ? `, ${urgentLabel(urgentCount, soonestEndsAtMs)}` : ""
      }${hasUnseen ? ", new" : ""}. Open.`}
    >
      <View style={styles.icon}>
        <Ionicons name="pin" size={16} color={theme.accent} />
        {hasUnseen && <View style={styles.dot} />}
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Pinned · {count}</Text>
          <View style={styles.label}>
            <Ionicons name="megaphone-outline" size={11} color={theme.primary} />
            <Text style={styles.labelText} numberOfLines={1}>Important Announcements</Text>
          </View>
        </View>
        {urgentCount > 0 ? (
          <View style={styles.urgent}>
            <Ionicons name="alert-circle" size={12} color={theme.danger} />
            <Text style={styles.urgentText}>{urgentLabel(urgentCount, soonestEndsAtMs)}</Text>
          </View>
        ) : (
          <Text style={styles.hint}>Tap to see them all</Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
    </TouchableOpacity>
  );
}

export default React.memo(PinnedBar);

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    bar: {
      marginHorizontal: 12,
      marginTop: 10,
      marginBottom: 6,
      paddingVertical: 11,
      paddingHorizontal: 12,
      borderRadius: 16,
      backgroundColor: c.surfaceRaised,
      borderWidth: 1,
      borderColor: c.border,
      flexDirection: "row",
      alignItems: "center",
      gap: 11,
      shadowColor: c.primary,
      shadowOpacity: 0.08,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 2,
    },
    icon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: c.accentSoft,
      alignItems: "center",
      justifyContent: "center",
    },
    dot: {
      position: "absolute",
      top: 0,
      right: 0,
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: c.danger,
      borderWidth: 2,
      borderColor: c.surfaceRaised,
    },
    body: { flex: 1, minWidth: 0, gap: 4 },
    titleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
    title: { color: c.textPrimary, fontSize: 14.5, fontWeight: "800" },
    label: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: c.accentSoft,
      flexShrink: 1,
    },
    labelText: { color: c.primary, fontSize: 11, fontWeight: "700", flexShrink: 1 },
    urgent: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
      backgroundColor: c.dangerSoft,
    },
    urgentText: { color: c.danger, fontSize: 11.5, fontWeight: "700" },
    hint: { color: c.textMuted, fontSize: 12 },
  });

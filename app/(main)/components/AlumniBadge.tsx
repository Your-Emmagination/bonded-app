// app/(main)/components/AlumniBadge.tsx
//
// Marks an account whose year level has reached "Graduated".
//
// This is a label, not a restriction. Alumni keep every capability a current
// student has — they can be mentioned, messaged, searched and tagged exactly
// as before. The badge exists so the person doing the mentioning knows who
// they are reaching, and so a graduating class stops being indistinguishable
// from the students still on campus.
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { ALUMNI_LABEL, isAlumni } from "@/utils/yearLevels";

type AlumniBadgeProps = {
  /** The account's raw yearlvl value. Anything that isn't "Graduated" renders nothing. */
  yearlvl?: unknown;
  /** "sm" for dense rows (mention picker, user cards), "md" for profile headers. */
  size?: "sm" | "md";
};

function AlumniBadgeComponent({ yearlvl, size = "sm" }: AlumniBadgeProps) {
  if (!isAlumni(yearlvl)) return null;

  const small = size === "sm";

  return (
    <View style={[styles.badge, small ? styles.badgeSm : styles.badgeMd]}>
      <Ionicons name="ribbon" size={small ? 10 : 12} color="#6e4aa3" />
      <Text style={[styles.text, small ? styles.textSm : styles.textMd]}>
        {ALUMNI_LABEL}
      </Text>
    </View>
  );
}

// Rendered inside virtualized rows (the mention picker, the managed user
// list), so a shallow compare keeps it out of every parent re-render.
const AlumniBadge = React.memo(AlumniBadgeComponent);

export default AlumniBadge;

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f1ebfa",
    borderRadius: 999,
  },
  badgeSm: { gap: 3, paddingHorizontal: 7, paddingVertical: 2.5 },
  badgeMd: { gap: 4, paddingHorizontal: 10, paddingVertical: 4 },
  text: { color: "#6e4aa3", fontWeight: "900" },
  textSm: { fontSize: 10 },
  textMd: { fontSize: 11.5 },
});

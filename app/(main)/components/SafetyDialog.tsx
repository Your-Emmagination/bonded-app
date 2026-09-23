// components/SafetyDialog.tsx
//
// Shown when moderation detects self-harm or suicidal content in something a
// student tried to post. This is the one dialog in BondEd that isn't really
// about the content — it's about the person — so it deliberately breaks from
// the usual pattern:
//
//   - No red. Red is the app's destructive/error colour, and this student
//     hasn't done anything wrong; a warm rose accent carries concern instead.
//   - The loudest line is "reach out to a trusted adult", not "your post was
//     blocked". The moderation outcome is secondary and set small.
//   - Tapping the backdrop does nothing, so it can't be flicked away by
//     accident mid-sentence. The Android back button still closes it — a
//     dialog nobody can dismiss is a trap, not a kindness.
//
// Used by Create Post, Create Poll, the server channel, comments and replies
// so the same words reach a student wherever they were typing.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { SELF_HARM_SAFETY_MESSAGE, SELF_HARM_TRUSTED_ADULT_MESSAGE } from "@/utils/contentModeration";

// Shown as tap-to-call rows. Swap these for the school's own guidance office
// number if that is the first contact you want students to reach.
const HELPLINES: { label: string; detail: string; number: string }[] = [
  { label: "Emergency", detail: "911", number: "911" },
  { label: "NCMH Crisis Hotline", detail: "1553 · toll-free landline", number: "1553" },
];

export type SafetyDialogProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * What the student was writing — "post", "poll", "comment", "reply" or
   * "message". Only used to word the secondary line.
   */
  contentLabel?: string;
};

const SafetyDialog: React.FC<SafetyDialogProps> = ({
  visible,
  onClose,
  contentLabel = "message",
}) => {
  const { styles, theme } = useStyles();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconCircle}>
            <Ionicons name="heart-outline" size={28} color={ACCENT} />
          </View>

          <Text style={styles.title}>You&rsquo;re not alone</Text>

          <Text style={styles.primaryMessage}>{SELF_HARM_TRUSTED_ADULT_MESSAGE}</Text>

          <Text style={styles.secondaryMessage}>
            Your {contentLabel} wasn&rsquo;t posted. {SELF_HARM_SAFETY_MESSAGE}
          </Text>

          <View style={styles.helpSection}>
            <Text style={styles.helpHeading}>If you need help right now</Text>
            {HELPLINES.map((line) => (
              <Pressable
                key={line.number}
                style={({ pressed }) => [styles.helpRow, pressed && styles.helpRowPressed]}
                onPress={() => {
                  Linking.openURL(`tel:${line.number}`).catch(() => {
                    // A device with no dialer (tablet, emulator) shouldn't throw
                    // an error at someone in this moment — the number is on
                    // screen either way.
                  });
                }}
                accessibilityRole="button"
                accessibilityLabel={`Call ${line.label} at ${line.number}`}
              >
                <Ionicons name="call-outline" size={16} color={ACCENT} />
                <View style={styles.helpTextWrap}>
                  <Text style={styles.helpLabel}>{line.label}</Text>
                  <Text style={styles.helpDetail}>{line.detail}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
              </Pressable>
            ))}
          </View>

          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={onClose}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>OK</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

const ACCENT = "#9c5a6d";

/** Themed stylesheet for this component. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: c.scrim,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: c.surface,
    borderRadius: 20,
    paddingTop: 24,
    paddingHorizontal: 20,
    paddingBottom: 18,
    alignItems: "center",
    borderWidth: 1,
    borderColor: c.border,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(156,90,109,0.12)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 14,
  },
  title: {
    color: c.textPrimary,
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
  },
  primaryMessage: {
    color: c.textPrimary,
    fontSize: 15.5,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 20,
    marginTop: 10,
  },
  secondaryMessage: {
    color: c.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
    marginTop: 10,
  },
  helpSection: {
    width: "100%",
    marginTop: 20,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: c.border,
    gap: 8,
  },
  helpHeading: {
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  helpRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: c.surfaceSunken,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  helpRowPressed: { opacity: 0.75 },
  helpTextWrap: { flex: 1, minWidth: 0 },
  helpLabel: { color: c.textPrimary, fontSize: 14, fontWeight: "600" },
  helpDetail: { color: c.textMuted, fontSize: 12, marginTop: 1 },
  button: {
    width: "100%",
    height: 46,
    borderRadius: 12,
    backgroundColor: ACCENT,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 20,
  },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: c.onPrimary, fontSize: 15, fontWeight: "700" },
});

export default SafetyDialog;

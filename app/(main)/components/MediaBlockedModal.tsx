// app/(main)/components/MediaBlockedModal.tsx
//
// Shown when a photo or video in a DM breaks the rules and was not sent.
// Red from top to bottom on purpose: this isn't a question or a warning to
// weigh, it's a stop.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";

const BLOCK_RED = "#c62828";
const BLOCK_RED_DARK = "#8e1c1c";

type MediaBlockedModalProps = {
  visible: boolean;
  kind: "image" | "video";
  /** What was found, e.g. "Nudity", "Weapon". */
  labels: string[];
  selfHarm: boolean;
  onClose: () => void;
};

export default function MediaBlockedModal({ visible, kind, labels, selfHarm, onClose }: MediaBlockedModalProps) {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const noun = kind === "video" ? "video" : "photo";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.card} onPress={() => undefined} accessibilityRole="alert">
          <View style={styles.banner}>
            <View style={styles.iconRing}>
              <Ionicons name="ban" size={34} color="#fff" />
            </View>
            <Text style={styles.title}>{kind === "video" ? "Video blocked" : "Photo blocked"}</Text>
            <Text style={styles.subtitle}>This {noun} was not sent.</Text>
          </View>

          <View style={styles.body}>
            {labels.length > 0 && (
              <View style={styles.labels}>
                {labels.map((label) => (
                  <View key={label} style={styles.labelChip}>
                    <Ionicons name="alert-circle" size={13} color={BLOCK_RED} />
                    <Text style={styles.labelText}>{label}</Text>
                  </View>
                ))}
              </View>
            )}
            <Text style={styles.message}>
              {"BondED doesn't allow photos or videos with nudity, violence, weapons, drugs or hate symbols, even in private messages."}
            </Text>
            {selfHarm && (
              <Text style={styles.care}>
                {"If you're going through something hard, you don't have to handle it alone. The guidance office is there to listen."}
              </Text>
            )}
            <TouchableOpacity style={styles.button} onPress={onClose} accessibilityRole="button" activeOpacity={0.85}>
              <Text style={styles.buttonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: c.scrim,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 360,
      borderRadius: 22,
      overflow: "hidden",
      backgroundColor: c.surface,
      borderWidth: 2,
      borderColor: BLOCK_RED,
    },
    banner: {
      backgroundColor: BLOCK_RED,
      alignItems: "center",
      paddingTop: 22,
      paddingBottom: 18,
      paddingHorizontal: 20,
    },
    iconRing: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: BLOCK_RED_DARK,
      borderWidth: 3,
      borderColor: "rgba(255,255,255,0.35)",
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 12,
    },
    title: { color: "#fff", fontSize: 20, fontWeight: "800" },
    subtitle: { color: "rgba(255,255,255,0.9)", fontSize: 14, marginTop: 4 },
    body: { padding: 20, gap: 12 },
    labels: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    labelChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: c.isDark ? "rgba(198,40,40,0.22)" : "#fdecea",
    },
    labelText: { color: c.isDark ? "#ff8a80" : BLOCK_RED, fontSize: 12.5, fontWeight: "700" },
    message: { color: c.textPrimary, fontSize: 14, lineHeight: 20 },
    care: { color: c.textMuted, fontSize: 13, lineHeight: 19 },
    button: {
      marginTop: 4,
      backgroundColor: BLOCK_RED,
      borderRadius: 12,
      paddingVertical: 13,
      alignItems: "center",
    },
    buttonText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  });

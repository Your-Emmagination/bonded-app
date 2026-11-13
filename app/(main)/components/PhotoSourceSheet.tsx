// app/(main)/components/PhotoSourceSheet.tsx
//
// "Change profile photo": take one with the camera or choose one from the
// gallery. Opened from the camera button on your profile photo.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type PhotoSourceSheetProps = {
  visible: boolean;
  onSelect: (useCamera: boolean) => void;
  onClose: () => void;
};

export default function PhotoSourceSheet({ visible, onSelect, onClose }: PhotoSourceSheetProps) {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const insets = useSafeAreaInsets();

  const options: { useCamera: boolean; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { useCamera: true, label: "Take photo", icon: "camera-outline" },
    { useCamera: false, label: "Choose from gallery", icon: "images-outline" },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Cancel" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
          <View style={styles.handle} />
          <Text style={styles.title}>Change profile photo</Text>
          {options.map((option) => (
            <TouchableOpacity
              key={option.label}
              style={styles.option}
              onPress={() => onSelect(option.useCamera)}
              activeOpacity={0.75}
              accessibilityRole="button"
            >
              <View style={styles.optionIcon}>
                <Ionicons name={option.icon} size={20} color={theme.primary} />
              </View>
              <Text style={styles.optionLabel}>{option.label}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.cancel} onPress={onClose} activeOpacity={0.75} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: c.scrim },
    sheet: {
      backgroundColor: c.surfaceRaised,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      paddingTop: 10,
      paddingHorizontal: 16,
    },
    handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: c.borderStrong, marginBottom: 12 },
    title: { color: c.textPrimary, fontSize: 16, fontWeight: "800", marginBottom: 6 },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    optionIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.accentSoft,
      alignItems: "center",
      justifyContent: "center",
    },
    optionLabel: { color: c.textPrimary, fontSize: 15, fontWeight: "700" },
    cancel: {
      marginTop: 8,
      paddingVertical: 12,
      borderRadius: 12,
      alignItems: "center",
      backgroundColor: c.surfaceSunken,
    },
    cancelText: { color: c.textSecondary, fontSize: 14.5, fontWeight: "700" },
  });

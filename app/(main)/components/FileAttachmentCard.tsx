import { useThemeColors } from "@/contexts/ThemeContext";
import { formatFileSize } from "@/utils/cloudinaryUpload";
import { getFileIconDetails } from "@/utils/fileTypeHelper";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

export type FileAttachmentCardFile = {
  url?: string;
  name?: string;
  mimeType?: string;
  size?: number;
};

export default function FileAttachmentCard({
  file,
  onPress,
  onLongPress,
  disabled = false,
}: {
  file: FileAttachmentCardFile;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
}) {
  const theme = useThemeColors();
  const name = file.name?.trim() || "Attachment";
  const details = getFileIconDetails(file.mimeType || "", name);
  const subtitle = useMemo(() => {
    if (typeof file.size === "number" && file.size > 0) return formatFileSize(file.size);
    return `${details.badge} file`;
  }, [details.badge, file.size]);

  return (
    <Pressable
      style={({ pressed }) => [styles.card, { backgroundColor: theme.surfaceSunken, borderColor: theme.border }, pressed && styles.pressed]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${subtitle}`}
    >
      <View style={[styles.icon, { backgroundColor: `${details.color}18` }]}>
        <Ionicons name={details.icon} size={22} color={details.color} />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.name, { color: theme.textPrimary }]} numberOfLines={1}>{name}</Text>
        <Text style={[styles.meta, { color: theme.textMuted }]} numberOfLines={1}>{subtitle}</Text>
      </View>
      <Ionicons name="open-outline" size={17} color={theme.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minWidth: 210,
    maxWidth: 300,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 4,
    marginBottom: 3,
  },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, minWidth: 0 },
  name: { fontSize: 13.5, fontWeight: "700" },
  meta: { marginTop: 2, fontSize: 11.5, fontWeight: "500" },
  pressed: { opacity: 0.78 },
});

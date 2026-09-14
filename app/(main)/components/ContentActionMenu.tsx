import { useMemo } from "react";
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import React from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

type ActionItem = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  destructive?: boolean;
};

type Props = {
  visible: boolean;
  title: string;
  actions: ActionItem[];
  onClose: () => void;
};

const ContentActionMenu: React.FC<Props> = ({ visible, title, actions, onClose }) => {
  const { styles, theme } = useStyles();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={styles.card} onStartShouldSetResponder={() => true}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.closeButton}>
              <Ionicons name="close" size={20} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={styles.divider} />

          {actions.map((action, index) => (
            <React.Fragment key={`${action.label}-${index}`}>
              <TouchableOpacity
                style={styles.actionItem}
                activeOpacity={0.75}
                onPress={action.onPress}
              >
                <View style={[styles.iconBox, action.destructive && styles.iconBoxDestructive]}>
                  <Ionicons
                    name={action.icon}
                    size={19}
                    color={action.destructive ? theme.danger : theme.textMuted}
                  />
                </View>
                <Text style={[styles.actionText, action.destructive && styles.actionTextDestructive]}>
                  {action.label}
                </Text>
              </TouchableOpacity>
              {index < actions.length - 1 && <View style={styles.itemDivider} />}
            </React.Fragment>
          ))}

          <View style={styles.divider} />
          <TouchableOpacity style={styles.cancelItem} activeOpacity={0.75} onPress={onClose}>
            <Ionicons name="close-circle-outline" size={19} color={theme.textMuted} />
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.48)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 390,
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  header: {
    minHeight: 54,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { color: c.textPrimary, fontSize: 17, fontWeight: "700" },
  closeButton: { padding: 4 },
  divider: { height: 1, backgroundColor: c.border },
  itemDivider: { height: 1, backgroundColor: c.border, marginLeft: 58 },
  actionItem: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  iconBox: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: c.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  iconBoxDestructive: { backgroundColor: c.dangerSoft },
  actionText: { flex: 1, color: c.textPrimary, fontSize: 14.5, fontWeight: "600" },
  actionTextDestructive: { color: c.primary },
  cancelItem: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  cancelText: { color: c.textMuted, fontSize: 14, fontWeight: "600" },
});

export default ContentActionMenu;

/** Themed stylesheet for this file. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

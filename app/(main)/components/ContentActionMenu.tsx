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
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={styles.card} onStartShouldSetResponder={() => true}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.closeButton}>
              <Ionicons name="close" size={20} color="#8f6a60" />
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
                    color={action.destructive ? "#a61f1f" : "#8f6a60"}
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
            <Ionicons name="close-circle-outline" size={19} color="#8f6a60" />
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
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
    backgroundColor: "#fffaf7",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#eadbd4",
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
  title: { color: "#4d1b17", fontSize: 17, fontWeight: "700" },
  closeButton: { padding: 4 },
  divider: { height: 1, backgroundColor: "#eadbd4" },
  itemDivider: { height: 1, backgroundColor: "#f0e7e2", marginLeft: 58 },
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
    backgroundColor: "#f6eee9",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  iconBoxDestructive: { backgroundColor: "#fbeaea" },
  actionText: { flex: 1, color: "#4d1b17", fontSize: 14.5, fontWeight: "600" },
  actionTextDestructive: { color: "#a61f1f" },
  cancelItem: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  cancelText: { color: "#8f6a60", fontSize: 14, fontWeight: "600" },
});

export default ContentActionMenu;

// components/ConfirmDialog.tsx
// Reusable confirmation dialog for destructive/important actions across BondEd.
// Matches the app's existing cream/maroon visual language so it drops into any
// screen (comments, posts, events, admin user management, etc.) without
// needing bespoke Alert.alert() calls scattered throughout the codebase.
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import {
    ActivityIndicator,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";

export type ConfirmDialogProps = {
  visible: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  /** Styles the confirm button as a destructive (red) action. Defaults to true. */
  destructive?: boolean;
  /** Shows a spinner on the confirm button and disables both buttons. */
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional icon shown above the title. Defaults to a warning icon for destructive dialogs. */
  icon?: keyof typeof Ionicons.glyphMap;
  /**
   * Shows a single dismiss button instead of a Cancel/Confirm pair — for
   * informational dialogs (e.g. "this couldn't be posted") where there's
   * nothing to actually confirm or cancel, just acknowledge.
   */
  singleAction?: boolean;
};

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  visible,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  destructive = true,
  loading = false,
  onConfirm,
  onCancel,
  icon,
  singleAction = false,
}) => {
  const resolvedIcon = icon ?? (destructive ? "warning-outline" : "help-circle-outline");

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => {
        if (!loading) onCancel();
      }}
    >
      <Pressable
        style={styles.backdrop}
        onPress={() => {
          if (!loading) onCancel();
        }}
      >
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <View
            style={[
              styles.iconCircle,
              destructive ? styles.iconCircleDestructive : styles.iconCircleNeutral,
            ]}
          >
            <Ionicons
              name={resolvedIcon}
              size={26}
              color={destructive ? "#b3261e" : "#e0a53d"}
            />
          </View>

          <Text style={styles.title}>{title}</Text>
          {!!description && <Text style={styles.description}>{description}</Text>}

          <View style={styles.buttonRow}>
            {!singleAction && (
              <TouchableOpacity
                style={[styles.button, styles.cancelButton]}
                onPress={onCancel}
                disabled={loading}
                activeOpacity={0.75}
              >
                <Text style={styles.cancelButtonText}>{cancelText}</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[
                styles.button,
                destructive ? styles.confirmButtonDestructive : styles.confirmButtonNeutral,
                loading && styles.buttonDisabled,
              ]}
              onPress={onConfirm}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#fffaf7" />
              ) : (
                <Text style={styles.confirmButtonText}>{confirmText}</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 28,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fffaf7",
    borderRadius: 18,
    paddingTop: 22,
    paddingHorizontal: 20,
    paddingBottom: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  iconCircleDestructive: { backgroundColor: "rgba(179,38,30,0.12)" },
  iconCircleNeutral: { backgroundColor: "rgba(224,165,61,0.16)" },
  title: {
    color: "#4d1b17",
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
  },
  description: {
    color: "#9b766c",
    fontSize: 14,
    textAlign: "center",
    marginTop: 6,
    lineHeight: 20,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 20,
    width: "100%",
  },
  button: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  cancelButton: {
    backgroundColor: "#f5efeb",
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  cancelButtonText: { color: "#5f0909", fontSize: 15, fontWeight: "600" },
  confirmButtonDestructive: { backgroundColor: "#b3261e" },
  confirmButtonNeutral: { backgroundColor: "#e0a53d" },
  confirmButtonText: { color: "#fffaf7", fontSize: 15, fontWeight: "700" },
  buttonDisabled: { opacity: 0.7 },
});

export default ConfirmDialog;
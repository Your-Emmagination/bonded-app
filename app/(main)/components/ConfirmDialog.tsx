// components/ConfirmDialog.tsx
// Reusable confirmation dialog for destructive/important actions across BondEd.
// Matches the app's existing cream/maroon visual language so it drops into any
// screen (comments, posts, events, admin user management, etc.) without
// needing bespoke Alert.alert() calls scattered throughout the codebase.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import {
    ActivityIndicator,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";

export type ConfirmDialogVariant = "success" | "info" | "warning" | "destructive";

export type ConfirmDialogProps = {
  visible: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  secondaryText?: string;
  onSecondary?: () => void;
  /** Styles the confirm button as a destructive (red) action. Defaults to true for backwards compatibility. */
  destructive?: boolean;
  /** Optional semantic visual style. Takes precedence over `destructive` when provided. */
  variant?: ConfirmDialogVariant;
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
  secondaryText,
  onSecondary,
  destructive = true,
  variant,
  loading = false,
  onConfirm,
  onCancel,
  icon,
  singleAction = false,
}) => {
  const { styles, theme: palette } = useStyles();
  const resolvedVariant: ConfirmDialogVariant = variant ?? (destructive ? "destructive" : "info");
  const variantTheme: Record<
    ConfirmDialogVariant,
    { icon: keyof typeof Ionicons.glyphMap; accent: string; iconBackground: string }
  > = {
    success: {
      icon: "checkmark-circle-outline",
      accent: palette.success,
      iconBackground: palette.successSoft,
    },
    info: {
      icon: "information-circle-outline",
      accent: palette.accent,
      iconBackground: palette.accentSoft,
    },
    warning: {
      icon: "warning-outline",
      accent: palette.warning,
      iconBackground: palette.accentSoft,
    },
    destructive: {
      icon: "alert-circle-outline",
      accent: palette.danger,
      iconBackground: palette.dangerSoft,
    },
  };
  const theme = variantTheme[resolvedVariant];
  const resolvedIcon = icon ?? theme.icon;

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
            style={[styles.iconCircle, { backgroundColor: theme.iconBackground }]}
          >
            <Ionicons
              name={resolvedIcon}
              size={26}
              color={theme.accent}
            />
          </View>

          <Text
            style={[
              styles.title,
              resolvedVariant === "success" && { color: theme.accent },
            ]}
          >
            {title}
          </Text>
          {!!description && <Text style={styles.description}>{description}</Text>}

          <View style={[styles.buttonRow, !!secondaryText && styles.buttonColumn]}>
            {!!secondaryText && !!onSecondary && (
              <TouchableOpacity
                style={[styles.button, styles.buttonFull, styles.secondaryButton]}
                onPress={onSecondary}
                disabled={loading}
                activeOpacity={0.75}
              >
                <Ionicons name="trash-outline" size={17} color={palette.danger} />
                <Text style={styles.secondaryButtonText}>{secondaryText}</Text>
              </TouchableOpacity>
            )}
            {!singleAction && (
              <TouchableOpacity
                style={[styles.button, !!secondaryText && styles.buttonFull, styles.cancelButton]}
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
                !!secondaryText && styles.buttonFull,
                { backgroundColor: theme.accent },
                loading && styles.buttonDisabled,
              ]}
              onPress={onConfirm}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator size="small" color={palette.onPrimary} />
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
    borderRadius: 18,
    paddingTop: 22,
    paddingHorizontal: 20,
    paddingBottom: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: c.border,
  },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  title: {
    color: c.textPrimary,
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
  },
  description: {
    color: c.textMuted,
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
  buttonColumn: { flexDirection: "column" },
  buttonFull: { flex: 0, width: "100%" },
  secondaryButton: {
    flexDirection: "row",
    gap: 7,
    backgroundColor: c.dangerSoft,
    borderWidth: 1,
    borderColor: c.danger,
  },
  secondaryButtonText: { color: c.danger, fontSize: 14.5, fontWeight: "700" },
  cancelButton: {
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  cancelButtonText: { color: c.primary, fontSize: 15, fontWeight: "600" },
  confirmButtonText: { color: c.onPrimary, fontSize: 15, fontWeight: "700" },
  buttonDisabled: { opacity: 0.7 },
});

export default ConfirmDialog;

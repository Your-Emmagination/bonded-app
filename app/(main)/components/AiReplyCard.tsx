import { useMemo } from "react";
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { AI_ASSISTANT_NAME } from "@/utils/aiAssistant";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import ExpandableText from "./ExpandableText";

type AiReply = {
  text?: string;
  model?: string | null;
  status?: string | null;
};

export default function AiReplyCard({
  reply,
  compact = false,
}: {
  reply?: AiReply | null;
  compact?: boolean;
}) {
  const { styles, theme } = useStyles();
  if (!reply) return null;

  const isGenerating = reply.status === "generating";
  const hasText = Boolean(reply.text?.trim());

  if (!isGenerating && !hasText) return null;

  return (
    <View style={[styles.card, compact && styles.cardCompact]}>
      <View style={styles.header}>
        <View style={styles.badge}>
          <Ionicons name="sparkles" size={13} color={theme.onPrimary} />
        </View>
        <Text style={styles.title}>{AI_ASSISTANT_NAME}</Text>
      </View>
      {isGenerating ? (
        <View style={styles.pendingRow}>
          <ActivityIndicator size="small" color={theme.primary} />
          <Text style={styles.pendingText}>Generating a reply...</Text>
        </View>
      ) : (
        <ExpandableText
          text={reply.text || ""}
          textStyle={styles.body}
          collapsedLines={compact ? 4 : 5}
          minLengthToToggle={220}
          buttonTextStyle={styles.toggleText}
        />
      )}
    </View>
  );
}

/** Themed stylesheet for this component. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
    shadowColor: "#7a2016",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 2,
  },
  cardCompact: {
    marginTop: 10,
    padding: 12,
    borderRadius: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  badge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.primary,
    marginRight: 8,
  },
  title: {
    color: c.primary,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  body: {
    color: c.textPrimary,
    fontSize: 13.5,
    lineHeight: 20,
  },
  toggleText: {
    color: c.primary,
    fontSize: 13,
    fontWeight: "700",
  },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  pendingText: {
    marginLeft: 10,
    color: c.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
});

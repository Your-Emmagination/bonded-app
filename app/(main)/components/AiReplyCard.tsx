import { Ionicons } from "@expo/vector-icons";
import React from "react";
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
  if (!reply) return null;

  const isGenerating = reply.status === "generating";
  const hasText = Boolean(reply.text?.trim());

  if (!isGenerating && !hasText) return null;

  return (
    <View style={[styles.card, compact && styles.cardCompact]}>
      <View style={styles.header}>
        <View style={styles.badge}>
          <Ionicons name="sparkles" size={13} color="#fff7f0" />
        </View>
        <Text style={styles.title}>Bonded AI</Text>
        {!!reply.model && <Text style={styles.model}>{reply.model}</Text>}
      </View>
      {isGenerating ? (
        <View style={styles.pendingRow}>
          <ActivityIndicator size="small" color="#8f2117" />
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

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "#fff4ef",
    borderWidth: 1,
    borderColor: "#f0c7ba",
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
    backgroundColor: "#8f2117",
    marginRight: 8,
  },
  title: {
    color: "#6f160f",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  model: {
    marginLeft: "auto",
    color: "#b46251",
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  body: {
    color: "#4f1c17",
    fontSize: 13.5,
    lineHeight: 20,
  },
  toggleText: {
    color: "#8f2117",
    fontSize: 13,
    fontWeight: "700",
  },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  pendingText: {
    marginLeft: 10,
    color: "#7d3b30",
    fontSize: 13,
    fontWeight: "600",
  },
});

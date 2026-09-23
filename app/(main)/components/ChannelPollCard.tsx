// app/(main)/components/ChannelPollCard.tsx
//
// A poll inside a channel message: the question, each option with a bar and
// its count, a check on your own answer, and how long is left. Its own card,
// so it reads the same inside your coloured bubble and anyone else's.
import { useThemeColors } from "@/contexts/ThemeContext";
import {
  POLL_MAX_TOTAL_OPTIONS,
  pollIsClosed,
  pollTimeLeft,
  tallyPoll,
  type ChannelPoll,
  type PollVoters,
} from "@/utils/channelPolls";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

type ChannelPollCardProps = {
  poll: ChannelPoll;
  voters?: PollVoters;
  currentUserId?: string | null;
  nowMs: number;
  /** Members and staff vote; someone who hasn't joined only sees the results. */
  canVote: boolean;
  onVote: (optionId: string) => void;
  onAddOption: (text: string) => Promise<string | null>;
  accent: string;
};

export default function ChannelPollCard({
  poll,
  voters,
  currentUserId,
  nowMs,
  canVote,
  onVote,
  onAddOption,
  accent,
}: ChannelPollCardProps) {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { counts, voterCount, mine } = tallyPoll(poll, voters, currentUserId);
  const closed = pollIsClosed(poll, nowMs);
  const interactive = canVote && !closed;
  const canAddOption =
    interactive &&
    poll.allowUsersToAddOption === true &&
    poll.options.length < POLL_MAX_TOTAL_OPTIONS;
  const [showAddOption, setShowAddOption] = useState(false);
  const [newOption, setNewOption] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addingOption, setAddingOption] = useState(false);
  const highest = Math.max(1, ...poll.options.map((option) => counts[option.id] || 0));

  const submitOption = async () => {
    if (!newOption.trim() || addingOption) return;
    setAddingOption(true);
    setAddError(null);
    try {
      const problem = await onAddOption(newOption);
      if (problem) {
        setAddError(problem);
        return;
      }
      setNewOption("");
      setShowAddOption(false);
    } finally {
      setAddingOption(false);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Ionicons name="stats-chart" size={13} color={accent} />
        <Text style={[styles.kicker, { color: accent }]}>Poll</Text>
        <Text style={styles.mode}>{poll.allowMultiple ? "Choose any" : "Choose one"}</Text>
      </View>
      <Text style={styles.question}>{poll.question}</Text>

      <View
        style={styles.options}
        accessibilityRole={poll.allowMultiple ? undefined : "radiogroup"}
      >
        {poll.options.map((option) => {
          const count = counts[option.id] || 0;
          const chosen = mine.includes(option.id);
          const share = voterCount ? Math.round((count / voterCount) * 100) : 0;
          return (
            <Pressable
              key={option.id}
              disabled={!interactive}
              onPress={() => onVote(option.id)}
              style={({ pressed }) => [
                styles.option,
                chosen && { borderColor: accent },
                pressed && styles.optionPressed,
              ]}
              accessibilityRole={poll.allowMultiple ? "checkbox" : "radio"}
              accessibilityState={{ checked: chosen, disabled: !interactive }}
              accessibilityLabel={`${option.text}, ${count} ${count === 1 ? "vote" : "votes"}`}
            >
              {/* The bar: how this option compares with the leader. */}
              <View
                style={[
                  styles.bar,
                  { width: `${(count / highest) * 100}%`, backgroundColor: `${accent}26` },
                ]}
                pointerEvents="none"
              />
              <Ionicons
                name={
                  poll.allowMultiple
                    ? chosen ? "checkbox" : "square-outline"
                    : chosen ? "radio-button-on" : "radio-button-off"
                }
                size={18}
                color={chosen ? accent : theme.textMuted}
              />
              <Text style={[styles.optionText, chosen && styles.optionTextChosen]} numberOfLines={2}>
                {option.text}
              </Text>
              <Text style={styles.count}>
                {voterCount ? `${share}%` : ""}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {canAddOption && !showAddOption && (
        <TouchableOpacity
          style={styles.addOptionButton}
          onPress={() => setShowAddOption(true)}
          activeOpacity={0.78}
          accessibilityRole="button"
        >
          <Ionicons name="add-circle-outline" size={17} color={accent} />
          <Text style={[styles.addOptionButtonText, { color: accent }]}>Add your own option</Text>
        </TouchableOpacity>
      )}

      {canAddOption && showAddOption && (
        <View style={styles.addOptionPanel}>
          <TextInput
            value={newOption}
            onChangeText={(value) => {
              setNewOption(value);
              if (addError) setAddError(null);
            }}
            placeholder="Type a new option"
            placeholderTextColor={theme.textMuted}
            style={styles.addOptionInput}
            maxLength={80}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={submitOption}
          />
          <View style={styles.addOptionActions}>
            <TouchableOpacity
              style={styles.addOptionCancel}
              onPress={() => {
                setNewOption("");
                setAddError(null);
                setShowAddOption(false);
              }}
              disabled={addingOption}
            >
              <Text style={styles.addOptionCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.addOptionSubmit,
                { backgroundColor: accent },
                (!newOption.trim() || addingOption) && styles.disabled,
              ]}
              onPress={submitOption}
              disabled={!newOption.trim() || addingOption}
            >
              {addingOption ? (
                <ActivityIndicator size="small" color={theme.onPrimary} />
              ) : (
                <Text style={styles.addOptionSubmitText}>Add</Text>
              )}
            </TouchableOpacity>
          </View>
          {!!addError && <Text style={styles.addOptionError}>{addError}</Text>}
        </View>
      )}

      <Text style={styles.footer}>
        {voterCount} {voterCount === 1 ? "vote" : "votes"} · {pollTimeLeft(poll, nowMs)}
        {!canVote && !closed ? " · Join the server to vote" : ""}
      </Text>
    </View>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    card: {
      minWidth: 230,
      marginTop: 2,
      padding: 12,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceRaised,
      gap: 8,
    },
    headRow: { flexDirection: "row", alignItems: "center", gap: 5 },
    kicker: { fontSize: 11.5, fontWeight: "800", letterSpacing: 0.3 },
    mode: { marginLeft: "auto", color: c.textMuted, fontSize: 11, fontWeight: "600" },
    question: { color: c.textPrimary, fontSize: 15, fontWeight: "800", lineHeight: 20 },
    options: { gap: 6 },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
      minHeight: 42,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 11,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.surface,
      overflow: "hidden",
    },
    optionPressed: { opacity: 0.8 },
    bar: { position: "absolute", top: 0, bottom: 0, left: 0 },
    optionText: { flex: 1, color: c.textPrimary, fontSize: 13.5 },
    optionTextChosen: { fontWeight: "800" },
    count: { color: c.textSecondary, fontSize: 12, fontWeight: "700", minWidth: 34, textAlign: "right" },
    addOptionButton: {
      minHeight: 38,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderRadius: 11,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
    },
    addOptionButtonText: { fontSize: 12.5, fontWeight: "800" },
    addOptionPanel: { gap: 7, padding: 8, borderRadius: 11, backgroundColor: c.surfaceSunken },
    addOptionInput: {
      minHeight: 42,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surfaceRaised,
      color: c.textPrimary,
      paddingHorizontal: 11,
      fontSize: 13,
    },
    addOptionActions: { flexDirection: "row", justifyContent: "flex-end", gap: 7 },
    addOptionCancel: { minHeight: 34, paddingHorizontal: 12, alignItems: "center", justifyContent: "center" },
    addOptionCancelText: { color: c.textSecondary, fontSize: 12, fontWeight: "700" },
    addOptionSubmit: { minWidth: 68, minHeight: 34, borderRadius: 9, alignItems: "center", justifyContent: "center" },
    addOptionSubmitText: { color: c.onPrimary, fontSize: 12, fontWeight: "800" },
    addOptionError: { color: c.danger, fontSize: 11.5, fontWeight: "600" },
    disabled: { opacity: 0.5 },
    footer: { color: c.textMuted, fontSize: 11.5 },
  });

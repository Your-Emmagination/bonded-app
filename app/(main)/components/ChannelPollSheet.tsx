// app/(main)/components/ChannelPollSheet.tsx
//
// "New poll" in a channel: the question, two to six options, one answer or
// several, and how long it runs. Posting it is the channel screen's job.
import { useThemeColors } from "@/contexts/ThemeContext";
import {
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  validatePollDraft,
  type PollDraft,
} from "@/utils/channelPolls";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import DropDownPicker from "react-native-dropdown-picker";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
// A pop-up is its own window, and the keyboard library turns off Android's
// own resizing inside it, so the sheet rides up with the keyboard itself.
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

type ChannelPollSheetProps = {
  visible: boolean;
  channelLabel: string;
  accent: string;
  onClose: () => void;
  /** Resolves true once the poll is posted. */
  onSubmit: (draft: PollDraft) => Promise<boolean>;
};

type DurationField = "days" | "hours" | "minutes";
const DEFAULT_DURATION = { days: 1, hours: 0, minutes: 0 };

export default function ChannelPollSheet({
  visible,
  channelLabel,
  accent,
  onClose,
  onSubmit,
}: ChannelPollSheetProps) {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [allowUsersToAddOption, setAllowUsersToAddOption] = useState(false);
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [durationOpen, setDurationOpen] = useState<DurationField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const reset = () => {
    setQuestion("");
    setOptions(["", ""]);
    setAllowMultiple(false);
    setAllowUsersToAddOption(false);
    setDuration(DEFAULT_DURATION);
    setDurationOpen(null);
    setError(null);
  };

  const close = () => {
    if (posting) return;
    onClose();
  };

  const post = async () => {
    const durationMs =
      duration.days * 24 * 60 * 60 * 1000 +
      duration.hours * 60 * 60 * 1000 +
      duration.minutes * 60 * 1000;
    const problem = validatePollDraft({ question, options, durationMs });
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setPosting(true);
    try {
      const posted = await onSubmit({
        question,
        options,
        allowMultiple,
        allowUsersToAddOption,
        durationMs,
      });
      if (posted) {
        reset();
        onClose();
      }
    } catch {
      setError("Couldn't post the poll. Check your connection and try again.");
    } finally {
      setPosting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView automaticOffset behavior="padding" style={styles.backdrop}>
        <TouchableOpacity accessible={false} activeOpacity={1} onPress={close} style={StyleSheet.absoluteFill} />
        <View style={styles.sheet}>
          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>New poll</Text>
              <Text style={styles.subtitle}>in #{channelLabel}</Text>
            </View>
            <TouchableOpacity onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={24} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={styles.label}>Question</Text>
            <TextInput
              value={question}
              onChangeText={(value) => {
                setQuestion(value);
                if (error) setError(null);
              }}
              placeholder="Which day works for the field trip?"
              placeholderTextColor={theme.textMuted}
              maxLength={POLL_QUESTION_MAX}
              multiline
              style={[styles.input, styles.questionInput]}
            />

            <Text style={styles.label}>Options</Text>
            {options.map((option, index) => (
              <View key={index} style={styles.optionRow}>
                <TextInput
                  value={option}
                  onChangeText={(value) => {
                    setOptions((current) => current.map((entry, i) => (i === index ? value : entry)));
                    if (error) setError(null);
                  }}
                  placeholder={`Option ${index + 1}`}
                  placeholderTextColor={theme.textMuted}
                  maxLength={POLL_OPTION_MAX}
                  style={[styles.input, styles.optionInput]}
                  returnKeyType="next"
                />
                {options.length > POLL_MIN_OPTIONS && (
                  <TouchableOpacity
                    onPress={() => setOptions((current) => current.filter((_, i) => i !== index))}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove option ${index + 1}`}
                  >
                    <Ionicons name="close-circle" size={24} color={theme.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
            ))}
            {options.length < POLL_MAX_OPTIONS && (
              <TouchableOpacity
                onPress={() => setOptions((current) => [...current, ""])}
                style={styles.addOption}
                accessibilityRole="button"
              >
                <Ionicons name="add-circle-outline" size={18} color={accent} />
                <Text style={[styles.addOptionText, { color: accent }]}>Add option</Text>
              </TouchableOpacity>
            )}

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchTitle}>Allow more than one answer</Text>
                <Text style={styles.switchHint}>
                  {allowMultiple ? "People can pick several options." : "People pick one option."}
                </Text>
              </View>
              <Switch
                value={allowMultiple}
                onValueChange={setAllowMultiple}
                trackColor={{ false: theme.borderStrong, true: accent }}
                thumbColor={theme.surfaceRaised}
              />
            </View>

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchTitle}>Allow users to add new options</Text>
                <Text style={styles.switchHint}>Members can submit their own choice while the poll is open.</Text>
              </View>
              <Switch
                value={allowUsersToAddOption}
                onValueChange={setAllowUsersToAddOption}
                trackColor={{ false: theme.borderStrong, true: accent }}
                thumbColor={theme.surfaceRaised}
              />
            </View>

            <Text style={styles.label}>Poll duration</Text>
            <View style={styles.durationRow}>
              <DurationDropdown
                label="Days"
                value={duration.days}
                max={30}
                open={durationOpen === "days"}
                onOpen={(open) => setDurationOpen(open ? "days" : null)}
                onChange={(value) => setDuration((current) => ({ ...current, days: value }))}
                zIndex={300}
              />
              <DurationDropdown
                label="Hours"
                value={duration.hours}
                max={23}
                open={durationOpen === "hours"}
                onOpen={(open) => setDurationOpen(open ? "hours" : null)}
                onChange={(value) => setDuration((current) => ({ ...current, hours: value }))}
                zIndex={200}
              />
              <DurationDropdown
                label="Minutes"
                value={duration.minutes}
                max={59}
                open={durationOpen === "minutes"}
                onOpen={(open) => setDurationOpen(open ? "minutes" : null)}
                onChange={(value) => setDuration((current) => ({ ...current, minutes: value }))}
                zIndex={100}
              />
            </View>

            {error && (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={16} color={theme.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </ScrollView>

          <TouchableOpacity
            onPress={post}
            disabled={posting}
            style={[styles.postButton, { backgroundColor: accent }, posting && { opacity: 0.6 }]}
            accessibilityRole="button"
          >
            {posting ? (
              <ActivityIndicator color={theme.onPrimary} />
            ) : (
              <Text style={styles.postText}>Post poll</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
    sheet: {
      maxHeight: "90%",
      backgroundColor: c.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 16,
    },
    head: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 6 },
    title: { color: c.textPrimary, fontSize: 18, fontWeight: "900" },
    subtitle: { color: c.textMuted, fontSize: 12, marginTop: 2 },
    label: { color: c.textSecondary, fontSize: 12.5, fontWeight: "800", marginTop: 16, marginBottom: 7 },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.surfaceRaised,
      color: c.textPrimary,
      fontSize: 14.5,
      paddingHorizontal: 13,
      paddingVertical: 11,
    },
    questionInput: { minHeight: 52, textAlignVertical: "top" },
    optionRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
    optionInput: { flex: 1 },
    addOption: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingVertical: 6 },
    addOptionText: { fontSize: 13.5, fontWeight: "800" },
    switchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginTop: 12,
      padding: 12,
      borderRadius: 12,
      backgroundColor: c.surfaceSunken,
    },
    switchTitle: { color: c.textPrimary, fontSize: 14, fontWeight: "700" },
    switchHint: { color: c.textMuted, fontSize: 12, marginTop: 2 },
    durationRow: { flexDirection: "row", gap: 9, alignItems: "flex-start", marginBottom: 8 },
    durationField: { flex: 1, minWidth: 0 },
    durationPicker: {
      minHeight: 52,
      borderRadius: 13,
      borderColor: c.borderStrong,
      backgroundColor: c.surfaceRaised,
      paddingHorizontal: 12,
    },
    durationPickerMenu: {
      borderColor: c.borderStrong,
      backgroundColor: c.surfaceRaised,
      borderRadius: 13,
    },
    durationPickerText: { color: c.textPrimary, fontSize: 14, fontWeight: "700" },
    durationLabel: { color: c.textMuted, fontSize: 11.5, textAlign: "center", marginTop: 6 },
    errorBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 16,
      padding: 11,
      borderRadius: 12,
      backgroundColor: c.dangerSoft,
    },
    errorText: { flex: 1, color: c.danger, fontSize: 13, fontWeight: "600" },
    postButton: {
      marginTop: 16,
      minHeight: 52,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    postText: { color: c.onPrimary, fontSize: 15.5, fontWeight: "800" },
  });

const DurationDropdown = ({
  label,
  value,
  max,
  open,
  onOpen,
  onChange,
  zIndex,
}: {
  label: string;
  value: number;
  max: number;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (value: number) => void;
  zIndex: number;
}) => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const items = useMemo(
    () => Array.from({ length: max + 1 }, (_, value) => ({ label: String(value), value })),
    [max],
  );

  return (
    <View style={[styles.durationField, { zIndex }]}>
      <DropDownPicker
        open={open}
        value={value}
        items={items}
        setOpen={(next) => onOpen(typeof next === "function" ? next(open) : next)}
        setValue={(next) => onChange(typeof next === "function" ? next(value) : next)}
        style={styles.durationPicker}
        dropDownContainerStyle={styles.durationPickerMenu}
        textStyle={styles.durationPickerText}
        listItemLabelStyle={styles.durationPickerText}
        maxHeight={190}
        zIndex={zIndex}
        zIndexInverse={1000 - zIndex}
      />
      <Text style={styles.durationLabel}>{label}</Text>
    </View>
  );
};

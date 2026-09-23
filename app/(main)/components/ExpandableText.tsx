import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import React, { useCallback, useMemo, useState } from "react";
import {
  NativeSyntheticEvent,
  StyleProp,
  StyleSheet,
  Text,
  TextLayoutEventData,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native";

type ExpandableTextProps = {
  text?: string | null;
  textStyle?: StyleProp<TextStyle>;
  /** Optional rich rendering for mentions or links; measurement stays plain text. */
  renderText?: (text: string) => React.ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  buttonStyle?: StyleProp<ViewStyle>;
  buttonTextStyle?: StyleProp<TextStyle>;
  /** Lines shown before the text is cut. */
  collapsedLines?: number;
  /** False shows the whole text, always — for rules and pinned messages. */
  collapsible?: boolean;
  /**
   * False cuts the text without offering "See more", where the whole card
   * is what you tap (the trending scroller).
   */
  showToggle?: boolean;
};

/** A line holds at least this many characters, at any width we draw. */
const MIN_CHARS_PER_LINE = 20;

/**
 * Text cut to a few lines with "See more", shown only when something is
 * really cut off. It used to go by character count (over 220), so a
 * message that fit in four lines still offered "See more", and tapping it
 * revealed nothing.
 */
export default function ExpandableText({
  text,
  textStyle,
  renderText,
  containerStyle,
  buttonStyle,
  buttonTextStyle,
  collapsedLines = 5,
  collapsible = true,
  showToggle = true,
}: ExpandableTextProps) {
  const { styles } = useStyles();
  const [expanded, setExpanded] = useState(false);
  // How many lines the whole text takes, measured for this exact text.
  const [measured, setMeasured] = useState<{ text: string; lines: number } | null>(null);

  const trimmedText = useMemo(() => text?.trim() || "", [text]);

  // Too short to reach the limit at any width: nothing to cut or measure.
  // Errs toward showing everything.
  const lineBreaks = trimmedText.split("\n").length;
  const mightOverflow =
    collapsible &&
    (lineBreaks > collapsedLines || trimmedText.length > collapsedLines * MIN_CHARS_PER_LINE);
  const fullLines = measured?.text === trimmedText ? measured.lines : null;
  const cutOff = mightOverflow && fullLines !== null && fullLines > collapsedLines;

  const handleMeasure = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const lines = event.nativeEvent.lines.length;
      setMeasured((current) =>
        current?.text === trimmedText && current.lines === lines
          ? current
          : { text: trimmedText, lines },
      );
    },
    [trimmedText],
  );

  if (!trimmedText) return null;

  return (
    <View style={containerStyle}>
      <Text
        style={textStyle}
        numberOfLines={mightOverflow && !expanded ? collapsedLines : undefined}
        ellipsizeMode="tail"
      >
        {renderText ? renderText(trimmedText) : trimmedText}
      </Text>

      {mightOverflow && (
        // The same text, invisible and uncut, only to count its lines: the
        // visible copy is cut, so it can't say how many there are.
        <View
          style={styles.measure}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={textStyle} onTextLayout={handleMeasure}>
            {trimmedText}
          </Text>
        </View>
      )}

      {cutOff && showToggle && (
        <TouchableOpacity
          activeOpacity={0.75}
          onPress={() => setExpanded((current) => !current)}
          style={[styles.button, buttonStyle]}
        >
          <Text style={[styles.buttonText, buttonTextStyle]}>
            {expanded ? "See less" : "See more"}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  button: {
    alignSelf: "flex-start",
    marginTop: 4,
  },
  buttonText: {
    color: c.primary,
    fontSize: 14,
    fontWeight: "600",
  },
  measure: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    opacity: 0,
  },
});

/** Themed stylesheet for this file. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

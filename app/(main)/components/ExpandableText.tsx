import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import React, { useMemo, useState } from "react";
import {
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native";

type ExpandableTextProps = {
  text?: string | null;
  textStyle?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  buttonStyle?: StyleProp<ViewStyle>;
  buttonTextStyle?: StyleProp<TextStyle>;
  collapsedLines?: number;
  minLengthToToggle?: number;
};

export default function ExpandableText({
  text,
  textStyle,
  containerStyle,
  buttonStyle,
  buttonTextStyle,
  collapsedLines = 5,
  minLengthToToggle = 220,
}: ExpandableTextProps) {
  const { styles } = useStyles();
  const [expanded, setExpanded] = useState(false);

  const trimmedText = useMemo(() => text?.trim() || "", [text]);
  const shouldShowToggle = trimmedText.length > minLengthToToggle;

  if (!trimmedText) return null;

  return (
    <View style={containerStyle}>
      <Text
        style={textStyle}
        numberOfLines={expanded || !shouldShowToggle ? undefined : collapsedLines}
        ellipsizeMode="tail"
      >
        {trimmedText}
      </Text>

      {shouldShowToggle && (
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
});

/** Themed stylesheet for this file. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

// app/(main)/components/ExternalLinkDialog.tsx
//
// The screen between tapping a link and the browser opening.
//
// The whole point is the domain. A phishing post says "CSAP Enrollment
// Portal" and links to "csap-enrollment-verify.tk"; the attack only works
// while nobody reads the second line. PostCard already prints the URL in
// small grey text under the title, which is easy to skip. Here it is the
// largest thing on screen, and the person has to make a choice before it
// opens.
//
// For a blocked host there is no way through — the only button closes it.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import {
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { analyzeLink, type LinkVerdict } from "@/utils/externalLinks";

type PendingLink = { url: string; verdict: LinkVerdict };

type ExternalLinkDialogProps = {
  link: PendingLink | null;
  onClose: () => void;
};

export default function ExternalLinkDialog({ link, onClose }: ExternalLinkDialogProps) {
  const { styles, theme } = useStyles();
  if (!link) return null;

  const { url, verdict } = link;
  const blocked = verdict.risk === "blocked";
  const suspicious = verdict.risk === "suspicious";

  const accent = blocked ? theme.danger : suspicious ? theme.warning : theme.textSecondary;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Stops a tap inside the card from closing the dialog. */}
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={[styles.iconWrap, { backgroundColor: accent + "14" }]}>
            <Ionicons
              name={blocked ? "close-circle" : suspicious ? "warning" : "open-outline"}
              size={26}
              color={accent}
            />
          </View>

          <Text style={styles.title}>
            {blocked
              ? "This link can't be opened"
              : suspicious
                ? "Check this link first"
                : "You're leaving BondED"}
          </Text>

          {!blocked && <Text style={styles.lead}>This link goes to</Text>}

          {/* The line everything else exists to make people read. */}
          <View style={[styles.hostBox, { borderColor: accent + "33" }]}>
            <Text style={[styles.host, { color: accent }]} numberOfLines={2}>
              {verdict.host || url}
            </Text>
          </View>

          {verdict.reasons.map((reason) => (
            <View key={reason} style={styles.reasonRow}>
              <Ionicons name="alert-circle-outline" size={15} color={accent} />
              <Text style={styles.reasonText}>{reason}</Text>
            </View>
          ))}

          {!blocked && (
            <Text style={styles.disclaimer}>
              BondED can&apos;t check whether this site is safe. Never type your
              student ID or password on a page you don&apos;t recognise.
            </Text>
          )}

          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelButton} onPress={onClose} activeOpacity={0.84}>
              <Text style={styles.cancelText}>{blocked ? "OK" : "Cancel"}</Text>
            </TouchableOpacity>

            {!blocked && (
              <TouchableOpacity
                style={[styles.continueButton, { backgroundColor: accent }]}
                onPress={() => {
                  onClose();
                  Linking.openURL(url).catch(() => {
                    // Nothing useful to add: the dialog is already gone and the
                    // person chose to leave. A failure here means no browser
                    // could handle it.
                  });
                }}
                activeOpacity={0.86}
              >
                <Ionicons name="open-outline" size={16} color={theme.onPrimary} />
                <Text style={styles.continueText}>Continue</Text>
              </TouchableOpacity>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Builds the dialog's state for a link. Screens call this in their onPress
 * and render <ExternalLinkDialog> with the result.
 *
 * Trusted destinations (Drive, YouTube, the app's own media host) open
 * straight away — returning null means "nothing to ask about". A dialog on
 * every link is a dialog nobody reads.
 */
export function prepareExternalLink(
  url: string,
  label?: string,
): PendingLink | null {
  const verdict = analyzeLink(url, label);
  if (verdict.risk === "trusted") {
    Linking.openURL(url).catch(() => {});
    return null;
  }
  return { url, verdict };
}

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
    alignItems: "center",
    justifyContent: "center",
    padding: 26,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: c.background,
    borderRadius: 22,
    padding: 22,
    alignItems: "center",
  },
  iconWrap: {
    width: 54,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 13,
  },
  title: {
    color: c.textPrimary,
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
  },
  lead: {
    color: c.textMuted,
    fontSize: 13,
    marginTop: 10,
  },
  hostBox: {
    alignSelf: "stretch",
    borderWidth: 1.5,
    borderRadius: 13,
    backgroundColor: c.surfaceRaised,
    paddingVertical: 13,
    paddingHorizontal: 14,
    marginTop: 8,
    marginBottom: 4,
  },
  host: {
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
  },
  reasonRow: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    marginTop: 10,
  },
  reasonText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 12.5,
    lineHeight: 18,
  },
  disclaimer: {
    color: c.textMuted,
    fontSize: 11.5,
    lineHeight: 17,
    textAlign: "center",
    marginTop: 14,
  },
  actions: {
    flexDirection: "row",
    alignSelf: "stretch",
    gap: 10,
    marginTop: 18,
  },
  cancelButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 13,
    borderRadius: 14,
    backgroundColor: c.border,
  },
  cancelText: { color: c.textPrimary, fontSize: 14, fontWeight: "900" },
  continueButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingVertical: 13,
    borderRadius: 14,
  },
  continueText: { color: c.onPrimary, fontSize: 14, fontWeight: "900" },
});

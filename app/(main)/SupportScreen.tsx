// app/(main)/SupportScreen.tsx
//
// The student's side of Help & Support: their own tickets, and the form for
// a new one.
//
// Reached from Settings rather than the Profile action list, because support
// is not a fifth thing about you — it is where you go when something is
// broken. A reply, however, is surfaced loudly: burying the entry point is
// fine, burying the answer is not.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
// The keyboard library's own view. It follows the keyboard frame by frame;
// React Native's built-in one stopped lifting anything on Android once
// KeyboardProvider (app/_layout.tsx) took over the keyboard.
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import BeaOrb from "./components/BeaOrb";
import ConfirmDialog from "./components/ConfirmDialog";
import { CardListSkeleton } from "./components/Skeleton";
import { auth } from "../../Firebase_configure";
import { uploadPostImage } from "@/utils/cloudinaryUpload";
import { getTimeAgo } from "@/utils/relativeTime";
import {
  createSupportTicket,
  getCategoryLabel,
  subscribeToMyTickets,
  TICKET_CATEGORIES,
  TICKET_STATUS_META,
  type SupportTicket,
  type TicketCategory,
} from "@/utils/supportTickets";

const SUBJECT_MAX = 80;
const DESCRIPTION_MAX = 1000;

export default function SupportScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    compose?: string | string[];
    question?: string | string[];
  }>();

  const single = (value?: string | string[]) =>
    Array.isArray(value) ? value[0] : value;

  const [userId, setUserId] = useState<string | null>(auth.currentUser?.uid ?? null);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  // Signed out has nothing to load, so the spinner starts off in that case
  // rather than being switched off from inside the effect below.
  const [loading, setLoading] = useState(() => !!auth.currentUser);

  // Opened straight into the form when BEA escalated a question.
  const escalatedQuestion = single(params.question) || "";
  const [composing, setComposing] = useState(single(params.compose) === "1");

  const [category, setCategory] = useState<TicketCategory | null>(null);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState(escalatedQuestion);
  const [attachment, setAttachment] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    onConfirm?: () => void;
  } | null>(null);

  useEffect(() => onAuthStateChanged(auth, (user) => setUserId(user?.uid ?? null)), []);

  useEffect(() => {
    if (!userId) return;
    return subscribeToMyTickets(userId, (rows) => {
      setTickets(rows);
      setLoading(false);
    });
  }, [userId]);

  const canSubmit =
    !!category && subject.trim().length > 0 && description.trim().length > 0;

  const resetForm = useCallback(() => {
    setCategory(null);
    setSubject("");
    setDescription("");
    setAttachment(null);
    setComposing(false);
  }, []);

  // Leaving the form keeps the draft. Typing four paragraphs about a bug and
  // losing them to a stray back tap is the fastest way to make somebody give
  // up on reporting it at all.
  const leaveForm = useCallback(() => setComposing(false), []);

  const handlePickImage = useCallback(async () => {
    if (uploading) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
      });
      if (result.canceled || !result.assets?.[0]) return;
      setUploading(true);
      const url = await uploadPostImage(result.assets[0].uri);
      setAttachment(url);
    } catch (error) {
      console.error("Screenshot upload failed:", error);
      setDialog({
        title: "Couldn't attach that",
        description: "The screenshot didn't upload. You can still send without it.",
      });
    } finally {
      setUploading(false);
    }
  }, [uploading]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || submitting || !category) return;
    setSubmitting(true);
    try {
      const { ticketNo } = await createSupportTicket({
        category,
        subject,
        description,
        imageUrl: attachment,
        sourceQuestion: escalatedQuestion || null,
      });
      resetForm();
      setDialog({
        title: "Request sent",
        description: `Your ticket is ${ticketNo}. You'll get a notification here when someone replies.`,
      });
    } catch (error: any) {
      setDialog({
        title: "Couldn't send",
        description:
          error?.message || "Please check your connection and try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }, [attachment, canSubmit, category, description, escalatedQuestion, resetForm, subject, submitting]);

  // Signing out leaves the last list in state; render from this instead so
  // a signed-out screen never shows the previous user's requests.
  const myTickets = useMemo(() => (userId ? tickets : []), [tickets, userId]);

  const unreadCount = useMemo(
    () => myTickets.filter((ticket) => ticket.unreadForUser).length,
    [myTickets],
  );

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => (composing ? leaveForm() : router.back())}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>
          {composing ? "Report a problem" : "Help & Support"}
        </Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView automaticOffset
        style={{ flex: 1 }}
        behavior="padding"
        enabled={Platform.OS !== "web"}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + 28 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          {composing ? (
            <>
              {!!escalatedQuestion && (
                // B.E.A. handing over: the unsure face, with its "?".
                <View style={styles.escalatedCard}>
                  <BeaOrb size={52} mood="unsure" animated />
                  <Text style={styles.escalatedText}>
                    <Text style={styles.escalatedLead}>
                      B.E.A. couldn&apos;t answer this one.
                    </Text>{" "}
                    We&apos;ve filled in what you asked so staff can pick it up. Add
                    anything else that helps.
                  </Text>
                </View>
              )}

              <Text style={styles.label}>What is this about?</Text>
              <View style={styles.categoryList}>
                {TICKET_CATEGORIES.map((item) => {
                  const selected = category === item.value;
                  return (
                    <TouchableOpacity
                      key={item.value}
                      style={[styles.categoryCard, selected && styles.categoryCardSelected]}
                      onPress={() => setCategory(item.value)}
                      activeOpacity={0.85}
                    >
                      <View
                        style={[
                          styles.categoryIcon,
                          selected && styles.categoryIconSelected,
                        ]}
                      >
                        <Ionicons
                          name={item.icon as any}
                          size={18}
                          color={selected ? theme.onPrimary : theme.accent}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.categoryLabel,
                            selected && styles.categoryLabelSelected,
                          ]}
                        >
                          {item.label}
                        </Text>
                        <Text style={styles.categoryHint}>{item.hint}</Text>
                      </View>
                      {selected && (
                        <Ionicons name="checkmark-circle" size={19} color={theme.primary} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.label}>Subject</Text>
              <TextInput
                style={styles.input}
                value={subject}
                onChangeText={(value) => setSubject(value.slice(0, SUBJECT_MAX))}
                placeholder="One line — e.g. My year level is wrong"
                placeholderTextColor={theme.textMuted}
              />
              <Text style={styles.counter}>
                {subject.length} / {SUBJECT_MAX}
              </Text>

              <Text style={styles.label}>What happened?</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                value={description}
                onChangeText={(value) => setDescription(value.slice(0, DESCRIPTION_MAX))}
                placeholder="Tell us what you expected and what happened instead. Include the time it happened if you can."
                placeholderTextColor={theme.textMuted}
                multiline
                textAlignVertical="top"
              />
              <Text style={styles.counter}>
                {description.length} / {DESCRIPTION_MAX}
              </Text>

              <Text style={styles.label}>Screenshot (optional)</Text>
              {attachment ? (
                <View style={styles.attachmentCard}>
                  <Image
                    source={{ uri: attachment }}
                    style={styles.attachmentThumb}
                    contentFit="cover"
                  />
                  <Text style={styles.attachmentLabel}>Screenshot attached</Text>
                  <TouchableOpacity
                    onPress={() => setAttachment(null)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons name="close-circle" size={21} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.attachButton}
                  onPress={handlePickImage}
                  disabled={uploading}
                  activeOpacity={0.85}
                >
                  {uploading ? (
                    <ActivityIndicator size="small" color={theme.accent} />
                  ) : (
                    <Ionicons name="image-outline" size={19} color={theme.accent} />
                  )}
                  <Text style={styles.attachButtonText}>
                    {uploading ? "Uploading…" : "Add a screenshot"}
                  </Text>
                </TouchableOpacity>
              )}

              <Text style={styles.privacyNote}>
                Your name, role and program are attached automatically so staff
                know who to help. Your app version is included too.
              </Text>

              <View style={styles.expectationRow}>
                <Ionicons name="time-outline" size={15} color={theme.textMuted} />
                <Text style={styles.expectationText}>
                  Staff usually reply within 1–2 school days. You&apos;ll get a
                  notification here when they do.
                </Text>
              </View>

              <TouchableOpacity
                style={[styles.primaryButton, !canSubmit && styles.primaryButtonDisabled]}
                onPress={handleSubmit}
                disabled={!canSubmit || submitting || uploading}
                activeOpacity={0.86}
              >
                {submitting ? (
                  <ActivityIndicator color={theme.onPrimary} size="small" />
                ) : (
                  <>
                    <Ionicons name="send" size={16} color={theme.onPrimary} />
                    <Text style={styles.primaryButtonText}>Send request</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <View style={styles.heroCard}>
                <View style={styles.heroIcon}>
                  <Ionicons name="help-buoy-outline" size={26} color={theme.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.heroTitle}>Need a hand?</Text>
                  <Text style={styles.heroText}>
                    Tell us what&apos;s wrong — a wrong year level, a post that
                    was held, or something in the app that isn&apos;t working.
                  </Text>
                </View>
              </View>

              <TouchableOpacity
                style={styles.newButton}
                onPress={() => setComposing(true)}
                activeOpacity={0.86}
              >
                <Ionicons name="add-circle-outline" size={18} color={theme.onPrimary} />
                <Text style={styles.newButtonText}>Report a problem</Text>
              </TouchableOpacity>

              <View style={styles.listHeader}>
                <Text style={styles.sectionLabel}>My requests</Text>
                {unreadCount > 0 && (
                  <View style={styles.unreadPill}>
                    <Text style={styles.unreadPillText}>
                      {unreadCount} new {unreadCount === 1 ? "reply" : "replies"}
                    </Text>
                  </View>
                )}
              </View>

              {loading ? (
                // Ticket cards in the real card style and spacing.
                <CardListSkeleton
                  count={3}
                  style={styles.skeletonList}
                  cardStyle={styles.ticketCard}
                  lines={[
                    { width: 84, height: 12 },
                    { width: "68%", height: 15, gap: 9 },
                    { width: "92%", height: 12, gap: 7 },
                  ]}
                />
              ) : myTickets.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons name="file-tray-outline" size={28} color={theme.textMuted} />
                  <Text style={styles.emptyTitle}>No requests yet</Text>
                  <Text style={styles.emptyText}>
                    Anything you report will appear here, with the reply.
                  </Text>
                </View>
              ) : (
                myTickets.map((ticket) => {
                  const status = TICKET_STATUS_META[ticket.status];
                  return (
                    <TouchableOpacity
                      key={ticket.id}
                      style={[
                        styles.ticketCard,
                        ticket.unreadForUser && styles.ticketCardUnread,
                      ]}
                      onPress={() =>
                        router.push({
                          pathname: "/SupportTicketScreen",
                          params: { ticketId: ticket.id },
                        })
                      }
                      activeOpacity={0.86}
                    >
                      <View style={styles.ticketTop}>
                        <Text style={styles.ticketNo}>{ticket.ticketNo}</Text>
                        <View style={[styles.statusChip, { backgroundColor: status.bg }]}>
                          <Text style={[styles.statusChipText, { color: status.color }]}>
                            {status.label}
                          </Text>
                        </View>
                      </View>

                      <Text style={styles.ticketSubject} numberOfLines={1}>
                        {ticket.subject}
                      </Text>
                      <Text style={styles.ticketPreview} numberOfLines={2}>
                        {ticket.lastMessagePreview || ticket.description}
                      </Text>

                      <View style={styles.ticketMeta}>
                        <Text style={styles.ticketMetaText}>
                          {getCategoryLabel(ticket.category)}
                        </Text>
                        <Text style={styles.ticketMetaText}>
                          {getTimeAgo(ticket.lastMessageAt)}
                        </Text>
                      </View>

                      {ticket.unreadForUser && (
                        <View style={styles.newReplyRow}>
                          <View style={styles.newReplyDot} />
                          <Text style={styles.newReplyText}>New reply</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmText="OK"
        destructive={false}
        singleAction
        onConfirm={() => {
          dialog?.onConfirm?.();
          setDialog(null);
        }}
        onCancel={() => setDialog(null)}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  topBarTitle: { color: c.textPrimary, fontSize: 16, fontWeight: "900" },
  content: { padding: 16, gap: 12 },

  heroCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 18,
    padding: 16,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: 15,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: { color: c.textPrimary, fontSize: 16, fontWeight: "900" },
  heroText: { color: c.textMuted, fontSize: 12.5, lineHeight: 18, marginTop: 3 },

  newButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.primary,
    borderRadius: 15,
    paddingVertical: 16,
  },
  newButtonText: { color: c.background, fontSize: 14.5, fontWeight: "900" },

  listHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  sectionLabel: {
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  unreadPill: {
    backgroundColor: c.dangerSoft,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  unreadPillText: { color: c.danger, fontSize: 11, fontWeight: "900" },

  // The same space between cards as the page's own spacing.
  skeletonList: { gap: 12 },

  emptyCard: {
    alignItems: "center",
    gap: 7,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 18,
    paddingVertical: 24,
    paddingHorizontal: 20,
  },
  emptyTitle: { color: c.textPrimary, fontSize: 14.5, fontWeight: "900" },
  emptyText: {
    color: c.textMuted,
    fontSize: 12.5,
    lineHeight: 16,
    textAlign: "center",
  },

  ticketCard: {
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 16,
    padding: 16,
    gap: 5,
  },
  ticketCardUnread: { borderColor: c.danger, backgroundColor: c.surfaceRaised },
  ticketTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  ticketNo: { color: c.textMuted, fontSize: 11.5, fontWeight: "900", letterSpacing: 0.4 },
  statusChip: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  statusChipText: { fontSize: 11, fontWeight: "900" },
  ticketSubject: { color: c.textPrimary, fontSize: 14.5, fontWeight: "800" },
  ticketPreview: { color: c.textMuted, fontSize: 12.5, lineHeight: 18 },
  ticketMeta: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  ticketMetaText: { color: c.textMuted, fontSize: 11.5 },
  newReplyRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 5 },
  newReplyDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: c.danger,
  },
  newReplyText: { color: c.danger, fontSize: 11.5, fontWeight: "900" },

  escalatedCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 14,
    padding: 13,
  },
  // Dark text on the gold wash: gold on gold was too faint to read.
  escalatedText: { flex: 1, color: c.textSecondary, fontSize: 12.5, lineHeight: 18 },
  escalatedLead: { color: c.textPrimary, fontWeight: "700" },

  label: {
    color: c.primary,
    fontSize: 13,
    fontWeight: "900",
    marginTop: 6,
  },
  categoryList: { gap: 8 },
  categoryCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    padding: 12,
  },
  categoryCardSelected: { borderColor: c.primary, backgroundColor: c.surfaceRaised },
  categoryIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  categoryIconSelected: { backgroundColor: c.primary },
  categoryLabel: { color: c.textPrimary, fontSize: 13.5, fontWeight: "800" },
  categoryLabelSelected: { color: c.primary },
  categoryHint: { color: c.textMuted, fontSize: 11.5, lineHeight: 16, marginTop: 2 },

  input: {
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: c.textPrimary,
    fontSize: 14,
  },
  textarea: { minHeight: 130 },
  counter: {
    alignSelf: "flex-end",
    color: c.textMuted,
    fontSize: 11,
    marginTop: -6,
  },
  privacyNote: {
    color: c.textMuted,
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 4,
  },

  attachButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderStyle: "dashed",
    borderRadius: 14,
    paddingVertical: 16,
  },
  attachButtonText: { color: c.accent, fontSize: 13.5, fontWeight: "800" },
  attachmentCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 14,
    padding: 10,
  },
  attachmentThumb: { width: 46, height: 46, borderRadius: 10 },
  attachmentLabel: { flex: 1, color: c.accent, fontSize: 13, fontWeight: "800" },
  expectationRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: c.accentSoft,
    borderRadius: 12,
    padding: 11,
    marginTop: 4,
  },
  expectationText: { flex: 1, color: c.textMuted, fontSize: 12, lineHeight: 17 },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.primary,
    borderRadius: 15,
    paddingVertical: 16,
    marginTop: 8,
  },
  primaryButtonDisabled: { backgroundColor: c.borderStrong },
  primaryButtonText: { color: c.background, fontSize: 14.5, fontWeight: "900" },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

// app/(main)/SupportTicketScreen.tsx
//
// One ticket and its conversation.
//
// Deliberately one screen for both sides rather than a student view and a
// staff view: the thread is the same thread, and two implementations would
// drift. What differs is the panel at the top — staff get status, priority
// and assignment controls; a student gets the same facts as read-only text.
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { auth } from "../../Firebase_configure";
import BeaOrb from "./components/BeaOrb";
import ImageZoomViewer from "./components/ImageZoomViewer";
import { uploadPostImage } from "@/utils/cloudinaryUpload";
import { isAdmin as isAdminRole } from "@/utils/rbac";
import { formatChatTimeLabel, formatClockTime, formatDayLabel, sameDay } from "@/utils/chatTime";
import { timestampMillis } from "@/utils/messengerState";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import {
  assignTicket,
  getCategoryLabel,
  markTicketRead,
  postTicketMessage,
  subscribeToTicket,
  subscribeToTicketMessages,
  TICKET_PRIORITY_META,
  TICKET_STATUS_META,
  updateTicketPriority,
  updateTicketStatus,
  type SupportTicket,
  type TicketMessage,
  type TicketPriority,
  type TicketStatus,
} from "@/utils/supportTickets";

const STATUS_FLOW: TicketStatus[] = ["open", "in_progress", "resolved", "closed"];
const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

export default function SupportTicketScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ ticketId?: string | string[] }>();
  const ticketId = Array.isArray(params.ticketId) ? params.ticketId[0] : params.ticketId;

  const role = useCurrentUserRole();
  // "staff" here means the support side of the thread, and only an
  // administrator is that. Everyone else — students, moderators, teachers —
  // sees this screen as the person who filed the request.
  const staff = isAdminRole(role);
  const currentUserId = auth.currentUser?.uid ?? null;

  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [attachment, setAttachment] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  // Messages already written but not yet echoed back by Firestore. Without
  // these the composer empties and nothing appears until the round-trip
  // finishes, which on a slow connection reads as "my message was lost".
  const [pending, setPending] = useState<TicketMessage[]>([]);
  // Only "Today" / "Yesterday" depend on the clock, so a minute is plenty.
  const nowMs = useRelativeTimeNow(60_000);
  // insets.bottom is the gesture-bar allowance. While the keyboard is open
  // the keyboard occupies that space, so keeping the padding leaves the
  // composer floating above the keys instead of sitting on them. Same pattern
  // DirectChatScreen uses.
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  // Whether the reader is already at the bottom of the thread. Auto-scrolling
  // regardless would throw somebody re-reading the original report back down
  // every time an image finishes loading.
  const atBottomRef = useRef(true);
  // One timer per optimistic message. Cleared when the server echoes it back;
  // if it fires first, the message is marked failed rather than left spinning.
  const failTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(
    () => () => {
      Object.values(failTimers.current).forEach(clearTimeout);
      failTimers.current = {};
    },
    [],
  );

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardVisible(false),
    );

    // Whenever the app comes back to the foreground, trust the platform over
    // the last event we happened to receive. Android can take the keyboard
    // away while this screen is paused — a picker, a notification tap, a
    // call — and the hide event never arrives, leaving the flag stuck on.
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") setKeyboardVisible(Keyboard.isVisible());
    });

    return () => {
      show.remove();
      hide.remove();
      appState.remove();
    };
  }, []);

  useEffect(() => {
    if (!ticketId) return;
    return subscribeToTicket(ticketId, (next) => {
      setTicket(next);
      setLoading(false);
    });
  }, [ticketId]);

  useEffect(() => {
    if (!ticketId) return;
    return subscribeToTicketMessages(ticketId, (rows) => {
      setMessages(rows);
      // Drop any optimistic row the server has now echoed back, matching on
      // author + text rather than id because Firestore assigned its own.
      setPending((current) =>
        current.filter((draft) => {
          // Compare the image as well as the text: two screenshot-only
          // messages both have an empty body, and matching on body alone
          // would clear both when only the first came back.
          const echoed = rows.some(
            (row) =>
              row.authorId === draft.authorId &&
              row.body === draft.body &&
              (row.imageUrl || null) === (draft.imageUrl || null),
          );
          if (echoed && failTimers.current[draft.id]) {
            clearTimeout(failTimers.current[draft.id]);
            delete failTimers.current[draft.id];
          }
          return !echoed;
        }),
      );
    });
  }, [ticketId]);

  // Opening the ticket is what "read" means. Runs once the side is known so a
  // student opening their own ticket never clears the staff marker.
  useEffect(() => {
    if (!ticketId || role === undefined) return;
    void markTicketRead(ticketId, staff ? "staff" : "user");
  }, [role, staff, ticketId]);

  const handlePickImage = useCallback(async () => {
    if (uploading) return;

    // Dismiss before the gallery opens, the way DirectChatScreen does.
    // The picker runs as its own Activity, so once this one is paused
    // keyboardDidHide may never reach JS — and keyboardVisible would stay
    // true after returning, collapsing the composer's bottom inset and
    // leaving it under the navigation bar.
    Keyboard.dismiss();

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
    } finally {
      setUploading(false);
    }
  }, [uploading]);

  // How long an optimistic message may sit unconfirmed before it is called
  // failed. Long enough for a slow campus connection, short enough that
  // nobody stares at "Sending…" wondering.
  const SEND_CONFIRM_TIMEOUT_MS = 12000;

  const sendMessage = useCallback(
    async (body: string, image: string | null) => {
      if (!ticketId || (!body.trim() && !image)) return;

      const draftId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      setPending((current) => [
        ...current,
        {
          id: draftId,
          authorId: auth.currentUser?.uid || "",
          authorName: "You",
          authorRole: String(role || "student"),
          fromStaff: staff,
          body,
          imageUrl: image,
          pending: true,
        },
      ]);

      // Firestore's local cache acknowledges the write immediately, so a
      // rejection by the rules never rejects the promise below. This timer is
      // the only thing that can notice the message never actually landed.
      failTimers.current[draftId] = setTimeout(() => {
        setPending((current) =>
          current.map((item) =>
            item.id === draftId ? { ...item, pending: false, failed: true } : item,
          ),
        );
        delete failTimers.current[draftId];
      }, SEND_CONFIRM_TIMEOUT_MS);

      try {
        await postTicketMessage({
          ticketId,
          body,
          fromStaff: staff,
          authorRole: String(role || "student"),
          imageUrl: image,
          ticketOwnerId: ticket?.userId ?? null,
          ticketNo: ticket?.ticketNo ?? null,
        });
      } catch (error) {
        console.error("Failed to send ticket reply:", error);
        clearTimeout(failTimers.current[draftId]);
        delete failTimers.current[draftId];
        setPending((current) =>
          current.map((item) =>
            item.id === draftId ? { ...item, pending: false, failed: true } : item,
          ),
        );
      }
    },
    [role, staff, ticket, ticketId],
  );

  const handleSend = useCallback(async () => {
    if (!ticketId || (!reply.trim() && !attachment) || sending) return;
    setSending(true);

    const body = reply;
    const image = attachment;

    // Clear the composer first and keep focus, so the keyboard stays up
    // between messages the way a chat should.
    setReply("");
    setAttachment(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      scrollRef.current?.scrollToEnd({ animated: true });
    });

    try {
      await sendMessage(body, image);
    } finally {
      setSending(false);
    }
  }, [attachment, reply, sendMessage, sending, ticketId]);

  const handleRetry = useCallback(
    (message: TicketMessage) => {
      setPending((current) => current.filter((item) => item.id !== message.id));
      void sendMessage(message.body, message.imageUrl ?? null);
    },
    [sendMessage],
  );

  const statusMeta = ticket ? TICKET_STATUS_META[ticket.status] : null;
  const priorityMeta = ticket ? TICKET_PRIORITY_META[ticket.priority] : null;

  const canReply = useMemo(
    () => ticket && ticket.status !== "closed",
    [ticket],
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.centered}>
          <ActivityIndicator color={theme.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!ticket) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={30} color={theme.textMuted} />
          <Text style={styles.missingTitle}>Request not found</Text>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.missingLink}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      enabled={Platform.OS !== "web"}
    >
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.topBarTitle}>{ticket.ticketNo}</Text>
        </View>

        {/* The status lives in the header, not only in the card that scrolls
            away, so the state of the request is readable at any scroll
            position. For an administrator the same chip is the control that
            changes it — one target that both shows the state and offers to
            edit it, instead of an abstract icon that opens something
            off-screen. */}
        {statusMeta && (
          <TouchableOpacity
            style={[styles.headerStatus, { backgroundColor: statusMeta.bg }]}
            onPress={() => staff && setShowControls(true)}
            disabled={!staff}
            activeOpacity={0.84}
            accessibilityRole={staff ? "button" : "text"}
            accessibilityLabel={
              staff
                ? `Status ${statusMeta.label}. Tap to manage this request.`
                : `Status ${statusMeta.label}`
            }
          >
            <Text style={[styles.headerStatusText, { color: statusMeta.color }]}>
              {statusMeta.label}
            </Text>
            {staff && (
              <Ionicons name="chevron-down" size={13} color={statusMeta.color} />
            )}
          </TouchableOpacity>
        )}
      </View>

      <View style={{ flex: 1 }}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onScroll={(event) => {
            const { layoutMeasurement, contentOffset, contentSize } =
              event.nativeEvent;
            atBottomRef.current =
              layoutMeasurement.height + contentOffset.y >= contentSize.height - 60;
          }}
          onContentSizeChange={() => {
            if (atBottomRef.current) {
              scrollRef.current?.scrollToEnd({ animated: false });
            }
          }}
        >
          <View style={styles.summaryCard}>
            <Text style={styles.subject}>{ticket.subject}</Text>

            <View style={styles.chipRow}>
              {statusMeta && (
                <View style={[styles.chip, { backgroundColor: statusMeta.bg }]}>
                  <Text style={[styles.chipText, { color: statusMeta.color }]}>
                    {statusMeta.label}
                  </Text>
                </View>
              )}
              {staff && priorityMeta && (
                <View style={[styles.chip, { backgroundColor: priorityMeta.bg }]}>
                  <Text style={[styles.chipText, { color: priorityMeta.color }]}>
                    {priorityMeta.label}
                  </Text>
                </View>
              )}
              <View style={[styles.chip, { backgroundColor: theme.surfaceSunken }]}>
                <Text style={[styles.chipText, { color: theme.textSecondary }]}>
                  {getCategoryLabel(ticket.category)}
                </Text>
              </View>
            </View>

            {/* Staff need to know who they are talking to without leaving. */}
            {staff && (
              <View style={styles.reporterBox}>
                <Text style={styles.reporterName}>{ticket.userName}</Text>
                <Text style={styles.reporterMeta}>
                  {[
                    ticket.userStudentId,
                    ticket.userRole,
                    ticket.userCourse,
                    ticket.userYearLevel,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
                {(ticket.appVersion || ticket.platform) && (
                  <Text style={styles.reporterMeta}>
                    {[ticket.platform, ticket.appVersion && `v${ticket.appVersion}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                )}
              </View>
            )}

            {ticket.assignedToName && (
              <Text style={styles.assignedText}>
                Handled by {ticket.assignedToName}
              </Text>
            )}

            {/* Raised from a question B.E.A. couldn't answer: staff see what
                was asked first, and the student sees where it came from. */}
            {!!ticket.sourceQuestion && (
              <View style={styles.beaNote}>
                <BeaOrb size={36} mood="unsure" />
                <View style={styles.beaNoteCopy}>
                  <Text style={styles.beaNoteLabel}>
                    {staff ? "Asked B.E.A. first" : "You asked B.E.A. first"}
                  </Text>
                  <Text style={styles.beaNoteQuestion} numberOfLines={3}>
                    “{ticket.sourceQuestion}”
                  </Text>
                </View>
              </View>
            )}
          </View>

          {/* The original report reads as the first message in the thread. */}
          <View style={[styles.bubble, styles.bubbleUser]}>
            <Text style={styles.bubbleAuthor}>
              {staff ? ticket.userName : "You"}
            </Text>
            <Text style={styles.bubbleBody}>{ticket.description}</Text>
            {!!ticket.imageUrl && (
              <TouchableOpacity
                onPress={() => setViewerImage(ticket.imageUrl!)}
                activeOpacity={0.9}
              >
                <Image
                  source={{ uri: ticket.imageUrl }}
                  style={styles.bubbleImage}
                  contentFit="cover"
                />
              </TouchableOpacity>
            )}
            <Text style={styles.bubbleTime}>
              {formatChatTimeLabel(timestampMillis(ticket.createdAt), nowMs)}
            </Text>
          </View>

          {[...messages, ...pending].map((message, index, all) => {
            // A day label wherever the conversation crosses into a new day,
            // measured from the message before (or the request itself).
            const ms = timestampMillis(message.createdAt);
            const previousMs =
              index === 0
                ? timestampMillis(ticket.createdAt)
                : timestampMillis(all[index - 1].createdAt);
            const newDay =
              !!ms && !!previousMs && !sameDay(new Date(ms), new Date(previousMs));
            return (
            <React.Fragment key={message.id}>
            {newDay && (
              <Text style={styles.dayLabel} accessibilityRole="header">
                {formatDayLabel(ms, nowMs)}
              </Text>
            )}
            <View
              style={[
                styles.bubble,
                message.fromStaff ? styles.bubbleStaff : styles.bubbleUser,
                message.pending && styles.bubblePending,
                message.failed && styles.bubbleFailed,
              ]}
            >
              <Text
                style={[
                  styles.bubbleAuthor,
                  message.fromStaff && styles.bubbleAuthorStaff,
                ]}
              >
                {message.authorId === currentUserId ? "You" : message.authorName}
                {message.fromStaff ? " · Support" : ""}
              </Text>
              {!!message.body && (
                <Text style={styles.bubbleBody}>{message.body}</Text>
              )}
              {!!message.imageUrl && (
                <TouchableOpacity
                  onPress={() => setViewerImage(message.imageUrl!)}
                  activeOpacity={0.9}
                >
                  <Image
                    source={{ uri: message.imageUrl }}
                    style={styles.bubbleImage}
                    contentFit="cover"
                  />
                </TouchableOpacity>
              )}
              <View style={styles.bubbleFooter}>
                {message.failed ? (
                  <TouchableOpacity
                    style={styles.retryRow}
                    onPress={() => handleRetry(message)}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="alert-circle" size={12} color={theme.danger} />
                    <Text style={styles.retryText}>Not sent · Tap to retry</Text>
                  </TouchableOpacity>
                ) : message.pending ? (
                  <>
                    <Ionicons name="time-outline" size={11} color={theme.textMuted} />
                    <Text style={styles.bubbleTime}>Sending…</Text>
                  </>
                ) : (
                  <Text style={styles.bubbleTime}>{formatClockTime(ms)}</Text>
                )}
              </View>
            </View>
            </React.Fragment>
            );
          })}

          {ticket.status === "closed" && (
            <View style={styles.closedNote}>
              <Ionicons name="lock-closed-outline" size={15} color={theme.textSecondary} />
              <Text style={styles.closedNoteText}>
                This request is closed. Report a new problem if you still need
                help.
              </Text>
            </View>
          )}
        </ScrollView>

        {canReply && (
          <View
            style={[
              styles.composerWrap,
              {
                paddingBottom: keyboardVisible
                  ? 10
                  : Math.max(insets.bottom, 10),
              },
            ]}
          >
            {(attachment || uploading) && (
              <View style={styles.attachmentPreview}>
                {uploading ? (
                  <View style={styles.attachmentLoading}>
                    <ActivityIndicator size="small" color={theme.accent} />
                    <Text style={styles.attachmentLoadingText}>
                      Uploading screenshot…
                    </Text>
                  </View>
                ) : (
                  <>
                    <Image
                      source={{ uri: attachment! }}
                      style={styles.attachmentThumb}
                      contentFit="cover"
                    />
                    <Text style={styles.attachmentLabel}>Screenshot attached</Text>
                    <TouchableOpacity
                      onPress={() => setAttachment(null)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Ionicons name="close-circle" size={20} color={theme.textMuted} />
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}

            <View style={styles.composer}>
              {/* A photo of the broken screen is the most useful thing on a
                  bug report and the thing nobody thinks to ask for. */}
              <TouchableOpacity
                style={styles.attachButton}
                onPress={handlePickImage}
                disabled={uploading}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="image-outline"
                  size={21}
                  color={uploading ? theme.textMuted : theme.accent}
                />
              </TouchableOpacity>

              <TextInput
                ref={inputRef}
                style={styles.composerInput}
                value={reply}
                onChangeText={setReply}
                placeholder={staff ? "Reply to this user…" : "Add more details…"}
                placeholderTextColor={theme.textMuted}
                multiline
              />
              <TouchableOpacity
                style={[
                  styles.sendButton,
                  !reply.trim() && !attachment && styles.sendButtonDisabled,
                ]}
                onPress={handleSend}
                disabled={(!reply.trim() && !attachment) || sending || uploading}
                activeOpacity={0.86}
              >
                <Ionicons name="send" size={17} color={theme.onPrimary} />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      {/* A bottom sheet rather than a panel inside the thread. The old panel
          rendered above the messages, so on a long conversation — where the
          reader is at the bottom — tapping the control scrolled nothing into
          view and appeared to do nothing at all. A sheet arrives at the
          bottom of the screen wherever the thread is scrolled to, lands under
          the thumb rather than at the top edge, and dismisses by tapping
          away. */}
      <Modal
        visible={staff && showControls}
        transparent
        animationType="slide"
        onRequestClose={() => setShowControls(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setShowControls(false)}
        >
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />

            <Text style={styles.sheetTitle}>Manage request</Text>
            <Text style={styles.sheetSubtitle} numberOfLines={1}>
              {ticket.ticketNo} · {ticket.userName}
            </Text>

            <Text style={styles.sheetLabel}>Status</Text>
            <View style={styles.sheetRow}>
              {STATUS_FLOW.map((value) => {
                const meta = TICKET_STATUS_META[value];
                const active = ticket.status === value;
                return (
                  <TouchableOpacity
                    key={value}
                    style={[
                      styles.sheetChip,
                      active && { backgroundColor: meta.bg, borderColor: meta.color },
                    ]}
                    onPress={() => void updateTicketStatus(ticket.id, value)}
                    activeOpacity={0.84}
                  >
                    {active && (
                      <Ionicons name="checkmark" size={13} color={meta.color} />
                    )}
                    <Text
                      style={[styles.sheetChipText, active && { color: meta.color }]}
                    >
                      {meta.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.sheetLabel}>Priority</Text>
            <View style={styles.sheetRow}>
              {PRIORITIES.map((value) => {
                const meta = TICKET_PRIORITY_META[value];
                const active = ticket.priority === value;
                return (
                  <TouchableOpacity
                    key={value}
                    style={[
                      styles.sheetChip,
                      active && { backgroundColor: meta.bg, borderColor: meta.color },
                    ]}
                    onPress={() => void updateTicketPriority(ticket.id, value)}
                    activeOpacity={0.84}
                  >
                    {active && (
                      <Ionicons name="checkmark" size={13} color={meta.color} />
                    )}
                    <Text
                      style={[styles.sheetChipText, active && { color: meta.color }]}
                    >
                      {meta.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.sheetLabel}>Assignment</Text>
            <TouchableOpacity
              style={styles.sheetAssign}
              onPress={() =>
                void assignTicket(
                  ticket.id,
                  ticket.assignedTo === currentUserId ? null : currentUserId,
                  ticket.assignedTo === currentUserId
                    ? null
                    : auth.currentUser?.displayName || "Staff",
                )
              }
              activeOpacity={0.84}
            >
              <Ionicons
                name={
                  ticket.assignedTo === currentUserId
                    ? "person-remove-outline"
                    : "person-add-outline"
                }
                size={17}
                color={theme.accent}
              />
              <Text style={styles.sheetAssignText}>
                {ticket.assignedTo === currentUserId
                  ? "Release this request"
                  : ticket.assignedToName
                    ? `Take over from ${ticket.assignedToName}`
                    : "Assign to me"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.sheetDone}
              onPress={() => setShowControls(false)}
              activeOpacity={0.86}
            >
              <Text style={styles.sheetDoneText}>Done</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <ImageZoomViewer
        images={viewerImage ? [viewerImage] : []}
        startIndex={0}
        visible={!!viewerImage}
        showActions={false}
        onClose={() => setViewerImage(null)}
      />
    </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  missingTitle: { color: c.textPrimary, fontSize: 15, fontWeight: "900" },
  missingLink: { color: c.accent, fontSize: 13.5, fontWeight: "800" },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  topBarTitle: { color: c.textPrimary, fontSize: 15, fontWeight: "900", letterSpacing: 0.4 },

  content: { padding: 16, gap: 10 },

  summaryCard: {
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 16,
    padding: 14,
    gap: 9,
  },
  subject: { color: c.textPrimary, fontSize: 16, fontWeight: "900" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { fontSize: 11.5, fontWeight: "900" },
  reporterBox: {
    backgroundColor: c.surfaceSunken,
    borderRadius: 12,
    padding: 11,
    gap: 2,
  },
  reporterName: { color: c.textPrimary, fontSize: 13, fontWeight: "800" },
  reporterMeta: { color: c.textMuted, fontSize: 11.5 },
  assignedText: { color: c.accent, fontSize: 12, fontWeight: "800" },
  beaNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
    padding: 10,
    borderRadius: 14,
    backgroundColor: c.surfaceSunken,
  },
  beaNoteCopy: { flex: 1, minWidth: 0 },
  beaNoteLabel: { color: c.textMuted, fontSize: 11.5, fontWeight: "700", letterSpacing: 0.2 },
  beaNoteQuestion: { color: c.textPrimary, fontSize: 13.5, lineHeight: 19, marginTop: 2 },

  headerStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  headerStatusText: { fontSize: 12, fontWeight: "900" },

  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(32,16,12,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: c.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 30,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 999,
    backgroundColor: c.borderStrong,
    marginBottom: 14,
  },
  sheetTitle: { color: c.textPrimary, fontSize: 17, fontWeight: "900" },
  sheetSubtitle: { color: c.textMuted, fontSize: 12.5, marginTop: 2 },
  sheetLabel: {
    color: c.accent,
    fontSize: 11.5,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginTop: 18,
    marginBottom: 8,
  },
  sheetRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  sheetChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surfaceRaised,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  sheetChipText: { color: c.textMuted, fontSize: 13, fontWeight: "800" },
  sheetAssign: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: c.accentSoft,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  sheetAssignText: { color: c.accent, fontSize: 13.5, fontWeight: "800" },
  sheetDone: {
    alignItems: "center",
    backgroundColor: c.primary,
    borderRadius: 15,
    paddingVertical: 14,
    marginTop: 22,
  },
  sheetDoneText: { color: c.background, fontSize: 14.5, fontWeight: "900" },

  bubble: {
    maxWidth: "88%",
    borderRadius: 16,
    padding: 12,
    gap: 4,
  },
  bubbleUser: {
    alignSelf: "flex-start",
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
  },
  bubbleStaff: {
    alignSelf: "flex-end",
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  bubbleAuthor: { color: c.textMuted, fontSize: 11, fontWeight: "900" },
  bubbleAuthorStaff: { color: c.accent },
  bubbleBody: { color: c.textPrimary, fontSize: 13.5, lineHeight: 19 },
  bubbleTime: { color: c.textMuted, fontSize: 10.5 },
  dayLabel: {
    alignSelf: "center",
    marginTop: 8,
    marginBottom: 2,
    fontSize: 11.5,
    fontWeight: "700",
    color: c.textMuted,
  },
  bubbleFooter: { flexDirection: "row", alignItems: "center", gap: 4 },
  bubblePending: { opacity: 0.65 },
  bubbleFailed: { borderColor: c.danger, backgroundColor: c.dangerSoft },
  retryRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  retryText: { color: c.danger, fontSize: 10.5, fontWeight: "800" },
  bubbleImage: {
    width: 200,
    height: 150,
    borderRadius: 10,
    marginTop: 6,
    backgroundColor: c.border,
  },

  closedNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: c.border,
    borderRadius: 12,
    padding: 12,
    marginTop: 6,
  },
  closedNoteText: { flex: 1, color: "#6d4a41", fontSize: 12, lineHeight: 17 },

  composerWrap: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.background,
    paddingTop: 10,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 9,
    paddingHorizontal: 14,
  },
  attachButton: {
    width: 38,
    height: 38,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentPreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 14,
    marginBottom: 9,
    backgroundColor: c.accentSoft,
    borderRadius: 12,
    padding: 8,
  },
  attachmentThumb: { width: 38, height: 38, borderRadius: 8 },
  attachmentLabel: { flex: 1, color: c.accent, fontSize: 12.5, fontWeight: "800" },
  attachmentLoading: { flexDirection: "row", alignItems: "center", gap: 9, padding: 4 },
  attachmentLoadingText: { color: c.accent, fontSize: 12.5, fontWeight: "800" },
  composerInput: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: c.textPrimary,
    fontSize: 14,
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 999,
    backgroundColor: c.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: { backgroundColor: c.borderStrong },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

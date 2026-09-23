// app/SignInHelpScreen.tsx
//
// For someone stuck at the sign-in screen. Most sign-in trouble is one of a
// handful of problems, so those come first, each with what to do. Then how
// to reach the school, and — if that isn't enough — a request they can send
// without an account, which admins answer by email or phone.
import { useThemeColors } from "@/contexts/ThemeContext";
import {
  isReachableContact,
  sendSignInHelpRequest,
  SIGN_IN_LIMITS,
  SIGN_IN_PROBLEMS,
  SUPPORT_CONTACT,
  type SignInProblem,
} from "@/utils/signInHelp";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";

import BeaOrb from "./(main)/components/BeaOrb";

type Problem = {
  id: string;
  question: string;
  answer: string;
  /** Opens the password reset, for the problem it solves. */
  resetButton?: boolean;
};

// Written to match how BondEd accounts actually work: the school creates
// them, sign-in is by ID, and a reset code goes to a verified recovery email.
const PROBLEMS: Problem[] = [
  {
    id: "forgot",
    question: "I forgot my password",
    answer:
      "Tap Reset my password and enter your ID. We'll email a 6-digit code to the recovery email on your account, then you choose a new password.",
    resetButton: true,
  },
  {
    id: "code",
    question: "I didn't get the code",
    answer:
      "Check your spam or junk folder, and wait for the resend timer before asking for another. The code only goes to a recovery email you added and verified in Edit Profile — if you never did, the school has to reset your password for you.",
  },
  {
    id: "account",
    question: "I don't have an account, or my ID isn't recognised",
    answer:
      "BondEd accounts are created by the school, not by signing up. Check that you typed your ID exactly as it was given to you, for example 2021-00123. If it still isn't recognised, ask the school to register you.",
  },
  {
    id: "first",
    question: "It's my first time signing in",
    answer:
      "Sign in with your ID and the temporary password the school gave you. BondEd then helps you finish setting up your profile.",
  },
  {
    id: "attempts",
    question: "It says there were too many attempts",
    answer:
      "For your safety, signing in pauses after several wrong passwords. Wait a few minutes and try again, or reset your password.",
  },
];

export default function SignInHelpScreen() {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();

  const [openProblem, setOpenProblem] = useState<string | null>(null);

  // ── The request ────────────────────────────────────────────────────────
  const [studentID, setStudentID] = useState((params.id ?? "").toString());
  const [fullName, setFullName] = useState("");
  const [contact, setContact] = useState("");
  const [problem, setProblem] = useState<SignInProblem>("forgot_password");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTicketNo, setSentTicketNo] = useState<string | null>(null);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/LoginScreen");
  };

  const openReset = () =>
    router.push({ pathname: "/ForgotPasswordScreen", params: { id: studentID.trim() } });

  const email = () =>
    Linking.openURL(
      `mailto:${SUPPORT_CONTACT.email}?subject=${encodeURIComponent("BondED sign-in help")}`,
    ).catch(() => setError(`Couldn't open email. Write to ${SUPPORT_CONTACT.email}.`));
  const call = () =>
    Linking.openURL(`tel:${SUPPORT_CONTACT.phone}`).catch(() =>
      setError(`Couldn't open the dialer. Call ${SUPPORT_CONTACT.phoneDisplay}.`),
    );

  const submit = async () => {
    if (sending) return;
    const id = studentID.trim();
    const name = fullName.trim();
    if (id.length < 3) return setError("Enter your ID, for example 2021-00123.");
    if (name.length < 2) return setError("Enter your full name.");
    if (!isReachableContact(contact)) {
      return setError("Enter an email or phone number the school can reach you on.");
    }
    setError(null);
    setSending(true);
    try {
      const ticketNo = await sendSignInHelpRequest({
        studentID: id,
        fullName: name,
        contact,
        problem,
        message,
      });
      setSentTicketNo(ticketNo || "sent");
    } catch (sendError) {
      setError(
        sendError instanceof Error ? sendError.message : "Couldn't send your request. Please try again.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right", "bottom"]}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={goBack}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel="Back to sign in"
        >
          <Ionicons name="chevron-back" size={24} color={theme.onChrome} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Sign-in help</Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAvoidingView automaticOffset style={styles.flex} behavior="padding">
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.intro}>
            <BeaOrb size={64} mood="unsure" animated tappable />
            <Text style={styles.introTitle}>Having trouble signing in?</Text>
            <Text style={styles.introText}>
              Most problems are one of these. Tap one to see what to do.
            </Text>
          </View>

          {/* ── Common problems ─────────────────────────────────────────── */}
          <View style={styles.card}>
            {PROBLEMS.map((item, index) => {
              const open = openProblem === item.id;
              return (
                <View key={item.id}>
                  {index > 0 && <View style={styles.divider} />}
                  <TouchableOpacity
                    style={styles.problemRow}
                    onPress={() => setOpenProblem(open ? null : item.id)}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                  >
                    <Text style={styles.problemQuestion}>{item.question}</Text>
                    <Ionicons
                      name={open ? "chevron-up" : "chevron-down"}
                      size={18}
                      color={theme.onChromeMuted}
                    />
                  </TouchableOpacity>
                  {open && (
                    <View style={styles.problemAnswerWrap}>
                      <Text style={styles.problemAnswer}>{item.answer}</Text>
                      {item.resetButton && (
                        <TouchableOpacity
                          style={styles.secondaryButton}
                          onPress={openReset}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                        >
                          <Ionicons name="key-outline" size={16} color={theme.onAccent} />
                          <Text style={styles.secondaryButtonText}>Reset my password</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>

          {/* ── Contact the school ──────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>Contact the school</Text>
          <View style={styles.card}>
            <View style={styles.contactButtons}>
              <TouchableOpacity
                style={styles.contactButton}
                onPress={email}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`Email ${SUPPORT_CONTACT.email}`}
              >
                <Ionicons name="mail-outline" size={20} color={theme.accent} />
                <Text style={styles.contactButtonLabel}>Email</Text>
                <Text style={styles.contactButtonValue} numberOfLines={1}>
                  {SUPPORT_CONTACT.email}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.contactButton}
                onPress={call}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`Call ${SUPPORT_CONTACT.phoneDisplay}`}
              >
                <Ionicons name="call-outline" size={20} color={theme.accent} />
                <Text style={styles.contactButtonLabel}>Call</Text>
                <Text style={styles.contactButtonValue} numberOfLines={1}>
                  {SUPPORT_CONTACT.phoneDisplay}
                </Text>
              </TouchableOpacity>
            </View>
            <View style={styles.hoursRow}>
              <Ionicons name="time-outline" size={15} color={theme.onChromeMuted} />
              <Text style={styles.hoursText}>{SUPPORT_CONTACT.hours}</Text>
            </View>
          </View>

          {/* ── A request without an account ────────────────────────────── */}
          <Text style={styles.sectionTitle}>Send a sign-in request</Text>
          {sentTicketNo ? (
            <View style={[styles.card, styles.sentCard]}>
              <Ionicons name="checkmark-circle" size={40} color={theme.accent} />
              <Text style={styles.sentTitle}>
                {sentTicketNo === "sent" ? "Request sent" : `Request sent · ${sentTicketNo}`}
              </Text>
              <Text style={styles.sentText}>
                The school will contact you at {contact.trim()} during office hours
                {sentTicketNo === "sent" ? "." : ". Keep this number to quote when they do."}
              </Text>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={goBack}
                activeOpacity={0.85}
                accessibilityRole="button"
              >
                <Text style={styles.primaryButtonText}>Back to sign in</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.formLead}>
                Still stuck? Send this and the school will reply by email or phone
                during office hours.
              </Text>

              <Text style={styles.label}>Your ID</Text>
              <TextInput
                style={styles.input}
                value={studentID}
                onChangeText={setStudentID}
                placeholder="e.g. 2021-00123"
                placeholderTextColor={theme.onChromeMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={SIGN_IN_LIMITS.idMax}
              />

              <Text style={styles.label}>Full name</Text>
              <TextInput
                style={styles.input}
                value={fullName}
                onChangeText={setFullName}
                placeholder="As it appears in school records"
                placeholderTextColor={theme.onChromeMuted}
                autoCapitalize="words"
                maxLength={SIGN_IN_LIMITS.nameMax}
              />

              <Text style={styles.label}>Email or phone number</Text>
              <TextInput
                style={styles.input}
                value={contact}
                onChangeText={setContact}
                placeholder="Where the school can reach you"
                placeholderTextColor={theme.onChromeMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={SIGN_IN_LIMITS.contactMax}
              />

              <Text style={styles.label}>What&apos;s the problem?</Text>
              <View style={styles.problemChips}>
                {SIGN_IN_PROBLEMS.map((option) => {
                  const active = problem === option.value;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[styles.problemChip, active && styles.problemChipActive]}
                      onPress={() => setProblem(option.value)}
                      activeOpacity={0.8}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                    >
                      <Text style={[styles.problemChipText, active && styles.problemChipTextActive]}>
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.label}>Anything else (optional)</Text>
              <TextInput
                style={[styles.input, styles.messageInput]}
                value={message}
                onChangeText={setMessage}
                placeholder="What happened when you tried to sign in?"
                placeholderTextColor={theme.onChromeMuted}
                multiline
                maxLength={SIGN_IN_LIMITS.messageMax}
                textAlignVertical="top"
              />

              <Text style={styles.verifyNote}>
                Anyone could type someone else&apos;s ID, so the school will confirm it&apos;s
                really you before changing anything on your account.
              </Text>

              {!!error && (
                <View style={styles.errorBox} accessibilityLiveRegion="polite">
                  <Ionicons name="alert-circle" size={18} color={theme.danger} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.primaryButton, sending && styles.buttonDisabled]}
                onPress={() => void submit()}
                disabled={sending}
                activeOpacity={0.85}
                accessibilityRole="button"
              >
                {sending ? (
                  <ActivityIndicator color={theme.onAccent} />
                ) : (
                  <Text style={styles.primaryButtonText}>Send request</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.primary },
    flex: { flex: 1 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 16,
      backgroundColor: c.primary,
    },
    headerTitle: { color: c.onChrome, fontSize: 18, fontWeight: "700" },
    content: { padding: 24, paddingBottom: 32 },
    intro: { alignItems: "center", marginBottom: 20 },
    introTitle: {
      color: c.onChrome,
      fontSize: 20,
      fontWeight: "800",
      marginTop: 10,
      textAlign: "center",
    },
    introText: {
      color: c.onChromeMuted,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 4,
      textAlign: "center",
    },
    sectionTitle: {
      color: c.accent,
      fontSize: 12.5,
      fontWeight: "800",
      letterSpacing: 0.6,
      textTransform: "uppercase",
      marginTop: 20,
      marginBottom: 8,
    },
    card: {
      backgroundColor: "rgba(0,0,0,0.22)",
      borderWidth: 1,
      borderColor: "rgba(224,165,61,0.28)",
      borderRadius: 14,
      padding: 16,
    },
    divider: { height: 1, backgroundColor: "rgba(224,165,61,0.18)" },
    problemRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 12,
    },
    problemQuestion: { flex: 1, color: c.onChrome, fontSize: 14.5, fontWeight: "700" },
    problemAnswerWrap: { paddingBottom: 12 },
    problemAnswer: { color: c.onChromeMuted, fontSize: 13.5, lineHeight: 20 },
    secondaryButton: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 7,
      backgroundColor: c.accent,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginTop: 12,
    },
    secondaryButtonText: { color: c.onAccent, fontSize: 14, fontWeight: "800" },
    contactButtons: { flexDirection: "row", gap: 10 },
    contactButton: {
      flex: 1,
      alignItems: "center",
      gap: 4,
      paddingVertical: 16,
      paddingHorizontal: 8,
      borderRadius: 12,
      backgroundColor: "rgba(0,0,0,0.22)",
      borderWidth: 1,
      borderColor: "rgba(224,165,61,0.35)",
    },
    contactButtonLabel: { color: c.onChrome, fontSize: 14, fontWeight: "800" },
    contactButtonValue: { color: c.onChromeMuted, fontSize: 12 },
    hoursRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      marginTop: 12,
    },
    hoursText: { color: c.onChromeMuted, fontSize: 13 },
    formLead: { color: c.onChromeMuted, fontSize: 13.5, lineHeight: 20 },
    label: {
      color: c.accent,
      fontSize: 13,
      fontWeight: "600",
      marginBottom: 6,
      marginTop: 16,
    },
    input: {
      backgroundColor: "rgba(0,0,0,0.28)",
      borderWidth: 1,
      borderColor: "rgba(224,165,61,0.35)",
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: Platform.OS === "ios" ? 14 : 10,
      color: c.onChrome,
      fontSize: 15,
    },
    messageInput: { minHeight: 90 },
    problemChips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    problemChip: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: "rgba(224,165,61,0.35)",
    },
    problemChipActive: { backgroundColor: c.accent, borderColor: c.accent },
    problemChipText: { color: c.onChrome, fontSize: 13, fontWeight: "700" },
    problemChipTextActive: { color: c.onAccent },
    verifyNote: { color: c.onChromeMuted, fontSize: 12, lineHeight: 16, marginTop: 16 },
    errorBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: "rgba(138,18,20,0.35)",
      borderRadius: 10,
      padding: 12,
      marginTop: 16,
    },
    errorText: { color: c.danger, fontSize: 13, flex: 1 },
    primaryButton: {
      backgroundColor: c.accent,
      borderRadius: 10,
      paddingVertical: 16,
      alignItems: "center",
      alignSelf: "stretch",
      marginTop: 20,
    },
    buttonDisabled: { opacity: 0.6 },
    primaryButtonText: { color: c.onAccent, fontSize: 16, fontWeight: "700" },
    sentCard: { alignItems: "center", gap: 6 },
    sentTitle: { color: c.onChrome, fontSize: 16, fontWeight: "800", textAlign: "center" },
    sentText: { color: c.onChromeMuted, fontSize: 13.5, lineHeight: 20, textAlign: "center" },
  });

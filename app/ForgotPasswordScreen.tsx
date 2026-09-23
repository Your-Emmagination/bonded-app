import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { PASSWORD_MIN_LENGTH, validateNewPassword } from "@/utils/passwordPolicy";
import {
    confirmPasswordReset,
    requestPasswordResetCode,
} from "@/utils/passwordReset";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Keyboard,
    Pressable,
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
import { SafeAreaView } from "react-native-safe-area-context";

const RESEND_COOLDOWN_SECONDS = 60;
const CODE_LENGTH = 6;

/**
 * The reset, in the order a person thinks about it: who am I, prove it,
 * what's my new password. The code isn't checked until the last step (the
 * Worker checks code and password together), so a wrong code sends you back
 * to step two with the reason.
 */
type Step = "id" | "code" | "password" | "done";
const STEPS: { key: Exclude<Step, "done">; label: string }[] = [
  { key: "id", label: "Your ID" },
  { key: "code", label: "Code" },
  { key: "password", label: "New password" },
];

export default function ForgotPasswordScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();

  const [step, setStep] = useState<Step>("id");
  const [studentID, setStudentID] = useState((params.id ?? "").toString());
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  // The ID the running resend timer belongs to (lowercased, as the Worker
  // matches it). Another ID isn't held up by it.
  const [cooldownId, setCooldownId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focused, setFocused] = useState<"id" | "code" | "new" | "confirm" | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codeInputRef = useRef<TextInput>(null);

  const startCooldown = useCallback(() => {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCooldown((value) => {
        if (value <= 1 && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return value - 1;
      });
    }, 1000);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  // Sign-in uses the ID the school issued, never an email. The Worker would
  // look for an account *named* "juan@gmail.com", find none, and — so nobody
  // can probe which IDs exist — still say a code was sent. So it is caught
  // here, before anyone waits for an email that is never coming.
  const idLooksLikeEmail = studentID.includes("@");
  const trimmedId = studentID.trim();
  const idKey = trimmedId.toLowerCase();

  const sendCode = useCallback(async () => {
    if (loading) return;
    Keyboard.dismiss();
    setError(null);
    setNotice(null);

    if (!trimmedId) {
      setError("Enter your student or employee ID.");
      return;
    }
    if (idLooksLikeEmail) {
      setError("That looks like an email. Enter your student or employee ID instead.");
      return;
    }

    // A code went to this same ID under a minute ago. It's good for 15
    // minutes and the Worker won't send another yet, so go to it rather
    // than leave the tap doing nothing.
    if (cooldown > 0 && cooldownId === idKey) {
      if (step === "id") {
        setStep("code");
        setNotice("We already sent a code to this ID. Check your email.");
        setTimeout(() => codeInputRef.current?.focus(), 250);
      }
      return;
    }

    setLoading(true);
    try {
      await requestPasswordResetCode(trimmedId);
      // A new code replaces the old one, so digits typed for it are useless.
      setCode("");
      setCooldownId(idKey);
      setStep("code");
      startCooldown();
      setTimeout(() => codeInputRef.current?.focus(), 250);
    } catch (err: any) {
      setError(err?.message || "Couldn't send the code. Try again.");
    } finally {
      setLoading(false);
    }
  }, [loading, cooldown, cooldownId, idKey, step, trimmedId, idLooksLikeEmail, startCooldown]);

  const continueWithCode = useCallback(() => {
    setError(null);
    if (code.length !== CODE_LENGTH) {
      setError("Enter all 6 digits from the email.");
      return;
    }
    Keyboard.dismiss();
    setStep("password");
  }, [code]);

  // The same rules the Worker enforces, shown as they are met.
  const checks = useMemo(
    () => [
      { label: `At least ${PASSWORD_MIN_LENGTH} characters`, ok: newPassword.length >= PASSWORD_MIN_LENGTH },
      { label: "Includes a number", ok: /[0-9]/.test(newPassword) },
      { label: "Includes a symbol (e.g. ! @ # $)", ok: /[^A-Za-z0-9]/.test(newPassword) },
      { label: "Both passwords match", ok: newPassword.length > 0 && newPassword === confirmPassword },
    ],
    [newPassword, confirmPassword],
  );
  const passwordReady = checks.every((check) => check.ok);

  const submitReset = useCallback(async () => {
    if (loading) return;
    Keyboard.dismiss();
    setError(null);

    const policyError = validateNewPassword(newPassword);
    if (policyError) {
      setError(policyError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The two passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      await confirmPasswordReset(trimmedId, code, newPassword);
      setStep("done");
    } catch (err: any) {
      const message: string = err?.message || "Couldn't reset the password. Try again.";
      // A wrong or expired code is a step-two problem; send them back there.
      if (/code/i.test(message)) {
        setCode("");
        setStep("code");
        setTimeout(() => codeInputRef.current?.focus(), 250);
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [loading, newPassword, confirmPassword, trimmedId, code]);

  const goBack = useCallback(() => {
    setError(null);
    setNotice(null);
    if (step === "code") setStep("id");
    else if (step === "password") setStep("code");
    else router.replace("/LoginScreen");
  }, [router, step]);

  const stepIndex = step === "done" ? STEPS.length : STEPS.findIndex((item) => item.key === step);

  const heading = {
    id: {
      icon: "key-outline" as const,
      title: "Forgot your password?",
      text: "Enter your ID and we'll email a 6-digit code to the recovery email on your account.",
    },
    code: {
      icon: "mail-unread-outline" as const,
      title: "Check your email",
      text: `If ${trimmedId || "that ID"} has a verified recovery email, a 6-digit code is on its way. It expires in 15 minutes.`,
    },
    password: {
      icon: "lock-closed-outline" as const,
      title: "Choose a new password",
      text: "Pick something only you know. You'll use it the next time you sign in.",
    },
    done: {
      icon: "checkmark-circle" as const,
      title: "Password updated",
      text: "You can sign in with your new password now.",
    },
  }[step];

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right", "bottom"]}>
      <StatusBar style="light" />

      <View style={styles.header}>
        {step !== "done" ? (
          <TouchableOpacity
            onPress={goBack}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel={step === "id" ? "Back to sign in" : "Back a step"}
          >
            <Ionicons name="chevron-back" size={24} color={theme.onChrome} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 26 }} />
        )}
        <Text style={styles.headerTitle}>Reset password</Text>
        <View style={{ width: 26 }} />
      </View>

      {/* Where you are in three steps. */}
      <View style={styles.progress} accessibilityLabel={`Step ${Math.min(stepIndex + 1, 3)} of 3`}>
        {STEPS.map((item, index) => {
          const complete = index < stepIndex;
          const current = index === stepIndex;
          return (
            <View key={item.key} style={styles.progressItem}>
              <View style={[styles.progressBar, (complete || current) && styles.progressBarOn]} />
              <Text style={[styles.progressLabel, (complete || current) && styles.progressLabelOn]}>
                {complete ? "✓ " : ""}
                {item.label}
              </Text>
            </View>
          );
        })}
      </View>

      <KeyboardAvoidingView automaticOffset style={styles.flex} behavior="padding">
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <View style={[styles.heroIcon, step === "done" && styles.heroIconDone]}>
              <Ionicons
                name={heading.icon}
                size={step === "done" ? 40 : 28}
                color={step === "done" ? theme.success : theme.accent}
              />
            </View>
            <Text style={styles.heroTitle}>{heading.title}</Text>
            <Text style={styles.heroText}>{heading.text}</Text>
          </View>

          <View style={styles.sheet}>
            {step === "id" && (
              <>
                <Text style={styles.label}>ID number</Text>
                <View
                  style={[
                    styles.field,
                    focused === "id" && styles.fieldFocused,
                    idLooksLikeEmail && styles.fieldWarning,
                  ]}
                >
                  <Ionicons name="id-card-outline" size={18} color={theme.textMuted} />
                  <TextInput
                    style={styles.fieldInput}
                    value={studentID}
                    onChangeText={(text) => {
                      setStudentID(text);
                      if (error) setError(null);
                    }}
                    onFocus={() => setFocused("id")}
                    onBlur={() => setFocused(null)}
                    placeholder="Student or employee ID"
                    placeholderTextColor={theme.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="username"
                    textContentType="username"
                    returnKeyType="send"
                    onSubmitEditing={() => void sendCode()}
                    editable={!loading}
                  />
                </View>
                {idLooksLikeEmail && (
                  <View style={styles.inlineWarning}>
                    <Ionicons name="alert-circle-outline" size={15} color={theme.warning} />
                    <Text style={styles.inlineWarningText}>
                      That looks like an email. Sign-in uses your student or employee ID.
                    </Text>
                  </View>
                )}

                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    (loading || !trimmedId || idLooksLikeEmail) && styles.btnDisabled,
                  ]}
                  onPress={sendCode}
                  disabled={loading || !trimmedId || idLooksLikeEmail}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                >
                  {loading ? (
                    <ActivityIndicator color={theme.onPrimary} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Send code</Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.linkRow}
                  onPress={() =>
                    router.push({ pathname: "/SignInHelpScreen", params: { id: trimmedId } } as any)
                  }
                  accessibilityRole="button"
                >
                  <Ionicons name="help-buoy-outline" size={16} color={theme.primary} />
                  <Text style={styles.linkText}>No recovery email? Get help signing in</Text>
                </TouchableOpacity>
              </>
            )}

            {step === "code" && (
              <>
                {notice && (
                  <View style={styles.noticeRow}>
                    <Ionicons name="mail-outline" size={16} color={theme.primary} />
                    <Text style={styles.noticeText}>{notice}</Text>
                  </View>
                )}
                <Text style={styles.label}>6-digit code</Text>
                {/* Six boxes over one real input, so paste and the keyboard's
                    "copy code" suggestion both work. */}
                <Pressable
                  style={styles.codeRow}
                  onPress={() => codeInputRef.current?.focus()}
                  accessibilityLabel="Enter the 6-digit code"
                >
                  {Array.from({ length: CODE_LENGTH }, (_, index) => {
                    const digit = code[index] || "";
                    const active = focused === "code" && index === Math.min(code.length, CODE_LENGTH - 1);
                    return (
                      <View
                        key={index}
                        style={[styles.codeBox, !!digit && styles.codeBoxFilled, active && styles.codeBoxActive]}
                      >
                        <Text style={styles.codeDigit}>{digit}</Text>
                      </View>
                    );
                  })}
                  <TextInput
                    ref={codeInputRef}
                    value={code}
                    onChangeText={(text) => {
                      const digits = text.replace(/\D/g, "").slice(0, CODE_LENGTH);
                      setCode(digits);
                      if (error) setError(null);
                    }}
                    onFocus={() => setFocused("code")}
                    onBlur={() => setFocused(null)}
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    autoComplete="one-time-code"
                    maxLength={CODE_LENGTH}
                    caretHidden
                    style={styles.codeHiddenInput}
                    editable={!loading}
                  />
                </Pressable>

                <TouchableOpacity
                  style={[styles.primaryBtn, code.length !== CODE_LENGTH && styles.btnDisabled]}
                  onPress={continueWithCode}
                  disabled={code.length !== CODE_LENGTH}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryBtnText}>Continue</Text>
                </TouchableOpacity>

                <View style={styles.codeFooter}>
                  <Text style={styles.mutedText}>Didn&apos;t get it? Check your spam folder, or</Text>
                  <TouchableOpacity
                    onPress={sendCode}
                    disabled={loading || cooldown > 0}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.linkText, (loading || cooldown > 0) && styles.linkDisabled]}>
                      {cooldown > 0 ? `resend in ${cooldown}s` : "send a new code"}
                    </Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity style={styles.linkRow} onPress={goBack} accessibilityRole="button">
                  <Ionicons name="swap-horizontal-outline" size={16} color={theme.primary} />
                  <Text style={styles.linkText}>Use a different ID</Text>
                </TouchableOpacity>
              </>
            )}

            {step === "password" && (
              <>
                <Text style={styles.label}>New password</Text>
                <View style={[styles.field, focused === "new" && styles.fieldFocused]}>
                  <Ionicons name="lock-closed-outline" size={18} color={theme.textMuted} />
                  <TextInput
                    style={styles.fieldInput}
                    value={newPassword}
                    onChangeText={(text) => {
                      setNewPassword(text);
                      if (error) setError(null);
                    }}
                    onFocus={() => setFocused("new")}
                    onBlur={() => setFocused(null)}
                    placeholder="New password"
                    placeholderTextColor={theme.textMuted}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="new-password"
                    textContentType="newPassword"
                    editable={!loading}
                  />
                  <TouchableOpacity
                    onPress={() => setShowPassword((value) => !value)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    accessibilityRole="button"
                    accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                  >
                    <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.label}>Confirm new password</Text>
                <View style={[styles.field, focused === "confirm" && styles.fieldFocused]}>
                  <Ionicons name="shield-checkmark-outline" size={18} color={theme.textMuted} />
                  <TextInput
                    style={styles.fieldInput}
                    value={confirmPassword}
                    onChangeText={(text) => {
                      setConfirmPassword(text);
                      if (error) setError(null);
                    }}
                    onFocus={() => setFocused("confirm")}
                    onBlur={() => setFocused(null)}
                    placeholder="Type it again"
                    placeholderTextColor={theme.textMuted}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                    onSubmitEditing={() => passwordReady && void submitReset()}
                    editable={!loading}
                  />
                </View>

                {/* Each rule turns green as it's met, so nobody meets the
                    rules by trial and error against the server. */}
                <View style={styles.checklist}>
                  {checks.map((check) => (
                    <View key={check.label} style={styles.checkRow}>
                      <Ionicons
                        name={check.ok ? "checkmark-circle" : "ellipse-outline"}
                        size={17}
                        color={check.ok ? theme.success : theme.textMuted}
                      />
                      <Text style={[styles.checkText, check.ok && styles.checkTextOk]}>{check.label}</Text>
                    </View>
                  ))}
                </View>

                <TouchableOpacity
                  style={[styles.primaryBtn, (loading || !passwordReady) && styles.btnDisabled]}
                  onPress={submitReset}
                  disabled={loading || !passwordReady}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                >
                  {loading ? (
                    <ActivityIndicator color={theme.onPrimary} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Reset password</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            {step === "done" && (
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={() => router.replace("/LoginScreen")}
                activeOpacity={0.85}
                accessibilityRole="button"
              >
                <Text style={styles.primaryBtnText}>Back to sign in</Text>
              </TouchableOpacity>
            )}

            {error && (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={18} color={theme.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.chrome },
    flex: { flex: 1 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 6,
    },
    headerTitle: { color: c.onChrome, fontSize: 16, fontWeight: "800" },

    progress: { flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingBottom: 6 },
    progressItem: { flex: 1, gap: 6 },
    progressBar: { height: 4, borderRadius: 2, backgroundColor: "rgba(255,250,246,0.18)" },
    progressBarOn: { backgroundColor: c.accent },
    progressLabel: { color: c.onChromeMuted, fontSize: 11, fontWeight: "700" },
    progressLabelOn: { color: c.onChrome },

    scroll: { flexGrow: 1, paddingBottom: 24 },
    hero: { alignItems: "center", paddingHorizontal: 20, paddingTop: 24, paddingBottom: 24 },
    heroIcon: {
      width: 64,
      height: 64,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(224,165,61,0.14)",
      borderWidth: 1,
      borderColor: "rgba(224,165,61,0.35)",
      marginBottom: 16,
    },
    heroIconDone: {
      width: 84,
      height: 84,
      borderRadius: 42,
      backgroundColor: c.successSoft,
      borderColor: c.success,
    },
    heroTitle: { color: c.onChrome, fontSize: 24, fontWeight: "800", letterSpacing: -0.4, textAlign: "center" },
    heroText: { color: c.onChromeMuted, fontSize: 14, lineHeight: 20, textAlign: "center", marginTop: 8 },

    // The form sits on a sheet, like every other sheet in the app.
    sheet: {
      flexGrow: 1,
      backgroundColor: c.background,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      paddingHorizontal: 20,
      paddingTop: 24,
      paddingBottom: 24,
    },
    label: { color: c.textSecondary, fontSize: 12.5, fontWeight: "800", marginBottom: 8, marginTop: 6 },
    field: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 52,
      borderRadius: 14,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.surfaceRaised,
      paddingHorizontal: 14,
      marginBottom: 10,
    },
    fieldFocused: { borderColor: c.primary },
    fieldWarning: { borderColor: c.warning },
    fieldInput: { flex: 1, color: c.textPrimary, fontSize: 15.5, paddingVertical: 12 },
    inlineWarning: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: -2, marginBottom: 6 },
    inlineWarningText: { flex: 1, color: c.warning, fontSize: 12.5, lineHeight: 16, fontWeight: "600" },
    noticeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: c.surfaceSunken,
      borderRadius: 12,
      padding: 12,
      marginBottom: 10,
    },
    noticeText: { flex: 1, color: c.textPrimary, fontSize: 13, lineHeight: 16, fontWeight: "600" },

    codeRow: { flexDirection: "row", justifyContent: "space-between", gap: 8, marginBottom: 6 },
    codeBox: {
      flex: 1,
      aspectRatio: 0.82,
      maxHeight: 64,
      borderRadius: 14,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.surfaceRaised,
      alignItems: "center",
      justifyContent: "center",
    },
    codeBoxFilled: { borderColor: c.borderStrong },
    codeBoxActive: { borderColor: c.primary, borderWidth: 2 },
    codeDigit: { color: c.textPrimary, fontSize: 24, fontWeight: "800" },
    // Covers the boxes, invisible, so a tap anywhere focuses it and a long
    // press can paste.
    codeHiddenInput: { ...StyleSheet.absoluteFill, opacity: 0.011, color: "transparent" },
    codeFooter: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 4, marginTop: 16 },

    checklist: {
      gap: 8,
      marginTop: 6,
      padding: 16,
      borderRadius: 14,
      backgroundColor: c.surfaceSunken,
    },
    checkRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    checkText: { color: c.textMuted, fontSize: 13 },
    checkTextOk: { color: c.textPrimary, fontWeight: "700" },

    primaryBtn: {
      backgroundColor: c.primary,
      borderRadius: 14,
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 20,
    },
    btnDisabled: { opacity: 0.45 },
    primaryBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: "800" },
    linkRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 20, paddingVertical: 6 },
    linkText: { color: c.primary, fontSize: 13.5, fontWeight: "700" },
    linkDisabled: { color: c.textMuted },
    mutedText: { color: c.textMuted, fontSize: 13 },

    errorBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: c.dangerSoft,
      borderRadius: 12,
      padding: 12,
      marginTop: 16,
    },
    errorText: { color: c.danger, fontSize: 13, flex: 1, fontWeight: "600" },
  });

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

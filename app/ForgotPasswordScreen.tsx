import { validateNewPassword } from "@/utils/passwordPolicy";
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
    Alert,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const RESEND_COOLDOWN_SECONDS = 60;

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();

  const [step, setStep] = useState<"request" | "confirm">("request");
  const [studentID, setStudentID] = useState((params.id ?? "").toString());
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const sendCode = useCallback(async () => {
    if (loading || cooldown > 0) return;
    Keyboard.dismiss();
    setError(null);

    const id = studentID.trim();
    if (!id) {
      setError("Enter your ID.");
      return;
    }

    setLoading(true);
    try {
      await requestPasswordResetCode(id);
      setStep("confirm");
      startCooldown();
    } catch (err: any) {
      setError(err?.message || "Couldn't send the code. Try again.");
    } finally {
      setLoading(false);
    }
  }, [loading, cooldown, studentID, startCooldown]);

  const submitReset = useCallback(async () => {
    if (loading) return;
    Keyboard.dismiss();
    setError(null);

    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from the email.");
      return;
    }
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
      await confirmPasswordReset(studentID.trim(), code.trim(), newPassword);
      Alert.alert(
        "Password changed",
        "You can now sign in with your new password.",
        [{ text: "Sign in", onPress: () => router.replace("/LoginScreen") }],
      );
    } catch (err: any) {
      setError(err?.message || "Couldn't reset the password. Try again.");
    } finally {
      setLoading(false);
    }
  }, [loading, code, newPassword, confirmPassword, studentID, router]);

  const resendLabel = useMemo(
    () => (cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"),
    [cooldown],
  );

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right", "bottom"]}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.replace("/LoginScreen")}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={26} color="#f5d8d3" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Reset password</Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {step === "request" ? (
            <>
              <Text style={styles.lead}>
                Enter your ID. We&apos;ll email a 6-digit code to the recovery
                email on your account.
              </Text>

              <Text style={styles.label}>Your ID</Text>
              <TextInput
                style={styles.input}
                value={studentID}
                onChangeText={setStudentID}
                placeholder="e.g. 2021-00123"
                placeholderTextColor="#8a655e"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!loading}
              />

              <TouchableOpacity
                style={[styles.primaryBtn, loading && styles.btnDisabled]}
                onPress={sendCode}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading ? (
                  <ActivityIndicator color="#5e0a09" />
                ) : (
                  <Text style={styles.primaryBtnText}>Send reset code</Text>
                )}
              </TouchableOpacity>

              <Text style={styles.hint}>
                No recovery email set? Add one in Profile after signing in, or
                ask your admin to reset your password for you.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.lead}>
                If an account exists for that ID with a recovery email, a code
                was sent to it. It expires in 15 minutes.
              </Text>

              <Text style={styles.label}>6-digit code</Text>
              <TextInput
                style={[styles.input, styles.codeInput]}
                value={code}
                onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                placeholderTextColor="#8a655e"
                keyboardType="number-pad"
                maxLength={6}
                editable={!loading}
              />

              <Text style={styles.label}>New password</Text>
              <View style={styles.passwordRow}>
                <TextInput
                  style={[styles.input, styles.flex]}
                  value={newPassword}
                  onChangeText={setNewPassword}
                  placeholder="8+ chars, incl. a number & symbol"
                  placeholderTextColor="#8a655e"
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!loading}
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowPassword((v) => !v)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons
                    name={showPassword ? "eye-off-outline" : "eye-outline"}
                    size={20}
                    color="#b88f87"
                  />
                </TouchableOpacity>
              </View>

              <Text style={styles.label}>Confirm new password</Text>
              <TextInput
                style={styles.input}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="Re-enter the new password"
                placeholderTextColor="#8a655e"
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!loading}
              />

              <TouchableOpacity
                style={[styles.primaryBtn, loading && styles.btnDisabled]}
                onPress={submitReset}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading ? (
                  <ActivityIndicator color="#5e0a09" />
                ) : (
                  <Text style={styles.primaryBtnText}>Reset password</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={sendCode}
                disabled={loading || cooldown > 0}
                style={styles.resendBtn}
              >
                <Text
                  style={[
                    styles.resendText,
                    (loading || cooldown > 0) && styles.resendTextDisabled,
                  ]}
                >
                  {resendLabel}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={18} color="#ffb4ab" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#3d0606" },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "#5f0909",
  },
  headerTitle: { color: "#f5d8d3", fontSize: 18, fontWeight: "700" },
  content: { padding: 20, paddingBottom: 48 },
  lead: { color: "#d8b3ab", fontSize: 14, lineHeight: 20, marginBottom: 20 },
  label: {
    color: "#e0aa42",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: "rgba(0,0,0,0.28)",
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.35)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "ios" ? 14 : 10,
    color: "#f5d8d3",
    fontSize: 15,
  },
  codeInput: { letterSpacing: 6, fontSize: 20, textAlign: "center" },
  passwordRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  eyeBtn: { padding: 8 },
  primaryBtn: {
    backgroundColor: "#e0a53d",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 22,
  },
  btnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: "#5e0a09", fontSize: 16, fontWeight: "700" },
  hint: { color: "#b88f87", fontSize: 12, lineHeight: 18, marginTop: 18 },
  resendBtn: { alignSelf: "center", marginTop: 16, padding: 6 },
  resendText: { color: "#e0a53d", fontSize: 14, fontWeight: "600" },
  resendTextDisabled: { color: "#8a655e" },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(138,18,20,0.35)",
    borderRadius: 10,
    padding: 12,
    marginTop: 20,
  },
  errorText: { color: "#ffb4ab", fontSize: 13, flex: 1 },
});

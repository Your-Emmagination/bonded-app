// app/LoginScreen.tsx
import { getUserDataByAuthUser, resolveUserRoleForAuthUser } from "@/utils/rbac";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import { signInWithEmailAndPassword } from "firebase/auth";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth } from "../Firebase_configure";

const TERMS_ACCEPTED_KEY = "termsAccepted";

function TermsModal({ visible, onAccept, onDecline }: {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const handleScroll = useCallback(({ nativeEvent }: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
    const isAtBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 20;
    if (isAtBottom) setScrolledToBottom(true);
  }, []);

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={tos.overlay}>
        <View style={tos.sheet}>
          {/* Header */}
          <View style={tos.header}>
            <View style={tos.headerIcon}>
              <Ionicons name="document-text" size={22} color="#e0a53d" />
            </View>
            <Text style={tos.headerTitle}>Terms & Conditions</Text>
            <Text style={tos.headerSub}>Please read before continuing</Text>
          </View>

          {/* Scroll prompt */}
          {!scrolledToBottom && (
            <View style={tos.scrollPrompt}>
              <Ionicons name="chevron-down" size={14} color="#dfb85e" />
              <Text style={tos.scrollPromptText}>Scroll to read all terms</Text>
            </View>
          )}

          {/* Body */}
          <ScrollView
            ref={scrollRef}
            style={tos.body}
            contentContainerStyle={tos.bodyContent}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={true}
            indicatorStyle="white"
          >
            <Text style={tos.sectionTitle}>1. Acceptance of Terms</Text>
            <Text style={tos.paragraph}>
              By accessing and using BondED, the official community hub of the CSAP, you agree to
              be bound by these Terms and Conditions. If you do not agree to these terms, you must
              not use this application.
            </Text>

            <Text style={tos.sectionTitle}>2. User Eligibility</Text>
            <Text style={tos.paragraph}>
              BondED is intended exclusively for registered students, faculty, and staff of CSAP.
              You must use your official school credentials to access the platform. Sharing your
              login credentials with others is strictly prohibited.
            </Text>

            <Text style={tos.sectionTitle}>3. Community Standards</Text>
            <Text style={tos.paragraph}>
              All users are expected to engage respectfully and responsibly. The following are
              prohibited on BondED:
            </Text>
            <Text style={tos.bullet}>• Harassment, bullying, or discrimination of any kind</Text>
            <Text style={tos.bullet}>• Sharing false, misleading, or harmful content</Text>
            <Text style={tos.bullet}>• Posting content that violates school policies</Text>
            <Text style={tos.bullet}>• Any form of academic dishonesty facilitated through the app</Text>

            <Text style={tos.sectionTitle}>4. Privacy & Data</Text>
            <Text style={tos.paragraph}>
              BondED collects only the data necessary to provide its services, including your
              student ID, name, and activity within the platform. Your data is handled in
              accordance with CSAP's data privacy policy and applicable laws. We do not sell or
              share your personal information with third parties.
            </Text>

            <Text style={tos.sectionTitle}>5. Content Ownership</Text>
            <Text style={tos.paragraph}>
              You retain ownership of any content you post. By submitting content to BondED, you
              grant CSAP a non-exclusive license to display that content within the platform for
              community purposes. You are solely responsible for the content you share.
            </Text>

            <Text style={tos.sectionTitle}>6. Account Suspension</Text>
            <Text style={tos.paragraph}>
              CSAP administrators reserve the right to suspend or permanently revoke access to
              BondED for any user found to be in violation of these terms or school policies,
              without prior notice.
            </Text>

            <Text style={tos.sectionTitle}>7. Changes to Terms</Text>
            <Text style={tos.paragraph}>
              These Terms and Conditions may be updated from time to time. Continued use of
              BondED after changes are posted constitutes your acceptance of the revised terms.
              Users will be notified of significant updates through the app.
            </Text>

            <Text style={tos.sectionTitle}>8. Contact</Text>
            <Text style={tos.paragraph}>
              For questions, concerns, or reports regarding these terms or platform conduct,
              please reach out to the CSAP administration through official school channels.
            </Text>

            <View style={tos.lastUpdated}>
              <Text style={tos.lastUpdatedText}>Last updated: January 2025</Text>
            </View>
          </ScrollView>

          {/* Actions */}
          <View style={tos.actions}>
            <TouchableOpacity style={tos.declineBtn} onPress={onDecline} activeOpacity={0.8}>
              <Text style={tos.declineBtnText}>Decline</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[tos.acceptBtn, !scrolledToBottom && tos.acceptBtnLocked]}
              onPress={scrolledToBottom ? onAccept : undefined}
              activeOpacity={scrolledToBottom ? 0.85 : 1}
            >
              {!scrolledToBottom ? (
                <Ionicons name="lock-closed" size={15} color="#7a4a00" style={{ marginRight: 6 }} />
              ) : null}
              <Text style={[tos.acceptBtnText, !scrolledToBottom && tos.acceptBtnTextLocked]}>
                {scrolledToBottom ? "I Agree" : "Read to continue"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function LoginScreen() {
  const [studentID, setStudentID] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTerms, setShowTerms] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(50)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const formLiftAnim = useRef(new Animated.Value(0)).current;
  const heroShiftAnim = useRef(new Animated.Value(0)).current;
  const heroScaleAnim = useRef(new Animated.Value(1)).current;

  // Check if terms have been accepted before
  useEffect(() => {
    (async () => {
      const accepted = await AsyncStorage.getItem(TERMS_ACCEPTED_KEY);
      if (!accepted) setShowTerms(true);
    })();
  }, []);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  useEffect(() => {
    const handleKeyboardShow = () => {
      Animated.parallel([
        Animated.timing(formLiftAnim, {
          toValue: Platform.OS === "android" ? -54 : -26,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(heroShiftAnim, {
          toValue: -28,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(heroScaleAnim, {
          toValue: 0.92,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    };

    const handleKeyboardHide = () => {
      Animated.parallel([
        Animated.timing(formLiftAnim, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(heroShiftAnim, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(heroScaleAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    };

    const showSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      handleKeyboardShow,
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      handleKeyboardHide,
    );

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [formLiftAnim, heroScaleAnim, heroShiftAnim]);

  const shakeAnimation = useCallback(() => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  const handleTermsAccept = useCallback(async () => {
    await AsyncStorage.setItem(TERMS_ACCEPTED_KEY, "true");
    setShowTerms(false);
  }, []);

const handleTermsDecline = useCallback(() => {
  Alert.alert(
    "Terms Required",
    "You must accept the Terms & Conditions to use BondED.",
    [
      {
        text: "Continue Reading",
        style: "cancel",
      },
    ]
  );
}, []);

  const handleSignin = useCallback(async () => {
    if (loading) return;

    setError(null);
    setLoading(true);
    Keyboard.dismiss();

    const trimmedID = studentID.trim();
    const trimmedPass = password.trim();

    if (!trimmedID) {
      setError("ID is required");
      shakeAnimation();
      setLoading(false);
      return;
    }

    if (!trimmedPass) {
      setError("Password is required");
      shakeAnimation();
      setLoading(false);
      return;
    }

    try {
      let email = trimmedID.toLowerCase();

      if (!email.includes("@")) {
        if (email.startsWith("teach-")) email += "@teacher.csap";
        else if (email.startsWith("admin-")) email += "@admin.csap";
        else email += "@student.csap";
      }

      const userCredential = await signInWithEmailAndPassword(auth, email, trimmedPass);
      const user = userCredential.user;

      const role = await resolveUserRoleForAuthUser(user);
      const profile = await getUserDataByAuthUser(user);

      await AsyncStorage.multiSet([
        ["userRole", role],
        ["userId", user.uid],
        ["userEmail", email],
        ["userProfileDocId", profile?.studentID || email.split("@")[0] || user.uid],
      ]);

      // Role-based navigation

    } catch (err: any) {
      shakeAnimation();

      const errorMessages: Record<string, string> = {
        "auth/invalid-email": "Invalid ID format.",
        "auth/user-disabled": "Account disabled. Contact admin.",
        "auth/user-not-found": "No account found with this ID.",
        "auth/wrong-password": "Incorrect password.",
        "auth/invalid-credential": "Invalid ID or password.",
        "auth/too-many-requests": "Too many attempts. Try again later.",
        "auth/network-request-failed": "Network error. Check connection.",
      };

      setError(errorMessages[err.code] || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [studentID, password, loading, shakeAnimation]);

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.container}>
      <StatusBar style="light" backgroundColor="#5f0909" />

      <TermsModal
        visible={showTerms}
        onAccept={handleTermsAccept}
        onDecline={handleTermsDecline}
      />

      <View style={styles.keyboardView}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          showsVerticalScrollIndicator={false}
          bounces={false}
          contentInsetAdjustmentBehavior="never"
        >
          <Animated.View
            style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}
          >
            <View style={styles.visualShell}>
              <View style={styles.topAccent} />
              <View style={styles.bottomAccent} />

              <Animated.View
                style={[
                  styles.logoContainer,
                  {
                    transform: [
                      { translateY: heroShiftAnim },
                      { scale: heroScaleAnim },
                    ],
                  },
                ]}
              >
                <Image
                  source={require("../assets/images/BondEDlogo.png")}
                  style={styles.logo}
                  resizeMode="contain"
                />
                <Text style={styles.brandText}>BondED</Text>
                <Text style={styles.loginTitle}>Welcome Back</Text>
                <Text style={styles.subtitle}>Sign in to continue</Text>
              </Animated.View>

              <Animated.View
                style={[
                  styles.inputContainer,
                  {
                    transform: [
                      { translateX: shakeAnim },
                      { translateY: formLiftAnim },
                    ],
                  },
                ]}
              >
                <View style={[styles.inputWrapper, error && styles.inputError]}>
                  <TextInput
                    placeholder="Email"
                    placeholderTextColor="#e5b9ad"
                    style={styles.input}
                    value={studentID}
                    onChangeText={(text) => {
                      setStudentID(text);
                      if (error) setError(null);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                    blurOnSubmit={false}
                  />
                </View>

                <View style={[styles.inputWrapper, error && styles.inputError]}>
                  <TextInput
                    placeholder="Password"
                    placeholderTextColor="#e5b9ad"
                    secureTextEntry={!showPassword}
                    style={styles.input}
                    value={password}
                    onChangeText={(text) => {
                      setPassword(text);
                      if (error) setError(null);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                    onSubmitEditing={handleSignin}
                  />
                  <TouchableOpacity
                    onPress={() => setShowPassword(!showPassword)}
                    style={styles.eyeIcon}
                  >
                    <Ionicons
                      name={showPassword ? "eye-off-outline" : "eye-outline"}
                      size={20}
                      color="#b88f87"
                    />
                  </TouchableOpacity>
                </View>

                {error && (
                  <Animated.View style={styles.errorContainer}>
                    <Ionicons name="alert-circle" size={18} color="#ffb4ab" />
                    <Text style={styles.errorText}>{error}</Text>
                  </Animated.View>
                )}

                <TouchableOpacity
                  style={[styles.button, loading && styles.buttonDisabled]}
                  onPress={handleSignin}
                  disabled={loading}
                  activeOpacity={0.85}
                >
                  {loading ? (
                    <ActivityIndicator color="#5e0a09" />
                  ) : (
                    <>
                      <Text style={styles.buttonText}>Sign In</Text>
                      <Ionicons name="arrow-forward" size={18} color="#5e0a09" />
                    </>
                  )}
                </TouchableOpacity>

                {/* Terms re-read link */}
                <TouchableOpacity
                  style={styles.tosLink}
                  onPress={() => setShowTerms(true)}
                  activeOpacity={0.7}
                >
                  <Ionicons name="document-text-outline" size={13} color="#b88f87" />
                  <Text style={styles.tosLinkText}>View Terms & Conditions</Text>
                </TouchableOpacity>
              </Animated.View>

              <View style={styles.footer}>
                <View style={styles.footerLine} />
                <Text style={styles.footerText}>BondED - CSAP Community Hub</Text>
              </View>
            </View>
          </Animated.View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

// ─── Terms Modal Styles ───────────────────────────────────────────────────────
const tos = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#3d0606",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: "90%",
    paddingBottom: Platform.OS === "ios" ? 34 : 24,
    borderTopWidth: 1.5,
    borderColor: "#8a1214",
  },
  header: {
    alignItems: "center",
    paddingTop: 28,
    paddingBottom: 16,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(224,160,40,0.15)",
  },
  headerIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#5f0909",
    borderWidth: 1.5,
    borderColor: "#e0a028",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#e0aa42",
    letterSpacing: 0.3,
  },
  headerSub: {
    fontSize: 13,
    color: "#b88f87",
    marginTop: 4,
    fontWeight: "500",
  },
  scrollPrompt: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 8,
    backgroundColor: "rgba(224,165,61,0.08)",
  },
  scrollPromptText: {
    fontSize: 12,
    color: "#dfb85e",
    fontWeight: "600",
  },
  body: {
    maxHeight: 380,
    paddingHorizontal: 24,
  },
  bodyContent: {
    paddingTop: 20,
    paddingBottom: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: "#e0a53d",
    marginTop: 18,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  paragraph: {
    fontSize: 14,
    color: "#f5d8d3",
    lineHeight: 21,
    fontWeight: "400",
  },
  bullet: {
    fontSize: 14,
    color: "#f5d8d3",
    lineHeight: 22,
    paddingLeft: 8,
    fontWeight: "400",
  },
  lastUpdated: {
    marginTop: 28,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "rgba(184,143,135,0.16)",
  },
  lastUpdatedText: {
    fontSize: 12,
    color: "#b88f87",
    fontWeight: "500",
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 18,
  },
  declineBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#8a1214",
    alignItems: "center",
    backgroundColor: "transparent",
  },
  declineBtnText: {
    color: "#b88f87",
    fontSize: 15,
    fontWeight: "700",
  },
  acceptBtn: {
    flex: 2,
    paddingVertical: 13,
    borderRadius: 10,
    backgroundColor: "#e0a53d",
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
  },
  acceptBtnLocked: {
    backgroundColor: "#6b4a10",
    opacity: 0.7,
  },
  acceptBtnText: {
    color: "#5e0a09",
    fontSize: 15,
    fontWeight: "800",
  },
  acceptBtnTextLocked: {
    color: "#7a4a00",
  },
});

// ─── Login Screen Styles ──────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#5f0909",
  },
  keyboardView: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
    backgroundColor: "#5f0909",
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 20,
  },
  content: {
    width: "100%",
    flex: 1,
  },
  visualShell: {
    flex: 1,
    backgroundColor: "#5f0909",
    overflow: "hidden",
    paddingHorizontal: 28,
    paddingTop: 16,
    paddingBottom: 28,
    justifyContent: "space-between",
  },
  topAccent: {
    position: "absolute",
    top: -76,
    right: -78,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "#8a1214",
  },
  bottomAccent: {
    position: "absolute",
    bottom: -90,
    left: -92,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "#8a1214",
  },
  logoContainer: {
    alignItems: "center",
    paddingTop: 76,
  },
  logo: {
    width: 92,
    height: 92,
  },
  brandText: {
    fontSize: 26,
    color: "#40d4b9",
    marginTop: 8,
    fontWeight: "500",
  },
  loginTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: "#e0aa42",
    marginTop: 52,
  },
  subtitle: {
    color: "#dfb85e",
    fontSize: 15,
    marginTop: 6,
    fontWeight: "600",
  },
  inputContainer: {
    width: "100%",
    marginTop: 28,
  },
  inputWrapper: {
    backgroundColor: "#7a2020",
    borderColor: "#e0a028",
    borderWidth: 1.6,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    marginBottom: 18,
    height: 46,
  },
  inputError: {
    borderColor: "#ffb4ab",
  },
  input: {
    flex: 1,
    color: "#f5d8d3",
    fontSize: 15,
    paddingVertical: 0,
    fontWeight: "600",
  },
  eyeIcon: {
    padding: 8,
  },
  errorContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: -4,
    marginBottom: 14,
    paddingHorizontal: 2,
  },
  errorText: {
    color: "#ffd4cf",
    fontSize: 13.5,
    flex: 1,
    fontWeight: "500",
  },
  button: {
    backgroundColor: "#e0a53d",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 18,
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    minHeight: 48,
  },
  buttonDisabled: {
    opacity: 0.75,
  },
  buttonText: {
    color: "#5e0a09",
    fontWeight: "800",
    fontSize: 17,
  },
  tosLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    marginTop: 16,
  },
  tosLinkText: {
    color: "#b88f87",
    fontSize: 12.5,
    fontWeight: "600",
  },
  footer: {
    marginTop: 40,
    alignItems: "center",
  },
  footerLine: {
    width: "100%",
    height: 1,
    backgroundColor: "rgba(184, 143, 135, 0.16)",
    marginBottom: 18,
  },
  footerText: {
    color: "#b88f87",
    fontSize: 12,
    fontWeight: "500",
  },
});
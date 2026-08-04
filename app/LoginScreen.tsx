// app/LoginScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { signInWithEmailAndPassword } from "firebase/auth";
import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth } from "../Firebase_configure";
import { getUserDataByAuthUser, resolveUserRoleForAuthUser } from "@/utils/rbac";

export default function LoginScreen() {
  const [studentID, setStudentID] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(50)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const formLiftAnim = useRef(new Animated.Value(0)).current;
  const heroShiftAnim = useRef(new Animated.Value(0)).current;
  const heroScaleAnim = useRef(new Animated.Value(1)).current;

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
        Animated.timing(formLiftAnim, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(heroShiftAnim, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(heroScaleAnim, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
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

      // Get role (token first → Firestore fallback)
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
                    onSubmitEditing={() => {
                      /* keep existing flow */
                    }}
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
              </Animated.View>

              <View style={styles.footer}>
                <View style={styles.footerLine} />
                <Text style={styles.footerText}>BonED - CSAP Community Hub</Text>
              </View>
            </View>
          </Animated.View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
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

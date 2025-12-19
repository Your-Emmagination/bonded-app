// app/LoginScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { signInWithEmailAndPassword } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import React, { useRef, useState, useEffect } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Keyboard,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth, db } from "../Firebase_configure";

export default function LoginScreen() {
  const [studentID, setStudentID] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(50)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const router = useRouter();

  // ✅ Trigger animations on mount
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  const shakeAnimation = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const handleSignin = async () => {
    setError(null);
    setLoading(true);
    Keyboard.dismiss();

    if (!studentID.trim()) {
      setError("ID is required");
      setLoading(false);
      shakeAnimation();
      return;
    }

    if (!password.trim()) {
      setError("Password is required");
      setLoading(false);
      shakeAnimation();
      return;
    }

    try {
      let email = studentID.toLowerCase().trim();

      if (!email.includes("@")) {
        if (studentID.startsWith("teach-")) email = `${email}@teacher.csap`;
        else if (studentID.startsWith("admin-")) email = `${email}@admin.csap`;
        else email = `${email}@student.csap`;
      }

      // Sign in
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;

      // Try to get role from ID token claims
      const idTokenResult = await user.getIdTokenResult();
      let role = idTokenResult.claims.role as string;

      // Fallback to Firestore if not found in token
      if (!role) {
        const userDoc = await getDoc(doc(db, "students", user.uid));
        if (userDoc.exists()) role = userDoc.data()?.role?.toLowerCase() || "student";
        else role = "student";
      }

      role = role.toLowerCase().trim();

      // Save user info
      await AsyncStorage.multiSet([
        ["userRole", role],
        ["userId", user.uid],
        ["userEmail", email],
      ]);

      setLoading(false);

      // Navigate based on role
  if (role === "student") router.replace("/(main)/(tabs)/HomeScreen");
else if (["moderator", "teacher", "admin"].includes(role))
  router.replace("/(main)/(tabs)/DashboardScreen");

     const displayName = user.displayName || email.split("@")[0];
    console.log(`✅ LOGIN SUCCESS`);
    console.log(`   Name: ${displayName}`);
    console.log(`   Email: ${email}`);
    console.log(`   Role: ${role}`);
    console.log(`   Time: ${new Date().toLocaleTimeString()}`);
    } catch (error: any) {
      setLoading(false);
      shakeAnimation();

      const errorMessages: Record<string, string> = {
        "auth/invalid-email": "Invalid ID format.",
        "auth/user-disabled": "Your account is disabled. Please contact admin.",
        "auth/user-not-found": "No account found with this ID.",
        "auth/wrong-password": "Incorrect password. Please try again.",
        "auth/invalid-credential": "Invalid ID or password. Please try again.",
        "auth/too-many-requests": "Too many attempts. Try again later.",
        "auth/network-request-failed": "Network error. Check your connection.",
      };

      setError(errorMessages[error.code] || "Login failed. Please try again.");
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View
            style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}
          >
            {/* Logo Section */}
            <View style={styles.logoContainer}>
              <Image
                source={require("../assets/images/BondEDlogo.png")}
                style={styles.logo}
                resizeMode="contain"
              />
              <Text style={styles.loginTitle}>Welcome Back</Text>
              <Text style={styles.subtitle}>Sign in to continue</Text>
            </View>

            {/* Input Fields */}
            <Animated.View
              style={[styles.inputContainer, { transform: [{ translateX: shakeAnim }] }]}
            >
              <View style={[styles.inputWrapper, error && styles.inputError]}>
                <Ionicons
                  name="id-card-outline"
                  size={20}
                  color="#ff3b7f"
                  style={styles.inputIcon}
                />
                <TextInput
                  placeholder="ID + Domain"
                  placeholderTextColor="#666"
                  style={styles.input}
                  value={studentID}
                  onChangeText={(text) => {
                    setStudentID(text);
                    setError(null);
                  }}
                  keyboardType="default"
                  autoCapitalize="none"
                />
              </View>

              <View style={[styles.inputWrapper, error && styles.inputError]}>
                <Ionicons
                  name="lock-closed-outline"
                  size={20}
                  color="#ff3b7f"
                  style={styles.inputIcon}
                />
                <TextInput
                  placeholder="Password"
                  placeholderTextColor="#666"
                  secureTextEntry={!showPassword}
                  style={styles.input}
                  value={password}
                  onChangeText={(text) => {
                    setPassword(text);
                    setError(null);
                  }}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword(!showPassword)}
                  style={styles.eyeIcon}
                >
                  <Ionicons
                    name={showPassword ? "eye-off-outline" : "eye-outline"}
                    size={22}
                    color="#888"
                  />
                </TouchableOpacity>
              </View>

              {error && (
                <Animated.View style={styles.errorContainer}>
                  <Ionicons name="alert-circle" size={18} color="#ff3b7f" />
                  <Text style={styles.errorText}>{error}</Text>
                </Animated.View>
              )}

              <TouchableOpacity
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handleSignin}
                disabled={loading}
                activeOpacity={0.8}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Text style={styles.buttonText}>Sign In</Text>
                    <Ionicons name="arrow-forward" size={20} color="#fff" />
                  </>
                )}
              </TouchableOpacity>
            </Animated.View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f1624" },
  scrollContent: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 20 },
  content: { width: "100%" },
  logoContainer: { alignItems: "center", marginBottom: 30 },
  logo: { width: "60%", height: undefined, aspectRatio: 1 },
  loginTitle: { fontSize: 32, fontWeight: "bold", color: "#ff3b7f", marginTop: 10 },
  subtitle: { color: "#999", fontSize: 16, marginTop: 5 },
  inputContainer: { width: "100%" },
  inputWrapper: {
    backgroundColor: "#1c2535",
    borderColor: "#2a3548",
    borderWidth: 2,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 15,
    marginBottom: 16,
    height: 56,
  },
  inputError: { borderColor: "#ff3b7f" },
  inputIcon: { marginRight: 12 },
  input: { flex: 1, color: "#fff", fontSize: 16 },
  eyeIcon: { padding: 5 },
  errorContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  errorText: { color: "#ff3b7f", fontSize: 14, flex: 1 },
  button: {
    backgroundColor: "#ff3b7f",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 8,
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    shadowColor: "#ff3b7f",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  buttonDisabled: { opacity: 0.7 },
  buttonText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
});
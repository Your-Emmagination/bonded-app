// app/LoginScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { signInWithEmailAndPassword } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import React, { useRef, useState, useEffect, useCallback } from "react";
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

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, slideAnim]);

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
      const idTokenResult = await user.getIdTokenResult(true); // force refresh
      let role = (idTokenResult.claims.role as string)?.toLowerCase();

      if (!role) {
        const userDoc = await getDoc(doc(db, "students", user.uid));
        role = userDoc.exists() ? userDoc.data()?.role?.toLowerCase() || "student" : "student";
      }

      // Save to AsyncStorage (only what's needed)
      await AsyncStorage.multiSet([
        ["userRole", role],
        ["userId", user.uid],
        ["userEmail", email],
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
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View
            style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}
          >
            <View style={styles.logoContainer}>
              <Image
                source={require("../assets/images/BondEDlogo.png")}
                style={styles.logo}
                resizeMode="contain"
              />
              <Text style={styles.loginTitle}>Welcome Back</Text>
              <Text style={styles.subtitle}>Sign in to continue</Text>
            </View>

            <Animated.View
              style={[styles.inputContainer, { transform: [{ translateX: shakeAnim }] }]}
            >
              <View style={[styles.inputWrapper, error && styles.inputError]}>
                <Ionicons name="id-card-outline" size={20} color="#ff3b7f" style={styles.inputIcon} />
                <TextInput
                  placeholder="ID + Domain"
                  placeholderTextColor="#666"
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
                  onSubmitEditing={() => {/* optional: focus password input */}}
                />
              </View>

              <View style={[styles.inputWrapper, error && styles.inputError]}>
                <Ionicons name="lock-closed-outline" size={20} color="#ff3b7f" style={styles.inputIcon} />
                <TextInput
                  placeholder="Password"
                  placeholderTextColor="#666"
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
                <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeIcon}>
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
  container: { 
    flex: 1, 
    backgroundColor: "#070c15",  // ← match PostCard background
  },
  scrollContent: { 
    flexGrow: 1, 
    justifyContent: "center", 
    paddingHorizontal: 24,        // slightly more breathing room
  },
  content: { 
    width: "100%" 
  },
  logoContainer: { 
    alignItems: "center", 
    marginBottom: 40 
  },
  logo: { 
    width: "65%", 
    height: undefined, 
    aspectRatio: 1 
  },
  loginTitle: { 
    fontSize: 34, 
    fontWeight: "700", 
    color: "#ff5c93",           // ← PostCard's vibrant pink
    marginTop: 16,
    letterSpacing: -0.5,
  },
  subtitle: { 
    color: "#8ea0d0",            // ← PostCard secondary text
    fontSize: 16, 
    marginTop: 6,
    fontWeight: "500",
  },

  inputContainer: { 
    width: "100%" 
  },
  inputWrapper: {
    backgroundColor: "#1b2235",     // ← PostCard card/accent bg
    borderColor: "#243054",         // ← PostCard subtle border
    borderWidth: 1.5,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    marginBottom: 16,
    height: 58,
  },
  inputError: { 
    borderColor: "#ff5c93"         // ← error uses same pink
  },
  inputIcon: { 
    marginRight: 12,
    color: "#ff5c93",              // ← icons match accent
  },
  input: {
    flex: 1,
    color: "#d8deff",               // ← main text color from PostCard
    fontSize: 16,
    paddingVertical: 0,
  },
  eyeIcon: { 
    padding: 6 
  },
  errorContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 20,
    paddingHorizontal: 4,
  },
  errorText: { 
    color: "#ff5c93", 
    fontSize: 14.5,
    flex: 1,
    fontWeight: "500",
  },

  button: {
    backgroundColor: "#ff5c93",     // ← same pink as likes/heart
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    marginTop: 12,
    flexDirection: "row",
    justifyContent: "center",
    gap: 10,
    shadowColor: "#ff5c93",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 10,
    minHeight: 58,
  },
  buttonDisabled: { 
    opacity: 0.6 
  },
  buttonText: { 
    color: "#fff", 
    fontWeight: "700", 
    fontSize: 17,
    letterSpacing: 0.3,
  },
});
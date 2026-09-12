import { auth, db } from "@/Firebase_configure";
import { useAccountSetup } from "@/contexts/AccountSetupContext";
import { changeAccountPassword } from "@/utils/changeAccountPassword";
import { uploadProfileImage } from "@/utils/cloudinaryUpload";
import { checkAccountPassword } from "@/utils/passwordReset";
import { COMMUNITY_RULES, COMMUNITY_RULES_VERSION, getSetupStep, hasAcceptedCommunityRules, hasProfilePhoto, profileEmail, validPersonalEmail, type SetupProfile } from "@/utils/profileSetup";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";
import { signOut, updateProfile, type User } from "firebase/auth";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { ActivityIndicator, BackHandler, Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, type TextInputProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function ProfileSetupScreen() {
  const { user, profile, profileId, status, error, retry } = useAccountSetup();
  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => handler.remove();
  }, []);

  if (status === "error") return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.fallback}>
        <Ionicons name="cloud-offline-outline" size={44} color="#8f2117" />
        <Text style={styles.heading}>Unable to load your profile</Text>
        <Text style={styles.subtext}>{error}</Text>
        <TouchableOpacity style={styles.continueButton} onPress={retry}><Text style={styles.continueText}>Try again</Text></TouchableOpacity>
        <SignOutButton />
      </View>
    </SafeAreaView>
  );
  if (!user || !profile || !profileId) return <View style={styles.fallback}><ActivityIndicator color="#8f2117" /></View>;
  return <SetupForm key={`${user.uid}:${profileId}`} user={user} profile={profile} profileId={profileId} />;
}

function SignOutButton({ disabled = false }: { disabled?: boolean }) {
  const [error, setError] = useState("");
  return <>
    <TouchableOpacity disabled={disabled} style={styles.signOut} onPress={() => {
      void signOut(auth).catch(() => setError("Could not sign out. Please try again."));
    }}><Text style={styles.link}>Sign out</Text></TouchableOpacity>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </>;
}

function SetupPasswordInput({ label, inputRef, ...props }: TextInputProps & { label: string; inputRef: Ref<TextInput> }) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.passwordField}>
      <TextInput {...props} ref={inputRef} accessibilityLabel={label} style={styles.passwordInput} placeholderTextColor="#a88d84" secureTextEntry={!visible} autoCapitalize="none" autoCorrect={false} />
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
        accessibilityState={{ disabled: props.editable === false }}
        disabled={props.editable === false}
        onPress={() => setVisible(value => !value)}
        style={styles.eyeButton}
      >
        <Ionicons name={visible ? "eye-off-outline" : "eye-outline"} size={22} color="#8f2117" />
      </TouchableOpacity>
    </View>
  );
}

function SetupForm({ user, profile, profileId }: { user: User; profile: SetupProfile; profileId: string }) {
  const step = getSetupStep(profile);
  const passwordStep = step === "password" || step === "password-check";
  const acceptedPreviously = hasAcceptedCommunityRules(profile);
  const [email, setEmail] = useState(() => profileEmail(profile));
  const [photo, setPhoto] = useState(() => hasProfilePhoto(profile.profileImage) ? profile.profileImage : "");
  const [agree, setAgree] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const saving = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const scrollOffset = useRef(0);
  const currentPasswordRef = useRef<TextInput>(null);
  const newPasswordRef = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const focusedInput = useRef<TextInput | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const revealFocusedInput = useCallback(() => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const input = focusedInput.current;
      if (input?.isFocused() && Keyboard.isVisible()) {
        const scroll = scrollRef.current;
        input.measureInWindow((_x, inputY, _width, inputHeight) => {
          scroll?.getNativeScrollRef()?.measureInWindow((_sx: number, viewportY: number, _sw: number, viewportHeight: number) => {
            if (focusedInput.current !== input || !input.isFocused()) return;
            // Measure the actual viewport above the pinned footer, including
            // safe-area padding, rather than assuming a full-screen scroller.
            const bottomOverlap = inputY + inputHeight - (viewportY + viewportHeight - 20);
            const topOverlap = inputY - (viewportY + 20);
            const delta = bottomOverlap > 0 ? bottomOverlap : topOverlap < 0 ? topOverlap : 0;
            if (delta) scroll.scrollTo({ y: Math.max(0, scrollOffset.current + delta), animated: true });
          });
        });
      }
    });
  }, []);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", revealFocusedInput);
    const change = Keyboard.addListener("keyboardDidChangeFrame", revealFocusedInput);
    return () => {
      show.remove();
      change.remove();
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, [revealFocusedInput]);

  const focusField = (input: TextInput | null) => {
    focusedInput.current = input;
    revealFocusedInput();
  };
  const uploadedPhoto = useRef<{ local: string; url: string } | null>(null);
  const emailError = emailTouched && !validPersonalEmail(email) ? "Enter a valid personal email address, such as name@example.com." : "";

  useEffect(() => {
    if (!error) return;
    const frame = requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    return () => cancelAnimationFrame(frame);
  }, [error]);

  const pickPhoto = async () => {
    if (saving.current || picking) return;
    setPicking(true);
    setError("");
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) throw new Error("Allow photo access in your phone settings to choose a profile picture.");
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
      if (!result.canceled && result.assets[0]?.uri) {
        setPhoto(result.assets[0].uri);
        uploadedPhoto.current = null;
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to open your photos. Please try again.");
    } finally { setPicking(false); }
  };

  const continueSetup = async () => {
    if (saving.current || picking) return;
    setError("");
    if (!passwordStep) {
      setEmailTouched(true);
      if (!validPersonalEmail(email)) { emailRef.current?.focus(); return; }
      if (!photo) { setError("Add a profile picture to continue."); return; }
      if (!acceptedPreviously && !agree) { setError("Please read and agree to the community rules to continue."); return; }
    }
    Keyboard.dismiss();
    saving.current = true;
    setBusy(true);
    try {
      if (auth.currentUser?.uid !== user.uid) throw new Error("Your session has ended. Sign in again.");
      if (passwordStep) {
        if (!currentPassword) throw new Error("Enter your current password.");
        setProgress(step === "password-check" ? "Checking password…" : "Updating password…");
        if (step === "password-check") {
          await checkAccountPassword(profileId, currentPassword);
        } else {
          if (newPassword !== confirmPassword) throw new Error("The new passwords do not match.");
          await changeAccountPassword(user, profileId, currentPassword, newPassword);
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
        }
        // The profile listener advances only after the backend saves the state.
        return;
      }
      let url = photo;
      if (!hasProfilePhoto(url)) {
        setProgress("Uploading photo…");
        if (uploadedPhoto.current?.local === photo) url = uploadedPhoto.current.url;
        else {
          try { url = await uploadProfileImage(photo); }
          catch { throw new Error("Your photo could not be uploaded. Check your connection and try again. Your selection has been kept."); }
          uploadedPhoto.current = { local: photo, url };
        }
      }
      if (!hasProfilePhoto(url)) throw new Error("The upload did not return a valid photo. Please choose the photo again.");
      setProgress("Saving profile…");
      // Preserve the school login email and separately verified recovery inbox.
      await updateProfile(user, { photoURL: url });
      const fields = {
        email: email.trim().toLowerCase(), profileImage: url, updatedAt: serverTimestamp(),
        ...(!acceptedPreviously ? { communityRulesVersion: COMMUNITY_RULES_VERSION, communityRulesAcceptedAt: serverTimestamp() } : {}),
      };
      await updateDoc(doc(db, "students", profileId), fields);
      // Root navigation unlocks Home after the committed profile snapshot.
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const message = code === "auth/invalid-credential" || code === "auth/wrong-password"
        ? "Your current password is incorrect. Please try again."
        : code === "auth/network-request-failed" || code === "unavailable"
          ? "Check your internet connection and try again."
          : code === "permission-denied" ? "Your profile could not be saved. Please try again or contact your administrator."
            : error instanceof Error ? error.message : "Unable to save your profile. Please try again.";
      setError(message);
    } finally {
      saving.current = false;
      setBusy(false);
      setProgress("");
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding" enabled={Platform.OS !== "web"}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.flex}>
        <ScrollView ref={scrollRef} style={styles.flex} onLayout={revealFocusedInput} onScroll={event => { scrollOffset.current = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={16} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"} showsVerticalScrollIndicator={false}>
          <View style={styles.brand}><Ionicons name="school-outline" color="#8f2117" size={22} /><Text style={styles.brandText}>BondED</Text></View>
          {passwordStep ? <>
            <View style={styles.lock}><Ionicons name="lock-closed-outline" size={38} color="#8f2117" /></View>
            <Text style={styles.heading}>{step === "password-check" ? "Secure Your Account" : "Choose Your Password"}</Text>
            <Text style={styles.subtext}>{step === "password-check" ? "Confirm your current password once. If you already chose your own password, you can keep it." : "Replace your school-issued temporary password with a password only you know."}</Text>
            <Text style={styles.label}>Current password</Text>
            <SetupPasswordInput label="Current password" inputRef={currentPasswordRef} value={currentPassword} onChangeText={setCurrentPassword} placeholder="Enter your current password" textContentType="password" editable={!busy} onFocus={() => focusField(currentPasswordRef.current)} returnKeyType={step === "password" ? "next" : "done"} submitBehavior={step === "password" ? "submit" : "blurAndSubmit"} onSubmitEditing={() => { if (step === "password") newPasswordRef.current?.focus(); else void continueSetup(); }} />
            {step === "password" && <>
              <Text style={styles.label}>New password</Text>
              <SetupPasswordInput label="New password" inputRef={newPasswordRef} value={newPassword} onChangeText={setNewPassword} placeholder="Create a new password" textContentType="newPassword" editable={!busy} onFocus={() => focusField(newPasswordRef.current)} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => confirmPasswordRef.current?.focus()} />
              <Text style={styles.hint}>Use at least 8 characters, including a number and a special character.</Text>
              <Text style={styles.label}>Confirm new password</Text>
              <SetupPasswordInput label="Confirm new password" inputRef={confirmPasswordRef} value={confirmPassword} onChangeText={setConfirmPassword} placeholder="Re-enter your new password" textContentType="newPassword" editable={!busy} onFocus={() => focusField(confirmPasswordRef.current)} returnKeyType="done" onSubmitEditing={() => void continueSetup()} />
            </>}
          </> : <>
            <Text style={styles.heading}>Complete Your Profile</Text>
            <Text style={styles.subtext}>Add your email and profile picture to personalize your account.</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={photo ? "Change profile photo" : "Add profile photo"} disabled={busy || picking} onPress={() => void pickPhoto()} style={styles.photoButton}>
              <View style={styles.avatar}>{photo ? <Image source={{ uri: photo }} style={styles.avatarImage} contentFit="cover" /> : <Ionicons name="person-outline" size={62} color="#b48a7b" />}</View>
              <View style={styles.photoBadge}>{picking ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="camera" size={19} color="#fff" />}</View>
            </TouchableOpacity>
            <TouchableOpacity disabled={busy || picking} onPress={() => void pickPhoto()}><Text style={styles.photoLink}>{photo ? "Change Photo" : "Add Photo"}</Text></TouchableOpacity>
            <Text style={styles.label}>Email address</Text>
            <TextInput ref={emailRef} accessibilityLabel="Email address" style={[styles.input, !!emailError && styles.invalidInput]} value={email} onChangeText={setEmail} onFocus={() => focusField(emailRef.current)} onBlur={() => setEmailTouched(true)} placeholder="Enter your email address" placeholderTextColor="#a88d84" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" autoCapitalize="none" autoCorrect={false} maxLength={254} editable={!busy} returnKeyType="done" onSubmitEditing={Keyboard.dismiss} />
            {!!emailError && <Text accessibilityRole="alert" style={styles.error}>{emailError}</Text>}
            <Text style={styles.hint}>You will still sign in with your school ID. You can verify a recovery email from your profile.</Text>
            {!acceptedPreviously ? <View style={styles.rules}>
              <Text style={styles.rulesHeading}>Our community rules</Text>
              {COMMUNITY_RULES.map((rule, index) => <View key={rule.title} style={styles.rule}><Text style={styles.ruleTitle}>{index + 1}. {rule.title}</Text><Text style={styles.ruleText}>{rule.text}</Text></View>)}
              <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: agree, disabled: busy }} disabled={busy} style={styles.checkRow} onPress={() => setAgree(value => !value)}><Ionicons name={agree ? "checkbox" : "square-outline"} size={25} color="#8f2117" /><Text style={styles.checkText}>I agree to the community rules</Text></TouchableOpacity>
            </View> : <View style={styles.accepted}><Ionicons name="checkmark-circle" color="#2e7d32" size={20} /><Text style={styles.hint}>Community rules accepted</Text></View>}
          </>}
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        </ScrollView>
          <View style={styles.footer}>
            <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy || picking, busy }} disabled={busy || picking} onPress={() => void continueSetup()} style={[styles.continueButton, (busy || picking) && styles.disabled]}>
              {busy && <ActivityIndicator color="#fff" />}
              <Text style={styles.continueText}>{busy ? progress || "Saving…" : "Continue"}</Text>
              {!busy && <Ionicons name="arrow-forward" size={19} color="#fff" />}
            </TouchableOpacity>
            <SignOutButton disabled={busy} />
          </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, screen: { flex: 1, backgroundColor: "#fffaf7" },
  content: { flexGrow: 1, padding: 24, paddingTop: 16, width: "100%", maxWidth: 540, alignSelf: "center" },
  fallback: { flex: 1, justifyContent: "center", alignItems: "center", padding: 28, gap: 18 },
  brand: { flexDirection: "row", gap: 8, alignItems: "center", alignSelf: "center", marginBottom: 28 },
  brandText: { fontSize: 20, fontWeight: "800", color: "#8f2117" },
  heading: { fontSize: 27, fontWeight: "800", color: "#4d1b17", textAlign: "center" },
  subtext: { fontSize: 15, color: "#896f66", lineHeight: 23, textAlign: "center", marginTop: 10, marginBottom: 18 },
  photoButton: { alignSelf: "center", marginTop: 8 }, avatar: { width: 128, height: 128, borderRadius: 64, backgroundColor: "#f5eae5", borderWidth: 3, borderColor: "#ecd8ca", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarImage: { width: "100%", height: "100%" }, photoBadge: { position: "absolute", right: 2, bottom: 4, width: 36, height: 36, borderRadius: 18, backgroundColor: "#8f2117", borderWidth: 3, borderColor: "#fffaf7", alignItems: "center", justifyContent: "center" },
  photoLink: { color: "#8f2117", fontWeight: "700", textAlign: "center", padding: 14 },
  label: { color: "#4d1b17", fontSize: 14, fontWeight: "700", marginTop: 18, marginBottom: 9 },
  input: { minHeight: 52, backgroundColor: "#f5eae5", borderRadius: 16, paddingHorizontal: 16, paddingVertical: 13, fontSize: 16, color: "#4d1b17", borderWidth: 1, borderColor: "#ecded6" },
  passwordField: { flexDirection: "row", alignItems: "center", minHeight: 52, backgroundColor: "#f5eae5", borderRadius: 16, borderWidth: 1, borderColor: "#ecded6" },
  passwordInput: { flex: 1, minWidth: 0, minHeight: 52, paddingLeft: 16, paddingRight: 4, paddingVertical: 13, fontSize: 16, color: "#4d1b17" },
  eyeButton: { width: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  invalidInput: { borderColor: "#b3261e" }, hint: { color: "#896f66", fontSize: 12, lineHeight: 18, marginTop: 7 },
  rules: { marginTop: 26, padding: 18, borderRadius: 20, backgroundColor: "#fff", borderWidth: 1, borderColor: "#ecded6" },
  rulesHeading: { color: "#4d1b17", fontWeight: "800", fontSize: 18, marginBottom: 4 },
  rule: { marginTop: 14 }, ruleTitle: { color: "#633b30", fontSize: 14, fontWeight: "700", marginBottom: 5 }, ruleText: { color: "#896f66", fontSize: 13, lineHeight: 20 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14, marginTop: 12, minHeight: 48 }, checkText: { flex: 1, color: "#4d1b17", fontSize: 14, fontWeight: "600" },
  accepted: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 20 },
  error: { color: "#b3261e", fontSize: 13, lineHeight: 20, marginTop: 10 },
  footer: { width: "100%", maxWidth: 540, alignSelf: "center", paddingHorizontal: 24, paddingTop: 12 }, continueButton: { minHeight: 54, backgroundColor: "#8f2117", borderRadius: 18, paddingHorizontal: 24, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 10 },
  continueText: { color: "#fff", fontSize: 16, fontWeight: "800" }, disabled: { opacity: 0.65 }, signOut: { padding: 16, alignItems: "center" }, link: { color: "#896f66", fontSize: 14, fontWeight: "600" },
  lock: { alignSelf: "center", width: 90, height: 90, borderRadius: 45, backgroundColor: "#f5eae5", justifyContent: "center", alignItems: "center", marginBottom: 20 },
});

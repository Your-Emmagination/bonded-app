// app/(main)/EditProfileScreen.tsx
//
// Editing your account: personal email, password and profile photo.
//
// This used to be a pop-up on the Profile tab, reached from Settings by a round
// trip — Settings sent you to the Profile tab, which then opened the pop-up, so
// "back" landed on Profile instead of where you started. As a screen of its
// own it opens from Settings and returns there.
//
// The three tabs are kept exactly as they were; `?tab=password` or `?tab=photo`
// opens on that tab, which is how Settings' Change Password row and a
// long-press on your own avatar land in the right place.
import { useAccountSetup } from "@/contexts/AccountSetupContext";
import { useThemeColors } from "@/contexts/ThemeContext";
import { changeAccountPassword } from "@/utils/changeAccountPassword";
import { AVATAR_SIZE_LARGE, avatarThumb } from "@/utils/cloudinaryImages";
import { uploadProfileImage } from "@/utils/cloudinaryUpload";
import { useNetworkStatus } from "@/utils/networkUtils";
import { saveCachedMyProfile } from "@/utils/offlineStorage";
import { validateNewPassword } from "@/utils/passwordPolicy";
import {
  confirmRecoveryEmailVerification,
  startRecoveryEmailVerification,
} from "@/utils/passwordReset";
import { profileEmail } from "@/utils/profileSetup";
import { updateUserDataCache } from "@/utils/rbac";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { updateProfile } from "firebase/auth";
import { doc, onSnapshot, updateDoc } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { auth, db } from "../../Firebase_configure";
import ConfirmDialog, { type ConfirmDialogVariant } from "./components/ConfirmDialog";

type TabKey = "info" | "password" | "photo";

type Student = {
  studentID?: string;
  email?: string;
  profileImage?: string;
  recoveryEmail?: string;
  recoveryEmailVerified?: boolean;
  firstname?: string;
  lastname?: string;
};

const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "info", label: "Edit Info", icon: "create-outline" },
  { key: "password", label: "Change Password", icon: "lock-closed-outline" },
  { key: "photo", label: "Change Photo", icon: "camera-outline" },
];

const parseTab = (value?: string | string[]): TabKey => {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "password" || raw === "photo" ? raw : "info";
};

type DialogState = {
  title: string;
  description?: string;
  variant: ConfirmDialogVariant;
  onConfirm: () => void;
};

export default function EditProfileScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const { tab } = useLocalSearchParams<{ tab?: string | string[] }>();
  const [selectedTab, setSelectedTab] = useState<TabKey>(() => parseTab(tab));

  const { profileId: accountProfileId } = useAccountSetup();
  const { isOffline } = useNetworkStatus();
  const user = auth.currentUser;
  const profileDocId =
    accountProfileId || user?.email?.split("@")[0] || user?.uid || "";

  const [student, setStudent] = useState<Student | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  useEffect(() => {
    if (!profileDocId) return;
    return onSnapshot(
      doc(db, "students", profileDocId),
      (snapshot) => {
        setStudent(snapshot.exists() ? (snapshot.data() as Student) : null);
        setProfileLoaded(true);
      },
      (error) => {
        if (auth.currentUser) console.error("Edit profile listener failed:", error);
        setProfileLoaded(true);
      },
    );
  }, [profileDocId]);

  // One dialog for every message on the screen, as on the Profile tab.
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const showInfo = useCallback((title: string, description?: string) => {
    const t = title.toLowerCase();
    const variant: ConfirmDialogVariant = /success|updated|verified|changed|saved/.test(t)
      ? "success"
      : /error|failed|unable/.test(t)
        ? "destructive"
        : /validation|required|invalid|weak|same/.test(t)
          ? "warning"
          : "info";
    setDialog({ title, description, variant, onConfirm: () => setDialog(null) });
  }, []);

  // ── Photo ───────────────────────────────────────────────────────────────
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  const pickImage = useCallback(
    async (useCamera: boolean) => {
      if (isOffline) {
        showInfo("Offline", "You are currently offline. Updating profile photo is unavailable.");
        return;
      }
      try {
        const permission = useCamera
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (permission.status !== "granted") {
          showInfo("Permission required", `Allow ${useCamera ? "camera" : "photo"} access.`);
          return;
        }
        const result = await (useCamera
          ? ImagePicker.launchCameraAsync
          : ImagePicker.launchImageLibraryAsync)({
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
        });
        if (!result.canceled && result.assets?.[0]?.uri) {
          setPendingImage(result.assets[0].uri);
        }
      } catch (error: any) {
        showInfo("Error", `Failed to update photo: ${error?.message || "Please try again."}`);
      }
    },
    [isOffline, showInfo],
  );

  const savePhoto = useCallback(async () => {
    if (!pendingImage || !user) return;
    if (isOffline) {
      showInfo("Offline", "You are currently offline. Uploading profile photo is unavailable.");
      return;
    }
    const docId = student?.studentID || profileDocId;
    if (!docId) return;

    setPhotoBusy(true);
    try {
      const url = await uploadProfileImage(pendingImage);
      await updateDoc(doc(db, "students", docId), { profileImage: url });
      // Some accounts keep a second profile document under the auth uid.
      if (user.uid !== docId) {
        updateDoc(doc(db, "students", user.uid), { profileImage: url }).catch(() => undefined);
      }
      updateProfile(user, { photoURL: url }).catch((error) =>
        console.warn("Error updating auth photoURL:", error),
      );
      updateUserDataCache(
        [user.uid, docId, user.email?.split("@")[0]?.trim()].filter(Boolean) as string[],
        { profileImage: url },
      );
      if (student) saveCachedMyProfile(user.uid, { ...student, profileImage: url });

      setPendingImage(null);
      showInfo("Success", "Profile photo updated!");
    } catch (error: any) {
      showInfo("Error", `Failed to update photo: ${error?.message || "Please try again."}`);
    } finally {
      setPhotoBusy(false);
    }
  }, [pendingImage, user, isOffline, student, profileDocId, showInfo]);

  // ── Password ────────────────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const studentNumber = student?.studentID;

  const changePassword = useCallback(async () => {
    if (!user || passwordBusy) return;
    if (isOffline) {
      showInfo("Offline", "You are currently offline. Changing password is unavailable.");
      return;
    }
    if (!currentPassword || !newPassword) {
      showInfo("Error", "Enter both current and new password.");
      return;
    }
    if (currentPassword === newPassword) {
      showInfo("Same Password", "Your new password must be different from your current one.");
      return;
    }
    const policyError = validateNewPassword(newPassword);
    if (policyError) {
      showInfo("Weak Password", policyError);
      return;
    }

    setPasswordBusy(true);
    try {
      await changeAccountPassword(
        user,
        studentNumber || user.email?.split("@")[0] || user.uid,
        currentPassword,
        newPassword,
      );
      setCurrentPassword("");
      setNewPassword("");
      showInfo("Success", "Password changed successfully!");
    } catch (error: any) {
      showInfo("Error", error?.message || "Failed to change password");
    } finally {
      setPasswordBusy(false);
    }
  }, [user, passwordBusy, isOffline, currentPassword, newPassword, studentNumber, showInfo]);

  const currentPhoto = student?.profileImage
    ? avatarThumb(student.profileImage, AVATAR_SIZE_LARGE)
    : null;

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable style={styles.iconButton} onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={theme.onChrome} />
        </Pressable>
        <Text style={styles.headerTitle}>Edit Profile</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        enabled={Platform.OS !== "web"}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {isOffline && (
            <View style={styles.offlineBar}>
              <Ionicons name="cloud-offline-outline" size={14} color={theme.warning} />
              <Text style={styles.offlineText}>Offline mode</Text>
            </View>
          )}

          <View style={styles.tabRow}>
            {TABS.map(({ key, label, icon }) => {
              const active = selectedTab === key;
              return (
                <TouchableOpacity
                  key={key}
                  onPress={() => setSelectedTab(key)}
                  style={[styles.tabButton, active && styles.tabButtonActive]}
                  activeOpacity={0.8}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                >
                  <Ionicons
                    name={icon}
                    size={18}
                    color={active ? theme.onPrimary : theme.textMuted}
                    style={styles.tabIcon}
                  />
                  <Text style={[styles.tabText, active && styles.tabTextActive]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.card}>
            {selectedTab === "info" &&
              (profileLoaded ? (
                // Keyed on the account, not the email: it starts from the saved
                // values and then keeps its own state, so a verification in
                // progress isn't wiped when the saved email updates underneath.
                <InfoTab
                  key={profileDocId}
                  studentID={student?.studentID || profileDocId}
                  initialEmail={
                    student?.recoveryEmail || profileEmail({ email: student?.email })
                  }
                  initialVerified={student?.recoveryEmailVerified}
                />
              ) : (
                <ActivityIndicator color={theme.accent} style={styles.loader} />
              ))}

            {selectedTab === "password" && (
              <PasswordTab
                currentPassword={currentPassword}
                newPassword={newPassword}
                onCurrentPassword={setCurrentPassword}
                onNewPassword={setNewPassword}
                onSubmit={changePassword}
                busy={passwordBusy}
              />
            )}

            {selectedTab === "photo" && (
              <PhotoTab
                currentUri={currentPhoto}
                previewUri={pendingImage}
                onPick={pickImage}
                onSave={savePhoto}
                onCancel={() => setPendingImage(null)}
                busy={photoBusy}
              />
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={dialog !== null}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        variant={dialog?.variant}
        confirmText="OK"
        singleAction
        onConfirm={() => dialog?.onConfirm()}
        onCancel={() => setDialog(null)}
      />
    </SafeAreaView>
  );
}

// Personal email address = the account's recovery email. Saving a new one
// verifies it with a 6-digit code (utils/passwordReset -> the Worker) so
// "Forgot password?" has a real inbox to send the reset code to.
function InfoTab({
  studentID,
  initialEmail,
  initialVerified,
}: {
  studentID: string;
  initialEmail?: string;
  initialVerified?: boolean;
}) {
  const { styles, theme } = useStyles();
  const [savedEmail, setSavedEmail] = useState(initialEmail ?? "");
  const [savedVerified, setSavedVerified] = useState(initialVerified === true);
  const [draft, setDraft] = useState(initialEmail ?? "");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    },
    [],
  );

  const startCooldown = useCallback(() => {
    setCooldown(60);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setCooldown((value) => {
        if (value <= 1 && cooldownRef.current) {
          clearInterval(cooldownRef.current);
          cooldownRef.current = null;
        }
        return value - 1;
      });
    }, 1000);
  }, []);

  const trimmed = draft.trim().toLowerCase();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  const emailChanged = trimmed !== savedEmail.trim().toLowerCase();
  const nothingToDo = !emailChanged && savedVerified;

  const editEmail = (text: string) => {
    setDraft(text);
    setError(null);
    if (stage === "code") {
      setStage("email");
      setCode("");
      setNotice(null);
    }
  };

  const sendCode = useCallback(async () => {
    if (busy || cooldown > 0) return;
    setError(null);
    setNotice(null);
    if (!emailValid) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    try {
      await startRecoveryEmailVerification(studentID, trimmed);
      setStage("code");
      setNotice(`Code sent to ${trimmed}.`);
      startCooldown();
    } catch (e: any) {
      setError(e?.message || "Couldn't send the code. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, cooldown, emailValid, studentID, trimmed, startCooldown]);

  const onSave = useCallback(async () => {
    if (busy || nothingToDo) return;
    if (stage === "email") {
      await sendCode();
      return;
    }
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code.");
      return;
    }
    setBusy(true);
    try {
      const res = (await confirmRecoveryEmailVerification(studentID, code.trim())) as {
        recoveryEmail?: string;
      };
      setSavedEmail(res.recoveryEmail || trimmed);
      setSavedVerified(true);
      setStage("email");
      setCode("");
      setNotice("Email verified.");
    } catch (e: any) {
      setError(e?.message || "Couldn't verify the code. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, nothingToDo, stage, code, studentID, trimmed, sendCode]);

  return (
    <View>
      <View style={styles.fieldLabelRow}>
        <Text style={styles.inputLabel}>Personal Email Address</Text>
        {savedEmail ? (
          <View
            style={[styles.verifyChip, savedVerified ? styles.verifyChipOk : styles.verifyChipWarn]}
          >
            <Ionicons
              name={savedVerified ? "checkmark-circle" : "alert-circle"}
              size={14}
              color={savedVerified ? theme.success : theme.warning}
            />
          </View>
        ) : null}
      </View>
      <Text style={styles.fieldHint}>
        Used to send you a code if you ever forget your password.
      </Text>

      <View style={styles.inputWrap}>
        <Ionicons name="mail-outline" size={17} color={theme.textMuted} style={styles.inputIcon} />
        <TextInput
          style={styles.inputWithIcon}
          placeholder="Enter email address"
          placeholderTextColor={theme.textMuted}
          value={draft}
          onChangeText={editEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
        />
      </View>

      {stage === "code" ? (
        <View style={styles.inputWrap}>
          <Ionicons name="keypad-outline" size={17} color={theme.textMuted} style={styles.inputIcon} />
          <TextInput
            style={[styles.inputWithIcon, styles.codeField]}
            placeholder="6-digit code"
            placeholderTextColor={theme.textMuted}
            value={code}
            onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
            keyboardType="number-pad"
            maxLength={6}
            editable={!busy}
          />
          <TouchableOpacity
            onPress={sendCode}
            disabled={busy || cooldown > 0}
            style={styles.resendInline}
          >
            <Text style={[styles.resendInlineText, (busy || cooldown > 0) && styles.mutedText]}>
              {cooldown > 0 ? `${cooldown}s` : "Resend"}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {notice ? <Text style={styles.infoNotice}>{notice}</Text> : null}
      {error ? <Text style={styles.infoError}>{error}</Text> : null}

      <TouchableOpacity
        style={[styles.primaryBtn, (busy || nothingToDo) && styles.btnMuted]}
        onPress={onSave}
        disabled={busy || nothingToDo}
        activeOpacity={0.85}
      >
        {busy ? (
          <ActivityIndicator color={theme.onPrimary} />
        ) : (
          <Text style={styles.primaryText}>
            {stage === "code" ? "Verify Email" : "Save Changes"}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  editable,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  editable: boolean;
}) {
  const { styles, theme } = useStyles();
  const [visible, setVisible] = useState(false);
  return (
    <>
      <Text style={styles.inputLabel}>{label}</Text>
      <View style={styles.inputWrap}>
        <Ionicons name="lock-closed-outline" size={17} color={theme.textMuted} style={styles.inputIcon} />
        <TextInput
          style={styles.inputWithIcon}
          placeholder={label}
          placeholderTextColor={theme.textMuted}
          secureTextEntry={!visible}
          value={value}
          onChangeText={onChange}
          autoCapitalize="none"
          autoCorrect={false}
          editable={editable}
        />
        <TouchableOpacity
          onPress={() => setVisible((current) => !current)}
          style={styles.eyeButton}
          accessibilityLabel={visible ? `Hide ${label}` : `Show ${label}`}
        >
          <Ionicons
            name={visible ? "eye-off-outline" : "eye-outline"}
            size={20}
            color={theme.textMuted}
          />
        </TouchableOpacity>
      </View>
    </>
  );
}

function PasswordTab({
  currentPassword,
  newPassword,
  onCurrentPassword,
  onNewPassword,
  onSubmit,
  busy,
}: {
  currentPassword: string;
  newPassword: string;
  onCurrentPassword: (text: string) => void;
  onNewPassword: (text: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const { styles, theme } = useStyles();
  return (
    <View>
      <PasswordField
        label="Current Password"
        value={currentPassword}
        onChange={onCurrentPassword}
        editable={!busy}
      />
      <PasswordField
        label="New Password"
        value={newPassword}
        onChange={onNewPassword}
        editable={!busy}
      />
      <TouchableOpacity
        style={[styles.primaryBtn, busy && styles.btnMuted]}
        onPress={onSubmit}
        disabled={busy}
        activeOpacity={0.85}
      >
        {busy ? (
          <ActivityIndicator color={theme.onPrimary} />
        ) : (
          <Text style={styles.primaryText}>Update Password</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

function PhotoTab({
  currentUri,
  previewUri,
  onPick,
  onSave,
  onCancel,
  busy,
}: {
  currentUri: string | null | undefined;
  previewUri: string | null;
  onPick: (useCamera: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { styles, theme } = useStyles();
  // Showing the current photo too means you can see what you are replacing
  // before you choose anything.
  const shown = previewUri || currentUri;

  return (
    <View>
      <View style={styles.photoPreview}>
        {shown ? (
          <Image source={{ uri: shown }} style={styles.photo} contentFit="cover" />
        ) : (
          <View style={[styles.photo, styles.photoEmpty]}>
            <Ionicons name="person" size={44} color={theme.textMuted} />
          </View>
        )}
        <Text style={styles.photoCaption}>
          {previewUri ? "Preview" : shown ? "Current photo" : "No photo yet"}
        </Text>
      </View>

      <TouchableOpacity style={styles.option} onPress={() => onPick(false)} disabled={busy}>
        <Ionicons name="images-outline" size={20} color={theme.accent} />
        <Text style={styles.optionText}>Choose from Gallery</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.option} onPress={() => onPick(true)} disabled={busy}>
        <Ionicons name="camera-outline" size={20} color={theme.accent} />
        <Text style={styles.optionText}>Take Photo</Text>
      </TouchableOpacity>

      {previewUri && (
        <View style={styles.photoActions}>
          <TouchableOpacity
            style={[styles.secondaryBtn, styles.flex]}
            onPress={onCancel}
            disabled={busy}
          >
            <Text style={styles.secondaryText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.primaryBtn, styles.flex, styles.photoSave, busy && styles.btnMuted]}
            onPress={onSave}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={theme.onPrimary} />
            ) : (
              <Text style={styles.primaryText}>Save Photo</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    flex: { flex: 1 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 12,
      backgroundColor: c.chrome,
    },
    iconButton: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
    headerTitle: {
      flex: 1,
      textAlign: "center",
      color: c.onChrome,
      fontSize: 17,
      fontWeight: "800",
    },
    headerSpacer: { width: 34 },

    content: { padding: 16, gap: 14 },
    offlineBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: c.accentSoft,
    },
    offlineText: { color: c.warning, fontSize: 12.5, fontWeight: "700" },

    tabRow: {
      flexDirection: "row",
      backgroundColor: c.surfaceSunken,
      borderRadius: 12,
      padding: 4,
      gap: 4,
    },
    tabButton: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 10,
      borderRadius: 10,
    },
    tabButtonActive: { backgroundColor: c.primary },
    tabIcon: { marginBottom: 2 },
    tabText: { color: c.textMuted, fontSize: 11, textAlign: "center", fontWeight: "600" },
    tabTextActive: { color: c.onPrimary },

    card: {
      backgroundColor: c.surface,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.border,
      padding: 16,
    },
    loader: { marginVertical: 24 },

    fieldLabelRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 2,
    },
    inputLabel: {
      color: c.textSecondary,
      fontSize: 12.5,
      marginBottom: 6,
      marginLeft: 2,
      fontWeight: "700",
    },
    fieldHint: { color: c.textMuted, fontSize: 12, marginBottom: 10, marginLeft: 2 },
    verifyChip: {
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: "center",
      justifyContent: "center",
    },
    verifyChipOk: { backgroundColor: c.successSoft },
    verifyChipWarn: { backgroundColor: c.accentSoft },
    inputWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surfaceSunken,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.borderStrong,
      paddingHorizontal: 10,
      marginBottom: 12,
    },
    inputIcon: { marginRight: 8 },
    inputWithIcon: { flex: 1, color: c.textPrimary, paddingVertical: 12, fontSize: 14 },
    eyeButton: { padding: 6 },
    codeField: { letterSpacing: 4, fontSize: 16 },
    resendInline: { paddingHorizontal: 8, paddingVertical: 6 },
    resendInlineText: { color: c.accent, fontWeight: "700", fontSize: 12 },
    mutedText: { color: c.textMuted },
    infoNotice: { color: c.success, fontSize: 12, marginBottom: 8, marginTop: 2 },
    infoError: { color: c.danger, fontSize: 12, marginBottom: 8, marginTop: 2 },

    primaryBtn: {
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 6,
    },
    primaryText: { color: c.onPrimary, fontWeight: "800", fontSize: 14.5 },
    btnMuted: { opacity: 0.55 },
    secondaryBtn: {
      backgroundColor: c.surfaceSunken,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: c.border,
    },
    secondaryText: { color: c.textSecondary, fontWeight: "700", fontSize: 14.5 },

    photoPreview: { alignItems: "center", marginBottom: 16 },
    photo: {
      width: 120,
      height: 120,
      borderRadius: 60,
      borderWidth: 3,
      borderColor: c.accent,
    },
    photoEmpty: {
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceSunken,
    },
    photoCaption: { marginTop: 8, color: c.textSecondary, fontWeight: "600" },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: c.surfaceSunken,
      padding: 14,
      borderRadius: 12,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: c.border,
    },
    optionText: { color: c.textPrimary, fontSize: 15, fontWeight: "600" },
    photoActions: { flexDirection: "row", gap: 10, marginTop: 6 },
    photoSave: { marginTop: 0 },
  });

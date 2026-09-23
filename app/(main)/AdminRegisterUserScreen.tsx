import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { deleteApp, initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
// The keyboard library's own view. It follows the keyboard frame by frame;
// React Native's built-in one stopped lifting anything on Android once
// KeyboardProvider (app/_layout.tsx) took over the keyboard.
import {
  KeyboardAvoidingView,
  KeyboardAwareScrollView,
} from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import ConfirmDialog, { type ConfirmDialogVariant } from "./components/ConfirmDialog";
import { auth, db, firebaseConfig } from "../../Firebase_configure";
import {
  getPermissionsForRole,
  getUserData,
  parseUserRole,
  type UserRole,
} from "@/utils/rbac";
import { normalizeYearLevel, YEAR_LEVELS } from "@/utils/yearLevels";

const ROLES: UserRole[] = ["student", "teacher", "moderator", "admin"];

type Program = {
  id: string;
  name: string;
  code: string;
  description?: string;
};

type RegistrationInput = {
  studentID: string;
  firstname: string;
  lastname: string;
  course: string;
  yearlvl: string;
  userType: UserRole;
};

type RegistrationResult = RegistrationInput & {
  success: boolean;
  email?: string;
  temporaryPassword?: string;
  message?: string;
};

function generatedEmail(studentID: string, role: UserRole) {
  const domains: Record<UserRole, string> = {
    student: "@student.csap",
    moderator: "@student.csap",
    teacher: "@teacher.csap",
    admin: "@admin.csap",
  };
  return `${studentID.trim()}${domains[role]}`.toLowerCase();
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function parseCsv(text: string): RegistrationInput[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("The CSV must contain a header and at least one user.");

  const headers = parseCsvLine(lines[0]).map((item) => item.toLowerCase());
  const required = ["studentid", "firstname", "lastname", "course", "yearlvl", "usertype"];
  const missing = required.filter((key) => !headers.includes(key));
  if (missing.length) throw new Error(`Missing CSV columns: ${missing.join(", ")}`);

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => { row[header] = values[index] || ""; });
    const rawRole = row.usertype.toLowerCase().trim() as UserRole;
    return {
      studentID: row.studentid,
      firstname: row.firstname,
      lastname: row.lastname,
      course: row.course,
      yearlvl: row.yearlvl,
      userType: ROLES.includes(rawRole) ? rawRole : "student",
    };
  });
}

async function readPickedFile(uri: string) {
  const response = await fetch(uri);
  if (!response.ok) throw new Error("Unable to read the selected CSV file.");
  return response.text();
}

async function createManagedUser(input: RegistrationInput): Promise<RegistrationResult> {
  const studentID = input.studentID.trim();
  const firstname = input.firstname.trim();
  const lastname = input.lastname.trim();
  const course = input.course.trim();
  const yearlvl = input.yearlvl.trim();
  const role = input.userType;

  if (!studentID || !firstname || !lastname) {
    throw new Error("Student ID, first name, and last name are required.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(studentID)) {
    throw new Error("Student/Staff ID contains unsupported characters.");
  }
  if (!lastname) throw new Error("Last name is required.");
  if ((role === "student" || role === "moderator") && !course) {
    throw new Error("A program/course is required for student accounts.");
  }
  if ((role === "student" || role === "moderator") && !normalizeYearLevel(yearlvl)) {
    throw new Error("A valid year level is required for student accounts.");
  }

  const email = generatedEmail(studentID, role);
  const temporaryPassword = `${lastname}12345`;
  if (temporaryPassword.length < 6) throw new Error("Last name must contain at least one character.");

  // A secondary Firebase app creates the new account without signing the
  // currently logged-in administrator out of the primary app.
  const secondaryName = `bonded-registration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const secondaryApp = initializeApp(firebaseConfig, secondaryName);
  const secondaryAuth = getAuth(secondaryApp);
  let createdUser: User | null = null;

  try {
    const credential = await createUserWithEmailAndPassword(secondaryAuth, email, temporaryPassword);
    createdUser = credential.user;
    await updateProfile(createdUser, { displayName: `${firstname} ${lastname}`.trim() });

    await setDoc(doc(db, "students", studentID), {
      studentID,
      firstname,
      lastname,
      // App-wide search: lowercased name fields for the prefix-range query.
      firstnameLower: firstname.trim().toLowerCase(),
      lastnameLower: lastname.trim().toLowerCase(),
      email,
      course: course || "",
      yearlvl: yearlvl || "",
      role,
      permissions: getPermissionsForRole(role),
      userId: createdUser.uid,
      bio: "",
      isOnline: false,
      mustChangePassword: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    return {
      ...input,
      studentID,
      firstname,
      lastname,
      course,
      yearlvl,
      email,
      temporaryPassword,
      success: true,
    };
  } catch (error: any) {
    try {
      if (createdUser) await deleteUser(createdUser);
    } catch (_) {
      // Best-effort cleanup. The original error is more useful to the admin.
    }
    if (error?.code === "auth/email-already-in-use") {
      throw new Error(`${email} is already registered.`);
    }
    if (error?.code === "auth/invalid-email") {
      throw new Error(`Generated email is invalid: ${email}`);
    }
    if (error?.code === "auth/weak-password") {
      throw new Error("The generated temporary password is too weak. Check the last name.");
    }
    throw new Error(error?.message || "Registration failed.");
  }finally {
  try {
    await signOut(secondaryAuth);
  } catch (_) {}

  try {
    await deleteApp(secondaryApp);
  } catch (_) {}
}
}

export default function AdminRegisterUserScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const [role, setRole] = useState<UserRole>("student");
  const [firstname, setFirstname] = useState("");
  const [lastname, setLastname] = useState("");
  const [studentID, setStudentID] = useState("");
  const [course, setCourse] = useState("");
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(null);
  const [yearlvl, setYearlvl] = useState("1st Year");
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkSummary, setBulkSummary] = useState<{ created: number; failed: number } | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [programsLoading, setProgramsLoading] = useState(true);
  const [programPickerOpen, setProgramPickerOpen] = useState(false);
  const [yearPickerOpen, setYearPickerOpen] = useState(false);

  // Single dialog state used to render every alert on this screen through
  // the app's branded ConfirmDialog instead of the bare native Alert.alert.
  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    variant?: ConfirmDialogVariant;
    singleAction?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const showInfo = (title: string, description?: string, onConfirm?: () => void, variant?: ConfirmDialogVariant) => {
    setDialog({
      title,
      description,
      variant,
      confirmText: "OK",
      singleAction: true,
      onConfirm: () => {
        setDialog(null);
        onConfirm?.();
      },
    });
  };
  const showConfirm = (options: {
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    onConfirm: () => void;
  }) => {
    setDialog({
      ...options,
      onConfirm: () => {
        setDialog(null);
        options.onConfirm();
      },
    });
  };

  const email = useMemo(() => generatedEmail(studentID, role), [studentID, role]);
  const temporaryPassword = useMemo(() => `${lastname.trim()}12345`, [lastname]);
  const fullName = useMemo(() => `${firstname.trim()} ${lastname.trim()}`.trim(), [firstname, lastname]);

  useEffect(() => {
    getUserData(auth.currentUser?.uid || "").then((data) => {
      setAuthorized(parseUserRole(data?.role) === "admin");
    }).catch(() => setAuthorized(false));
  }, []);

  useEffect(() => {
    if (authorized !== true) return;
    const programsQuery = query(collection(db, "programs"), orderBy("name", "asc"));
    const unsubscribe = onSnapshot(
      programsQuery,
      (snapshot) => {
        const next = snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Program, "id">) }));
        setPrograms(next);
        setProgramsLoading(false);
      },
      (error) => {
        console.error("Program picker error:", error);
        setProgramsLoading(false);
      },
    );
    return unsubscribe;
  }, [authorized]);

  const filteredPrograms = useMemo(() => {
    const value = course.trim().toLowerCase();
    if (!value) return programs;
    return programs.filter((program) => `${program.name} ${program.code}`.toLowerCase().includes(value));
  }, [course, programs]);

  const handleRegister = async () => {
    if (!firstname.trim() || !lastname.trim() || !studentID.trim()) {
      showInfo("Incomplete Information", "First name, last name, and ID are required.");
      return;
    }
    if ((role === "student" || role === "moderator") && !selectedProgramId) {
      showInfo("Select a Program", "Choose a program from Manage Programs before registering this account.");
      return;
    }
    if ((role === "student" || role === "moderator") && !normalizeYearLevel(yearlvl)) {
      showInfo("Select Year Level", "Choose a valid year level.");
      return;
    }

    setLoading(true);
    try {
      const result = await createManagedUser({
        studentID,
        firstname,
        lastname,
        course,
        yearlvl,
        userType: role,
      });

      showInfo(
        "User Registered",
        `${fullName}\n\nEmail: ${result.email}\nTemporary password: ${result.temporaryPassword}\n\nThe user should change the temporary password after signing in.`,
        () => router.back(),
        "success",
      );
    } catch (error: any) {
      showInfo("Registration Failed", error?.message || "Unable to register the user.");
    } finally {
      setLoading(false);
    }
  };

  const handleImportCsv = async () => {
    if (bulkLoading) return;
    setBulkLoading(true);
    setBulkSummary(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["text/csv", "text/comma-separated-values", "application/vnd.ms-excel", "text/plain"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.[0]?.uri) return;
      const csvText = await readPickedFile(picked.assets[0].uri);
      const users = parseCsv(csvText).filter((user) => user.studentID && user.firstname && user.lastname);
      if (!users.length) throw new Error("No valid users were found in the CSV.");
      if (users.length > 250) throw new Error("The app accepts up to 250 users per CSV import.");

      let created = 0;
      let failed = 0;
      for (let index = 0; index < users.length; index += 5) {
        const batch = users.slice(index, index + 5);
        const results = await Promise.all(batch.map(async (user) => {
          try {
            await createManagedUser(user);
            return true;
          } catch (error) {
            console.warn("CSV registration failed:", user.studentID, error);
            return false;
          }
        }));
        results.forEach((ok) => ok ? created += 1 : failed += 1);
      }

      setBulkSummary({ created, failed });
      showInfo(
        "Import Complete",
        `${created} account${created === 1 ? "" : "s"} created.\n${failed} failed or skipped.`,
        undefined,
        failed > 0 ? "warning" : "success",
      );
    } catch (error: any) {
      showInfo("CSV Import Failed", error?.message || "Unable to import the CSV.");
    } finally {
      setBulkLoading(false);
    }
  };

  const selectProgram = (program: Program) => {
    setCourse(program.name);
    setSelectedProgramId(program.id);
    setProgramPickerOpen(false);
  };

  const changeCourseText = (value: string) => {
    setCourse(value);
    const exact = programs.find(
      (program) => program.name.toLowerCase() === value.trim().toLowerCase() || program.code.toLowerCase() === value.trim().toLowerCase(),
    );
    setSelectedProgramId(exact?.id || null);
  };

  if (authorized === null) {
    return <SafeAreaView style={styles.container}><ActivityIndicator size="large" color={theme.accent} /></SafeAreaView>;
  }

  if (!authorized) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Ionicons name="lock-closed" size={54} color={theme.accent} />
          <Text style={styles.title}>Access Denied</Text>
          <Text style={styles.muted}>Only administrators can register users.</Text>
          <TouchableOpacity style={styles.button} onPress={() => router.back()}><Text style={styles.buttonText}>Go Back</Text></TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const field = (label: string, value: string, onChangeText: (value: string) => void, placeholder: string) => (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={theme.textMuted} style={styles.input} />
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView automaticOffset style={{ flex: 1 }} behavior="padding">
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.textSecondary} /></TouchableOpacity>
          <Text style={styles.headerTitle}>Register User</Text>
          <View style={{ width: 24 }} />
        </View>

        <KeyboardAwareScrollView
          bottomOffset={20}
          contentContainerStyle={styles.content}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <View style={styles.heroIcon}><Ionicons name="person-add-outline" size={26} color={theme.onPrimary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroTitle}>Create a campus account</Text>
              <Text style={styles.heroText}>Accounts are created directly with Firebase. Your admin session stays signed in.</Text>
            </View>
          </View>

          {field("Student / Staff ID *", studentID, setStudentID, "012324-005432")}
          {field("First Name *", firstname, setFirstname, "Juan")}
          {field("Last Name *", lastname, setLastname, "Dela Cruz")}

          <Text style={styles.label}>User Type *</Text>
          <View style={styles.choiceRow}>
            {ROLES.map((item) => (
              <TouchableOpacity key={item} style={[styles.choice, role === item && styles.choiceActive]} onPress={() => setRole(item)}>
                <Text style={[styles.choiceText, role === item && styles.choiceTextActive]}>{item[0].toUpperCase() + item.slice(1)}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Program / Course {role === "student" || role === "moderator" ? "*" : ""}</Text>
          <View style={styles.searchShell}>
            <Ionicons name="search-outline" size={18} color={theme.textSecondary} />
            <TextInput
              value={course}
              onChangeText={changeCourseText}
              placeholder={programsLoading ? "Loading programs..." : "Search program or code"}
              placeholderTextColor={theme.textMuted}
              style={styles.searchInput}
              editable={!programsLoading}
            />
            <TouchableOpacity onPress={() => setProgramPickerOpen((value) => !value)}><Ionicons name={programPickerOpen ? "chevron-up" : "chevron-down"} size={20} color={theme.textSecondary} /></TouchableOpacity>
          </View>
          {programPickerOpen && (
            <View style={styles.dropdown}>
              {filteredPrograms.length === 0 ? <Text style={styles.dropdownEmpty}>No matching programs. Add one in Manage Programs.</Text> : filteredPrograms.map((program) => (
                <TouchableOpacity key={program.id} style={styles.dropdownItem} onPress={() => selectProgram(program)}>
                  <View style={styles.programBadge}><Text style={styles.programBadgeText}>{program.code.slice(0, 5)}</Text></View>
                  <View style={{ flex: 1 }}><Text style={styles.dropdownName}>{program.name}</Text><Text style={styles.dropdownCode}>{program.code}</Text></View>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={styles.label}>Year Level {role === "student" || role === "moderator" ? "*" : ""}</Text>
          <TouchableOpacity style={styles.select} onPress={() => setYearPickerOpen((value) => !value)}>
            <Text style={styles.selectText}>{yearlvl || "Select year level"}</Text>
            <Ionicons name={yearPickerOpen ? "chevron-up" : "chevron-down"} size={20} color={theme.textSecondary} />
          </TouchableOpacity>
          {yearPickerOpen && <View style={styles.dropdown}>{YEAR_LEVELS.map((item) => <TouchableOpacity key={item} style={styles.dropdownItemSimple} onPress={() => { setYearlvl(item); setYearPickerOpen(false); }}><Text style={styles.dropdownName}>{item}</Text></TouchableOpacity>)}</View>}

          <View style={styles.previewCard}>
            <Text style={styles.previewTitle}>Automatic account details</Text>
            <Text style={styles.previewLabel}>Email</Text><Text style={styles.previewValue}>{email || "studentID@..."}</Text>
            <Text style={styles.previewLabel}>Temporary password</Text><Text style={styles.previewValue}>{temporaryPassword || "lastname12345"}</Text>
          </View>

          <TouchableOpacity style={[styles.primaryButton, loading && { opacity: 0.6 }]} onPress={handleRegister} disabled={loading}>
            {loading ? <ActivityIndicator color={theme.onPrimary} /> : <Ionicons name="person-add" size={19} color={theme.onPrimary} />}
            <Text style={styles.primaryButtonText}>{loading ? "Registering..." : "Register User"}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.secondaryButton, bulkLoading && { opacity: 0.6 }]} onPress={handleImportCsv} disabled={bulkLoading}>
            {bulkLoading ? <ActivityIndicator color={theme.textSecondary} /> : <Ionicons name="cloud-upload-outline" size={19} color={theme.textSecondary} />}
            <Text style={styles.secondaryButtonText}>{bulkLoading ? "Importing..." : "Register from Student CSV"}</Text>
          </TouchableOpacity>

          {bulkSummary && <View style={styles.summary}><Text style={styles.summaryText}>Created: {bulkSummary.created}  •  Failed: {bulkSummary.failed}</Text></View>}
        </KeyboardAwareScrollView>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmText={dialog?.confirmText ?? "Confirm"}
        cancelText={dialog?.cancelText}
        destructive={dialog?.destructive ?? true}
        variant={dialog?.variant}
        singleAction={dialog?.singleAction ?? false}
        onConfirm={() => dialog?.onConfirm()}
        onCancel={() => setDialog(null)}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { marginTop: 12, fontSize: 24, fontWeight: "800", color: c.textPrimary },
  muted: { marginTop: 7, color: c.textSecondary, textAlign: "center" },
  button: { marginTop: 20, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 12, backgroundColor: c.textSecondary },
  buttonText: { color: c.surface, fontWeight: "800" },
  header: { height: 58, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: c.borderStrong },
  headerTitle: { fontSize: 20, fontWeight: "800", color: c.textPrimary },
  content: { padding: 18, paddingBottom: 42 },
  hero: { flexDirection: "row", gap: 12, backgroundColor: c.surface, borderRadius: 18, padding: 16, marginBottom: 20 },
  heroIcon: { width: 48, height: 48, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: c.textSecondary },
  heroTitle: { fontSize: 17, fontWeight: "800", color: c.textPrimary },
  heroText: { marginTop: 4, color: c.textSecondary, lineHeight: 19 },
  fieldWrap: { marginBottom: 14 },
  label: { fontSize: 13, fontWeight: "800", color: c.textSecondary, marginBottom: 7, marginTop: 6 },
  input: { borderWidth: 1, borderColor: c.borderStrong, backgroundColor: c.surfaceRaised, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 12, color: c.textPrimary },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  choice: { borderWidth: 1, borderColor: c.borderStrong, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: c.surfaceRaised },
  choiceActive: { backgroundColor: c.textSecondary, borderColor: c.textSecondary },
  choiceText: { color: c.textSecondary, fontWeight: "700" },
  choiceTextActive: { color: c.surface },
  searchShell: { minHeight: 48, borderWidth: 1, borderColor: c.borderStrong, borderRadius: 12, backgroundColor: c.surfaceRaised, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, marginBottom: 6 },
  searchInput: { flex: 1, color: c.textPrimary, paddingHorizontal: 9, paddingVertical: 11 },
  dropdown: { borderWidth: 1, borderColor: c.borderStrong, backgroundColor: c.surfaceRaised, borderRadius: 12, overflow: "hidden", marginBottom: 14 },
  dropdownItem: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  dropdownItemSimple: { padding: 13, borderBottomWidth: 1, borderBottomColor: c.border },
  dropdownName: { fontWeight: "800", color: c.textPrimary },
  dropdownCode: { marginTop: 2, color: c.textMuted, fontSize: 12 },
  dropdownEmpty: { padding: 14, color: c.textSecondary },
  programBadge: { width: 44, height: 44, borderRadius: 12, backgroundColor: c.surfaceSunken, alignItems: "center", justifyContent: "center" },
  programBadgeText: { color: c.textSecondary, fontWeight: "900", fontSize: 11 },
  select: { minHeight: 48, borderWidth: 1, borderColor: c.borderStrong, borderRadius: 12, backgroundColor: c.surfaceRaised, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 13, marginBottom: 6 },
  selectText: { color: c.textPrimary, fontWeight: "700" },
  previewCard: { marginTop: 18, backgroundColor: c.surface, borderRadius: 16, padding: 15 },
  previewTitle: { fontWeight: "900", color: c.textPrimary, marginBottom: 10 },
  previewLabel: { color: c.textSecondary, fontSize: 12, marginTop: 6 },
  previewValue: { color: c.textPrimary, fontWeight: "800", marginTop: 2 },
  primaryButton: { marginTop: 16, minHeight: 50, borderRadius: 13, backgroundColor: c.textSecondary, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
  primaryButtonText: { color: c.surface, fontWeight: "900", fontSize: 15 },
  secondaryButton: { marginTop: 10, minHeight: 48, borderRadius: 13, borderWidth: 1, borderColor: c.borderStrong, backgroundColor: c.surfaceRaised, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
  secondaryButtonText: { color: c.textSecondary, fontWeight: "900" },
  summary: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: c.successSoft },
  summaryText: { textAlign: "center", color: c.success, fontWeight: "800" },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

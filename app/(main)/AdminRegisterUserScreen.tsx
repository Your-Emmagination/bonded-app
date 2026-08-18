import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { getIdToken } from "firebase/auth";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { auth } from "../../Firebase_configure";
import {
  getUserData,
  parseUserRole,
  type UserRole,
} from "@/utils/rbac";

const ROLES: UserRole[] = ["student", "teacher", "moderator", "admin"];
const API_URL = (process.env.EXPO_PUBLIC_BONDED_API_URL || "http://localhost:5000").replace(/\/$/, "");

type RegistrationResult = {
  success: boolean;
  studentID?: string;
  email?: string;
  temporaryPassword?: string;
  role?: string;
  message?: string;
};

function generatedEmail(studentID: string, role: UserRole) {
  const domain = role === "teacher"
    ? "@teacher.csap"
    : role === "admin"
      ? "@admin.csap"
      : "@student.csap";
  return `${studentID.trim()}${domain}`.toLowerCase();
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

function parseCsv(text: string) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) throw new Error("The CSV must contain a header and at least one user.");

  const headers = parseCsvLine(lines[0]).map((item) => item.toLowerCase());
  const required = ["studentid", "firstname", "lastname", "course", "yearlvl", "usertype"];
  const missing = required.filter((key) => !headers.includes(key));
  if (missing.length) throw new Error(`Missing CSV columns: ${missing.join(", ")}`);

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return {
      studentID: row.studentid,
      firstname: row.firstname,
      lastname: row.lastname,
      course: row.course,
      yearlvl: row.yearlvl,
      userType: row.usertype || "student",
    };
  });
}

async function readPickedFile(uri: string) {
  const response = await fetch(uri);
  if (!response.ok) throw new Error("Unable to read the selected CSV file.");
  return response.text();
}

export default function AdminRegisterUserScreen() {
  const router = useRouter();
  const [role, setRole] = useState<UserRole>("student");
  const [firstname, setFirstname] = useState("");
  const [lastname, setLastname] = useState("");
  const [studentID, setStudentID] = useState("");
  const [course, setCourse] = useState("");
  const [yearlvl, setYearlvl] = useState("1st Year");
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkSummary, setBulkSummary] = useState<{ created: number; failed: number } | null>(null);

  const email = useMemo(() => generatedEmail(studentID, role), [studentID, role]);
  const temporaryPassword = useMemo(() => `${lastname.trim()}12345`, [lastname]);
  const fullName = useMemo(() => `${firstname.trim()} ${lastname.trim()}`.trim(), [firstname, lastname]);

  useEffect(() => {
    getUserData(auth.currentUser?.uid || "").then((data) => {
      setAuthorized(parseUserRole(data?.role) === "admin");
    });
  }, []);

  const callServer = async (path: string, body: unknown) => {
    if (!auth.currentUser) throw new Error("Your session has expired. Please sign in again.");
    const token = await getIdToken(auth.currentUser, true);
    const response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || `Server returned ${response.status}.`);
    return data;
  };

  const handleRegister = async () => {
    if (!firstname.trim() || !lastname.trim() || !studentID.trim()) {
      Alert.alert("Incomplete Information", "First name, last name, and ID are required.");
      return;
    }
    if (!/^(student|teacher|moderator|admin)$/.test(role)) return;

    setLoading(true);
    try {
      const result = await callServer("/api/admin/register-user", {
        studentID: studentID.trim(),
        firstname: firstname.trim(),
        lastname: lastname.trim(),
        course: course.trim(),
        yearlvl: yearlvl.trim(),
        userType: role,
      }) as RegistrationResult;

      Alert.alert(
        "User Registered",
        `${fullName}\n\nEmail: ${result.email}\nTemporary password: ${result.temporaryPassword}\n\nThe user should change the temporary password after signing in.`,
        [{ text: "Done", onPress: () => router.back() }],
      );
    } catch (error: any) {
      Alert.alert("Registration Failed", error?.message || "Unable to register the user.");
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

      const result = await callServer("/api/admin/register-users", { users });
      const summary = { created: Number(result.created || 0), failed: Number(result.failed || 0) };
      setBulkSummary(summary);

      Alert.alert(
        "Import Complete",
        `${summary.created} account${summary.created === 1 ? "" : "s"} created.\n${summary.failed} failed or skipped.`,
      );
    } catch (error: any) {
      Alert.alert("CSV Import Failed", error?.message || "Unable to import the CSV.");
    } finally {
      setBulkLoading(false);
    }
  };

  if (authorized === null) {
    return <SafeAreaView style={styles.container}><ActivityIndicator size="large" color="#e0a53d" /></SafeAreaView>;
  }

  if (!authorized) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Ionicons name="lock-closed" size={54} color="#e0a53d" />
          <Text style={styles.title}>Access Denied</Text>
          <Text style={styles.muted}>Only administrators can register users.</Text>
          <TouchableOpacity style={styles.button} onPress={() => router.back()}>
            <Text style={styles.buttonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const field = (
    label: string,
    value: string,
    setter: (value: string) => void,
    placeholder: string,
    extra?: Record<string, unknown>,
  ) => (
    <View style={styles.group}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={setter}
        placeholder={placeholder}
        placeholderTextColor="#b88f87"
        style={styles.input}
        {...extra}
      />
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color="#7a3b2e" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Register Users</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <View style={styles.heroIcon}><Ionicons name="person-add" size={25} color="#fffaf7" /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroTitle}>Campus account registration</Text>
              <Text style={styles.heroText}>Create one account or import your existing student.csv directly from the app.</Text>
            </View>
          </View>

          <View style={styles.bulkCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.bulkTitle}>Have many users?</Text>
              <Text style={styles.bulkText}>Use the columns studentID, firstname, lastname, course, yearlvl, userType.</Text>
            </View>
            <TouchableOpacity style={styles.importButton} onPress={handleImportCsv} disabled={bulkLoading}>
              {bulkLoading ? <ActivityIndicator color="#fffaf7" /> : <><Ionicons name="document-text-outline" size={17} color="#fffaf7" /><Text style={styles.importButtonText}>Import CSV</Text></>}
            </TouchableOpacity>
          </View>

          {bulkSummary && (
            <View style={styles.summaryCard}>
              <Ionicons name="checkmark-circle" size={22} color="#2e8b57" />
              <Text style={styles.summaryText}>{bulkSummary.created} created • {bulkSummary.failed} failed</Text>
            </View>
          )}

          {field("First Name *", firstname, setFirstname, "First name")}
          {field("Last Name *", lastname, setLastname, "Last name")}
          {field("Student / Staff ID *", studentID, setStudentID, "e.g. 012324-005432", { autoCapitalize: "characters" })}
          {field("Course / Program", course, setCourse, "BS Information Systems")}
          {field("Year Level", yearlvl, setYearlvl, "1st Year")}

          <Text style={styles.label}>Account Type *</Text>
          <View style={styles.roleRow}>
            {ROLES.map((item) => (
              <TouchableOpacity key={item} style={[styles.roleChip, role === item && styles.roleChipActive]} onPress={() => setRole(item)}>
                <Ionicons name={item === "teacher"
                    ? "school-outline"
                    : item === "moderator"
                      ? "shield-outline"
                      : item === "admin"
                        ? "key-outline"
                        : "people-outline"} size={16} color={role === item ? "#fff" : "#7a3b2e"} />
                <Text style={[styles.roleText, role === item && styles.roleTextActive]}>{item.charAt(0).toUpperCase() + item.slice(1)}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {role === "admin" && (
            <View style={styles.warningCard}>
              <Ionicons name="warning-outline" size={20} color="#8a5a10" />
              <Text style={styles.warningText}>Admin accounts have full system access. Only create an admin account for an authorized campus administrator.</Text>
            </View>
          )}

          <View style={styles.previewCard}>
            <Text style={styles.previewTitle}>Account preview</Text>
            <Text style={styles.previewLabel}>Generated email</Text>
            <Text style={styles.previewValue}>{email || "Student ID + role domain"}</Text>
            <Text style={styles.previewLabel}>Temporary password</Text>
            <Text style={styles.previewValue}>{lastname.trim() ? temporaryPassword : "Lastname12345"}</Text>
            <Text style={styles.previewNote}>Passwords are not stored in Firestore. The server creates the Firebase Authentication account and applies the role claim securely.</Text>
          </View>

          <TouchableOpacity style={[styles.button, loading && { opacity: 0.6 }]} onPress={handleRegister} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <><Ionicons name="person-add-outline" size={18} color="#fff" /><Text style={styles.buttonText}>Register User</Text></>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f6f1ed" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1, borderBottomColor: "#eadbd4", backgroundColor: "#fffaf7" },
  headerTitle: { fontSize: 19, fontWeight: "800", color: "#7a3b2e" },
  content: { padding: 18, paddingBottom: 55 },
  hero: { flexDirection: "row", alignItems: "center", gap: 13, padding: 17, borderRadius: 18, backgroundColor: "#7a0020", marginBottom: 13 },
  heroIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: "#8e2443", alignItems: "center", justifyContent: "center" },
  heroTitle: { color: "#fffaf7", fontSize: 17, fontWeight: "800" },
  heroText: { color: "#f8ddd6", fontSize: 12.5, lineHeight: 18, marginTop: 3 },
  bulkCard: { flexDirection: "row", alignItems: "center", gap: 12, padding: 15, borderRadius: 16, backgroundColor: "#fffaf7", borderWidth: 1, borderColor: "#eadbd4", marginBottom: 18 },
  bulkTitle: { color: "#4d1b17", fontWeight: "800", fontSize: 14 },
  bulkText: { color: "#9b766c", fontSize: 12, lineHeight: 17, marginTop: 3 },
  importButton: { minHeight: 42, paddingHorizontal: 13, borderRadius: 12, backgroundColor: "#8a5a10", alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6 },
  importButtonText: { color: "#fffaf7", fontWeight: "800", fontSize: 12.5 },
  summaryCard: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 12, backgroundColor: "#eaf7ef", marginBottom: 15 },
  summaryText: { color: "#286b45", fontWeight: "700" },
  group: { marginBottom: 14 },
  label: { color: "#7a3b2e", fontWeight: "800", marginBottom: 7 },
  input: { backgroundColor: "#fffaf7", borderWidth: 1, borderColor: "#eadbd4", borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12, color: "#4d1b17", fontSize: 15 },
  roleRow: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: 17 },
  roleChip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, borderWidth: 1, borderColor: "#d8b7ab", backgroundColor: "#fffaf7", flexDirection: "row", alignItems: "center", gap: 6 },
  roleChipActive: { backgroundColor: "#7a0020", borderColor: "#7a0020" },
  roleText: { color: "#7a3b2e", fontWeight: "700" },
  roleTextActive: { color: "#fff" },
  warningCard: { flexDirection: "row", alignItems: "flex-start", gap: 9, padding: 13, borderRadius: 13, backgroundColor: "#fff3d6", borderWidth: 1, borderColor: "#ead7a5", marginBottom: 15 },
  warningText: { flex: 1, color: "#795514", fontSize: 12, lineHeight: 17, fontWeight: "600" },
  previewCard: { padding: 16, borderRadius: 16, backgroundColor: "#fffaf7", borderWidth: 1, borderColor: "#eadbd4", marginBottom: 18 },
  previewTitle: { color: "#4d1b17", fontSize: 16, fontWeight: "800", marginBottom: 12 },
  previewLabel: { color: "#9b766c", fontSize: 11.5, fontWeight: "700", textTransform: "uppercase", marginTop: 8 },
  previewValue: { color: "#4d1b17", fontSize: 15, fontWeight: "700", marginTop: 3 },
  previewNote: { color: "#9b766c", fontSize: 12, lineHeight: 18, marginTop: 12 },
  button: { backgroundColor: "#7a0020", borderRadius: 14, minHeight: 50, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, flexDirection: "row", gap: 8 },
  buttonText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 22, fontWeight: "800", color: "#4d1b17", marginTop: 12 },
  muted: { color: "#9b766c", textAlign: "center", marginVertical: 10 },
});

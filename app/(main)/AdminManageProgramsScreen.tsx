import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
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
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { auth, db } from "../../Firebase_configure";
import { getUserData, parseUserRole } from "@/utils/rbac";
import ConfirmDialog from "./components/ConfirmDialog";

type Program = {
  id: string;
  name: string;
  code: string;
  description?: string;
  createdAt?: unknown;
};

export default function AdminManageProgramsScreen() {
  const router = useRouter();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Program | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    getUserData(auth.currentUser?.uid || "").then((data) => {
      setAuthorized(parseUserRole(data?.role) === "admin");
    });
  }, []);

  useEffect(() => {
    if (authorized !== true) return;
    const programsQuery = query(collection(db, "programs"), orderBy("name", "asc"));
    const unsubscribe = onSnapshot(
      programsQuery,
      (snapshot) => {
        setPrograms(snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Program, "id">),
        })));
        setLoading(false);
      },
      (error) => {
        console.error("Program listener error:", error);
        setLoading(false);
        Alert.alert("Unable to load programs", "Check your connection and Firestore rules.");
      },
    );
    return unsubscribe;
  }, [authorized]);

  const filteredPrograms = useMemo(() => {
    const value = search.trim().toLowerCase();
    if (!value) return programs;
    return programs.filter((program) =>
      `${program.name} ${program.code} ${program.description || ""}`.toLowerCase().includes(value),
    );
  }, [programs, search]);

  const openCreate = () => {
    setEditingId(null);
    setName("");
    setCode("");
    setDescription("");
    setEditorVisible(true);
  };

  const openEdit = (program: Program) => {
    setEditingId(program.id);
    setName(program.name);
    setCode(program.code);
    setDescription(program.description || "");
    setEditorVisible(true);
  };

  const saveProgram = async () => {
    const cleanName = name.trim();
    const cleanCode = code.trim().toUpperCase();
    const cleanDescription = description.trim();

    if (!cleanName || !cleanCode) {
      Alert.alert("Incomplete", "Program name and program code are required.");
      return;
    }

    const duplicate = programs.find(
      (program) =>
        program.id !== editingId &&
        (program.name.trim().toLowerCase() === cleanName.toLowerCase() ||
          program.code.trim().toUpperCase() === cleanCode),
    );
    if (duplicate) {
      Alert.alert("Already exists", `A program with ${duplicate.code} / ${duplicate.name} already exists.`);
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await updateDoc(doc(db, "programs", editingId), {
          name: cleanName,
          code: cleanCode,
          description: cleanDescription,
          updatedAt: serverTimestamp(),
          updatedBy: auth.currentUser?.uid || null,
        });
      } else {
        await addDoc(collection(db, "programs"), {
          name: cleanName,
          code: cleanCode,
          description: cleanDescription,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdBy: auth.currentUser?.uid || null,
        });
      }
      setEditorVisible(false);
    } catch (error) {
      console.error("Save program error:", error);
      Alert.alert("Save failed", "Unable to save the program. Check your permissions and connection.");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(db, "programs", deleteTarget.id));
      setDeleteTarget(null);
    } catch (error) {
      console.error("Delete program error:", error);
      Alert.alert("Delete failed", "Unable to delete this program.");
    } finally {
      setDeleting(false);
    }
  };

  if (authorized === null || loading) {
    return <SafeAreaView style={styles.container}><ActivityIndicator size="large" color="#e0a53d" /></SafeAreaView>;
  }

  if (!authorized) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Ionicons name="lock-closed" size={54} color="#e0a53d" />
          <Text style={styles.title}>Access Denied</Text>
          <Text style={styles.muted}>Only administrators can manage programs.</Text>
          <TouchableOpacity style={styles.primaryButton} onPress={() => router.back()}>
            <Text style={styles.primaryButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color="#7a3b2e" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Manage Programs</Text>
          <TouchableOpacity onPress={openCreate} style={styles.headerAdd}>
            <Ionicons name="add" size={23} color="#fffaf7" />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <View style={styles.heroIcon}><Ionicons name="school-outline" size={26} color="#fffaf7" /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroTitle}>Program / Course catalog</Text>
              <Text style={styles.heroText}>Manage the programs that appear automatically in user registration.</Text>
            </View>
          </View>

          <View style={styles.searchShell}>
            <Ionicons name="search-outline" size={18} color="#9b766c" />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search program or code"
              placeholderTextColor="#b88f87"
              style={styles.searchInput}
            />
            {!!search && <TouchableOpacity onPress={() => setSearch("")}><Ionicons name="close-circle" size={18} color="#b88f87" /></TouchableOpacity>}
          </View>

          <TouchableOpacity style={styles.addButton} onPress={openCreate} activeOpacity={0.84}>
            <Ionicons name="add-circle-outline" size={19} color="#fffaf7" />
            <Text style={styles.addButtonText}>Add Program</Text>
          </TouchableOpacity>

          <Text style={styles.countText}>{filteredPrograms.length} program{filteredPrograms.length === 1 ? "" : "s"}</Text>

          {filteredPrograms.length === 0 ? (
            <View style={styles.emptyCard}>
              <Ionicons name="school-outline" size={42} color="#b88f87" />
              <Text style={styles.emptyTitle}>{programs.length ? "No programs matched" : "No programs yet"}</Text>
              <Text style={styles.muted}>Add a program so it becomes available in Register User.</Text>
            </View>
          ) : filteredPrograms.map((program) => (
            <View key={program.id} style={styles.programCard}>
              <View style={styles.programBadge}><Text style={styles.programBadgeText}>{program.code.slice(0, 5)}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.programName}>{program.name}</Text>
                <Text style={styles.programCode}>{program.code}</Text>
                {!!program.description && <Text style={styles.programDescription}>{program.description}</Text>}
              </View>
              <View style={styles.actionRow}>
                <TouchableOpacity style={styles.iconButton} onPress={() => openEdit(program)}>
                  <Ionicons name="create-outline" size={19} color="#7a3b2e" />
                </TouchableOpacity>
                <TouchableOpacity style={[styles.iconButton, styles.deleteIcon]} onPress={() => setDeleteTarget(program)}>
                  <Ionicons name="trash-outline" size={19} color="#b3261e" />
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={editorVisible} transparent animationType="slide" onRequestClose={() => !saving && setEditorVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>{editingId ? "Edit Program" : "Add Program"}</Text>
                <Text style={styles.modalSubtitle}>This appears in the registration program picker.</Text>
              </View>
              <TouchableOpacity onPress={() => !saving && setEditorVisible(false)}>
                <Ionicons name="close" size={24} color="#7a3b2e" />
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Program Name *</Text>
            <TextInput value={name} onChangeText={setName} placeholder="Bachelor of Science in Information Systems" placeholderTextColor="#b88f87" style={styles.input} />

            <Text style={styles.label}>Program Code *</Text>
            <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" placeholder="BSIS" placeholderTextColor="#b88f87" style={styles.input} />

            <Text style={styles.label}>Description (optional)</Text>
            <TextInput value={description} onChangeText={setDescription} placeholder="Short description" placeholderTextColor="#b88f87" style={[styles.input, styles.textArea]} multiline />

            <TouchableOpacity style={[styles.primaryButton, saving && { opacity: 0.6 }]} onPress={saveProgram} disabled={saving}>
              {saving ? <ActivityIndicator color="#fffaf7" /> : <><Ionicons name="save-outline" size={18} color="#fffaf7" /><Text style={styles.primaryButtonText}>{editingId ? "Save Changes" : "Add Program"}</Text></>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ConfirmDialog
        visible={!!deleteTarget}
        title="Delete program?"
        description={deleteTarget ? `${deleteTarget.code} — ${deleteTarget.name}` : undefined}
        confirmText="Delete"
        destructive
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => !deleting && setDeleteTarget(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f6f1ed" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1, borderBottomColor: "#eadbd4", backgroundColor: "#fffaf7" },
  headerTitle: { fontSize: 19, fontWeight: "800", color: "#7a3b2e" },
  headerAdd: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#7a0020", alignItems: "center", justifyContent: "center" },
  content: { padding: 18, paddingBottom: 55 },
  hero: { flexDirection: "row", alignItems: "center", gap: 13, padding: 17, borderRadius: 18, backgroundColor: "#7a0020", marginBottom: 14 },
  heroIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: "#8e2443", alignItems: "center", justifyContent: "center" },
  heroTitle: { color: "#fffaf7", fontSize: 17, fontWeight: "800" },
  heroText: { color: "#f8ddd6", fontSize: 12.5, lineHeight: 18, marginTop: 3 },
  searchShell: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#fffaf7", borderWidth: 1, borderColor: "#eadbd4", borderRadius: 13, paddingHorizontal: 13, minHeight: 46, marginBottom: 12 },
  searchInput: { flex: 1, color: "#4d1b17", fontSize: 14 },
  addButton: { backgroundColor: "#8a5a10", borderRadius: 13, minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, marginBottom: 13 },
  addButtonText: { color: "#fffaf7", fontWeight: "800", fontSize: 14 },
  countText: { color: "#9b766c", fontSize: 12, fontWeight: "700", marginBottom: 8 },
  programCard: { backgroundColor: "#fffaf7", borderWidth: 1, borderColor: "#eadbd4", borderRadius: 16, padding: 14, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 11 },
  programBadge: { width: 48, height: 48, borderRadius: 14, backgroundColor: "#f2e3d8", alignItems: "center", justifyContent: "center" },
  programBadgeText: { color: "#7a3b2e", fontWeight: "900", fontSize: 12 },
  programName: { color: "#4d1b17", fontWeight: "800", fontSize: 14.5 },
  programCode: { color: "#8a5a10", fontWeight: "800", fontSize: 12, marginTop: 3 },
  programDescription: { color: "#9b766c", fontSize: 11.5, marginTop: 4 },
  actionRow: { flexDirection: "row", gap: 7 },
  iconButton: { width: 36, height: 36, borderRadius: 11, backgroundColor: "#f5efeb", alignItems: "center", justifyContent: "center" },
  deleteIcon: { backgroundColor: "#fff0ef" },
  emptyCard: { backgroundColor: "#fffaf7", borderWidth: 1, borderColor: "#eadbd4", borderRadius: 16, padding: 28, alignItems: "center" },
  emptyTitle: { color: "#4d1b17", fontSize: 16, fontWeight: "800", marginTop: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 22, fontWeight: "800", color: "#4d1b17", marginTop: 12 },
  muted: { color: "#9b766c", textAlign: "center", marginTop: 6, lineHeight: 19 },
  primaryButton: { minHeight: 48, borderRadius: 13, backgroundColor: "#7a0020", alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, paddingHorizontal: 18, marginTop: 14 },
  primaryButtonText: { color: "#fffaf7", fontWeight: "800", fontSize: 14 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: "#fffaf7", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 28 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 15 },
  modalTitle: { color: "#4d1b17", fontSize: 20, fontWeight: "900" },
  modalSubtitle: { color: "#9b766c", fontSize: 12, marginTop: 3, maxWidth: 280 },
  label: { color: "#7a3b2e", fontWeight: "800", marginBottom: 7, marginTop: 10 },
  input: { backgroundColor: "#fffaf7", borderWidth: 1, borderColor: "#eadbd4", borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12, color: "#4d1b17", fontSize: 14.5 },
  textArea: { minHeight: 76, textAlignVertical: "top" },
});

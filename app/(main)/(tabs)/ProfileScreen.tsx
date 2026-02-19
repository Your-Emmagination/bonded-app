/* eslint-disable react-hooks/exhaustive-deps */
/*profileScreen.tsx - DARK NAVY THEME */
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { uploadProfileImage } from "../../../utils/cloudinaryUpload";
import { router } from "expo-router";
import {
    EmailAuthProvider, User as FirebaseUser,
    reauthenticateWithCredential,
    signOut, updatePassword,
} from "firebase/auth";
import { doc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";
import DropDownPicker from "react-native-dropdown-picker";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert, Animated,
    AppState,
    Image, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, TouchableWithoutFeedback, View, Platform, 
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";


// Types
type Student = {
  firstname?: string;
  lastname?: string;
  course?: string;
  yearlvl?: string;
  studentID?: string;
  email?: string;
  profileImage?: string;
  isOnline?: boolean;
};

type TabKey = "info" | "password" | "photo";

type EditData = {
  yearlvl?: string;
  email?: string;
  currentPassword?: string;
  newPassword?: string;
  selectedTab?: TabKey;
};

// Constants
const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "info", label: "Edit Info", icon: "create-outline" },
  { key: "password", label: "Change Password", icon: "lock-closed-outline" },
  { key: "photo", label: "Change Photo", icon: "camera-outline" },
];

const ProfileScreen = () => {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  const [editedData, setEditedData] = useState<EditData>({ selectedTab: "info" });
  const [profileImage, setProfileImage] = useState<string>();
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [viewImageVisible, setViewImageVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const scaleAnim = useRef(new Animated.Value(0)).current;

  const imageUri = useMemo(() => profileImage ?? student?.profileImage, [profileImage, student?.profileImage]);
  const fullName = useMemo(() => 
    `${student?.firstname ?? ""} ${student?.lastname ?? ""}`.trim() || "Anonymous",
    [student?.firstname, student?.lastname]
  );
  const studentIdDisplay = useMemo(() => 
    student?.studentID ?? user?.email?.split("@")[0] ?? "â€”",
    [student?.studentID, user?.email]
  );

  // Main auth listener with automatic online status
  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (currentUser) => {
      setUser(currentUser);

      if (currentUser) {
        const email = currentUser.email ?? "";
        const studentID = email.split("@")[0] || currentUser.uid;

        // âœ… Set user online immediately when authenticated
        try {
          await setDoc(doc(db, "students", studentID), { isOnline: true }, { merge: true });
        } catch (error) {
          console.error("Error setting online status:", error);
        }

        // Listen to profile changes
        const unsubscribeProfile = onSnapshot(
          doc(db, "students", studentID),
          (docSnapshot) => {
            if (docSnapshot.exists()) {
              const data = docSnapshot.data() as Student;
              setStudent(data);
              setProfileImage(data.profileImage);
              setEditedData({
                yearlvl: data.yearlvl,
                email: data.email || "",
                selectedTab: "info",
              });
            }
          },
          (error) => {
            // Only log if user is still authenticated
            if (auth.currentUser) {
              console.error("Error listening to profile:", error);
            }
          }
        );

        return () => {
          unsubscribeProfile();
        };
      } else {
        // User logged out - clear state
        setStudent(null);
        setProfileImage(undefined);
      }
    });

    return unsubscribe;
  }, []);

  // Handle app state changes (background/foreground)
  useEffect(() => {
    const subscription = AppState.addEventListener("change", async (nextAppState) => {
      if (!user || !auth.currentUser) return;
      
      const email = user.email ?? "";
      const studentID = email.split("@")[0] || user.uid;

      try {
        if (nextAppState === "active") {
          // App came to foreground - set online
          await setDoc(doc(db, "students", studentID), { isOnline: true }, { merge: true });
        } else if (nextAppState === "background" || nextAppState === "inactive") {
          // App went to background - set offline
          await setDoc(doc(db, "students", studentID), { isOnline: false }, { merge: true });
        }
      } catch (error) {
        console.error("Error updating online status:", error);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [user]);

  const updateStudent = useCallback(async (data: Partial<Student>) => {
    if (!student?.studentID || !auth.currentUser) return;
    
    try {
      if (
  editedData.email?.endsWith("@student.csap") ||
  editedData.email?.endsWith("@teacher.csap") ||
  editedData.email?.endsWith("@admin.csap")
) {
  delete editedData.email; // Prevent saving fake login email
}
      await updateDoc(doc(db, "students", student.studentID), data);
      setStudent(prev => prev ? { ...prev, ...data } : prev);
    } catch (error) {
      console.error("Error updating student:", error);
      throw error;
    }
  }, [student?.studentID]);

const handleImagePick = useCallback(async (useCamera = false) => {
  setLoading(true);
  try {
    const permission = useCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (permission.status !== "granted") {
      Alert.alert("Permission required", `Allow ${useCamera ? "camera" : "photo"} access.`);
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
      const uri = result.assets[0].uri;
      // âœ… Use the profile-specific upload function
      const cloudinaryUrl = await uploadProfileImage(uri);
      
      setProfileImage(cloudinaryUrl);
      await updateStudent({ profileImage: cloudinaryUrl });
      Alert.alert("Success", "Profile photo updated!");
    }
  } catch (error: any) {
    Alert.alert("Error", `Failed to update photo: ${error.message}`);
  } finally {
    setLoading(false);
  }
}, [updateStudent]);


  const toggleOnlineStatus = useCallback(async () => {
    if (!student || !auth.currentUser) return;
    const newStatus = !student.isOnline;
    
    try {
      await updateStudent({ isOnline: newStatus });
    } catch {
      Alert.alert("Error", "Failed to update status");
    }
  }, [student, updateStudent]);

  const handleSave = useCallback(async () => {
    if (!student?.studentID) {
      return Alert.alert("Error", "Missing student ID");
    }

    if (!editedData.yearlvl) {
      return Alert.alert("Validation", "Please select a Year Level.");
    }

    try {
      await updateStudent({
        yearlvl: editedData.yearlvl,
        email: editedData.email || "",
      });
      Alert.alert("Success", "Profile updated successfully");
      setEditModalVisible(false);
    } catch {
      Alert.alert("Error", "Failed to update profile");
    }
  }, [student?.studentID, editedData.yearlvl, editedData.email, updateStudent]);

  const handleChangePassword = useCallback(async () => {
    if (!user) return;
    
    const { currentPassword, newPassword } = editedData;
    if (!currentPassword || !newPassword) {
      return Alert.alert("Error", "Enter both current and new password.");
    }

    try {
      const credential = EmailAuthProvider.credential(user.email || "", currentPassword);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPassword);
      Alert.alert("Success", "Password changed successfully!");
      setEditedData(prev => ({ 
        ...prev, 
        currentPassword: "", 
        newPassword: "" 
      }));
    } catch (error: any) {
      Alert.alert("Error", error.message || "Failed to change password");
    }
  }, [user, editedData.currentPassword, editedData.newPassword]);

const confirmLogout = useCallback(() =>
  Alert.alert("Log Out", "Are you sure you want to log out?", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Log Out",
      style: "destructive",
      onPress: async () => {
        try {
          // Set offline status
          if (user) {
            const email = user.email ?? "";
            const studentID = email.split("@")[0] || user.uid;
            if (studentID) {
              try {
                await setDoc(
                  doc(db, "students", studentID),
                  { isOnline: false },
                  { merge: true }
                );
              } catch (err) {
                console.log("Could not update offline status:", err);
              }
            }
          }
          await signOut(auth);

        } catch (e: any) {
          Alert.alert("Error", e.message || "Failed to log out");
        }
      },
    },
  ]), [user]);

  const openModal = useCallback(() => {
    Animated.spring(scaleAnim, { 
      toValue: 1, 
      useNativeDriver: true 
    }).start();
  }, [scaleAnim]);

  const closeModal = useCallback(() => {
    Animated.timing(scaleAnim, { 
      toValue: 0, 
      duration: 200, 
      useNativeDriver: true 
    }).start(() => setEditModalVisible(false));
  }, [scaleAnim]);

  const openImageViewer = useCallback(() => {
    if (imageUri) {
      setViewImageVisible(true);
    } else {
      setEditedData(prev => ({ ...prev, selectedTab: "photo" }));
      setEditModalVisible(true);
    }
  }, [imageUri]);

  const handleTabChange = useCallback((key: TabKey) => {
    setEditedData(prev => ({ ...prev, selectedTab: key }));
  }, []);

  const updateEditedData = useCallback((field: keyof EditData, value: string) => {
    setEditedData(prev => ({ ...prev, [field]: value }));
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.header}>Profile</Text>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Profile Card */}
        <View style={styles.profileCard}>
          <TouchableOpacity
            onPress={openImageViewer}
            onLongPress={() => {
              handleTabChange("photo");
              setEditModalVisible(true);
            }}
            disabled={loading}
            activeOpacity={0.9}
          >
            {imageUri ? (
              <Image source={{ uri: imageUri }} style={styles.profileImage} />
            ) : (
              <View style={styles.placeholder}>
                <Ionicons name="person" size={50} color="#ff3b7f" />
              </View>
            )}
            <View style={styles.editBadge}>
              <Ionicons name="camera" size={16} color="#fff" />
            </View>
            <View style={[styles.statusBadge, { backgroundColor: student?.isOnline ? "#0f0" : "#999" }]} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.statusBtn} onPress={toggleOnlineStatus}>
            <View style={[styles.statusDot, { backgroundColor: student?.isOnline ? "#0f0" : "#999" }]} />
            <Text style={{ color: student?.isOnline ? "#0f0" : "#999" }}>
              {student?.isOnline ? "Online" : "Offline"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Personal Info Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Personal Info</Text>
          <InfoRow icon="person-outline" label="Name" value={fullName} />
<InfoRow
  icon="mail-outline"
  label="Email"
  value={
    student?.email &&
    !student.email.endsWith("@student.csap") &&
    !student.email.endsWith("@teacher.csap") &&
    !student.email.endsWith("@admin.csap")
      ? student.email
      : "No email added"
  }
/>

        </View>

        {/* Academic Info Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Academic Info</Text>
          <InfoRow icon="school-outline" label="Course" value={student?.course ?? "â€”"} />
          <InfoRow icon="trending-up-outline" label="Year Level" value={student?.yearlvl ?? "â€”"} />
          <InfoRow icon="card-outline" label="Student ID" value={studentIdDisplay} />
        </View>

        {/* Actions Section */}
        <View style={styles.section}>
          <ActionButton 
            icon="create-outline" 
            text="Edit Profile" 
            onPress={() => setEditModalVisible(true)} 
          />
          <ActionButton icon="log-out-outline" text="Log Out" onPress={confirmLogout} />
        </View>
      </ScrollView>

      {/* Edit Modal */}
      <EditModal
        visible={editModalVisible}
        scaleAnim={scaleAnim}
        onShow={openModal}
        onClose={closeModal}
        editedData={editedData}
        onTabChange={handleTabChange}
        onDataChange={updateEditedData}
        onSave={handleSave}
        onChangePassword={handleChangePassword}
        onImagePick={handleImagePick}
        loading={loading}
      />

      {/* Full Image Viewer Modal */}
      <ImageViewerModal
        visible={viewImageVisible}
        imageUri={imageUri}
        onClose={() => setViewImageVisible(false)}
      />
    </SafeAreaView>
  );
};

// Sub-components (same as before)
const InfoRow = ({ icon, label, value }: { 
  icon: keyof typeof Ionicons.glyphMap; 
  label: string; 
  value: string;
}) => (
  <View style={styles.infoCard}>
    <Ionicons name={icon} size={20} color="#ff5c93" />
    <View style={{ marginLeft: 12 }}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  </View>
);

const ActionButton = ({ icon, text, onPress }: { 
  icon: keyof typeof Ionicons.glyphMap; 
  text: string; 
  onPress: () => void;
}) => (
  <TouchableOpacity style={styles.actionButton} onPress={onPress}>
    <Ionicons name={icon} size={22} color="#ff5c93" />
    <Text style={styles.actionText}>{text}</Text>
  </TouchableOpacity>
);

const EditModal = ({ 
  visible, 
  scaleAnim, 
  onShow, 
  onClose, 
  editedData, 
  onTabChange,
  onDataChange,
  onSave,
  onChangePassword,
  onImagePick,
  loading 
}: {
  visible: boolean;
  scaleAnim: Animated.Value;
  onShow: () => void;
  onClose: () => void;
  editedData: EditData;
  onTabChange: (key: TabKey) => void;
  onDataChange: (field: keyof EditData, value: string) => void;
  onSave: () => void;
  onChangePassword: () => void;
  onImagePick: (useCamera: boolean) => void;
  loading: boolean;
}) => (
  <Modal 
    visible={visible} 
    transparent 
    animationType="fade" 
    onShow={onShow}
    onRequestClose={onClose}
  >
    <View style={styles.modalOverlay}>
      <Animated.View style={[styles.modalCard, { transform: [{ scale: scaleAnim }] }]}>
        <Text style={styles.modalHeader}>Edit Profile</Text>

        {/* Tab Navigation */}
        <View style={styles.tabRow}>
          {TABS.map(({ key, label, icon }) => (
            <TouchableOpacity
              key={key}
              onPress={() => onTabChange(key)}
              style={[
                styles.tabButton,
                editedData.selectedTab === key && styles.tabButtonActive,
              ]}
            >
              <Ionicons
                name={icon}
                size={18}
                color={editedData.selectedTab === key ? "#fff" : "#999"}
                style={{ marginBottom: 2 }}
              />
              <Text
                style={[
                  styles.tabText,
                  editedData.selectedTab === key && styles.tabTextActive,
                ]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Tab Content */}
        <View style={styles.tabContent}>
          {loading ? (
            <ActivityIndicator size="large" color="#ff5c93" style={{ marginVertical: 20 }} />
          ) : (
            <>
              {editedData.selectedTab === "info" && (
                <InfoTab 
                  editedData={editedData}
                  onDataChange={onDataChange}
                  onSave={onSave}
                />
              )}

              {editedData.selectedTab === "password" && (
                <PasswordTab
                  editedData={editedData}
                  onDataChange={onDataChange}
                  onChangePassword={onChangePassword}
                />
              )}

              {editedData.selectedTab === "photo" && (
                <PhotoTab onImagePick={onImagePick} />
              )}
            </>
          )}
        </View>

        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Text style={styles.closeText}>Close</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  </Modal>
);

const InfoTab = ({ editedData, onDataChange, onSave }: {
  editedData: EditData;
  onDataChange: (field: keyof EditData, value: string) => void;
  onSave: () => void;
}) => (
  <>
<TextInput
  style={styles.input}
  placeholder="Add your email (optional)"
  placeholderTextColor="rgba(184,199,255,0.5)"
  onChangeText={(text: string) => onDataChange("email", text)}
  keyboardType="email-address"
  autoCapitalize="none"
/>



    <Text style={styles.inputLabel}>Year Level</Text>
    <YearLevelDropdown
      value={editedData.yearlvl ?? ""}
      onChange={(val) => onDataChange("yearlvl", val)}
    />

    <TouchableOpacity style={styles.primaryBtn} onPress={onSave}>
      <Text style={styles.primaryText}>Save Changes</Text>
    </TouchableOpacity>
  </>
);

const PasswordTab = ({ editedData, onDataChange, onChangePassword }: {
  editedData: EditData;
  onDataChange: (field: keyof EditData, value: string) => void;
  onChangePassword: () => void;
}) => {
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);

  return (
    <>
      <View style={styles.passwordInputWrapper}>
        <TextInput
          style={styles.passwordInput}
          placeholder="Current Password"
          placeholderTextColor="rgba(184,199,255,0.5)"
          secureTextEntry={!showCurrentPassword}
          value={editedData.currentPassword ?? ""}
          onChangeText={(text) => onDataChange("currentPassword", text)}
        />
        <TouchableOpacity
          onPress={() => setShowCurrentPassword(!showCurrentPassword)}
          style={styles.eyeIconPassword}
        >
          <Ionicons
            name={showCurrentPassword ? "eye-off-outline" : "eye-outline"}
            size={22}
            color="#8ea0d0"
          />
        </TouchableOpacity>
      </View>
      
      <View style={styles.passwordInputWrapper}>
        <TextInput
          style={styles.passwordInput}
          placeholder="New Password"
          placeholderTextColor="rgba(184,199,255,0.5)"
          secureTextEntry={!showNewPassword}
          value={editedData.newPassword ?? ""}
          onChangeText={(text) => onDataChange("newPassword", text)}
        />
        <TouchableOpacity
          onPress={() => setShowNewPassword(!showNewPassword)}
          style={styles.eyeIconPassword}
        >
          <Ionicons
            name={showNewPassword ? "eye-off-outline" : "eye-outline"}
            size={22}
            color="#8ea0d0"
          />
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.primaryBtn} onPress={onChangePassword}>
        <Text style={styles.primaryText}>Update Password</Text>
      </TouchableOpacity>
    </>
  );
};

const PhotoTab = ({ onImagePick }: { onImagePick: (useCamera: boolean) => void }) => (
  <View style={{ marginTop: 10 }}>
    <TouchableOpacity style={styles.modalOption} onPress={() => onImagePick(false)}>
      <Ionicons name="images-outline" size={20} color="#ff5c93" />
      <Text style={styles.optionText}>Choose from Gallery</Text>
    </TouchableOpacity>
    <TouchableOpacity style={styles.modalOption} onPress={() => onImagePick(true)}>
      <Ionicons name="camera-outline" size={20} color="#ff5c93" />
      <Text style={styles.optionText}>Take Photo</Text>
    </TouchableOpacity>
  </View>
);

const ImageViewerModal = ({ visible, imageUri, onClose }: {
  visible: boolean;
  imageUri?: string;
  onClose: () => void;
}) => (
  <Modal
    visible={visible}
    transparent
    animationType="fade"
    onRequestClose={onClose}
  >
    <TouchableWithoutFeedback onPress={onClose}>
      <View style={styles.fullImageModal}>
        <View style={styles.fullImageInner}>
          {imageUri && (
            <Image
              source={{ uri: imageUri }}
              style={styles.fullImage}
              resizeMode="contain"
            />
          )}
        </View>
      </View>
    </TouchableWithoutFeedback>
  </Modal>
);

type YearLevelDropdownProps = {
  value: string;
  onChange: (val: string) => void;
};

const YearLevelDropdown: React.FC<YearLevelDropdownProps> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([
    { label: "1st Year", value: "1st Year" },
    { label: "2nd Year", value: "2nd Year" },
    { label: "3rd Year", value: "3rd Year" },
    { label: "4th Year", value: "4th Year" },
    { label: "Graduate", value: "Graduate" },
  ]);

  return (
    <View style={{ zIndex: 1000, marginBottom: 10 }}>
      <DropDownPicker
        open={open}
        value={value}
        items={items}
        setOpen={setOpen}
        setValue={(callback) => {
          const newVal = callback(value);
          onChange(newVal);
        }}
        setItems={setItems}
        placeholder="Select Year Level"
        placeholderStyle={styles.placeholderStyle}
        style={styles.dropdown}
        dropDownContainerStyle={styles.dropdownContainer}
        textStyle={styles.dropdownText}
        arrowIconStyle={styles.arrowIcon}
        tickIconStyle={styles.tickIcon}
        listItemContainerStyle={styles.listItemContainer}
        listItemLabelStyle={styles.listItemLabel}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  // Background: darker than HomeScreen's #0e1320
  container: { flex: 1, backgroundColor: "#070c15" },
  // Header accent: matches HomeScreen's #b8c7ff blue-lavender
  header: { color: "#b8c7ff", fontSize: 20, fontWeight: "bold", textAlign: "center", margin: 16, letterSpacing: 1 },
  // Dropdown: surface = #1b2235 (HomeScreen card bg), accent = #ff5c93 (HomeScreen pink)
  dropdown: {
    backgroundColor: "#1b2235",
    borderColor: "#ff5c93",
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 50,
  },
  dropdownContainer: {
    backgroundColor: "#0e1320",
    borderColor: "#ff5c93",
    borderWidth: 1,
    borderRadius: 10,
  },
  dropdownText: { color: "#e9edff", fontSize: 16 },
  placeholderStyle: { color: "rgba(184,199,255,0.5)" },
  listItemContainer: {
    borderBottomColor: "#1b2235",
    borderBottomWidth: 0.5,
  },
  listItemLabel: { color: "#e9edff" },
  arrowIcon: { tintColor: "#ff5c93" } as any,
  tickIcon: { tintColor: "#ff5c93" } as any,
  scroll: { paddingBottom: 100 },
  // Card surfaces: #1b2235 (HomeScreen surface)
  profileCard: { alignItems: "center", backgroundColor: "#1b2235", margin: 16, padding: 20, borderRadius: 16, borderWidth: 1, borderColor: "#243054" },
  profileImage: { width: 100, height: 100, borderRadius: 50, borderWidth: 3, borderColor: "#ff5c93" },
  placeholder: { width: 100, height: 100, borderRadius: 50, backgroundColor: "#243054", justifyContent: "center", alignItems: "center" },
  editBadge: { position: "absolute", bottom: 5, right: 5, backgroundColor: "#ff5c93", borderRadius: 16, padding: 5 },
  statusBadge: { position: "absolute", top: 5, right: 5, width: 14, height: 14, borderRadius: 7 },
  statusBtn: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  section: { marginHorizontal: 16, marginTop: 24 },
  sectionTitle: { color: "#8ea0d0", fontWeight: "700", marginBottom: 12, fontSize: 15 },
  infoCard: { flexDirection: "row", alignItems: "center", padding: 12, backgroundColor: "#1b2235", borderRadius: 12, marginBottom: 10, borderWidth: 1, borderColor: "#243054" },
  infoLabel: { color: "#8ea0d0", fontSize: 12 },
  infoValue: { color: "#e9edff", fontSize: 16 },
  actionButton: { flexDirection: "row", alignItems: "center", backgroundColor: "#1b2235", padding: 16, borderRadius: 12, marginBottom: 10, borderWidth: 1, borderColor: "#243054" },
  actionText: { color: "#e9edff", fontSize: 16, marginLeft: 12 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "center", alignItems: "center" },
  modalCard: {
    width: "90%",
    maxWidth: 400,
    backgroundColor: "rgba(0,0,0,0.85)",
    borderRadius: 20,
    paddingVertical: 20,
    paddingHorizontal: 16,
    elevation: 8,

    borderWidth: 1,
    borderColor: "rgba(255,92,147,0.15)",
  },
  modalHeader: { color: "#ff5c93", fontSize: 20, fontWeight: "bold", textAlign: "center", marginBottom: 18 },
  tabRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#243054",
    borderRadius: 10,
    padding: 4,
    gap: 4,
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 10,
    minWidth: 0,
  },
  tabButtonActive: { backgroundColor: "#ff5c93" },
  tabText: { color: "#8ea0d0", fontSize: 12, textAlign: "center", fontWeight: "600", flexWrap: "wrap" },
  tabTextActive: { color: "#fff" },
  tabContent: { marginVertical: 10, padding: 12 },
  input: {
    backgroundColor: "#243054",
    color: "#e9edff",
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "rgba(255,92,147,0.3)",
  },
  passwordInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#243054",
    borderRadius: 8,
    marginBottom: 10,
    paddingRight: 12,
    borderWidth: 1,
    borderColor: "rgba(255,92,147,0.3)",
  },
  passwordInput: { flex: 1, color: "#e9edff", padding: 12, fontSize: 15 },
  eyeIconPassword: { padding: 8 },
  primaryBtn: {
    backgroundColor: "#ff5c93",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 5,
    shadowColor: "#ff5c93",
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 3,
  },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  closeBtn: { backgroundColor: "#1b2235", borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 10, borderWidth: 1, borderColor: "#243054" },
  closeText: { color: "#8ea0d0", fontWeight: "600", fontSize: 15 },
  modalOption: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#243054",
    padding: 14,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(255,92,147,0.2)",
  },
  optionText: { color: "#e9edff", fontSize: 16, marginLeft: 12 },
  fullImageModal: { flex: 1, backgroundColor: "rgba(0,0,0,0.97)", justifyContent: "center", alignItems: "center" },
  fullImageInner: { width: "100%", height: "100%", justifyContent: "center", alignItems: "center" },
  fullImage: { width: "100%", height: "100%" },
  inputLabel: { color: "#8ea0d0", fontSize: 14, marginBottom: 6, marginLeft: 2, fontWeight: "600" },
  statusText: { fontSize: 14, fontWeight: "500" },
});

export default ProfileScreen;
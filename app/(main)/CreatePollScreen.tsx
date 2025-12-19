import React, { useState, useCallback, useMemo } from "react";
import { Ionicons } from "@expo/vector-icons";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Alert,
  ActivityIndicator,
  ListRenderItem,
  KeyboardAvoidingView,
  Platform,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import DropDownPicker from "react-native-dropdown-picker";
import * as ImagePicker from "expo-image-picker";
import { auth, db } from "../../Firebase_configure";
import { uploadPostImage } from "../../utils/cloudinaryUpload";
import { useRouter } from "expo-router";

type PollOption = {
  id: string;
  text: string;
};

type PollDuration = {
  days: number;
  hours: number;
  minutes: number;
};

type FormSection = {
  id: string;
  type: string;
};

const CreatePollScreen = () => {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<PollOption[]>([
    { id: "1", text: "" },
    { id: "2", text: "" },
  ]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [maxSelections, setMaxSelections] = useState(1);
  const [duration, setDuration] = useState<PollDuration>({ days: 1, hours: 0, minutes: 0 });
  const [loading, setLoading] = useState(false);
  const [maxSelectionsOpen, setMaxSelectionsOpen] = useState(false);
  const [daysOpen, setDaysOpen] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);
  const [minutesOpen, setMinutesOpen] = useState(false);
  const [allowAdding, setAllowAdding] = useState(false);
  const [pollImage, setPollImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const router = useRouter();

  // Close all dropdowns except the one being opened
  const handleDropdownOpen = (dropdown: 'maxSelections' | 'days' | 'hours' | 'minutes') => {
    setMaxSelectionsOpen(dropdown === 'maxSelections');
    setDaysOpen(dropdown === 'days');
    setHoursOpen(dropdown === 'hours');
    setMinutesOpen(dropdown === 'minutes');
  };

  const addOption = useCallback(() => {
    const newId = String(Math.max(...options.map(o => parseInt(o.id) || 0), 0) + 1);
    setOptions([...options, { id: newId, text: "" }]);
  }, [options]);

  const removeOption = useCallback((id: string) => {
    if (options.length > 2) {
      setOptions(options.filter(opt => opt.id !== id));
    } else {
      Alert.alert("Error", "You must have at least 2 options");
    }
  }, [options]);

  const updateOption = useCallback((id: string, text: string) => {
    setOptions(options.map(opt => opt.id === id ? { ...opt, text } : opt));
  }, [options]);

  const updateDuration = (field: "days" | "hours" | "minutes", value: number) => {
    setDuration(prev => ({ ...prev, [field]: value }));
  };

  const pickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const imageUri = result.assets[0].uri;
        setUploading(true);
        try {
          const url = await uploadPostImage(imageUri);
          setPollImage(url);
        } catch (error) {
          Alert.alert("Error", "Failed to upload image");
          console.error(error);
        } finally {
          setUploading(false);
        }
      }
    } catch (error) {
      Alert.alert("Error", "Failed to pick image");
      console.error(error);
    }
  };

  const removeImage = () => {
    setPollImage(null);
  };

  const validatePoll = () => {
    if (!question.trim()) {
      Alert.alert("Error", "Please enter a question");
      return false;
    }

    const filledOptions = options.filter(opt => opt.text.trim());
    if (filledOptions.length < 2) {
      Alert.alert("Error", "You must have at least 2 options");
      return false;
    }

    if (allowMultiple && maxSelections < 1) {
      Alert.alert("Error", "Maximum selections must be at least 1");
      return false;
    }

    if (allowMultiple && maxSelections > filledOptions.length) {
      Alert.alert("Error", `Maximum selections cannot exceed ${filledOptions.length}`);
      return false;
    }

    return true;
  };

  const handleCreatePoll = async () => {
    if (!validatePoll()) return;

    setLoading(true);
    try {
      const user = auth.currentUser;
      if (!user) {
        Alert.alert("Error", "You must be logged in");
        setLoading(false);
        return;
      }

      const filledOptions = options.filter(opt => opt.text.trim());
      const durationMs = (duration.days * 24 * 60 * 60 * 1000) +
                         (duration.hours * 60 * 60 * 1000) +
                         (duration.minutes * 60 * 1000);

      const pollData = {
        question: question.trim(),
        options: filledOptions.map(opt => ({
          text: opt.text.trim(),
          votes: 0,
          voters: [],
        })),
        imageUrl: pollImage || null,
        allowUsersToAddOption: allowAdding,
        userId: user.uid,
        username: user.displayName || user.email?.split("@")[0] || "Anonymous",
        isAnonymous: false,
        allowMultiple,
        maxSelections: allowMultiple ? maxSelections : 1,
        totalVotes: 0,
        durationMs,
        createdAt: serverTimestamp(),
        expiresAt: new Date(Date.now() + durationMs),
      };

      await addDoc(collection(db, "polls"), pollData);
      Alert.alert("Success", "Poll created successfully!", [
        { text: "OK", onPress: () => router.back() }
      ]);
    } catch (error) {
      console.error("Error creating poll:", error);
      Alert.alert("Error", "Failed to create poll");
    } finally {
      setLoading(false);
    }
  };

  const maxSelectionsOptions = allowMultiple 
    ? Array.from({ length: Math.min(options.filter(o => o.text.trim()).length, 5) }, (_, i) => ({
        label: String(i + 1),
        value: i + 1,
      }))
    : [];

  const formSections: FormSection[] = useMemo(() => [
    { id: "question", type: "question" },
    { id: "image", type: "image" },
    { id: "options-header", type: "optionsHeader" },
    ...options.map(opt => ({ id: opt.id, type: "option" })),
    { id: "addOption", type: "addOption" },
    { id: "settings", type: "settings" },
    { id: "duration", type: "duration" },
    { id: "spacing", type: "spacing" },
    { id: "button", type: "button" },
  ], [options]);

  const renderItem: ListRenderItem<FormSection> = ({ item }) => {
    if (item.type === "question") {
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Ask a question</Text>
          <TextInput
            style={styles.questionInput}
            placeholder="Enter your poll question"
            placeholderTextColor="#666"
            value={question}
            onChangeText={setQuestion}
            multiline
            maxLength={200}
          />
          <Text style={styles.charCount}>{question.length} / 200</Text>
        </View>
      );
    }

    if (item.type === "image") {
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Poll Image (Optional)</Text>
          {pollImage ? (
            <View style={styles.imagePreviewContainer}>
              <Image source={{ uri: pollImage }} style={styles.imagePreview} />
              <TouchableOpacity 
                style={styles.removeImageBtn}
                onPress={removeImage}
                disabled={uploading}
              >
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.uploadImageBtn}
              onPress={pickImage}
              disabled={uploading}
            >
              {uploading ? (
                <ActivityIndicator color="#ff3b7f" />
              ) : (
                <>
                  <Ionicons name="image-outline" size={24} color="#ff3b7f" />
                  <Text style={styles.uploadImageText}>Add Image to Poll</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>
      );
    }

    if (item.type === "optionsHeader") {
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Options</Text>
        </View>
      );
    }

    if (item.type === "option") {
      const option = options.find(o => o.id === item.id);
      if (!option) return null;
      const index = options.indexOf(option);

      return (
        <View style={styles.optionContainer}>
          <View style={styles.optionInputWrapper}>
            <Text style={styles.optionLabel}>Choice {index + 1}</Text>
            <View style={styles.optionRow}>
              <TextInput
                style={styles.optionInput}
                placeholder={`Option ${index + 1}`}
                placeholderTextColor="#666"
                value={option.text}
                onChangeText={(text) => updateOption(option.id, text)}
                maxLength={25}
              />
              {options.length > 2 && (
                <TouchableOpacity
                  onPress={() => removeOption(option.id)}
                  style={styles.deleteBtn}
                >
                  <Ionicons name="close" size={20} color="#ff3b7f" />
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.charCount}>{option.text.length} / 25</Text>
          </View>
        </View>
      );
    }

    if (item.type === "addOption") {
      return (
        <TouchableOpacity
          style={styles.addOptionBtn}
          onPress={addOption}
          disabled={options.length >= 10}
        >
          <Ionicons name="add" size={20} color="#ff3b7f" />
          <Text style={styles.addOptionText}>Add Option</Text>
        </TouchableOpacity>
      );
    }

    if (item.type === "settings") {
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Poll Settings</Text>

          {/* Allow multiple answers */}
          <View style={styles.settingRow}>
            <View>
              <Text style={styles.settingLabel}>Allow multiple answers</Text>
              <Text style={styles.settingSubtext}>Users can select multiple options</Text>
            </View>
            <TouchableOpacity
              style={[styles.toggle, allowMultiple && styles.toggleActive]}
              onPress={() => setAllowMultiple(!allowMultiple)}
            >
              <View
                style={[
                  styles.toggleThumb,
                  allowMultiple && styles.toggleThumbActive,
                ]}
              />
            </TouchableOpacity>
          </View>

          {/* Max selections dropdown */}
          {allowMultiple && (
            <View style={styles.maxSelectionsWrapper}>
              <Text style={styles.settingLabel}>Maximum answers per user</Text>
              <DropDownPicker
                open={maxSelectionsOpen}
                value={maxSelections}
                items={maxSelectionsOptions}
                setOpen={(open) => {
                  if (typeof open === 'function') {
                    const newOpen = open(maxSelectionsOpen);
                    if (newOpen) handleDropdownOpen('maxSelections');
                    else setMaxSelectionsOpen(false);
                  } else {
                    if (open) handleDropdownOpen('maxSelections');
                    else setMaxSelectionsOpen(false);
                  }
                }}
                setValue={setMaxSelections}
                style={styles.dropdown}
                dropDownContainerStyle={styles.dropdownContainer}
                textStyle={styles.dropdownText}
                placeholderStyle={styles.placeholderStyle}
                arrowIconStyle={styles.arrowIcon}
                tickIconStyle={styles.tickIcon}
                listItemContainerStyle={styles.listItemContainer}
                listItemLabelStyle={styles.listItemLabel}
                zIndex={3000}
                zIndexInverse={1000}
              />
            </View>
          )}

          {/* Allow users to add new options */}
          <View style={[styles.settingRow, { marginTop: 14 }]}>
            <View>
              <Text style={styles.settingLabel}>Allow users to add new options</Text>
              <Text style={styles.settingSubtext}>
                Users can submit their own choices in this poll
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.toggle, allowAdding && styles.toggleActive]}
              onPress={() => setAllowAdding(!allowAdding)}
            >
              <View
                style={[
                  styles.toggleThumb,
                  allowAdding && styles.toggleThumbActive,
                ]}
              />
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    if (item.type === "duration") {
      return (
        <View style={[styles.section, { zIndex: 1 }]}>
          <Text style={styles.sectionTitle}>Poll duration</Text>
          <View style={styles.durationRow}>
            <DurationDropdown
              label="Days"
              value={duration.days}
              onChange={(val) => updateDuration("days", val)}
              max={30}
              open={daysOpen}
              setOpen={() => handleDropdownOpen('days')}
              zIndex={100}
            />
            <DurationDropdown
              label="Hours"
              value={duration.hours}
              onChange={(val) => updateDuration("hours", val)}
              max={23}
              open={hoursOpen}
              setOpen={() => handleDropdownOpen('hours')}
              zIndex={99}
            />
            <DurationDropdown
              label="Minutes"
              value={duration.minutes}
              onChange={(val) => updateDuration("minutes", val)}
              max={59}
              open={minutesOpen}
              setOpen={() => handleDropdownOpen('minutes')}
              zIndex={98}
            />
          </View>
        </View>
      );
    }

    if (item.type === "spacing") {
      return <View style={{ height: 40 }} />;
    }

    if (item.type === "button") {
      return (
        <TouchableOpacity
          style={[styles.createBtn, loading && styles.createBtnDisabled]}
          onPress={handleCreatePoll}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.createBtnText}>Create Poll</Text>
          )}
        </TouchableOpacity>
      );
    }

    return null;
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView 
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color="#ff3b7f" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Create Poll</Text>
          <View style={{ width: 24 }} />
        </View>

        <FlatList
          data={formSections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          scrollEnabled
          nestedScrollEnabled
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

// Duration Dropdown Component
const DurationDropdown = ({ 
  label, 
  value, 
  onChange, 
  max,
  open,
  setOpen,
  zIndex = 100,
}: {
  label: string;
  value: number;
  onChange: (val: number) => void;
  max: number;
  open: boolean;
  setOpen: () => void;
  zIndex?: number;
}) => {

  const items = Array.from({ length: max + 1 }, (_, i) => ({
    label: String(i),
    value: i,
  }));

  return (
    <View style={[styles.durationField, { zIndex }]}>
      <DropDownPicker
        open={open}
        value={value}
        items={items}
        setOpen={setOpen}
        setValue={(callback) => {
            const newValue = typeof callback === "function" ? callback(value) : callback;
            onChange(newValue);
        }}
        style={styles.durationDropdown}
        dropDownContainerStyle={styles.durationDropdownContainer}
        textStyle={styles.dropdownText}
        placeholderStyle={styles.placeholderStyle}
        arrowIconStyle={styles.arrowIcon}
        tickIconStyle={styles.tickIcon}
        listItemContainerStyle={styles.listItemContainer}
        listItemLabelStyle={styles.listItemLabel}
        maxHeight={150}
        zIndex={zIndex}
        zIndexInverse={1000 - zIndex}
      />
      <Text style={styles.durationLabel}>{label}</Text>
    </View>
  );
};

export default CreatePollScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f1624",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#ff3b7f",
  },
  headerTitle: {
    color: "#ff3b7f",
    fontSize: 18,
    fontWeight: "bold",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 20,
    paddingBottom: 80,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: "#ff3b7f",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
  },
  questionInput: {
    backgroundColor: "#1c2535",
    borderWidth: 1,
    borderColor: "#2a3548",
    borderRadius: 12,
    padding: 14,
    color: "#fff",
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: "top",
  },
  charCount: {
    color: "#666",
    fontSize: 12,
    marginTop: 6,
    textAlign: "right",
  },
  imagePreviewContainer: {
    position: "relative",
    borderRadius: 12,
    overflow: "hidden",
  },
  imagePreview: {
    width: "100%",
    height: 200,
    borderRadius: 12,
    backgroundColor: "#1c2535",
  },
  removeImageBtn: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 20,
    padding: 8,
  },
  uploadImageBtn: {
    backgroundColor: "#1c2535",
    borderWidth: 2,
    borderColor: "#ff3b7f",
    borderRadius: 12,
    paddingVertical: 30,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  uploadImageText: {
    color: "#ff3b7f",
    fontSize: 14,
    fontWeight: "600",
  },
  optionContainer: {
    marginBottom: 14,
  },
  optionInputWrapper: {
    backgroundColor: "#1c2535",
    borderWidth: 1,
    borderColor: "#2a3548",
    borderRadius: 12,
    padding: 14,
  },
  optionLabel: {
    color: "#ff3b7f",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 8,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  optionInput: {
    flex: 1,
    backgroundColor: "#2a3548",
    borderRadius: 8,
    padding: 10,
    color: "#fff",
    fontSize: 14,
  },
  deleteBtn: {
    padding: 8,
  },
  addOptionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    marginBottom: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: "#ff3b7f",
    borderRadius: 10,
    marginTop: 8,
  },
  addOptionText: {
    color: "#ff3b7f",
    fontSize: 14,
    fontWeight: "600",
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1c2535",
    padding: 14,
    borderRadius: 12,
    marginBottom: 12,
  },
  settingLabel: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  settingSubtext: {
    color: "#999",
    fontSize: 12,
    marginTop: 4,
  },
  toggle: {
    width: 50,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#2a3548",
    padding: 2,
    justifyContent: "center",
  },
  toggleActive: {
    backgroundColor: "#ff3b7f",
  },
  toggleThumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#666",
    alignSelf: "flex-start",
  },
  toggleThumbActive: {
    backgroundColor: "#fff",
    alignSelf: "flex-end",
  },
  maxSelectionsWrapper: {
    marginBottom: 12,
    zIndex: 3000,
  },
  durationRow: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  durationField: {
    flex: 1,
  },
  durationLabel: {
    color: "#999",
    fontSize: 12,
    marginTop: 8,
    textAlign: "center",
  },
  dropdown: {
    backgroundColor: "#1c2535",
    borderColor: "#ff3b7f",
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 50,
  },
  durationDropdown: {
    backgroundColor: "#1c2535",
    borderColor: "#ff3b7f",
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 50,
  },
  dropdownContainer: {
    backgroundColor: "#1c2535",
    borderColor: "#ff3b7f",
    borderWidth: 1,
    borderRadius: 10,
  },
  durationDropdownContainer: {
    backgroundColor: "#1c2535",
    borderColor: "#ff3b7f",
    borderWidth: 1,
    borderRadius: 10,
    maxHeight: 200,
  },
  dropdownText: {
    color: "#fff",
    fontSize: 14,
  },
  placeholderStyle: {
    color: "rgba(255,255,255,0.6)",
  },
  arrowIcon: {
    borderColor: "#ff3b7f",
  },
  tickIcon: {
    backgroundColor: "#ff3b7f",
    borderRadius: 4,
  },
  listItemContainer: {
    borderBottomColor: "rgba(255,255,255,0.1)",
    borderBottomWidth: 0.5,
  },
  listItemLabel: {
    color: "#fff",
  },
  createBtn: {
    backgroundColor: "#ff3b7f",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 20,
  },
  createBtnDisabled: {
    opacity: 0.6,
  },
  createBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
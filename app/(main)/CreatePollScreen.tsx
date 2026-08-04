// CreatePollScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  ListRenderItem,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import DropDownPicker from "react-native-dropdown-picker";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import { uploadPostImage } from "@/utils/cloudinaryUpload";
import {
  getModerationPreviewText,
  requestModerationDecision,
} from "@/utils/contentModeration";
import { resolveUserRoleForAuthUser } from "@/utils/rbac";

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

type CreatePollRouteParams = {
  serverId?: string | string[];
  channelId?: string | string[];
  serverName?: string | string[];
  channelLabel?: string | string[];
};

const getSingleParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const CreatePollScreen = () => {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<PollOption[]>([
    { id: "1", text: "" },
    { id: "2", text: "" },
  ]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [maxSelections, setMaxSelections] = useState(1);
  const [duration, setDuration] = useState<PollDuration>({
    days: 1,
    hours: 0,
    minutes: 0,
  });
  const [loading, setLoading] = useState(false);
  const [maxSelectionsOpen, setMaxSelectionsOpen] = useState(false);
  const [daysOpen, setDaysOpen] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);
  const [minutesOpen, setMinutesOpen] = useState(false);
  const [allowAdding, setAllowAdding] = useState(false);
  const [pollImage, setPollImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const router = useRouter();
  const { serverId, channelId, serverName, channelLabel } =
    useLocalSearchParams<CreatePollRouteParams>();
  const selectedServerId = getSingleParam(serverId) || null;
  const selectedChannelId = getSingleParam(channelId) || null;
  const selectedServerName = getSingleParam(serverName) || null;
  const selectedChannelLabel = getSingleParam(channelLabel) || null;

  React.useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      router.back();
      return true;
    });

    return () => subscription.remove();
  }, [router]);

  // Unified dropdown management
  const closeAllDropdowns = useCallback(() => {
    setMaxSelectionsOpen(false);
    setDaysOpen(false);
    setHoursOpen(false);
    setMinutesOpen(false);
  }, []);

  const openDropdown = useCallback(
    (dropdown: "maxSelections" | "days" | "hours" | "minutes") => {
      closeAllDropdowns();
      if (dropdown === "maxSelections") setMaxSelectionsOpen(true);
      else if (dropdown === "days") setDaysOpen(true);
      else if (dropdown === "hours") setHoursOpen(true);
      else if (dropdown === "minutes") setMinutesOpen(true);
    },
    [closeAllDropdowns],
  );

  const addOption = useCallback(() => {
    const newId = String(
      Math.max(...options.map((o) => parseInt(o.id) || 0), 0) + 1,
    );
    setOptions([...options, { id: newId, text: "" }]);
  }, [options]);

  const removeOption = useCallback(
    (id: string) => {
      if (options.length > 2) {
        setOptions(options.filter((opt) => opt.id !== id));
      } else {
        Alert.alert("Error", "You must have at least 2 options");
      }
    },
    [options],
  );

  const updateOption = useCallback(
    (id: string, text: string) => {
      setOptions(
        options.map((opt) => (opt.id === id ? { ...opt, text } : opt)),
      );
    },
    [options],
  );

  const updateDuration = useCallback(
    (field: "days" | "hours" | "minutes", value: number) => {
      setDuration((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

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

  const validatePoll = (): boolean => {
    if (!question.trim()) {
      Alert.alert("Error", "Please enter a question");
      return false;
    }

    const filledOptions = options.filter((opt) => opt.text.trim());
    if (filledOptions.length < 2) {
      Alert.alert("Error", "You must have at least 2 options");
      return false;
    }

    if (allowMultiple && maxSelections < 1) {
      Alert.alert("Error", "Maximum selections must be at least 1");
      return false;
    }

    if (allowMultiple && maxSelections > filledOptions.length) {
      Alert.alert(
        "Error",
        `Maximum selections cannot exceed ${filledOptions.length}`,
      );
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

      const filledOptions = options.filter((opt) => opt.text.trim());
      const durationMs =
        duration.days * 24 * 60 * 60 * 1000 +
        duration.hours * 60 * 60 * 1000 +
        duration.minutes * 60 * 1000;
      const moderationDecision = await requestModerationDecision({
        text: getModerationPreviewText({
          text: `${question.trim()}\n${filledOptions.map((opt) => opt.text.trim()).join("\n")}`,
        }),
        scope: "post",
        serverId: selectedServerId,
        channelId: selectedChannelId,
        authorId: user.uid,
        authorRole: await resolveUserRoleForAuthUser(user),
      });

      const pollData = {
        question: question.trim(),
        options: filledOptions.map((opt) => ({
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
        commentCount: 0,
        serverId: selectedServerId,
        channelId: selectedChannelId,
        moderationStatus: moderationDecision.status,
        moderationReasons: moderationDecision.reasons,
        moderatedAtMs: Date.now(),
      };

      await addDoc(collection(db, "polls"), pollData);
      Alert.alert(
        moderationDecision.status === "pending" ? "Poll Pending Review" : "Success",
        moderationDecision.status === "pending"
          ? "Your poll was flagged for moderator review and will stay hidden until approved."
          : "Poll created successfully!",
        [{ text: "OK", onPress: () => router.back() }],
      );
    } catch (error) {
      console.error("Error creating poll:", error);
      Alert.alert("Error", "Failed to create poll");
    } finally {
      setLoading(false);
    }
  };

  const filledOptionsCount = options.filter((o) => o.text.trim()).length;
  const maxSelectionsOptions = useMemo(
    () =>
      allowMultiple
        ? Array.from({ length: Math.min(filledOptionsCount, 5) }, (_, i) => ({
            label: String(i + 1),
            value: i + 1,
          }))
        : [],
    [allowMultiple, filledOptionsCount],
  );

  const formSections: FormSection[] = useMemo(
    () => [
      { id: "question", type: "question" },
      { id: "image", type: "image" },
      { id: "options-header", type: "optionsHeader" },
      ...options.map((opt) => ({ id: opt.id, type: "option" })),
      { id: "addOption", type: "addOption" },
      { id: "settings", type: "settings" },
      { id: "duration", type: "duration" },
      { id: "spacing", type: "spacing" },
      { id: "button", type: "button" },
    ],
    [options],
  );

  const renderItem: ListRenderItem<FormSection> = ({ item }) => {
    switch (item.type) {
      case "question":
        return <QuestionSection question={question} setQuestion={setQuestion} />;

      case "image":
        return (
          <ImageSection
            pollImage={pollImage}
            uploading={uploading}
            onPickImage={pickImage}
            onRemoveImage={removeImage}
          />
        );

      case "optionsHeader":
        return (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Options</Text>
          </View>
        );

      case "option": {
        const option = options.find((o) => o.id === item.id);
        if (!option) return null;
        const index = options.indexOf(option);

        return (
          <OptionItem
            option={option}
            index={index}
            canDelete={options.length > 2}
            onUpdateOption={updateOption}
            onRemoveOption={removeOption}
          />
        );
      }

      case "addOption":
        return (
          <AddOptionButton
            disabled={options.length >= 10}
            onPress={addOption}
          />
        );

      case "settings":
        return (
          <SettingsSection
            allowMultiple={allowMultiple}
            setAllowMultiple={setAllowMultiple}
            maxSelections={maxSelections}
            setMaxSelections={setMaxSelections}
            maxSelectionsOptions={maxSelectionsOptions}
            maxSelectionsOpen={maxSelectionsOpen}
            setMaxSelectionsOpen={setMaxSelectionsOpen}
            onOpenDropdown={() => openDropdown("maxSelections")}
            allowAdding={allowAdding}
            setAllowAdding={setAllowAdding}
          />
        );

      case "duration":
        return (
          <DurationSection
            duration={duration}
            daysOpen={daysOpen}
            hoursOpen={hoursOpen}
            minutesOpen={minutesOpen}
            onUpdateDuration={updateDuration}
            onOpenDropdown={openDropdown}
          />
        );

      case "spacing":
        return <View style={{ height: 40 }} />;

      case "button":
        return (
          <CreateButton loading={loading} onPress={handleCreatePoll} />
        );

      default:
        return null;
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color="#e0a53d" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Create Poll</Text>
          <View style={{ width: 24 }} />
        </View>

        <View style={styles.scopeCard}>
          <Ionicons
            name={selectedServerId ? "server-outline" : "home-outline"}
            size={18}
            color="#e0a53d"
          />
          <View style={styles.scopeCopy}>
            <Text style={styles.scopeLabel}>
              {selectedServerId ? "Creating in server" : "Creating in Home"}
            </Text>
            <Text style={styles.scopeValue}>
              {selectedServerId && selectedServerName
                ? `${selectedServerName}${selectedChannelLabel ? ` • #${selectedChannelLabel}` : ""}`
                : "Campus-wide shared feed"}
            </Text>
          </View>
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
      </View>
    </SafeAreaView>
  );
};

// ==================== COMPONENTS ====================

const QuestionSection = ({
  question,
  setQuestion,
}: {
  question: string;
  setQuestion: (q: string) => void;
}) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle}>Ask a question</Text>
    <TextInput
      style={styles.questionInput}
      placeholder="Enter your poll question"
      placeholderTextColor="#9b766c"
      value={question}
      onChangeText={setQuestion}
      multiline
      maxLength={200}
    />
    <Text style={styles.charCount}>{question.length} / 200</Text>
  </View>
);

const ImageSection = ({
  pollImage,
  uploading,
  onPickImage,
  onRemoveImage,
}: {
  pollImage: string | null;
  uploading: boolean;
  onPickImage: () => void;
  onRemoveImage: () => void;
}) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle}>Poll Image (Optional)</Text>
    {pollImage ? (
      <View style={styles.imagePreviewContainer}>
        <Image source={{ uri: pollImage }} style={styles.imagePreview} />
        <TouchableOpacity
          style={styles.removeImageBtn}
          onPress={onRemoveImage}
          disabled={uploading}
        >
          <Ionicons name="close" size={24} color="#fff" />
        </TouchableOpacity>
      </View>
    ) : (
      <TouchableOpacity
        style={styles.uploadImageBtn}
        onPress={onPickImage}
        disabled={uploading}
      >
        {uploading ? (
          <ActivityIndicator color="#e0a53d" />
        ) : (
          <>
            <Ionicons name="image-outline" size={24} color="#e0a53d" />
            <Text style={styles.uploadImageText}>Add Image to Poll</Text>
          </>
        )}
      </TouchableOpacity>
    )}
  </View>
);

const OptionItem = ({
  option,
  index,
  canDelete,
  onUpdateOption,
  onRemoveOption,
}: {
  option: PollOption;
  index: number;
  canDelete: boolean;
  onUpdateOption: (id: string, text: string) => void;
  onRemoveOption: (id: string) => void;
}) => (
  <View style={styles.optionContainer}>
    <View style={styles.optionInputWrapper}>
      <Text style={styles.optionLabel}>Choice {index + 1}</Text>
      <View style={styles.optionRow}>
        <TextInput
          style={styles.optionInput}
          placeholder={`Option ${index + 1}`}
          placeholderTextColor="#9b766c"
          value={option.text}
          onChangeText={(text) => onUpdateOption(option.id, text)}
          maxLength={25}
        />
        {canDelete && (
          <TouchableOpacity
            onPress={() => onRemoveOption(option.id)}
            style={styles.deleteBtn}
          >
            <Ionicons name="close" size={20} color="#e0a53d" />
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.charCount}>{option.text.length} / 25</Text>
    </View>
  </View>
);

const AddOptionButton = ({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}) => (
  <TouchableOpacity
    style={[styles.addOptionBtn, disabled && styles.addOptionBtnDisabled]}
    onPress={onPress}
    disabled={disabled}
  >
    <Ionicons name="add" size={20} color="#e0a53d" />
    <Text style={styles.addOptionText}>Add Option</Text>
  </TouchableOpacity>
);

const SettingsSection = ({
  allowMultiple,
  setAllowMultiple,
  maxSelections,
  setMaxSelections,
  maxSelectionsOptions,
  maxSelectionsOpen,
  setMaxSelectionsOpen,
  onOpenDropdown,
  allowAdding,
  setAllowAdding,
}: {
  allowMultiple: boolean;
  setAllowMultiple: (v: boolean) => void;
  maxSelections: number;
  setMaxSelections: (v: number) => void;
  maxSelectionsOptions: { label: string; value: number }[];
  maxSelectionsOpen: boolean;
  setMaxSelectionsOpen: (v: boolean) => void;
  onOpenDropdown: () => void;
  allowAdding: boolean;
  setAllowAdding: (v: boolean) => void;
}) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle}>Poll Settings</Text>

    {/* Allow multiple answers */}
    <View style={styles.settingRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.settingLabel}>Allow multiple answers</Text>
        <Text style={styles.settingSubtext}>
          Users can select multiple options
        </Text>
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
            if (typeof open === "function") {
              const newOpen = open(maxSelectionsOpen);
              if (newOpen) onOpenDropdown();
              else setMaxSelectionsOpen(false);
            } else {
              if (open) onOpenDropdown();
              else setMaxSelectionsOpen(false);
            }
          }}
          setValue={(callback) => {
            const newValue =
              typeof callback === "function" ? callback(maxSelections) : callback;
            setMaxSelections(newValue);
          }}
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
      <View style={{ flex: 1 }}>
        <Text style={styles.settingLabel}>
          Allow users to add new options
        </Text>
        <Text style={styles.settingSubtext}>
          Users can submit their own choices in this poll
        </Text>
      </View>
      <TouchableOpacity
        style={[styles.toggle, allowAdding && styles.toggleActive]}
        onPress={() => setAllowAdding(!allowAdding)}
      >
        <View
          style={[styles.toggleThumb, allowAdding && styles.toggleThumbActive]}
        />
      </TouchableOpacity>
    </View>
  </View>
);

const DurationSection = ({
  duration,
  daysOpen,
  hoursOpen,
  minutesOpen,
  onUpdateDuration,
  onOpenDropdown,
}: {
  duration: PollDuration;
  daysOpen: boolean;
  hoursOpen: boolean;
  minutesOpen: boolean;
  onUpdateDuration: (field: "days" | "hours" | "minutes", value: number) => void;
  onOpenDropdown: (dropdown: "days" | "hours" | "minutes") => void;
}) => (
  <View style={[styles.section, { zIndex: 1 }]}>
    <Text style={styles.sectionTitle}>Poll duration</Text>
    <View style={styles.durationRow}>
      <DurationDropdown
        label="Days"
        value={duration.days}
        onChange={(val) => onUpdateDuration("days", val)}
        max={30}
        open={daysOpen}
        setOpen={() => onOpenDropdown("days")}
        zIndex={100}
      />
      <DurationDropdown
        label="Hours"
        value={duration.hours}
        onChange={(val) => onUpdateDuration("hours", val)}
        max={23}
        open={hoursOpen}
        setOpen={() => onOpenDropdown("hours")}
        zIndex={99}
      />
      <DurationDropdown
        label="Minutes"
        value={duration.minutes}
        onChange={(val) => onUpdateDuration("minutes", val)}
        max={59}
        open={minutesOpen}
        setOpen={() => onOpenDropdown("minutes")}
        zIndex={98}
      />
    </View>
  </View>
);

const CreateButton = ({
  loading,
  onPress,
}: {
  loading: boolean;
  onPress: () => void;
}) => (
  <TouchableOpacity
    style={[styles.createBtn, loading && styles.createBtnDisabled]}
    onPress={onPress}
    disabled={loading}
  >
    {loading ? (
      <ActivityIndicator color="#fff" />
    ) : (
      <Text style={styles.createBtnText}>Create Poll</Text>
    )}
  </TouchableOpacity>
);

// ==================== DURATION DROPDOWN ====================
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
  const items = useMemo(
    () =>
      Array.from({ length: max + 1 }, (_, i) => ({
        label: String(i),
        value: i,
      })),
    [max],
  );

  return (
    <View style={[styles.durationField, { zIndex }]}>
      <DropDownPicker
        open={open}
        value={value}
        items={items}
        setOpen={setOpen}
        setValue={(callback) => {
          const newValue =
            typeof callback === "function" ? callback(value) : callback;
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

// ==================== STYLES ====================
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#5f0909",
  },
  contentShell: {
    flex: 1,
    backgroundColor: "#f8ebe6",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#efd7cd",
    backgroundColor: "#fff7f3",
  },
  headerTitle: {
    color: "#4d1b17",
    fontSize: 18,
    fontWeight: "700",
  },
  scopeCard: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "#fff7f2",
    borderWidth: 1,
    borderColor: "#f0c7ba",
    gap: 10,
  },
  scopeCopy: { flex: 1 },
  scopeLabel: {
    color: "#9b766c",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  scopeValue: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "600",
    marginTop: 3,
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
    color: "#8f2117",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
  },
  questionInput: {
    backgroundColor: "#fffdfa",
    borderWidth: 1.5,
    borderColor: "#d88872",
    borderRadius: 12,
    padding: 14,
    color: "#4d1b17",
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: "top",
  },
  charCount: {
    color: "#9b766c",
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
    backgroundColor: "#f6f1ed",
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
    backgroundColor: "#fff7f2",
    borderWidth: 2,
    borderColor: "#c44a3c",
    borderRadius: 12,
    paddingVertical: 30,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  uploadImageText: {
    color: "#8f2117",
    fontSize: 14,
    fontWeight: "600",
  },
  optionContainer: {
    marginBottom: 14,
  },
  optionInputWrapper: {
    backgroundColor: "#fff7f2",
    borderWidth: 1,
    borderColor: "#f0c7ba",
    borderRadius: 12,
    padding: 14,
  },
  optionLabel: {
    color: "#8f2117",
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
    backgroundColor: "#fffdfa",
    borderRadius: 8,
    padding: 10,
    color: "#4d1b17",
    fontSize: 14,
    borderWidth: 1,
    borderColor: "#d88872",
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
    borderColor: "#c44a3c",
    borderRadius: 10,
    marginTop: 8,
    backgroundColor: "#fff7f2",
  },
  addOptionBtnDisabled: {
    opacity: 0.5,
  },
  addOptionText: {
    color: "#8f2117",
    fontSize: 14,
    fontWeight: "600",
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fff7f2",
    padding: 14,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#f0c7ba",
  },
  settingLabel: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "600",
  },
  settingSubtext: {
    color: "#9b766c",
    fontSize: 12,
    marginTop: 4,
  },
  toggle: {
    width: 50,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#f0e7e2",
    padding: 2,
    justifyContent: "center",
  },
  toggleActive: {
    backgroundColor: "#a61f1f",
  },
  toggleThumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#9b766c",
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
    color: "#9b766c",
    fontSize: 12,
    marginTop: 8,
    textAlign: "center",
  },
  dropdown: {
    backgroundColor: "#fffdfa",
    borderColor: "#d88872",
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 50,
  },
  durationDropdown: {
    backgroundColor: "#fffdfa",
    borderColor: "#d88872",
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 50,
  },
  dropdownContainer: {
    backgroundColor: "#fffdfa",
    borderColor: "#d88872",
    borderWidth: 1,
    borderRadius: 10,
  },
  durationDropdownContainer: {
    backgroundColor: "#fffdfa",
    borderColor: "#d88872",
    borderWidth: 1,
    borderRadius: 10,
    maxHeight: 200,
  },
  dropdownText: {
    color: "#4d1b17",
    fontSize: 14,
  },
  placeholderStyle: {
    color: "#9b766c",
  },
  arrowIcon: {
    borderColor: "#e0a53d",
  },
  tickIcon: {
    backgroundColor: "#8f2117",
    borderRadius: 4,
  },
  listItemContainer: {
    borderBottomColor: "rgba(255,255,255,0.1)",
    borderBottomWidth: 0.5,
  },
  listItemLabel: {
    color: "#4d1b17",
  },
  createBtn: {
    backgroundColor: "#8f2117",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 20,
    shadowColor: "#6f160f",
    shadowOpacity: 0.16,
    shadowRadius: 12,
    elevation: 3,
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

//createpostscreen.tsx
import { useThemeColors } from "@/contexts/ThemeContext";
import {
  getLostFoundStatusInfo,
  lostFoundStatusColors,
} from "@/utils/lostFoundStatus";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { isAttachmentTooLargeError, pickUploadDocuments } from "@/utils/uploadAttachments";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import {
    addDoc,
    collection,
    deleteField,
    doc,
    getDoc,
    getDocs,
    limit,
    orderBy,
    query,
    serverTimestamp,
    Timestamp,
    updateDoc,
    where,
} from "firebase/firestore";
import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated,
    BackHandler,
    FlatList,
    LayoutAnimation,
    Modal,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    UIManager,
    View,
} from "react-native";
// The keyboard library's own view. It follows the keyboard frame by frame;
// React Native's built-in one stopped lifting anything on Android once
// KeyboardProvider (app/_layout.tsx) took over the keyboard.
import {
    KeyboardAvoidingView,
    KeyboardAwareScrollView,
} from "react-native-keyboard-controller";
import {
    SafeAreaView,
    useSafeAreaInsets,
} from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import AlumniBadge from "./components/AlumniBadge";
import ConfirmDialog, { type ConfirmDialogVariant } from "./components/ConfirmDialog";

import { notifyAnnouncement } from "@/services/notificationService";
import {
    AI_ASSISTANT_NAME,
    AI_ASSISTANT_STUDENT,
    AI_MENTION_TOKEN,
    EVERYONE_MENTION_NAME,
    EVERYONE_MENTION_STUDENT,
    EVERYONE_MENTION_TAG,
    EVERYONE_MENTION_TOKEN,
    getMentionTokenForStudent,
    hasAiAssistantMention,
    hasEveryoneMention,
    isAiAssistantId,
    isEveryoneMentionId,
} from "@/utils/aiAssistant";
import { summarizeAiVisibleContent } from "@/utils/aiContext";
import {
    requestAiReplyFromWorker,
    requestServerPostModeration,
    requestVideoTranscription,
} from "@/utils/aiWorker";
import {
    uploadPostFile,
    uploadPostGif,
    uploadPostImage,
    uploadPostVideo,
} from "@/utils/cloudinaryUpload";
import SafetyDialog from "./components/SafetyDialog";
import {
    detectAnnouncementTargetDate,
    formatTargetDateLabel,
    type DetectedTargetDate,
} from "@/utils/dateDetection";
import { getFileIconDetails } from "@/utils/fileTypeHelper";
import { looksLikeHelpRequest } from "@/utils/helpRequestDetection";
import { emitHomeFeedScrollToTop } from "@/utils/homeFeedEvents";
import { looksLikeLostItemDescription } from "@/utils/lostAndFoundDetection";
import {
    canUsePostFlair,
    DEFAULT_POST_FLAIR,
    POST_FLAIRS,
    normalizePostFlair,
    STAFF_POST_FLAIR_ROLES,
    type PostFlairId,
} from "@/utils/postFlairs";
import { getTimeAgo } from "@/utils/relativeTime";
import { findMostSimilar } from "@/utils/textSimilarity";
import { buildPostSearchTerms } from "@/utils/postSearchTerms";
import { getUserDataByAuthUser } from "@/utils/rbac";
import { getMyAnonymousHandle } from "@/utils/anonymousHandle";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { manualTaggedUsers } from "@/utils/taggedUsers";

const MAX_FILES = 10;

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Gentle collapse/expand for previews, chips and inline banners as they
// appear and disappear. Purely visual — no behaviour or copy changes.
const easeLayout = () =>
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

// Shared banner for the flair suggestions (Lost & Found, Help / Advice). Both
// suggestions render this so the card / "Switch flair" / "Not now" styling
// lives in one place instead of being copy-pasted per suggestion type.
const FlairSuggestionBanner = ({
  message,
  onSwitch,
  onDismiss,
}: {
  message: string;
  onSwitch: () => void;
  onDismiss: () => void;
}) => {
  const { styles } = useStyles();

  return (
    <View style={styles.flairSuggestionBanner}>
      <Text style={styles.flairSuggestionText}>{message}</Text>
      <View style={styles.flairSuggestionActions}>
        <TouchableOpacity
          style={styles.flairSuggestionSwitchButton}
          activeOpacity={0.82}
          onPress={onSwitch}
        >
          <Text style={styles.flairSuggestionSwitchText}>Switch flair</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.flairSuggestionDismissButton}
          activeOpacity={0.82}
          onPress={onDismiss}
        >
          <Text style={styles.flairSuggestionDismissText}>Not now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

interface Student {
  id: string;
  firstname: string;
  lastname: string;
  email: string;
  studentID: string;
  /** Carried only so the mention picker can mark alumni. Never filters. */
  yearlvl?: string;
}

type RecentQuestion = {
  id: string;
  content: string;
  authorName: string;
  createdAt: any;
};

// Share of significant words that must match. Tuned against real campus
// phrasing: at 0.5, "where is the registrar office" and "what are the
// registrar office hours" both score 0.50 and warn about each other — same
// topic, different question. 0.6 keeps those quiet and still catches a
// genuine repost. See the same constant in CreatePollScreen.
const DUPLICATE_QUESTION_THRESHOLD = 0.6;
const DUPLICATE_QUESTION_WINDOW_DAYS = 30;

type MentionDraft = Student & {
  mentionToken: string;
  label: string;
};

type CreatePostRouteParams = {
  serverId?: string | string[];
  channelId?: string | string[];
  serverName?: string | string[];
  channelLabel?: string | string[];
  editPostId?: string | string[];
};

const getSingleParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

// Returns a function that keeps the same identity for the whole screen but
// always runs the latest `callback`, so a memoized section can take a handler
// that reads current state without redrawing on every key press.
function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

// The sections below don't depend on the post text. Each one is memoized so
// typing only redraws the text box and what reacts to it (mentions, flair and
// date suggestions, the Post button) instead of the whole screen.

const AnonymousToggle = memo(function AnonymousToggle({
  isAnonymous,
  progress,
  onToggle,
}: {
  isAnonymous: boolean;
  progress: Animated.Value;
  onToggle: () => void;
}) {
  const { styles, theme } = useStyles();
  // Built once instead of on every render, so the toggle's animation isn't
  // re-attached each time the screen redraws.
  const trackColor = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: [theme.border, theme.accent],
      }),
    [progress, theme.border, theme.accent],
  );
  const thumbTranslateX = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 20],
      }),
    [progress],
  );

  return (
    <>
      <View style={styles.anonymousContainer}>
        <Text style={styles.anonymousLabel}>Post Anonymously</Text>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={onToggle}
          accessibilityRole="switch"
          accessibilityState={{ checked: isAnonymous }}
        >
          <Animated.View style={[styles.toggle, { backgroundColor: trackColor }]}>
            <Animated.View
              style={[
                styles.toggleThumb,
                { transform: [{ translateX: thumbTranslateX }] },
              ]}
            />
          </Animated.View>
        </TouchableOpacity>
      </View>

      {isAnonymous && (
        <Text style={styles.anonymousNote}>
          Note: Admins and moderators can still see your identity. Only
          students will see this as anonymous.
        </Text>
      )}
    </>
  );
});

const FlairPicker = memo(function FlairPicker({
  pickerRef,
  selectedFlair,
  authorRole,
  onSelect,
  onPickerLayout,
  onPickerScroll,
  onChipLayout,
}: {
  pickerRef: RefObject<ScrollView | null>;
  selectedFlair: PostFlairId;
  authorRole: string;
  onSelect: (flairId: PostFlairId) => void;
  onPickerLayout: (width: number) => void;
  onPickerScroll: (x: number) => void;
  onChipLayout: (flairId: string, x: number, width: number) => void;
}) {
  const { styles, theme } = useStyles();
  const flairs = useMemo(
    () => POST_FLAIRS.filter((flair) => !flair.staffOnly || canUsePostFlair(flair.id, authorRole)),
    [authorRole],
  );

  return (
    <ScrollView
      ref={pickerRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.flairPickerContent}
      scrollEventThrottle={16}
      onLayout={(event) => onPickerLayout(event.nativeEvent.layout.width)}
      onScroll={(event) => onPickerScroll(event.nativeEvent.contentOffset.x)}
    >
      {flairs.map((flair) => {
        const selected = selectedFlair === flair.id;
        return (
          <TouchableOpacity
            key={flair.id}
            style={[styles.flairChoice, selected && styles.flairChoiceSelected]}
            activeOpacity={0.82}
            onLayout={(event) => {
              const { x, width } = event.nativeEvent.layout;
              onChipLayout(flair.id, x, width);
            }}
            onPress={() => onSelect(flair.id)}
          >
            <Text style={styles.flairChoiceEmoji}>{flair.emoji}</Text>
            <Text style={[styles.flairChoiceText, selected && styles.flairChoiceTextSelected]}>{flair.label}</Text>
            {selected && (
              <Ionicons
                name="checkmark-circle"
                size={14}
                color={theme.onPrimary}
                style={styles.flairChoiceCheck}
              />
            )}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
});

const PinSection = memo(function PinSection({
  selectedFlair,
  shouldPin,
  targetDate,
  onTogglePin,
  onOpenDatePicker,
  onOpenTimePicker,
  onPinIndefinitely,
}: {
  selectedFlair: PostFlairId;
  shouldPin: boolean;
  targetDate: Date | null;
  onTogglePin: () => void;
  onOpenDatePicker: () => void;
  onOpenTimePicker: () => void;
  onPinIndefinitely: () => void;
}) {
  const { styles, theme } = useStyles();
  return (
    <View style={styles.pinSection}>
      <View style={styles.pinRow}>
        <View style={styles.pinLabelContainer}>
          <Ionicons name="pin" size={18} color={theme.primary} style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.pinTitle}>Pin to Top of Feed</Text>
            <Text style={styles.pinSubtitle}>
              {selectedFlair === "announcement"
                ? "Feature in active announcements carousel at top of feed"
                : "Keep at the top of the campus feed"}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={onTogglePin}
          accessibilityRole="switch"
          accessibilityState={{ checked: shouldPin }}
        >
          <View style={[styles.miniToggle, shouldPin && styles.miniToggleActive]}>
            <View style={[styles.miniToggleThumb, shouldPin && styles.miniToggleThumbActive]} />
          </View>
        </TouchableOpacity>
      </View>

      {shouldPin && (
        <View style={styles.pinDetailsCard}>
          <Text style={styles.pinDetailsInfo}>
            📅 Auto-unpin & expiration schedule:
          </Text>
          <View style={styles.pinDateControls}>
            <TouchableOpacity
              style={styles.pinDateButton}
              onPress={onOpenDatePicker}
              activeOpacity={0.7}
            >
              <Ionicons name="calendar-outline" size={16} color={theme.primary} />
              <Text style={styles.pinDateButtonText}>
                {targetDate
                  ? targetDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                  : "Pick Date"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.pinDateButton}
              onPress={onOpenTimePicker}
              activeOpacity={0.7}
            >
              <Ionicons name="time-outline" size={16} color={theme.primary} />
              <Text style={styles.pinDateButtonText}>
                {targetDate
                  ? targetDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
                  : "Pick Time"}
              </Text>
            </TouchableOpacity>
          </View>

          {targetDate ? (
            <View style={styles.pinExpiryRow}>
              <Text style={styles.pinExpiryBadge}>
                ⏳ Ends: {formatTargetDateLabel(targetDate)}
              </Text>
              <TouchableOpacity
                onPress={onPinIndefinitely}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.pinRemoveDateText}>Pin indefinitely</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={styles.pinIndefiniteNote}>
              Pinned indefinitely until manually unpinned.
            </Text>
          )}
        </View>
      )}
    </View>
  );
});

const AttachmentPreviews = memo(function AttachmentPreviews({
  selectedGif,
  attachedLink,
  existingFiles,
  files,
  onRemoveGif,
  onRemoveLink,
  onRemoveExistingFile,
  onRemoveFile,
}: {
  selectedGif: string | null;
  attachedLink: { url: string; title: string } | null;
  existingFiles: { url: string; mimeType: string; name?: string }[];
  files: { uri: string; mimeType: string; name: string }[];
  onRemoveGif: () => void;
  onRemoveLink: () => void;
  onRemoveExistingFile: (index: number) => void;
  onRemoveFile: (index: number) => void;
}) {
  const { styles, theme } = useStyles();
  return (
    <>
      {selectedGif && (
        <View style={styles.gifPreview}>
          <Image source={{ uri: selectedGif }} style={styles.gifImage} />
          <TouchableOpacity
            activeOpacity={0.7}
            style={styles.removeFile}
            onPress={onRemoveGif}
          >
            <Ionicons name="close-circle" size={22} color={theme.accent} />
          </TouchableOpacity>
        </View>
      )}

      {attachedLink && (
        <View style={styles.linkPreview}>
          <Ionicons name="link" size={20} color="#4f9cff" />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.linkTitle} numberOfLines={1}>
              {attachedLink.title}
            </Text>
            <Text style={styles.linkUrl} numberOfLines={1}>
              {attachedLink.url}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.linkRemoveButton}
            onPress={onRemoveLink}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Remove link"
          >
            <Ionicons name="close-circle" size={22} color={theme.accent} />
          </TouchableOpacity>
        </View>
      )}

      {existingFiles.length > 0 && (
        <View style={styles.filePreviewContainer}>
          {existingFiles.map((f, i) => (
            <View key={`existing-${i}`} style={styles.filePreview}>
              {f.mimeType?.startsWith("image/") ? (
                <Image source={{ uri: f.url }} style={styles.imagePreview} />
              ) : (
                <View style={styles.documentPreview}>
                  <Ionicons
                    name={f.mimeType?.startsWith("video/") ? "videocam" : getFileIconDetails(f.mimeType, f.name).icon}
                    size={40}
                    color={f.mimeType?.startsWith("video/") ? "#4f9cff" : getFileIconDetails(f.mimeType, f.name).color}
                  />
                  <Text style={styles.documentName} numberOfLines={1}>{f.name || "Attached file"}</Text>
                </View>
              )}
              <TouchableOpacity activeOpacity={0.7} style={styles.removeFile} onPress={() => onRemoveExistingFile(i)}>
                <Ionicons name="close-circle" size={22} color={theme.accent} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {files.length > 0 && (
        <View style={styles.filePreviewContainer}>
          {files.map((f, i) => (
            <View key={i} style={styles.filePreview}>
              {f.mimeType.startsWith("image/") ? (
                <Image
                  source={{ uri: f.uri }}
                  style={styles.imagePreview}
                />
              ) : f.mimeType.startsWith("video/") ? (
                <View style={styles.videoPreview}>
                  <Ionicons name="videocam" size={40} color="#4f9cff" />
                  <Text style={styles.documentName} numberOfLines={1}>
                    {f.name}
                  </Text>
                </View>
              ) : (
                <View style={styles.documentPreview}>
                  <Ionicons
                    name={getFileIconDetails(f.mimeType, f.name).icon}
                    size={40}
                    color={getFileIconDetails(f.mimeType, f.name).color}
                  />
                  <Text style={styles.documentName} numberOfLines={1}>
                    {f.name}
                  </Text>
                </View>
              )}
              <TouchableOpacity
                activeOpacity={0.7}
                style={styles.removeFile}
                onPress={() => onRemoveFile(i)}
              >
                <Ionicons name="close-circle" size={22} color={theme.accent} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
    </>
  );
});

const AddToPostToolbar = memo(function AddToPostToolbar({
  filesCount,
  onTakePhoto,
  onPickPhotos,
  onPickDocuments,
  onPickVideos,
  onOpenTags,
  onOpenLink,
  onOpenGif,
  taggedCount,
}: {
  filesCount: number;
  onTakePhoto: () => void;
  onPickPhotos: () => void;
  onPickDocuments: () => void;
  onPickVideos: () => void;
  onOpenTags: () => void;
  onOpenLink: () => void;
  onOpenGif: () => void;
  taggedCount: number;
}) {
  const { styles, theme } = useStyles();
  const filesFull = filesCount >= MAX_FILES;
  return (
    <View style={styles.addToPostContainer}>
      <Text style={styles.addToPostLabel}>Add to your post</Text>
      <View style={styles.iconRow}>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.iconButton, filesFull && styles.iconButtonDisabled]}
          onPress={onTakePhoto}
          disabled={filesFull}
          accessibilityLabel="Take a photo"
        >
          <Ionicons name="camera" size={24} color={filesFull ? theme.textMuted : theme.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.iconButton, filesFull && styles.iconButtonDisabled]}
          onPress={onPickPhotos}
          disabled={filesFull}
          accessibilityLabel="Choose photos"
        >
          <Ionicons name="images" size={24} color={filesFull ? theme.textMuted : "#4f9cff"} />
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.iconButton, filesFull && styles.iconButtonDisabled]}
          onPress={onPickDocuments}
          disabled={filesFull}
          accessibilityLabel="Attach files"
        >
          <Ionicons name="attach" size={24} color={filesFull ? theme.textMuted : theme.accent} />
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.iconButton, filesFull && styles.iconButtonDisabled]}
          onPress={onPickVideos}
          disabled={filesFull}
        >
          <Ionicons name="videocam" size={24} color={filesFull ? theme.textMuted : theme.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          style={styles.iconButton}
          onPress={onOpenTags}
          accessibilityRole="button"
          accessibilityLabel="Tag people"
        >
          <Ionicons name="people-outline" size={23} color={theme.primary} />
          {taggedCount > 0 && (
            <View style={styles.tagBadge}>
              <Text style={styles.tagBadgeText}>{taggedCount}</Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} style={styles.iconButton} onPress={onOpenLink}>
          <Ionicons name="link" size={24} color="#4f9cff" />
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} style={styles.iconButton} onPress={onOpenGif}>
          <Ionicons name="gift" size={24} color="#ff9f43" />
        </TouchableOpacity>
      </View>
    </View>
  );
});

const CreatePostScreen = () => {
  const { styles, theme } = useStyles();
  const [content, setContent] = useState("");
  const [selectedFlair, setSelectedFlair] = useState<PostFlairId>(DEFAULT_POST_FLAIR);
  // Which side of a Lost & Found post this is. Only asked when writing a new
  // one; afterwards the status moves from the post itself.
  const [lostFoundKind, setLostFoundKind] = useState<"lost" | "found">("lost");
  // Live, so an admin demoting this account takes "Pin to Top of Feed" and
  // the staff flairs away even from a form that is already open.
  const liveRole = useCurrentUserRole();
  const authorRole = String(liveRole || "student").toLowerCase();
  const [authorProfileName, setAuthorProfileName] = useState("");
  const [files, setFiles] = useState<
    { uri: string; mimeType: string; name: string; size?: number }[]
  >([]);
  const [existingFiles, setExistingFiles] = useState<
    { url: string; mimeType: string; name?: string; size?: number }[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const [blockedDialog, setBlockedDialog] = useState<{
    title: string;
    description: string;
    variant: ConfirmDialogVariant;
    onConfirm?: () => void;
  } | null>(null);
  // Small helper so the many single-button "OK" info messages throughout this
  // screen render as the app's branded ConfirmDialog instead of the bare OS
  // alert. The self-harm safety notice doesn't go through this either — it
  // has a dialog of its own, see components/SafetyDialog.
  const getDialogVariant = (title: string): ConfirmDialogVariant => {
    const normalizedTitle = title.trim().toLowerCase();
    if (normalizedTitle.includes("success")) return "success";
    if (
      normalizedTitle.includes("info") ||
      normalizedTitle.includes("review") ||
      normalizedTitle.includes("pending") ||
      normalizedTitle.includes("sent")
    ) {
      return "info";
    }
    if (
      normalizedTitle.includes("error") ||
      normalizedTitle.includes("failed") ||
      normalizedTitle.includes("blocked")
    ) {
      return "destructive";
    }
    return "warning";
  };

  // Self-harm gets its own dialog instead of the generic one — see
  // components/SafetyDialog. Closing it leaves the screen, the way the old
  // alert's OK button did.
  const [safetyVisible, setSafetyVisible] = useState(false);

  const showInfo = (title: string, description: string, onConfirm?: () => void) => {
    setBlockedDialog({ title, description, variant: getDialogVariant(title), onConfirm });
  };
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [taggedUsers, setTaggedUsers] = useState<Student[]>([]);
  const [mentionedUsers, setMentionedUsers] = useState<Student[]>([]);
  const [draftTaggedUsers, setDraftTaggedUsers] = useState<Student[]>([]);
  const [showTagModal, setShowTagModal] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [contentSelection, setContentSelection] = useState({ start: 0, end: 0 });
  // Suggests switching to the Lost & Found flair when the post text reads
  // like someone describing their own lost item (same detection pattern the
  // @ai chat nudge uses). Purely a suggestion — never changes the flair on
  // its own, and dismissing it for this draft stops it from reappearing
  // even if the text keeps matching.
  const [lostFoundSuggestionDismissed, setLostFoundSuggestionDismissed] = useState(false);
  // Mirror of lostFoundSuggestionDismissed for the Help / Advice flair
  // suggestion. Both re-arm together when the compose box is fully cleared.
  const [helpSuggestionDismissed, setHelpSuggestionDismissed] = useState(false);
  // Recent questions, read once, used only to warn that something has already
  // been asked. Never blocks posting and never filters the feed.
  const [recentQuestions, setRecentQuestions] = useState<RecentQuestion[]>([]);
  const [duplicateQuestionDismissed, setDuplicateQuestionDismissed] =
    useState(false);

  // Target date detection and pin-until-date expiration for staff announcements
  const isStaff = STAFF_POST_FLAIR_ROLES.has(String(authorRole || "").toLowerCase());
  const [shouldPin, setShouldPin] = useState(false);
  const [targetDate, setTargetDate] = useState<Date | null>(null);
  const [targetDateLabel, setTargetDateLabel] = useState<string | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [dismissedDetectedDate, setDismissedDetectedDate] = useState(false);

  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [attachedLink, setAttachedLink] = useState<{
    url: string;
    title: string;
  } | null>(null);
  const contentScrollRef = useRef<any>(null);
  const contentInputRef = useRef<TextInput>(null);
  // Horizontal flair picker: its ref plus enough layout bookkeeping to scroll
  // a specific chip into view (used by the suggestion banners' "Switch flair").
  const flairPickerRef = useRef<ScrollView>(null);
  const flairChipLayoutsRef = useRef<Record<string, { x: number; width: number }>>({});
  const flairPickerScrollXRef = useRef(0);
  const flairPickerWidthRef = useRef(0);
  const [isContentFocused, setIsContentFocused] = useState(false);
  const anonymousProgress = useRef(new Animated.Value(0)).current;
  const postButtonScale = useRef(new Animated.Value(1)).current;

  const [showGifModal, setShowGifModal] = useState(false);
  const [gifSearchQuery, setGifSearchQuery] = useState("");
  const [gifResults, setGifResults] = useState<any[]>([]);
  const [selectedGif, setSelectedGif] = useState<string | null>(null);
  const [loadingGifs, setLoadingGifs] = useState(false);
  const [gifError, setGifError] = useState<string | null>(null);

  const insets = useSafeAreaInsets();
  const { serverId, channelId, serverName, channelLabel, editPostId } =
    useLocalSearchParams<CreatePostRouteParams>();
  const selectedEditPostId = getSingleParam(editPostId) || null;
  const isEditMode = !!selectedEditPostId;
  const selectedServerId = getSingleParam(serverId) || null;
  const selectedChannelId = getSingleParam(channelId) || null;
  const selectedServerName = getSingleParam(serverName) || null;
  const selectedChannelLabel = getSingleParam(channelLabel) || null;

  useEffect(() => {
    fetchStudents();
  }, []);

  useEffect(() => {
    let active = true;
    const loadAuthorRole = async () => {
      const profile = await getUserDataByAuthUser(auth.currentUser);
      if (active) {
        setAuthorProfileName(
          `${profile?.firstname || ""} ${profile?.lastname || ""}`.trim(),
        );
      }
    };
    loadAuthorRole();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedEditPostId || !auth.currentUser) return;
    const loadPostForEdit = async () => {
      try {
        const snap = await getDoc(doc(db, "posts", selectedEditPostId));
        if (!snap.exists()) {
          showInfo("Post Not Found", "This post no longer exists.", () => router.back());
          return;
        }
        const data: any = snap.data();
        const ownerId = data.realUserId || data.userId;
        if (ownerId !== auth.currentUser?.uid) {
          showInfo("Access Denied", "You can only edit your own posts.", () => router.back());
          return;
        }
        setContent(data.content || "");
        // A retired flair (Academic, Study, Sports) opens as Discussion.
        setSelectedFlair(normalizePostFlair(data.flair));
        setIsAnonymous(!!data.isAnonymous);
        setAttachedLink(data.link || null);
        setExistingFiles(Array.isArray(data.files) ? data.files : []);
        const loadedTaggedUsers: Student[] = Array.isArray(data.taggedUsers) ? data.taggedUsers.map((tag: any) => ({
          id: tag.id,
          firstname: tag.name || "User",
          lastname: "",
          email: "",
          studentID: tag.studentID || "",
        })) : [];
        const loadedMentionIds = Array.isArray(data.mentionedUserIds)
          ? data.mentionedUserIds.filter((id: unknown): id is string => typeof id === "string")
          : [];
        const loadedManualIds = new Set(
          manualTaggedUsers(
            data.content || "",
            loadedTaggedUsers.map((tag) => ({
              id: tag.id,
              name: tag.firstname,
              studentID: tag.studentID,
            })),
            loadedMentionIds,
          ).map((tag) => tag.id),
        );
        setTaggedUsers(loadedTaggedUsers.filter((tag) => loadedManualIds.has(tag.id)));
        setMentionedUsers(loadedTaggedUsers.filter((tag) => !loadedManualIds.has(tag.id)));
        if (data.pinnedAt) {
          setShouldPin(true);
          const rawDate = data.pinExpiresAt || data.targetDate;
          if (rawDate) {
            const parsed = rawDate?.toDate
              ? rawDate.toDate()
              : rawDate?.seconds
                ? new Date(rawDate.seconds * 1000)
                : new Date(rawDate);
            if (!isNaN(parsed.getTime())) {
              setTargetDate(parsed);
            }
          }
          if (data.targetDateLabel) {
            setTargetDateLabel(data.targetDateLabel);
          }
        }
      } catch (error) {
        console.error("Error loading post for edit:", error);
        showInfo("Error", "Failed to load the post.", () => router.back());
      }
    };
    loadPostForEdit();
  }, [selectedEditPostId]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      router.back();
      return true;
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    setGifError(null);
    if (!gifSearchQuery.trim()) {
      setGifResults([]);
    }
  }, [gifSearchQuery]);

  useEffect(() => {
    Animated.timing(anonymousProgress, {
      toValue: isAnonymous ? 1 : 0,
      duration: 180,
      useNativeDriver: false,
    }).start();
  }, [isAnonymous, anonymousProgress]);

  const fetchStudents = async () => {
    try {
      const studentsSnapshot = await getDocs(collection(db, "students"));
      const currentUserId = auth.currentUser?.uid;
      const currentUserEmail = auth.currentUser?.email;
      const currentStudentID = currentUserEmail?.split("@")[0];

      const studentsList = studentsSnapshot.docs
        .map((doc): Student | null => {
          const data = doc.data();
          if (!data.firstname || !data.lastname || !data.studentID) {
            console.warn(`Student ${doc.id} missing required fields`);
            return null;
          }
          return {
            id: doc.id,
            firstname: String(data.firstname || "").trim(),
            lastname: String(data.lastname || "").trim(),
            email: String(data.email || ""),
            studentID: String(data.studentID || ""),
            yearlvl: String(data.yearlvl || ""),
          };
        })
        .filter((student): student is Student => {
          if (student === null) return false;

          if (student.id === currentUserId) return false;
          if (student.id === currentStudentID) return false;
          if (student.studentID === currentStudentID) return false;

          return true;
        });

      setStudents(studentsList);
    } catch (error) {
      console.error("Error fetching students:", error);
      showInfo("Error", "Failed to load students list");
    }
  };

  const takePhoto = async () => {
    try {
      if (files.length >= MAX_FILES) {
        showInfo(
          "Maximum Files Reached",
          `You can only attach up to ${MAX_FILES} files per post.`,
        );
        return;
      }

      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        showInfo(
          "Camera Permission Required",
          "Please allow BondEd to use your camera so you can take a photo for your post.",
        );
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.85,
        allowsEditing: false,
      });

      if (result.canceled || !result.assets?.length) return;

      const photo = result.assets[0];
      easeLayout();
      setFiles((current) => [
        ...current,
        {
          uri: photo.uri,
          mimeType: photo.mimeType || "image/jpeg",
          name: photo.fileName || `camera_${Date.now()}.jpg`,
        },
      ]);
    } catch (error) {
      console.error("Error taking photo:", error);
      showInfo("Camera Error", "Failed to take a photo. Please try again.");
    }
  };

  const pickPhotos = async () => {
    try {
      if (files.length >= MAX_FILES) {
        showInfo(
          "Maximum Files Reached",
          `You can only attach up to ${MAX_FILES} files per post.`,
        );
        return;
      }

      const result = await pickUploadDocuments({
        type: "image/*",
        multiple: true,
      });

      if (!result.canceled && result.assets?.length > 0) {
        const remainingSlots = MAX_FILES - files.length;
        const filesToAdd = result.assets.slice(0, remainingSlots);

        if (result.assets.length > remainingSlots) {
          showInfo(
            "File Limit",
            `Only ${remainingSlots} more file(s) can be added. Maximum is ${MAX_FILES} files per post.`,
          );
        }

        const newFiles = filesToAdd.map((picked) => ({
          uri: picked.uri || "",
          mimeType: picked.mimeType ?? "image/jpeg",
          name: picked.name ?? `photo_${Date.now()}.jpg`,
          size: picked.size,
        }));

        easeLayout();
        setFiles([...files, ...newFiles]);
      }
    } catch (error) {
      console.error("Error picking photos:", error);
      showInfo("Error", "Failed to pick photos");
    }
  };

  const pickDocuments = async () => {
    try {
      if (files.length >= MAX_FILES) {
        showInfo(
          "Maximum Files Reached",
          `You can only attach up to ${MAX_FILES} files per post.`,
        );
        return;
      }

      const result = await pickUploadDocuments({
        type: "*/*",
        multiple: true,
      });

      if (!result.canceled && result.assets?.length > 0) {
        const remainingSlots = MAX_FILES - files.length;
        const filesToAdd = result.assets.slice(0, remainingSlots);

        if (result.assets.length > remainingSlots) {
          showInfo(
            "File Limit",
            `Only ${remainingSlots} more file(s) can be added. Maximum is ${MAX_FILES} files per post.`,
          );
        }

        const newFiles = filesToAdd.map((picked) => ({
          uri: picked.uri || "",
          mimeType: picked.mimeType ?? "application/octet-stream",
          name: picked.name ?? `file_${Date.now()}`,
          size: picked.size,
        }));

        easeLayout();
        setFiles([...files, ...newFiles]);
      }
    } catch (error) {
      console.error("Error picking documents:", error);
      showInfo(
        isAttachmentTooLargeError(error) ? "File too large" : "Error",
        error instanceof Error ? error.message : "Failed to pick documents",
      );
    }
  };

  const pickFiles = pickDocuments;

  const pickVideos = async () => {
    try {
      if (files.length >= MAX_FILES) {
        showInfo(
          "Maximum Files Reached",
          `You can only attach up to ${MAX_FILES} files per post.`,
        );
        return;
      }

      const result = await pickUploadDocuments({
        type: "video/*",
        multiple: true,
      });

      if (!result.canceled && result.assets?.length > 0) {
        const remainingSlots = MAX_FILES - files.length;
        const filesToAdd = result.assets.slice(0, remainingSlots);

        if (result.assets.length > remainingSlots) {
          showInfo(
            "File Limit",
            `Only ${remainingSlots} more video(s) can be added. Maximum is ${MAX_FILES} files per post.`,
          );
        }

        const newVideos = filesToAdd.map((picked) => ({
          uri: picked.uri || "",
          mimeType: picked.mimeType?.startsWith("video/")
            ? picked.mimeType
            : "video/mp4",
          name: picked.name ?? `video_${Date.now()}.mp4`,
        }));

        easeLayout();
        setFiles((current) => [...current, ...newVideos]);
      }
    } catch (error) {
      console.error("Error picking videos:", error);
      showInfo("Error", "Failed to pick video(s)");
    }
  };

  const handlePost = async () => {
    if (!auth.currentUser) {
      showInfo("Login required", "You must be signed in to create a post.");
      return;
    }

    if (
      !content.trim() &&
      files.length === 0 &&
      existingFiles.length === 0 &&
      !selectedGif &&
      !attachedLink
    ) {
      showInfo("Empty Post", "Please add content, a file, GIF, or link.");
      return;
    }
setUploading(true);

try {
  // Media (images/video) is moderated server-side by the trusted Worker on
  // the same pass as text — a post with attachments is saved pending, the
  // Worker checks every attachment via OpenModeration, and it is approved
  // only when text AND media are clean. No client-side pre-check: like text,
  // the client is not the moderation authority.


      // Upload independent attachments together after every student file has
      // passed the existing moderation checks. Promise.all preserves order.
      const [uploadedFiles, uploadedGifUrl] = await Promise.all([
        Promise.all(
          files.map(async (file) => {
            let uploadedUrl: string;

            if (file.mimeType.startsWith("image/")) {
              uploadedUrl = await uploadPostImage(file.uri);
            } else if (file.mimeType.startsWith("video/")) {
              uploadedUrl = await uploadPostVideo(file.uri);
            } else {
              uploadedUrl = await uploadPostFile(file.uri);
            }

            return { url: uploadedUrl, mimeType: file.mimeType, name: file.name, size: file.size };
          }),
        ),
        selectedGif ? uploadPostGif(selectedGif) : Promise.resolve(null),
      ]);
      const uploadedUrls = [...uploadedFiles];

      if (uploadedGifUrl) {
        uploadedUrls.push({ url: uploadedGifUrl, mimeType: "image/gif", name: "animated.gif", size: undefined });
      }

      // Auto-captioning: a video post starts life as caption "pending"; the
      // Worker transcribes it in the background (see requestVideoTranscription
      // below) and flips this to "ready"/"unavailable". Non-video posts don't
      // carry the field at all.
      const hasVideoAttachment = uploadedUrls.some((file) =>
        file.mimeType.startsWith("video/"),
      );

      const user = auth.currentUser;

      const nextMentionedUsers = hasAiAssistantMention(content)
        ? mentionedUsers.some((taggedUser) => isAiAssistantId(taggedUser.id))
          ? mentionedUsers
          : [...mentionedUsers, AI_ASSISTANT_STUDENT]
        : mentionedUsers.filter((taggedUser) => !isAiAssistantId(taggedUser.id));
      const normalizedMentionedUsers = hasEveryoneMention(content)
        ? nextMentionedUsers.some((taggedUser) => isEveryoneMentionId(taggedUser.id))
          ? nextMentionedUsers
          : [...nextMentionedUsers, EVERYONE_MENTION_STUDENT]
        : nextMentionedUsers.filter((taggedUser) => !isEveryoneMentionId(taggedUser.id));
      const uniqueMentionedUsers = normalizedMentionedUsers.filter(
        (user, index, self) =>
          index === self.findIndex((u) => u.id === user.id),
      );
      const uniqueTaggedUsers = [...uniqueMentionedUsers, ...taggedUsers].filter(
        (user, index, self) =>
          index === self.findIndex((u) => u.id === user.id),
      );
      let resolvedProfileName = authorProfileName;
      if (!isAnonymous && !resolvedProfileName) {
        try {
          const profile = await getUserDataByAuthUser(user);
          resolvedProfileName =
            `${profile?.firstname || ""} ${profile?.lastname || ""}`.trim();
        } catch (profileError) {
          console.warn("[CreatePost] Could not resolve author name:", profileError);
        }
      }

      // An anonymous post carries the writer's permanent anonymous name, so
      // readers can tell anonymous people apart without learning who they are.
      const anonymousHandle = isAnonymous ? await getMyAnonymousHandle() : null;
      const displayName = isAnonymous
        ? anonymousHandle || "Anonymous"
        : resolvedProfileName || user?.displayName?.trim() || user?.email?.split("@")[0] || "User";
      const aiPrompt = summarizeAiVisibleContent({
        text: content,
        username: displayName,
        isAnonymous,
        link: attachedLink,
        files: uploadedUrls,
        taggedUsers: uniqueTaggedUsers.map((u) => ({
          id: u.id,
          name: isAiAssistantId(u.id)
            ? AI_ASSISTANT_NAME
            : isEveryoneMentionId(u.id)
              ? EVERYONE_MENTION_TAG.name
              : `${u.firstname} ${u.lastname}`,
          studentID: u.studentID,
        })),
      });
      
      // MODERATION IS SERVER-AUTHORITATIVE. Every post is saved pending
      // first; the trusted Worker re-reads it and runs both text and media
      // (image/video) through OpenModeration before approving.
      const finalModerationReasons: string[] = [];

      if (!canUsePostFlair(selectedFlair, authorRole)) {
        showInfo("Flair Not Allowed", "Announcement is reserved for authorized staff accounts.");
        return;
      }

      const postData: any = {
  content: content.trim(),
  // App-wide search: word-array of the content, matched with array-contains.
  // Rebuilt on every edit below too.
  searchTerms: buildPostSearchTerms(content, [attachedLink?.title, attachedLink?.url]),
  flair: selectedFlair,
  ...(selectedFlair === "lost_found" ? { lostFoundStatus: lostFoundKind } : {}),
  files: uploadedUrls,
  ...(hasVideoAttachment ? { captionStatus: "pending" } : {}),

  // Keep the authenticated UID as the ownership identity even when the
  // public display is anonymous. Firestore rules depend on this invariant.
  userId: user?.uid,
  realUserId: user?.uid,
  ...(anonymousHandle ? { anonymousHandle } : {}),

  username: displayName,
  authorName: displayName,
  aiPrompt,

  // Persist the student marker used by report authorization. Staff content
  // intentionally keeps its existing schema and remains non-reportable.
  ...(authorRole === "student" ? { userRole: "student" } : {}),

  isAnonymous,

  taggedUsers: uniqueTaggedUsers.map((u) => ({
    id: u.id,
    name: isAiAssistantId(u.id)
      ? AI_ASSISTANT_NAME
      : isEveryoneMentionId(u.id)
        ? EVERYONE_MENTION_TAG.name
        : `${u.firstname} ${u.lastname}`,
    studentID: u.studentID,
  })),
  mentionedUserIds: uniqueMentionedUsers.map((user) => user.id),

  createdAt: serverTimestamp(),

  likeCount: 0,
  commentCount: 0,
  likedBy: [],
  bookmarkedBy: [],

  serverId: selectedServerId,
  channelId: selectedChannelId,

  moderationStatus: "pending",
  moderationReasons: finalModerationReasons,
  moderatedAtMs: null,
};
      if (attachedLink) {
        postData.link = attachedLink;
      }
      if (isStaff && shouldPin) {
        postData.pinnedAt = serverTimestamp();
        postData.pinnedBy = user?.uid;
        if (targetDate) {
          postData.pinExpiresAt = Timestamp.fromDate(targetDate);
          postData.targetDate = Timestamp.fromDate(targetDate);
          postData.targetDateLabel = targetDateLabel || formatTargetDateLabel(targetDate);
        }
      }

      let postRef: any;
      if (isEditMode && selectedEditPostId) {
        const editPayload: any = {
          content: content.trim(),
          searchTerms: buildPostSearchTerms(content, [attachedLink?.title, attachedLink?.url]),
          flair: selectedFlair,
          files: uploadedUrls,
          taggedUsers: uniqueTaggedUsers.map((u) => ({
            id: u.id,
            name: isAiAssistantId(u.id) ? AI_ASSISTANT_NAME : isEveryoneMentionId(u.id) ? EVERYONE_MENTION_TAG.name : `${u.firstname} ${u.lastname}`.trim(),
            studentID: u.studentID,
          })),
          mentionedUserIds: uniqueMentionedUsers.map((user) => user.id),
          isAnonymous,
          ...(anonymousHandle ? { anonymousHandle } : {}),
          aiPrompt,
          link: attachedLink || deleteField(),
          moderationStatus: "pending",
          moderationReasons: finalModerationReasons,
          moderatedAtMs: null,
          updatedAt: serverTimestamp(),
        };

        if (isStaff) {
          if (shouldPin) {
            editPayload.pinnedAt = serverTimestamp();
            editPayload.pinnedBy = user?.uid;
            if (targetDate) {
              editPayload.pinExpiresAt = Timestamp.fromDate(targetDate);
              editPayload.targetDate = Timestamp.fromDate(targetDate);
              editPayload.targetDateLabel = targetDateLabel || formatTargetDateLabel(targetDate);
            } else {
              editPayload.pinExpiresAt = deleteField();
              editPayload.targetDate = deleteField();
              editPayload.targetDateLabel = deleteField();
            }
          } else {
            editPayload.pinnedAt = deleteField();
            editPayload.pinnedBy = deleteField();
            editPayload.pinExpiresAt = deleteField();
            editPayload.targetDate = deleteField();
            editPayload.targetDateLabel = deleteField();
          }
        }

        await updateDoc(doc(db, "posts", selectedEditPostId), editPayload);

        let serverDecision: any = { status: "pending", selfHarm: false };
        try {
          serverDecision = await requestServerPostModeration(selectedEditPostId);
        } catch (moderationError) {
          console.warn("[CreatePost] Server moderation unavailable; post remains pending:", moderationError);
        }

        if (serverDecision.selfHarm === true) {
          setSafetyVisible(true);
          return;
        }

        if (serverDecision.status === "approved" && hasAiAssistantMention(content)) {
          try {
            const { reply, model } = await requestAiReplyFromWorker({
              serverId: selectedServerId || "posts",
              channelId: selectedChannelId || selectedEditPostId,
              sourceMessageId: selectedEditPostId,
              sourceUserId: user.uid,
              prompt: aiPrompt,
              contextMessages: [],
            });
            await updateDoc(doc(db, "posts", selectedEditPostId), {
              aiReply: { text: reply, model, status: "completed", generatedAtMs: Date.now() },
            });
          } catch (aiError) {
            console.warn("[CreatePost] Non-generative @BondedAI reply failed:", aiError);
          }
        }

        showInfo(
          serverDecision.status === "approved" ? "Success" : "Sent For Review",
          serverDecision.status === "approved"
            ? "Your edited post has been updated and approved."
            : "Your edited post was sent for moderator review.",
          () => router.back(),
        );
        return;
      }

      postRef = await addDoc(collection(db, "posts"), postData);

      // Firebase Spark has no deployable Cloud Functions. The post is always
      // created as PENDING, then the trusted Cloudflare Worker re-reads the
      // document and is the only non-staff path that can approve it. If the
      // Worker is unavailable, the post safely stays pending.
      let serverDecision: any = { status: "pending", selfHarm: false };
      try {
        serverDecision = await requestServerPostModeration(postRef.id);
      } catch (moderationError) {
        console.warn("[CreatePost] Server moderation unavailable; post remains pending:", moderationError);
      }

      if (serverDecision.selfHarm === true) {
        setSafetyVisible(true);
        return;
      }

      // Kick off caption generation once, only for an approved video post
      // (no point transcribing something that's about to be rejected). Fully
      // fire-and-forget — the post is already published and the video plays
      // regardless of whether/when captions arrive.
      if (serverDecision.status === "approved" && hasVideoAttachment) {
        void requestVideoTranscription(postRef.id);
      }

      // Staff announcement -> push to every device via the free Worker + Expo
      // path. Fire-and-forget; the Worker re-checks staff role + post owner.
      if (serverDecision.status === "approved" && selectedFlair === "announcement") {
        void notifyAnnouncement(postRef.id);
      }

      if (serverDecision.status === "approved" && hasAiAssistantMention(content)) {
        try {
          const { reply, model } = await requestAiReplyFromWorker({
            serverId: selectedServerId || "posts",
            channelId: selectedChannelId || postRef.id,
            sourceMessageId: postRef.id,
            sourceUserId: user.uid,
            prompt: aiPrompt,
            contextMessages: [],
          });
          await updateDoc(postRef, {
            aiReply: { text: reply, model, status: "completed", generatedAtMs: Date.now() },
          });
        } catch (aiError) {
          console.warn("[CreatePost] Non-generative @BondedAI reply failed:", aiError);
        }
      }

      showInfo(
        serverDecision.status === "approved" ? "Success" : "Sent For Review",
        serverDecision.status === "approved"
          ? "Your post has been created!"
          : "Your post was sent for moderator review and will appear after approval.",
        () => {
          setContent("");
          setSelectedFlair(DEFAULT_POST_FLAIR);
          setLostFoundKind("lost");
          setLostFoundSuggestionDismissed(false);
          setHelpSuggestionDismissed(false);
          setDismissedDetectedDate(false);
          setShouldPin(false);
          setTargetDate(null);
          setTargetDateLabel(null);
          setFiles([]);
          setTaggedUsers([]);
          setMentionedUsers([]);
          setIsAnonymous(false);
          setAttachedLink(null);
          setSelectedGif(null);
          setContentSelection({ start: 0, end: 0 });
          router.back();
          if (serverDecision.status === "approved") {
            requestAnimationFrame(emitHomeFeedScrollToTop);
          }
        },
      );
    } catch (error: any) {
      console.error("Upload error:", error);
      showInfo("Error", error.message || "Failed to create post");
    } finally {
      setUploading(false);
    }
  };

  const openTagModal = () => {
    setDraftTaggedUsers(taggedUsers);
    setSearchQuery("");
    setShowTagModal(true);
  };

  const cancelTagSelection = () => {
    setDraftTaggedUsers(taggedUsers);
    setSearchQuery("");
    setShowTagModal(false);
  };

  const confirmTagSelection = () => {
    setTaggedUsers(draftTaggedUsers);
    setSearchQuery("");
    setShowTagModal(false);
  };

  const handleTagUser = (student: Student) => {
    setDraftTaggedUsers((current) =>
      current.some((u) => u.id === student.id)
        ? current.filter((u) => u.id !== student.id)
        : [...current, student],
    );
  };

  // Rebuilt when the student list loads, not on every key press.
  const allMentionables = useMemo<MentionDraft[]>(
    () => [
      {
        ...AI_ASSISTANT_STUDENT,
        mentionToken: AI_MENTION_TOKEN,
        label: AI_ASSISTANT_NAME,
      },
      {
        ...EVERYONE_MENTION_STUDENT,
        mentionToken: EVERYONE_MENTION_TOKEN,
        label: EVERYONE_MENTION_NAME,
      },
      ...students.map((student) => ({
        ...student,
        mentionToken: getMentionTokenForStudent(
          student.studentID,
          student.firstname,
          student.lastname,
        ),
        label: `${student.firstname} ${student.lastname}`,
      })),
    ],
    [students],
  );

  const activeMentionMatch = content
    .slice(0, contentSelection.start)
    .match(/(^|\s)@([a-zA-Z0-9._-]*)$/);
  const activeMentionQuery = activeMentionMatch?.[2]?.toLowerCase() || "";
  const activeMentionIndex =
    activeMentionMatch && typeof activeMentionMatch.index === "number"
      ? activeMentionMatch.index + activeMentionMatch[1].length
      : -1;

  const mentionSuggestions = useMemo(
    () =>
      activeMentionIndex > -1
        ? allMentionables.filter((person) => {
            if (!activeMentionQuery) return true;
            return (
              person.label.toLowerCase().includes(activeMentionQuery) ||
              person.studentID.toLowerCase().includes(activeMentionQuery) ||
              person.mentionToken.slice(1).toLowerCase().includes(activeMentionQuery)
            );
          })
        : [],
    [activeMentionIndex, activeMentionQuery, allMentionables],
  );

  const syncMentionedUsersFromText = (nextText: string) => {
    setMentionedUsers((current) => {
      if (current.length === 0) return current;
      const next = current.filter((taggedUser) => {
        const token = isAiAssistantId(taggedUser.id)
          ? AI_MENTION_TOKEN
          : isEveryoneMentionId(taggedUser.id)
            ? EVERYONE_MENTION_TOKEN
          : getMentionTokenForStudent(
              taggedUser.studentID,
              taggedUser.firstname,
              taggedUser.lastname,
            );
        const tokenPattern = new RegExp(
          `(^|\\s)${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?=$|\\s|[.,!?])`,
          "i",
        );
        return tokenPattern.test(nextText);
      });
      // Keep the same list when nothing was removed, so ordinary typing isn't
      // treated as a tag change.
      return next.length === current.length ? current : next;
    });
  };

  // Scrolls the horizontal flair picker so the given flair's chip is fully
  // visible. No-op if the chip is already comfortably in view, so tapping
  // "Switch flair" on a chip that's already on screen doesn't jump the picker.
  const scrollFlairIntoView = (flairId: string) => {
    const layout = flairChipLayoutsRef.current[flairId];
    const picker = flairPickerRef.current;
    const viewportWidth = flairPickerWidthRef.current;
    if (!layout || !picker || viewportWidth <= 0) return;

    const scrollX = flairPickerScrollXRef.current;
    const margin = 16; // breathing room from the picker edges
    const chipStart = layout.x;
    const chipEnd = layout.x + layout.width;

    let nextX = scrollX;
    if (chipStart < scrollX + margin) {
      nextX = Math.max(0, chipStart - margin);
    } else if (chipEnd > scrollX + viewportWidth - margin) {
      nextX = chipEnd - viewportWidth + margin;
    } else {
      return; // already visible
    }
    picker.scrollTo({ x: nextX, animated: true });
  };

  const handleContentChange = (nextText: string) => {
    setContent(nextText);
    syncMentionedUsersFromText(nextText);
    // Re-arm both flair suggestions the moment the box is fully cleared, so
    // deleting everything and retyping matching text can surface a banner
    // again this session. A partial edit leaves a dismissed banner dismissed.
    if (nextText.trim().length === 0) {
      setLostFoundSuggestionDismissed(false);
      setHelpSuggestionDismissed(false);
      setDismissedDetectedDate(false);
    }
  };

  const handleSelectMention = (person: MentionDraft) => {
    if (activeMentionIndex < 0) return;
    const before = content.slice(0, activeMentionIndex);
    const after = content.slice(contentSelection.start);
    const insertion = `${person.mentionToken} `;
    const nextText = `${before}${insertion}${after}`;
    setContent(nextText);
    setMentionedUsers((current) => {
      if (current.some((entry) => entry.id === person.id)) return current;
      return [...current, person];
    });
    const nextCursor = before.length + insertion.length;
    setContentSelection({ start: nextCursor, end: nextCursor });
    requestAnimationFrame(() => {
      contentInputRef.current?.focus();
      contentInputRef.current?.setNativeProps?.({
        selection: { start: nextCursor, end: nextCursor },
      });
    });
  };

  const handleAddLink = () => {
    if (!linkUrl.trim()) {
      showInfo("Error", "Please enter a valid URL");
      return;
    }

    const urlPattern =
      /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/;
    if (!urlPattern.test(linkUrl)) {
      showInfo("Invalid URL", "Please enter a valid website URL");
      return;
    }

    let formattedUrl = linkUrl.trim();
    if (
      !formattedUrl.startsWith("http://") &&
      !formattedUrl.startsWith("https://")
    ) {
      formattedUrl = "https://" + formattedUrl;
    }

    easeLayout();
    setAttachedLink({
      url: formattedUrl,
      title: linkTitle.trim() || formattedUrl,
    });
    setShowLinkModal(false);
    setLinkUrl("");
    setLinkTitle("");
  };

  const handleRemoveLink = useCallback(() => {
    easeLayout();
    setAttachedLink(null);
    setLinkUrl("");
    setLinkTitle("");
  }, []);

  const handleCloseLinkModal = () => {
    setShowLinkModal(false);
    setLinkUrl("");
    setLinkTitle("");
  };

 const searchGifs = async (query: string) => {
    if (!query.trim()) {
      setGifResults([]);
      setGifError(null);
      return;
    }

    setLoadingGifs(true);
    setGifError(null);
    try {
      // Paste your Giphy API Key here (Get one free at https://developers.giphy.com)
      const GIPHY_API_KEY = "UAisLETyclXOiTF4eGtbxACJ3VM3hv6G";
      const limit = 20;

      const params = new URLSearchParams({
        api_key: GIPHY_API_KEY,
        q: query.trim(),
        limit: String(limit),
        rating: "g",
        lang: "en",
      });

      const response = await fetch(
        `https://api.giphy.com/v1/gifs/search?${params.toString()}`
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.data && data.data.length > 0) {
        setGifResults(data.data);
      } else {
        setGifResults([]);
        setGifError("No GIFs found for your search query.");
      }
    } catch (error) {
      console.error("Error searching GIFs:", error);
      setGifError("Failed to search GIFs. Please try again.");
    } finally {
      setLoadingGifs(false);
    }
  };

  const handleSelectGif = (gifUrl: string) => {
    easeLayout();
    setSelectedGif(gifUrl);
    setShowGifModal(false);
    setGifSearchQuery("");
    setGifResults([]);
  };

  const effectiveTaggedUsers = taggedUsers;
  // Filtering every student is only needed while the tag picker is open, not
  // on every key press in the post box.
  const filteredTagOptions = useMemo<Student[]>(() => {
    if (!showTagModal) return [];
    const search = searchQuery.toLowerCase();
    const filteredStudents = students.filter((s) => {
      const firstname = (s.firstname || "").toLowerCase();
      const lastname = (s.lastname || "").toLowerCase();
      const studentID = (s.studentID || "").toLowerCase();

      return (
        firstname.includes(search) ||
        lastname.includes(search) ||
        studentID.includes(search)
      );
    });
    return filteredStudents.filter(
      (student) => !isAiAssistantId(student.id) && !isEveryoneMentionId(student.id),
    );
  }, [searchQuery, showTagModal, students]);

  // Recent questions, read once when the composer opens. Bounded by a date
  // window and a row limit, and filtered to question-flaired posts in memory
  // so the query stays single-field and needs no deployed composite index.
  useEffect(() => {
    let cancelled = false;

    const since = new Date();
    since.setDate(since.getDate() - DUPLICATE_QUESTION_WINDOW_DAYS);

    getDocs(
      query(
        collection(db, "posts"),
        where("createdAt", ">=", since),
        orderBy("createdAt", "desc"),
        limit(80),
      ),
    )
      .then((snapshot) => {
        if (cancelled) return;
        setRecentQuestions(
          snapshot.docs
            .filter((postDoc) => {
              const data = (postDoc.data() || {}) as any;
              // Only approved questions. Warning about a pending or rejected
              // post would leak content the author is not allowed to see.
              const status = String(data.moderationStatus ?? "approved").toLowerCase();
              return (
                status === "approved" &&
                normalizePostFlair(data.flair) === "question"
              );
            })
            .map((postDoc) => {
              const data = (postDoc.data() || {}) as any;
              return {
                id: postDoc.id,
                content: String(data.content || ""),
                authorName: String(data.username || data.authorName || "Someone"),
                createdAt: data.createdAt,
              };
            }),
        );
      })
      .catch((error) => {
        // A missing hint is never worth interrupting the composer for.
        console.warn("Duplicate-question lookup failed:", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Require a bit of real content before suggesting anything — avoids
  // firing on a half-typed word every keystroke.
  const hasEnoughContentForSuggestion = content.trim().length >= 12;

  // Only for things actually being asked: the Question flair, or text that
  // ends in a question mark. Running this on every post would put a
  // "someone said this already" hint under ordinary conversation.
  const looksLikeQuestion =
    selectedFlair === "question" || content.trim().endsWith("?");

  const duplicateQuestion = useMemo(() => {
    if (duplicateQuestionDismissed || !looksLikeQuestion) return null;
    if (!hasEnoughContentForSuggestion) return null;

    const match = findMostSimilar(
      content,
      recentQuestions.filter(
        (item: RecentQuestion) => item.id !== selectedEditPostId && item.content,
      ),
      (item) => item.content,
      DUPLICATE_QUESTION_THRESHOLD,
    );

    return match?.item ?? null;
  }, [
    content,
    duplicateQuestionDismissed,
    hasEnoughContentForSuggestion,
    looksLikeQuestion,
    recentQuestions,
    selectedEditPostId,
  ]);

  const showLostFoundSuggestion =
    !lostFoundSuggestionDismissed &&
    selectedFlair !== "lost_found" &&
    hasEnoughContentForSuggestion &&
    looksLikeLostItemDescription(content);

  // Same shape as the Lost & Found suggestion. Only one banner shows at a
  // time: when a post matches both patterns, Lost & Found (the established
  // feature) wins, so this is suppressed whenever the text reads as a lost
  // item — not just when the Lost & Found banner happens to be visible.
  const showHelpSuggestion =
    !helpSuggestionDismissed &&
    selectedFlair !== "help" &&
    hasEnoughContentForSuggestion &&
    looksLikeHelpRequest(content) &&
    !looksLikeLostItemDescription(content);

  const detectedTargetDate = useMemo<DetectedTargetDate | null>(() => {
    if (
      dismissedDetectedDate ||
      !isStaff ||
      shouldPin ||
      !hasEnoughContentForSuggestion
    ) {
      return null;
    }
    return detectAnnouncementTargetDate(content);
  }, [content, dismissedDetectedDate, hasEnoughContentForSuggestion, isStaff, shouldPin]);

  // Stable handlers for the memoized sections, so typing in the post box only
  // redraws the parts of the screen that depend on the text.
  const handleToggleAnonymous = useCallback(() => {
    easeLayout();
    setIsAnonymous((current) => !current);
  }, []);
  const handleSelectFlair = useCallback((flairId: PostFlairId) => {
    easeLayout();
    setSelectedFlair(flairId);
  }, []);
  const handleFlairPickerLayout = useCallback((width: number) => {
    flairPickerWidthRef.current = width;
  }, []);
  const handleFlairPickerScroll = useCallback((x: number) => {
    flairPickerScrollXRef.current = x;
  }, []);
  const handleFlairChipLayout = useCallback((flairId: string, x: number, width: number) => {
    flairChipLayoutsRef.current[flairId] = { x, width };
  }, []);
  const handleTogglePin = useCallback(() => {
    easeLayout();
    const next = !shouldPin;
    setShouldPin(next);
    if (next && !targetDate) {
      const d = new Date();
      d.setDate(d.getDate() + 3);
      d.setHours(23, 59, 0, 0);
      setTargetDate(d);
      setTargetDateLabel(formatTargetDateLabel(d));
    }
  }, [shouldPin, targetDate]);
  const handleOpenDatePicker = useCallback(() => setShowDatePicker(true), []);
  const handleOpenTimePicker = useCallback(() => setShowTimePicker(true), []);
  const handlePinIndefinitely = useCallback(() => {
    easeLayout();
    setTargetDate(null);
    setTargetDateLabel(null);
  }, []);
  const handleRemoveGif = useCallback(() => {
    easeLayout();
    setSelectedGif(null);
  }, []);
  const handleRemoveExistingFile = useCallback((index: number) => {
    easeLayout();
    setExistingFiles((current) => current.filter((_, idx) => idx !== index));
  }, []);
  const handleRemoveFile = useCallback((index: number) => {
    easeLayout();
    setFiles((current) => current.filter((_, idx) => idx !== index));
  }, []);
  const handleTakePhoto = useStableCallback(takePhoto);
  const handlePickPhotos = useStableCallback(pickPhotos);
  const handlePickDocuments = useStableCallback(pickDocuments);
  const handlePickVideos = useStableCallback(pickVideos);
  const handleOpenLinkModal = useCallback(() => setShowLinkModal(true), []);
  const handleOpenGifModal = useCallback(() => setShowGifModal(true), []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
      <KeyboardAvoidingView automaticOffset
        style={{ flex: 1 }}
        behavior="padding"
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{isEditMode ? "Edit Post" : "Create Post"}</Text>
          <TouchableOpacity
            activeOpacity={0.7}
            style={styles.headerCloseButton}
            onPress={() => router.back()}
            accessibilityRole="button"
          >
            <Ionicons name="close" size={28} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>

        <View style={styles.scopeCard}>
          <Ionicons
            name={selectedServerId ? "server-outline" : "home-outline"}
            size={18}
            color={theme.accent}
          />
          <View style={styles.scopeCopy}>
            <Text style={styles.scopeLabel}>
              {selectedServerId ? "Posting to server" : "Posting to Home"}
            </Text>
            <Text style={styles.scopeValue}>
              {selectedServerId && selectedServerName
                ? `${selectedServerName}${selectedChannelLabel ? ` • #${selectedChannelLabel}` : ""}`
                : "Campus-wide shared feed"}
            </Text>
          </View>
        </View>

        <KeyboardAwareScrollView
          ref={contentScrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          bottomOffset={32}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        >
          {files.length > 0 && (
            <View style={styles.fileLimitInfo}>
              <Text style={styles.fileLimitText}>
                {files.length} / {MAX_FILES} files attached
              </Text>
            </View>
          )}

          <AnonymousToggle
            isAnonymous={isAnonymous}
            progress={anonymousProgress}
            onToggle={handleToggleAnonymous}
          />

          <View style={styles.flairSection}>
            <View style={styles.flairSectionHeader}>
              <Text style={styles.flairSectionTitle}>Post flair</Text>
              <Text style={styles.flairSectionHint}>Choose a category</Text>
            </View>
            {showLostFoundSuggestion && (
              <FlairSuggestionBanner
                message="🔎 This sounds like a Lost & Found post — want to switch the flair?"
                onSwitch={() => {
                  easeLayout();
                  setSelectedFlair("lost_found");
                  setLostFoundSuggestionDismissed(true);
                  requestAnimationFrame(() => scrollFlairIntoView("lost_found"));
                }}
                onDismiss={() => {
                  easeLayout();
                  setLostFoundSuggestionDismissed(true);
                }}
              />
            )}
            {showHelpSuggestion && (
              <FlairSuggestionBanner
                message="🆘 This sounds like a Help / Advice post — want to switch the flair?"
                onSwitch={() => {
                  easeLayout();
                  setSelectedFlair("help");
                  setHelpSuggestionDismissed(true);
                  requestAnimationFrame(() => scrollFlairIntoView("help"));
                }}
                onDismiss={() => {
                  easeLayout();
                  setHelpSuggestionDismissed(true);
                }}
              />
            )}
            {!!duplicateQuestion && (
              <View style={styles.duplicateQuestionCard}>
                <Ionicons name="help-circle-outline" size={19} color={theme.accent} />
                <View style={styles.duplicateQuestionCopy}>
                  <Text style={styles.duplicateQuestionTitle}>
                    {`${duplicateQuestion.authorName} asked something similar ${getTimeAgo(duplicateQuestion.createdAt)}`}
                  </Text>
                  <Text
                    style={styles.duplicateQuestionText}
                    numberOfLines={2}
                  >
                    {`“${duplicateQuestion.content}”`}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    easeLayout();
                    setDuplicateQuestionDismissed(true);
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons name="close" size={17} color={theme.textMuted} />
                </TouchableOpacity>
              </View>
            )}
            <FlairPicker
              pickerRef={flairPickerRef}
              selectedFlair={selectedFlair}
              authorRole={authorRole}
              onSelect={handleSelectFlair}
              onPickerLayout={handleFlairPickerLayout}
              onPickerScroll={handleFlairPickerScroll}
              onChipLayout={handleFlairChipLayout}
            />

            {/* Status is set here once, then changed from the post itself — so
                editing a post never touches it. */}
            {selectedFlair === "lost_found" && !isEditMode && (
              <View style={styles.lostFoundKind}>
                <Text style={styles.lostFoundKindTitle}>Is this item…</Text>
                <View style={styles.lostFoundKindRow}>
                  {(["lost", "found"] as const).map((kind) => {
                    const info = getLostFoundStatusInfo(kind);
                    const tones = lostFoundStatusColors(kind, theme);
                    const selected = lostFoundKind === kind;
                    return (
                      <TouchableOpacity
                        key={kind}
                        style={[
                          styles.lostFoundKindOption,
                          selected && { backgroundColor: tones.fill, borderColor: tones.line },
                        ]}
                        onPress={() => setLostFoundKind(kind)}
                        activeOpacity={0.82}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                      >
                        <Text style={styles.lostFoundKindEmoji}>{info.emoji}</Text>
                        <View style={styles.lostFoundKindCopy}>
                          <Text
                            style={[
                              styles.lostFoundKindLabel,
                              selected && { color: tones.ink },
                            ]}
                          >
                            {kind === "lost" ? "Lost" : "Found"}
                          </Text>
                          <Text style={styles.lostFoundKindHint}>
                            {kind === "lost" ? "I'm looking for it" : "I have it"}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}
          </View>

          {isStaff && (
            <PinSection
              selectedFlair={selectedFlair}
              shouldPin={shouldPin}
              targetDate={targetDate}
              onTogglePin={handleTogglePin}
              onOpenDatePicker={handleOpenDatePicker}
              onOpenTimePicker={handleOpenTimePicker}
              onPinIndefinitely={handlePinIndefinitely}
            />
          )}

          {showDatePicker && (
            <DateTimePicker
              value={targetDate || new Date()}
              mode="date"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              minimumDate={new Date()}
              onChange={(_, selected) => {
                setShowDatePicker(false);
                if (selected) {
                  const next = targetDate ? new Date(targetDate) : new Date();
                  next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
                  setTargetDate(next);
                  setTargetDateLabel(formatTargetDateLabel(next));
                }
              }}
            />
          )}

          {showTimePicker && (
            <DateTimePicker
              value={targetDate || new Date()}
              mode="time"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              onChange={(_, selected) => {
                setShowTimePicker(false);
                if (selected) {
                  const next = targetDate ? new Date(targetDate) : new Date();
                  next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
                  setTargetDate(next);
                  setTargetDateLabel(formatTargetDateLabel(next));
                }
              }}
            />
          )}

          {detectedTargetDate && (
            <View style={styles.dateSuggestionBanner}>
              <View style={styles.dateSuggestionHeader}>
                <Ionicons name="sparkles" size={16} color={theme.accent} />
                <Text style={styles.dateSuggestionTitle}>Upcoming Target Date Detected</Text>
              </View>
              <Text style={styles.dateSuggestionText}>
                We detected <Text style={styles.dateSuggestionBold}>"{detectedTargetDate.matchedText}"</Text> ({detectedTargetDate.label}). Would you like to pin this announcement until then?
              </Text>
              <View style={styles.flairSuggestionActions}>
                <TouchableOpacity
                  style={styles.flairSuggestionSwitchButton}
                  activeOpacity={0.82}
                  onPress={() => {
                    easeLayout();
                    setShouldPin(true);
                    setTargetDate(detectedTargetDate.targetDate);
                    setTargetDateLabel(detectedTargetDate.label);
                    if (selectedFlair !== "announcement" && canUsePostFlair("announcement", authorRole)) {
                      setSelectedFlair("announcement");
                    }
                    setDismissedDetectedDate(true);
                  }}
                >
                  <Text style={styles.flairSuggestionSwitchText}>Pin until date</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.flairSuggestionDismissButton}
                  activeOpacity={0.82}
                  onPress={() => {
                    easeLayout();
                    setDismissedDetectedDate(true);
                  }}
                >
                  <Text style={styles.flairSuggestionDismissText}>Not now</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <View
            style={[
              styles.composerCard,
              isContentFocused && styles.composerCardFocused,
            ]}
          >
            <TextInput
              ref={contentInputRef}
              style={styles.input}
              placeholder="Share something with BondED..."
              placeholderTextColor={theme.textMuted}
              multiline
              value={content}
              onChangeText={handleContentChange}
              onFocus={() => setIsContentFocused(true)}
              onBlur={() => setIsContentFocused(false)}
              onSelectionChange={(event) => {
                const { start, end } = event.nativeEvent.selection;
                setContentSelection((current) =>
                  current.start === start && current.end === end ? current : { start, end },
                );
              }}
            />
          </View>

          {mentionSuggestions.length > 0 && (
            <View
              style={styles.mentionSheet}
              onLayout={(event) => {
                const mentionSheetY = event.nativeEvent.layout.y;
                requestAnimationFrame(() => {
                  contentScrollRef.current?.scrollTo({
                    y: Math.max(0, mentionSheetY - 12),
                    animated: true,
                  });
                });
              }}
            >
              <Text style={styles.mentionLabel}>Mention someone</Text>
              {mentionSuggestions.slice(0, 4).map((person) => (
                <TouchableOpacity
                  key={person.id}
                  style={styles.mentionRow}
                  onPress={() => handleSelectMention(person)}
                >
                  <View
                    style={[
                      styles.mentionAvatar,
                      isAiAssistantId(person.id) && styles.mentionAvatarAi,
                    ]}
                  >
                    <Text style={styles.mentionAvatarText}>
                      {isAiAssistantId(person.id)
                        ? "AI"
                        : `${person.firstname.charAt(0)}${person.lastname.charAt(0)}`}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.mentionName}>{person.label}</Text>
                    <Text style={styles.mentionMeta}>
                      {person.mentionToken} {isAiAssistantId(person.id) ? "assistant" : `• ${person.studentID}`}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <AttachmentPreviews
            selectedGif={selectedGif}
            attachedLink={attachedLink}
            existingFiles={existingFiles}
            files={files}
            onRemoveGif={handleRemoveGif}
            onRemoveLink={handleRemoveLink}
            onRemoveExistingFile={handleRemoveExistingFile}
            onRemoveFile={handleRemoveFile}
          />

          {effectiveTaggedUsers.length > 0 && (
            <View style={styles.taggedPreview}>
              <Ionicons name="people" size={16} color={theme.accent} />
              <Text style={styles.taggedPreviewText}>
                Tagged {effectiveTaggedUsers.length}{" "}
                {effectiveTaggedUsers.length === 1 ? "mention" : "mentions"}
              </Text>
            </View>
          )}

          <AddToPostToolbar
            filesCount={files.length}
            onTakePhoto={handleTakePhoto}
            onPickPhotos={handlePickPhotos}
            onPickDocuments={handlePickDocuments}
            onPickVideos={handlePickVideos}
            onOpenTags={openTagModal}
            onOpenLink={handleOpenLinkModal}
            onOpenGif={handleOpenGifModal}
            taggedCount={taggedUsers.length}
          />
        </KeyboardAwareScrollView>

        <View
          style={[
            styles.footer,
            { paddingBottom: Math.max(insets.bottom, 16) },
          ]}
        >
          <Animated.View style={{ transform: [{ scale: postButtonScale }] }}>
            <TouchableOpacity
              activeOpacity={0.9}
              style={[
                styles.postButton,
                !content.trim() &&
                  files.length === 0 &&
                  !selectedGif &&
                  !attachedLink &&
                  styles.disabledButton,
              ]}
              onPress={handlePost}
              onPressIn={() =>
                Animated.spring(postButtonScale, {
                  toValue: 0.97,
                  useNativeDriver: true,
                }).start()
              }
              onPressOut={() =>
                Animated.spring(postButtonScale, {
                  toValue: 1,
                  useNativeDriver: true,
                }).start()
              }
              disabled={
                (!content.trim() &&
                  files.length === 0 &&
                  !selectedGif &&
                  !attachedLink) ||
                uploading
              }
            >
              {uploading ? (
                <ActivityIndicator color={theme.onAccent} />
              ) : (
                <Text style={styles.postButtonText}>{isEditMode ? "Save Changes" : "Post"}</Text>
              )}
            </TouchableOpacity>
          </Animated.View>
        </View>

        <Modal
          visible={showTagModal}
          animationType="slide"
          transparent
          onRequestClose={cancelTagSelection}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContainer}>
              <View style={styles.sheetHandle} />
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  Tag People{" "}
                  {draftTaggedUsers.length > 0 && `(${draftTaggedUsers.length})`}
                </Text>
                <View style={styles.tagModalActions}>
                  <TouchableOpacity
                    style={styles.tagConfirmButton}
                    onPress={confirmTagSelection}
                    accessibilityRole="button"
                    accessibilityLabel={`Confirm ${draftTaggedUsers.length} selected tags`}
                  >
                    <Text style={styles.tagConfirmText}>
                      Confirm{draftTaggedUsers.length > 0 ? ` (${draftTaggedUsers.length})` : ""}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={cancelTagSelection} accessibilityRole="button" accessibilityLabel="Cancel tag selection">
                    <Ionicons name="close" size={24} color={theme.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>

              {students.length > 0 && (
                <TouchableOpacity
                  style={styles.tagAllButton}
                  onPress={() => {
                    // Tag all students (except already tagged)
                    const allTagged = students.filter(
                      (s) => !draftTaggedUsers.find((u) => u.id === s.id),
                    );
                    if (allTagged.length === 0) {
                      showInfo("Info", "Everyone is already tagged!");
                      return;
                    }
                    setDraftTaggedUsers([...draftTaggedUsers, ...allTagged]);
                  }}
                >
                  <Ionicons name="people-circle" size={20} color={theme.onAccent} />
                  <Text style={styles.tagAllText}>Tag All</Text>
                </TouchableOpacity>
              )}

              <TextInput
                placeholder="Search students..."
                placeholderTextColor={theme.textMuted}
                value={searchQuery}
                onChangeText={setSearchQuery}
                style={styles.searchInput}
              />

              <FlatList
                initialNumToRender={10}
                maxToRenderPerBatch={10}
                windowSize={7}
                data={filteredTagOptions}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => {
                  const tagged = draftTaggedUsers.find((u) => u.id === item.id);
                  const firstname = item.firstname || "?";
                  const lastname = item.lastname || "?";
                  return (
                    <TouchableOpacity
                      style={styles.studentItem}
                      onPress={() => handleTagUser(item)}
                    >
                      <View style={styles.studentAvatar}>
                        <Text style={styles.studentAvatarText}>
                          {isEveryoneMentionId(item.id)
                            ? "EV"
                            : `${firstname.charAt(0)}${lastname.charAt(0)}`}
                        </Text>
                      </View>
                      <View style={styles.studentInfo}>
                        <View style={styles.studentNameRow}>
                          <Text style={styles.studentName} numberOfLines={1}>
                            {isEveryoneMentionId(item.id)
                              ? EVERYONE_MENTION_NAME
                              : `${firstname} ${lastname}`}
                          </Text>
                          {/* Alumni stay fully mentionable - this only says
                              who you are about to reach. */}
                          <AlumniBadge yearlvl={item.yearlvl} />
                        </View>
                      </View>
                      {tagged && (
                        <Ionicons
                          name="checkmark-circle"
                          size={20}
                          color="#6f9aff"
                        />
                      )}
                    </TouchableOpacity>
                  );
                }}
                ListEmptyComponent={
                  <Text style={styles.emptyText}>
                    {searchQuery
                      ? "No students found"
                      : "You cannot tag yourself"}
                  </Text>
                }
              />
            </View>
          </View>
        </Modal>

        {/* Link Modal */}
        <Modal
          visible={showLinkModal}
          animationType="fade"
          transparent
          onRequestClose={handleCloseLinkModal}
        >
          <KeyboardAvoidingView automaticOffset
            behavior="padding"
            style={styles.linkModalOverlay}
          >
            <View style={styles.linkModalContent}>
              <View style={styles.linkModalHeader}>
                <Text style={styles.linkModalTitle}>Add Link</Text>
                <TouchableOpacity
                  style={styles.linkModalCloseButton}
                  onPress={handleCloseLinkModal}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close Add Link"
                >
                  <Ionicons name="close" size={24} color={theme.textSecondary} />
                </TouchableOpacity>
              </View>

              <TextInput
                placeholder="Enter URL (e.g., https://example.com)"
                placeholderTextColor={theme.textMuted}
                value={linkUrl}
                onChangeText={setLinkUrl}
                style={styles.linkInput}
                autoCapitalize="none"
                keyboardType="url"
              />

              <TextInput
                placeholder="Link title (optional)"
                placeholderTextColor={theme.textMuted}
                value={linkTitle}
                onChangeText={setLinkTitle}
                style={styles.linkInput}
              />

              <View style={styles.linkModalButtons}>
                <TouchableOpacity
                  style={[
                    styles.linkModalButton,
                    { backgroundColor: theme.surface },
                  ]}
                  onPress={handleCloseLinkModal}
                >
                  <Text style={styles.linkModalCancelText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.linkModalButton,
                    { backgroundColor: theme.accent },
                  ]}
                  onPress={handleAddLink}
                >
                  <Text style={styles.linkModalButtonText}>Add Link</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* GIF Modal */}
        <Modal
          visible={showGifModal}
          animationType="slide"
          transparent
          onRequestClose={() => setShowGifModal(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContainer}>
              <View style={styles.sheetHandle} />
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Choose a GIF</Text>
                <TouchableOpacity onPress={() => setShowGifModal(false)}>
                  <Ionicons name="close" size={40} color={theme.textSecondary} />
                </TouchableOpacity>
              </View>

              <View style={styles.gifSearchContainer}>
                <TextInput
                  placeholder="Search GIFs..."
                  placeholderTextColor={theme.textMuted}
                  value={gifSearchQuery}
                  onChangeText={setGifSearchQuery}
                  onSubmitEditing={() => searchGifs(gifSearchQuery)}
                  style={styles.searchInput}
                  returnKeyType="search"
                />
                <TouchableOpacity
                  style={styles.gifSearchButton}
                  onPress={() => searchGifs(gifSearchQuery)}
                >
                  <Ionicons name="search" size={20} color={theme.onAccent} />
                </TouchableOpacity>
              </View>

              {loadingGifs ? (
                <View style={styles.gifLoadingContainer}>
                  <ActivityIndicator size="large" color={theme.accent} />
                  <Text style={styles.gifLoadingText}>Searching GIFs...</Text>
                </View>
              ) : gifError ? (
                <View style={styles.gifErrorContainer}>
                  <Ionicons
                    name="cloud-offline-outline"
                    size={64}
                    color={theme.accent}
                  />
                  <Text style={styles.errorText}>{gifError}</Text>
                  <TouchableOpacity
                    style={styles.retryButton}
                    onPress={() => searchGifs(gifSearchQuery)}
                  >
                    <Text style={styles.retryButtonText}>Retry Search</Text>
                  </TouchableOpacity>
                </View>
              ) : gifResults.length > 0 ? (
               <FlatList
  initialNumToRender={8}
  maxToRenderPerBatch={8}
  windowSize={5}
  data={gifResults}
  numColumns={2}
  keyExtractor={(item, index) => item.id || index.toString()}
  renderItem={({ item }) => {
    // ✅ Updated to match Giphy API schema
    const images = item?.images;
    const gifUrl = images?.original?.url || images?.downsized_medium?.url;
    const thumbnailUrl = images?.fixed_width_small?.url || images?.preview_gif?.url || gifUrl;

    if (!gifUrl || !thumbnailUrl) return null;

    return (
      <TouchableOpacity
        style={styles.gifItem}
        onPress={() => handleSelectGif(gifUrl)}
      >
        <Image
          source={{ uri: thumbnailUrl }}
          style={styles.gifThumbnail}
          contentFit="cover"
        />
      </TouchableOpacity>
    );
  }}
  contentContainerStyle={styles.gifGrid}
/>
              ) : (
                <View style={styles.gifEmptyContainer}>
                  <Ionicons name="images-outline" size={64} color={theme.textMuted} />
                  <Text style={styles.emptyText}>
                    {gifSearchQuery
                      ? "No GIFs found"
                      : "Search for GIFs to get started"}
                  </Text>
                </View>
              )}
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
      </View>
      <ConfirmDialog
        visible={!!blockedDialog}
        title={blockedDialog?.title ?? ""}
        description={blockedDialog?.description}
        singleAction
        confirmText="OK"
        variant={blockedDialog?.variant ?? "warning"}
        onConfirm={() => {
          const onConfirmCallback = blockedDialog?.onConfirm;
          setBlockedDialog(null);
          onConfirmCallback?.();
        }}
        onCancel={() => setBlockedDialog(null)}
      />

      <SafetyDialog
        visible={safetyVisible}
        onClose={() => {
          setSafetyVisible(false);
          router.back();
        }}
        contentLabel="post"
      />
    </SafeAreaView>
  );
};

export default CreatePostScreen;

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  container: { flex: 1, backgroundColor: c.primary },
  contentShell: { flex: 1, backgroundColor: c.surfaceSunken },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 52,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    backgroundColor: c.surface,
  },
  headerTitle: { color: c.textSecondary, fontSize: 20, fontWeight: "bold" },
  headerCloseButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
  },
  flairSection: { marginTop: 16, marginBottom: 16 },
  lostFoundKind: { marginTop: 12, gap: 8 },
  lostFoundKindTitle: { color: c.textSecondary, fontSize: 13, fontWeight: "700" },
  lostFoundKindRow: { flexDirection: "row", gap: 10 },
  lostFoundKindOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surfaceRaised,
  },
  lostFoundKindEmoji: { fontSize: 16 },
  lostFoundKindCopy: { flex: 1, minWidth: 0 },
  lostFoundKindLabel: { color: c.textPrimary, fontSize: 14.5, fontWeight: "800" },
  lostFoundKindHint: { color: c.textMuted, fontSize: 11.5, marginTop: 1 },
  flairSectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 9 },
  flairSectionTitle: { color: c.textPrimary, fontSize: 14, fontWeight: "800" },
  flairSectionHint: { color: c.textMuted, fontSize: 12, fontWeight: "600" },
  flairPickerContent: { gap: 8, paddingRight: 16 },
  // Shared by both flair-suggestion banners (Lost & Found, Help / Advice) —
  // see the FlairSuggestionBanner component near the top of this file.
  flairSuggestionBanner: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.accent,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  flairSuggestionText: { color: c.textPrimary, fontSize: 13, fontWeight: "700", marginBottom: 8 },
  flairSuggestionActions: { flexDirection: "row", gap: 8 },
  flairSuggestionSwitchButton: { backgroundColor: c.primary, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 7 },
  flairSuggestionSwitchText: { color: c.surfaceRaised, fontSize: 12, fontWeight: "800" },
  flairSuggestionDismissButton: { backgroundColor: "transparent", borderWidth: 1, borderColor: c.border, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 7 },
  flairSuggestionDismissText: { color: c.textMuted, fontSize: 12, fontWeight: "700" },
  pinSection: {
    backgroundColor: c.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 16,
    marginBottom: 16,
    shadowColor: c.textPrimary,
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  pinRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pinLabelContainer: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    marginRight: 12,
  },
  pinTitle: {
    color: c.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  pinSubtitle: {
    color: c.textMuted,
    fontSize: 11,
    marginTop: 2,
    lineHeight: 15,
  },
  miniToggle: {
    width: 44,
    height: 26,
    backgroundColor: c.borderStrong,
    borderRadius: 13,
    justifyContent: "center",
    padding: 2,
  },
  miniToggleActive: {
    backgroundColor: c.danger,
  },
  miniToggleThumb: {
    width: 22,
    height: 22,
    backgroundColor: c.surfaceRaised,
    borderRadius: 11,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  miniToggleThumbActive: {
    transform: [{ translateX: 18 }],
  },
  pinDetailsCard: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  pinDetailsInfo: {
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 8,
  },
  pinDateControls: {
    flexDirection: "row",
    gap: 8,
  },
  pinDateButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 8,
  },
  pinDateButtonText: {
    color: c.textPrimary,
    fontSize: 12,
    fontWeight: "700",
  },
  pinExpiryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
  },
  pinExpiryBadge: {
    color: c.danger,
    fontSize: 12,
    fontWeight: "700",
  },
  pinRemoveDateText: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
  pinIndefiniteNote: {
    marginTop: 8,
    color: c.textMuted,
    fontSize: 11,
    fontStyle: "italic",
  },
  dateSuggestionBanner: {
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.accent,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  dateSuggestionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  dateSuggestionTitle: {
    color: c.accent,
    fontSize: 13,
    fontWeight: "700",
  },
  dateSuggestionText: {
    color: c.textPrimary,
    fontSize: 13,
    lineHeight: 16,
    marginBottom: 10,
  },
  dateSuggestionBold: {
    fontWeight: "800",
    color: c.danger,
  },
  flairChoice: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  flairChoiceSelected: { backgroundColor: c.primary, borderColor: c.primary },
  flairChoiceEmoji: { fontSize: 14 },
  flairChoiceText: { color: c.textSecondary, fontSize: 12, fontWeight: "700" },
  flairChoiceTextSelected: { color: c.surfaceRaised },
  flairChoiceCheck: { marginLeft: 1 },
  composerCardFocused: {
    borderColor: c.accent,
    shadowOpacity: 0.1,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.borderStrong,
    marginTop: 8,
  },
  scopeCard: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    gap: 10,
  },
  scopeCopy: { flex: 1 },
  scopeLabel: {
    color: c.textMuted,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  scopeValue: {
    color: c.textPrimary,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 3,
  },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 120 },
  fileLimitInfo: {
    backgroundColor: c.border,
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  fileLimitText: {
    color: c.textSecondary,
    fontSize: 13,
    textAlign: "center",
    fontWeight: "600",
  },
  anonymousContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.borderStrong,
    shadowColor: c.textPrimary,
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  anonymousLabel: { color: c.textPrimary, fontSize: 15, fontWeight: "600" },
  anonymousNote: {
    color: c.textMuted,
    fontSize: 13,
    marginTop: 6,
    marginBottom: 16,
    lineHeight: 16,
  },
  toggle: {
    width: 48,
    height: 28,
    backgroundColor: c.borderStrong,
    borderRadius: 14,
    justifyContent: "center",
    padding: 2,
  },
  toggleThumb: {
    width: 24,
    height: 24,
    backgroundColor: c.surfaceRaised,
    borderRadius: 12,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  input: {
    color: c.textPrimary,
    fontSize: 16,
    minHeight: 132,
    textAlignVertical: "top",
    lineHeight: 20,
  },
  composerCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.borderStrong,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
    shadowColor: c.textPrimary,
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  mentionSheet: {
    marginBottom: 16,
    maxHeight: 232,
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.borderStrong,
    overflow: "hidden",
  },
  mentionLabel: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.3,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
  },
  mentionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  mentionAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
    marginRight: 10,
  },
  mentionAvatarAi: {
    backgroundColor: "#efe3ff",
  },
  mentionAvatarText: {
    color: c.primary,
    fontSize: 12,
    fontWeight: "800",
  },
  mentionName: {
    color: c.textPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
  mentionMeta: {
    color: c.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  taggedPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.border,
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
    gap: 8,
  },
  taggedPreviewText: {
    color: c.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  tagAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.accent,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 6,
  },
  tagAllText: {
    color: c.onAccent,
    fontWeight: "600",
    fontSize: 14,
  },

  gifPreview: {
    marginBottom: 16,
    position: "relative",
    padding: 6,
    borderRadius: 16,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
    overflow: "hidden",
  },
  gifImage: {
    width: "100%",
    height: 250,
    borderRadius: 11,
  },
  linkPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.border,
    minHeight: 72,
    paddingLeft: 14,
    paddingVertical: 12,
    paddingRight: 8,
    borderRadius: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  linkTitle: {
    color: c.textPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  linkUrl: {
    color: c.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  linkRemoveButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
    flexShrink: 0,
    backgroundColor: c.surface,
  },
  filePreviewContainer: { gap: 12, marginBottom: 2 },
  filePreview: {
    marginBottom: 2,
    position: "relative",
    padding: 6,
    borderRadius: 16,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
    overflow: "hidden",
  },
  videoPreview: {
    width: 110,
    height: 90,
    borderRadius: 12,
    backgroundColor: c.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  imagePreview: { width: "100%", height: 250, borderRadius: 11 },
  documentPreview: {
    backgroundColor: c.border,
    padding: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  documentName: {
    color: c.textPrimary,
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
  },
  removeFile: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,250,247,0.92)",
  },
  addToPostContainer: {
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.borderStrong,
    gap: 12,
  },
  addToPostLabel: { color: c.textSecondary, fontSize: 15, fontWeight: "600" },
  iconRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  iconButton: {
    width: 42,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    backgroundColor: c.surfaceSunken,
  },
  iconButtonDisabled: {
    opacity: 0.4,
  },
  tagBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    backgroundColor: c.accent,
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  tagBadgeText: {
    color: c.onAccent,
    fontSize: 10,
    fontWeight: "bold",
  },
  footer: {
    backgroundColor: c.surface,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopColor: c.border,
    borderTopWidth: 1,
  },
  postButton: {
    backgroundColor: c.accent,
    minHeight: 52,
    borderRadius: 15,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: c.textSecondary,
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  disabledButton: { opacity: 0.5 },
  postButtonText: { color: c.onAccent, fontSize: 16, fontWeight: "bold" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)" },
  modalContainer: {
    flex: 1,
    backgroundColor: c.surfaceSunken,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 24,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
  },
  modalTitle: { flex: 1, color: c.textSecondary, fontSize: 18, fontWeight: "bold" },
  tagModalActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  tagConfirmButton: {
    minWidth: 88,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.primary,
  },
  tagConfirmText: {
    color: c.onPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
  searchInput: {
    backgroundColor: c.surface,
    color: c.textPrimary,
    borderRadius: 10,
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  studentItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderBottomColor: c.border,
    borderBottomWidth: 1,
  },
  studentAvatar: {
    backgroundColor: c.border,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  studentAvatarText: { color: c.textSecondary, fontWeight: "bold" },
  studentInfo: {
    flex: 1,
  },
  duplicateQuestionCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 14,
    padding: 13,
    marginBottom: 12,
  },
  duplicateQuestionCopy: { flex: 1 },
  duplicateQuestionTitle: {
    color: c.accent,
    fontSize: 12.5,
    fontWeight: "900",
  },
  duplicateQuestionText: {
    color: c.textMuted,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 3,
    fontStyle: "italic",
  },
  studentNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  studentName: {
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
  },
  studentID: {
    color: c.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  emptyText: { color: c.textMuted, textAlign: "center", marginTop: 40 },
  linkModalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  linkModalContent: {
    width: "85%",
    backgroundColor: c.surface,
    borderRadius: 16,
    padding: 24,
  },
  linkModalHeader: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  linkModalTitle: {
    color: c.textSecondary,
    fontSize: 18,
    fontWeight: "bold",
    textAlign: "center",
  },
  linkModalCloseButton: {
    position: "absolute",
    right: -6,
    width: 40,
    height: 40,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
  },
  linkInput: {
    backgroundColor: c.border,
    color: c.textPrimary,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  linkModalButtons: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  linkModalButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  linkModalButtonText: {
    color: c.onAccent,
    fontSize: 15,
    fontWeight: "600",
  },
  linkModalCancelText: {
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: "600",
  },
  gifSearchContainer: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 8,
  },
  gifSearchButton: {
    backgroundColor: c.accent,
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
  },
  gifLoadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  gifLoadingText: {
    color: c.textMuted,
    fontSize: 14,
    marginTop: 12,
  },
  gifGrid: {
    padding: 8,
  },
  gifItem: {
    flex: 1,
    margin: 4,
    aspectRatio: 1,
    maxWidth: "48%",
  },
  gifThumbnail: {
    width: "100%",
    height: "100%",
    borderRadius: 8,
  },
  gifEmptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 32,
  },
  gifErrorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 32,
  },
  errorText: {
    color: c.textMuted,
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
    marginHorizontal: 20,
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: c.accent,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 16,
  },
  retryButtonText: {
    color: c.onAccent,
    fontWeight: "600",
    fontSize: 14,
  },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

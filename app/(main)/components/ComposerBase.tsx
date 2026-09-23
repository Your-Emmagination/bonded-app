// components/ComposerBase.tsx
import { useThemeColors } from "@/contexts/ThemeContext";
import { getMyAnonymousHandle } from "@/utils/anonymousHandle";
import type { ThemeTokens } from "@/utils/theme";
import {
    AI_ASSISTANT_NAME,
    AI_ASSISTANT_STUDENT,
    AI_ASSISTANT_TAG,
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
import { resolveAvatarUri } from "@/utils/avatar";
import { isStaffRole } from "@/utils/communityServers";
import { AVATAR_SIZE_SMALL, avatarThumb } from "@/utils/cloudinaryImages";
import { prepareComposerAttachments, type ComposerAttachments } from "@/utils/composerUploads";
import { getFileIconDetails } from "@/utils/fileTypeHelper";
import { normalizeMessageUrl } from "@/utils/chatLinks";
import { findBlockedLink } from "@/utils/externalLinks";
import { Ionicons } from "@expo/vector-icons";
import { pickUploadDocuments, isAttachmentTooLargeError, isAttachmentUnavailableError } from "@/utils/uploadAttachments";
import { Image } from "expo-image";
import {
    collection,
    getDocs,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    FlatList,
    Modal,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import {
    KeyboardAvoidingView,
    KeyboardAwareScrollView,
} from "react-native-keyboard-controller";
import { auth, db } from "../../../Firebase_configure";
import ConfirmDialog from "./ConfirmDialog";
import DragToCloseSheet from "./DragToCloseSheet";

const MAX_FILES = 10;
const MAX_CHARACTERS = 1250;

export type ComposerPayload = {
  text: string;
  /** The writer's permanent anonymous name, on anonymous content. */
  anonymousHandle?: string;
  userId: string;
  realUserId?: string;
  username?: string;
  role?: string;
  likes?: string[];
  profilePic?: string | null;
  profileImage?: string | null;
  isAnonymous?: boolean;
  replyCount?: number;
  link?: { url: string; title: string };
  taggedUsers?: { id: string; name: string; studentID: string }[];
  /** IDs inserted inline with @. Manual tags are the remaining taggedUsers. */
  mentionedUserIds?: string[];
};

interface Student {
  id: string;
  firstname: string;
  lastname: string;
  email: string;
  studentID: string;
  role?: string;
}

type MentionDraft = Student & {
  mentionToken: string;
  label: string;
};

export interface ComposerProps {
  // Resolve false when the message wasn't sent (e.g. offline) and the screen
  // has already told the user why; the composer then gives the text back.
  // Attachments arrive un-uploaded: the screen shows the message with the
  // phone's copies first, then calls attachments.upload() before saving it.
  onSend?: (payload: ComposerPayload, attachments: ComposerAttachments) => Promise<void | boolean>;
  currentUser: any;
  maxFiles?: number;
  placeholder?: string;
  replyingTo?: { id: string; name: string; text: string } | null;
  onCancelReply?: () => void;
  /** Parent can draw its own reply bar while retaining focus behavior. */
  showReplyBar?: boolean;
  /** Kept for existing callers; the compact input is now always visible. */
  autoExpand?: boolean;
  // Optional: fired as the user types (true) and when the box is cleared or a
  // message is sent (false). Consumers debounce/throttle any side effects.
  onTypingChange?: (isTyping: boolean) => void;
  /**
   * A Staff only channel: only staff can be mentioned, and there is no
   * B.E.A., no @everyone and no anonymous mode — students can't see the
   * channel, so none of those would make sense there.
   */
  staffOnly?: boolean;
  /** Shows a Poll button in the options, for server channels. */
  onCreatePoll?: () => void;
}

export interface ComposerLabels {
  item: "comment" | "reply" | "message";
  placeholder: string;
  send: string;
  sending: string;
  sendFailure: string;
  connectionFailure: string;
  attachmentFailure: string;
  logPrefix: string;
}

interface ComposerBaseProps extends ComposerProps {
  labels: ComposerLabels;
}

let cachedStudents: Student[] | null = null;
let studentsRequest: Promise<Student[]> | null = null;

const ComposerBase: React.FC<ComposerBaseProps> = ({
  labels,
  onSend,
  currentUser,
  maxFiles = MAX_FILES,
  placeholder = labels.placeholder,
  replyingTo = null,
  onCancelReply,
  showReplyBar = true,
  onTypingChange,
  staffOnly = false,
  onCreatePoll,
}) => {
  const { composerStyles, theme } = useStyles();
  const [draftText, setDraftText] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [files, setFiles] = useState<{ uri: string; mimeType: string; name: string }[]>([]);
  const [attachedLink, setAttachedLink] = useState<{ url: string; title: string } | null>(null);
  // Inline @mentions and manual "Tag people" selections have different UI.
  // They are combined only when the payload is built for notifications.
  const [mentionedUsers, setMentionedUsers] = useState<Student[]>([]);
  const [taggedUsers, setTaggedUsers] = useState<Student[]>([]);
  const [draftTaggedUsers, setDraftTaggedUsers] = useState<Student[]>([]);
  const [showTagModal, setShowTagModal] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [showGifModal, setShowGifModal] = useState(false);
  const [gifSearchQuery, setGifSearchQuery] = useState("");
  const [gifResults, setGifResults] = useState<any[]>([]);
  const [selectedGif, setSelectedGif] = useState<string | null>(null);
  const [loadingGifs, setLoadingGifs] = useState(false);
  const [gifError, setGifError] = useState<string | null>(null);
  // Stable, so the GIF sheet's drag gesture isn't rebuilt on every keystroke.
  const closeGifPicker = useCallback(() => {
    setShowGifModal(false);
    setGifError(null);
  }, []);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [infoDialog, setInfoDialog] = useState<{ title: string; description: string } | null>(null);
  const showInfo = (title: string, description: string) => setInfoDialog({ title, description });
  const textInputRef = useRef<TextInput>(null);
  // Blocks a second send while one is still running (a fast double tap lands
  // before the Send button re-renders as disabled).
  const isSendingRef = useRef(false);

  useEffect(() => {
    if (replyingTo) {
      textInputRef.current?.focus();
    }
  }, [replyingTo]);

  const fetchStudents = async (): Promise<Student[]> => {
    if (cachedStudents) {
      return cachedStudents;
    }

    if (studentsRequest) {
      return studentsRequest;
    }

    studentsRequest = (async () => {
    try {
      const studentsSnapshot = await getDocs(collection(db, "students"));
      const currentUserId = auth.currentUser?.uid;
      const currentUserEmail = auth.currentUser?.email;
      const currentStudentID = currentUserEmail?.split("@")[0];

      const studentsList = studentsSnapshot.docs
        .map((doc): Student | null => {
          const data = doc.data();
          if (!data.firstname || !data.lastname || !data.studentID) return null;
          return {
            id: doc.id,
            firstname: String(data.firstname || "").trim(),
            lastname: String(data.lastname || "").trim(),
            email: String(data.email || ""),
            studentID: String(data.studentID || ""),
            role: String(data.role || ""),
          };
        })
        .filter((student): student is Student => {
          if (student === null) return false;
          if (student.id === currentUserId) return false;
          if (student.id === currentStudentID) return false;
          if (student.studentID === currentStudentID) return false;
          return true;
        });

      cachedStudents = studentsList;
      return studentsList;
    } catch (error) {
      console.error("Error fetching students:", error);
      return [];
    } finally {
      studentsRequest = null;
    }
    })();

    return studentsRequest;
  };

  useEffect(() => {
    fetchStudents().then(setStudents).catch(() => undefined);
  }, []);

  const pickPhotos = async () => {
    try {
      if (files.length >= maxFiles) {
        showInfo("Maximum Files Reached", `You can only attach up to ${maxFiles} files per ${labels.item}.`);
        return;
      }

      const result = await pickUploadDocuments({
        type: "image/*",
        multiple: true,
      });

      if (!result.canceled && result.assets?.length > 0) {
        const remainingSlots = maxFiles - files.length;
        const filesToAdd = result.assets.slice(0, remainingSlots);

        if (result.assets.length > remainingSlots) {
          showInfo("File Limit", `Only ${remainingSlots} more file(s) can be added. Maximum is ${maxFiles} files per ${labels.item}.`);
        }

        const newFiles = filesToAdd.map((picked) => ({
          uri: picked.uri || "",
          mimeType: picked.mimeType ?? "image/jpeg",
          name: picked.name ?? `photo_${Date.now()}.jpg`,
          size: picked.size,
        }));
        setFiles([...files, ...newFiles]);
      }
    } catch (error) {
      console.error(`${labels.logPrefix} selecting photos:`, error);
      showInfo("Attachment unavailable", "Could not prepare the selected photo. Please select it again.");
    }
  };

  const pickDocuments = async () => {
    try {
      if (files.length >= maxFiles) {
        showInfo("Maximum Files Reached", `You can only attach up to ${maxFiles} files per ${labels.item}.`);
        return;
      }

      const result = await pickUploadDocuments({
        type: "*/*",
        multiple: true,
      });

      if (!result.canceled && result.assets?.length > 0) {
        const remainingSlots = maxFiles - files.length;
        const filesToAdd = result.assets.slice(0, remainingSlots);

        if (result.assets.length > remainingSlots) {
          showInfo("File Limit", `Only ${remainingSlots} more file(s) can be added. Maximum is ${maxFiles} files per ${labels.item}.`);
        }

        const newFiles = filesToAdd.map((picked) => ({
          uri: picked.uri || "",
          mimeType: picked.mimeType ?? "application/octet-stream",
          name: picked.name ?? `file_${Date.now()}`,
          size: picked.size,
        }));
        setFiles([...files, ...newFiles]);
      }
    } catch (error) {
      console.error(`${labels.logPrefix} selecting files:`, error);
      showInfo(
        isAttachmentTooLargeError(error) ? "File too large" : "Attachment unavailable",
        error instanceof Error ? error.message : "Could not prepare the selected file. Please select it again.",
      );
    }
  };

  const handleAddLink = () => {
    const normalizedUrl = normalizeMessageUrl(linkUrl);
    if (!normalizedUrl) {
      showInfo("Invalid URL", "Enter a website such as facebook.com or https://facebook.com.");
      return;
    }

    const blockedLink = findBlockedLink([normalizedUrl]);
    if (blockedLink) {
      showInfo("This link can't be added", `${blockedLink.host} is blocked in BondED.`);
      return;
    }

    setAttachedLink({ url: normalizedUrl, title: linkTitle.trim() });
    setShowLinkModal(false);
    setLinkUrl("");
    setLinkTitle("");
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

  // In a Staff only channel, only staff can be mentioned or tagged.
  const mentionableStudents = staffOnly
    ? students.filter((student) => isStaffRole(student.role))
    : students;

  const allMentionables: MentionDraft[] = [
    ...(staffOnly
      ? []
      : [
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
        ]),
    ...mentionableStudents.map((student) => ({
      ...student,
      mentionToken: getMentionTokenForStudent(
        student.studentID,
        student.firstname,
        student.lastname,
      ),
      label: `${student.firstname} ${student.lastname}`,
    })),
  ];

  const activeMentionMatch = draftText
    .slice(0, selection.start)
    .match(/(^|\s)@([a-zA-Z0-9._-]*)$/);
  const activeMentionQuery = activeMentionMatch?.[2]?.toLowerCase() || "";
  const activeMentionIndex =
    activeMentionMatch && typeof activeMentionMatch.index === "number"
      ? activeMentionMatch.index + activeMentionMatch[1].length
      : -1;
  const mentionSuggestions =
    activeMentionIndex > -1
      ? allMentionables.filter((person) => {
          if (!activeMentionQuery) return true;
          return (
            person.label.toLowerCase().includes(activeMentionQuery) ||
            person.studentID.toLowerCase().includes(activeMentionQuery) ||
            person.mentionToken.slice(1).toLowerCase().includes(activeMentionQuery)
          );
        })
      : [];

  const syncMentionedUsersFromText = (nextText: string) => {
    setMentionedUsers((current) =>
      current.filter((taggedUser) => {
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
      }),
    );
  };

  const handleChangeText = (nextText: string) => {
    setDraftText(nextText);
    syncMentionedUsersFromText(nextText);
    onTypingChange?.(nextText.trim().length > 0);
  };

  const handleSelectMention = (person: MentionDraft) => {
    if (activeMentionIndex < 0) return;
    const before = draftText.slice(0, activeMentionIndex);
    const after = draftText.slice(selection.start);
    const insertedText = `${person.mentionToken} `;
    const nextText = `${before}${insertedText}${after}`;
    setDraftText(nextText);
    setMentionedUsers((current) => {
      if (current.some((entry) => entry.id === person.id)) return current;
      return [...current, person];
    });
    const nextCursor = before.length + insertedText.length;
    setSelection({ start: nextCursor, end: nextCursor });
    requestAnimationFrame(() => {
      textInputRef.current?.focus();
      textInputRef.current?.setNativeProps?.({
        selection: { start: nextCursor, end: nextCursor },
      });
    });
  };

  const handleSend = async () => {
    if (!draftText.trim() && files.length === 0 && !attachedLink && !selectedGif) return;
    if (!currentUser || !onSend) return;
    if (isSendingRef.current) return;
    isSendingRef.current = true;

    // Clear the composer on tap instead of after the screen finishes sending,
    // which can include moderation and notifications. The draft is given back
    // if the message isn't sent.
    const draft = {
      text: draftText,
      files,
      mentionedUsers,
      taggedUsers,
      attachedLink,
      selectedGif,
      isAnonymous: staffOnly ? false : isAnonymous,
    };
    setDraftText("");
    setFiles([]);
    setMentionedUsers([]);
    setTaggedUsers([]);
    setAttachedLink(null);
    setSelectedGif(null);
    setIsAnonymous(false);
    setSelection({ start: 0, end: 0 });
    onTypingChange?.(false);
    textInputRef.current?.focus();

    // Only fills in what's still empty, so anything typed since isn't lost. An
    // anonymous draft turns anonymous back on so it can't be resent under the
    // user's name by accident.
    const restoreDraft = () => {
      setDraftText((current) => (current.trim() ? current : draft.text));
      setFiles((current) => (current.length > 0 ? current : draft.files));
      setMentionedUsers((current) => (current.length > 0 ? current : draft.mentionedUsers));
      setTaggedUsers((current) => (current.length > 0 ? current : draft.taggedUsers));
      setAttachedLink((current) => current ?? draft.attachedLink);
      setSelectedGif((current) => current ?? draft.selectedGif);
      if (draft.isAnonymous) setIsAnonymous(true);
    };

    setUploading(true);
    try {
      // Not uploaded here: the screen shows the message at once and uploads
      // these before it saves.
      const attachments = prepareComposerAttachments(draft.files, draft.selectedGif);

      const nextMentionedUsers = hasAiAssistantMention(draft.text)
        ? draft.mentionedUsers.some((user) => isAiAssistantId(user.id))
          ? draft.mentionedUsers
          : [...draft.mentionedUsers, AI_ASSISTANT_STUDENT]
        : draft.mentionedUsers.filter((user) => !isAiAssistantId(user.id));
      const normalizedMentionedUsers = hasEveryoneMention(draft.text)
        ? nextMentionedUsers.some((user) => isEveryoneMentionId(user.id))
          ? nextMentionedUsers
          : [...nextMentionedUsers, EVERYONE_MENTION_STUDENT]
        : nextMentionedUsers.filter((user) => !isEveryoneMentionId(user.id));
      const uniqueMentionedUsers = normalizedMentionedUsers.filter(
        (user, index, self) =>
          index === self.findIndex((entry) => entry.id === user.id) &&
          !(staffOnly && (isAiAssistantId(user.id) || isEveryoneMentionId(user.id))),
      );
      const uniqueTaggedUsers = [...uniqueMentionedUsers, ...draft.taggedUsers].filter(
        (user, index, self) =>
          index === self.findIndex((u) => u.id === user.id) &&
          !(staffOnly && (isAiAssistantId(user.id) || isEveryoneMentionId(user.id)))
      );

      // Anonymous content carries the writer's permanent anonymous name.
      const anonymousHandle = draft.isAnonymous ? await getMyAnonymousHandle() : null;
      const payload: ComposerPayload = {
        text: draft.text.trim(),
        userId: draft.isAnonymous ? "anonymous" : currentUser.uid,
        realUserId: currentUser.uid,
        ...(anonymousHandle ? { anonymousHandle } : {}),
        username: draft.isAnonymous
          ? anonymousHandle || "Anonymous"
          : (
              `${currentUser.firstname || ""} ${currentUser.lastname || ""}`.trim() ||
              String(currentUser.username || currentUser.displayName || "").trim() ||
              String(currentUser.email || "").split("@")[0]?.trim() ||
              "User"
            ),
        role: currentUser.role || "student",
        likes: [],
        profilePic: draft.isAnonymous ? null : resolveAvatarUri(currentUser),
        profileImage: draft.isAnonymous ? null : resolveAvatarUri(currentUser),
        isAnonymous: draft.isAnonymous,
        replyCount: 0,
        taggedUsers: uniqueTaggedUsers.map((u) => ({
          id: u.id,
          name: isAiAssistantId(u.id)
            ? AI_ASSISTANT_TAG.name
            : isEveryoneMentionId(u.id)
              ? EVERYONE_MENTION_TAG.name
            : `${u.firstname} ${u.lastname}`,
          studentID: u.studentID,
        })),
        mentionedUserIds: uniqueMentionedUsers.map((user) => user.id),
      };

      if (draft.attachedLink) {
        payload.link = draft.attachedLink;
      }

      const sent = await onSend(payload, attachments);
      if (sent === false) restoreDraft();
    } catch (error: any) {
      console.error(`${labels.logPrefix}:`, error);
      restoreDraft();

      const errorMessage = error?.message?.toLowerCase() || "";
      if (isAttachmentUnavailableError(error)) {
        showInfo("Attachment unavailable", labels.attachmentFailure);
      } else if (
        errorMessage.includes("network") ||
        errorMessage.includes("connection") ||
        errorMessage.includes("timeout") ||
        error?.code === "unavailable" ||
        error?.code === "ECONNREFUSED"
      ) {
        showInfo("Connection Error", labels.connectionFailure);
      } else {
        showInfo("Error", labels.sendFailure);
      }
    } finally {
      setUploading(false);
      isSendingRef.current = false;
    }
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
      // Replace with your actual Giphy API key
      const GIPHY_API_KEY = "UAisLETyclXOiTF4eGtbxACJ3VM3hv6G"; 
      const limit = 20;

      const params = new URLSearchParams({
        api_key: GIPHY_API_KEY,
        q: query.trim(),
        limit: String(limit),
        rating: "g",
        lang: "en",
      });

      const response = await fetch(`https://api.giphy.com/v1/gifs/search?${params.toString()}`);

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
    setSelectedGif(gifUrl);
    setShowGifModal(false);
    setGifSearchQuery("");
    setGifResults([]);
    setGifError(null);
  };

  const filteredStudents = mentionableStudents.filter((s) => {
    const firstname = (s.firstname || "").toLowerCase();
    const lastname = (s.lastname || "").toLowerCase();
    const studentID = (s.studentID || "").toLowerCase();
    const search = searchQuery.toLowerCase();
    return firstname.includes(search) || lastname.includes(search) || studentID.includes(search);
  });
  // B.E.A. and @everyone are mention targets, not people tags. They remain
  // available from the inline @ picker and never create a duplicate "with" row.
  const filteredTagOptions = filteredStudents.filter(
    (student) => !isAiAssistantId(student.id) && !isEveryoneMentionId(student.id),
  );
  // Only deliberate Tag People selections get a separate preview and the
  // "with …" line. Inline @mentions remain visible only in the message text.
  const effectiveTaggedUsers = taggedUsers;

  const remainingChars = MAX_CHARACTERS - draftText.length;
  const isNearLimit = remainingChars < 100;

  return (
    <>
      <View style={composerStyles.inputWrapper}>
        {/* Replying To Bar */}
        {showReplyBar && replyingTo && (
          <View style={composerStyles.replyingToBar}>
            <View style={composerStyles.replyingToContent}>
              <Ionicons name="chevron-forward" size={14} color={theme.accent} />
              <Text style={composerStyles.replyingToText} numberOfLines={1}>
                Replying to <Text style={composerStyles.replyingToName}>{replyingTo.name}</Text>
                {" · "}
                <Text style={composerStyles.replyingToSnippet} numberOfLines={1}>
                  {replyingTo.text.length > 40 ? replyingTo.text.slice(0, 40) + "…" : replyingTo.text}
                </Text>
              </Text>
            </View>
            {onCancelReply && (
              <TouchableOpacity onPress={onCancelReply} style={composerStyles.cancelReplyBtn}>
                <Ionicons name="close" size={16} color={theme.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        )}

        {selectedGif && (
  <View style={composerStyles.gifPreviewCompact}>
    <Image 
      source={{ uri: selectedGif }} 
      style={composerStyles.gifImageCompact} 
      contentFit="cover"
    />
    <TouchableOpacity 
      style={composerStyles.removeGifBtn} 
      onPress={() => setSelectedGif(null)}
    >
      <Ionicons name="close-circle" size={16} color={theme.accent} />
    </TouchableOpacity>
  </View>
)}

          <View style={composerStyles.expandedInputContainer}>
            {/* Extra tools stay available above the compact message bar. */}
            {optionsExpanded && <View style={composerStyles.toolsPanel}>
            <View style={composerStyles.toolsHeading}>
              <Text style={composerStyles.toolsTitle}>Options</Text>
              <TouchableOpacity onPress={() => setOptionsExpanded(false)} style={composerStyles.barIconButton}
                accessibilityRole="button" accessibilityLabel="Close composer options">
                <Ionicons name="chevron-down" size={20} color={theme.primary} />
              </TouchableOpacity>
            </View>
            <View style={composerStyles.optionsRow}>
              <TouchableOpacity style={composerStyles.optionBtn} onPress={openTagModal} accessibilityRole="button" accessibilityLabel="Tag people">
                <Ionicons name="people-outline" size={20} color={theme.primary} />
                <Text style={composerStyles.optionLabel}>Tag people</Text>
              </TouchableOpacity>
              <TouchableOpacity style={composerStyles.optionBtn} onPress={() => setShowLinkModal(true)} accessibilityRole="button" accessibilityLabel="Attach a link">
                <Ionicons name="link-outline" size={20} color={theme.primary} />
                <Text style={composerStyles.optionLabel}>Link</Text>
              </TouchableOpacity>
              <TouchableOpacity style={composerStyles.optionBtn} onPress={() => setShowGifModal(true)} accessibilityRole="button" accessibilityLabel="Choose a GIF">
                <Text style={composerStyles.gifToolLabel}>GIF</Text>
                <Text style={composerStyles.optionLabel}>GIFs</Text>
              </TouchableOpacity>
              {onCreatePoll && (
                <TouchableOpacity
                  style={composerStyles.optionBtn}
                  onPress={() => {
                    setOptionsExpanded(false);
                    onCreatePoll();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Create a poll"
                >
                  <Ionicons name="stats-chart-outline" size={20} color={theme.primary} />
                  <Text style={composerStyles.optionLabel}>Poll</Text>
                </TouchableOpacity>
              )}
            </View>
              {!staffOnly && (
              <TouchableOpacity
                style={[composerStyles.anonymousBtn, isAnonymous && composerStyles.anonymousBtnActive]}
                onPress={() => setIsAnonymous(!isAnonymous)}
                accessibilityRole="switch" accessibilityState={{ checked: isAnonymous }} accessibilityLabel="Post anonymously"
              >
                <View style={composerStyles.userAvatarSmall}>
                  {isAnonymous ? <Ionicons name="eye-off-outline" size={18} color={theme.primary} />
                    : resolveAvatarUri(currentUser) ? <Image source={{ uri: avatarThumb(resolveAvatarUri(currentUser), AVATAR_SIZE_SMALL) }} style={composerStyles.avatarImage} />
                    : <Text style={composerStyles.avatarTextSmall}>{currentUser?.firstname?.[0]?.toUpperCase() || "U"}</Text>}
                </View>
                <Text style={composerStyles.anonymousBtnText}>
                  {isAnonymous ? "Anonymous" : "Public"}
                </Text>
                <Text style={composerStyles.modeHint}>Tap to switch</Text>
                <Ionicons name="swap-horizontal-outline" size={18} color={theme.primary} />
              </TouchableOpacity>
              )}
            </View>}

            {/* File previews */}
            {files.length > 0 && (
              <View style={composerStyles.filesPreviewRow}>
                {files.map((f, i) => {
                  const fileDetails = getFileIconDetails(f.mimeType, f.name);
                  return (
                    <View key={i} style={composerStyles.filePreviewItem}>
                      {f.mimeType.startsWith("image/") ? (
                        <Image source={{ uri: f.uri }} style={composerStyles.previewImage} />
                      ) : (
                        <View style={composerStyles.previewDoc}>
                          <Ionicons name={fileDetails.icon} size={14} color={fileDetails.color} />
                          <Text style={composerStyles.previewDocName} numberOfLines={1}>
                            {f.name.length > 8 ? f.name.substring(0, 8) + "…" : f.name}
                          </Text>
                        </View>
                      )}
                      <TouchableOpacity
                        style={composerStyles.removeFileBtn}
                        onPress={() => setFiles(files.filter((_, idx) => idx !== i))}
                      >
                        <Ionicons name="close-circle" size={14} color={theme.accent} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
                <Text style={composerStyles.fileLimitText}>{files.length}/{maxFiles}</Text>
              </View>
            )}

            {attachedLink && (
              <View style={composerStyles.linkPreviewRow}>
                <Ionicons name="link" size={12} color="#4f9cff" />
                <View style={composerStyles.linkPreviewCopy}>
                  {!!attachedLink.title && (
                    <Text style={composerStyles.linkPreviewTitle} numberOfLines={1}>{attachedLink.title}</Text>
                  )}
                  <Text style={composerStyles.linkPreviewText} numberOfLines={2}>{attachedLink.url}</Text>
                </View>
                <TouchableOpacity onPress={() => setAttachedLink(null)}>
                  <Ionicons name="close-circle" size={14} color={theme.accent} />
                </TouchableOpacity>
              </View>
            )}

            {effectiveTaggedUsers.length > 0 && (
              <View style={composerStyles.taggedPreviewRow}>
                <Ionicons name="people" size={11} color={theme.accent} />
                <Text style={composerStyles.taggedPreviewText}>
                  {effectiveTaggedUsers.length} tagged
                  {effectiveTaggedUsers.some((taggedUser) => isAiAssistantId(taggedUser.id))
                    ? `, including ${AI_ASSISTANT_NAME}`
                    : effectiveTaggedUsers.some((taggedUser) => isEveryoneMentionId(taggedUser.id))
                      ? `, including ${EVERYONE_MENTION_NAME}`
                    : ""}
                </Text>
              </View>
            )}

            {mentionSuggestions.length > 0 && (
              <View style={composerStyles.mentionSheet}>
                <Text style={composerStyles.mentionSheetLabel}>Mention someone</Text>
                {mentionSuggestions.slice(0, 5).map((person) => (
                  <TouchableOpacity
                    key={person.id}
                    style={composerStyles.mentionRow}
                    onPress={() => handleSelectMention(person)}
                  >
                    <View
                      style={[
                        composerStyles.mentionAvatar,
                        isAiAssistantId(person.id) && composerStyles.aiAvatar,
                      ]}
                    >
                      <Text style={composerStyles.mentionAvatarText}>
                        {isAiAssistantId(person.id)
                          ? "AI"
                          : `${person.firstname.charAt(0)}${person.lastname.charAt(0)}`}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={composerStyles.mentionName}>{person.label}</Text>
                      <Text style={composerStyles.mentionMeta}>
                        {person.mentionToken} {isAiAssistantId(person.id) ? "assistant" : `• ${person.studentID}`}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Input row */}
            {isAnonymous && !staffOnly && !optionsExpanded && <TouchableOpacity style={composerStyles.anonymousIndicator}
              onPress={() => setOptionsExpanded(true)} accessibilityLabel="Posting anonymously. Open options to change">
              <Ionicons name="eye-off-outline" size={14} color={theme.primary} />
              <Text style={composerStyles.anonymousIndicatorText}>Anonymous</Text>
            </TouchableOpacity>}
            <View style={composerStyles.inputRow}>
              <TouchableOpacity style={composerStyles.barIconButton} onPress={pickPhotos} disabled={files.length >= maxFiles}
                accessibilityRole="button" accessibilityLabel="Attach photos">
                <Ionicons name="image-outline" size={23} color={files.length >= maxFiles ? theme.textMuted : theme.primary} />
              </TouchableOpacity>
              <TouchableOpacity style={composerStyles.barIconButton} onPress={pickDocuments} disabled={files.length >= maxFiles}
                accessibilityRole="button" accessibilityLabel="Attach files">
                <Ionicons name="attach-outline" size={24} color={files.length >= maxFiles ? theme.textMuted : theme.primary} />
              </TouchableOpacity>
              <View style={composerStyles.inputPill}>
              <TextInput
                ref={textInputRef}
                placeholder={placeholder}
                placeholderTextColor={theme.textMuted}
                style={composerStyles.input}
                value={draftText}
                onChangeText={handleChangeText}
                onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
                multiline
                maxLength={MAX_CHARACTERS}
                autoFocus={!!replyingTo}
              />
              <TouchableOpacity style={composerStyles.moreButton} onPress={() => setOptionsExpanded(!optionsExpanded)}
                accessibilityRole="button" accessibilityLabel={optionsExpanded ? "Close composer options" : "More options: GIFs, links, tags and anonymous mode"}
                accessibilityState={{ expanded: optionsExpanded }}>
                <Ionicons name={optionsExpanded ? "close-circle-outline" : "ellipsis-horizontal-circle-outline"} size={25} color={theme.primary} />
              </TouchableOpacity>
              </View>
              <TouchableOpacity
                onPress={handleSend}
                accessibilityRole="button" accessibilityLabel={uploading ? labels.sending : labels.send}
                accessibilityState={{ busy: uploading, disabled: (!draftText.trim() && files.length === 0 && !attachedLink && !selectedGif) || uploading }}
                disabled={(!draftText.trim() && files.length === 0 && !attachedLink && !selectedGif) || uploading}
                style={[
                  composerStyles.sendButton,
                  (!draftText.trim() && files.length === 0 && !attachedLink && !selectedGif) && composerStyles.sendButtonDisabled,
                ]}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color={theme.onPrimary} />
                ) : (
                  <Ionicons
                    name="arrow-up"
                    size={21}
                    color={(draftText.trim() || files.length > 0 || attachedLink || selectedGif) ? theme.onPrimary : theme.textMuted}
                  />
                )}
              </TouchableOpacity>
            </View>

            {isNearLimit && (
              <Text
                style={[
                  composerStyles.charCountText,
                  remainingChars < 50 && composerStyles.charCountTextWarning,
                ]}
              >
                {remainingChars} left
              </Text>
            )}
          </View>
      </View>

      {/* Tag Modal */}
      <Modal visible={showTagModal} animationType="slide" transparent onRequestClose={cancelTagSelection}>
        <View style={composerStyles.modalOverlay}>
          <View style={composerStyles.tagModalContainer}>
            <View style={composerStyles.modalHeader}>
              <Text style={composerStyles.modalTitle}>
                Tag People {draftTaggedUsers.length > 0 && `(${draftTaggedUsers.length})`}
              </Text>
              <View style={composerStyles.tagModalActions}>
                <TouchableOpacity
                  style={composerStyles.tagConfirmButton}
                  onPress={confirmTagSelection}
                  accessibilityRole="button"
                  accessibilityLabel={`Confirm ${draftTaggedUsers.length} selected tags`}
                >
                  <Text style={composerStyles.tagConfirmText}>
                    Confirm{draftTaggedUsers.length > 0 ? ` (${draftTaggedUsers.length})` : ""}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={cancelTagSelection} accessibilityRole="button" accessibilityLabel="Cancel tag selection">
                  <Ionicons name="close" size={24} color={theme.textMuted} />
                </TouchableOpacity>
              </View>
            </View>

            {students.length > 0 && (
              <TouchableOpacity
                style={composerStyles.tagAllButton}
                onPress={() => {
                  const allTagged = students.filter((s) => !draftTaggedUsers.find((u) => u.id === s.id));
                  if (allTagged.length === 0) { showInfo("Info", "Everyone is already tagged!"); return; }
                  setDraftTaggedUsers([...draftTaggedUsers, ...allTagged]);
                }}
              >
                <Ionicons name="people-circle" size={18} color={theme.onAccent} />
                <Text style={composerStyles.tagAllText}>Tag All</Text>
              </TouchableOpacity>
            )}

            <TextInput
              placeholder="Search people or AI..."
              placeholderTextColor={theme.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              style={composerStyles.searchInput}
            />

            <FlatList
              initialNumToRender={10}
              maxToRenderPerBatch={10}
              windowSize={7}
              data={filteredTagOptions}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => {
                const tagged = draftTaggedUsers.find((u) => u.id === item.id);
                const isAiAssistant = isAiAssistantId(item.id);
                return (
                  <TouchableOpacity style={composerStyles.studentItem} onPress={() => handleTagUser(item)}>
                    <View
                      style={[
                        composerStyles.studentAvatar,
                        isAiAssistant && composerStyles.aiAvatar,
                      ]}
                    >
                      <Text style={composerStyles.studentAvatarText}>
                        {isAiAssistant
                          ? "AI"
                          : `${item.firstname.charAt(0)}${item.lastname.charAt(0)}`}
                      </Text>
                    </View>
                    <View style={composerStyles.studentInfo}>
                      <Text style={composerStyles.studentName}>{item.firstname} {item.lastname}</Text>
                      <Text style={composerStyles.studentMetaText}>
                        {isAiAssistant ? "Assistant bot" : item.studentID}
                      </Text>
                    </View>
                    {tagged && <Ionicons name="checkmark-circle" size={18} color={theme.accent} />}
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={composerStyles.emptyText}>
                  {searchQuery ? "No matches found" : "No people available"}
                </Text>
              }
            />
          </View>
        </View>
      </Modal>

      {/* Link Modal */}
      <Modal visible={showLinkModal} animationType="fade" transparent onRequestClose={() => setShowLinkModal(false)}>
        <KeyboardAvoidingView
          automaticOffset
          style={composerStyles.linkModalKeyboard}
          behavior="padding"
          enabled={Platform.OS !== "web"}
        >
          <View style={composerStyles.linkModalOverlay}>
            <KeyboardAwareScrollView
              style={composerStyles.linkModalScroll}
              contentContainerStyle={composerStyles.linkModalScrollContent}
              bottomOffset={24}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
            <View style={composerStyles.linkModalContent}>
            <Text style={composerStyles.linkModalTitle}>Add Link</Text>
            <TextInput
              placeholder="https://example.com"
              placeholderTextColor={theme.textMuted}
              value={linkUrl}
              onChangeText={setLinkUrl}
              style={composerStyles.linkInput}
              autoCapitalize="none"
              keyboardType="url"
              autoCorrect={false}
              autoFocus
            />
            <TextInput
              placeholder="Link title (optional)"
              placeholderTextColor={theme.textMuted}
              value={linkTitle}
              onChangeText={setLinkTitle}
              style={composerStyles.linkInput}
            />
            <View style={composerStyles.linkModalButtons}>
              <TouchableOpacity
                style={[composerStyles.linkModalButton, { backgroundColor: theme.surface }]}
                onPress={() => { setShowLinkModal(false); setLinkUrl(""); setLinkTitle(""); }}
              >
                <Text
                  style={[composerStyles.linkModalButtonText, { color: theme.primary }]}
                >
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[composerStyles.linkModalButton, { backgroundColor: theme.accent }]}
                onPress={handleAddLink}
              >
                <Text style={composerStyles.linkModalButtonText}>Add Link</Text>
              </TouchableOpacity>
            </View>
            </View>
            </KeyboardAwareScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* GIF picker — drag its top down to close. */}
      <DragToCloseSheet
        visible={showGifModal}
        onClose={closeGifPicker}
        handleColor={theme.textMuted}
        backdropColor="rgba(0,0,0,0.75)"
        closeLabel="Close GIF picker"
        sheetStyle={composerStyles.tagModalContainer}
        header={
          <View style={composerStyles.modalHeader}>
            <Text style={composerStyles.modalTitle}>Choose a GIF</Text>
            <TouchableOpacity onPress={closeGifPicker} accessibilityRole="button" accessibilityLabel="Close GIF picker">
              <Ionicons name="close" size={24} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
        }
      >

        <View style={composerStyles.gifSearchContainer}>
          <TextInput
            placeholder="Search GIFs..."
            placeholderTextColor={theme.textMuted}
            value={gifSearchQuery}
            onChangeText={setGifSearchQuery}
            onSubmitEditing={() => searchGifs(gifSearchQuery)}
            style={composerStyles.searchInput}
            returnKeyType="search"
          />
          <TouchableOpacity style={composerStyles.gifSearchButton} onPress={() => searchGifs(gifSearchQuery)}>
            <Ionicons name="search" size={18} color={theme.onAccent} />
          </TouchableOpacity>
        </View>

        {loadingGifs ? (
          <View style={composerStyles.gifLoadingContainer}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={composerStyles.gifLoadingText}>Searching GIFs...</Text>
          </View>
        ) : gifError ? (
          <View style={composerStyles.gifErrorContainer}>
            <Ionicons name="cloud-offline-outline" size={40} color={theme.accent} />
            <Text style={composerStyles.gifErrorTitle}>Connection Error</Text>
            <Text style={composerStyles.gifErrorText}>{gifError}</Text>
            <TouchableOpacity style={composerStyles.gifRetryButton} onPress={() => searchGifs(gifSearchQuery)}>
              <Ionicons name="refresh" size={18} color={theme.onPrimary} />
              <Text style={composerStyles.gifRetryText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        ) : gifResults.length > 0 ? (
          <FlatList
initialNumToRender={8}
maxToRenderPerBatch={8}
windowSize={5}
data={gifResults}
numColumns={2}
keyExtractor={(item) => item.id}
renderItem={({ item }) => {
// Extract full GIF and small thumbnail preview
const gifUrl = item.images?.original?.url;
const thumbnailUrl = item.images?.fixed_height_small?.url || item.images?.fixed_width?.url;

if (!gifUrl || !thumbnailUrl) return null;

return (
  <TouchableOpacity
    style={composerStyles.gifItem}
    onPress={() => handleSelectGif(gifUrl)}
  >
    <Image
      source={{ uri: thumbnailUrl }}
      style={composerStyles.gifThumbnail}
      contentFit="cover"
    />
  </TouchableOpacity>
);
}}
contentContainerStyle={composerStyles.gifGrid}
/>
        ) : (
          <View style={composerStyles.gifEmptyContainer}>
            <Ionicons name="images-outline" size={40} color={theme.border} />
            <Text style={composerStyles.emptyText}>
              {gifSearchQuery ? "No GIFs found" : "Search for GIFs to get started"}
            </Text>
          </View>
        )}
      </DragToCloseSheet>

      <ConfirmDialog
        visible={!!infoDialog}
        title={infoDialog?.title ?? ""}
        description={infoDialog?.description}
        singleAction
        confirmText="OK"
        destructive
        onConfirm={() => setInfoDialog(null)}
        onCancel={() => setInfoDialog(null)}
      />
    </>
  );
};

/** Themed stylesheet for this component. */
const useStyles = () => {
  const theme = useThemeColors();
  const composerStyles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ composerStyles, theme }), [composerStyles, theme]);
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  inputWrapper: {
    backgroundColor: c.surface,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
  },

  replyingToBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: c.surfaceSunken,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
    marginBottom: 8,
    marginHorizontal: 8,
    borderLeftWidth: 3,
    borderLeftColor: c.primary,
  },
  replyingToContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flex: 1,
  },
  replyingToText: {
    color: c.textMuted,
    fontSize: 11,
    flex: 1,
  },
  replyingToName: {
    color: c.primary,
    fontWeight: "600",
  },
  replyingToSnippet: {
    color: c.textMuted,
    fontStyle: "italic",
  },
  cancelReplyBtn: {
    padding: 10,
    marginLeft: 6,
  },

  gifPreviewCompact: {
    position: "relative",
    marginBottom: 8,
    marginHorizontal: 8,
    width: 112,
    borderRadius: 14,
    overflow: "hidden",
  },
  gifImageCompact: {
    width: "100%",
    height: 90,
    borderRadius: 14,
  },
  removeGifBtn: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 10,
    padding: 1,
  },

  simpleInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: c.surfaceRaised,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  placeholderText: {
    flex: 1,
    color: c.textMuted,
    fontSize: 14,
  },

  expandedInputContainer: {
    backgroundColor: c.surface,
  },
  toolsPanel: { backgroundColor: c.surfaceSunken, borderRadius: 18, padding: 10, marginHorizontal: 8, marginBottom: 10 },
  toolsHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 6 },
  toolsTitle: { color: c.textSecondary, fontSize: 13, fontWeight: "600" },
  optionLabel: { color: c.textSecondary, fontSize: 11, fontWeight: "500", textAlign: "center" },
  gifToolLabel: { color: c.primary, fontSize: 15, lineHeight: 20, fontWeight: "800" },
  anonymousBtnActive: { backgroundColor: c.surfaceSunken, borderColor: c.borderStrong },
  modeHint: { flex: 1, color: c.textMuted, fontSize: 11, textAlign: "right" },
  anonymousIndicator: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 5, paddingHorizontal: 10, paddingVertical: 5, marginLeft: 8, marginBottom: 4, borderRadius: 12, backgroundColor: c.surfaceSunken },
  anonymousIndicatorText: { color: c.primary, fontSize: 11, fontWeight: "600" },
  barIconButton: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  inputPill: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-end", backgroundColor: c.surfaceSunken, borderRadius: 24, paddingLeft: 14 },
  moreButton: { width: 40, height: 46, alignItems: "center", justifyContent: "center" },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  optionBtn: {
    flex: 1,
    minHeight: 52,
    paddingVertical: 8,
    paddingHorizontal: 2,
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 13,
    backgroundColor: c.surface,
  },
  optionBadge: {
    position: "absolute",
    top: -1,
    right: -1,
    backgroundColor: c.accent,
    borderRadius: 6,
    minWidth: 11,
    height: 11,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 1,
  },
  optionBadgeText: {
    color: c.onAccent,
    fontSize: 7,
    fontWeight: "bold",
  },
  anonymousBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 44,
    backgroundColor: c.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
  },
  anonymousBtnText: {
    color: c.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  collapseBtn: {
    padding: 3,
  },

  filesPreviewRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 8,
    flexWrap: "wrap",
    alignItems: "center",
  },
  filePreviewItem: {
    width: 56,
    height: 56,
    borderRadius: 12,
    overflow: "hidden",
    position: "relative",
  },
  previewImage: {
    width: "100%",
    height: "100%",
  },
  previewDoc: {
    width: "100%",
    height: "100%",
    backgroundColor: c.surface,
    justifyContent: "center",
    alignItems: "center",
  },
  previewDocName: {
    color: c.textMuted,
    fontSize: 9,
    marginTop: 1,
  },
  removeFileBtn: {
    position: "absolute",
    top: 1,
    right: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 7,
    padding: 1,
  },
  fileLimitText: {
    color: c.textMuted,
    fontSize: 10,
  },

  linkPreviewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: c.surfaceSunken,
    padding: 10,
    borderRadius: 12,
    marginBottom: 8,
    marginHorizontal: 8,
  },
  linkPreviewText: {
    color: c.primary,
    fontSize: 12,
  },
  linkPreviewCopy: { flex: 1, minWidth: 0 },
  linkPreviewTitle: { color: c.textPrimary, fontSize: 12, fontWeight: "700", marginBottom: 2 },
  taggedPreviewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  taggedPreviewText: {
    color: c.textSecondary,
    fontSize: 11,
    fontWeight: "500",
  },
  mentionSheet: {
    marginTop: 8,
    marginBottom: 8,
    marginHorizontal: 8,
    borderRadius: 14,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.borderStrong,
    overflow: "hidden",
  },
  mentionSheetLabel: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
    textTransform: "uppercase",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
  },
  mentionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  mentionAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
    marginRight: 10,
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
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    paddingVertical: 2,
  },
  userAvatarSmall: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: c.surface,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: c.border,
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarTextSmall: {
    color: c.textMuted,
    fontSize: 10,
    fontWeight: "700",
  },
  input: {
    flex: 1,
    minWidth: 0,
    color: c.textPrimary,
    fontSize: 15,
    minHeight: 46,
    maxHeight: 120,
    paddingTop: 12,
    paddingBottom: 12,
    paddingHorizontal: 0,
    lineHeight: 20,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.primary,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 3,
    marginLeft: 5,
  },
  sendButtonDisabled: {
    backgroundColor: c.borderStrong,
    borderColor: c.borderStrong,
    shadowOpacity: 0,
    elevation: 0,
  },
  charCountText: {
    alignSelf: "flex-end",
    color: c.textMuted,
    fontSize: 10,
    fontWeight: "700",
    textAlign: "right",
    marginTop: 4,
    backgroundColor: c.surfaceSunken,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: "hidden",
  },
  charCountTextWarning: {
    color: c.danger,
    backgroundColor: c.dangerSoft,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "flex-end",
  },
  tagModalContainer: {
    flex: 0.8,
    backgroundColor: c.surfaceSunken,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.borderStrong,
    backgroundColor: c.surface,
  },
  modalTitle: {
    color: c.textPrimary,
    fontSize: 16,
    fontWeight: "700",
  },
  tagAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.accent,
    marginHorizontal: 16,
    marginVertical: 8,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  tagAllText: {
    color: c.onAccent,
    fontWeight: "600",
    fontSize: 13,
  },
  searchInput: {
    backgroundColor: c.surface,
    color: c.textPrimary,
    borderRadius: 8,
    padding: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    fontSize: 14,
    borderWidth: 1,
    borderColor: c.border,
  },
  studentItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    marginHorizontal: 16,
    borderBottomColor: c.surface,
    borderBottomWidth: 1,
  },
  studentAvatar: {
    backgroundColor: c.surface,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    borderWidth: 1,
    borderColor: c.border,
  },
  aiAvatar: {
    backgroundColor: "#efe3ff",
    borderColor: "#d1b2ff",
  },
  studentAvatarText: {
    color: c.primary,
    fontWeight: "bold",
    fontSize: 13,
  },
  studentInfo: { flex: 1 },
  studentName: {
    color: c.textPrimary,
    fontSize: 14,
    fontWeight: "500",
  },
  studentMetaText: {
    color: c.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  emptyText: {
    color: c.textMuted,
    fontSize: 13,
    textAlign: "center",
    marginTop: 20,
  },

  linkModalKeyboard: { flex: 1 },
  linkModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.8)",
  },
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
  linkModalScroll: { flex: 1 },
  linkModalScrollContent: {
    flexGrow: 1,
    justifyContent: "flex-start",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: Platform.OS === "android" ? 64 : 34,
    paddingBottom: 24,
  },
  linkModalContent: {
    width: "100%",
    maxWidth: 390,
    backgroundColor: c.surfaceSunken,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  linkModalTitle: {
    color: c.textPrimary,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 16,
    textAlign: "center",
  },
  linkInput: {
    backgroundColor: c.surface,
    color: c.textPrimary,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: c.border,
    fontSize: 14,
  },
  linkModalButtons: {
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
  },
  linkModalButton: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  linkModalButtonText: {
    color: c.onAccent,
    fontSize: 14,
    fontWeight: "600",
  },

  gifSearchContainer: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    gap: 8,
    marginBottom: 8,
  },
  gifSearchButton: {
    backgroundColor: c.accent,
    padding: 10,
    borderRadius: 8,
  },
  gifLoadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 32,
  },
  gifLoadingText: {
    color: c.textMuted,
    fontSize: 13,
    marginTop: 10,
  },
  gifErrorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 32,
    paddingHorizontal: 20,
  },
  gifErrorTitle: {
    color: c.accent,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 6,
  },
  gifErrorText: {
    color: c.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 16,
    marginBottom: 16,
  },
  gifRetryButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  gifRetryText: {
    color: c.onPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  gifGrid: { padding: 6 },
  gifItem: {
    flex: 1,
    margin: 3,
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
});

export default ComposerBase;

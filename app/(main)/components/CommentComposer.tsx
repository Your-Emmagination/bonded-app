// components/CommentComposer.tsx
import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  FlatList,
  Image,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import {
  collection,
  getDocs,
} from "firebase/firestore";
import { db, auth } from "../../../Firebase_configure";
import {
  uploadPostImage,
  uploadPostFile,
  uploadPostGif,
} from "@/utils/cloudinaryUpload";
import {
  AI_ASSISTANT_NAME,
  AI_ASSISTANT_TAG,
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
import { resolveAvatarUri } from "@/utils/avatar";

const MAX_FILES = 10;
const MAX_CHARACTERS = 1250;

type PartialComment = {
  text: string;
  userId: string;
  realUserId?: string;
  username?: string;
  role?: string;
  likes?: string[];
  profilePic?: string | null;
  profileImage?: string | null;
  isAnonymous?: boolean;
  replyCount?: number;
  files?: { url: string; mimeType: string; name?: string }[];
  link?: { url: string; title: string };
  taggedUsers?: { id: string; name: string; studentID: string }[];
};

interface Student {
  id: string;
  firstname: string;
  lastname: string;
  email: string;
  studentID: string;
}

type MentionDraft = Student & {
  mentionToken: string;
  label: string;
};

interface CommentComposerProps {
  onSend?: (commentData: PartialComment) => Promise<void>;
  currentUser: any;
  maxFiles?: number;
  placeholder?: string;
  replyingTo?: { id: string; name: string; text: string } | null;
  onCancelReply?: () => void;
  autoExpand?: boolean;
}

let cachedStudents: Student[] | null = null;
let studentsRequest: Promise<Student[]> | null = null;

const CommentComposer: React.FC<CommentComposerProps> = ({
  onSend,
  currentUser,
  maxFiles = MAX_FILES,
  placeholder = "Write a comment...",
  replyingTo = null,
  onCancelReply,
  autoExpand = false,
}) => {
  const [commentText, setCommentText] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [isExpanded, setIsExpanded] = useState(autoExpand || !!replyingTo);
  const [uploading, setUploading] = useState(false);
  const [files, setFiles] = useState<{ uri: string; mimeType: string; name: string }[]>([]);
  const [attachedLink, setAttachedLink] = useState<{ url: string; title: string } | null>(null);
  const [taggedUsers, setTaggedUsers] = useState<Student[]>([]);
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
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const textInputRef = useRef<TextInput>(null);

  useEffect(() => {
    fetchStudents().then(setStudents).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (replyingTo) {
      setIsExpanded(true);
      textInputRef.current?.focus();
    }
  }, [replyingTo]);

  useEffect(() => {
    if (autoExpand) {
      setIsExpanded(true);
    }
  }, [autoExpand]);

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
        .map((doc) => {
          const data = doc.data();
          if (!data.firstname || !data.lastname || !data.studentID) return null;
          return {
            id: doc.id,
            firstname: String(data.firstname || "").trim(),
            lastname: String(data.lastname || "").trim(),
            email: String(data.email || ""),
            studentID: String(data.studentID || ""),
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

  const pickFiles = async () => {
    try {
      if (files.length >= maxFiles) {
        Alert.alert("Maximum Files Reached", `You can only attach up to ${maxFiles} files per comment.`);
        return;
      }

      const result = await DocumentPicker.getDocumentAsync({
        type: ["image/*", "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets?.length > 0) {
        const remainingSlots = maxFiles - files.length;
        const filesToAdd = result.assets.slice(0, remainingSlots);

        if (result.assets.length > remainingSlots) {
          Alert.alert("File Limit", `Only ${remainingSlots} more file(s) can be added. Maximum is ${maxFiles} files per comment.`);
        }

        const newFiles = filesToAdd.map((picked) => ({
          uri: picked.uri || "",
          mimeType: picked.mimeType ?? "application/octet-stream",
          name: picked.name ?? `file_${Date.now()}`,
        }));
        setFiles([...files, ...newFiles]);
      }
    } catch (error) {
      console.error("Error picking files:", error);
    }
  };

  const handleAddLink = () => {
    if (!linkUrl.trim()) {
      Alert.alert("Error", "Please enter a valid URL");
      return;
    }

    const urlPattern = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/;
    if (!urlPattern.test(linkUrl)) {
      Alert.alert("Invalid URL", "Please enter a valid website URL");
      return;
    }

    let formattedUrl = linkUrl.trim();
    if (!formattedUrl.startsWith("http://") && !formattedUrl.startsWith("https://")) {
      formattedUrl = "https://" + formattedUrl;
    }

    setAttachedLink({ url: formattedUrl, title: linkTitle.trim() || formattedUrl });
    setShowLinkModal(false);
    setLinkUrl("");
    setLinkTitle("");
  };

  const handleTagUser = (student: Student) => {
    if (taggedUsers.find((u) => u.id === student.id)) {
      setTaggedUsers(taggedUsers.filter((u) => u.id !== student.id));
    } else {
      setTaggedUsers([...taggedUsers, student]);
    }
  };

  const allMentionables: MentionDraft[] = [
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
  ];

  const activeMentionMatch = commentText
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

  const syncTaggedUsersFromText = (nextText: string) => {
    setTaggedUsers((current) =>
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
    setCommentText(nextText);
    syncTaggedUsersFromText(nextText);
  };

  const handleSelectMention = (person: MentionDraft) => {
    if (activeMentionIndex < 0) return;
    const before = commentText.slice(0, activeMentionIndex);
    const after = commentText.slice(selection.start);
    const insertedText = `${person.mentionToken} `;
    const nextText = `${before}${insertedText}${after}`;
    setCommentText(nextText);
    setTaggedUsers((current) => {
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

  const handleSendComment = async () => {
    if (!commentText.trim() && files.length === 0 && !attachedLink && !selectedGif) return;
    if (!currentUser || !onSend) return;


    setUploading(true);
    try {
      const uploadedUrls = [];

      for (const file of files) {
        let uploadedUrl: string;
        if (file.mimeType.startsWith("image/")) {
          uploadedUrl = await uploadPostImage(file.uri);
        } else {
          uploadedUrl = await uploadPostFile(file.uri);
        }
        uploadedUrls.push({ url: uploadedUrl, mimeType: file.mimeType, name: file.name });
      }

      if (selectedGif) {
        const uploadedGifUrl = await uploadPostGif(selectedGif);
        uploadedUrls.push({ url: uploadedGifUrl, mimeType: "image/gif", name: "animated.gif" });
      }

      const nextTaggedUsers = hasAiAssistantMention(commentText)
        ? taggedUsers.some((taggedUser) => isAiAssistantId(taggedUser.id))
          ? taggedUsers
          : [...taggedUsers, AI_ASSISTANT_STUDENT]
        : taggedUsers;
      const normalizedTaggedUsers = hasEveryoneMention(commentText)
        ? nextTaggedUsers.some((taggedUser) => isEveryoneMentionId(taggedUser.id))
          ? nextTaggedUsers
          : [...nextTaggedUsers, EVERYONE_MENTION_STUDENT]
        : nextTaggedUsers.filter((taggedUser) => !isEveryoneMentionId(taggedUser.id));

      const uniqueTaggedUsers = normalizedTaggedUsers.filter(
        (user, index, self) => index === self.findIndex((u) => u.id === user.id)
      );

      const commentData: PartialComment = {
        text: commentText.trim(),
        userId: isAnonymous ? "anonymous" : currentUser.uid,
        realUserId: currentUser.uid,
        username: isAnonymous
          ? "Anonymous"
          : `${currentUser.firstname || ""} ${currentUser.lastname || ""}`.trim() || "Anonymous",
        role: currentUser.role || "student",
        likes: [],
        profilePic: isAnonymous ? null : resolveAvatarUri(currentUser),
        profileImage: isAnonymous ? null : resolveAvatarUri(currentUser),
        isAnonymous: isAnonymous,
        replyCount: 0,
        files: uploadedUrls,
        taggedUsers: uniqueTaggedUsers.map((u) => ({
          id: u.id,
          name: isAiAssistantId(u.id)
            ? AI_ASSISTANT_TAG.name
            : isEveryoneMentionId(u.id)
              ? EVERYONE_MENTION_TAG.name
            : `${u.firstname} ${u.lastname}`,
          studentID: u.studentID,
        })),
      };

      if (attachedLink) {
        commentData.link = attachedLink;
      }

      await onSend(commentData);

      setCommentText("");
      setFiles([]);
      setTaggedUsers([]);
      setAttachedLink(null);
      setSelectedGif(null);
      setIsAnonymous(false);
      setSelection({ start: 0, end: 0 });

      textInputRef.current?.focus();

    } catch (error: any) {
      console.error("Comment error:", error);

      const errorMessage = error?.message?.toLowerCase() || "";
      if (
        errorMessage.includes("network") ||
        errorMessage.includes("connection") ||
        errorMessage.includes("timeout") ||
        error?.code === "unavailable" ||
        error?.code === "ECONNREFUSED"
      ) {
        Alert.alert("Connection Error", "Unable to post comment. Please check your internet connection and try again.", [{ text: "OK" }]);
      } else {
        Alert.alert("Error", "Failed to post comment. Please try again.");
      }
    } finally {
      setUploading(false);
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
      const API_KEY = "AIzaSyCFwGab5AO3lSHEBTxTDIVgOwFt4YvCWEI";
      const limit = 20;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(
        `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${API_KEY}&limit=${limit}&media_filter=gif`,
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) throw new Error("Failed to fetch GIFs");

      const data = await response.json();

      if (data.results && data.results.length > 0) {
        setGifResults(data.results);
        setGifError(null);
      } else {
        setGifResults([]);
        setGifError("No GIFs found for this search");
      }
    } catch (error: any) {
      console.error("Error searching GIFs:", error);

      if (error.name === "AbortError") {
        setGifError("Connection timeout. Please check your internet and try again.");
      } else if (error.message?.includes("network") || error.message?.includes("Failed to fetch")) {
        setGifError("No internet connection. Please check your network and try again.");
      } else {
        setGifError("Unable to load GIFs. Please try again later.");
      }

      setGifResults([]);
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

  const filteredStudents = students.filter((s) => {
    const firstname = (s.firstname || "").toLowerCase();
    const lastname = (s.lastname || "").toLowerCase();
    const studentID = (s.studentID || "").toLowerCase();
    const search = searchQuery.toLowerCase();
    return firstname.includes(search) || lastname.includes(search) || studentID.includes(search);
  });
  const aiLabel = `${AI_ASSISTANT_STUDENT.firstname} ${AI_ASSISTANT_STUDENT.lastname}`.toLowerCase();
  const aiMatchesSearch =
    !searchQuery.trim() ||
    aiLabel.includes(searchQuery.toLowerCase()) ||
    AI_ASSISTANT_STUDENT.studentID.toLowerCase().includes(searchQuery.toLowerCase()) ||
    "assistant".includes(searchQuery.toLowerCase());
  const everyoneMatchesSearch =
    !searchQuery.trim() ||
    EVERYONE_MENTION_NAME.toLowerCase().includes(searchQuery.toLowerCase()) ||
    EVERYONE_MENTION_TOKEN.slice(1).includes(searchQuery.toLowerCase()) ||
    "all".includes(searchQuery.toLowerCase());
  const filteredTagOptions = [
    ...(aiMatchesSearch ? [AI_ASSISTANT_STUDENT] : []),
    ...(everyoneMatchesSearch ? [EVERYONE_MENTION_STUDENT] : []),
    ...filteredStudents.filter(
      (student) => !isAiAssistantId(student.id) && !isEveryoneMentionId(student.id),
    ),
  ];
  const autoTaggedUsers = hasAiAssistantMention(commentText)
    ? taggedUsers.some((entry) => isAiAssistantId(entry.id))
      ? taggedUsers
      : [...taggedUsers, AI_ASSISTANT_STUDENT]
    : taggedUsers;
  const effectiveTaggedUsers = hasEveryoneMention(commentText)
    ? autoTaggedUsers.some((entry) => isEveryoneMentionId(entry.id))
      ? autoTaggedUsers
      : [...autoTaggedUsers, EVERYONE_MENTION_STUDENT]
    : autoTaggedUsers.filter((entry) => !isEveryoneMentionId(entry.id));

  const remainingChars = MAX_CHARACTERS - commentText.length;
  const isNearLimit = remainingChars < 100;

  return (
    <>
      <View style={composerStyles.inputWrapper}>
        {/* Replying To Bar */}
        {replyingTo && (
          <View style={composerStyles.replyingToBar}>
            <View style={composerStyles.replyingToContent}>
              <Ionicons name="chevron-forward" size={14} color="#e0a53d" />
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
                <Ionicons name="close" size={16} color="#9b766c" />
              </TouchableOpacity>
            )}
          </View>
        )}

        {selectedGif && (
          <View style={composerStyles.gifPreviewCompact}>
            <Image source={{ uri: selectedGif }} style={composerStyles.gifImageCompact} />
            <TouchableOpacity style={composerStyles.removeGifBtn} onPress={() => setSelectedGif(null)}>
              <Ionicons name="close-circle" size={16} color="#e0a53d" />
            </TouchableOpacity>
          </View>
        )}

        {!isExpanded ? (
          <TouchableOpacity
            style={composerStyles.simpleInputContainer}
            onPress={() => setIsExpanded(true)}
            activeOpacity={0.7}
          >
            <View style={composerStyles.userAvatarSmall}>
              {resolveAvatarUri(currentUser) ? (
                <Image source={{ uri: resolveAvatarUri(currentUser)! }} style={composerStyles.avatarImage} />
              ) : (
                <Text style={composerStyles.avatarTextSmall}>
                  {currentUser?.firstname?.[0]?.toUpperCase() || "U"}
                </Text>
              )}
            </View>
            <Text style={composerStyles.placeholderText}>{placeholder}</Text>
          </TouchableOpacity>
        ) : (
          <View style={composerStyles.expandedInputContainer}>
            {/* Options row */}
            <View style={composerStyles.optionsRow}>
              <TouchableOpacity
                style={composerStyles.optionBtn}
                onPress={pickFiles}
                disabled={files.length >= maxFiles}
              >
                <Ionicons name="images" size={19} color={files.length >= maxFiles ? "#f0e7e2" : "#4f9cff"} />
              </TouchableOpacity>
              <TouchableOpacity
                style={composerStyles.optionBtn}
                onPress={() => {
                  textInputRef.current?.focus();
                  const nextText =
                    commentText.length > 0 && !commentText.endsWith(" ")
                      ? `${commentText} @`
                      : `${commentText}@`;
                  handleChangeText(nextText);
                  const cursor = nextText.length;
                  setSelection({ start: cursor, end: cursor });
                }}
              >
                <Ionicons name="at" size={19} color="#a86fff" />
              </TouchableOpacity>
              <TouchableOpacity style={composerStyles.optionBtn} onPress={() => setShowLinkModal(true)}>
                <Ionicons name="link" size={19} color="#4f9cff" />
              </TouchableOpacity>
              <TouchableOpacity style={composerStyles.optionBtn} onPress={() => setShowGifModal(true)}>
                <Ionicons name="gift" size={19} color="#ff9f43" />
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                style={composerStyles.anonymousBtn}
                onPress={() => setIsAnonymous(!isAnonymous)}
              >
                <Ionicons
                  name={isAnonymous ? "eye-off" : "person"}
                  size={14}
                  color={isAnonymous ? "#e0a53d" : "#9b766c"}
                />
                <Text style={[composerStyles.anonymousBtnText, isAnonymous && { color: "#e0a53d" }]}>
                  {isAnonymous ? "Anon" : "Public"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={composerStyles.collapseBtn}
                onPress={() => { setIsExpanded(false); }}
              >
                <Ionicons name="chevron-down" size={18} color="#9b766c" />
              </TouchableOpacity>
            </View>

            {/* File previews */}
            {files.length > 0 && (
              <View style={composerStyles.filesPreviewRow}>
                {files.map((f, i) => (
                  <View key={i} style={composerStyles.filePreviewItem}>
                    {f.mimeType.startsWith("image/") ? (
                      <Image source={{ uri: f.uri }} style={composerStyles.previewImage} />
                    ) : (
                      <View style={composerStyles.previewDoc}>
                        <Ionicons name={f.mimeType.includes("pdf") ? "document-text" : "document"} size={14} color="#4f9cff" />
                        <Text style={composerStyles.previewDocName} numberOfLines={1}>
                          {f.name.length > 6 ? f.name.substring(0, 6) + "…" : f.name}
                        </Text>
                      </View>
                    )}
                    <TouchableOpacity
                      style={composerStyles.removeFileBtn}
                      onPress={() => setFiles(files.filter((_, idx) => idx !== i))}
                    >
                      <Ionicons name="close-circle" size={14} color="#e0a53d" />
                    </TouchableOpacity>
                  </View>
                ))}
                <Text style={composerStyles.fileLimitText}>{files.length}/{maxFiles}</Text>
              </View>
            )}

            {attachedLink && (
              <View style={composerStyles.linkPreviewRow}>
                <Ionicons name="link" size={12} color="#4f9cff" />
                <Text style={composerStyles.linkPreviewText} numberOfLines={1}>{attachedLink.title}</Text>
                <TouchableOpacity onPress={() => setAttachedLink(null)}>
                  <Ionicons name="close-circle" size={14} color="#e0a53d" />
                </TouchableOpacity>
              </View>
            )}

            {effectiveTaggedUsers.length > 0 && (
              <View style={composerStyles.taggedPreviewRow}>
                <Ionicons name="people" size={11} color="#e0a53d" />
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

            {/* Input row */}
            <View style={composerStyles.inputRow}>
              <View style={composerStyles.userAvatarSmall}>
                {isAnonymous ? (
                  <Ionicons name="person" size={11} color="#9b766c" />
                ) : resolveAvatarUri(currentUser) ? (
                  <Image source={{ uri: resolveAvatarUri(currentUser)! }} style={composerStyles.avatarImage} />
                ) : (
                  <Text style={composerStyles.avatarTextSmall}>
                    {currentUser?.firstname?.[0]?.toUpperCase() || "U"}
                  </Text>
                )}
              </View>
              <TextInput
                ref={textInputRef}
                placeholder={placeholder}
                placeholderTextColor="#9b766c"
                style={composerStyles.input}
                value={commentText}
                onChangeText={handleChangeText}
                onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
                multiline
                maxLength={MAX_CHARACTERS}
                autoFocus={!!replyingTo}
              />
              <TouchableOpacity
                onPress={handleSendComment}
                disabled={(!commentText.trim() && files.length === 0 && !attachedLink && !selectedGif) || uploading}
                style={[
                  composerStyles.sendButton,
                  (!commentText.trim() && files.length === 0 && !attachedLink && !selectedGif) && composerStyles.sendButtonDisabled,
                ]}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons
                    name="send"
                    size={16}
                    color={(commentText.trim() || files.length > 0 || attachedLink || selectedGif) ? "#fff" : "#9b766c"}
                  />
                )}
              </TouchableOpacity>
            </View>

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

            {isNearLimit && (
              <Text style={[composerStyles.charCountText, remainingChars < 50 && { color: "#e0a53d" }]}>
                {remainingChars} left
              </Text>
            )}
          </View>
        )}
      </View>

      {/* Tag Modal */}
      <Modal visible={showTagModal} animationType="slide" transparent onRequestClose={() => setShowTagModal(false)}>
        <View style={composerStyles.modalOverlay}>
          <View style={composerStyles.tagModalContainer}>
            <View style={composerStyles.modalHeader}>
              <Text style={composerStyles.modalTitle}>
                Tag People & AI {effectiveTaggedUsers.length > 0 && `(${effectiveTaggedUsers.length})`}
              </Text>
              <TouchableOpacity onPress={() => setShowTagModal(false)}>
                <Ionicons name="close" size={24} color="#9b766c" />
              </TouchableOpacity>
            </View>

            {students.length > 0 && (
              <TouchableOpacity
                style={composerStyles.tagAllButton}
                onPress={() => {
                  const allTagged = students.filter((s) => !taggedUsers.find((u) => u.id === s.id));
                  if (allTagged.length === 0) { Alert.alert("Info", "Everyone is already tagged!"); return; }
                  setTaggedUsers([...taggedUsers, ...allTagged]);
                }}
              >
                <Ionicons name="people-circle" size={18} color="#fff" />
                <Text style={composerStyles.tagAllText}>Tag All</Text>
              </TouchableOpacity>
            )}

            <TextInput
              placeholder="Search people or AI..."
              placeholderTextColor="#9b766c"
              value={searchQuery}
              onChangeText={setSearchQuery}
              style={composerStyles.searchInput}
            />

            <FlatList
              data={filteredTagOptions}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => {
                const tagged = taggedUsers.find((u) => u.id === item.id);
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
                    {tagged && <Ionicons name="checkmark-circle" size={18} color="#e0a53d" />}
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
        <View style={composerStyles.linkModalOverlay}>
          <View style={composerStyles.linkModalContent}>
            <Text style={composerStyles.linkModalTitle}>Add Link</Text>
            <TextInput
              placeholder="https://example.com"
              placeholderTextColor="#9b766c"
              value={linkUrl}
              onChangeText={setLinkUrl}
              style={composerStyles.linkInput}
              autoCapitalize="none"
              keyboardType="url"
            />
            <TextInput
              placeholder="Link title (optional)"
              placeholderTextColor="#9b766c"
              value={linkTitle}
              onChangeText={setLinkTitle}
              style={composerStyles.linkInput}
            />
            <View style={composerStyles.linkModalButtons}>
              <TouchableOpacity
                style={[composerStyles.linkModalButton, { backgroundColor: "#fffaf7" }]}
                onPress={() => { setShowLinkModal(false); setLinkUrl(""); setLinkTitle(""); }}
              >
                <Text
                  style={[composerStyles.linkModalButtonText, { color: "#5f0909" }]}
                >
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[composerStyles.linkModalButton, { backgroundColor: "#e0a53d" }]}
                onPress={handleAddLink}
              >
                <Text style={composerStyles.linkModalButtonText}>Add Link</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* GIF Modal */}
      <Modal
        visible={showGifModal}
        animationType="slide"
        transparent
        onRequestClose={() => { setShowGifModal(false); setGifError(null); }}
      >
        <View style={composerStyles.modalOverlay}>
          <View style={composerStyles.tagModalContainer}>
            <View style={composerStyles.modalHeader}>
              <Text style={composerStyles.modalTitle}>Choose a GIF</Text>
              <TouchableOpacity onPress={() => { setShowGifModal(false); setGifError(null); }}>
                <Ionicons name="close" size={24} color="#9b766c" />
              </TouchableOpacity>
            </View>

            <View style={composerStyles.gifSearchContainer}>
              <TextInput
                placeholder="Search GIFs..."
                placeholderTextColor="#9b766c"
                value={gifSearchQuery}
                onChangeText={setGifSearchQuery}
                onSubmitEditing={() => searchGifs(gifSearchQuery)}
                style={composerStyles.searchInput}
                returnKeyType="search"
              />
              <TouchableOpacity style={composerStyles.gifSearchButton} onPress={() => searchGifs(gifSearchQuery)}>
                <Ionicons name="search" size={18} color="#fff" />
              </TouchableOpacity>
            </View>

            {loadingGifs ? (
              <View style={composerStyles.gifLoadingContainer}>
                <ActivityIndicator size="large" color="#e0a53d" />
                <Text style={composerStyles.gifLoadingText}>Searching GIFs...</Text>
              </View>
            ) : gifError ? (
              <View style={composerStyles.gifErrorContainer}>
                <Ionicons name="cloud-offline-outline" size={48} color="#e0a53d" />
                <Text style={composerStyles.gifErrorTitle}>Connection Error</Text>
                <Text style={composerStyles.gifErrorText}>{gifError}</Text>
                <TouchableOpacity style={composerStyles.gifRetryButton} onPress={() => searchGifs(gifSearchQuery)}>
                  <Ionicons name="refresh" size={18} color="#fff" />
                  <Text style={composerStyles.gifRetryText}>Try Again</Text>
                </TouchableOpacity>
              </View>
            ) : gifResults.length > 0 ? (
              <FlatList
                data={gifResults}
                numColumns={2}
                keyExtractor={(_, index) => index.toString()}
                renderItem={({ item }) => {
                  const gifUrl = item?.media_formats?.gif?.url;
                  const thumbnailUrl = item?.media_formats?.tinygif?.url || gifUrl;
                  if (!gifUrl || !thumbnailUrl) return null;
                  return (
                    <TouchableOpacity style={composerStyles.gifItem} onPress={() => handleSelectGif(gifUrl)}>
                      <Image source={{ uri: thumbnailUrl }} style={composerStyles.gifThumbnail} resizeMode="cover" />
                    </TouchableOpacity>
                  );
                }}
                contentContainerStyle={composerStyles.gifGrid}
              />
            ) : (
              <View style={composerStyles.gifEmptyContainer}>
                <Ionicons name="images-outline" size={48} color="#f0e7e2" />
                <Text style={composerStyles.emptyText}>
                  {gifSearchQuery ? "No GIFs found" : "Search for GIFs to get started"}
                </Text>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
};

const composerStyles = StyleSheet.create({
  inputWrapper: {
    backgroundColor: "#8f3a2b",
    paddingTop: 10,
    paddingBottom: 10,
    paddingHorizontal: 10,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "#e0a53d",
    shadowColor: "#5f0909",
    shadowOpacity: 0.14,
    shadowRadius: 10,
    elevation: 2,
  },

  replyingToBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#f4e7df",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: "rgba(95,9,9,0.18)",
  },
  replyingToContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flex: 1,
  },
  replyingToText: {
    color: "#9b766c",
    fontSize: 11,
    flex: 1,
  },
  replyingToName: {
    color: "#5f0909",
    fontWeight: "600",
  },
  replyingToSnippet: {
    color: "#9b766c",
    fontStyle: "italic",
  },
  cancelReplyBtn: {
    padding: 2,
    marginLeft: 6,
  },

  gifPreviewCompact: {
    position: "relative",
    marginBottom: 4,
    borderRadius: 8,
    overflow: "hidden",
  },
  gifImageCompact: {
    width: "100%",
    height: 90,
    borderRadius: 8,
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
    backgroundColor: "#fff8f4",
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: "rgba(95,9,9,0.18)",
  },
  placeholderText: {
    flex: 1,
    color: "#9b766c",
    fontSize: 14,
  },

  expandedInputContainer: {
    backgroundColor: "#f7ddd7",
    borderRadius: 16,
    padding: 8,
    borderWidth: 1,
    borderColor: "rgba(95,9,9,0.18)",
    shadowColor: "#5f0909",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 1,
  },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(95,9,9,0.12)",
  },
  optionBtn: {
    padding: 3,
    position: "relative",
  },
  optionBadge: {
    position: "absolute",
    top: -1,
    right: -1,
    backgroundColor: "#e0a53d",
    borderRadius: 6,
    minWidth: 11,
    height: 11,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 1,
  },
  optionBadgeText: {
    color: "#fff",
    fontSize: 7,
    fontWeight: "bold",
  },
  anonymousBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: "#fffaf7",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(95,9,9,0.12)",
  },
  anonymousBtnText: {
    color: "#9b766c",
    fontSize: 10,
    fontWeight: "600",
  },
  collapseBtn: {
    padding: 3,
  },

  filesPreviewRow: {
    flexDirection: "row",
    gap: 4,
    marginBottom: 4,
    flexWrap: "wrap",
    alignItems: "center",
  },
  filePreviewItem: {
    width: 36,
    height: 36,
    borderRadius: 6,
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
    backgroundColor: "#fffaf7",
    justifyContent: "center",
    alignItems: "center",
  },
  previewDocName: {
    color: "#9b766c",
    fontSize: 6,
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
    color: "#9b766c",
    fontSize: 10,
  },

  linkPreviewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#fffaf7",
    padding: 4,
    borderRadius: 6,
    marginBottom: 4,
  },
  linkPreviewText: {
    flex: 1,
    color: "#4f9cff",
    fontSize: 11,
  },
  taggedPreviewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  taggedPreviewText: {
    color: "#e0a53d",
    fontSize: 11,
    fontWeight: "500",
  },
  mentionSheet: {
    marginTop: 8,
    borderRadius: 14,
    backgroundColor: "#fff7f1",
    borderWidth: 1,
    borderColor: "#f0d2c2",
    overflow: "hidden",
  },
  mentionSheetLabel: {
    color: "#9b766c",
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
    borderTopColor: "#f6e3d8",
  },
  mentionAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff0ea",
    marginRight: 10,
  },
  mentionAvatarText: {
    color: "#7d1d13",
    fontSize: 12,
    fontWeight: "800",
  },
  mentionName: {
    color: "#4d1b17",
    fontSize: 13,
    fontWeight: "700",
  },
  mentionMeta: {
    color: "#9b766c",
    fontSize: 11,
    marginTop: 2,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "#fff8f4",
    borderWidth: 1,
    borderColor: "rgba(95,9,9,0.16)",
  },
  userAvatarSmall: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#fffaf7",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    marginBottom: 3,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarTextSmall: {
    color: "#9b766c",
    fontSize: 10,
    fontWeight: "700",
  },
  input: {
    flex: 1,
    color: "#4d1b17",
    fontSize: 14.5,
    maxHeight: 80,
    paddingTop: 6,
    paddingBottom: 6,
    paddingHorizontal: 4,
    lineHeight: 20,
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#5f0909",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 0,
    borderWidth: 1,
    borderColor: "#e0a53d",
  },
  sendButtonDisabled: {
    backgroundColor: "#f0d2c2",
    borderColor: "#f0d2c2",
  },
  charCountText: {
    color: "#9b766c",
    fontSize: 10,
    textAlign: "right",
    marginTop: 1,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "flex-end",
  },
  tagModalContainer: {
    flex: 0.8,
    backgroundColor: "#f6f1ed",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: "#e8d3b2",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#e8d3b2",
    backgroundColor: "#fff4ee",
  },
  modalTitle: {
    color: "#4d1b17",
    fontSize: 16,
    fontWeight: "700",
  },
  tagAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#e0a53d",
    marginHorizontal: 14,
    marginVertical: 8,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  tagAllText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 13,
  },
  searchInput: {
    backgroundColor: "#fffaf7",
    color: "#4d1b17",
    borderRadius: 8,
    padding: 10,
    marginHorizontal: 14,
    marginBottom: 8,
    fontSize: 14,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  studentItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    marginHorizontal: 14,
    borderBottomColor: "#fffaf7",
    borderBottomWidth: 1,
  },
  studentAvatar: {
    backgroundColor: "#fffaf7",
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  aiAvatar: {
    backgroundColor: "#efe3ff",
    borderColor: "#d1b2ff",
  },
  studentAvatarText: {
    color: "#5f0909",
    fontWeight: "bold",
    fontSize: 13,
  },
  studentInfo: { flex: 1 },
  studentName: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "500",
  },
  studentMetaText: {
    color: "#9b766c",
    fontSize: 12,
    marginTop: 2,
  },
  emptyText: {
    color: "#9b766c",
    fontSize: 13,
    textAlign: "center",
    marginTop: 20,
  },

  linkModalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.8)",
  },
  linkModalContent: {
    width: "85%",
    backgroundColor: "#f6f1ed",
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: "#e8d3b2",
  },
  linkModalTitle: {
    color: "#4d1b17",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 14,
    textAlign: "center",
  },
  linkInput: {
    backgroundColor: "#fffaf7",
    color: "#4d1b17",
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#f0e7e2",
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
    color: "#fff",
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
    backgroundColor: "#e0a53d",
    padding: 10,
    borderRadius: 8,
  },
  gifLoadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 40,
  },
  gifLoadingText: {
    color: "#9b766c",
    fontSize: 13,
    marginTop: 10,
  },
  gifErrorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 40,
    paddingHorizontal: 28,
  },
  gifErrorTitle: {
    color: "#e0a53d",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 6,
  },
  gifErrorText: {
    color: "#9b766c",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
    marginBottom: 16,
  },
  gifRetryButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#5f0909",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  gifRetryText: {
    color: "#fff",
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
    paddingVertical: 40,
  },
});

export default CommentComposer;

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

const MAX_FILES = 10;
const MAX_CHARACTERS = 1250;

type PartialComment = {
  text: string;
  userId: string;
  realUserId?: string;
  username?: string;
  role?: string;
  likes?: string[];
  profilePic?: string;
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

interface CommentComposerProps {
  onSend?: (commentData: PartialComment) => Promise<void>;
  currentUser: any;
  maxFiles?: number;
  placeholder?: string;
  replyingTo?: { id: string; name: string; text: string } | null;
  onCancelReply?: () => void;
}

const CommentComposer: React.FC<CommentComposerProps> = ({
  onSend,
  currentUser,
  maxFiles = MAX_FILES,
  placeholder = "Write a comment...",
  replyingTo = null,
  onCancelReply,
}) => {
  const [commentText, setCommentText] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
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
  const textInputRef = useRef<TextInput>(null);

  useEffect(() => {
    fetchStudents();
  }, []);

  useEffect(() => {
    if (replyingTo) {
      setIsExpanded(true);
      textInputRef.current?.focus();
    }
  }, [replyingTo]);

  const fetchStudents = async () => {
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

      setStudents(studentsList);
    } catch (error) {
      console.error("Error fetching students:", error);
    }
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

  const handleSendComment = async () => {
    if (!commentText.trim() && files.length === 0 && !attachedLink && !selectedGif) return;
    if (!currentUser || !onSend) return;

    // NO Keyboard.dismiss() here → keyboard stays open after send (modern social media style)

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

      const uniqueTaggedUsers = taggedUsers.filter(
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
        profilePic: isAnonymous ? null : currentUser.profilePic || null,
        isAnonymous: isAnonymous,
        replyCount: 0,
        files: uploadedUrls,
        taggedUsers: uniqueTaggedUsers.map((u) => ({
          id: u.id,
          name: `${u.firstname} ${u.lastname}`,
          studentID: u.studentID,
        })),
      };

      if (attachedLink) {
        commentData.link = attachedLink;
      }

      await onSend(commentData);

      // Clear input immediately → user sees instant feedback
      setCommentText("");
      setFiles([]);
      setTaggedUsers([]);
      setAttachedLink(null);
      setSelectedGif(null);
      setIsAnonymous(false);

      // Keep composer expanded so user can continue typing immediately
      // setIsExpanded(false);  ← commented out on purpose

      // Optional: re-focus the input automatically for next message
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

  const remainingChars = MAX_CHARACTERS - commentText.length;
  const isNearLimit = remainingChars < 100;

  return (
    <>
      <View style={composerStyles.inputWrapper}>
        {/* Replying To Bar */}
        {replyingTo && (
          <View style={composerStyles.replyingToBar}>
            <View style={composerStyles.replyingToContent}>
              <Ionicons name="chevron-forward" size={14} color="#ff5c93" />
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
                <Ionicons name="close" size={16} color="#8ea0d0" />
              </TouchableOpacity>
            )}
          </View>
        )}

        {selectedGif && (
          <View style={composerStyles.gifPreviewCompact}>
            <Image source={{ uri: selectedGif }} style={composerStyles.gifImageCompact} />
            <TouchableOpacity style={composerStyles.removeGifBtn} onPress={() => setSelectedGif(null)}>
              <Ionicons name="close-circle" size={16} color="#ff5c93" />
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
              {currentUser?.profilePic ? (
                <Image source={{ uri: currentUser.profilePic }} style={composerStyles.avatarImage} />
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
                <Ionicons name="images" size={19} color={files.length >= maxFiles ? "#243054" : "#4f9cff"} />
              </TouchableOpacity>
              <TouchableOpacity style={composerStyles.optionBtn} onPress={() => setShowTagModal(true)}>
                <Ionicons name="person-add" size={19} color="#a86fff" />
                {taggedUsers.length > 0 && (
                  <View style={composerStyles.optionBadge}>
                    <Text style={composerStyles.optionBadgeText}>{taggedUsers.length}</Text>
                  </View>
                )}
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
                  color={isAnonymous ? "#ff5c93" : "#8ea0d0"}
                />
                <Text style={[composerStyles.anonymousBtnText, isAnonymous && { color: "#ff5c93" }]}>
                  {isAnonymous ? "Anon" : "Public"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={composerStyles.collapseBtn}
                onPress={() => { setIsExpanded(false); /* Keyboard.dismiss(); */ }}
              >
                <Ionicons name="chevron-down" size={18} color="#8ea0d0" />
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
                      <Ionicons name="close-circle" size={14} color="#ff5c93" />
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
                  <Ionicons name="close-circle" size={14} color="#ff5c93" />
                </TouchableOpacity>
              </View>
            )}

            {taggedUsers.length > 0 && (
              <View style={composerStyles.taggedPreviewRow}>
                <Ionicons name="people" size={11} color="#ff5c93" />
                <Text style={composerStyles.taggedPreviewText}>{taggedUsers.length} tagged</Text>
              </View>
            )}

            {/* Input row */}
            <View style={composerStyles.inputRow}>
              <View style={composerStyles.userAvatarSmall}>
                {isAnonymous ? (
                  <Ionicons name="person" size={11} color="#8ea0d0" />
                ) : currentUser?.profilePic ? (
                  <Image source={{ uri: currentUser.profilePic }} style={composerStyles.avatarImage} />
                ) : (
                  <Text style={composerStyles.avatarTextSmall}>
                    {currentUser?.firstname?.[0]?.toUpperCase() || "U"}
                  </Text>
                )}
              </View>
              <TextInput
                ref={textInputRef}
                placeholder={placeholder}
                placeholderTextColor="#6b7280"
                style={composerStyles.input}
                value={commentText}
                onChangeText={setCommentText}
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
                    color={(commentText.trim() || files.length > 0 || attachedLink || selectedGif) ? "#fff" : "#243054"}
                  />
                )}
              </TouchableOpacity>
            </View>

            {isNearLimit && (
              <Text style={[composerStyles.charCountText, remainingChars < 50 && { color: "#ff5c93" }]}>
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
                Tag People {taggedUsers.length > 0 && `(${taggedUsers.length})`}
              </Text>
              <TouchableOpacity onPress={() => setShowTagModal(false)}>
                <Ionicons name="close" size={24} color="#8ea0d0" />
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
              placeholder="Search students..."
              placeholderTextColor="#8ea0d0"
              value={searchQuery}
              onChangeText={setSearchQuery}
              style={composerStyles.searchInput}
            />

            <FlatList
              data={filteredStudents}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => {
                const tagged = taggedUsers.find((u) => u.id === item.id);
                return (
                  <TouchableOpacity style={composerStyles.studentItem} onPress={() => handleTagUser(item)}>
                    <View style={composerStyles.studentAvatar}>
                      <Text style={composerStyles.studentAvatarText}>
                        {item.firstname.charAt(0)}{item.lastname.charAt(0)}
                      </Text>
                    </View>
                    <View style={composerStyles.studentInfo}>
                      <Text style={composerStyles.studentName}>{item.firstname} {item.lastname}</Text>
                    </View>
                    {tagged && <Ionicons name="checkmark-circle" size={18} color="#ff5c93" />}
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={composerStyles.emptyText}>
                  {searchQuery ? "No students found" : "No students available"}
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
              placeholderTextColor="#8ea0d0"
              value={linkUrl}
              onChangeText={setLinkUrl}
              style={composerStyles.linkInput}
              autoCapitalize="none"
              keyboardType="url"
            />
            <TextInput
              placeholder="Link title (optional)"
              placeholderTextColor="#8ea0d0"
              value={linkTitle}
              onChangeText={setLinkTitle}
              style={composerStyles.linkInput}
            />
            <View style={composerStyles.linkModalButtons}>
              <TouchableOpacity
                style={[composerStyles.linkModalButton, { backgroundColor: "#1b2235" }]}
                onPress={() => { setShowLinkModal(false); setLinkUrl(""); setLinkTitle(""); }}
              >
                <Text style={composerStyles.linkModalButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[composerStyles.linkModalButton, { backgroundColor: "#ff5c93" }]}
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
                <Ionicons name="close" size={24} color="#8ea0d0" />
              </TouchableOpacity>
            </View>

            <View style={composerStyles.gifSearchContainer}>
              <TextInput
                placeholder="Search GIFs..."
                placeholderTextColor="#8ea0d0"
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
                <ActivityIndicator size="large" color="#ff5c93" />
                <Text style={composerStyles.gifLoadingText}>Searching GIFs...</Text>
              </View>
            ) : gifError ? (
              <View style={composerStyles.gifErrorContainer}>
                <Ionicons name="cloud-offline-outline" size={48} color="#ff5c93" />
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
                <Ionicons name="images-outline" size={48} color="#243054" />
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
  // ── Wrapper ─────────────────────────────────────────────
  inputWrapper: {
    backgroundColor: "transparent",
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: 0,
  },

  // Replying bar (unchanged)
  replyingToBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#0e1320",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 4,
  },
  replyingToContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flex: 1,
  },
  replyingToText: {
    color: "#8ea0d0",
    fontSize: 11,
    flex: 1,
  },
  replyingToName: {
    color: "#ff8ab2",
    fontWeight: "600",
  },
  replyingToSnippet: {
    color: "#8ea0d0",
    fontStyle: "italic",
  },
  cancelReplyBtn: {
    padding: 2,
    marginLeft: 6,
  },

  // GIF preview (unchanged)
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

  // Collapsed pill (unchanged)
  simpleInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#0e1320",
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#1b2235",
  },
  placeholderText: {
    flex: 1,
    color: "#6b7280",
    fontSize: 14,
  },

  // ── Expanded box – now super compact ────────────────────
  expandedInputContainer: {
    backgroundColor: "#0e1320",
    borderRadius: 10,
    padding: 6,
    borderWidth: 1,
    borderColor: "#1b2235",
  },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#1b2235",
  },
  optionBtn: {
    padding: 3,
    position: "relative",
  },
  optionBadge: {
    position: "absolute",
    top: -1,
    right: -1,
    backgroundColor: "#ff5c93",
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
    backgroundColor: "#1b2235",
    borderRadius: 8,
  },
  anonymousBtnText: {
    color: "#8ea0d0",
    fontSize: 10,
    fontWeight: "600",
  },
  collapseBtn: {
    padding: 3,
  },

  // Previews – reduced margins
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
    backgroundColor: "#1b2235",
    justifyContent: "center",
    alignItems: "center",
  },
  previewDocName: {
    color: "#8ea0d0",
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
    color: "#8ea0d0",
    fontSize: 10,
  },

  linkPreviewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#1b2235",
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
    color: "#ff5c93",
    fontSize: 11,
    fontWeight: "500",
  },

  // Input row – tightest possible
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    paddingTop: 0,
    paddingBottom: 0,
  },
  userAvatarSmall: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#1b2235",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    marginBottom: 3,
    borderWidth: 1,
    borderColor: "#243054",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarTextSmall: {
    color: "#8ea0d0",
    fontSize: 10,
    fontWeight: "700",
  },
  input: {
    flex: 1,
    color: "#d8deff",
    fontSize: 14.5,
    maxHeight: 80,
    paddingTop: 6,
    paddingBottom: 6,
    paddingHorizontal: 4,
    lineHeight: 20,
  },
  sendButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#ff5c93",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 0,
  },
  sendButtonDisabled: {
    backgroundColor: "#1b2235",
  },
  charCountText: {
    color: "#8ea0d0",
    fontSize: 10,
    textAlign: "right",
    marginTop: 1,
  },

  // Modals (unchanged – keeping your original modal styles)
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "flex-end",
  },
  tagModalContainer: {
    flex: 0.8,
    backgroundColor: "#0e1320",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: "#1b2235",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#1b2235",
  },
  modalTitle: {
    color: "#e9edff",
    fontSize: 16,
    fontWeight: "700",
  },
  tagAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ff5c93",
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
    backgroundColor: "#1b2235",
    color: "#d8deff",
    borderRadius: 8,
    padding: 10,
    marginHorizontal: 14,
    marginBottom: 8,
    fontSize: 14,
    borderWidth: 1,
    borderColor: "#243054",
  },
  studentItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    marginHorizontal: 14,
    borderBottomColor: "#1b2235",
    borderBottomWidth: 1,
  },
  studentAvatar: {
    backgroundColor: "#1b2235",
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    borderWidth: 1,
    borderColor: "#243054",
  },
  studentAvatarText: {
    color: "#ff8ab2",
    fontWeight: "bold",
    fontSize: 13,
  },
  studentInfo: { flex: 1 },
  studentName: {
    color: "#d8deff",
    fontSize: 14,
    fontWeight: "500",
  },
  emptyText: {
    color: "#8ea0d0",
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
    backgroundColor: "#0e1320",
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: "#1b2235",
  },
  linkModalTitle: {
    color: "#e9edff",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 14,
    textAlign: "center",
  },
  linkInput: {
    backgroundColor: "#1b2235",
    color: "#d8deff",
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#243054",
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
    backgroundColor: "#ff5c93",
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
    color: "#8ea0d0",
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
    color: "#ff5c93",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 6,
  },
  gifErrorText: {
    color: "#8ea0d0",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
    marginBottom: 16,
  },
  gifRetryButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#4f9cff",
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
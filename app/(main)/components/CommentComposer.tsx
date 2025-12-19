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
  Keyboard,
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

  // Auto-expand and focus when replying to someone
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
          if (!data.firstname || !data.lastname || !data.studentID) {
            return null;
          }
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
        Alert.alert(
          "Maximum Files Reached",
          `You can only attach up to ${maxFiles} files per comment.`
        );
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
          Alert.alert(
            "File Limit",
            `Only ${remainingSlots} more file(s) can be added. Maximum is ${maxFiles} files per comment.`
          );
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

    setAttachedLink({
      url: formattedUrl,
      title: linkTitle.trim() || formattedUrl,
    });
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

      setCommentText("");
      setFiles([]);
      setTaggedUsers([]);
      setAttachedLink(null);
      setSelectedGif(null);
      setIsAnonymous(false);
      setIsExpanded(false);
      Keyboard.dismiss();
    } catch (error: any) {
      console.error("Comment error:", error);
      
      // Check for network-related errors
      const errorMessage = error?.message?.toLowerCase() || "";
      if (
        errorMessage.includes("network") ||
        errorMessage.includes("connection") ||
        errorMessage.includes("timeout") ||
        error?.code === "unavailable" ||
        error?.code === "ECONNREFUSED"
      ) {
        Alert.alert(
          "Connection Error",
          "Unable to post comment. Please check your internet connection and try again.",
          [{ text: "OK" }]
        );
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
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const response = await fetch(
        `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(
          query
        )}&key=${API_KEY}&limit=${limit}&media_filter=gif`,
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error("Failed to fetch GIFs");
      }

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
      
      // Handle different types of errors
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
              <Ionicons name="chevron-forward" size={16} color="#4f9cff" />
              <Text style={composerStyles.replyingToText} numberOfLines={1}>
                Replying to <Text style={composerStyles.replyingToName}>{replyingTo.name}</Text>
              </Text>
            </View>
            {onCancelReply && (
              <TouchableOpacity onPress={onCancelReply} style={composerStyles.cancelReplyBtn}>
                <Ionicons name="close-circle" size={20} color="#8ea0d0" />
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Quoted Message */}
        {replyingTo && (
          <View style={composerStyles.quotedMessageContainer}>
            <Text style={composerStyles.quotedName}>{replyingTo.name}</Text>
            <Text style={composerStyles.quotedText} numberOfLines={2} ellipsizeMode="tail">
              {replyingTo.text}
            </Text>
          </View>
        )}

        {files.length > 0 && (
          <View style={composerStyles.fileLimitInfo}>
            <Text style={composerStyles.fileLimitText}>
              {files.length} / {maxFiles} files attached
            </Text>
          </View>
        )}

        {selectedGif && (
          <View style={composerStyles.gifPreviewCompact}>
            <Image source={{ uri: selectedGif }} style={composerStyles.gifImageCompact} />
            <TouchableOpacity
              style={composerStyles.removeGifBtn}
              onPress={() => setSelectedGif(null)}
            >
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
                <Image
                  source={{ uri: currentUser.profilePic }}
                  style={composerStyles.avatarImage}
                />
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
            <View style={composerStyles.optionsRow}>
              <TouchableOpacity
                style={composerStyles.optionBtn}
                onPress={pickFiles}
                disabled={files.length >= maxFiles}
              >
                <Ionicons 
                  name="images" 
                  size={20} 
                  color={files.length >= maxFiles ? "#5a6380" : "#4f9cff"} 
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={composerStyles.optionBtn}
                onPress={() => setShowTagModal(true)}
              >
                <Ionicons name="person-add" size={20} color="#a86fff" />
                {taggedUsers.length > 0 && (
                  <View style={composerStyles.optionBadge}>
                    <Text style={composerStyles.optionBadgeText}>{taggedUsers.length}</Text>
                  </View>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={composerStyles.optionBtn}
                onPress={() => setShowLinkModal(true)}
              >
                <Ionicons name="link" size={20} color="#4f9cff" />
              </TouchableOpacity>
              <TouchableOpacity
                style={composerStyles.optionBtn}
                onPress={() => setShowGifModal(true)}
              >
                <Ionicons name="gift" size={20} color="#ff9f43" />
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                style={composerStyles.anonymousBtn}
                onPress={() => setIsAnonymous(!isAnonymous)}
              >
                <Ionicons
                  name={isAnonymous ? "eye-off" : "person"}
                  size={16}
                  color={isAnonymous ? "#ff3b7f" : "#8ea0d0"}
                />
                <Text style={[
                  composerStyles.anonymousBtnText,
                  isAnonymous && { color: "#ff3b7f" }
                ]}>
                  {isAnonymous ? "Anonymous" : "Public"}
                </Text>
              </TouchableOpacity>
            </View>

            {files.length > 0 && (
              <View style={composerStyles.filesPreviewRow}>
                {files.map((f, i) => (
                  <View key={i} style={composerStyles.filePreviewItem}>
                    {f.mimeType.startsWith("image/") ? (
                      <Image source={{ uri: f.uri }} style={composerStyles.previewImage} />
                    ) : (
                      <View style={composerStyles.previewDoc}>
                        <Ionicons 
                          name={f.mimeType.includes("pdf") ? "document-text" : "document"} 
                          size={16} 
                          color="#4f9cff" 
                        />
                        <Text style={composerStyles.previewDocName} numberOfLines={1}>
                          {f.name.length > 8 ? f.name.substring(0, 8) + "..." : f.name}
                        </Text>
                      </View>
                    )}
                    <TouchableOpacity
                      style={composerStyles.removeFileBtn}
                      onPress={() => setFiles(files.filter((_, idx) => idx !== i))}
                    >
                      <Ionicons name="close-circle" size={16} color="#ff5c93" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {attachedLink && (
              <View style={composerStyles.linkPreviewRow}>
                <Ionicons name="link" size={14} color="#4f9cff" />
                <Text style={composerStyles.linkPreviewText} numberOfLines={1}>
                  {attachedLink.title}
                </Text>
                <TouchableOpacity onPress={() => setAttachedLink(null)}>
                  <Ionicons name="close-circle" size={16} color="#ff5c93" />
                </TouchableOpacity>
              </View>
            )}

            {taggedUsers.length > 0 && (
              <View style={composerStyles.taggedPreviewRow}>
                <Ionicons name="people" size={12} color="#ff3b7f" />
                <Text style={composerStyles.taggedPreviewText}>
                  {taggedUsers.length} tagged
                </Text>
              </View>
            )}

            <View style={composerStyles.inputRow}>
              <View style={composerStyles.userAvatarSmall}>
                {isAnonymous ? (
                  <Ionicons name="person" size={12} color="#8ea0d0" />
                ) : currentUser?.profilePic ? (
                  <Image
                    source={{ uri: currentUser.profilePic }}
                    style={composerStyles.avatarImage}
                  />
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
                disabled={(!commentText.trim() && files.length === 0 && !attachedLink) || uploading}
                style={[
                  composerStyles.sendButton,
                  (!commentText.trim() && files.length === 0 && !attachedLink) && composerStyles.sendButtonDisabled,
                ]}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons
                    name="send"
                    size={18}
                    color={(commentText.trim() || files.length > 0 || attachedLink) ? "#fff" : "#4b5563"}
                  />
                )}
              </TouchableOpacity>
            </View>

            {isNearLimit && (
              <View style={composerStyles.charCountRow}>
                <Text style={[
                  composerStyles.charCountText,
                  remainingChars < 50 && { color: "#ff5c93" }
                ]}>
                  {remainingChars} characters remaining
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={composerStyles.collapseBtn}
              onPress={() => {
                setIsExpanded(false);
                Keyboard.dismiss();
              }}
            >
              <Ionicons name="chevron-down" size={20} color="#8ea0d0" />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Tag Modal */}
      <Modal
        visible={showTagModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowTagModal(false)}
      >
        <View style={composerStyles.modalOverlay}>
          <View style={composerStyles.tagModalContainer}>
            <View style={composerStyles.modalHeader}>
              <Text style={composerStyles.modalTitle}>
                Tag People {taggedUsers.length > 0 && `(${taggedUsers.length})`}
              </Text>
              <TouchableOpacity onPress={() => setShowTagModal(false)}>
                <Ionicons name="close" size={28} color="#b8c7ff" />
              </TouchableOpacity>
            </View>

            {students.length > 0 && (
              <TouchableOpacity
                style={composerStyles.tagAllButton}
                onPress={() => {
                  const allTagged = students.filter(
                    (s) => !taggedUsers.find((u) => u.id === s.id)
                  );
                  if (allTagged.length === 0) {
                    Alert.alert("Info", "Everyone is already tagged!");
                    return;
                  }
                  setTaggedUsers([...taggedUsers, ...allTagged]);
                }}
              >
                <Ionicons name="people-circle" size={20} color="#fff" />
                <Text style={composerStyles.tagAllText}>Tag All</Text>
              </TouchableOpacity>
            )}

            <TextInput
              placeholder="Search students..."
              placeholderTextColor="#a0a8c0"
              value={searchQuery}
              onChangeText={setSearchQuery}
              style={composerStyles.searchInput}
            />

            <FlatList
              data={filteredStudents}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => {
                const tagged = taggedUsers.find((u) => u.id === item.id);
                const firstname = item.firstname || "?";
                const lastname = item.lastname || "?";
                return (
                  <TouchableOpacity
                    style={composerStyles.studentItem}
                    onPress={() => handleTagUser(item)}
                  >
                    <View style={composerStyles.studentAvatar}>
                      <Text style={composerStyles.studentAvatarText}>
                        {firstname.charAt(0)}
                        {lastname.charAt(0)}
                      </Text>
                    </View>
                    <View style={composerStyles.studentInfo}>
                      <Text style={composerStyles.studentName}>
                        {firstname} {lastname}
                      </Text>
                    </View>
                    {tagged && (
                      <Ionicons name="checkmark-circle" size={20} color="#6f9aff" />
                    )}
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
      <Modal
        visible={showLinkModal}
        animationType="fade"
        transparent
        onRequestClose={() => setShowLinkModal(false)}
      >
        <View style={composerStyles.linkModalOverlay}>
          <View style={composerStyles.linkModalContent}>
            <Text style={composerStyles.linkModalTitle}>Add Link</Text>

            <TextInput
              placeholder="Enter URL (e.g., https://example.com)"
              placeholderTextColor="#a0a8c0"
              value={linkUrl}
              onChangeText={setLinkUrl}
              style={composerStyles.linkInput}
              autoCapitalize="none"
              keyboardType="url"
            />

            <TextInput
              placeholder="Link title (optional)"
              placeholderTextColor="#a0a8c0"
              value={linkTitle}
              onChangeText={setLinkTitle}
              style={composerStyles.linkInput}
            />

            <View style={composerStyles.linkModalButtons}>
              <TouchableOpacity
                style={[composerStyles.linkModalButton, { backgroundColor: "#1b2235" }]}
                onPress={() => {
                  setShowLinkModal(false);
                  setLinkUrl("");
                  setLinkTitle("");
                }}
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
        onRequestClose={() => {
          setShowGifModal(false);
          setGifError(null);
        }}
      >
        <View style={composerStyles.modalOverlay}>
          <View style={composerStyles.tagModalContainer}>
            <View style={composerStyles.modalHeader}>
              <Text style={composerStyles.modalTitle}>Choose a GIF</Text>
              <TouchableOpacity onPress={() => {
                setShowGifModal(false);
                setGifError(null);
              }}>
                <Ionicons name="close" size={28} color="#b8c7ff" />
              </TouchableOpacity>
            </View>

            <View style={composerStyles.gifSearchContainer}>
              <TextInput
                placeholder="Search GIFs..."
                placeholderTextColor="#a0a8c0"
                value={gifSearchQuery}
                onChangeText={setGifSearchQuery}
                onSubmitEditing={() => searchGifs(gifSearchQuery)}
                style={composerStyles.searchInput}
                returnKeyType="search"
              />
              <TouchableOpacity
                style={composerStyles.gifSearchButton}
                onPress={() => searchGifs(gifSearchQuery)}
              >
                <Ionicons name="search" size={20} color="#fff" />
              </TouchableOpacity>
            </View>

            {loadingGifs ? (
              <View style={composerStyles.gifLoadingContainer}>
                <ActivityIndicator size="large" color="#ff5c93" />
                <Text style={composerStyles.gifLoadingText}>Searching GIFs...</Text>
              </View>
            ) : gifError ? (
              <View style={composerStyles.gifErrorContainer}>
                <Ionicons name="cloud-offline-outline" size={64} color="#ff5c93" />
                <Text style={composerStyles.gifErrorTitle}>Connection Error</Text>
                <Text style={composerStyles.gifErrorText}>{gifError}</Text>
                <TouchableOpacity
                  style={composerStyles.gifRetryButton}
                  onPress={() => searchGifs(gifSearchQuery)}
                >
                  <Ionicons name="refresh" size={20} color="#fff" />
                  <Text style={composerStyles.gifRetryText}>Try Again</Text>
                </TouchableOpacity>
              </View>
            ) : gifResults.length > 0 ? (
              <FlatList
                data={gifResults}
                numColumns={2}
                keyExtractor={(item, index) => index.toString()}
                renderItem={({ item }) => {
                  const gifUrl = item?.media_formats?.gif?.url;
                  const thumbnailUrl =
                    item?.media_formats?.tinygif?.url || item?.media_formats?.gif?.url;

                  if (!gifUrl || !thumbnailUrl) return null;

                  return (
                    <TouchableOpacity
                      style={composerStyles.gifItem}
                      onPress={() => handleSelectGif(gifUrl)}
                    >
                      <Image
                        source={{ uri: thumbnailUrl }}
                        style={composerStyles.gifThumbnail}
                        resizeMode="cover"
                      />
                    </TouchableOpacity>
                  );
                }}
                contentContainerStyle={composerStyles.gifGrid}
              />
            ) : (
              <View style={composerStyles.gifEmptyContainer}>
                <Ionicons name="images-outline" size={64} color="#5a6380" />
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
    backgroundColor: "#1c2535",
    borderTopWidth: 1,
    borderTopColor: "#243054",
    paddingTop: 6,              // Reduced
    paddingHorizontal: 12,      // Slightly reduced
    paddingBottom: 6,
  },
  replyingToBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#243054",
    paddingHorizontal: 8,       // Reduced
    paddingVertical: 5,
    borderRadius: 8,
    marginBottom: 6,            // Reduced
  },
  replyingToContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  replyingToText: {
    color: "#a0a8c0",
    fontSize: 12,               // Smaller
  },
  replyingToName: {
    color: "#4f9cff",
    fontWeight: "600",
  },
  cancelReplyBtn: {
    padding: 2,
  },
  quotedMessageContainer: {
    backgroundColor: "#243054",
    padding: 8,                 // Reduced
    borderRadius: 8,
    marginBottom: 6,            // Reduced
    // Removed thick left border for compactness
  },
  quotedName: {
    color: "#e9edff",
    fontSize: 11,               // Smaller
    fontWeight: "600",
    marginBottom: 2,
  },
  quotedText: {
    color: "#a0a8c0",
    fontSize: 12,               // Smaller
    lineHeight: 16,
  },
  fileLimitInfo: {
    // Removed standalone info – now shown in preview row
  },
  gifPreviewCompact: {
    position: "relative",
    marginBottom: 6,            // Reduced
    borderRadius: 8,
    overflow: "hidden",
  },
  gifImageCompact: {
    width: "100%",
    height: 100,                // Smaller preview
    borderRadius: 8,
  },
  removeGifBtn: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 10,
    padding: 2,
  },
  simpleInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#0f1624",
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 9,         // Slightly reduced
    borderWidth: 1,
    borderColor: "#243054",
  },
  placeholderText: {
    flex: 1,
    color: "#6b7280",
    fontSize: 14,
  },
  expandedInputContainer: {
    backgroundColor: "#0f1624",
    borderRadius: 12,
    padding: 8,                 // Reduced padding
    borderWidth: 1,
    borderColor: "#243054",
  },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,                    // Reduced gap
    marginBottom: 6,            // Reduced
  },
  optionBtn: {
    padding: 4,                 // Smaller touch area ok for icons
    position: "relative",
  },
  optionBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    backgroundColor: "#ff5c93",
    borderRadius: 7,
    minWidth: 12,
    height: 12,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 2,
  },
  optionBadgeText: {
    color: "#fff",
    fontSize: 8,
    fontWeight: "bold",
  },
  anonymousBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: "#243054",
    borderRadius: 10,
  },
  anonymousBtnText: {
    color: "#8ea0d0",
    fontSize: 10,               // Smaller
    fontWeight: "600",
  },
  filesPreviewRow: {
    flexDirection: "row",
    gap: 5,
    marginBottom: 6,
    flexWrap: "wrap",
    alignItems: "center",
  },
  filePreviewItem: {
    width: 40,                  // Smaller thumbnails
    height: 40,
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
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
  },
  previewDocName: {
    color: "#8ea0d0",
    fontSize: 7,
    marginTop: 1,
  },
  removeFileBtn: {
    position: "absolute",
    top: 1,
    right: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 8,
    padding: 1,
  },
  linkPreviewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#243054",
    padding: 5,                 // Reduced
    borderRadius: 6,
    marginBottom: 6,
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
    marginBottom: 6,
  },
  taggedPreviewText: {
    color: "#ff3b7f",
    fontSize: 11,
    fontWeight: "500",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",     // Better alignment for multiline
    gap: 8,
  },
  userAvatarSmall: {
    width: 26,                  // Slightly smaller avatar
    height: 26,
    borderRadius: 13,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    marginBottom: 4,            // Align with multiline text
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarTextSmall: {
    color: "#8ea0d0",
    fontSize: 11,
    fontWeight: "700",
  },
  input: {
    flex: 1,
    color: "#e9edff",
    fontSize: 14,
    maxHeight: 80,              // Limit growth a bit
    paddingTop: 8,
    paddingBottom: 8,
  },
  sendButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#ff3b7f",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 4,
  },
  sendButtonDisabled: {
    opacity: 0.5,
    backgroundColor: "#243054",
  },
  charCountRow: {
    marginTop: 2,
  },
  charCountText: {
    color: "#8ea0d0",
    fontSize: 10,
    textAlign: "right",
  },
  collapseBtn: {
    alignSelf: "center",
    marginTop: 2,               // Reduced
    padding: 3,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  tagModalContainer: {
    flex: 0.8,
    backgroundColor: "#10172b",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#1f2937",
  },
  modalTitle: {
    color: "#b8c7ff",
    fontSize: 18,
    fontWeight: "bold",
  },
  tagAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ff5c93",
    marginHorizontal: 16,
    marginBottom: 10,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 6,
  },
  tagAllText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
  searchInput: {
    backgroundColor: "#1b2235",
    color: "#e4e8ff",
    borderRadius: 10,
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  studentItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    marginHorizontal: 16,
    borderBottomColor: "#1e2840",
    borderBottomWidth: 1,
  },
  studentAvatar: {
    backgroundColor: "#243054",
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  studentAvatarText: {
    color: "#aebeff",
    fontWeight: "bold",
  },
  studentInfo: {
    flex: 1,
  },
  studentName: {
    color: "#e4e8ff",
    fontSize: 15,
    fontWeight: "500",
  },
  emptyText: {
    color: "#8ea0d0",
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
  },
  linkModalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  linkModalContent: {
    width: "85%",
    backgroundColor: "#1b2235",
    borderRadius: 16,
    padding: 20,
  },
  linkModalTitle: {
    color: "#b8c7ff",
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 16,
    textAlign: "center",
  },
  linkInput: {
    backgroundColor: "#243054",
    color: "#e9edff",
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#2a3548",
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
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  gifSearchContainer: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 12,
  },
  gifSearchButton: {
    backgroundColor: "#ff5c93",
    padding: 12,
    borderRadius: 10,
  },
  gifLoadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 60,
  },
  gifLoadingText: {
    color: "#8ea0d0",
    fontSize: 14,
    marginTop: 12,
  },
  gifErrorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 60,
    paddingHorizontal: 32,
  },
  gifErrorTitle: {
    color: "#ff5c93",
    fontSize: 18,
    fontWeight: "bold",
    marginTop: 16,
    marginBottom: 8,
  },
  gifErrorText: {
    color: "#a0a8c0",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 20,
  },
  gifRetryButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#4f9cff",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    gap: 8,
  },
  gifRetryText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
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
    paddingVertical: 60,
  },
   fileLimitText: {
    color: "#a0a8c0",
    fontSize: 11,
    textAlign: "center",
  },
});

export default CommentComposer;
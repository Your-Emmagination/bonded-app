//createpostscreen.tsx - FIXED: Can't tag yourself & duplicate prevention
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { router } from "expo-router";
import {
  addDoc,
  collection,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
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
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";

import {
  uploadPostFile,
  uploadPostGif,
  uploadPostImage,
} from "@/utils/cloudinaryUpload";

const MAX_FILES = 10;

interface Student {
  id: string;
  firstname: string;
  lastname: string;
  email: string;
  studentID: string;
}

const CreatePostScreen = () => {
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<
    { uri: string; mimeType: string; name: string }[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [taggedUsers, setTaggedUsers] = useState<Student[]>([]);
  const [showTagModal, setShowTagModal] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [attachedLink, setAttachedLink] = useState<{
    url: string;
    title: string;
  } | null>(null);

  const [showGifModal, setShowGifModal] = useState(false);
  const [gifSearchQuery, setGifSearchQuery] = useState("");
  const [gifResults, setGifResults] = useState<any[]>([]);
  const [selectedGif, setSelectedGif] = useState<string | null>(null);
  const [loadingGifs, setLoadingGifs] = useState(false);
  const [gifError, setGifError] = useState<string | null>(null);

  const insets = useSafeAreaInsets();

  useEffect(() => {
    fetchStudents();
  }, []);

  useEffect(() => {
    setGifError(null);
    if (!gifSearchQuery.trim()) {
      setGifResults([]);
    }
  }, [gifSearchQuery]);

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
            console.warn(`Student ${doc.id} missing required fields`);
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

          // ✅ Filter out current user by checking both doc.id and studentID
          if (student.id === currentUserId) return false;
          if (student.id === currentStudentID) return false;
          if (student.studentID === currentStudentID) return false;

          return true;
        });

      setStudents(studentsList);
    } catch (error) {
      console.error("Error fetching students:", error);
      Alert.alert("Error", "Failed to load students list");
    }
  };

  const pickFiles = async () => {
    try {
      if (files.length >= MAX_FILES) {
        Alert.alert(
          "Maximum Files Reached",
          `You can only attach up to ${MAX_FILES} files per post.`,
        );
        return;
      }

      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "image/*",
          "application/pdf",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets?.length > 0) {
        const remainingSlots = MAX_FILES - files.length;
        const filesToAdd = result.assets.slice(0, remainingSlots);

        if (result.assets.length > remainingSlots) {
          Alert.alert(
            "File Limit",
            `Only ${remainingSlots} more file(s) can be added. Maximum is ${MAX_FILES} files per post.`,
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
      Alert.alert("Error", "Failed to pick files");
    }
  };

  const handlePost = async () => {
    if (!auth.currentUser) {
      Alert.alert("Login required", "You must be signed in to create a post.");
      return;
    }

    if (
      !content.trim() &&
      files.length === 0 &&
      !selectedGif &&
      !attachedLink
    ) {
      Alert.alert("Empty Post", "Please add content, a file, GIF, or link.");
      return;
    }

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

        uploadedUrls.push({ url: uploadedUrl, mimeType: file.mimeType });
      }

      if (selectedGif) {
        const uploadedGifUrl = await uploadPostGif(selectedGif);
        uploadedUrls.push({ url: uploadedGifUrl, mimeType: "image/gif" });
      }

      const user = auth.currentUser;

      // ✅ Remove duplicate tagged users before saving
      const uniqueTaggedUsers = taggedUsers.filter(
        (user, index, self) =>
          index === self.findIndex((u) => u.id === user.id),
      );

      const postData: any = {
        content: content,
        files: uploadedUrls,
        userId: isAnonymous ? "anonymous" : user?.uid,
        realUserId: user?.uid,
        username: isAnonymous
          ? `Anonymous${Math.floor(Math.random() * 10000)}`
          : user?.displayName || user?.email?.split("@")[0] || "User",
        isAnonymous: isAnonymous,
        taggedUsers: uniqueTaggedUsers.map((u) => ({
          id: u.id,
          name: `${u.firstname} ${u.lastname}`,
          studentID: u.studentID,
        })),
        createdAt: serverTimestamp(),
        likeCount: 0,
        commentCount: 0,
      };

      if (attachedLink) {
        postData.link = attachedLink;
      }

      await addDoc(collection(db, "posts"), postData);

      Alert.alert("Success", "Your post has been created!");
      setContent("");
      setFiles([]);
      setTaggedUsers([]);
      setIsAnonymous(false);
      setAttachedLink(null);
      setSelectedGif(null);
      router.back();
    } catch (error: any) {
      console.error("Upload error:", error);
      Alert.alert("Error", error.message || "Failed to create post");
    } finally {
      setUploading(false);
    }
  };

  const handleTagUser = (student: Student) => {
    if (taggedUsers.find((u) => u.id === student.id)) {
      setTaggedUsers(taggedUsers.filter((u) => u.id !== student.id));
    } else {
      setTaggedUsers([...taggedUsers, student]);
    }
  };

  const handleAddLink = () => {
    if (!linkUrl.trim()) {
      Alert.alert("Error", "Please enter a valid URL");
      return;
    }

    const urlPattern =
      /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/;
    if (!urlPattern.test(linkUrl)) {
      Alert.alert("Invalid URL", "Please enter a valid website URL");
      return;
    }

    let formattedUrl = linkUrl.trim();
    if (
      !formattedUrl.startsWith("http://") &&
      !formattedUrl.startsWith("https://")
    ) {
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
      const response = await fetch(
        `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(
          query,
        )}&key=${API_KEY}&limit=${limit}&media_filter=gif`,
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.results && data.results.length > 0) {
        setGifResults(data.results);
      } else {
        setGifResults([]);
      }
    } catch (error) {
      console.error("Error searching GIFs:", error);
      setGifError(
        "Failed to search GIFs. Please check your internet connection and try again.",
      );
    } finally {
      setLoadingGifs(false);
    }
  };

  const handleSelectGif = (gifUrl: string) => {
    setSelectedGif(gifUrl);
    setShowGifModal(false);
    setGifSearchQuery("");
    setGifResults([]);
  };

  const filteredStudents = students.filter((s) => {
    const firstname = (s.firstname || "").toLowerCase();
    const lastname = (s.lastname || "").toLowerCase();
    const studentID = (s.studentID || "").toLowerCase();
    const search = searchQuery.toLowerCase();

    return (
      firstname.includes(search) ||
      lastname.includes(search) ||
      studentID.includes(search)
    );
  });

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Create Post</Text>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="close" size={28} color="#b8c7ff" />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scrollContent}
          contentContainerStyle={{ paddingBottom: 120 }}
          showsVerticalScrollIndicator={false}
        >
          {files.length > 0 && (
            <View style={styles.fileLimitInfo}>
              <Text style={styles.fileLimitText}>
                {files.length} / {MAX_FILES} files attached
              </Text>
            </View>
          )}

          <View style={styles.anonymousContainer}>
            <Text style={styles.anonymousLabel}>Post Anonymously</Text>
            <TouchableOpacity
              style={[styles.toggle, isAnonymous && styles.toggleActive]}
              onPress={() => setIsAnonymous(!isAnonymous)}
            >
              <View
                style={[
                  styles.toggleThumb,
                  isAnonymous && styles.toggleThumbActive,
                ]}
              />
            </TouchableOpacity>
          </View>

          {isAnonymous && (
            <Text style={styles.anonymousNote}>
              Note: Admins and moderators can still see your identity. Only
              students will see this as anonymous.
            </Text>
          )}

          <TextInput
            style={styles.input}
            placeholder="Share something with BondED..."
            placeholderTextColor="#a0a8c0"
            multiline
            value={content}
            onChangeText={setContent}
          />

          {selectedGif && (
            <View style={styles.gifPreview}>
              <Image source={{ uri: selectedGif }} style={styles.gifImage} />
              <TouchableOpacity
                style={styles.removeFile}
                onPress={() => setSelectedGif(null)}
              >
                <Ionicons name="close-circle" size={22} color="#ff5c93" />
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
              <TouchableOpacity onPress={() => setAttachedLink(null)}>
                <Ionicons name="close-circle" size={22} color="#ff5c93" />
              </TouchableOpacity>
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
                  ) : (
                    <View style={styles.documentPreview}>
                      <Ionicons
                        name="document-text"
                        size={40}
                        color="#4f9cff"
                      />
                      <Text style={styles.documentName} numberOfLines={1}>
                        {f.name}
                      </Text>
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.removeFile}
                    onPress={() =>
                      setFiles(files.filter((_, idx) => idx !== i))
                    }
                  >
                    <Ionicons name="close-circle" size={22} color="#ff5c93" />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* ✅ Show tagged users count */}
          {taggedUsers.length > 0 && (
            <View style={styles.taggedPreview}>
              <Ionicons name="people" size={16} color="#ff5c93" />
              <Text style={styles.taggedPreviewText}>
                Tagged {taggedUsers.length}{" "}
                {taggedUsers.length === 1 ? "person" : "people"}
              </Text>
            </View>
          )}

          <View style={styles.addToPostContainer}>
            <Text style={styles.addToPostLabel}>Add to your post</Text>
            <View style={styles.iconRow}>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={pickFiles}
                disabled={files.length >= MAX_FILES}
              >
                <Ionicons
                  name="images"
                  size={24}
                  color={files.length >= MAX_FILES ? "#5a6380" : "#4f9cff"}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={() => setShowTagModal(true)}
              >
                <Ionicons name="person-add" size={24} color="#a86fff" />
                {taggedUsers.length > 0 && (
                  <View style={styles.tagBadge}>
                    <Text style={styles.tagBadgeText}>
                      {taggedUsers.length}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={() => setShowLinkModal(true)}
              >
                <Ionicons name="link" size={24} color="#4f9cff" />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={() => setShowGifModal(true)}
              >
                <Ionicons name="gift" size={24} color="#ff9f43" />
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>

        <View
          style={[
            styles.footer,
            { paddingBottom: Math.max(insets.bottom, 16) },
          ]}
        >
          <TouchableOpacity
            style={[
              styles.postButton,
              !content.trim() &&
                files.length === 0 &&
                !selectedGif &&
                !attachedLink &&
                styles.disabledButton,
            ]}
            onPress={handlePost}
            disabled={
              (!content.trim() &&
                files.length === 0 &&
                !selectedGif &&
                !attachedLink) ||
              uploading
            }
          >
            {uploading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.postButtonText}>Post</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* ✅ Tag Modal (Updated) */}
        <Modal
          visible={showTagModal}
          animationType="slide"
          transparent
          onRequestClose={() => setShowTagModal(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContainer}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  Tag People{" "}
                  {taggedUsers.length > 0 && `(${taggedUsers.length})`}
                </Text>
                <TouchableOpacity onPress={() => setShowTagModal(false)}>
                  <Ionicons name="close" size={28} color="#b8c7ff" />
                </TouchableOpacity>
              </View>

              {/* ✅ Tag All button */}
              {students.length > 0 && (
                <TouchableOpacity
                  style={styles.tagAllButton}
                  onPress={() => {
                    // Tag all students (except already tagged)
                    const allTagged = students.filter(
                      (s) => !taggedUsers.find((u) => u.id === s.id),
                    );
                    if (allTagged.length === 0) {
                      Alert.alert("Info", "Everyone is already tagged!");
                      return;
                    }
                    setTaggedUsers([...taggedUsers, ...allTagged]);
                  }}
                >
                  <Ionicons name="people-circle" size={20} color="#fff" />
                  <Text style={styles.tagAllText}>Tag All</Text>
                </TouchableOpacity>
              )}

              <TextInput
                placeholder="Search students..."
                placeholderTextColor="#a0a8c0"
                value={searchQuery}
                onChangeText={setSearchQuery}
                style={styles.searchInput}
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
                      style={styles.studentItem}
                      onPress={() => handleTagUser(item)}
                    >
                      <View style={styles.studentAvatar}>
                        <Text style={styles.studentAvatarText}>
                          {firstname.charAt(0)}
                          {lastname.charAt(0)}
                        </Text>
                      </View>
                      <View style={styles.studentInfo}>
                        {/* ✅ Show full name only */}
                        <Text style={styles.studentName}>
                          {firstname} {lastname}
                        </Text>
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
          onRequestClose={() => setShowLinkModal(false)}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={styles.linkModalOverlay}
          >
            <View style={styles.linkModalContent}>
              <Text style={styles.linkModalTitle}>Add Link</Text>

              <TextInput
                placeholder="Enter URL (e.g., https://example.com)"
                placeholderTextColor="#a0a8c0"
                value={linkUrl}
                onChangeText={setLinkUrl}
                style={styles.linkInput}
                autoCapitalize="none"
                keyboardType="url"
              />

              <TextInput
                placeholder="Link title (optional)"
                placeholderTextColor="#a0a8c0"
                value={linkTitle}
                onChangeText={setLinkTitle}
                style={styles.linkInput}
              />

              <View style={styles.linkModalButtons}>
                <TouchableOpacity
                  style={[
                    styles.linkModalButton,
                    { backgroundColor: "#1b2235" },
                  ]}
                  onPress={() => {
                    setShowLinkModal(false);
                    setLinkUrl("");
                    setLinkTitle("");
                  }}
                >
                  <Text style={styles.linkModalButtonText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.linkModalButton,
                    { backgroundColor: "#ff5c93" },
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
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Choose a GIF</Text>
                <TouchableOpacity onPress={() => setShowGifModal(false)}>
                  <Ionicons name="close" size={28} color="#b8c7ff" />
                </TouchableOpacity>
              </View>

              <View style={styles.gifSearchContainer}>
                <TextInput
                  placeholder="Search GIFs..."
                  placeholderTextColor="#a0a8c0"
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
                  <Ionicons name="search" size={20} color="#fff" />
                </TouchableOpacity>
              </View>

              {loadingGifs ? (
                <View style={styles.gifLoadingContainer}>
                  <ActivityIndicator size="large" color="#ff5c93" />
                  <Text style={styles.gifLoadingText}>Searching GIFs...</Text>
                </View>
              ) : gifError ? (
                <View style={styles.gifErrorContainer}>
                  <Ionicons
                    name="cloud-offline-outline"
                    size={64}
                    color="#ff5c93"
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
                  data={gifResults}
                  numColumns={2}
                  keyExtractor={(item, index) => index.toString()}
                  renderItem={({ item }) => {
                    const gifUrl = item?.media_formats?.gif?.url;
                    const thumbnailUrl =
                      item?.media_formats?.tinygif?.url ||
                      item?.media_formats?.gif?.url;

                    if (!gifUrl || !thumbnailUrl) return null;

                    return (
                      <TouchableOpacity
                        style={styles.gifItem}
                        onPress={() => handleSelectGif(gifUrl)}
                      >
                        <Image
                          source={{ uri: thumbnailUrl }}
                          style={styles.gifThumbnail}
                          resizeMode="cover"
                        />
                      </TouchableOpacity>
                    );
                  }}
                  contentContainerStyle={styles.gifGrid}
                />
              ) : (
                <View style={styles.gifEmptyContainer}>
                  <Ionicons name="images-outline" size={64} color="#5a6380" />
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
    </SafeAreaView>
  );
};

export default CreatePostScreen;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0e1320" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
  },
  headerTitle: { color: "#b8c7ff", fontSize: 20, fontWeight: "bold" },
  scrollContent: { flex: 1, padding: 16 },
  fileLimitInfo: {
    backgroundColor: "#243054",
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  fileLimitText: {
    color: "#a0a8c0",
    fontSize: 13,
    textAlign: "center",
  },
  anonymousContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1b2235",
    padding: 14,
    borderRadius: 12,
  },
  anonymousLabel: { color: "#dbe1ff", fontSize: 15, fontWeight: "500" },
  anonymousNote: {
    color: "#8ea0d0",
    fontSize: 13,
    marginTop: 6,
    marginBottom: 14,
    lineHeight: 18,
  },
  toggle: {
    width: 48,
    height: 28,
    backgroundColor: "#3c4661",
    borderRadius: 14,
    justifyContent: "center",
    padding: 2,
  },
  toggleActive: { backgroundColor: "#ff5c93" },
  toggleThumb: {
    width: 24,
    height: 24,
    backgroundColor: "#fff",
    borderRadius: 12,
  },
  toggleThumbActive: { alignSelf: "flex-end" },
  input: {
    color: "#e9edff",
    fontSize: 16,
    minHeight: 120,
    textAlignVertical: "top",
    marginBottom: 16,
  },
  taggedPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#243054",
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
    gap: 8,
  },
  taggedPreviewText: {
    color: "#ff5c93",
    fontSize: 13,
    fontWeight: "500",
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

  gifPreview: {
    marginBottom: 12,
    position: "relative",
  },
  gifImage: {
    width: "100%",
    height: 250,
    borderRadius: 12,
  },
  linkPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#243054",
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#2a3548",
  },
  linkTitle: {
    color: "#e9edff",
    fontSize: 14,
    fontWeight: "600",
  },
  linkUrl: {
    color: "#8ea0d0",
    fontSize: 12,
    marginTop: 2,
  },
  filePreviewContainer: { gap: 10 },
  filePreview: {
    marginBottom: 10,
    position: "relative",
  },
  imagePreview: { width: "100%", height: 250, borderRadius: 12 },
  documentPreview: {
    backgroundColor: "#243054",
    padding: 20,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  documentName: {
    color: "#dbe1ff",
    fontSize: 13,
    marginTop: 8,
  },
  removeFile: { position: "absolute", top: 8, right: 8 },
  addToPostContainer: {
    backgroundColor: "#1b2235",
    padding: 14,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  addToPostLabel: { color: "#b8c7ff", fontSize: 15, fontWeight: "600" },
  iconRow: { flexDirection: "row", gap: 14 },
  iconButton: { padding: 6, position: "relative" },
  tagBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    backgroundColor: "#ff5c93",
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  tagBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "bold",
  },
  footer: {
    backgroundColor: "#0e1320",
    padding: 16,
    borderTopColor: "#1b2235",
    borderTopWidth: 1,
  },
  postButton: {
    backgroundColor: "#ff5c93",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  disabledButton: { opacity: 0.5 },
  postButtonText: { color: "#fff", fontSize: 16, fontWeight: "bold" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)" },
  modalContainer: {
    flex: 1,
    backgroundColor: "#10172b",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 20,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 16,
  },
  modalTitle: { color: "#b8c7ff", fontSize: 18, fontWeight: "bold" },
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
  studentAvatarText: { color: "#aebeff", fontWeight: "bold" },
  studentInfo: {
    flex: 1,
  },
  studentName: {
    color: "#e4e8ff",
    fontSize: 15,
    fontWeight: "500",
  },
  studentID: {
    color: "#8ea0d0",
    fontSize: 12,
    marginTop: 2,
  },
  emptyText: { color: "#8ea0d0", textAlign: "center", marginTop: 40 },
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
  },
  gifSearchButton: {
    backgroundColor: "#ff5c93",
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
    color: "#8ea0d0",
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
    paddingVertical: 60,
  },
  gifErrorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 60,
  },
  errorText: {
    color: "#8ea0d0",
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
    marginHorizontal: 20,
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: "#ff5c93",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 16,
  },
  retryButtonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
});

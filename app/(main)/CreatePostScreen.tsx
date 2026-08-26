//createpostscreen.tsx
import { Ionicons } from "@expo/vector-icons";
import ConfirmDialog from "./components/ConfirmDialog";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import {
  addDoc,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
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
  uploadPostVideo,
} from "@/utils/cloudinaryUpload";
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
import { requestAiReplyFromWorker, requestServerPostModeration } from "@/utils/aiWorker";
import {
  getModerationPreviewText,
  requestModerationDecision,
  requestImageModeration,
  requestVideoModeration,
} from "@/utils/contentModeration";
import { resolveUserRoleForAuthUser } from "@/utils/rbac";
import { canUsePostFlair, DEFAULT_POST_FLAIR, POST_FLAIRS, type PostFlairId } from "@/utils/postFlairs";

const MAX_FILES = 10;
// Keep the Python image-moderation integration available for later, but do not
// call it while BondED is not running the Python media service.
const IMAGE_MODERATION_ENABLED = false;

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

type CreatePostRouteParams = {
  serverId?: string | string[];
  channelId?: string | string[];
  serverName?: string | string[];
  channelLabel?: string | string[];
  editPostId?: string | string[];
};

const getSingleParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const CreatePostScreen = () => {
  const [content, setContent] = useState("");
  const [selectedFlair, setSelectedFlair] = useState<PostFlairId>(DEFAULT_POST_FLAIR);
  const [authorRole, setAuthorRole] = useState<string>("student");
  const [files, setFiles] = useState<
    { uri: string; mimeType: string; name: string }[]
  >([]);
  const [existingFiles, setExistingFiles] = useState<
    { url: string; mimeType: string; name?: string }[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const [blockedDialog, setBlockedDialog] = useState<{
    title: string;
    description: string;
  } | null>(null);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [taggedUsers, setTaggedUsers] = useState<Student[]>([]);
  const [showTagModal, setShowTagModal] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [contentSelection, setContentSelection] = useState({ start: 0, end: 0 });

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
      const resolvedRole = await resolveUserRoleForAuthUser(auth.currentUser);
      if (active) setAuthorRole(String(resolvedRole || "student").toLowerCase());
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
          Alert.alert("Post Not Found", "This post no longer exists.", [{ text: "OK", onPress: () => router.back() }]);
          return;
        }
        const data: any = snap.data();
        const ownerId = data.realUserId || data.userId;
        if (ownerId !== auth.currentUser?.uid) {
          Alert.alert("Access Denied", "You can only edit your own posts.", [{ text: "OK", onPress: () => router.back() }]);
          return;
        }
        setContent(data.content || "");
        setSelectedFlair((data.flair || DEFAULT_POST_FLAIR) as PostFlairId);
        setIsAnonymous(!!data.isAnonymous);
        setAttachedLink(data.link || null);
        setExistingFiles(Array.isArray(data.files) ? data.files : []);
        setTaggedUsers(Array.isArray(data.taggedUsers) ? data.taggedUsers.map((tag: any) => ({
          id: tag.id,
          firstname: tag.name || "User",
          lastname: "",
          email: "",
          studentID: tag.studentID || "",
        })) : []);
      } catch (error) {
        console.error("Error loading post for edit:", error);
        Alert.alert("Error", "Failed to load the post.", [{ text: "OK", onPress: () => router.back() }]);
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

  const takePhoto = async () => {
    try {
      if (files.length >= MAX_FILES) {
        Alert.alert(
          "Maximum Files Reached",
          `You can only attach up to ${MAX_FILES} files per post.`,
        );
        return;
      }

      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
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
      Alert.alert("Camera Error", "Failed to take a photo. Please try again.");
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

  const pickVideos = async () => {
    try {
      if (files.length >= MAX_FILES) {
        Alert.alert(
          "Maximum Files Reached",
          `You can only attach up to ${MAX_FILES} files per post.`,
        );
        return;
      }

      const result = await DocumentPicker.getDocumentAsync({
        type: "video/*",
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets?.length > 0) {
        const remainingSlots = MAX_FILES - files.length;
        const filesToAdd = result.assets.slice(0, remainingSlots);

        if (result.assets.length > remainingSlots) {
          Alert.alert(
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

        setFiles((current) => [...current, ...newVideos]);
      }
    } catch (error) {
      console.error("Error picking videos:", error);
      Alert.alert("Error", "Failed to pick video(s)");
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
      existingFiles.length === 0 &&
      !selectedGif &&
      !attachedLink
    ) {
      Alert.alert("Empty Post", "Please add content, a file, GIF, or link.");
      return;
    }
setUploading(true);

try {
  // ─────────────────────────────────────────────────────────────
  // STEP 1: AI MODERATE MEDIA BEFORE UPLOADING
  // approved = continue, review = pending queue, blocked = stop.
  let mediaRequiresReview = false;

  // STEP 2: UPLOAD MEDIA ONLY AFTER AI CHECK
  // ─────────────────────────────────────────────────────────────

  const uploadedUrls = [];

for (const file of files) {
  // ─────────────────────────────────────────────
  // IMAGE AI MODERATION
  // ─────────────────────────────────────────────
  if (IMAGE_MODERATION_ENABLED && file.mimeType.startsWith("image/")) {
    console.log("[Post Moderation] Checking image with Python AI...");

    const imageDecision = await requestImageModeration(file.uri);

    console.log(
      "[Post Moderation] Image AI result:",
      JSON.stringify(imageDecision),
    );

    if (imageDecision.decision === "blocked") {
      setBlockedDialog({
        title: "Post Blocked",
        description: "This image cannot be posted because it was detected as inappropriate.",
      });
      return;
    }

    if (imageDecision.decision === "review") {
      mediaRequiresReview = true;
    }
  }

  // ─────────────────────────────────────────────
  // VIDEO AI MODERATION
  // ─────────────────────────────────────────────
  if (file.mimeType.startsWith("video/")) {
    console.log("[Post Moderation] Checking video with Python AI...");

    const videoDecision = await requestVideoModeration(file.uri);

    console.log(
      "[Post Moderation] Video AI result:",
      JSON.stringify(videoDecision),
    );

    if (videoDecision.decision === "blocked") {
      setBlockedDialog({
        title: "Post Blocked",
        description: "This video cannot be posted because it was detected as inappropriate.",
      });
      return;
    }

    if (videoDecision.decision === "review") {
      mediaRequiresReview = true;
    }
  }

  // ─────────────────────────────────────────────
  // ONLY UPLOAD AFTER MEDIA MODERATION
  // ─────────────────────────────────────────────
  let uploadedUrl: string;

  if (file.mimeType.startsWith("image/")) {
    uploadedUrl = await uploadPostImage(file.uri);
  } else if (file.mimeType.startsWith("video/")) {
    uploadedUrl = await uploadPostVideo(file.uri);
  } else {
    uploadedUrl = await uploadPostFile(file.uri);
  }

  uploadedUrls.push({
    url: uploadedUrl,
    mimeType: file.mimeType,
  });
}

      if (selectedGif) {
        const uploadedGifUrl = await uploadPostGif(selectedGif);
        uploadedUrls.push({ url: uploadedGifUrl, mimeType: "image/gif" });
      }

      const user = auth.currentUser;

      const nextTaggedUsers = hasAiAssistantMention(content)
        ? taggedUsers.some((taggedUser) => isAiAssistantId(taggedUser.id))
          ? taggedUsers
          : [...taggedUsers, AI_ASSISTANT_STUDENT]
        : taggedUsers;
      const normalizedTaggedUsers = hasEveryoneMention(content)
        ? nextTaggedUsers.some((taggedUser) => isEveryoneMentionId(taggedUser.id))
          ? nextTaggedUsers
          : [...nextTaggedUsers, EVERYONE_MENTION_STUDENT]
        : nextTaggedUsers.filter((taggedUser) => !isEveryoneMentionId(taggedUser.id));

      const uniqueTaggedUsers = normalizedTaggedUsers.filter(
        (user, index, self) =>
          index === self.findIndex((u) => u.id === user.id),
      );
      let firstName = "";
      let lastName = "";

      if (!isAnonymous) {
        try {
          const studentsSnapshot = await getDocs(collection(db, "students"));
          const currentUid = user?.uid || "";
          const currentEmail = user?.email?.trim().toLowerCase() || "";
          const currentStudentID = currentEmail.split("@")[0];

          const currentStudent = studentsSnapshot.docs.find((studentDoc) => {
            const data = studentDoc.data();
            const docId = studentDoc.id.trim().toLowerCase();
            const dataUid = String(data.uid ?? data.userId ?? "").trim();
            const dataEmail = String(data.email ?? "").trim().toLowerCase();
            const dataStudentID = String(data.studentID ?? "").trim().toLowerCase();

            return (
              docId === currentUid.toLowerCase() ||
              dataUid === currentUid ||
              (currentEmail && dataEmail === currentEmail) ||
              (currentStudentID && dataStudentID === currentStudentID)
            );
          });

          if (currentStudent) {
            const data = currentStudent.data();
            firstName = String(data.firstname ?? data.firstName ?? "").trim();
            lastName = String(data.lastname ?? data.lastName ?? "").trim();
          }
        } catch (profileError) {
          console.warn("[CreatePost] Could not resolve student name:", profileError);
        }
      }

      const resolvedStudentName = `${firstName} ${lastName}`.trim();
      const displayName = isAnonymous
        ? `Anonymous${Math.floor(Math.random() * 10000)}`
        : resolvedStudentName || user?.displayName?.trim() || user?.email?.split("@")[0] || "User";
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
      
      const moderationDecision = await requestModerationDecision({
        // Text moderation must inspect only the actual user text.
        // A media-only post should not be turned into an artificial
        // "Empty Post" text by the AI context summarizer.
        text: content.trim(),
        scope: "post",
        serverId: selectedServerId,
        channelId: selectedChannelId,
        authorId: user?.uid,
        authorRole,
      });
      const localModerationStatus =
        moderationDecision.status === "pending" || mediaRequiresReview
          ? "pending"
          : moderationDecision.status;

      const finalModerationReasons = [
        ...moderationDecision.reasons,
        ...(mediaRequiresReview
          ? ["Media flagged for AI moderator review."]
          : []),
      ];

      // Local moderation can block obvious violations before any write.
      // Every non-rejected post is still written as PENDING. The trusted
      // Cloud Function is responsible for changing it to approved/rejected.
      const finalModerationStatus: "pending" | "rejected" =
        localModerationStatus === "rejected" ? "rejected" : "pending";

      // Rejected content must never be written to Firestore.
      // Pending content is intentionally written so it can appear in the
      // moderation queue, but it must remain hidden from user feeds.
      if (finalModerationStatus === "rejected") {
        setBlockedDialog({
          title: "Post Blocked",
          description:
            "This post was blocked because it contains restricted content. If you think this is a mistake, contact a moderator.",
        });
        return;
      }

      if (!canUsePostFlair(selectedFlair, authorRole)) {
        Alert.alert("Flair Not Allowed", "Announcement is reserved for authorized staff accounts.");
        return;
      }

      const postData: any = {
  content: content.trim(),
  flair: selectedFlair,
  files: uploadedUrls,

  // Keep the authenticated UID as the ownership identity even when the
  // public display is anonymous. Firestore rules depend on this invariant.
  userId: user?.uid,
  realUserId: user?.uid,

  username: displayName,
  authorName: displayName,
  aiPrompt,

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

  createdAt: serverTimestamp(),

  likeCount: 0,
  commentCount: 0,

  serverId: selectedServerId,
  channelId: selectedChannelId,

  moderationStatus: "pending",
  moderationReasons: finalModerationReasons,
  moderatedAtMs: null,
};
      if (attachedLink) {
        postData.link = attachedLink;
      }

      let postRef: any;
      if (isEditMode && selectedEditPostId) {
        await updateDoc(doc(db, "posts", selectedEditPostId), {
          content: content.trim(),
          flair: selectedFlair,
          files: uploadedUrls,
          taggedUsers: uniqueTaggedUsers.map((u) => ({
            id: u.id,
            name: isAiAssistantId(u.id) ? AI_ASSISTANT_NAME : isEveryoneMentionId(u.id) ? EVERYONE_MENTION_TAG.name : `${u.firstname} ${u.lastname}`.trim(),
            studentID: u.studentID,
          })),
          isAnonymous,
          aiPrompt,
          link: attachedLink || deleteField(),
          moderationStatus: "pending",
          moderationReasons: finalModerationReasons,
          moderatedAtMs: null,
          updatedAt: serverTimestamp(),
        });

        let serverDecision: any = { status: "pending" };
        try {
          serverDecision = await requestServerPostModeration(selectedEditPostId);
        } catch (moderationError) {
          console.warn("[CreatePost] Server moderation unavailable; post remains pending:", moderationError);
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

        Alert.alert(
          serverDecision.status === "approved" ? "Success" : "Sent For Review",
          serverDecision.status === "approved"
            ? "Your edited post has been updated and approved."
            : "Your edited post was sent for moderator review.",
        );
        router.back();
        return;
      }

      postRef = await addDoc(collection(db, "posts"), postData);

      // Firebase Spark has no deployable Cloud Functions. The post is always
      // created as PENDING, then the trusted Cloudflare Worker re-reads the
      // document and is the only non-staff path that can approve it. If the
      // Worker is unavailable, the post safely stays pending.
      let serverDecision: any = { status: "pending" };
      try {
        serverDecision = await requestServerPostModeration(postRef.id);
      } catch (moderationError) {
        console.warn("[CreatePost] Server moderation unavailable; post remains pending:", moderationError);
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

      Alert.alert(
        serverDecision.status === "approved" ? "Success" : "Sent For Review",
        serverDecision.status === "approved"
          ? "Your post has been created!"
          : "Your post was sent for moderator review and will appear after approval.",
      );
      setContent("");
      setSelectedFlair(DEFAULT_POST_FLAIR);
      setFiles([]);
      setTaggedUsers([]);
      setIsAnonymous(false);
      setAttachedLink(null);
      setSelectedGif(null);
      setContentSelection({ start: 0, end: 0 });
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

  const activeMentionMatch = content
    .slice(0, contentSelection.start)
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

  const handleContentChange = (nextText: string) => {
    setContent(nextText);
    syncTaggedUsersFromText(nextText);
  };

  const handleSelectMention = (person: MentionDraft) => {
    if (activeMentionIndex < 0) return;
    const before = content.slice(0, activeMentionIndex);
    const after = content.slice(contentSelection.start);
    const insertion = `${person.mentionToken} `;
    const nextText = `${before}${insertion}${after}`;
    setContent(nextText);
    setTaggedUsers((current) => {
      if (current.some((entry) => entry.id === person.id)) return current;
      return [...current, person];
    });
    const nextCursor = before.length + insertion.length;
    setContentSelection({ start: nextCursor, end: nextCursor });
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
  const autoTaggedUsers = hasAiAssistantMention(content)
    ? taggedUsers.some((entry) => isAiAssistantId(entry.id))
      ? taggedUsers
      : [...taggedUsers, AI_ASSISTANT_STUDENT]
    : taggedUsers;
  const effectiveTaggedUsers = hasEveryoneMention(content)
    ? autoTaggedUsers.some((entry) => isEveryoneMentionId(entry.id))
      ? autoTaggedUsers
      : [...autoTaggedUsers, EVERYONE_MENTION_STUDENT]
    : autoTaggedUsers.filter((entry) => !isEveryoneMentionId(entry.id));
  const everyoneMatchesSearch =
    !searchQuery.trim() ||
    EVERYONE_MENTION_NAME.toLowerCase().includes(searchQuery.toLowerCase()) ||
    EVERYONE_MENTION_TOKEN.slice(1).includes(searchQuery.toLowerCase()) ||
    "all".includes(searchQuery.toLowerCase());
  const filteredTagOptions = [
    ...(everyoneMatchesSearch ? [EVERYONE_MENTION_STUDENT] : []),
    ...filteredStudents.filter((student) => !isEveryoneMentionId(student.id)),
  ];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{isEditMode ? "Edit Post" : "Create Post"}</Text>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="close" size={28} color="#7a3b2e" />
          </TouchableOpacity>
        </View>

        <View style={styles.scopeCard}>
          <Ionicons
            name={selectedServerId ? "server-outline" : "home-outline"}
            size={18}
            color="#e0a53d"
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

          <View style={styles.flairSection}>
            <View style={styles.flairSectionHeader}>
              <Text style={styles.flairSectionTitle}>Post flair</Text>
              <Text style={styles.flairSectionHint}>Choose a category</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.flairPickerContent}>
              {POST_FLAIRS.filter((flair) => !flair.staffOnly || canUsePostFlair(flair.id, authorRole)).map((flair) => {
                const selected = selectedFlair === flair.id;
                return (
                  <TouchableOpacity key={flair.id} style={[styles.flairChoice, selected && styles.flairChoiceSelected]} activeOpacity={0.82} onPress={() => setSelectedFlair(flair.id)}>
                    <Text style={styles.flairChoiceEmoji}>{flair.emoji}</Text>
                    <Text style={[styles.flairChoiceText, selected && styles.flairChoiceTextSelected]}>{flair.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Share something with BondED..."
            placeholderTextColor="#a0a8c0"
            multiline
            value={content}
            onChangeText={handleContentChange}
            onSelectionChange={(event) =>
              setContentSelection(event.nativeEvent.selection)
            }
          />

          {mentionSuggestions.length > 0 && (
            <View style={styles.mentionSheet}>
              <Text style={styles.mentionLabel}>Mention someone</Text>
              {mentionSuggestions.slice(0, 5).map((person) => (
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

          {selectedGif && (
            <View style={styles.gifPreview}>
              <Image source={{ uri: selectedGif }} style={styles.gifImage} />
              <TouchableOpacity
                style={styles.removeFile}
                onPress={() => setSelectedGif(null)}
              >
                <Ionicons name="close-circle" size={22} color="#e0a53d" />
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
                <Ionicons name="close-circle" size={22} color="#e0a53d" />
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
                      <Ionicons name={f.mimeType?.startsWith("video/") ? "videocam" : "document-text"} size={40} color="#4f9cff" />
                      <Text style={styles.documentName} numberOfLines={1}>{f.name || "Attached file"}</Text>
                    </View>
                  )}
                  <TouchableOpacity style={styles.removeFile} onPress={() => setExistingFiles((current) => current.filter((_, idx) => idx !== i))}>
                    <Ionicons name="close-circle" size={22} color="#e0a53d" />
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
                    <Ionicons name="close-circle" size={22} color="#e0a53d" />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {effectiveTaggedUsers.length > 0 && (
            <View style={styles.taggedPreview}>
              <Ionicons name="people" size={16} color="#e0a53d" />
              <Text style={styles.taggedPreviewText}>
                Tagged {effectiveTaggedUsers.length}{" "}
                {effectiveTaggedUsers.length === 1 ? "mention" : "mentions"}
              </Text>
            </View>
          )}

          <View style={styles.addToPostContainer}>
            <Text style={styles.addToPostLabel}>Add to your post</Text>
            <View style={styles.iconRow}>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={takePhoto}
                disabled={files.length >= MAX_FILES}
                accessibilityLabel="Take a photo"
              >
                <Ionicons
                  name="camera"
                  size={24}
                  color={files.length >= MAX_FILES ? "#5a6380" : "#a61f1f"}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={pickFiles}
                disabled={files.length >= MAX_FILES}
                accessibilityLabel="Choose photos or files"
              >
                <Ionicons
                  name="images"
                  size={24}
                  color={files.length >= MAX_FILES ? "#5a6380" : "#4f9cff"}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={pickVideos}
                disabled={files.length >= MAX_FILES}
              >
                <Ionicons
                  name="videocam"
                  size={24}
                  color={files.length >= MAX_FILES ? "#5a6380" : "#7a0020"}
                />
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
              <Text style={styles.postButtonText}>{isEditMode ? "Save Changes" : "Post"}</Text>
            )}
          </TouchableOpacity>
        </View>

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
                  {effectiveTaggedUsers.length > 0 && `(${effectiveTaggedUsers.length})`}
                </Text>
                <TouchableOpacity onPress={() => setShowTagModal(false)}>
                  <Ionicons name="close" size={28} color="#7a3b2e" />
                </TouchableOpacity>
              </View>

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
                data={filteredTagOptions}
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
                          {isEveryoneMentionId(item.id)
                            ? "EV"
                            : `${firstname.charAt(0)}${lastname.charAt(0)}`}
                        </Text>
                      </View>
                      <View style={styles.studentInfo}>
                        <Text style={styles.studentName}>
                          {isEveryoneMentionId(item.id)
                            ? EVERYONE_MENTION_NAME
                            : `${firstname} ${lastname}`}
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
                    { backgroundColor: "#fffaf7" },
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
                    { backgroundColor: "#e0a53d" },
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
                  <Ionicons name="close" size={28} color="#7a3b2e" />
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
                  <ActivityIndicator size="large" color="#e0a53d" />
                  <Text style={styles.gifLoadingText}>Searching GIFs...</Text>
                </View>
              ) : gifError ? (
                <View style={styles.gifErrorContainer}>
                  <Ionicons
                    name="cloud-offline-outline"
                    size={64}
                    color="#e0a53d"
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
      </View>
      <ConfirmDialog
        visible={!!blockedDialog}
        title={blockedDialog?.title ?? ""}
        description={blockedDialog?.description}
        singleAction
        confirmText="OK"
        destructive
        onConfirm={() => setBlockedDialog(null)}
        onCancel={() => setBlockedDialog(null)}
      />
    </SafeAreaView>
  );
};

export default CreatePostScreen;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#5f0909" },
  contentShell: { flex: 1, backgroundColor: "#f6f1ed" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
  },
  headerTitle: { color: "#7a3b2e", fontSize: 20, fontWeight: "bold" },
  flairSection: { marginHorizontal: 16, marginBottom: 14 },
  flairSectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 9 },
  flairSectionTitle: { color: "#4d1b17", fontSize: 14, fontWeight: "800" },
  flairSectionHint: { color: "#9b766c", fontSize: 12, fontWeight: "600" },
  flairPickerContent: { gap: 8, paddingRight: 16 },
  flairChoice: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 18, backgroundColor: "#fffaf7", borderWidth: 1, borderColor: "#e5d4cc" },
  flairChoiceSelected: { backgroundColor: "#5f0909", borderColor: "#5f0909" },
  flairChoiceEmoji: { fontSize: 14 },
  flairChoiceText: { color: "#6f4a40", fontSize: 12, fontWeight: "700" },
  flairChoiceTextSelected: { color: "#ffffff" },
  scopeCard: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#eadbd4",
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
  scrollContent: { flex: 1, padding: 16 },
  fileLimitInfo: {
    backgroundColor: "#f0e7e2",
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  fileLimitText: {
    color: "#7a3b2e",
    fontSize: 13,
    textAlign: "center",
    fontWeight: "600",
  },
  anonymousContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fffaf7",
    padding: 14,
    borderRadius: 12,
  },
  anonymousLabel: { color: "#4d1b17", fontSize: 15, fontWeight: "600" },
  anonymousNote: {
    color: "#9b766c",
    fontSize: 13,
    marginTop: 6,
    marginBottom: 14,
    lineHeight: 18,
  },
  toggle: {
    width: 48,
    height: 28,
    backgroundColor: "#d6c9c2",
    borderRadius: 14,
    justifyContent: "center",
    padding: 2,
  },
  toggleActive: { backgroundColor: "#e0a53d" },
  toggleThumb: {
    width: 24,
    height: 24,
    backgroundColor: "#fff",
    borderRadius: 12,
  },
  toggleThumbActive: { alignSelf: "flex-end" },
  input: {
    color: "#4d1b17",
    fontSize: 16,
    minHeight: 120,
    textAlignVertical: "top",
    marginBottom: 12,
  },
  mentionSheet: {
    marginBottom: 14,
    backgroundColor: "#fff7f1",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#f0d2c2",
    overflow: "hidden",
  },
  mentionLabel: {
    color: "#9b766c",
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
    borderTopColor: "#f5e3d9",
  },
  mentionAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff0ea",
    marginRight: 10,
  },
  mentionAvatarAi: {
    backgroundColor: "#efe3ff",
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
  taggedPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f0e7e2",
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
    gap: 8,
  },
  taggedPreviewText: {
    color: "#7a3b2e",
    fontSize: 13,
    fontWeight: "600",
  },
  tagAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#e0a53d",
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
    backgroundColor: "#f0e7e2",
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#dfc9c1",
  },
  linkTitle: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "600",
  },
  linkUrl: {
    color: "#9b766c",
    fontSize: 12,
    marginTop: 2,
  },
  filePreviewContainer: { gap: 10 },
  filePreview: {
    marginBottom: 10,
    position: "relative",
  },
  videoPreview: {
    width: 110,
    height: 90,
    borderRadius: 12,
    backgroundColor: "#eef4ff",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  imagePreview: { width: "100%", height: 250, borderRadius: 12 },
  documentPreview: {
    backgroundColor: "#f0e7e2",
    padding: 20,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  documentName: {
    color: "#4d1b17",
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
  },
  removeFile: { position: "absolute", top: 8, right: 8 },
  addToPostContainer: {
    backgroundColor: "#fffaf7",
    padding: 14,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  addToPostLabel: { color: "#7a3b2e", fontSize: 15, fontWeight: "600" },
  iconRow: { flexDirection: "row", gap: 14 },
  iconButton: { padding: 6, position: "relative" },
  tagBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    backgroundColor: "#e0a53d",
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
    backgroundColor: "#f6f1ed",
    padding: 16,
    borderTopColor: "#fffaf7",
    borderTopWidth: 1,
  },
  postButton: {
    backgroundColor: "#e0a53d",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  disabledButton: { opacity: 0.5 },
  postButtonText: { color: "#fff", fontSize: 16, fontWeight: "bold" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)" },
  modalContainer: {
    flex: 1,
    backgroundColor: "#f5efeb",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 20,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 16,
  },
  modalTitle: { color: "#7a3b2e", fontSize: 18, fontWeight: "bold" },
  searchInput: {
    backgroundColor: "#fffaf7",
    color: "#4d1b17",
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
    backgroundColor: "#f0e7e2",
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  studentAvatarText: { color: "#7a3b2e", fontWeight: "bold" },
  studentInfo: {
    flex: 1,
  },
  studentName: {
    color: "#4d1b17",
    fontSize: 15,
    fontWeight: "600",
  },
  studentID: {
    color: "#9b766c",
    fontSize: 12,
    marginTop: 2,
  },
  emptyText: { color: "#9b766c", textAlign: "center", marginTop: 40 },
  linkModalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  linkModalContent: {
    width: "85%",
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    padding: 20,
  },
  linkModalTitle: {
    color: "#7a3b2e",
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 16,
    textAlign: "center",
  },
  linkInput: {
    backgroundColor: "#f0e7e2",
    color: "#4d1b17",
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#dfc9c1",
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
    backgroundColor: "#e0a53d",
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
    color: "#9b766c",
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
    color: "#9b766c",
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
    marginHorizontal: 20,
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: "#e0a53d",
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

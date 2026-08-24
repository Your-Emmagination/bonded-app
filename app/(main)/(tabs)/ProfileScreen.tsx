/* eslint-disable react-hooks/exhaustive-deps */
import { uploadProfileImage } from "@/utils/cloudinaryUpload";
import ImageZoomViewer from "../components/ImageZoomViewer";
import PostCard from "../components/PostCard";
import CommentModal from "../components/CommentModal";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import DateTimePicker from "@react-native-community/datetimepicker";
import {
  EmailAuthProvider,
  User as FirebaseUser,
  reauthenticateWithCredential,
  signOut,
  updatePassword,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  increment,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import DropDownPicker from "react-native-dropdown-picker";

import { getProfileIdLabel } from "@/utils/profileLabels";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import {
  removeLikeNotification,
  upsertLikeNotification,
} from "@/utils/notifications";
import { resolveUserRoleForAuthUser, UserRole } from "@/utils/rbac";
import { useRelativeTimeNow } from "@/utils/relativeTime";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { AVATAR_SIZE_LARGE, avatarThumb } from "@/utils/cloudinaryImages";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  BackHandler,
  Image,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";

type Student = {
  firstname?: string;
  lastname?: string;
  course?: string;
  yearlvl?: string;
  studentID?: string;
  email?: string;
  profileImage?: string;
  isOnline?: boolean;
  role?: string;
};

type TabKey = "info" | "password" | "photo";

type EditData = {
  yearlvl?: string;
  email?: string;
  currentPassword?: string;
  newPassword?: string;
  selectedTab?: TabKey;
};

type TaggedUser = { id: string; name: string; studentID: string };
type FileAttachment = { url: string; mimeType: string; name?: string };

type Post = {
  id: string;
  content?: string;
  imageUrl?: string;
  files?: FileAttachment[];
  link?: { url: string; title: string };
  username?: string;
  authorName?: string;
  userId?: string;
  realUserId?: string;
  isAnonymous?: boolean;
  taggedUsers?: TaggedUser[];
  createdAt?: any;
  likeCount?: number;
  commentCount?: number;
  likedBy?: string[];
  bookmarkedBy?: string[];
  role?: string;
  moderationStatus?: string;
};

type PostSortOption = "newest" | "oldest" | "mostLiked" | "mostCommented";

const POST_SORT_OPTIONS: { key: PostSortOption; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "mostLiked", label: "Most liked" },
  { key: "mostCommented", label: "Most commented" },
];

const PROFILE_RETURN_ROUTE = "/(main)/(tabs)/ProfileScreen";

const isSameCalendarDay = (timestamp: any, target: Date): boolean => {
  if (!timestamp || typeof timestamp.toDate !== "function") return false;
  const date = timestamp.toDate();
  return (
    date.getFullYear() === target.getFullYear() &&
    date.getMonth() === target.getMonth() &&
    date.getDate() === target.getDate()
  );
};

// A post's own document has no field indicating it's still awaiting
// review — that's what moderationStatus tracks. Approved (or legacy posts
// with no moderationStatus at all) are the only ones visible here, same
// rule Home and Saved Posts already use.
const isApprovedPost = (post: Post): boolean => {
  const status = post.moderationStatus;
  return !status || status === "approved";
};

const TABS: {
  key: TabKey;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: "info", label: "Edit Info", icon: "create-outline" },
  { key: "password", label: "Change Password", icon: "lock-closed-outline" },
  { key: "photo", label: "Change Photo", icon: "camera-outline" },
];

const ProfileScreen = () => {
  const { returnTo } = useLocalSearchParams<{ returnTo?: string | string[] }>();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  const [editedData, setEditedData] = useState<EditData>({
    selectedTab: "info",
  });
  const [profileImage, setProfileImage] = useState<string>();
  const [pendingProfileImage, setPendingProfileImage] = useState<string | null>(null);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [viewImageVisible, setViewImageVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const router = useRouter();
  const navigation = useNavigation();
  const resolvedReturnTo = Array.isArray(returnTo) ? returnTo[0] : returnTo;
  const canNavigateBack = navigation.canGoBack() || !!resolvedReturnTo;

  // ─── My Posts ─────────────────────────────────────────────────────────
  const [currentUserRole, setCurrentUserRole] = useState<UserRole | undefined>();
  const [myPosts, setMyPosts] = useState<Post[]>([]);
  const [myPostsLoading, setMyPostsLoading] = useState(true);
  const [postSearchQuery, setPostSearchQuery] = useState("");
  const [postSortOption, setPostSortOption] = useState<PostSortOption>("newest");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [selectedDateFilter, setSelectedDateFilter] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [commentModalPostId, setCommentModalPostId] = useState<string | null>(null);
  const [postImageViewerVisible, setPostImageViewerVisible] = useState(false);
  const [postImages, setPostImages] = useState<string[]>([]);
  const [postImageIndex, setPostImageIndex] = useState(0);
  const [postImageViewerPostId, setPostImageViewerPostId] = useState<string | null>(null);
  const likeInFlightRef = useRef<Set<string>>(new Set());
  const relativeTimeNow = useRelativeTimeNow();

  const imageUri = useMemo(
    () => profileImage ?? student?.profileImage,
    [profileImage, student?.profileImage],
  );
  const fullName = useMemo(
    () =>
      `${student?.firstname ?? ""} ${student?.lastname ?? ""}`.trim() ||
      "Anonymous",
    [student?.firstname, student?.lastname],
  );
  const studentIdDisplay = useMemo(
    () => student?.studentID ?? user?.email?.split("@")[0] ?? "—",
    [student?.studentID, user?.email],
  );

  const profileIdLabel = useMemo(
    () => getProfileIdLabel(student?.role),
    [student?.role],
  );

  // Live listener on the signed-in user's own posts. realUserId is always
  // set to the true auth uid on creation (even for anonymous posts), so a
  // single query covers both anonymous and regular posts.
  useEffect(() => {
    if (!user?.uid) {
      setMyPosts([]);
      setMyPostsLoading(false);
      return;
    }

    setMyPostsLoading(true);
    const q = query(collection(db, "posts"), where("realUserId", "==", user.uid));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setMyPosts(snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() } as Post)));
        setMyPostsLoading(false);
      },
      (error) => {
        console.error("Error loading your posts:", error);
        setMyPostsLoading(false);
      },
    );
    return unsubscribe;
  }, [user?.uid]);

  useEffect(() => {
    if (!user) {
      setCurrentUserRole(undefined);
      return;
    }
    resolveUserRoleForAuthUser(user).then((role) => setCurrentUserRole(role as UserRole));
  }, [user]);

  const approvedMyPosts = useMemo(() => myPosts.filter(isApprovedPost), [myPosts]);

  const visiblePosts = useMemo(() => {
    const trimmedQuery = postSearchQuery.trim().toLowerCase();

    const filtered = approvedMyPosts.filter((post) => {
      if (trimmedQuery && !post.content?.toLowerCase().includes(trimmedQuery)) {
        return false;
      }
      if (selectedDateFilter && !isSameCalendarDay(post.createdAt, selectedDateFilter)) {
        return false;
      }
      return true;
    });

    const getMillis = (timestamp: any) =>
      timestamp && typeof timestamp.toMillis === "function" ? timestamp.toMillis() : 0;

    const sorted = [...filtered];
    switch (postSortOption) {
      case "oldest":
        sorted.sort((a, b) => getMillis(a.createdAt) - getMillis(b.createdAt));
        break;
      case "mostLiked":
        sorted.sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0));
        break;
      case "mostCommented":
        sorted.sort((a, b) => (b.commentCount ?? 0) - (a.commentCount ?? 0));
        break;
      case "newest":
      default:
        sorted.sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt));
        break;
    }
    return sorted;
  }, [approvedMyPosts, postSearchQuery, postSortOption, selectedDateFilter]);

  const getTimeAgo = useCallback(
    (timestamp: any) => {
      if (!timestamp || typeof timestamp.toDate !== "function") return "";
      const now = new Date(relativeTimeNow);
      const postDate = timestamp.toDate();
      const diffMs = now.getTime() - postDate.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHour = Math.floor(diffMin / 60);

      if (diffSec < 60) return "Just now";
      if (diffMin < 60) return `${diffMin}m`;
      if (isSameCalendarDay(timestamp, now)) return `${diffHour}h`;

      const timePart = postDate.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });

      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (isSameCalendarDay(timestamp, yesterday)) {
        return `Yesterday at ${timePart}`;
      }

      const datePart = postDate.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      });

      if (postDate.getFullYear() === now.getFullYear()) {
        return `${datePart} at ${timePart}`;
      }

      return `${datePart}, ${postDate.getFullYear()}`;
    },
    [relativeTimeNow],
  );

  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;

    const unsubscribeAuth = auth.onAuthStateChanged((currentUser) => {
      setUser(currentUser);

      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }

      if (currentUser) {
        const email = currentUser.email ?? "";
        const studentID = email.split("@")[0] || currentUser.uid;

        setDoc(doc(db, "students", studentID), { isOnline: true }, { merge: true }).catch(
          (error) => console.error("Error setting online status:", error),
        );

        unsubscribeProfile = onSnapshot(
          doc(db, "students", studentID),
          (docSnapshot) => {
            if (docSnapshot.exists()) {
              const data = docSnapshot.data() as Student;
              setStudent(data);
              setProfileImage(data.profileImage);
              setEditedData((prev) => ({
                ...prev,
                yearlvl: data.yearlvl,
                email: data.email || "",
              }));
            }
          },
          (error) => {
            if (auth.currentUser) {
              console.error("Error listening to profile:", error);
            }
          },
        );
      } else {
        setStudent(null);
        setProfileImage(undefined);
      }
    });

    return () => {
      if (unsubscribeProfile) unsubscribeProfile();
      unsubscribeAuth();
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      async (nextAppState) => {
        if (!user || !auth.currentUser) return;

        const email = user.email ?? "";
        const studentID = email.split("@")[0] || user.uid;

        try {
          const isOnline = nextAppState === "active";
          await setDoc(doc(db, "students", studentID), { isOnline }, { merge: true });
        } catch (error) {
          console.error("Error updating online status:", error);
        }
      },
    );

    return () => {
      subscription.remove();
    };
  }, [user]);

  // ─── My Posts: handlers ─────────────────────────────────────────────
  const deleteCommentTree = useCallback(async (parentId: string) => {
    const commentsSnapshot = await getDocs(
      query(collection(db, "comments"), where("postId", "==", parentId)),
    );
    await Promise.all(
      commentsSnapshot.docs.map(async (commentDoc) => {
        const repliesSnapshot = await getDocs(
          query(collection(db, "replies"), where("commentId", "==", commentDoc.id)),
        );
        await Promise.all(repliesSnapshot.docs.map((replyDoc) => deleteDoc(replyDoc.ref)));
        await deleteDoc(commentDoc.ref);
      }),
    );
  }, []);

  const handleLike = useCallback(
    async (postId: string, currentLikedBy: string[] = []) => {
      if (!user) return;
      if (likeInFlightRef.current.has(postId)) return;
      likeInFlightRef.current.add(postId);

      const post = myPosts.find((p) => p.id === postId);
      const hasLiked = currentLikedBy.includes(user.uid);
      const postRef = doc(db, "posts", postId);
      const postOwnerId = post?.realUserId || post?.userId;
      const actorName = user.displayName || user.email?.split("@")[0] || "Someone";

      try {
        await updateDoc(postRef, {
          likedBy: hasLiked
            ? currentLikedBy.filter((id) => id !== user.uid)
            : [...currentLikedBy, user.uid],
          likeCount: increment(hasLiked ? -1 : 1),
        });

        if (hasLiked) {
          await removeLikeNotification({
            recipientId: postOwnerId,
            actorId: user.uid,
            entityType: "post",
            entityId: postId,
          });
        } else {
          await upsertLikeNotification({
            recipientId: postOwnerId,
            actor: { id: user.uid, name: actorName, profileImage: null },
            entityType: "post",
            entityId: postId,
            preview: post?.content,
          });
        }
      } catch (error) {
        console.error("Error liking post:", error);
      } finally {
        likeInFlightRef.current.delete(postId);
      }
    },
    [myPosts, user],
  );

  const handleEditPost = useCallback(
    (postId: string) => {
      router.push({ pathname: "/CreatePostScreen", params: { editPostId: postId } });
    },
    [router],
  );

  const handleDeletePost = useCallback(
    (postId: string) => {
      Alert.alert(
        "Delete Post",
        "This will permanently remove the post, comments, and replies.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await deleteCommentTree(postId);
                await deleteDoc(doc(db, "posts", postId));
              } catch (error) {
                console.error("Error deleting post:", error);
                Alert.alert("Error", "Failed to delete post.");
              }
            },
          },
        ],
      );
    },
    [deleteCommentTree],
  );

  const openPostImageViewer = useCallback(
    (images: string[], startIndex: number, postId?: string) => {
      setPostImages(images);
      setPostImageIndex(startIndex);
      setPostImageViewerPostId(postId ?? null);
      setPostImageViewerVisible(true);
    },
    [],
  );

  const handlePostFilePress = useCallback(
    (url: string, mimeType: string) => {
      if (mimeType.startsWith("image/")) {
        openPostImageViewer([url], 0);
        return;
      }
      let fileUrl = url;
      if (mimeType.includes("pdf") && url.includes("cloudinary.com")) {
        fileUrl = url.replace("/upload/", "/upload/fl_attachment/");
      }
      Linking.canOpenURL(fileUrl)
        .then((supported) => {
          if (supported) Linking.openURL(fileUrl);
        })
        .catch((err) => console.error("Error opening URL:", err));
    },
    [openPostImageViewer],
  );

  const handlePostProfileClick = useCallback(
    (targetId?: string) => {
      if (!targetId || targetId === user?.uid) return; // already on own profile
      router.push(
        buildUserProfileHref({ userId: targetId, returnTo: PROFILE_RETURN_ROUTE }) as any,
      );
    },
    [router, user?.uid],
  );

  const handlePostTagClick = useCallback(
    (taggedUserId: string) => {
      if (taggedUserId === user?.uid) return;
      router.push(
        buildUserProfileHref({ userId: taggedUserId, returnTo: PROFILE_RETURN_ROUTE }) as any,
      );
    },
    [router, user?.uid],
  );

  const postImageViewerPost = postImageViewerPostId
    ? myPosts.find((p) => p.id === postImageViewerPostId)
    : undefined;

  const handleDateFilterChange = useCallback((_event: any, date?: Date) => {
    setShowDatePicker(Platform.OS === "ios");
    if (date) setSelectedDateFilter(date);
  }, []);

  const updateStudent = useCallback(
    async (data: Partial<Student>) => {
      if (!student?.studentID || !auth.currentUser) return;

      try {
        const payload = { ...data };
        if (
          payload.email?.endsWith("@student.csap") ||
          payload.email?.endsWith("@teacher.csap") ||
          payload.email?.endsWith("@admin.csap")
        ) {
          delete payload.email;
        }

        await updateDoc(doc(db, "students", student.studentID), payload);
        setStudent((prev) => (prev ? { ...prev, ...payload } : prev));
      } catch (error) {
        console.error("Error updating student:", error);
        throw error;
      }
    },
    [student?.studentID],
  );

  const handleImagePick = useCallback(
    async (useCamera = false) => {
      setLoading(true);
      try {
        const permission = useCamera
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

        if (permission.status !== "granted") {
          Alert.alert(
            "Permission required",
            `Allow ${useCamera ? "camera" : "photo"} access.`,
          );
          return;
        }

        const result = await (
          useCamera
            ? ImagePicker.launchCameraAsync
            : ImagePicker.launchImageLibraryAsync
        )({
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
        });

        if (!result.canceled && result.assets?.[0]?.uri) {
          setPendingProfileImage(result.assets[0].uri);
          setEditModalVisible(true);
        }
      } catch (error: any) {
        Alert.alert("Error", `Failed to update photo: ${error.message}`);
      } finally {
        setLoading(false);
      }
    },
    [updateStudent],
  );

  const commitPendingProfileImage = useCallback(async () => {
    if (!pendingProfileImage) return;
    setLoading(true);
    try {
      const cloudinaryUrl = await uploadProfileImage(pendingProfileImage);
      await updateStudent({ profileImage: cloudinaryUrl });
      setProfileImage(cloudinaryUrl);
      setPendingProfileImage(null);
      setEditModalVisible(false);
      Alert.alert("Success", "Profile photo updated!");
    } catch (error: any) {
      Alert.alert("Error", `Failed to update photo: ${error?.message || "Please try again."}`);
    } finally {
      setLoading(false);
    }
  }, [pendingProfileImage, updateStudent]);

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
      const credential = EmailAuthProvider.credential(
        user.email || "",
        currentPassword,
      );
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPassword);
      Alert.alert("Success", "Password changed successfully!");
      setEditedData((prev) => ({
        ...prev,
        currentPassword: "",
        newPassword: "",
      }));
    } catch (error: any) {
      Alert.alert("Error", error.message || "Failed to change password");
    }
  }, [user, editedData.currentPassword, editedData.newPassword]);

  const handleLogout = useCallback(async () => {
    let confirmed: boolean;

    if (Platform.OS === "web") {
      confirmed = window.confirm("Are you sure you want to log out?");
    } else {
      confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          "Log Out",
          "Are you sure you want to log out?",
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            {
              text: "Log Out",
              style: "destructive",
              onPress: () => resolve(true),
            },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      });
    }

    if (!confirmed) return;

    try {
      if (user) {
        const email = user.email ?? "";
        const studentID = email.split("@")[0] || user.uid;
        if (studentID) {
          try {
            await setDoc(
              doc(db, "students", studentID),
              { isOnline: false },
              { merge: true },
            );
          } catch (err) {
            console.warn("Offline status failed:", err);
          }
        }
      }

      await signOut(auth);

      if (Platform.OS === "web") {
        window.location.replace("/LoginScreen");
      } else {
        router.replace("/LoginScreen");
      }
    } catch (e: any) {
      console.error("Logout failed:", e);
      if (Platform.OS !== "web") {
        Alert.alert("Error", "Failed to log out. Please try again.");
      } else {
        alert("Failed to log out: " + (e.message || "Unknown error"));
      }
    }
  }, [user, router]);

  const openModal = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      friction: 7,
      tension: 40,
    }).start();
  }, [scaleAnim]);

  const closeModal = useCallback(() => {
    Animated.timing(scaleAnim, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start(() => setEditModalVisible(false));
  }, [scaleAnim]);

  const openImageViewer = useCallback(() => {
    if (imageUri) {
      setViewImageVisible(true);
    } else {
      setEditedData((prev) => ({ ...prev, selectedTab: "photo" }));
      setEditModalVisible(true);
    }
  }, [imageUri]);

  const handleTabChange = useCallback((key: TabKey) => {
    setEditedData((prev) => ({ ...prev, selectedTab: key }));
  }, []);

  const handleScreenBack = useCallback(() => {
    if (viewImageVisible) {
      setViewImageVisible(false);
      return true;
    }

    if (editModalVisible) {
      closeModal();
      return true;
    }

    if (navigation.canGoBack()) {
      navigation.goBack();
      return true;
    }

    if (resolvedReturnTo) {
      router.replace(resolvedReturnTo as any);
      return true;
    }

    return false;
  }, [
    closeModal,
    editModalVisible,
    navigation,
    resolvedReturnTo,
    router,
    viewImageVisible,
  ]);

  const updateEditedData = useCallback(
    (field: keyof EditData, value: string) => {
      setEditedData((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        handleScreenBack,
      );

      return () => subscription.remove();
    }, [handleScreenBack]),
  );

  const displayEmail =
    student?.email &&
    !student.email.endsWith("@student.csap") &&
    !student.email.endsWith("@teacher.csap") &&
    !student.email.endsWith("@admin.csap")
      ? student.email
      : "No email added";

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
        {/* Header Block */}
        <View style={styles.headerShell}>
          <View style={styles.headerRow}>
            {canNavigateBack ? (
              <TouchableOpacity
                style={styles.headerBackButton}
                onPress={() => {
                  void handleScreenBack();
                }}
                activeOpacity={0.7}
              >
                <Ionicons name="arrow-back" size={20} color="#fffaf7" />
              </TouchableOpacity>
            ) : (
              <View style={styles.headerBackSpacer} />
            )}

            <View style={styles.headerCopy}>
              <Text style={styles.header}>Profile</Text>
              <Text style={styles.headerSubtext}>
                Manage your account, status, and photo
              </Text>
            </View>

            <View style={styles.headerBackSpacer} />
          </View>
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Profile Header Card */}
          <View style={styles.profileCard}>
            <TouchableOpacity
              onPress={openImageViewer}
              onLongPress={() => {
                handleTabChange("photo");
                setEditModalVisible(true);
              }}
              disabled={loading}
              activeOpacity={0.88}
              style={styles.avatarWrapper}
            >
              {imageUri ? (
                <Image source={{ uri: avatarThumb(imageUri, AVATAR_SIZE_LARGE) }} style={styles.profileImage} />
              ) : (
                <View style={styles.placeholder}>
                  <Ionicons name="person" size={48} color="#e0a53d" />
                </View>
              )}
              <View style={styles.editBadge}>
                <Ionicons name="camera" size={14} color="#fff" />
              </View>
              <View
                style={[
                  styles.statusBadge,
                  { backgroundColor: student?.isOnline ? "#00e676" : "#999" },
                ]}
              />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.statusBtn}
              onPress={toggleOnlineStatus}
              activeOpacity={0.75}
            >
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: student?.isOnline ? "#00e676" : "#999" },
                ]}
              />
              <Text
                style={{
                  color: student?.isOnline ? "#00e676" : "#c4a39b",
                  fontWeight: "600",
                }}
              >
                {student?.isOnline ? "Online" : "Offline"}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Grouped Personal Information Card */}
<View style={styles.section}>
  <View style={styles.sectionTitleRow}>
    <Ionicons name="person" size={18} color="#5f0909" />
    <Text style={styles.sectionTitle}>Personal Information</Text>
  </View>
  <View style={styles.goldCard}>
    <CardItemRow
      icon="person-outline"
      label="Full Name"
      value={fullName}
      isLocked={true}
    />
    <View style={styles.rowDivider} />
    {/* No lock, no chevron — edited cleanly via Edit Profile button */}
    <CardItemRow
      icon="mail-outline"
      label="Email Address"
      value={displayEmail}
      isLocked={false}
    />
  </View>
</View>

{/* Grouped Academic Information Card */}
<View style={styles.section}>
  <View style={styles.sectionTitleRow}>
    <Ionicons name="school" size={18} color="#5f0909" />
    <Text style={styles.sectionTitle}>Academic Information</Text>
  </View>
  <View style={styles.goldCard}>
    <CardItemRow
      icon="school-outline"
      label="Course / Program"
      value={student?.course ?? "—"}
      isLocked={true}
    />
    <View style={styles.rowDivider} />
    {/* Locked: Year level auto-increments or managed by admin */}
    <CardItemRow
      icon="trending-up-outline"
      label="Year Level"
      value={student?.yearlvl ?? "—"}
      isLocked={true}
    />
    <View style={styles.rowDivider} />
    <CardItemRow
      icon="card-outline"
      label={profileIdLabel}
      value={studentIdDisplay}
      isLocked={true}
    />
  </View>
</View>

          {/* Actions Section */}
          <View style={styles.section}>
            <ActionButton
              icon="create-outline"
              text="Edit Profile"
              onPress={() => setEditModalVisible(true)}
            />
            <ActionButton
              icon="bookmark-outline"
              text="Saved Posts"
              onPress={() => router.push("/(main)/BookmarksScreen" as any)}
            />
            <ActionButton
              icon="settings-outline"
              text="Settings"
              onPress={() => router.push("/(main)/SettingsScreen" as any)}
            />
            <ActionButton
              icon="log-out-outline"
              text="Log Out"
              onPress={handleLogout}
            />
          </View>

          {/* My Posts Section */}
          <View style={styles.section}>
            <View style={styles.sectionTitleRow}>
              <Ionicons name="grid-outline" size={18} color="#5f0909" />
              <Text style={styles.sectionTitle}>My Posts</Text>
            </View>

            {/* Toolbar: search, sort, date filter */}
            <View style={styles.postsToolbar}>
              <View style={styles.searchBar}>
                <Ionicons name="search-outline" size={16} color="#b88f87" />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search your posts"
                  placeholderTextColor="#b88f87"
                  value={postSearchQuery}
                  onChangeText={setPostSearchQuery}
                  returnKeyType="search"
                />
                {postSearchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setPostSearchQuery("")}>
                    <Ionicons name="close-circle" size={16} color="#b88f87" />
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.toolbarRow}>
                <TouchableOpacity
                  style={styles.toolbarChip}
                  onPress={() => setShowSortMenu(true)}
                  activeOpacity={0.75}
                >
                  <Ionicons name="swap-vertical-outline" size={14} color="#5f0909" />
                  <Text style={styles.toolbarChipText}>
                    {POST_SORT_OPTIONS.find((o) => o.key === postSortOption)?.label}
                  </Text>
                  <Ionicons name="chevron-down" size={14} color="#5f0909" />
                </TouchableOpacity>

                {selectedDateFilter ? (
                  <View style={[styles.toolbarChip, styles.toolbarChipActive]}>
                    <Ionicons name="calendar-outline" size={14} color="#fffaf7" />
                    <Text style={[styles.toolbarChipText, styles.toolbarChipTextActive]}>
                      {selectedDateFilter.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </Text>
                    <TouchableOpacity onPress={() => setSelectedDateFilter(null)}>
                      <Ionicons name="close" size={14} color="#fffaf7" />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.toolbarChip}
                    onPress={() => setShowDatePicker(true)}
                    activeOpacity={0.75}
                  >
                    <Ionicons name="calendar-outline" size={14} color="#5f0909" />
                    <Text style={styles.toolbarChipText}>Date</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {showDatePicker && (
              <DateTimePicker
                value={selectedDateFilter ?? new Date()}
                mode="date"
                display="default"
                maximumDate={new Date()}
                onChange={handleDateFilterChange}
              />
            )}

            {/* Post list */}
            {myPostsLoading ? (
              <View style={styles.postsEmptyState}>
                <ActivityIndicator size="small" color="#a61f1f" />
              </View>
            ) : myPosts.length === 0 ? (
              <View style={styles.postsEmptyState}>
                <Ionicons name="albums-outline" size={32} color="#c9a89c" />
                <Text style={styles.postsEmptyTitle}>You haven't posted anything yet</Text>
              </View>
            ) : approvedMyPosts.length === 0 ? (
              <View style={styles.postsEmptyState}>
                <Ionicons name="time-outline" size={32} color="#c9a89c" />
                <Text style={styles.postsEmptyTitle}>
                  Your post{myPosts.length > 1 ? "s are" : " is"} awaiting moderator review
                </Text>
              </View>
            ) : visiblePosts.length === 0 ? (
              <View style={styles.postsEmptyState}>
                <Ionicons name="search-outline" size={32} color="#c9a89c" />
                <Text style={styles.postsEmptyTitle}>No posts match your filters</Text>
                <TouchableOpacity
                  onPress={() => {
                    setPostSearchQuery("");
                    setSelectedDateFilter(null);
                  }}
                >
                  <Text style={styles.postsClearFiltersText}>Clear filters</Text>
                </TouchableOpacity>
              </View>
            ) : (
              visiblePosts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post as any}
                  isLiked={post.likedBy?.includes(user?.uid || "") || false}
                  currentUserRole={currentUserRole}
                  currentUserId={user?.uid}
                  onLike={handleLike}
                  onProfileClick={handlePostProfileClick}
                  onTagClick={handlePostTagClick}
                  onImagePress={openPostImageViewer}
                  onFilePress={handlePostFilePress}
                  getTimeAgo={getTimeAgo}
                  onCommentPress={(postId) => setCommentModalPostId(postId)}
                  onEdit={handleEditPost}
                  onDelete={handleDeletePost}
                />
              ))
            )}
          </View>
        </ScrollView>
      </View>

      {/* Sort options menu */}
      <Modal
        visible={showSortMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSortMenu(false)}
      >
        <TouchableOpacity
          style={styles.sortMenuBackdrop}
          activeOpacity={1}
          onPress={() => setShowSortMenu(false)}
        >
          <View style={styles.sortMenuCard}>
            {POST_SORT_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.key}
                style={styles.sortMenuOption}
                onPress={() => {
                  setPostSortOption(option.key);
                  setShowSortMenu(false);
                }}
              >
                <Text
                  style={[
                    styles.sortMenuOptionText,
                    postSortOption === option.key && styles.sortMenuOptionTextActive,
                  ]}
                >
                  {option.label}
                </Text>
                {postSortOption === option.key && (
                  <Ionicons name="checkmark" size={16} color="#a61f1f" />
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Comment Modal for My Posts */}
      {commentModalPostId && user?.uid && (
        <CommentModal
          visible={true}
          onClose={() => setCommentModalPostId(null)}
          postId={commentModalPostId}
          currentUserId={user.uid}
          currentUserRole={currentUserRole}
        />
      )}

      {/* Image Viewer for My Posts */}
      <ImageZoomViewer
        images={postImages}
        startIndex={postImageIndex}
        visible={postImageViewerVisible}
        onClose={() => setPostImageViewerVisible(false)}
        showActions={!!postImageViewerPost}
        likesCount={postImageViewerPost?.likeCount ?? 0}
        commentsCount={postImageViewerPost?.commentCount ?? 0}
        isLiked={postImageViewerPost?.likedBy?.includes(user?.uid || "") || false}
        onLike={() => {
          if (postImageViewerPost) {
            handleLike(postImageViewerPost.id, postImageViewerPost.likedBy || []);
          }
        }}
        onComment={() => {
          if (postImageViewerPost) {
            setPostImageViewerVisible(false);
            setCommentModalPostId(postImageViewerPost.id);
          }
        }}
      />

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
        pendingProfileImage={pendingProfileImage}
        onCommitImage={commitPendingProfileImage}
        onCancelImage={() => setPendingProfileImage(null)}
        loading={loading}
      />

      {/* Full Image Viewer Modal */}
      <ImageZoomViewer
        images={imageUri ? [imageUri] : []}
        startIndex={0}
        visible={viewImageVisible}
        onClose={() => setViewImageVisible(false)}
        showActions={false}
      />
    </SafeAreaView>
  );
};

// Updated CardItemRow Component
const CardItemRow = React.memo(
  ({
    icon,
    label,
    value,
    isLocked,
  }: {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    value: string;
    isLocked?: boolean;
  }) => (
    <View style={styles.cardItemRow}>
      <View style={styles.iconBox}>
        <Ionicons name={icon} size={18} color="#5f0909" />
      </View>
      <View style={{ marginLeft: 12, flex: 1 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value}</Text>
      </View>
      {/* Shows lock if read-only/admin managed, nothing if editable via Edit Profile */}
      {isLocked && (
        <Ionicons
          name="lock-closed"
          size={16}
          color="#e0a53d"
          style={{ marginLeft: 8 }}
        />
      )}
    </View>
  ),
);

const ActionButton = React.memo(
  ({
    icon,
    text,
    onPress,
  }: {
    icon: keyof typeof Ionicons.glyphMap;
    text: string;
    onPress: () => void;
  }) => (
    <TouchableOpacity
      style={styles.actionButton}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Ionicons name={icon} size={20} color="#e0a53d" />
      <Text style={styles.actionText}>{text}</Text>
      <Ionicons
        name="chevron-forward"
        size={18}
        color="#9b766c"
        style={{ marginLeft: "auto" }}
      />
    </TouchableOpacity>
  ),
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
  loading,
  pendingProfileImage,
  onCommitImage,
  onCancelImage,
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
  pendingProfileImage: string | null;
  onCommitImage: () => void;
  onCancelImage: () => void;
}) => (
  <Modal
    visible={visible}
    transparent
    animationType="fade"
    onShow={onShow}
    onRequestClose={onClose}
  >
    <View style={styles.modalOverlay}>
      <Animated.View
        style={[styles.modalCard, { transform: [{ scale: scaleAnim }] }]}
      >
        <Text style={styles.modalHeader}>Edit Profile</Text>

        <View style={styles.tabRow}>
          {TABS.map(({ key, label, icon }) => (
            <TouchableOpacity
              key={key}
              onPress={() => onTabChange(key)}
              style={[
                styles.tabButton,
                editedData.selectedTab === key && styles.tabButtonActive,
              ]}
              activeOpacity={0.8}
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

        <View style={styles.tabContent}>
          {loading ? (
            <ActivityIndicator
              size="large"
              color="#e0a53d"
              style={{ marginVertical: 24 }}
            />
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
                <PhotoTab
                  onImagePick={onImagePick}
                  previewUri={pendingProfileImage}
                  onCommit={onCommitImage}
                  onCancel={onCancelImage}
                  loading={loading}
                />
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

// Cleaned-up InfoTab for Edit Modal (Email only)
const InfoTab = ({
  editedData,
  onDataChange,
  onSave,
}: {
  editedData: EditData;
  onDataChange: (field: keyof EditData, value: string) => void;
  onSave: () => void;
}) => (
  <>
    <Text style={styles.inputLabel}>Personal Email Address</Text>
    <TextInput
      style={styles.input}
      placeholder="Enter email address"
      placeholderTextColor="rgba(155,118,108,0.6)"
      value={editedData.email ?? ""}
      onChangeText={(text: string) => onDataChange("email", text)}
      keyboardType="email-address"
      autoCapitalize="none"
    />

    <TouchableOpacity style={styles.primaryBtn} onPress={onSave}>
      <Text style={styles.primaryText}>Save Changes</Text>
    </TouchableOpacity>
  </>
);

const PasswordTab = ({
  editedData,
  onDataChange,
  onChangePassword,
}: {
  editedData: EditData;
  onDataChange: (field: keyof EditData, value: string) => void;
  onChangePassword: () => void;
}) => {
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);

  return (
    <>
      <Text style={styles.inputLabel}>Current Password</Text>
      <View style={styles.passwordInputWrapper}>
        <TextInput
          style={styles.passwordInput}
          placeholder="Current Password"
          placeholderTextColor="rgba(155,118,108,0.6)"
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
            size={20}
            color="#9b766c"
          />
        </TouchableOpacity>
      </View>

      <Text style={styles.inputLabel}>New Password</Text>
      <View style={styles.passwordInputWrapper}>
        <TextInput
          style={styles.passwordInput}
          placeholder="New Password"
          placeholderTextColor="rgba(155,118,108,0.6)"
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
            size={20}
            color="#9b766c"
          />
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.primaryBtn} onPress={onChangePassword}>
        <Text style={styles.primaryText}>Update Password</Text>
      </TouchableOpacity>
    </>
  );
};

const PhotoTab = ({
  onImagePick, previewUri, onCommit, onCancel, loading,
}: {
  onImagePick: (useCamera: boolean) => void;
  previewUri: string | null;
  onCommit: () => void;
  onCancel: () => void;
  loading: boolean;
}) => (
  <View style={{ marginTop: 6 }}>
    {previewUri && (
      <View style={{ alignItems: "center", marginBottom: 14 }}>
        <Image source={{ uri: previewUri }} style={{ width: 110, height: 110, borderRadius: 55, borderWidth: 3, borderColor: "#e0a53d" }} />
        <Text style={{ marginTop: 8, color: "#7a3b2e", fontWeight: "600" }}>Preview</Text>
      </View>
    )}
    <TouchableOpacity style={styles.modalOption} onPress={() => onImagePick(false)} disabled={loading}>
      <Ionicons name="images-outline" size={20} color="#e0a53d" />
      <Text style={styles.optionText}>Choose from Gallery</Text>
    </TouchableOpacity>
    <TouchableOpacity style={styles.modalOption} onPress={() => onImagePick(true)} disabled={loading}>
      <Ionicons name="camera-outline" size={20} color="#e0a53d" />
      <Text style={styles.optionText}>Take Photo</Text>
    </TouchableOpacity>
    {previewUri && (
      <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
        <TouchableOpacity style={[styles.closeBtn, { flex: 1 }]} onPress={onCancel} disabled={loading}>
          <Text style={styles.closeText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.primaryBtn, { flex: 1, marginTop: 0 }]} onPress={onCommit} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Done</Text>}
        </TouchableOpacity>
      </View>
    )}
  </View>
);


type YearLevelDropdownProps = {
  value: string;
  onChange: (val: string) => void;
};

const YearLevelDropdown: React.FC<YearLevelDropdownProps> = React.memo(
  ({ value, onChange }) => {
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState([
      { label: "1st Year", value: "1st Year" },
      { label: "2nd Year", value: "2nd Year" },
      { label: "3rd Year", value: "3rd Year" },
      { label: "4th Year", value: "4th Year" },
      { label: "Graduate", value: "Graduate" },
    ]);

    return (
      <View style={{ zIndex: 1000, marginBottom: 12 }}>
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
  },
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f6f1ed" },
  contentShell: { flex: 1, backgroundColor: "#f6f1ed" },
  headerShell: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 20,
    backgroundColor: "#5f0909",
    borderWidth: 1,
    borderColor: "#8f3a2b",

    shadowColor: "#5f0909",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerBackButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,250,247,0.12)",
    borderWidth: 1,
    borderColor: "rgba(240,210,194,0.3)",
  },
  headerBackSpacer: {
    width: 38,
    height: 38,
  },
  headerCopy: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  header: {
    color: "#fffaf7",
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: 0.5,
  },
  headerSubtext: {
    color: "#f0d2c2",
    fontSize: 12,
    textAlign: "center",
    marginTop: 2,
  },
  scroll: { paddingBottom: 60 },
  profileCard: {
    alignItems: "center",
    backgroundColor: "#5f0909",
    marginHorizontal: 16,
    marginTop: 12,
    padding: 24,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#e0a53d",

    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 5,
  },
  avatarWrapper: {
    position: "relative",
    marginBottom: 12,
  },
  profileImage: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 3,
    borderColor: "#e0a53d",
  },
  placeholder: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: "#f0e7e2",
    justifyContent: "center",
    alignItems: "center",
  },
  editBadge: {
    position: "absolute",
    bottom: 2,
    right: 2,
    backgroundColor: "#e0a53d",
    borderRadius: 16,
    width: 30,
    height: 30,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#5f0909",
  },
  statusBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#5f0909",
  },
  statusBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "rgba(255,250,247,0.12)",
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.28)",
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  section: { marginHorizontal: 16, marginTop: 20 },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  sectionTitle: {
    color: "#5f0909",
    fontWeight: "700",
    fontSize: 14,
    letterSpacing: 0.5,
  },
  goldCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    borderWidth: 2,
    borderColor: "#e0a53d",
    paddingHorizontal: 14,
    paddingVertical: 4,

    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 5,
    elevation: 3,
  },
  cardItemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
  },
  rowDivider: {
    height: 1,
    backgroundColor: "rgba(224,165,61,0.25)",
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#f0e7e2",
    justifyContent: "center",
    alignItems: "center",
  },
  infoLabel: {
    color: "#9b766c",
    fontSize: 11,
    fontWeight: "600",
  },
  infoValue: {
    color: "#4d1b17",
    fontSize: 14,
    fontWeight: "600",
    marginTop: 2,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fffaf7",
    padding: 16,
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e8d3b2",
    borderLeftWidth: 4,
    borderLeftColor: "#e0a53d",

    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  actionText: {
    color: "#4d1b17",
    fontSize: 15,
    fontWeight: "600",
    marginLeft: 12,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalCard: {
    width: "90%",
    maxWidth: 400,
    backgroundColor: "#fffaf7",
    borderRadius: 22,
    paddingVertical: 20,
    paddingHorizontal: 18,
    elevation: 8,
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.22)",
  },
  modalHeader: {
    color: "#5f0909",
    fontSize: 18,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 16,
  },
  tabRow: {
    flexDirection: "row",
    backgroundColor: "#f0e7e2",
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderRadius: 10,
  },
  tabButtonActive: { backgroundColor: "#5f0909" },
  tabText: {
    color: "#9b766c",
    fontSize: 11,
    textAlign: "center",
    fontWeight: "600",
  },
  tabTextActive: { color: "#fff" },
  tabContent: { marginVertical: 12 },
  inputLabel: {
    color: "#9b766c",
    fontSize: 12,
    marginBottom: 4,
    marginLeft: 2,
    fontWeight: "600",
  },
  input: {
    backgroundColor: "#f0e7e2",
    color: "#4d1b17",
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    fontSize: 14,
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.32)",
  },
  passwordInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f0e7e2",
    borderRadius: 10,
    marginBottom: 12,
    paddingRight: 8,
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.32)",
  },
  passwordInput: { flex: 1, color: "#4d1b17", padding: 12, fontSize: 14 },
  eyeIconPassword: { padding: 8 },
  primaryBtn: {
    backgroundColor: "#5f0909",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 6,
    shadowColor: "#5f0909",
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 1,
    borderColor: "#8f3a2b",
  },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  closeBtn: {
    backgroundColor: "#f5efeb",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  closeText: { color: "#9b766c", fontWeight: "600", fontSize: 14 },
  modalOption: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f0e7e2",
    padding: 14,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.24)",
  },
  optionText: { color: "#4d1b17", fontSize: 15, marginLeft: 12, fontWeight: "500" },
  dropdown: {
    backgroundColor: "#fffaf7",
    borderColor: "#e0a53d",
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 48,
  },
  dropdownContainer: {
    backgroundColor: "#f6f1ed",
    borderColor: "#e0a53d",
    borderWidth: 1,
    borderRadius: 10,
  },
  dropdownText: { color: "#4d1b17", fontSize: 14 },
  placeholderStyle: { color: "rgba(155,118,108,0.6)" },
  listItemContainer: { borderBottomColor: "#fffaf7", borderBottomWidth: 0.5 },
  listItemLabel: { color: "#4d1b17" },
  arrowIcon: { tintColor: "#e0a53d" } as any,
  tickIcon: { tintColor: "#e0a53d" } as any,

  // My Posts
  postsToolbar: { gap: 10, marginBottom: 12 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#ead8cf",
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 40,
  },
  searchInput: { flex: 1, color: "#4d1b17", fontSize: 14 },
  toolbarRow: { flexDirection: "row", gap: 8 },
  toolbarChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#ead8cf",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  toolbarChipActive: {
    backgroundColor: "#a61f1f",
    borderColor: "#a61f1f",
  },
  toolbarChipText: { color: "#5f0909", fontSize: 12.5, fontWeight: "600" },
  toolbarChipTextActive: { color: "#fffaf7" },
  postsEmptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
    gap: 8,
  },
  postsEmptyTitle: {
    color: "#8f6a60",
    fontSize: 13.5,
    fontWeight: "600",
    textAlign: "center",
  },
  postsClearFiltersText: {
    color: "#a61f1f",
    fontSize: 13,
    fontWeight: "700",
    marginTop: 2,
  },
  sortMenuBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  sortMenuCard: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  sortMenuOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sortMenuOptionText: { color: "#4d1b17", fontSize: 14.5 },
  sortMenuOptionTextActive: { color: "#a61f1f", fontWeight: "700" },
});

export default ProfileScreen;
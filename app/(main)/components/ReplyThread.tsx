import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  Dimensions,
  FlatList,
  Image,
  Linking,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { db } from "../../../Firebase_configure";
import {
  getRoleColor,
  getRoleDisplayName,
  getUserData,
} from "@/utils/rbac";
import CommentComposer from "./CommentComposer";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

type Reply = {
  id: string;
  text: string;
  userId: string;
  realUserId?: string;
  username?: string;
  createdAt: any;
  role?: string;
  profilePic?: string;
  isAnonymous?: boolean;
  commentId: string;
  files?: { url: string; mimeType: string; name?: string }[];
  link?: { url: string; title: string };
  taggedUsers?: { id: string; name: string; studentID: string }[];
  likeCount?: number;
  likedBy?: string[];
  seenBy?: string[];
  replyingTo?: { id: string; name: string; text: string };
};

type ReplyThreadProps = {
  visible: boolean;
  onClose: () => void;
  commentId: string;
  commentAuthor: string;
  currentUser: any;
};

// ─── Role helpers ────────────────────────────────────────────────────────────
const ROLE_PRIORITY = ["admin", "moderator", "teacher", "student"];

function getAuthorRole(authorData: any, itemRole?: string) {
  return authorData?.role || itemRole || "student";
}

// ─── Single reply bubble ──────────────────────────────────────────────────────
const ReplyBubble: React.FC<{
  item: Reply;
  currentUser: any;
  prevItem?: Reply;
  onLike: (id: string, likedBy: string[]) => void;
  onReplyClick: (id: string, name: string, text: string) => void;
  onLongPress: (item: Reply) => void;
  onProfileClick: (item: Reply) => void;
  onTagClick: (userId: string) => void;
  onLinkPress: (url: string) => void;
  onFilePress: (url: string, name: string) => void;
  onImagePress: (images: string[], index: number) => void;
  getTimeAgo: (ts: any) => string;
  getFileDisplayName: (f: {
    url: string;
    mimeType: string;
    name?: string;
  }) => string;
}> = ({
  item,
  currentUser,
  prevItem,
  onLike,
  onReplyClick,
  onLongPress,
  onProfileClick,
  onTagClick,
  onLinkPress,
  onFilePress,
  onImagePress,
  getTimeAgo,
  getFileDisplayName,
}) => {
  const [authorData, setAuthorData] = useState<any>(null);
  const [revealed, setRevealed] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const isCurrentUser =
    (item.realUserId && item.realUserId === currentUser?.uid) ||
    item.userId === currentUser?.uid;
  const isAnon = item.isAnonymous ?? false;

  // Determine if we show avatar/name (group consecutive messages from same sender)
  const isSameSenderAsPrev =
    prevItem &&
    (prevItem.realUserId || prevItem.userId) ===
      (item.realUserId || item.userId) &&
    prevItem.isAnonymous === item.isAnonymous;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  useEffect(() => {
    const fetchAuthor = async () => {
      const uid = item.realUserId || item.userId;
      if (uid && uid !== "anonymous") {
        try {
          const data = await getUserData(uid);
          setAuthorData(data);
        } catch {}
      }
    };
    fetchAuthor();
  }, [item.realUserId, item.userId]);

  const authorRole = getAuthorRole(authorData, item.role);
  const roleColor = getRoleColor(authorRole);
  const roleDisplayName = getRoleDisplayName(authorRole);
  const isPrivileged = authorRole !== "student";

  const canReveal =
    isAnon &&
    (currentUser?.role === "admin" ||
      currentUser?.role === "moderator" ||
      (currentUser?.role === "teacher" && authorRole === "student"));

  const isIdentityVisible = !isAnon || (revealed && canReveal);

  const displayName = isIdentityVisible
    ? authorData
      ? `${authorData.firstname} ${authorData.lastname}`
      : item.username || "User"
    : "Anonymous";

  const initial = isIdentityVisible
    ? (authorData?.firstname?.[0] || displayName[0] || "A").toUpperCase()
    : "?";

  const isLiked = (item.likedBy || []).includes(currentUser?.uid || "");

  const imageFiles = (item.files || []).filter(
    (f) => f.mimeType.startsWith("image/") && !f.mimeType.includes("gif"),
  );
  const gifFiles = (item.files || []).filter((f) => f.mimeType.includes("gif"));
  const docFiles = (item.files || []).filter(
    (f) => !f.mimeType.startsWith("image/"),
  );
  const taggedUsers = item.taggedUsers ?? [];

  const showHeader = !isSameSenderAsPrev;

  return (
    <Animated.View
      style={[
        styles.messageRow,
        isCurrentUser ? styles.messageRowRight : styles.messageRowLeft,
        { opacity: fadeAnim },
        isSameSenderAsPrev ? { marginTop: 2 } : { marginTop: 10 },
      ]}
    >
      {/* Avatar — only for others, only when not grouped */}
      {!isCurrentUser && (
        <View style={styles.avatarColumn}>
          {showHeader ? (
            <TouchableOpacity
              onPress={() => onProfileClick(item)}
              disabled={!isIdentityVisible}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.avatar,
                  isIdentityVisible && isPrivileged
                    ? { borderColor: roleColor, borderWidth: 2 }
                    : { borderColor: "#243054", borderWidth: 1 },
                ]}
              >
                {isIdentityVisible && item.profilePic ? (
                  <Image
                    source={{ uri: item.profilePic }}
                    style={styles.avatarImg}
                  />
                ) : isIdentityVisible ? (
                  <Text style={[styles.avatarInitial, { color: roleColor }]}>
                    {initial}
                  </Text>
                ) : (
                  <Ionicons name="person" size={13} color="#8ea0d0" />
                )}
              </View>
            </TouchableOpacity>
          ) : (
            <View style={styles.avatarPlaceholder} />
          )}
        </View>
      )}

      {/* Bubble */}
      <TouchableOpacity
        onLongPress={() => onLongPress(item)}
        activeOpacity={0.88}
        style={[
          styles.bubbleWrapper,
          isCurrentUser ? styles.bubbleWrapperRight : styles.bubbleWrapperLeft,
        ]}
      >
        {/* Sender name + role chip — only show on first in group, only for others */}
        {!isCurrentUser && showHeader && (
          <View style={styles.senderRow}>
            <TouchableOpacity
              onPress={() => onProfileClick(item)}
              disabled={!isIdentityVisible}
            >
              <Text
                style={[
                  styles.senderName,
                  { color: isIdentityVisible ? roleColor : "#8ea0d0" },
                ]}
              >
                {displayName}
              </Text>
            </TouchableOpacity>

            {isIdentityVisible && isPrivileged && (
              <View
                style={[
                  styles.roleChip,
                  { backgroundColor: roleColor + "22", borderColor: roleColor },
                ]}
              >
                <Text style={[styles.roleChipText, { color: roleColor }]}>
                  {roleDisplayName}
                </Text>
              </View>
            )}

            {canReveal && (
              <TouchableOpacity
                onPress={() => setRevealed(!revealed)}
                style={styles.eyeBtn}
              >
                <Ionicons
                  name={revealed ? "eye-off-outline" : "eye-outline"}
                  size={13}
                  color={revealed ? "#ff5c93" : "#8ea0d0"}
                />
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Reply-to preview */}
        {item.replyingTo && (
          <View
            style={[
              styles.replyPreview,
              isCurrentUser && styles.replyPreviewRight,
            ]}
          >
            <View style={styles.replyPreviewBar} />
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.replyPreviewAuthor,
                  isCurrentUser && { color: "#ffaad0" },
                ]}
              >
                {item.replyingTo.name}
              </Text>
              <Text
                style={[
                  styles.replyPreviewText,
                  isCurrentUser && { color: "#ffffff99" },
                ]}
                numberOfLines={2}
              >
                {item.replyingTo.text || "Message"}
              </Text>
            </View>
          </View>
        )}

        {/* Bubble body */}
        <View
          style={[
            styles.bubble,
            isCurrentUser ? styles.bubbleRight : styles.bubbleLeft,
          ]}
        >
          {/* Text */}
          {!!item.text && (
            <Text
              style={[
                styles.bubbleText,
                isCurrentUser && styles.bubbleTextRight,
              ]}
            >
              {item.text}
            </Text>
          )}

          {/* GIF */}
          {gifFiles.length > 0 && (
            <View style={styles.gifContainer}>
              <Image
                source={{ uri: gifFiles[0].url }}
                style={styles.gifImage}
                resizeMode="cover"
              />
            </View>
          )}

          {/* Images */}
          {imageFiles.length > 0 && (
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() =>
                onImagePress(
                  imageFiles.map((f) => f.url),
                  0,
                )
              }
              style={styles.imageContainer}
            >
              <Image
                source={{ uri: imageFiles[0].url }}
                style={styles.imagePreview}
                resizeMode="cover"
              />
              {imageFiles.length > 1 && (
                <View style={styles.imageCountBadge}>
                  <Text style={styles.imageCountText}>
                    +{imageFiles.length - 1}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          )}

          {/* Docs */}
          {docFiles.length > 0 && (
            <View style={styles.docsContainer}>
              {docFiles.map((file, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={[styles.docItem, isCurrentUser && styles.docItemRight]}
                  onPress={() =>
                    onFilePress(file.url, getFileDisplayName(file))
                  }
                >
                  <Ionicons
                    name={
                      file.mimeType.includes("pdf")
                        ? "document-text"
                        : "document"
                    }
                    size={14}
                    color={isCurrentUser ? "#fff" : "#4f9cff"}
                  />
                  <Text
                    style={[styles.docText, isCurrentUser && { color: "#fff" }]}
                    numberOfLines={1}
                  >
                    {getFileDisplayName(file)}
                  </Text>
                  <Ionicons
                    name="download-outline"
                    size={12}
                    color={isCurrentUser ? "#ffffff99" : "#8ea0d0"}
                  />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Link */}
          {item.link && (
            <TouchableOpacity
              style={[
                styles.linkPreview,
                isCurrentUser && styles.linkPreviewRight,
              ]}
              onPress={() => onLinkPress(item.link?.url ?? "")}
            >
              <Ionicons
                name="link"
                size={13}
                color={isCurrentUser ? "#fff" : "#4f9cff"}
              />
              <View style={{ flex: 1, marginLeft: 6 }}>
                <Text
                  style={[styles.linkTitle, isCurrentUser && { color: "#fff" }]}
                  numberOfLines={1}
                >
                  {item.link?.title ?? "Link"}
                </Text>
                <Text
                  style={[
                    styles.linkUrl,
                    isCurrentUser && { color: "#ffffff99" },
                  ]}
                  numberOfLines={1}
                >
                  {item.link?.url ?? ""}
                </Text>
              </View>
              <Ionicons
                name="open-outline"
                size={11}
                color={isCurrentUser ? "#ffffff99" : "#8ea0d0"}
              />
            </TouchableOpacity>
          )}

          {/* Tagged users */}
          {taggedUsers.length > 0 && (
            <View
              style={[styles.taggedRow, isCurrentUser && styles.taggedRowRight]}
            >
              <Ionicons
                name="people-outline"
                size={11}
                color={isCurrentUser ? "#ffaad0" : "#ff5c93"}
              />
              <Text
                style={[
                  styles.taggedWith,
                  isCurrentUser && { color: "#ffaad0" },
                ]}
              >
                with{" "}
              </Text>
              <View style={styles.taggedNames}>
                {taggedUsers.map((tag, idx) => (
                  <React.Fragment key={tag.id}>
                    <TouchableOpacity onPress={() => onTagClick(tag.id)}>
                      <Text
                        style={[
                          styles.taggedName,
                          isCurrentUser && { color: "#fff" },
                        ]}
                      >
                        {tag.name}
                      </Text>
                    </TouchableOpacity>
                    {idx < taggedUsers.length - 1 && (
                      <Text
                        style={[
                          styles.taggedWith,
                          isCurrentUser && { color: "#ffaad0" },
                        ]}
                      >
                        ,{" "}
                      </Text>
                    )}
                  </React.Fragment>
                ))}
              </View>
            </View>
          )}
        </View>

        {/* Footer: time + actions */}
        <View
          style={[
            styles.bubbleFooter,
            isCurrentUser && styles.bubbleFooterRight,
          ]}
        >
          <Text
            style={[styles.timeText, isCurrentUser && styles.timeTextRight]}
          >
            {getTimeAgo(item.createdAt)}
          </Text>

          <View style={styles.footerActions}>
            <TouchableOpacity
              onPress={() => onLike(item.id, item.likedBy || [])}
              style={styles.footerAction}
            >
              <Ionicons
                name={isLiked ? "heart" : "heart-outline"}
                size={13}
                color={
                  isLiked ? "#ff5c93" : isCurrentUser ? "#ffffff99" : "#8ea0d0"
                }
              />
              {(item.likeCount || 0) > 0 && (
                <Text
                  style={[
                    styles.footerActionText,
                    isCurrentUser && { color: "#ffffff99" },
                  ]}
                >
                  {item.likeCount}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() =>
                onReplyClick(item.id, displayName, item.text || "")
              }
              style={styles.footerAction}
            >
              <Ionicons
                name="return-down-forward-outline"
                size={13}
                color={isCurrentUser ? "#ffffff99" : "#8ea0d0"}
              />
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────
const ReplyThread: React.FC<ReplyThreadProps> = ({
  visible,
  onClose,
  commentId,
  commentAuthor,
  currentUser,
}) => {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [showSeenModal, setShowSeenModal] = useState(false);
  const [selectedReplySeenBy, setSelectedReplySeenBy] = useState<string[]>([]);
  const [replyingTo, setReplyingTo] = useState<{
    id: string;
    name: string;
    text: string;
  } | null>(null);
  const [seenUsers, setSeenUsers] = useState<{ [uid: string]: any }>({});

  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList>(null);
  const router = useRouter();

  // Scroll to bottom when new message arrives
  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, []);

  useEffect(() => {
    const backHandler = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (visible) {
          onClose();
          return true;
        }
        return false;
      },
    );
    return () => backHandler.remove();
  }, [visible, onClose]);

  useEffect(() => {
    if (!commentId) return;
    const q = query(
      collection(db, "replies"),
      where("commentId", "==", commentId),
      orderBy("createdAt", "asc"),
    );

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const fetched = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Reply[];
      setReplies(fetched);
      setLoading(false);

      // Mark as seen
      if (currentUser?.uid) {
        for (const reply of fetched) {
          if (!reply.seenBy?.includes(currentUser.uid)) {
            try {
              await updateDoc(doc(db, "replies", reply.id), {
                seenBy: arrayUnion(currentUser.uid),
              });
            } catch {}
          }
        }
      }
    });

    return unsubscribe;
  }, [commentId, currentUser?.uid]);

  // Scroll to bottom when replies load for the first time
  useEffect(() => {
    if (!loading && replies.length > 0) {
      scrollToBottom();
    }
  }, [loading, replies.length, scrollToBottom]);

  const handleSendReply = async (replyData: any) => {
    if (!currentUser) return;
    const newReply = {
      ...replyData,
      commentId,
      createdAt: serverTimestamp(),
      likeCount: 0,
      likedBy: [],
      seenBy: [currentUser.uid],
      ...(replyingTo && { replyingTo }),
    };
    await addDoc(collection(db, "replies"), newReply);
    await updateDoc(doc(db, "comments", commentId), {
      replyCount: (replies.length || 0) + 1,
    });
    setReplyingTo(null);
    scrollToBottom();
  };

  const handleLikeReply = async (replyId: string, likedBy: string[]) => {
    if (!currentUser?.uid) return;
    const replyRef = doc(db, "replies", replyId);
    const isLiked = likedBy.includes(currentUser.uid);
    try {
      if (isLiked) {
        await updateDoc(replyRef, {
          likedBy: arrayRemove(currentUser.uid),
          likeCount: Math.max(0, likedBy.length - 1),
        });
      } else {
        await updateDoc(replyRef, {
          likedBy: arrayUnion(currentUser.uid),
          likeCount: likedBy.length + 1,
        });
      }
    } catch {}
  };

  const handleDeleteReply = async (replyId: string) => {
    Alert.alert("Delete Reply", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteDoc(doc(db, "replies", replyId));
            await updateDoc(doc(db, "comments", commentId), {
              replyCount: Math.max(0, replies.length - 1),
            });
          } catch {
            Alert.alert("Error", "Failed to delete");
          }
        },
      },
    ]);
  };

  const handleReportReply = (replyId: string) => {
    Alert.alert("Report Reply", "Select a reason:", [
      { text: "Cancel", style: "cancel" },
      { text: "Spam", onPress: () => submitReport(replyId, "spam") },
      {
        text: "Harassment",
        onPress: () => submitReport(replyId, "harassment"),
      },
      {
        text: "Inappropriate",
        onPress: () => submitReport(replyId, "inappropriate"),
      },
    ]);
  };

  const submitReport = async (replyId: string, reason: string) => {
    try {
      await addDoc(collection(db, "reports"), {
        contentType: "reply",
        contentId: replyId,
        reportedBy: currentUser.uid,
        reason,
        createdAt: serverTimestamp(),
        status: "pending",
      });
      Alert.alert("Reported", "Thank you for your report");
    } catch {
      Alert.alert("Error", "Failed to report");
    }
  };

  const handleLongPress = (reply: Reply) => {
    const isOwner =
      reply.realUserId === currentUser?.uid ||
      reply.userId === currentUser?.uid;
    const isAdmin = currentUser?.role === "admin";
    const canDelete = isOwner || isAdmin;

    const options: { text: string; style?: any; onPress: () => void }[] = [
      {
        text: "Reply",
        onPress: () => {
          const uid = reply.realUserId || reply.userId;
          const name =
            !reply.isAnonymous && uid && uid !== "anonymous"
              ? reply.username || "User"
              : "Anonymous";
          setReplyingTo({ id: reply.id, name, text: reply.text || "" });
        },
      },
    ];

    if (!isOwner) {
      options.push({
        text: "Report",
        onPress: () => handleReportReply(reply.id),
      });
    }

    options.push({
      text: "Seen by",
      onPress: () => {
        setSelectedReplySeenBy(reply.seenBy || []);
        setShowSeenModal(true);
      },
    });

    if (canDelete) {
      options.push({
        text: "Delete",
        style: "destructive",
        onPress: () => handleDeleteReply(reply.id),
      });
    }

    Alert.alert("Options", undefined, [
      ...options,
      { text: "Cancel", style: "cancel", onPress: () => {} },
    ]);
  };

  const handleProfileClick = useCallback(
    (reply: Reply) => {
      const isAnon = reply.isAnonymous ?? false;
      const uid = reply.realUserId || reply.userId;
      if (isAnon || !uid || uid === "anonymous") return;
      try {
        if (currentUser && uid === currentUser.uid) {
          router.push("../../(tabs)/ProfileScreen");
        } else {
          router.push(`../../UserProfileScreen?userId=${uid}`);
        }
      } catch {}
    },
    [currentUser, router],
  );

  const handleTagClick = useCallback(
    (taggedUserId: string) => {
      try {
        if (currentUser && taggedUserId === currentUser.uid) {
          router.push("../../(tabs)/ProfileScreen");
        } else {
          router.push(`../../UserProfileScreen?userId=${taggedUserId}`);
        }
      } catch {}
    },
    [currentUser, router],
  );

  const handleLinkPress = (url: string) => {
    Linking.canOpenURL(url)
      .then((ok) => {
        if (ok) Linking.openURL(url);
        else Alert.alert("Invalid Link", "Cannot open this URL");
      })
      .catch(() => Alert.alert("Error", "Failed to open link"));
  };

  const handleFilePress = async (url: string, filename: string) => {
    try {
      const ok = await Linking.canOpenURL(url);
      if (ok) await Linking.openURL(url);
      else Alert.alert("Error", "Cannot open this file");
    } catch {
      Alert.alert("Error", "Failed to open file");
    }
  };

  const handleImagePress = (images: string[], startIndex: number) => {
    setSelectedImages(images);
    setSelectedImageIndex(startIndex);
    setImageViewerVisible(true);
  };

  const getFileDisplayName = (file: {
    url: string;
    mimeType: string;
    name?: string;
  }) => {
    if (file.name) return file.name;
    const parts = file.url.split("/");
    const last = parts[parts.length - 1];
    const name = decodeURIComponent(last.split("?")[0]);
    return name.length > 28 ? name.slice(0, 25) + "..." : name;
  };

  const getTimeAgo = (timestamp: any) => {
    if (!timestamp) return "";
    const now = new Date();
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSec < 60) return "Just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  };

  // Date separator logic
  const shouldShowDateSeparator = (item: Reply, prev?: Reply) => {
    if (!prev) return true;
    if (!item.createdAt || !prev.createdAt) return false;
    const dateA = item.createdAt.toDate
      ? item.createdAt.toDate()
      : new Date(item.createdAt);
    const dateB = prev.createdAt.toDate
      ? prev.createdAt.toDate()
      : new Date(prev.createdAt);
    return dateA.toDateString() !== dateB.toDateString();
  };

  const formatDateHeader = (timestamp: any) => {
    if (!timestamp) return "";
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    return date.toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: diffDays > 365 ? "numeric" : undefined,
    });
  };

  return (
    <>
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={styles.screen}>
          {/* ── Header ── */}
          <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
              style={styles.backBtn}
            >
              <Ionicons name="arrow-back" size={24} color="#ff5c93" />
            </TouchableOpacity>

            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle}>Replies</Text>
              <Text style={styles.headerSub}>
                to{" "}
                <Text style={{ color: "#ff8ab2", fontWeight: "700" }}>
                  {commentAuthor}
                </Text>
                {"  ·  "}
                <Text style={{ color: "#8ea0d0" }}>
                  {replies.length} {replies.length === 1 ? "reply" : "replies"}
                </Text>
              </Text>
            </View>

            <View style={{ width: 40 }} />
          </View>

          {/* ── Body ── */}
          {loading ? (
            <View style={styles.centered}>
              <ActivityIndicator color="#ff5c93" size="large" />
            </View>
          ) : replies.length === 0 ? (
            <View style={styles.centered}>
              <Ionicons name="chatbubbles-outline" size={52} color="#243054" />
              <Text style={styles.emptyTitle}>No replies yet</Text>
              <Text style={styles.emptySub}>Be the first to reply!</Text>
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={replies}
              keyExtractor={(item) => item.id}
              renderItem={({ item, index }) => {
                const prev = index > 0 ? replies[index - 1] : undefined;
                const showDate = shouldShowDateSeparator(item, prev);
                return (
                  <>
                    {showDate && (
                      <View style={styles.dateSeparator}>
                        <View style={styles.dateLine} />
                        <Text style={styles.dateLabel}>
                          {formatDateHeader(item.createdAt)}
                        </Text>
                        <View style={styles.dateLine} />
                      </View>
                    )}
                    <ReplyBubble
                      item={item}
                      currentUser={currentUser}
                      prevItem={prev}
                      onLike={handleLikeReply}
                      onReplyClick={(id, name, text) =>
                        setReplyingTo({ id, name, text })
                      }
                      onLongPress={handleLongPress}
                      onProfileClick={handleProfileClick}
                      onTagClick={handleTagClick}
                      onLinkPress={handleLinkPress}
                      onFilePress={handleFilePress}
                      onImagePress={handleImagePress}
                      getTimeAgo={getTimeAgo}
                      getFileDisplayName={getFileDisplayName}
                    />
                  </>
                );
              }}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={scrollToBottom}
            />
          )}

          {/* ── Composer ── */}
          {currentUser && (
            <View
              style={[
                styles.composerWrapper,
                {
                  paddingBottom: Platform.select({
                    ios: insets.bottom + 8,
                    android: 16,
                    default: insets.bottom + 8,
                  }),
                },
              ]}
            >
              <CommentComposer
                currentUser={currentUser}
                onSend={handleSendReply}
                placeholder="Reply..."
                replyingTo={replyingTo}
                onCancelReply={() => setReplyingTo(null)}
              />
            </View>
          )}
        </View>
      </Modal>

      {/* ── Seen-by modal ── */}
      <Modal
        visible={showSeenModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSeenModal(false)}
      >
        <TouchableOpacity
          style={styles.overlayDark}
          activeOpacity={1}
          onPress={() => setShowSeenModal(false)}
        >
          <View style={styles.seenSheet} onStartShouldSetResponder={() => true}>
            <View style={styles.seenHeader}>
              <Text style={styles.seenTitle}>
                Seen by ({selectedReplySeenBy.length})
              </Text>
              <TouchableOpacity onPress={() => setShowSeenModal(false)}>
                <Ionicons name="close" size={22} color="#8ea0d0" />
              </TouchableOpacity>
            </View>
            {selectedReplySeenBy.length === 0 ? (
              <View style={styles.centered}>
                <Ionicons name="eye-off-outline" size={42} color="#243054" />
                <Text style={styles.emptySub}>No views yet</Text>
              </View>
            ) : (
              <FlatList
                data={selectedReplySeenBy}
                keyExtractor={(id) => id}
                renderItem={({ item: uid }) => (
                  <View style={styles.seenRow}>
                    <View style={styles.seenAvatar}>
                      <Text style={styles.seenAvatarText}>
                        {uid[0]?.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.seenName}>User {uid.slice(0, 8)}…</Text>
                  </View>
                )}
              />
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Image viewer ── */}
      <Modal
        visible={imageViewerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setImageViewerVisible(false)}
      >
        <View style={styles.imageViewer}>
          <TouchableOpacity
            style={styles.imageViewerClose}
            onPress={() => setImageViewerVisible(false)}
          >
            <Ionicons name="close" size={30} color="#fff" />
          </TouchableOpacity>
          <FlatList
            data={selectedImages}
            horizontal
            pagingEnabled
            initialScrollIndex={selectedImageIndex}
            getItemLayout={(_, i) => ({
              length: SCREEN_WIDTH,
              offset: SCREEN_WIDTH * i,
              index: i,
            })}
            renderItem={({ item }) => (
              <View style={styles.imageViewerPage}>
                <Image
                  source={{ uri: item }}
                  style={styles.imageViewerImg}
                  resizeMode="contain"
                />
              </View>
            )}
            keyExtractor={(_, i) => i.toString()}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => {
              setSelectedImageIndex(
                Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH),
              );
            }}
          />
          {selectedImages.length > 1 && (
            <View style={styles.imageCounter}>
              <Text style={styles.imageCounterText}>
                {selectedImageIndex + 1} / {selectedImages.length}
              </Text>
            </View>
          )}
        </View>
      </Modal>
    </>
  );
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#070c15" },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1b2235",
    backgroundColor: "#070c15",
  },
  backBtn: { padding: 4, marginRight: 4 },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle: { color: "#e9edff", fontSize: 17, fontWeight: "700" },
  headerSub: { color: "#8ea0d0", fontSize: 12.5, marginTop: 2 },

  // List
  listContent: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    flexGrow: 1,
  },

  // Date separator
  dateSeparator: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 14,
    paddingHorizontal: 8,
    gap: 8,
  },
  dateLine: { flex: 1, height: 1, backgroundColor: "#1b2235" },
  dateLabel: {
    color: "#8ea0d0",
    fontSize: 11.5,
    fontWeight: "600",
    paddingHorizontal: 6,
    backgroundColor: "#0f1623",
    borderRadius: 8,
    overflow: "hidden",
    paddingVertical: 3,
  },

  // Message row
  messageRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 4,
  },
  messageRowLeft: { justifyContent: "flex-start" },
  messageRowRight: { justifyContent: "flex-end" },

  // Avatar
  avatarColumn: { width: 36, marginRight: 8, alignItems: "center" },
  avatarPlaceholder: { width: 36 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#1b2235",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInitial: { fontSize: 14, fontWeight: "700" },

  // Bubble wrapper
  bubbleWrapper: { maxWidth: "76%", flexShrink: 1 },
  bubbleWrapperLeft: { alignItems: "flex-start" },
  bubbleWrapperRight: { alignItems: "flex-end" },

  // Sender row
  senderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  senderName: { fontSize: 12.5, fontWeight: "700" },
  roleChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  roleChipText: { fontSize: 9.5, fontWeight: "700" },
  eyeBtn: { padding: 2 },

  // Reply preview
  replyPreview: {
    flexDirection: "row",
    backgroundColor: "#0e1320",
    borderRadius: 10,
    padding: 8,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: "#1b2235",
  },
  replyPreviewRight: { backgroundColor: "#b03060" },
  replyPreviewBar: {
    width: 3,
    backgroundColor: "#ff5c93",
    borderRadius: 2,
    marginRight: 8,
  },
  replyPreviewAuthor: {
    color: "#ff8ab2",
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 2,
  },
  replyPreviewText: { color: "#8ea0d0", fontSize: 12, lineHeight: 16 },

  // Bubble
  bubble: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minWidth: 60,
  },
  bubbleLeft: {
    backgroundColor: "#1b2235",
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: "#243054",
  },
  bubbleRight: {
    backgroundColor: "#ff5c93",
    borderBottomRightRadius: 4,
  },
  bubbleText: { color: "#d8deff", fontSize: 15, lineHeight: 21 },
  bubbleTextRight: { color: "#fff" },

  // GIF
  gifContainer: { marginTop: 6, borderRadius: 12, overflow: "hidden" },
  gifImage: { width: 220, height: 160, backgroundColor: "#0e1320" },

  // Image
  imageContainer: {
    marginTop: 6,
    borderRadius: 12,
    overflow: "hidden",
    position: "relative",
  },
  imagePreview: { width: 220, height: 160, backgroundColor: "#0e1320" },
  imageCountBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: "rgba(0,0,0,0.7)",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  imageCountText: { color: "#fff", fontSize: 11, fontWeight: "700" },

  // Docs
  docsContainer: { marginTop: 6, gap: 5 },
  docItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#243054",
    padding: 8,
    borderRadius: 9,
  },
  docItemRight: { backgroundColor: "rgba(255,255,255,0.18)" },
  docText: { flex: 1, color: "#d8deff", fontSize: 12 },

  // Link
  linkPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#243054",
    padding: 9,
    borderRadius: 10,
    marginTop: 6,
    gap: 6,
  },
  linkPreviewRight: {
    backgroundColor: "rgba(255,255,255,0.18)",
    borderColor: "rgba(255,255,255,0.2)",
  },
  linkTitle: {
    color: "#e9edff",
    fontSize: 12.5,
    fontWeight: "600",
    marginBottom: 1,
  },
  linkUrl: { color: "#8ea0d0", fontSize: 11 },

  // Tagged
  taggedRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 3,
    marginTop: 7,
    backgroundColor: "#243054",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },
  taggedRowRight: { backgroundColor: "rgba(255,255,255,0.18)" },
  taggedWith: { color: "#8ea0d0", fontSize: 11 },
  taggedNames: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  taggedName: { color: "#ff8ab2", fontWeight: "600", fontSize: 11.5 },

  // Footer
  bubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
    paddingHorizontal: 2,
  },
  bubbleFooterRight: { justifyContent: "flex-end" },
  timeText: { color: "#8ea0d0", fontSize: 11 },
  timeTextRight: { color: "#8ea0d0" },
  footerActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  footerAction: { flexDirection: "row", alignItems: "center", gap: 3 },
  footerActionText: { color: "#8ea0d0", fontSize: 11 },

  // Composer wrapper
  composerWrapper: {
    borderTopWidth: 1,
    borderTopColor: "#1b2235",
    backgroundColor: "#0e1320",
    paddingHorizontal: 12,
    paddingTop: 8,
  },

  // Seen modal
  overlayDark: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.82)",
    justifyContent: "center",
    alignItems: "center",
  },
  seenSheet: {
    backgroundColor: "#1b2235",
    borderRadius: 16,
    width: "86%",
    maxHeight: "60%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#243054",
  },
  seenHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#243054",
  },
  seenTitle: { color: "#e9edff", fontSize: 16, fontWeight: "700" },
  seenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#243054",
  },
  seenAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
  },
  seenAvatarText: { color: "#ff8ab2", fontWeight: "700", fontSize: 14 },
  seenName: { color: "#e9edff", fontSize: 14, fontWeight: "500" },

  // Centered (empty / loading)
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 40,
  },
  emptyTitle: {
    color: "#e9edff",
    fontSize: 17,
    fontWeight: "700",
    marginTop: 14,
  },
  emptySub: { color: "#8ea0d0", fontSize: 13.5, marginTop: 6 },

  // Image viewer
  imageViewer: { flex: 1, backgroundColor: "#000" },
  imageViewerClose: {
    position: "absolute",
    top: 50,
    right: 20,
    zIndex: 10,
    padding: 8,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 20,
  },
  imageViewerPage: {
    width: SCREEN_WIDTH,
    justifyContent: "center",
    alignItems: "center",
  },
  imageViewerImg: { width: "100%", height: "100%" },
  imageCounter: {
    position: "absolute",
    bottom: 42,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  imageCounterText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});

export default ReplyThread;

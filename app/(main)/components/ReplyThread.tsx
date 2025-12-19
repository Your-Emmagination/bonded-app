import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Keyboard,
  Platform,
  Image,
  ActivityIndicator,
  BackHandler,
  Alert,
  Linking,
  Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  orderBy,
  updateDoc,
  doc,
  serverTimestamp,
  deleteDoc,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";
import { db } from "../../../Firebase_configure";
import CommentComposer from "./CommentComposer";
import { getUserData, getRoleColor, getRoleDisplayName } from "@/utils/rbac";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

// Simple keyboard height hook
const useKeyboard = () => {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (e) => setKeyboardHeight(e.endCoordinates.height)
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardHeight(0)
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return keyboardHeight;
};

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
  const [replyingTo, setReplyingTo] = useState<{ id: string; name: string; text: string } | null>(null);

  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboard();
  const flatListRef = useRef<FlatList>(null);
  const router = useRouter();

  const handleReplyClick = useCallback((replyId: string, authorName: string, replyText: string) => {
    setReplyingTo({ id: replyId, name: authorName, text: replyText });
  }, []);

  // Android back button handling
  useEffect(() => {
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (visible) {
        onClose();
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [visible, onClose]);

  // Real-time replies listener
  useEffect(() => {
    if (!commentId) return;

    const q = query(
      collection(db, "replies"),
      where("commentId", "==", commentId),
      orderBy("createdAt", "asc")
    );

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const fetchedReplies = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Reply[];

      setReplies(fetchedReplies);
      setLoading(false);

      // Mark as seen
      if (currentUser?.uid) {
        for (const reply of fetchedReplies) {
          if (!reply.seenBy?.includes(currentUser.uid)) {
            try {
              await updateDoc(doc(db, "replies", reply.id), {
                seenBy: arrayUnion(currentUser.uid),
              });
            } catch (err) {
              console.log("Error marking reply as seen:", err);
            }
          }
        }
      }
    });

    return unsubscribe;
  }, [commentId, currentUser?.uid]);

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

    // Update parent comment reply count
    await updateDoc(doc(db, "comments", commentId), {
      replyCount: replies.length + 1,
    });

    setReplyingTo(null);

    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 300);
  };

  const handleLikeReply = async (replyId: string, likedBy: string[]) => {
    if (!currentUser?.uid) return;

    const replyRef = doc(db, "replies", replyId);
    const isLiked = likedBy.includes(currentUser.uid);

    try {
      if (isLiked) {
        await updateDoc(replyRef, {
          likedBy: arrayRemove(currentUser.uid),
          likeCount: Math.max(0, (likedBy.length || 1) - 1),
        });
      } else {
        await updateDoc(replyRef, {
          likedBy: arrayUnion(currentUser.uid),
          likeCount: (likedBy.length || 0) + 1,
        });
      }
    } catch (error) {
      console.error("Error toggling like:", error);
    }
  };

  const handleDeleteReply = async (replyId: string) => {
    Alert.alert("Delete Reply", "Are you sure you want to delete this reply?", [
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
            Alert.alert("Success", "Reply deleted successfully");
          } catch (error) {
            console.error("Error deleting reply:", error);
            Alert.alert("Error", "Failed to delete reply");
          }
        },
      },
    ]);
  };

  const handleReportReply = async (replyId: string) => {
    Alert.alert("Report Reply", "Why are you reporting this reply?", [
      { text: "Cancel", style: "cancel" },
      { text: "Spam", onPress: () => submitReport(replyId, "spam") },
      { text: "Harassment", onPress: () => submitReport(replyId, "harassment") },
      { text: "Inappropriate Content", onPress: () => submitReport(replyId, "inappropriate") },
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
      Alert.alert("Success", "Reply reported successfully");
    } catch (error) {
      console.error("Error reporting reply:", error);
      Alert.alert("Error", "Failed to report reply");
    }
  };

  const handleViewSeenBy = (seenBy: string[]) => {
    setSelectedReplySeenBy(seenBy);
    setShowSeenModal(true);
  };

  const getTimeAgo = (timestamp: any) => {
    if (!timestamp) return "";
    const now = new Date();
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSec < 60) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d`;
  };

  const handleLinkPress = (url: string) => {
    Linking.canOpenURL(url)
      .then((supported) => {
        if (supported) Linking.openURL(url);
        else Alert.alert("Invalid Link", "Cannot open this URL");
      })
      .catch(() => Alert.alert("Error", "Failed to open link"));
  };

  const handleFilePress = async (url: string, filename: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) await Linking.openURL(url);
      else Alert.alert("Error", "Cannot open this file");
    } catch (error) {
      console.error("Error opening file:", error);
      Alert.alert("Error", "Failed to open file");
    }
  };

  const getFileDisplayName = (file: { url: string; mimeType: string; name?: string }) => {
    if (file.name) return file.name;
    const urlParts = file.url.split("/");
    const lastPart = urlParts[urlParts.length - 1];
    const filename = lastPart.split("?")[0];
    return decodeURIComponent(filename);
  };

  const handleImagePress = (images: string[], startIndex: number) => {
    setSelectedImages(images);
    setSelectedImageIndex(startIndex);
    setImageViewerVisible(true);
  };

  const handleProfileClick = async (reply: Reply) => {
    const isReplyAnonymous = reply.isAnonymous ?? true;
    const userIdToNavigate = reply.realUserId || reply.userId;

    if (isReplyAnonymous || !userIdToNavigate || userIdToNavigate === "anonymous") return;

    try {
      if (currentUser && userIdToNavigate === currentUser.uid) {
        router.push("../../(tabs)/ProfileScreen");
      } else {
        router.push(`../../UserProfileScreen?userId=${userIdToNavigate}`);
      }
    } catch (error) {
      console.log("Navigation error:", error);
    }
  };

  const handleTagClick = (taggedUserId: string) => {
    try {
      if (currentUser && taggedUserId === currentUser.uid) {
        router.push("../../(tabs)/ProfileScreen");
      } else {
        router.push(`../../UserProfileScreen?userId=${taggedUserId}`);
      }
    } catch (error) {
      console.log("Navigation error:", error);
    }
  };

  const handleLongPress = (reply: Reply) => {
    const isCurrentUser = reply.realUserId === currentUser?.uid;
    const options = isCurrentUser
      ? ["Reply", "Delete", "Cancel"]
      : ["Reply", "Report", "See who seen this reply", "Cancel"];

    const destructiveButtonIndex = isCurrentUser ? 1 : 1;
    const cancelButtonIndex = options.length - 1;

    Alert.alert("Reply Options", "", options.map((option, index) => ({
      text: option,
      style:
        index === cancelButtonIndex ? "cancel" :
        index === destructiveButtonIndex ? "destructive" : "default",
      onPress: () => {
        if (option === "Reply") {
          const targetName = reply.username || "Anonymous";
          setReplyingTo({ id: reply.id, name: targetName, text: reply.text || "" });
        } else if (option === "Report") {
          handleReportReply(reply.id);
        } else if (option === "See who seen this reply") {
          handleViewSeenBy(reply.seenBy || []);
        } else if (option === "Delete") {
          handleDeleteReply(reply.id);
        }
      },
    })), { cancelable: true });
  };

  const renderReply = ({ item }: { item: Reply }) => {
    return <ReplyItem item={item} onReplyClick={handleReplyClick} />;
  };

  const ReplyItem: React.FC<{ item: Reply; onReplyClick: (id: string, name: string, text: string) => void }> = ({
    item,
    onReplyClick,
  }) => {
    const isCurrentUser = item.realUserId === currentUser?.uid;
    const isAnon = item.isAnonymous ?? true;
    const isLiked = (item.likedBy || []).includes(currentUser?.uid || "");

    const [authorData, setAuthorData] = useState<any>(null);

    useEffect(() => {
      const fetchAuthor = async () => {
        const userIdToFetch = item.realUserId || item.userId;
        if (userIdToFetch && userIdToFetch !== "anonymous") {
          try {
            const data = await getUserData(userIdToFetch);
            setAuthorData(data);
          } catch (err) {
            console.log("Error fetching author:", err);
          }
        }
      };
      fetchAuthor();
    }, [item.realUserId, item.userId]);

    const authorRole = authorData?.role || item.role || "student";
    const roleColor = getRoleColor(authorRole);

    const displayName = isAnon
      ? "Anonymous"
      : authorData
      ? `${authorData.firstname} ${authorData.lastname}`
      : item.username || "User";

    const imageFiles = (item.files || []).filter(
      (f) => f.mimeType.startsWith("image/") && !f.mimeType.includes("gif")
    );
    const gifFiles = (item.files || []).filter((f) => f.mimeType.includes("gif"));
    const docFiles = (item.files || []).filter((f) => !f.mimeType.startsWith("image/"));

    return (
      <TouchableOpacity
        onLongPress={() => handleLongPress(item)}
        activeOpacity={0.9}
        style={[styles.replyContainer, isCurrentUser ? styles.replyRight : styles.replyLeft]}
      >
        {!isCurrentUser && (
          <TouchableOpacity onPress={() => handleProfileClick(item)} disabled={isAnon}>
            <View
              style={[
                styles.avatarSmall,
                !isAnon && authorRole !== "student" && { borderColor: roleColor, borderWidth: 2 },
              ]}
            >
              {isAnon ? (
                <Ionicons name="person" size={12} color="#8ea0d0" />
              ) : item.profilePic ? (
                <Image source={{ uri: item.profilePic }} style={styles.avatarImageSmall} />
              ) : (
                <Text style={[styles.avatarTextTiny, { color: roleColor }]}>
                  {displayName[0]?.toUpperCase() || "U"}
                </Text>
              )}
            </View>
          </TouchableOpacity>
        )}

        <View
          style={[
            styles.replyBubble,
            isCurrentUser ? styles.bubbleRight : styles.bubbleLeft,
          ]}
        >
          {!isCurrentUser && (
            <TouchableOpacity onPress={() => handleProfileClick(item)} disabled={isAnon}>
              <Text style={[styles.replyAuthor, { color: isAnon ? "#8ea0d0" : roleColor }]}>
                {displayName}
              </Text>
            </TouchableOpacity>
          )}

          {item.replyingTo && (
            <View style={styles.replyPreviewContainer}>
              <View style={styles.replyPreviewBar} />
              <View style={styles.replyPreviewContent}>
                <Text style={styles.replyPreviewAuthor}>{item.replyingTo.name}</Text>
                <Text style={styles.replyPreviewText} numberOfLines={2}>
                  {item.replyingTo.text || "Message"}
                </Text>
              </View>
            </View>
          )}

          {item.text && (
            <Text style={[styles.replyText, isCurrentUser && styles.replyTextRight]}>
              {item.text}
            </Text>
          )}

          {gifFiles.length > 0 && (
            <View style={styles.replyGifContainer}>
              <Image source={{ uri: gifFiles[0].url }} style={styles.replyGif} resizeMode="cover" />
            </View>
          )}

          {imageFiles.length > 0 && (
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() => {
                const imageUrls = imageFiles.map((f) => f.url);
                handleImagePress(imageUrls, 0);
              }}
              style={styles.replyImageContainer}
            >
              <Image source={{ uri: imageFiles[0].url }} style={styles.replyImage} resizeMode="cover" />
              {imageFiles.length > 1 && (
                <View style={styles.imageCountBadge}>
                  <Text style={styles.imageCountText}>+{imageFiles.length - 1}</Text>
                </View>
              )}
            </TouchableOpacity>
          )}

          {docFiles.length > 0 && (
            <View style={styles.replyDocsContainer}>
              {docFiles.map((file, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={styles.replyDocItem}
                  activeOpacity={0.7}
                  onPress={() => handleFilePress(file.url, getFileDisplayName(file))}
                >
                  <Ionicons
                    name={file.mimeType.includes("pdf") ? "document-text" : "document"}
                    size={14}
                    color={isCurrentUser ? "#fff" : "#4f9cff"}
                  />
                  <Text
                    style={[styles.replyDocText, isCurrentUser && { color: "#fff" }]}
                    numberOfLines={1}
                  >
                    {getFileDisplayName(file)}
                  </Text>
                  <Ionicons
                    name="download-outline"
                    size={12}
                    color={isCurrentUser ? "#ffffff" : "#a0a8c0"}
                  />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {item.link && (
            <TouchableOpacity
              style={[styles.replyLinkPreview, isCurrentUser && styles.replyLinkPreviewRight]}
              onPress={() => handleLinkPress(item.link!.url)}
              activeOpacity={0.7}
            >
              <Ionicons name="link" size={14} color={isCurrentUser ? "#fff" : "#4f9cff"} />
              <View style={{ flex: 1, marginLeft: 6 }}>
                <Text style={[styles.replyLinkTitle, isCurrentUser && { color: "#fff" }]} numberOfLines={1}>
                  {item.link.title}
                </Text>
                <Text style={[styles.replyLinkUrl, isCurrentUser && { color: "#ffffff99" }]} numberOfLines={1}>
                  {item.link.url}
                </Text>
              </View>
              <Ionicons name="open-outline" size={12} color={isCurrentUser ? "#ffffff" : "#a0a8c0"} />
            </TouchableOpacity>
          )}

          {item.taggedUsers && item.taggedUsers.length > 0 && (
            <View style={[styles.replyTaggedSection, isCurrentUser && styles.replyTaggedSectionRight]}>
              <Ionicons name="people-outline" size={11} color={isCurrentUser ? "#ffffff" : "#ff5c93"} />
              <Text style={[styles.replyTaggedText, isCurrentUser && { color: "#ffffff" }]}>with </Text>
              <View style={styles.taggedNamesContainer}>
                {item.taggedUsers.map((tag, idx) => (
                  <React.Fragment key={tag.id}>
                    <TouchableOpacity onPress={() => handleTagClick(tag.id)}>
                      <Text style={[styles.replyTaggedName, isCurrentUser && { color: "#fff" }]}>
                        {tag.name}
                      </Text>
                    </TouchableOpacity>
                    {idx < item.taggedUsers!.length - 1 && (
                      <Text style={[styles.replyTaggedText, isCurrentUser && { color: "#ffffff" }]}>
                        {", "}
                      </Text>
                    )}
                  </React.Fragment>
                ))}
              </View>
            </View>
          )}

          <View style={styles.replyFooter}>
            <Text style={[styles.replyTime, isCurrentUser && styles.replyTimeRight]}>
              {getTimeAgo(item.createdAt)}
            </Text>

            <View style={styles.replyActions}>
              <TouchableOpacity
                style={styles.replyActionButton}
                onPress={() => handleLikeReply(item.id, item.likedBy || [])}
              >
                <Ionicons
                  name={isLiked ? "heart" : "heart-outline"}
                  size={14}
                  color={isLiked ? "#ff5c93" : isCurrentUser ? "#ffffff" : "#8ea0d0"}
                />
                {(item.likeCount || 0) > 0 && (
                  <Text style={[styles.replyActionText, isCurrentUser && { color: "#ffffff" }]}>
                    {item.likeCount}
                  </Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.replyActionButton}
                onPress={() => onReplyClick(item.id, item.username || "Anonymous", item.text || "")}
              >
                <Ionicons name="chatbubble-outline" size={14} color={isCurrentUser ? "#ffffff" : "#8ea0d0"} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <>
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: "#0f1624" }}>
          {/* Header */}
          <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}>
              <Ionicons name="arrow-back" size={28} color="#ff3b7f" />
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle}>Reply to {commentAuthor}</Text>
              <Text style={styles.headerSubtitle}>
                {replies.length} {replies.length === 1 ? "reply" : "replies"}
              </Text>
            </View>
            <View style={{ width: 48 }} />
          </View>

          {/* List or Empty State */}
          {loading ? (
            <ActivityIndicator color="#ff3b7f" style={{ flex: 1, marginTop: 40 }} />
          ) : replies.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="chatbubble-outline" size={48} color="#8ea0d0" />
              <Text style={styles.emptyText}>No replies yet</Text>
              <Text style={styles.emptySubText}>Start the conversation!</Text>
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={replies}
              keyExtractor={(item) => item.id}
              renderItem={renderReply}
              contentContainerStyle={{ 
                paddingHorizontal: 16, 
                paddingTop: 12,
                paddingBottom: 8
              }}
              showsVerticalScrollIndicator={false}
            />
          )}

          {/* Optimized Composer – Full-width, minimal padding, seamless */}
          {currentUser && (
            <View
              style={{
                paddingHorizontal: 0,
                paddingTop: 6,
                paddingBottom: keyboardHeight > 0 ? 8 : Math.max(insets.bottom, 8),
                backgroundColor: "#1c2535",
              }}
            >
              <CommentComposer
                currentUser={currentUser}
                onSend={handleSendReply}
                placeholder="Write a reply..."
                replyingTo={replyingTo}
                onCancelReply={() => setReplyingTo(null)}
              />
            </View>
          )}
        </View>
      </Modal>

      {/* Seen By Modal */}
      <SeenByModal
        visible={showSeenModal}
        onClose={() => setShowSeenModal(false)}
        seenBy={selectedReplySeenBy}
        onProfileClick={handleProfileClick}
        currentUserId={currentUser?.uid}
      />

      {/* Image Viewer Modal */}
      <Modal visible={imageViewerVisible} transparent animationType="fade" onRequestClose={() => setImageViewerVisible(false)}>
        <View style={styles.imageViewerContainer}>
          <TouchableOpacity style={styles.imageViewerClose} onPress={() => setImageViewerVisible(false)}>
            <Ionicons name="close" size={32} color="#fff" />
          </TouchableOpacity>

          <FlatList
            data={selectedImages}
            horizontal
            pagingEnabled
            initialScrollIndex={selectedImageIndex}
            getItemLayout={(_, index) => ({ length: SCREEN_WIDTH, offset: SCREEN_WIDTH * index, index })}
            onScrollToIndexFailed={() => {}}
            renderItem={({ item }) => (
              <View style={styles.imageViewerPage}>
                <Image source={{ uri: item }} style={styles.imageViewerImage} resizeMode="contain" />
              </View>
            )}
            keyExtractor={(_, index) => index.toString()}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(event) => {
              const index = Math.round(event.nativeEvent.contentOffset.x / SCREEN_WIDTH);
              setSelectedImageIndex(index);
            }}
          />

          {selectedImages.length > 1 && (
            <View style={styles.imageViewerCounter}>
              <Text style={styles.imageViewerCounterText}>
                {selectedImageIndex + 1} / {selectedImages.length}
              </Text>
            </View>
          )}
        </View>
      </Modal>
    </>
  );
};

// SeenByModal remains unchanged
interface SeenByModalProps {
  visible: boolean;
  onClose: () => void;
  seenBy: string[];
  onProfileClick: (reply: any) => void;
  currentUserId?: string;
}

const SeenByModal: React.FC<SeenByModalProps> = ({
  visible,
  onClose,
  seenBy,
  onProfileClick,
  currentUserId,
}) => {
  const [usersData, setUsersData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsers = async () => {
      if (!visible || seenBy.length === 0) return;

      setLoading(true);
      try {
        const users = await Promise.all(
          seenBy.map(async (userId) => {
            try {
              return await getUserData(userId);
            } catch {
              return null;
            }
          })
        );
        setUsersData(users.filter((u) => u !== null));
      } catch {
        console.error("Error fetching users");
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, [visible, seenBy]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.seenModalContent} onStartShouldSetResponder={() => true}>
          <View style={styles.seenModalHeader}>
            <Text style={styles.seenModalTitle}>Seen by ({seenBy.length})</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color="#e9edff" />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#ff5c93" />
            </View>
          ) : usersData.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="eye-outline" size={48} color="#8ea0d0" />
              <Text style={styles.emptyText}>No views yet</Text>
            </View>
          ) : (
            <FlatList
              data={usersData}
              keyExtractor={(item) => item.userId}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.seenUserItem}
                  onPress={() => {
                    onClose();
                    onProfileClick({ realUserId: item.userId, isAnonymous: false });
                  }}
                  activeOpacity={0.7}
                >
                  <View
                    style={[
                      styles.seenUserAvatar,
                      item.role !== "student" && {
                        borderColor: getRoleColor(item.role),
                        borderWidth: 2,
                      },
                    ]}
                  >
                    <Text style={[styles.seenUserAvatarText, { color: getRoleColor(item.role) }]}>
                      {item.firstname[0].toUpperCase()}
                    </Text>
                  </View>

                  <View style={styles.seenUserInfo}>
                    <Text style={styles.seenUserName}>{item.firstname} {item.lastname}</Text>
                    {item.role !== "student" && (
                      <View
                        style={[
                          styles.seenUserRoleChip,
                          { backgroundColor: getRoleColor(item.role) + "20", borderColor: getRoleColor(item.role) },
                        ]}
                      >
                        <Text style={[styles.seenUserRoleText, { color: getRoleColor(item.role) }]}>
                          {getRoleDisplayName(item.role)}
                        </Text>
                      </View>
                    )}
                  </View>

                  <Ionicons name="eye" size={18} color="#8ea0d0" />
                </TouchableOpacity>
              )}
              style={styles.seenUsersList}
            />
          )}
        </View>
      </TouchableOpacity>
    </Modal>
  );
};

export default ReplyThread;

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1f2937",
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    marginLeft: -32,
  },
  headerTitle: {
    color: "#e9edff",
    fontSize: 16,
    fontWeight: "700",
  },
  headerSubtitle: {
    color: "#8ea0d0",
    fontSize: 12,
    marginTop: 2,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyText: {
    color: "#e9edff",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 16,
  },
  emptySubText: {
    color: "#8ea0d0",
    fontSize: 14,
    marginTop: 4,
  },
  replyContainer: {
    flexDirection: "row",
    marginBottom: 12,
    alignItems: "flex-end",
  },
  replyLeft: {
    justifyContent: "flex-start",
  },
  replyRight: {
    justifyContent: "flex-end",
  },
  avatarSmall: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  avatarImageSmall: {
    width: "100%",
    height: "100%",
  },
  avatarTextTiny: {
    fontSize: 12,
    fontWeight: "700",
  },
  replyBubble: {
    maxWidth: "70%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    marginHorizontal: 8,
  },
  bubbleLeft: {
    backgroundColor: "#1c2535",
    borderBottomLeftRadius: 4,
  },
  bubbleRight: {
    backgroundColor: "#ff3b7f",
    borderBottomRightRadius: 4,
  },
  replyAuthor: {
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 4,
  },
  replyPreviewContainer: {
    flexDirection: "row",
    marginBottom: 8,
    paddingLeft: 8,
    opacity: 0.8,
  },
  replyPreviewBar: {
    width: 3,
    backgroundColor: "#ff5c93",
    borderRadius: 2,
    marginRight: 8,
  },
  replyPreviewContent: {
    flex: 1,
  },
  replyPreviewAuthor: {
    fontSize: 10,
    fontWeight: "700",
    color: "#ff5c93",
    marginBottom: 2,
  },
  replyPreviewText: {
    fontSize: 11,
    color: "#ffffff99",
    lineHeight: 14,
  },
  replyText: {
    color: "#e9edff",
    fontSize: 14,
    lineHeight: 20,
  },
  replyTextRight: {
    color: "#ffffff",
  },
  replyGifContainer: {
    marginTop: 6,
    borderRadius: 8,
    overflow: "hidden",
  },
  replyGif: {
    width: 200,
    height: 150,
  },
  replyImageContainer: {
    marginTop: 6,
    borderRadius: 8,
    overflow: "hidden",
    position: "relative",
  },
  replyImage: {
    width: 200,
    height: 150,
  },
  imageCountBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  imageCountText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "bold",
  },
  replyDocsContainer: {
    marginTop: 6,
    gap: 4,
  },
  replyDocItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.2)",
    padding: 6,
    borderRadius: 6,
  },
  replyDocText: {
    flex: 1,
    color: "#4f9cff",
    fontSize: 11,
    fontWeight: "500",
  },
  replyLinkPreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.2)",
    padding: 8,
    borderRadius: 6,
    marginTop: 6,
  },
  replyLinkPreviewRight: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  replyLinkTitle: {
    color: "#4f9cff",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 2,
  },
  replyLinkUrl: {
    color: "#8ea0d0",
    fontSize: 10,
  },
  replyTaggedSection: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 6,
    backgroundColor: "#243054",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  replyTaggedSectionRight: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  taggedNamesContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
  },
  replyTaggedText: {
    color: "#a0a8c0",
    fontSize: 11,
  },
  replyTaggedName: {
    color: "#ff5c93",
    fontWeight: "600",
    fontSize: 11,
  },
  replyFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 6,
  },
  replyTime: {
    color: "#8ea0d0",
    fontSize: 10,
  },
  replyTimeRight: {
    color: "#ffffff",
  },
  replyActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  replyActionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  replyActionText: {
    color: "#8ea0d0",
    fontSize: 10,
    fontWeight: "500",
  },
  imageViewerContainer: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  imageViewerClose: {
    position: "absolute",
    top: 50,
    right: 20,
    zIndex: 10,
    padding: 8,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 20,
  },
  imageViewerPage: {
    width: SCREEN_WIDTH,
    justifyContent: "center",
    alignItems: "center",
  },
  imageViewerImage: {
    width: "100%",
    height: "100%",
  },
  imageViewerCounter: {
    position: "absolute",
    bottom: 40,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  imageViewerCounterText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
  },
  seenModalContent: {
    backgroundColor: "#1b2235",
    borderRadius: 16,
    width: "85%",
    maxHeight: "70%",
    overflow: "hidden",
  },
  seenModalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#243054",
  },
  seenModalTitle: {
    color: "#e9edff",
    fontSize: 18,
    fontWeight: "600",
  },
  loadingContainer: {
    padding: 40,
    justifyContent: "center",
    alignItems: "center",
  },
  seenUsersList: {
    maxHeight: 400,
  },
  seenUserItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#243054",
  },
  seenUserAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
  },
  seenUserAvatarText: {
    fontSize: 18,
    fontWeight: "bold",
  },
  seenUserInfo: {
    flex: 1,
  },
  seenUserName: {
    color: "#e9edff",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 4,
  },
  seenUserRoleChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  seenUserRoleText: {
    fontSize: 10,
    fontWeight: "600",
  },
});
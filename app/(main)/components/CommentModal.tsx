// Updated CommentModal.tsx with Full Screen and Draggable Header Only
import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Image,
  ActivityIndicator,
  BackHandler,
  Alert,
  Linking,
  Dimensions,
  PanResponder,
  Animated,
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
  getDoc,
  increment,
  serverTimestamp,
} from "firebase/firestore";
import { db, auth } from "../../../Firebase_configure";

import ReplyThread from "./ReplyThread";
import {
  getUserData,
  getRoleColor,
  getRoleDisplayName,
  UserRole,
} from "@/utils/rbac";

import CommentComposer from "./CommentComposer";


const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

type Comment = {
  id: string;
  text: string;
  userId: string;
  realUserId?: string;
  username?: string;
  createdAt: any;
  role?: string;
  likes?: string[];
  profilePic?: string;
  isAnonymous?: boolean;
  replyCount?: number;
  files?: { url: string; mimeType: string; name?: string }[];
  link?: { url: string; title: string };
  taggedUsers?: { id: string; name: string; studentID: string }[];
  onImagePress?: (images: string[], index: number) => void;
  onLinkPress?: (url: string) => void;
  onTagClick?: (userId: string) => void;
  onFilePress?: (url: string, name: string) => void;
};

type CommentModalProps = {
  visible: boolean;
  onClose: () => void;
  postId: string;
  currentUserId?: string;
  currentUserRole?: UserRole;
  onCommentAdded?: () => void;
};

type SortOption = "latest" | "relevant" | "all";

// ✅ Comment Item Component
interface CommentItemProps {
  item: Comment;
  user: any;
  onLike: (commentId: string) => void;
  onProfileClick: (comment: Comment) => void;
  onReply: (comment: Comment) => void;
  getTimeAgo: (timestamp: any) => string;
}

const CommentItem: React.FC<CommentItemProps> = ({
  item,
  user,
  onLike,
  onProfileClick,
  onReply,
  getTimeAgo,
}) => {
  const [authorData, setAuthorData] = useState<any>(null);
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const MAX_LINES = 6;
  const CHARS_PER_LINE = 50;
  const MAX_CHARS = MAX_LINES * CHARS_PER_LINE;
  const needsExpansion = item.text.length > MAX_CHARS;

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
  const roleDisplayName = getRoleDisplayName(authorRole);

  const canSeeIdentity =
    user?.role === "admin" ||
    ((user?.role === "teacher" || user?.role === "moderator") &&
      authorRole === "student");

  const canShowEyeIcon = (item.isAnonymous ?? true) && canSeeIdentity;
  const isIdentityVisible = !item.isAnonymous || (revealed && canSeeIdentity);

  const displayName = isIdentityVisible
    ? authorData
      ? `${authorData.firstname} ${authorData.lastname}`
      : item.username || "User"
    : "Anonymous";

  const canClickProfile =
    isIdentityVisible && !!authorData?.userId && authorData.userId !== "anonymous";

  const liked = item.likes?.includes(user?.uid);
  const displayText = expanded || !needsExpansion
    ? item.text
    : item.text.substring(0, MAX_CHARS) + "...";

  // Separate images and documents
  const imageFiles = (item.files || []).filter((f) => f.mimeType.startsWith("image/") && !f.mimeType.includes("gif"));
  const gifFiles = (item.files || []).filter((f) => f.mimeType.includes("gif"));
  const docFiles = (item.files || []).filter((f) => !f.mimeType.startsWith("image/"));

  const [imageHeight, setImageHeight] = useState(200);

  useEffect(() => {
    if (imageFiles.length > 0) {
      Image.getSize(imageFiles[0].url, (width, height) => {
        const aspectRatio = height / width;
        const calculatedHeight = SCREEN_WIDTH * aspectRatio;
        setImageHeight(Math.min(calculatedHeight, 500));
      }, (error) => {
        console.log("Error getting image size:", error);
        setImageHeight(200);
      });
    }
  }, [imageFiles]);

  const getFileDisplayName = (file: { url: string; mimeType: string; name?: string }) => {
    if (file.name) return file.name;
    
    const urlParts = file.url.split('/');
    const lastPart = urlParts[urlParts.length - 1];
    const filename = lastPart.split('?')[0];
    
    return decodeURIComponent(filename);
  };

  return (
    <View style={styles.commentItem}>
      <View style={styles.commentTopRow}>
        <TouchableOpacity
          onPress={() => canClickProfile && onProfileClick(item)}
          disabled={!canClickProfile}
        >
          <View
            style={[
              styles.avatar,
              isIdentityVisible && authorRole !== "student" && {
                borderColor: roleColor,
                borderWidth: 2,
              },
            ]}
          >
            {isIdentityVisible ? (
              item.profilePic ? (
                <Image
                  source={{ uri: item.profilePic }}
                  style={styles.avatarImage}
                />
              ) : (
                <Text style={[styles.avatarText, { color: roleColor }]}>
                  {(authorData?.firstname?.[0] || displayName[0] || "A").toUpperCase()}
                </Text>
              )
            ) : (
              <Ionicons name="person" size={16} color="#8ea0d0" />
            )}
          </View>
        </TouchableOpacity>

        <View style={{ flex: 1 }}>
          <View style={styles.nameRow}>
            <TouchableOpacity
              onPress={() => canClickProfile && onProfileClick(item)}
              disabled={!canClickProfile}
            >
              <Text
                style={[
                  styles.commentName,
                  { color: isIdentityVisible ? roleColor : "#8ea0d0" },
                ]}
              >
                {displayName}
              </Text>
            </TouchableOpacity>

            {isIdentityVisible && authorRole !== "student" && (
              <View
                style={[
                  styles.roleChip,
                  { backgroundColor: roleColor + "20", borderColor: roleColor },
                ]}
              >
                <Text style={[styles.roleChipText, { color: roleColor }]}>
                  {roleDisplayName}
                </Text>
              </View>
            )}

            {canShowEyeIcon && (
              <TouchableOpacity
                onPress={() => setRevealed(!revealed)}
                style={styles.eyeButton}
              >
                <Ionicons
                  name={revealed ? "eye-off-outline" : "eye-outline"}
                  size={14}
                  color={revealed ? "#ff3b7f" : "#8ea0d0"}
                />
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.commentRole}>
            {getTimeAgo(item.createdAt)}
          </Text>
        </View>
      </View>

      {/* Content without hanging indentation */}
      <View>
        <Text style={styles.commentText}>{displayText}</Text>
        {needsExpansion && (
          <TouchableOpacity 
            onPress={() => setExpanded(!expanded)}
            style={styles.seeMoreButton}
          >
            <Text style={styles.seeMoreText}>
              {expanded ? "See less" : "See more"}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* GIFs */}
      {gifFiles.length > 0 && (
        <View style={styles.commentGifContainer}>
          <Image 
            source={{ uri: gifFiles[0].url }} 
            style={styles.commentGif}
            resizeMode="cover"
          />
        </View>
      )}

      {/* Images */}
      {imageFiles.length > 0 && (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => {
            const imageUrls = imageFiles.map(f => f.url);
            item.onImagePress?.(imageUrls, 0);
          }}
          style={styles.commentImageContainer}
        >
          <Image 
            source={{ uri: imageFiles[0].url }} 
            style={[styles.commentImageFull, { height: imageHeight }]}
            resizeMode="cover"
          />
          {imageFiles.length > 1 && (
            <View style={styles.imageCountBadge}>
              <Ionicons name="images" size={14} color="#fff" />
              <Text style={styles.imageCountText}>+{imageFiles.length - 1}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* Documents */}
      {docFiles.length > 0 && (
        <View style={styles.commentDocsContainer}>
          {docFiles.map((file, idx) => (
            <TouchableOpacity 
              key={idx} 
              style={styles.commentDocItem}
              activeOpacity={0.7}
              onPress={() => item.onFilePress?.(file.url, getFileDisplayName(file))}
            >
              <Ionicons 
                name={file.mimeType.includes("pdf") ? "document-text" : "document"} 
                size={16} 
                color="#4f9cff" 
              />
              <Text style={styles.commentDocText} numberOfLines={1}>
                {getFileDisplayName(file)}
              </Text>
              <Ionicons name="download-outline" size={14} color="#a0a8c0" />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Link Preview */}
      {item.link && (
        <TouchableOpacity 
          style={styles.commentLinkPreview}
          onPress={() => item.link && item.onLinkPress?.(item.link.url)}
          activeOpacity={0.7}
        >
          <Ionicons name="link" size={16} color="#4f9cff" />
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={styles.commentLinkTitle} numberOfLines={1}>
              {item.link.title}
            </Text>
            <Text style={styles.commentLinkUrl} numberOfLines={1}>
              {item.link.url}
            </Text>
          </View>
          <Ionicons name="open-outline" size={14} color="#a0a8c0" />
        </TouchableOpacity>
      )}

      {/* Tagged Users */}
      {item.taggedUsers && item.taggedUsers.length > 0 && (
        <View style={styles.commentTaggedContainer}>
          <Ionicons name="people-outline" size={12} color="#ff5c93" />
          <Text style={styles.commentTaggedText}>with </Text>
          {item.taggedUsers?.map((tag, idx) => (
            <React.Fragment key={tag.id}>
              <TouchableOpacity onPress={() => item.onTagClick?.(tag.id)}>
                <Text style={styles.commentTaggedName}>{tag.name}</Text>
              </TouchableOpacity>
              {idx < (item.taggedUsers?.length ?? 0) - 1 && (
                <Text style={styles.commentTaggedText}>, </Text>
              )}
            </React.Fragment>
          ))}
        </View>
      )}

      <View style={styles.actionRow}>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => onLike(item.id)}
        >
          <Ionicons
            name={liked ? "heart" : "heart-outline"}
            size={16}
            color={liked ? "#ff3b7f" : "#bbb"}
          />
          <Text style={styles.actionText}>
            {item.likes?.length || 0}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => onReply(item)}
        >
          <Ionicons name="chatbubble-outline" size={14} color="#bbb" />
          <Text style={styles.actionText}>
            {item.replyCount || 0}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const CommentModal: React.FC<CommentModalProps> = ({
  visible,
  onClose,
  postId,
}) => {
  // NEW: Internal visible state for animation control (decouples from prop for smooth closes)
  const [internalVisible, setInternalVisible] = useState(visible);
  const [comments, setComments] = useState<Comment[]>([]);
  const [displayedComments, setDisplayedComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [sortBy, setSortBy] = useState<SortOption>("latest");
  const [replyModalVisible, setReplyModalVisible] = useState(false);
  const [selectedComment, setSelectedComment] = useState<Comment | null>(null);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  const flatListRef = useRef<FlatList>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Drag-to-close animation
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  // NEW: Sync internal visible to prop (for open), but don't snap on close
  useEffect(() => {
    setInternalVisible(visible);
  }, [visible]);

  // UPDATED: Show modal animation (use internalVisible)
  useEffect(() => {
    if (internalVisible) {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }
    // Removed else block—no snap on close; handled by closeAndNavigate
  }, [backdropOpacity, translateY, internalVisible]);

  const [isNavigating, setIsNavigating] = useState(false);

  // NEW: Helper to animate close, then unmount + navigate (or just unmount)
  const closeAndNavigate = useCallback((navigateFn?: () => void) => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: SCREEN_HEIGHT,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setInternalVisible(false); // Actually unmount
      onClose(); // Notify parent
      if (navigateFn) {
        navigateFn(); // Trigger nav after dismiss
      }
    });
  }, [backdropOpacity, onClose, translateY]);

  // UPDATED: Wrapper for regular closes (no nav)
  const handleClose = useCallback(() => {
    closeAndNavigate();
  }, [closeAndNavigate]);

  // Pan responder only for header area
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        const isDraggingDown = gestureState.dy > 10;
        const isVertical = Math.abs(gestureState.dy) > Math.abs(gestureState.dx) * 2;
        return isDraggingDown && isVertical;
      },
      onPanResponderGrant: () => {},
      onPanResponderMove: (evt, gestureState) => {
        if (gestureState.dy > 0) {
          translateY.setValue(gestureState.dy);
          const opacity = 1 - (gestureState.dy / SCREEN_HEIGHT);
          backdropOpacity.setValue(Math.max(0, opacity));
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (gestureState.dy > 150 || gestureState.vy > 0.8) {
          // UPDATED: Use handleClose instead of direct onClose
          handleClose();
        } else {
          Animated.parallel([
            Animated.spring(translateY, {
              toValue: 0,
              useNativeDriver: true,
              tension: 65,
              friction: 10,
            }),
            Animated.timing(backdropOpacity, {
              toValue: 1,
              duration: 200,
              useNativeDriver: true,
            }),
          ]).start();
        }
      },
    })
  ).current;

  useEffect(() => {
    const backHandler = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (isNavigating) {
          setIsNavigating(false);
          return false;
        }
        if (internalVisible && !replyModalVisible) { // UPDATED: Use internalVisible
          handleClose(); // UPDATED: Use handleClose
          return true;
        }
        return false;
      }
    );
    return () => backHandler.remove();
  }, [internalVisible, replyModalVisible, isNavigating, handleClose]); // UPDATED: Deps

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (u) => {
      if (u) {
        const userData = await getUserData(u.uid);
        setUser({ uid: u.uid, ...userData });
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!postId) return;
    const q = query(
      collection(db, "comments"),
      where("postId", "==", postId),
      orderBy("createdAt", "asc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedComments = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Comment[];
      setComments(fetchedComments);
      setLoading(false);
    });

    return unsubscribe;
  }, [postId]);

  useEffect(() => {
    let sorted = [...comments];
    
    switch (sortBy) {
      case "latest":
        sorted.sort((a, b) => {
          const timeA = a.createdAt?.toMillis?.() || 0;
          const timeB = b.createdAt?.toMillis?.() || 0;
          return timeB - timeA;
        });
        break;
      
      case "relevant":
        sorted.sort((a, b) => {
          const scoreA = (a.likes?.length || 0) + (a.replyCount || 0) * 2;
          const scoreB = (b.likes?.length || 0) + (b.replyCount || 0) * 2;
          return scoreB - scoreA;
        });
        break;
      
      case "all":
        sorted.sort((a, b) => {
          const timeA = a.createdAt?.toMillis?.() || 0;
          const timeB = b.createdAt?.toMillis?.() || 0;
          return timeA - timeB;
        });
        break;
    }
    
    setDisplayedComments(sorted);
  }, [comments, sortBy]);

  const handleSend = async (commentData: any) => {
    const newComment = {
      ...commentData,
      postId,
      createdAt: serverTimestamp(),
    };
    await addDoc(collection(db, "comments"), newComment);
    await updateDoc(doc(db, "posts", postId), {
      commentCount: increment(1),
    });
  };

  const handleLikeComment = async (commentId: string) => {
    if (!user) return;
    const commentRef = doc(db, "comments", commentId);
    const commentSnap = await getDoc(commentRef);

    if (commentSnap.exists()) {
      const commentData = commentSnap.data() as Comment;
      const existingLikes = commentData.likes || [];
      const updatedLikes = existingLikes.includes(user.uid)
        ? existingLikes.filter((uid) => uid !== user.uid)
        : [...existingLikes, user.uid];

      await updateDoc(commentRef, { likes: updatedLikes });
    }
  };

  const handleReply = (comment: Comment) => {
    setSelectedComment(comment);
    setReplyModalVisible(true);
  };

  // UPDATED: Use closeAndNavigate for smooth dismiss + nav (no invalid options)
  const handleProfileClick = useCallback((comment: Comment) => {
    const isCommentAnonymous = comment.isAnonymous ?? true;
    const userIdToNavigate = comment.realUserId || comment.userId;

    if (isCommentAnonymous || !userIdToNavigate || userIdToNavigate === "anonymous") {
      return;
    }

    try {
      setIsNavigating(true);
      closeAndNavigate(() => { // Animate out first, then nav
        if (user && userIdToNavigate === user.uid) {
          router.push("../../(tabs)/ProfileScreen");
        } else {
          router.push(`../../UserProfileScreen?userId=${userIdToNavigate}`);
        }
      });
    } catch (error) {
      console.log("Navigation error:", error);
      setIsNavigating(false);
    }
  }, [closeAndNavigate, user, router, setIsNavigating]);

  // UPDATED: Same for tags
  const handleTagClick = useCallback((taggedUserId: string) => {
    try {
      setIsNavigating(true);
      closeAndNavigate(() => {
        if (user && taggedUserId === user.uid) {
          router.push("../../(tabs)/ProfileScreen");
        } else {
          router.push(`../../UserProfileScreen?userId=${taggedUserId}`);
        }
      });
    } catch (error) {
      console.log("Navigation error:", error);
      setIsNavigating(false);
    }
  }, [closeAndNavigate, user, router, setIsNavigating]);

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
      if (supported) {
        await Linking.openURL(url);
      } else {
        Alert.alert("Error", "Cannot open this file");
      }
    } catch (error) {
      console.error("Error opening file:", error);
      Alert.alert("Error", "Failed to open file");
    }
  };

  const handleImagePress = (images: string[], startIndex: number) => {
    setSelectedImages(images);
    setSelectedImageIndex(startIndex);
    setImageViewerVisible(true);
  };

  const getTimeAgo = (timestamp: any) => {
    if (!timestamp) return "";
    const now = new Date();
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSec < 60) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  };

  // UPDATED: Render if internalVisible (prevents snap unmount)
  if (!internalVisible) return null;

  return (
    <>
      <Modal 
        visible={internalVisible} // UPDATED: Use internalVisible
        animationType="none"
        transparent
        onRequestClose={handleClose} // UPDATED
      >
        <View style={styles.modalOverlay}>
          <Animated.View 
            style={[
              styles.backdrop,
              { opacity: backdropOpacity }
            ]}
          >
            <TouchableOpacity 
              style={StyleSheet.absoluteFill} 
              activeOpacity={1} 
              onPress={handleClose} // UPDATED: Use handleClose
            />
          </Animated.View>

          <Animated.View 
            style={[
              styles.modalContainer, 
              { 
                paddingTop: insets.top,
                transform: [{ translateY }],
              }
            ]}
          >
            {/* Draggable Header Only */}
            <View {...panResponder.panHandlers}>
              <View style={styles.dragIndicatorContainer}>
                <View style={styles.dragIndicator} />
              </View>

              {/* Header */}
              <View style={styles.header}>
                <Text style={styles.headerTitle}>
                  Comments ({comments.length})
                </Text>
              </View>

              {/* Sort Options */}
              <View style={styles.sortContainer}>
                <TouchableOpacity
                  style={[
                    styles.sortButton,
                    sortBy === "latest" && styles.sortButtonActive,
                  ]}
                  onPress={() => setSortBy("latest")}
                >
                  <Ionicons
                    name="time-outline"
                    size={14}
                    color={sortBy === "latest" ? "#ff3b7f" : "#8ea0d0"}
                  />
                  <Text
                    style={[
                      styles.sortText,
                      sortBy === "latest" && styles.sortTextActive,
                    ]}
                  >
                    Latest
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.sortButton,
                    sortBy === "relevant" && styles.sortButtonActive,
                  ]}
                  onPress={() => setSortBy("relevant")}
                >
                  <Ionicons
                    name="trending-up-outline"
                    size={14}
                    color={sortBy === "relevant" ? "#ff3b7f" : "#8ea0d0"}
                  />
                  <Text
                    style={[
                      styles.sortText,
                      sortBy === "relevant" && styles.sortTextActive,
                    ]}
                  >
                    Relevant
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.sortButton,
                    sortBy === "all" && styles.sortButtonActive,
                  ]}
                  onPress={() => setSortBy("all")}
                >
                  <Ionicons
                    name="list-outline"
                    size={14}
                    color={sortBy === "all" ? "#ff3b7f" : "#8ea0d0"}
                  />
                  <Text
                    style={[
                      styles.sortText,
                      sortBy === "all" && styles.sortTextActive,
                    ]}
                  >
                    All
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Scrollable Content */}
<View style={styles.modalContent}>
  {loading ? (
    <ActivityIndicator color="#ff3b7f" style={{ marginTop: 40 }} />
  ) : displayedComments.length === 0 ? (
    <View style={styles.emptyContainer}>
      <Ionicons name="chatbubbles-outline" size={48} color="#8ea0d0" />
      <Text style={styles.emptyText}>No comments yet</Text>
      <Text style={styles.emptySubText}>Be the first to comment!</Text>
    </View>
  ) : (
    <FlatList
      ref={flatListRef}
      data={displayedComments}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <CommentItem
          item={{
            ...item,
            onImagePress: handleImagePress,
            onLinkPress: handleLinkPress,
            onTagClick: handleTagClick,
            onFilePress: handleFilePress,
          }}
          user={user}
          onLike={handleLikeComment}
          onProfileClick={handleProfileClick}
          onReply={handleReply}
          getTimeAgo={getTimeAgo}
        />
      )}
      contentContainerStyle={{ paddingBottom: 16 }}
      showsVerticalScrollIndicator={false}
    />
  )}

        {/* Clean Composer – No extra wrapper, minimal padding */}
{user && (
  <View style={{
    paddingHorizontal: 0,                    // Remove side padding
    paddingTop: 4,                           // Tiny top gap only
    paddingBottom: insets.bottom > 0 ? insets.bottom : 8,  // Safe area only, no extra
    backgroundColor: "#1c2535",              // Match composer's background/border
  }}>
    <CommentComposer
      currentUser={user}
      onSend={handleSend}
      placeholder="Write a comment..."
    />
  </View>
)}
      </View>
    </Animated.View>
  </View>
</Modal>

      {/* Reply Thread Modal */}
      {selectedComment && (
        <ReplyThread
          visible={replyModalVisible}
          onClose={() => {
            setReplyModalVisible(false);
            setSelectedComment(null);
          }}
          commentId={selectedComment.id}
          commentAuthor={
            selectedComment.isAnonymous 
              ? "Anonymous" 
              : selectedComment.username || "User"
          }
          currentUser={user}
        />
      )}

      {/* Image Viewer Modal */}
      <Modal
        visible={imageViewerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setImageViewerVisible(false)}
      >
        <View style={styles.imageViewerContainer}>
          <TouchableOpacity
            style={styles.imageViewerClose}
            onPress={() => setImageViewerVisible(false)}
          >
            <Ionicons name="close" size={32} color="#fff" />
          </TouchableOpacity>
          
          <FlatList
            data={selectedImages}
            horizontal
            pagingEnabled
            initialScrollIndex={selectedImageIndex}
            getItemLayout={(data, index) => ({
              length: SCREEN_WIDTH,
              offset: SCREEN_WIDTH * index,
              index,
            })}
            onScrollToIndexFailed={() => {}}
            renderItem={({ item }) => (
              <View style={styles.imageViewerPage}>
                <Image
                  source={{ uri: item }}
                  style={styles.imageViewerImage}
                  resizeMode="contain"
                />
              </View>
            )}
            keyExtractor={(item, index) => index.toString()}
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

export default CommentModal;

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  modalContainer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: SCREEN_HEIGHT,
    backgroundColor: "#0f1624",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  composerContainer: {
    width: "100%",
  },
  dragIndicatorContainer: {
    alignItems: "center",
    paddingVertical: 6,
  },
  dragIndicator: {
    width: 40,
    height: 4,
    backgroundColor: "#8ea0d0",
    borderRadius: 2,
    opacity: 0.5,
  },
  modalContent: {
    flex: 1,
    backgroundColor: "#0f1624",
  },
  header: {
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 6,
    borderBottomColor: "#1f2937",
    borderBottomWidth: 1,
  },
  headerTitle: {
    color: "#e9edff",
    fontSize: 16,
    fontWeight: "700",
  },
  sortContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#1f2937",
  },
  sortButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 16,
    backgroundColor: "#1c2535",
    borderWidth: 1,
    borderColor: "#2a3548",
  },
  sortButtonActive: {
    backgroundColor: "#ff3b7f20",
    borderColor: "#ff3b7f",
  },
  sortText: {
    color: "#8ea0d0",
    fontSize: 12,
    fontWeight: "600",
  },
  sortTextActive: {
    color: "#ff3b7f",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 60,
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
  commentItem: {
    backgroundColor: "#1c2535",
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#243054",
  },
  commentTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 8,
    gap: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarText: {
    fontSize: 16,
    fontWeight: "700",
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  commentName: {
    fontWeight: "700",
    fontSize: 14,
  },
  roleChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  roleChipText: {
    fontSize: 10,
    fontWeight: "600",
  },
  eyeButton: {
    padding: 2,
  },
  commentRole: {
    color: "#8ea0d0",
    fontSize: 12,
    marginTop: 2,
  },
  commentText: {
    color: "#dbe1ff",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  seeMoreButton: {
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  seeMoreText: {
    color: "#ff3b7f",
    fontSize: 13,
    fontWeight: "600",
  },
  commentImageContainer: {
    position: "relative",
    marginTop: 10,
    marginHorizontal: -14,
    overflow: "hidden",
    borderRadius: 8,
  },
  commentImageFull: {
    width: "100%",
    backgroundColor: "#0e1320",
  },
  commentGifContainer: {
    marginTop: 10,
    marginHorizontal: -14,
    overflow: "hidden",
    borderRadius: 8,
  },
  commentGif: {
    width: "100%",
    height: 200,
    backgroundColor: "#0e1320",
  },
  imageCountBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  imageCountText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "bold",
  },
  commentDocsContainer: {
    marginTop: 8,
    gap: 6,
  },
  commentDocItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#243054",
    padding: 8,
    borderRadius: 6,
  },
  commentDocText: {
    flex: 1,
    color: "#4f9cff",
    fontSize: 12,
    fontWeight: "500",
  },
  commentLinkPreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#243054",
    padding: 10,
    borderRadius: 8,
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#2a3548",
  },
  commentLinkTitle: {
    color: "#e9edff",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 2,
  },
  commentLinkUrl: {
    color: "#8ea0d0",
    fontSize: 11,
  },
  commentTaggedContainer: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 8,
  },
  commentTaggedText: {
    color: "#a0a8c0",
    fontSize: 12,
  },
  commentTaggedName: {
    color: "#ff5c93",
    fontWeight: "600",
    fontSize: 12,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingTop: 8,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#243054",
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  actionText: {
    color: "#8ea0d0",
    fontSize: 13,
    fontWeight: "500",
  },
  // Image Viewer Styles
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
});
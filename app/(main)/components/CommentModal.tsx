// Updated CommentModal.tsx – matched PostCard color palette & tagged/see-more behavior
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
  Platform,
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

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

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

const CommentItem: React.FC<{
  item: Comment;
  user: any;
  onLike: (commentId: string) => void;
  onProfileClick: (comment: Comment) => void;
  onReply: (comment: Comment) => void;
  getTimeAgo: (timestamp: any) => string;
}> = ({ item, user, onLike, onProfileClick, onReply, getTimeAgo }) => {
  const [authorData, setAuthorData] = useState<any>(null);
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const MAX_CHARS = 300;
  const needsExpansion = item.text.length > MAX_CHARS;
  const displayText = expanded || !needsExpansion ? item.text : item.text.substring(0, MAX_CHARS) + "...";

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
    ((user?.role === "teacher" || user?.role === "moderator") && authorRole === "student");

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

  const imageFiles = (item.files || []).filter((f) => f.mimeType.startsWith("image/") && !f.mimeType.includes("gif"));
  const gifFiles = (item.files || []).filter((f) => f.mimeType.includes("gif"));
  const docFiles = (item.files || []).filter((f) => !f.mimeType.startsWith("image/"));

  const [imageHeight, setImageHeight] = useState(200);

  useEffect(() => {
    if (imageFiles.length > 0) {
      Image.getSize(imageFiles[0].url, (w, h) => {
        const ratio = h / w;
        setImageHeight(Math.min(SCREEN_WIDTH * ratio, 500));
      }, () => setImageHeight(200));
    }
  }, [imageFiles]);

  const getFileDisplayName = (file: { url: string; mimeType: string; name?: string }) => {
    if (file.name) return file.name;
    const parts = file.url.split("/");
    const last = parts[parts.length - 1];
    const name = decodeURIComponent(last.split("?")[0]);
    return name.length > 25 ? name.slice(0, 22) + "..." : name;
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
                <Image source={{ uri: item.profilePic }} style={styles.avatarImage} />
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
              <Text style={[styles.commentName, { color: isIdentityVisible ? roleColor : "#8ea0d0" }]}>
                {displayName}
              </Text>
            </TouchableOpacity>

            {isIdentityVisible && authorRole !== "student" && (
              <View style={[styles.roleChip, { backgroundColor: roleColor + "20", borderColor: roleColor }]}>
                <Text style={[styles.roleChipText, { color: roleColor }]}>{roleDisplayName}</Text>
              </View>
            )}

            {canShowEyeIcon && (
              <TouchableOpacity onPress={() => setRevealed(!revealed)} style={styles.eyeButton}>
                <Ionicons
                  name={revealed ? "eye-off-outline" : "eye-outline"}
                  size={14}
                  color={revealed ? "#ff5c93" : "#8ea0d0"}
                />
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.commentRole}>{getTimeAgo(item.createdAt)}</Text>
        </View>
      </View>

      <View style={styles.commentContentContainer}>
        <Text style={styles.commentText}>{displayText}</Text>
        {needsExpansion && (
          <TouchableOpacity onPress={() => setExpanded(!expanded)} style={styles.seeMoreButton}>
            <Text style={styles.seeMoreText}>{expanded ? "See less" : "See more"}</Text>
          </TouchableOpacity>
        )}
      </View>

      {gifFiles.length > 0 && (
        <View style={styles.commentGifContainer}>
          <Image source={{ uri: gifFiles[0].url }} style={styles.commentGif} resizeMode="cover" />
        </View>
      )}

      {imageFiles.length > 0 && (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => item.onImagePress?.(imageFiles.map(f => f.url), 0)}
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

      {docFiles.length > 0 && (
        <View style={styles.commentDocsContainer}>
          {docFiles.map((file, idx) => (
            <TouchableOpacity
              key={idx}
              style={styles.commentDocItem}
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
              <Ionicons name="download-outline" size={14} color="#8ea0d0" />
            </TouchableOpacity>
          ))}
        </View>
      )}

{item.link && (
  <TouchableOpacity
    style={styles.commentLinkPreview}
    onPress={() => item.onLinkPress?.(item.link?.url ?? '')}
  >
    <Ionicons name="link" size={16} color="#4f9cff" />
    <View style={{ flex: 1, marginLeft: 8 }}>
      <Text style={styles.commentLinkTitle} numberOfLines={1}>
        {item.link?.title ?? 'Link'}
      </Text>
      <Text style={styles.commentLinkUrl} numberOfLines={1}>
        {item.link?.url ?? ''}
      </Text>
    </View>
    <Ionicons name="open-outline" size={14} color="#a0a8c0" />
  </TouchableOpacity>
)}

      {item.taggedUsers && item.taggedUsers.length > 0 && (
        <TaggedUsersDisplay taggedUsers={item.taggedUsers} onTagClick={item.onTagClick} />
      )}

      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => onLike(item.id)}>
          <Ionicons
            name={liked ? "heart" : "heart-outline"}
            size={16}
            color={liked ? "#ff5c93" : "#8ea0d0"}
          />
          <Text style={styles.actionText}>{item.likes?.length || 0}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={() => onReply(item)}>
          <Ionicons name="chatbubble-outline" size={14} color="#8ea0d0" />
          <Text style={styles.actionText}>{item.replyCount || 0}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const TaggedUsersDisplay = ({
  taggedUsers,
  onTagClick,
}: {
  taggedUsers: { id: string; name: string; studentID: string }[];
  onTagClick?: (userId: string) => void;
}) => {
  const [expanded, setExpanded] = useState(false);

  const MAX_VISIBLE = 1;
  const visible = expanded ? taggedUsers : taggedUsers.slice(0, MAX_VISIBLE);
  const remaining = taggedUsers.length - MAX_VISIBLE;
  const hasMore = remaining > 0 && !expanded;

  return (
    <View style={styles.taggedBox}>
      <View style={styles.taggedContent}>
        <Ionicons name="people-outline" size={14} color="#ff5c93" />
        <Text style={styles.taggedLabel}>with </Text>

        {visible.map((tag, idx) => (
          <React.Fragment key={tag.id}>
            <TouchableOpacity onPress={() => onTagClick?.(tag.id)}>
              <Text style={styles.taggedName}>{tag.name}</Text>
            </TouchableOpacity>
            {(idx < visible.length - 1 || (hasMore && idx === visible.length - 1)) && (
              <Text style={styles.taggedSeparator}>, </Text>
            )}
          </React.Fragment>
        ))}

        {hasMore && (
          <TouchableOpacity onPress={() => setExpanded(true)} activeOpacity={0.7}>
            <Text style={styles.moreCount}>+{remaining} more</Text>
          </TouchableOpacity>
        )}

        {expanded && taggedUsers.length > MAX_VISIBLE && (
          <TouchableOpacity onPress={() => setExpanded(false)} style={{ marginLeft: 4 }}>
            <Text style={styles.showLessText}>Show less</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

const CommentModal: React.FC<CommentModalProps> = ({
  visible,
  onClose,
  postId,
}) => {
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
  const [isNavigating, setIsNavigating] = useState(false); // ← FIXED: missing state

  const flatListRef = useRef<FlatList>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    setInternalVisible(visible);
  }, [visible]);

  useEffect(() => {
    if (internalVisible) {
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(backdropOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();
    }
  }, [backdropOpacity, internalVisible, translateY]);

  const closeAndNavigate = useCallback((navigateFn?: () => void) => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: SCREEN_HEIGHT, duration: 300, useNativeDriver: true }),
      Animated.timing(backdropOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => {
      setInternalVisible(false);
      onClose();
      if (navigateFn) navigateFn();
    });
  }, [backdropOpacity, onClose, translateY]);

  const handleClose = useCallback(() => closeAndNavigate(), [closeAndNavigate]);

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
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isNavigating) {
        setIsNavigating(false);
        return false;
      }
      if (internalVisible && !replyModalVisible) {
        handleClose();
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [internalVisible, replyModalVisible, isNavigating, handleClose]);

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

  const handleProfileClick = useCallback((comment: Comment) => {
    const isCommentAnonymous = comment.isAnonymous ?? true;
    const userIdToNavigate = comment.realUserId || comment.userId;

    if (isCommentAnonymous || !userIdToNavigate || userIdToNavigate === "anonymous") {
      return;
    }

    try {
      setIsNavigating(true);
      closeAndNavigate(() => {
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

  if (!internalVisible) return null;

  return (
    <>
      <Modal visible={internalVisible} animationType="none" transparent onRequestClose={handleClose}>
        <View style={styles.modalOverlay}>
          <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
            <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={handleClose} />
          </Animated.View>

          <Animated.View
            style={[
              styles.modalContainer,
              { paddingTop: insets.top, transform: [{ translateY }] },
            ]}
          >
            <View {...panResponder.panHandlers}>
              <View style={styles.dragIndicatorContainer}>
                <View style={styles.dragIndicator} />
              </View>

              <View style={styles.header}>
                <Text style={styles.headerTitle}>Comments ({comments.length})</Text>
              </View>

              <View style={styles.sortContainer}>
                <TouchableOpacity
                  style={[styles.sortButton, sortBy === "latest" && styles.sortButtonActive]}
                  onPress={() => setSortBy("latest")}
                >
                  <Ionicons
                    name="time-outline"
                    size={14}
                    color={sortBy === "latest" ? "#ff5c93" : "#8ea0d0"}
                  />
                  <Text style={[styles.sortText, sortBy === "latest" && styles.sortTextActive]}>
                    Latest
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.sortButton, sortBy === "relevant" && styles.sortButtonActive]}
                  onPress={() => setSortBy("relevant")}
                >
                  <Ionicons
                    name="trending-up-outline"
                    size={14}
                    color={sortBy === "relevant" ? "#ff5c93" : "#8ea0d0"}
                  />
                  <Text style={[styles.sortText, sortBy === "relevant" && styles.sortTextActive]}>
                    Relevant
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.sortButton, sortBy === "all" && styles.sortButtonActive]}
                  onPress={() => setSortBy("all")}
                >
                  <Ionicons
                    name="list-outline"
                    size={14}
                    color={sortBy === "all" ? "#ff5c93" : "#8ea0d0"}
                  />
                  <Text style={[styles.sortText, sortBy === "all" && styles.sortTextActive]}>
                    All
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.modalContent}>
              {loading ? (
                <ActivityIndicator color="#ff5c93" style={{ marginTop: 40 }} />
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
                  contentContainerStyle={{ paddingBottom: 8, paddingHorizontal: 0 }}
                  showsVerticalScrollIndicator={false}
                />
              )}

              {user && (
                <View
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: "#243054",
                    backgroundColor: "#0e1320",
                    paddingHorizontal: 12,
                    paddingTop: 8,
                    paddingBottom: Platform.select({
                      ios: insets.bottom + 8,
                      android: 16,
                      default: insets.bottom + 8,
                    }),
                  }}
                >
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

      {selectedComment && (
        <ReplyThread
          visible={replyModalVisible}
          onClose={() => {
            setReplyModalVisible(false);
            setSelectedComment(null);
          }}
          commentId={selectedComment.id}
          commentAuthor={selectedComment.isAnonymous ? "Anonymous" : selectedComment.username || "User"}
          currentUser={user}
        />
      )}

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
            renderItem={({ item }) => (
              <View style={styles.imageViewerPage}>
                <Image source={{ uri: item }} style={styles.imageViewerImage} resizeMode="contain" />
              </View>
            )}
            keyExtractor={(_, i) => i.toString()}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => {
              const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
              setSelectedImageIndex(idx);
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

const styles = StyleSheet.create({
  modalOverlay: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.82)" },
  modalContainer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: SCREEN_HEIGHT,
    backgroundColor: "#070c15",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  dragIndicatorContainer: { alignItems: "center", paddingVertical: 8 },
  dragIndicator: { width: 40, height: 4, backgroundColor: "#8ea0d0", borderRadius: 2, opacity: 0.5 },
  modalContent: { flex: 1, backgroundColor: "#070c15" },

  header: {
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#243054",
  },
  headerTitle: { color: "#e9edff", fontSize: 17, fontWeight: "700" },

  sortContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#243054",
  },
  sortButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "#1b2235",
    borderWidth: 1,
    borderColor: "#243054",
  },
  sortButtonActive: {
    backgroundColor: "#ff5c9320",
    borderColor: "#ff5c93",
  },
  sortText: { color: "#8ea0d0", fontSize: 13, fontWeight: "600" },
  sortTextActive: { color: "#ff5c93" },

  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 80,
  },
  emptyText: { color: "#e9edff", fontSize: 17, fontWeight: "700", marginTop: 16 },
  emptySubText: { color: "#8ea0d0", fontSize: 14, marginTop: 6 },

  commentItem: {
    backgroundColor: "#1b2235",
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#243054",
  },
  commentTopRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 10, gap: 12 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: "#243054",
  },
  avatarImage: { width: "100%", height: "100%" },
  avatarText: { fontSize: 17, fontWeight: "700" },

  nameRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  commentName: { fontWeight: "700", fontSize: 15 },
  roleChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  roleChipText: { fontSize: 10, fontWeight: "700" },
  eyeButton: { padding: 4 },
  commentRole: { color: "#8ea0d0", fontSize: 12.5, marginTop: 3 },

  commentContentContainer: { marginTop: 4, marginBottom: 8 },
  commentText: { color: "#d8deff", fontSize: 15, lineHeight: 21 },
  seeMoreButton: { alignSelf: "flex-start", marginTop: 4 },
  seeMoreText: { color: "#ff5c93", fontSize: 14, fontWeight: "600" },

  commentGifContainer: { marginTop: 10, marginHorizontal: -14, overflow: "hidden", borderRadius: 12 },
  commentGif: { width: "100%", height: 220, backgroundColor: "#0e1320" },

  commentImageContainer: { position: "relative", marginTop: 10, marginHorizontal: -14, overflow: "hidden", borderRadius: 12 },
  commentImageFull: { width: "100%", backgroundColor: "#0e1320" },
  imageCountBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  imageCountText: { color: "#fff", fontSize: 12, fontWeight: "bold" },

  commentDocsContainer: { marginTop: 10, gap: 8 },
  commentDocItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1b2235",
    padding: 10,
    borderRadius: 10,
    gap: 10,
    borderWidth: 1,
    borderColor: "#243054",
  },
  commentDocText: { flex: 1, color: "#d8deff", fontSize: 13 },

  commentLinkPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1b2235",
    padding: 12,
    borderRadius: 12,
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#243054",
  },
  commentLinkTitle: { color: "#e9edff", fontSize: 14, fontWeight: "600", marginBottom: 2 },
  commentLinkUrl: { color: "#8ea0d0", fontSize: 12 },

  taggedBox: {
    backgroundColor: "#1b2235",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginVertical: 10,
    borderWidth: 1,
    borderColor: "#243054",
  },
  taggedContent: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 },
  taggedLabel: { color: "#8ea0d0", fontSize: 13 },
  taggedName: { color: "#ff8ab2", fontWeight: "600", fontSize: 13.5 },
  taggedSeparator: { color: "#8ea0d0", fontSize: 13 },
  moreCount: { color: "#8ea0d0", fontWeight: "600", fontSize: 13.5 },
  showLessText: { color: "#8ea0d0", fontSize: 13, fontStyle: "italic" },

  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    paddingTop: 10,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#243054",
  },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  actionText: { color: "#8ea0d0", fontSize: 13, fontWeight: "500" },

  imageViewerContainer: { flex: 1, backgroundColor: "#000", justifyContent: "center", alignItems: "center" },
  imageViewerClose: {
    position: "absolute",
    top: 50,
    right: 20,
    zIndex: 10,
    padding: 8,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 20,
  },
  imageViewerPage: { width: SCREEN_WIDTH, justifyContent: "center", alignItems: "center" },
  imageViewerImage: { width: "100%", height: "100%" },
  imageViewerCounter: {
    position: "absolute",
    bottom: 40,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  imageViewerCounterText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});

export default CommentModal;
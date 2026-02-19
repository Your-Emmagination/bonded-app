// components/PostCard.tsx

import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  getRoleColor,
  getRoleDisplayName,
  getUserData,
  UserData,
  UserRole,
} from "../../../utils/rbac";
import CommentModal from "./CommentModal";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const IMAGE_WIDTH = SCREEN_WIDTH - 68;
const AUTO_SCROLL_INTERVAL = 4000;

type TaggedUser = {
  id: string;
  name: string;
  studentID: string;
};

type FileAttachment = {
  url: string;
  mimeType: string;
  name?: string;
};

type Post = {
  id: string;
  content?: string;
  imageUrl?: string;
  files?: FileAttachment[];
  link?: { url: string; title: string };
  username?: string;
  userId?: string;
  realUserId?: string;
  isAnonymous?: boolean;
  taggedUsers?: TaggedUser[];
  createdAt?: any;
  likeCount?: number;
  commentCount?: number;
  viewCount?: number;
  likedBy?: string[];
  viewedBy?: string[];
  role?: string;
};

interface PostCardProps {
  post: Post;
  isLiked: boolean;
  currentUserRole?: UserRole;
  currentUserId?: string;
  onLike: (postId: string, likedBy: string[]) => void;
  onProfileClick: (userId?: string) => void;
  onTagClick: (taggedUserId: string) => void;
  onImagePress?: (images: string[], startIndex: number) => void;
  onFilePress: (url: string, mimeType: string) => void;
  getTimeAgo: (timestamp: any) => string;
  onCommentCountUpdate?: (postId: string, newCount: number) => void;
  onViewPost?: (postId: string) => void;
}

const PostCard: React.FC<PostCardProps> = ({
  post,
  isLiked,
  currentUserRole,
  currentUserId,
  onLike,
  onProfileClick,
  onTagClick,
  onImagePress,
  onFilePress,
  getTimeAgo,
  onCommentCountUpdate,
  onViewPost,
}) => {
  const [showCommentsModal, setShowCommentsModal] = useState(false);
  const [showLikesModal, setShowLikesModal] = useState(false);
  const [showFullContent, setShowFullContent] = useState(false);
  const [hasBeenViewed, setHasBeenViewed] = useState(false);

  const viewTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [, setCurrentImageIndex] = useState(0);
  const flatListRef = useRef<FlatList>(null);
  const autoScrollTimerRef = useRef<NodeJS.Timeout | null>(null);

  const imageFiles = (post.files || []).filter(
    (f) => f.mimeType.startsWith("image/") && !f.mimeType.includes("gif")
  );
  const gifFiles = (post.files || []).filter((f) => f.mimeType.includes("gif"));
  const nonImageFiles = (post.files || []).filter((f) => !f.mimeType.startsWith("image/"));

  if (post.imageUrl && !imageFiles.find((f) => f.url === post.imageUrl)) {
    imageFiles.unshift({ url: post.imageUrl, mimeType: "image/jpeg" });
  }

  useEffect(() => {
    if (imageFiles.length <= 1) return;

    const startAutoScroll = () => {
      autoScrollTimerRef.current = setInterval(() => {
        setCurrentImageIndex((prev) => {
          const next = (prev + 1) % imageFiles.length;
          flatListRef.current?.scrollToIndex({ index: next, animated: true });
          return next;
        });
      }, AUTO_SCROLL_INTERVAL);
    };

    startAutoScroll();

    return () => {
      if (autoScrollTimerRef.current) clearInterval(autoScrollTimerRef.current);
    };
  }, [imageFiles.length]);

  const handleMomentumScrollEnd = () => {
    if (imageFiles.length <= 1) return;
    if (autoScrollTimerRef.current) clearInterval(autoScrollTimerRef.current);

    autoScrollTimerRef.current = setInterval(() => {
      setCurrentImageIndex((prev) => {
        const next = (prev + 1) % imageFiles.length;
        flatListRef.current?.scrollToIndex({ index: next, animated: true });
        return next;
      });
    }, AUTO_SCROLL_INTERVAL);
  };

  useEffect(() => {
    if (!hasBeenViewed && onViewPost && currentUserId) {
      viewTimerRef.current = setTimeout(() => {
        onViewPost(post.id);
        setHasBeenViewed(true);
      }, 1000);
    }
    return () => {
      if (viewTimerRef.current) clearTimeout(viewTimerRef.current);
    };
  }, [hasBeenViewed, onViewPost, post.id, currentUserId]);

  const handleCommentAdded = () => {
    if (onCommentCountUpdate) {
      onCommentCountUpdate(post.id, (post.commentCount || 0) + 1);
    }
  };

  const formatViewCount = (count: number = 0) => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
  };

  const shouldShowToggle = post.content && post.content.length > 180;
  const taggedUsers = post.taggedUsers ?? [];

  return (
    <View style={styles.postCard}>
      <View style={styles.hangingLayout}>
        <View style={styles.avatarColumn}>
          <PostAvatar
            post={post}
            currentUserRole={currentUserRole}
            currentUserId={currentUserId}
            onProfileClick={onProfileClick}
          />
        </View>

        <View style={styles.contentColumn}>
          <PostHeader
            post={post}
            currentUserRole={currentUserRole}
            currentUserId={currentUserId}
            onProfileClick={onProfileClick}
            getTimeAgo={getTimeAgo}
          />

{post.content && (
            <View style={styles.postContentContainer}>
              <Text
                style={styles.postContent}
                numberOfLines={showFullContent ? undefined : 5}
                ellipsizeMode="tail"
              >
                {post.content}
              </Text>

              {shouldShowToggle && (
                <TouchableOpacity
                  style={styles.toggleContainer}
                  onPress={() => setShowFullContent(!showFullContent)}
                >
                  <Text style={styles.toggleText}>
                    {showFullContent ? "See less" : "See more"}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}

{taggedUsers.length > 0 && (
  <TaggedUsersDisplay
    taggedUsers={taggedUsers}
    onTagClick={onTagClick}
  />
)}
          {gifFiles.length > 0 && (
            <View style={styles.mediaContainer}>
              <Image source={{ uri: gifFiles[0].url }} style={styles.gif} resizeMode="cover" />
            </View>
          )}

          {imageFiles.length > 0 && (
            <View style={styles.carouselContainer}>
              <FlatList
                ref={flatListRef}
                data={imageFiles}
                horizontal
                showsHorizontalScrollIndicator={false}
                keyExtractor={(_, index) => index.toString()}
                renderItem={({ item, index }) => (
                  <TouchableOpacity
                    activeOpacity={0.95}
                    onPress={() => {
                      if (onImagePress) {
                        const urls = imageFiles.map((f) => f.url);
                        onImagePress(urls, index);
                      }
                    }}
                  >
                    <Image
                      source={{ uri: item.url }}
                      style={styles.carouselImage}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                )}
                onScroll={(e) => {
                  const idx = Math.round(e.nativeEvent.contentOffset.x / IMAGE_WIDTH);
                  setCurrentImageIndex(idx);
                }}
                onMomentumScrollEnd={handleMomentumScrollEnd}
                scrollEventThrottle={16}
                decelerationRate="fast"
                snapToInterval={IMAGE_WIDTH}
                snapToAlignment="start"
                disableIntervalMomentum
                overScrollMode="never"
                bounces={false}
                getItemLayout={(_, index) => ({
                  length: IMAGE_WIDTH,
                  offset: IMAGE_WIDTH * index,
                  index,
                })}
              />
            </View>
          )}

          {nonImageFiles.length > 0 && (
            <FilesList files={nonImageFiles} onFilePress={onFilePress} />
          )}
          {post.link && <LinkPreview link={post.link} />}

          <View style={styles.actions}>
            <TouchableOpacity style={styles.actionButton} onPress={() => onLike(post.id, post.likedBy || [])}>
              <Ionicons
                name={isLiked ? "heart" : "heart-outline"}
                size={20}
                color={isLiked ? "#ff5c93" : "#8ea0d0"}
              />
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionButton} onPress={() => setShowCommentsModal(true)}>
              <Ionicons name="chatbubble-outline" size={19} color="#8ea0d0" />
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionButton}>
              <MaterialIcons name="bookmark-outline" size={21} color="#8ea0d0" />
            </TouchableOpacity>
          </View>

          <View style={styles.statsRow}>
            {(post.likeCount ?? 0) > 0 && (
              <TouchableOpacity onPress={() => setShowLikesModal(true)}>
                <Text style={styles.statLink}>
                  {post.likeCount} {post.likeCount === 1 ? "like" : "likes"}
                </Text>
              </TouchableOpacity>
            )}

            {(post.commentCount ?? 0) > 0 && (
              <Text style={styles.statText}>
                {post.commentCount} {post.commentCount === 1 ? "comment" : "comments"}
              </Text>
            )}

            {(post.viewCount ?? 0) > 0 && (
              <Text style={styles.statText}>
                {formatViewCount(post.viewCount)} views
              </Text>
            )}
          </View>
        </View>
      </View>

      {/* Likes Modal */}
      <Modal
        visible={showLikesModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowLikesModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.likesModalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Liked by</Text>
              <TouchableOpacity onPress={() => setShowLikesModal(false)}>
                <Ionicons name="close-circle-outline" size={28} color="#ff5c93" />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.likesScroll}>
              {post.likedBy && post.likedBy.length > 0 ? (
                post.likedBy.map((likerId) => (
                  <LikeUserRow
                    key={likerId}
                    userId={likerId}
                    currentUserId={currentUserId}
                    onProfileClick={onProfileClick}
                  />
                ))
              ) : (
                <Text style={styles.noLikesText}>No one has liked this post yet.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {showCommentsModal && currentUserId && (
        <CommentModal
          visible={showCommentsModal}
          onClose={() => setShowCommentsModal(false)}
          postId={post.id}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          onCommentAdded={handleCommentAdded}
        />
      )}
    </View>
  );
};

// ────────────────────────────────────────────────
//   LikeUserRow – shows one person who liked the post
// ────────────────────────────────────────────────
const LikeUserRow = React.memo(
  ({
    userId,
    currentUserId,
    onProfileClick,
  }: {
    userId: string;
    currentUserId?: string;
    onProfileClick: (userId?: string) => void;
  }) => {
    const [user, setUser] = useState<UserData | null>(null);

    useEffect(() => {
      getUserData(userId)
        .then(setUser)
        .catch(() => setUser(null));
    }, [userId]);

    const displayName =
      user && user.firstname && user.lastname
        ? `${user.firstname} ${user.lastname}`
        : "Unknown User";

    const isYou = userId === currentUserId;

    return (
      <TouchableOpacity
        style={styles.likeRow}
        onPress={() => onProfileClick(isYou ? "self" : userId)}
      >
        <View style={styles.likeAvatar}>
          <Text style={styles.likeAvatarText}>
            {(user?.firstname?.[0] || "U").toUpperCase()}
          </Text>
        </View>
        <Text style={styles.likeName}>
          {displayName}
          {isYou && <Text style={styles.youBadge}> • you</Text>}
        </Text>
      </TouchableOpacity>
    );
  }
);

const TaggedUsersDisplay = ({
  taggedUsers,
  onTagClick,
}: {
  taggedUsers: TaggedUser[];
  onTagClick: (taggedUserId: string) => void;
}) => {
  const [expanded, setExpanded] = useState(false);

  const MAX_VISIBLE = 1; 
  const visibleUsers = expanded ? taggedUsers : taggedUsers.slice(0, MAX_VISIBLE);
  const remainingCount = taggedUsers.length - MAX_VISIBLE;

  const hasMore = remainingCount > 0 && !expanded;

  return (
    <View style={styles.taggedBox}>
      <View style={styles.taggedContent}>
        <Ionicons name="people-outline" size={14} color="#ff8ab2" />
        <Text style={styles.taggedLabel}> Tagged: </Text>

        {visibleUsers.map((tag, index) => (
          <React.Fragment key={tag.id}>
            <TouchableOpacity onPress={() => onTagClick(tag.id)}>
              <Text style={styles.taggedName}>{tag.name}</Text>
            </TouchableOpacity>
            {(index < visibleUsers.length - 1 || (hasMore && index === visibleUsers.length - 1)) && (
              <Text style={styles.taggedSeparator}>, </Text>
            )}
          </React.Fragment>
        ))}

        {hasMore && (
          <TouchableOpacity
            onPress={() => setExpanded(true)}
            activeOpacity={0.7}
          >
            <Text style={styles.moreCount}>
              +{remainingCount} more
            </Text>
          </TouchableOpacity>
        )}

        {expanded && taggedUsers.length > MAX_VISIBLE && (
          <TouchableOpacity
            onPress={() => setExpanded(false)}
            style={{ marginLeft: 4 }}
          >
            <Text style={styles.showLessText}>Show less</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};
/* ==================== POST AVATAR ==================== */
const PostAvatar: React.FC<{
  post: Post;
  currentUserRole?: UserRole;
  currentUserId?: string;
  onProfileClick: (userId?: string) => void;
}> = ({ post, currentUserRole, currentUserId, onProfileClick }) => {
  const [authorData, setAuthorData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAuthor = async () => {
      const userIdToFetch = post.realUserId || post.userId;
      if (userIdToFetch && userIdToFetch !== "anonymous") {
        try {
          const data = await getUserData(userIdToFetch);
          setAuthorData(data);
        } catch (err) {
          setAuthorData(null);
        }
      }
      setLoading(false);
    };
    fetchAuthor();
  }, [post.realUserId, post.userId]);

  const getSafeRole = (role: string | undefined): UserRole => {
    const validRoles: UserRole[] = ["student", "moderator", "teacher", "admin"];
    return validRoles.includes(role as UserRole) ? (role as UserRole) : "student";
  };

  const authorRole: UserRole = authorData?.role || getSafeRole(post.role) || "student";
  const roleColor = getRoleColor(authorRole);
  const isIdentityVisible = !post.isAnonymous;

  const canClickProfile = isIdentityVisible && !!authorData?.userId && authorData.userId !== "anonymous";

  const handleProfileClick = () => {
    if (!canClickProfile) return;
    if (authorData?.userId === currentUserId) {
      onProfileClick("self");
    } else {
      onProfileClick(authorData.userId);
    }
  };

  return (
    <TouchableOpacity onPress={handleProfileClick} disabled={!canClickProfile}>
      <View style={styles.avatar}>
        {loading ? (
          <ActivityIndicator size="small" color="#8ea0d0" />
        ) : isIdentityVisible ? (
          <Text style={[styles.avatarText, { color: roleColor }]}>
            {(authorData?.firstname?.[0] || post.username?.[0] || "A").toUpperCase()}
          </Text>
        ) : (
          <Ionicons name="person" size={18} color="#8ea0d0" />
        )}
      </View>
    </TouchableOpacity>
  );
};

/* ==================== POST HEADER ==================== */
const PostHeader: React.FC<{
  post: Post;
  currentUserRole?: UserRole;
  currentUserId?: string;
  onProfileClick: (userId?: string) => void;
  getTimeAgo: (timestamp: any) => string;
}> = ({ post, currentUserRole, currentUserId, onProfileClick, getTimeAgo }) => {
  const [authorData, setAuthorData] = useState<UserData | null>(null);
  const [, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const fetchAuthor = async () => {
      const userIdToFetch = post.realUserId || post.userId;
      if (userIdToFetch && userIdToFetch !== "anonymous") {
        try {
          const data = await getUserData(userIdToFetch);
          setAuthorData(data);
        } catch (err) {
          setAuthorData(null);
        }
      }
      setLoading(false);
    };
    fetchAuthor();
  }, [post.realUserId, post.userId]);

  const getSafeRole = (role: string | undefined): UserRole => {
    const validRoles: UserRole[] = ["student", "moderator", "teacher", "admin"];
    return validRoles.includes(role as UserRole) ? (role as UserRole) : "student";
  };

  const authorRole: UserRole = authorData?.role || getSafeRole(post.role) || "student";
  const roleColor = getRoleColor(authorRole);

  const canSeeIdentity =
    currentUserRole === "admin" ||
    ((currentUserRole === "teacher" || currentUserRole === "moderator") && authorRole === "student");

  const canShowEyeIcon = (post.isAnonymous ?? true) && canSeeIdentity;
  const isIdentityVisible = !post.isAnonymous || (revealed && canSeeIdentity);

  const displayName = isIdentityVisible
    ? authorData
      ? `${authorData.firstname} ${authorData.lastname}`
      : post.username || "User"
    : "Anonymous";

  const canClickProfile = isIdentityVisible && !!authorData?.userId && authorData.userId !== "anonymous";

  const handleProfileClick = () => {
    if (!canClickProfile) return;
    if (authorData?.userId === currentUserId) {
      onProfileClick("self");
    } else {
      onProfileClick(authorData.userId);
    }
  };

  return (
    <View style={styles.header}>
      <View style={styles.usernameRow}>
        <TouchableOpacity onPress={handleProfileClick} disabled={!canClickProfile}>
          <Text style={styles.username}>{displayName}</Text>
        </TouchableOpacity>

        {isIdentityVisible && authorRole !== "student" && (
          <View style={[styles.roleChip, { backgroundColor: roleColor + "20", borderColor: roleColor }]}>
            <Text style={[styles.roleChipText, { color: roleColor }]}>
              {getRoleDisplayName(authorRole)}
            </Text>
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

      <Text style={styles.timestamp}>
        {getTimeAgo(post.createdAt)}
      </Text>
    </View>
  );
};

/* ==================== TAGGED SECTION ==================== */
const TaggedSection: React.FC<{ taggedUsers: TaggedUser[]; onTagClick: (id: string) => void }> = ({
  taggedUsers,
  onTagClick,
}) => (
  <View style={styles.taggedSection}>
    <Ionicons name="people-outline" size={12} color="#ff5c93" />
    <Text style={styles.taggedText}>with </Text>
    {taggedUsers.map((tag, idx) => (
      <React.Fragment key={tag.id}>
        <TouchableOpacity onPress={() => onTagClick(tag.id)}>
          <Text style={styles.taggedName}>{tag.name}</Text>
        </TouchableOpacity>
        {idx < taggedUsers.length - 1 && <Text style={styles.taggedText}>, </Text>}
      </React.Fragment>
    ))}
  </View>
);

/* ==================== FILES LIST ==================== */
const FilesList: React.FC<{ files: FileAttachment[]; onFilePress: (url: string, mimeType: string) => void }> = ({
  files,
  onFilePress,
}) => {
  const getFileNameFromUrl = (url: string) => {
    try {
      const parts = url.split("/");
      const last = parts[parts.length - 1];
      const name = decodeURIComponent(last.split("?")[0]);
      return name.length > 25 ? name.slice(0, 22) + "..." : name;
    } catch {
      return "File";
    }
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.includes("pdf")) return "document-text";
    if (mimeType.includes("word") || mimeType.includes("document")) return "document";
    return "document-attach";
  };

  return (
    <View style={styles.filesContainer}>
      {files.map((file, idx) => (
        <TouchableOpacity
          key={idx}
          style={styles.fileCard}
          onPress={() => onFilePress(file.url, file.mimeType)}
          activeOpacity={0.7}
        >
          <Ionicons name={getFileIcon(file.mimeType)} size={18} color="#4f9cff" />
          <Text style={styles.fileName} numberOfLines={1}>
            {file.name || getFileNameFromUrl(file.url)}
          </Text>
          <Ionicons name="download-outline" size={14} color="#8ea0d0" />
        </TouchableOpacity>
      ))}
    </View>
  );
};

/* ==================== LINK PREVIEW ==================== */
const LinkPreview: React.FC<{ link: { url: string; title: string } }> = ({ link }) => (
  <TouchableOpacity
    style={styles.linkPreview}
    onPress={() => Linking.openURL(link.url).catch(() => Alert.alert("Error", "Cannot open link"))}
    activeOpacity={0.7}
  >
    <Ionicons name="link" size={14} color="#4f9cff" />
    <View style={{ flex: 1, marginLeft: 6 }}>
      <Text style={styles.linkTitle} numberOfLines={1}>{link.title}</Text>
      <Text style={styles.linkUrl} numberOfLines={1}>{link.url}</Text>
    </View>
    <Ionicons name="open-outline" size={13} color="#8ea0d0" />
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  postCard: {
    backgroundColor: "#070c15",
    marginBottom: 1,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#0e1320",
  },
  hangingLayout: { flexDirection: "row" },
  avatarColumn: { width: 40, marginRight: 12 },
  contentColumn: { flex: 1 },

  postContentContainer: { marginTop: 4, marginBottom: 8 },
  postContent: { color: "#d8deff", fontSize: 15, lineHeight: 21 },
  toggleContainer: { alignSelf: "flex-start", marginTop: 4 },
  toggleText: { color: "#ff5c93", fontSize: 14, fontWeight: "600" },

taggedBox: {
  backgroundColor: "#1b2235",
  borderRadius: 12,
  paddingVertical: 8,
  paddingHorizontal: 12,
  marginVertical: 8,
  borderWidth: 1,
  borderColor: "#243054",
},
taggedContent: {
  flexDirection: "row",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 4,
},
taggedLabel: {
  color: "#8ea0d0",
  fontSize: 13,
},
taggedName: {
  color: "#ff8ab2",
  fontWeight: "600",
  fontSize: 13.5,
},
taggedSeparator: {
  color: "#8ea0d0",
  fontSize: 13,
},
moreCount: {
  color: "#8ea0d0",
  fontWeight: "600",
  fontSize: 13.5,
},
showLessText: {
  color: "#8ea0d0",
  fontSize: 13,
  fontStyle: "italic",
},

  actions: {
    flexDirection: "row",
    gap: 28,
    marginTop: 12,
    marginBottom: 6,
  },
  actionButton: { padding: 4 },

  statsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
    marginTop: 4,
  },
  statText: { color: "#8ea0d0", fontSize: 13, fontWeight: "500" },
  statLink: { color: "#ff8ab2", fontSize: 13, fontWeight: "600" },

  // Likes modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.82)",
    justifyContent: "center",
    alignItems: "center",
  },
  likesModalContainer: {
    width: "86%",
    maxHeight: "68%",
    backgroundColor: "#0e1320",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#243054",
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#243054",
  },
  modalTitle: { color: "#e9edff", fontSize: 17, fontWeight: "700" },
  likesScroll: { paddingHorizontal: 12, paddingVertical: 8 },
  likeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    gap: 12,
  },
  likeAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
  },
  likeAvatarText: { color: "#ff5c93", fontSize: 16, fontWeight: "bold" },
  likeName: { color: "#e9edff", fontSize: 15 },
  youBadge: { color: "#8ea0d0", fontSize: 13, fontStyle: "italic" },
  noLikesText: {
    color: "#8ea0d0",
    fontSize: 15,
    textAlign: "center",
    paddingVertical: 40,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#1b2235",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#243054",
  },
  avatarText: {
    fontSize: 17,
    fontWeight: "700",
  },
  

  // Header with name + date below
  header: {
    marginBottom: 8,
  },
  usernameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  username: {
    color: "#e9edff",
    fontSize: 15,
    fontWeight: "700",
  },
  roleChip: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
  },
  roleChipText: {
    fontSize: 10,
    fontWeight: "700",
  },
  eyeButton: {
    padding: 3,
  },
  timestamp: {
    color: "#8ea0d0",
    fontSize: 12.5,
    marginTop: 3,
    letterSpacing: -0.1,
  },

  // Content + See more
  seeMoreButton: {
    marginTop: 4,
    alignSelf: "flex-start",
  },
  seeMoreText: {
    color: "#ff5c93",
    fontSize: 14,
    fontWeight: "600",
  },

  taggedSection: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 4,
    marginBottom: 10,
  },
  taggedText: {
    color: "#8ea0d0",
    fontSize: 13,
  },
  carouselContainer: {
    marginVertical: 10,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#0e1320",
  },
  carouselImage: {
    width: IMAGE_WIDTH,
    height: IMAGE_WIDTH * 1.25,
    backgroundColor: "#0e1320",
  },

  mediaContainer: {
    marginVertical: 10,
  },
  gif: {
    width: IMAGE_WIDTH,
    height: 220,
    borderRadius: 12,
    backgroundColor: "#0e1320",
  },

  filesContainer: {
    gap: 6,
    marginVertical: 10,
  },
  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1b2235",
    padding: 10,
    borderRadius: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: "#243054",
  },
  fileName: {
    flex: 1,
    color: "#d8deff",
    fontSize: 13,
  },

  linkPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1b2235",
    borderRadius: 10,
    padding: 10,
    marginVertical: 10,
    borderWidth: 1,
    borderColor: "#243054",
  },
  linkTitle: {
    color: "#e9edff",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 2,
  },
  linkUrl: {
    color: "#8ea0d0",
    fontSize: 12,
  },
});

export default PostCard;
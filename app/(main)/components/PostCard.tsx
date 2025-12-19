// components/PostCard.tsx - FINAL READY-TO-PASTE VERSION
// Full image per slide, no border radius, sharp corners like X/Twitter

import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  Alert,
  Linking,
  ActivityIndicator,
  Modal,
  FlatList,
  Dimensions,
} from "react-native";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import {
  getRoleColor,
  getRoleDisplayName,
  getUserData,
  UserData,
  UserRole,
} from "../../../utils/rbac";
import CommentModal from "./CommentModal";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

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
  likedBy?: string[];
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
  onImagePress: (images: string[], startIndex: number) => void;
  onFilePress: (url: string, mimeType: string) => void;
  getTimeAgo: (timestamp: any) => string;
  onCommentCountUpdate?: (postId: string, newCount: number) => void;
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
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showLikesModal, setShowLikesModal] = useState(false);
  const [showCommentsModal, setShowCommentsModal] = useState(false);

  const imageFiles = (post.files || []).filter(
    (f) => f.mimeType.startsWith("image/") && !f.mimeType.includes("gif")
  );
  const gifFiles = (post.files || []).filter((f) => f.mimeType.includes("gif"));
  const nonImageFiles = (post.files || []).filter((f) => !f.mimeType.startsWith("image/"));

  if (post.imageUrl && !imageFiles.find((f) => f.url === post.imageUrl)) {
    imageFiles.unshift({ url: post.imageUrl, mimeType: "image/jpeg" });
  }

  const handleCommentAdded = () => {
    if (onCommentCountUpdate) {
      onCommentCountUpdate(post.id, (post.commentCount || 0) + 1);
    }
  };

  return (
    <View style={styles.postCard}>
      <PostHeader
        post={post}
        onProfileClick={onProfileClick}
        getTimeAgo={getTimeAgo}
        currentUserRole={currentUserRole}
        currentUserId={currentUserId}
      />

      {post.content && (
        <View style={styles.contentContainer}>
          <Text style={styles.postContent} numberOfLines={isExpanded ? undefined : 4}>
            {post.content}
          </Text>
          {post.content.length > 150 && (
            <TouchableOpacity onPress={() => setIsExpanded(!isExpanded)} style={styles.seeMoreButton}>
              <Text style={styles.seeMoreText}>
                {isExpanded ? "See less" : "See more"}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {post.link && <LinkPreview link={post.link} />}

      {post.taggedUsers && post.taggedUsers.length > 0 && (
        <TaggedSection taggedUsers={post.taggedUsers} onTagClick={onTagClick} />
      )}

      {gifFiles.length > 0 && (
        <View style={styles.gifContainer}>
          <Image source={{ uri: gifFiles[0].url }} style={styles.postGif} resizeMode="cover" />
        </View>
      )}

      {imageFiles.length > 0 && (
        <ImageGallery
          images={imageFiles}
          onPress={() => onImagePress(imageFiles.map((f) => f.url), 0)}
        />
      )}

      {nonImageFiles.length > 0 && (
        <FilesList files={nonImageFiles} onFilePress={onFilePress} />
      )}

      <PostActions
        post={post}
        isLiked={isLiked}
        onLike={() => onLike(post.id, post.likedBy || [])}
        onLongPressLike={() => setShowLikesModal(true)}
        onComment={() => setShowCommentsModal(true)}
      />

      <LikesModal
        visible={showLikesModal}
        onClose={() => setShowLikesModal(false)}
        likedBy={post.likedBy || []}
        onProfileClick={onProfileClick}
        currentUserId={currentUserId}
      />

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

/* ==================== IMAGE CAROUSEL - FULL WIDTH, ONE IMAGE PER SLIDE, NO BORDER RADIUS ==================== */
const ImageGallery: React.FC<{ images: FileAttachment[]; onPress: () => void }> = ({
  images,
  onPress,
}) => {
  const [imageHeight, setImageHeight] = useState(400);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (images.length > 0) {
      Image.getSize(
        images[0].url,
        (width, height) => {
          const aspectRatio = height / width;
          const calculatedHeight = aspectRatio * SCREEN_WIDTH;
          setImageHeight(Math.min(calculatedHeight, 600));
        },
        () => setImageHeight(400)
      );
    }
  }, [images]);

  if (images.length === 0) return null;

  return (
    <View style={styles.carouselContainer}>
      <FlatList
        data={images}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, index) => index.toString()}
        onMomentumScrollEnd={(e) => {
          const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
          setCurrentIndex(index);
        }}
        renderItem={({ item }) => (
          <TouchableOpacity activeOpacity={0.95} onPress={onPress}>
            <Image
              source={{ uri: item.url }}
              style={[styles.carouselImage, { height: imageHeight }]}
              resizeMode="cover"
            />
          </TouchableOpacity>
        )}
      />

      {/* +N badge on first image only */}
      {images.length > 1 && currentIndex === 0 && (
        <View style={styles.imageCountBadge}>
          <Ionicons name="images" size={20} color="#fff" />
          <Text style={styles.imageCountText}>+{images.length - 1}</Text>
        </View>
      )}

      {/* Dots indicator */}
      {images.length > 1 && (
        <View style={styles.dotsContainer}>
          {images.map((_, index) => (
            <View
              key={index}
              style={[styles.dot, index === currentIndex && styles.activeDot]}
            />
          ))}
        </View>
      )}
    </View>
  );
};

/* ==================== ALL OTHER COMPONENTS ==================== */

const PostHeader: React.FC<{
  post: Post;
  onProfileClick: (userId?: string) => void;
  getTimeAgo: (timestamp: any) => string;
  currentUserRole?: UserRole;
  currentUserId?: string;
}> = ({ post, onProfileClick, getTimeAgo, currentUserRole, currentUserId }) => {
  const [authorData, setAuthorData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
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
    <View style={styles.postHeader}>
      <TouchableOpacity style={styles.userInfo} onPress={handleProfileClick} disabled={!canClickProfile}>
        <View
          style={[
            styles.avatar,
            isIdentityVisible && authorRole !== "student" && { borderColor: roleColor, borderWidth: 2 },
          ]}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#8ea0d0" />
          ) : isIdentityVisible ? (
            <Text style={[styles.avatarText, { color: roleColor }]}>
              {(authorData?.firstname?.[0] || displayName[0] || "A").toUpperCase()}
            </Text>
          ) : (
            <Ionicons name="person" size={20} color="#8ea0d0" />
          )}
        </View>

        <View style={styles.headerTextContainer}>
          <View style={styles.nameRow}>
            <Text style={styles.username}>{displayName}</Text>
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
                  size={16}
                  color={revealed ? "#ff5c93" : "#8ea0d0"}
                />
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.timestamp}>{getTimeAgo(post.createdAt)}</Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity>
        <Ionicons name="ellipsis-vertical" size={20} color="#a0a8c0" />
      </TouchableOpacity>
    </View>
  );
};

const LinkPreview: React.FC<{ link: { url: string; title: string } }> = ({ link }) => (
  <TouchableOpacity
    style={styles.linkPreviewCard}
    onPress={() => Linking.openURL(link.url).catch(() => Alert.alert("Error", "Cannot open link"))}
    activeOpacity={0.7}
  >
    <View style={styles.linkPreviewContent}>
      <Ionicons name="link" size={20} color="#4f9cff" />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={styles.linkPreviewTitle} numberOfLines={1}>{link.title}</Text>
        <Text style={styles.linkPreviewUrl} numberOfLines={1}>{link.url}</Text>
      </View>
      <Ionicons name="open-outline" size={18} color="#a0a8c0" />
    </View>
  </TouchableOpacity>
);

const TaggedSection: React.FC<{ taggedUsers: TaggedUser[]; onTagClick: (id: string) => void }> = ({
  taggedUsers,
  onTagClick,
}) => (
  <View style={styles.taggedSection}>
    <Ionicons name="people-outline" size={14} color="#ff5c93" />
    <Text style={styles.taggedText}>with </Text>
    <View style={styles.taggedNamesContainer}>
      {taggedUsers.map((tag, idx) => (
        <React.Fragment key={tag.id}>
          <TouchableOpacity onPress={() => onTagClick(tag.id)}>
            <Text style={styles.taggedName}>{tag.name}</Text>
          </TouchableOpacity>
          {idx < taggedUsers.length - 1 && <Text style={styles.taggedText}>, </Text>}
        </React.Fragment>
      ))}
    </View>
  </View>
);

const FilesList: React.FC<{ files: FileAttachment[]; onFilePress: (url: string, mimeType: string) => void }> = ({
  files,
  onFilePress,
}) => {
  const getFileNameFromUrl = (url: string) => {
    try {
      const parts = url.split("/");
      const last = parts[parts.length - 1];
      const name = decodeURIComponent(last.split("?")[0]);
      return name.length > 40 ? name.slice(0, 37) + "..." : name;
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
          <Ionicons name={getFileIcon(file.mimeType)} size={24} color="#4f9cff" />
          <Text style={styles.fileName} numberOfLines={1}>
            {file.name || getFileNameFromUrl(file.url)}
          </Text>
          <Ionicons name="download-outline" size={18} color="#a0a8c0" />
        </TouchableOpacity>
      ))}
    </View>
  );
};

const PostActions: React.FC<{
  post: Post;
  isLiked: boolean;
  onLike: () => void;
  onLongPressLike: () => void;
  onComment: () => void;
}> = ({ post, isLiked, onLike, onLongPressLike, onComment }) => (
  <View style={styles.postActions}>
    <TouchableOpacity
      style={styles.actionButton}
      onPress={onLike}
      onLongPress={onLongPressLike}
      delayLongPress={500}
    >
      <Ionicons
        name={isLiked ? "heart" : "heart-outline"}
        size={20}
        color={isLiked ? "#ff5c93" : "#a0a8c0"}
      />
      {(post.likeCount || 0) > 0 && <Text style={styles.actionText}>{post.likeCount}</Text>}
    </TouchableOpacity>

    <TouchableOpacity style={styles.actionButton} onPress={onComment}>
      <Ionicons name="chatbubble-outline" size={20} color="#a0a8c0" />
      {(post.commentCount || 0) > 0 && <Text style={styles.actionText}>{post.commentCount}</Text>}
    </TouchableOpacity>

    <TouchableOpacity style={styles.actionButton}>
      <Ionicons name="share-outline" size={20} color="#a0a8c0" />
    </TouchableOpacity>

    <TouchableOpacity style={styles.actionButton}>
      <MaterialIcons name="bookmark-outline" size={20} color="#a0a8c0" />
    </TouchableOpacity>
  </View>
);

const LikesModal: React.FC<{
  visible: boolean;
  onClose: () => void;
  likedBy: string[];
  onProfileClick: (userId: string) => void;
  currentUserId?: string;
}> = ({ visible, onClose, likedBy, onProfileClick, currentUserId }) => {
  const [usersData, setUsersData] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchUsersData = useCallback(async () => {
    setLoading(true);
    try {
      const users = await Promise.all(
        likedBy.map(async (userId) => {
          try {
            return await getUserData(userId);
          } catch {
            return null;
          }
        })
      );
      setUsersData(users.filter((u): u is UserData => u !== null));
    } catch {
      console.error("Error fetching users");
    } finally {
      setLoading(false);
    }
  }, [likedBy]);

  useEffect(() => {
    if (visible && likedBy.length > 0) {
      fetchUsersData();
    }
  }, [visible, likedBy, fetchUsersData]);

  const handleProfileClick = (userId: string) => {
    onClose();
    if (userId === currentUserId) {
      onProfileClick("self");
    } else {
      onProfileClick(userId);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.modalContent} onStartShouldSetResponder={() => true}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Reactions ({likedBy.length})</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color="#e9edff" />
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator size="large" color="#ff5c93" style={{ padding: 40 }} />
          ) : usersData.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="heart-outline" size={48} color="#8ea0d0" />
              <Text style={styles.emptyText}>No reactions yet</Text>
            </View>
          ) : (
            <FlatList
              data={usersData}
              keyExtractor={(item) => item.userId}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.userReactionItem}
                  onPress={() => handleProfileClick(item.userId)}
                  activeOpacity={0.7}
                >
                  <View
                    style={[
                      styles.userAvatar,
                      item.role !== "student" && { borderColor: getRoleColor(item.role), borderWidth: 2 },
                    ]}
                  >
                    <Text style={[styles.userAvatarText, { color: getRoleColor(item.role) }]}>
                      {item.firstname[0].toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.userReactionInfo}>
                    <Text style={styles.userFullName}>{item.firstname} {item.lastname}</Text>
                    {item.role !== "student" && (
                      <View
                        style={[
                          styles.userRoleChip,
                          { backgroundColor: getRoleColor(item.role) + "20", borderColor: getRoleColor(item.role) },
                        ]}
                      >
                        <Text style={[styles.userRoleText, { color: getRoleColor(item.role) }]}>
                          {getRoleDisplayName(item.role)}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Ionicons name="heart" size={20} color="#ff5c93" />
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </TouchableOpacity>
    </Modal>
  );
};

/* ==================== STYLES ==================== */
const styles = StyleSheet.create({
  postCard: {
    backgroundColor: "#1b2235",
    marginBottom: 8,
    paddingVertical: 16,
  },
  postHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  userInfo: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    fontSize: 18,
    fontWeight: "bold",
  },
  headerTextContainer: {
    flex: 1,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  username: {
    color: "#e9edff",
    fontSize: 14,
    fontWeight: "600",
  },
  roleChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  roleChipText: {
    fontSize: 11,
    fontWeight: "600",
  },
  eyeButton: {
    padding: 2,
  },
  timestamp: {
    color: "#8ea0d0",
    fontSize: 12,
    marginTop: 2,
  },
  contentContainer: {
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  postContent: {
    color: "#dbe1ff",
    fontSize: 15,
    lineHeight: 22,
  },
  seeMoreButton: {
    marginTop: 6,
    alignSelf: "flex-start",
  },
  seeMoreText: {
    color: "#4f9cff",
    fontSize: 13,
    fontWeight: "600",
  },
  taggedSection: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
    marginBottom: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "#243054",
    borderRadius: 8,
    alignSelf: "flex-start",
    marginHorizontal: 16,
  },
  taggedNamesContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
  },
  taggedText: {
    color: "#a0a8c0",
    fontSize: 13,
  },
  taggedName: {
    color: "#ff5c93",
    fontWeight: "600",
    fontSize: 13,
  },
  linkPreviewCard: {
    backgroundColor: "#243054",
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: "#2a3548",
  },
  linkPreviewContent: {
    flexDirection: "row",
    alignItems: "center",
  },
  linkPreviewTitle: {
    color: "#e9edff",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 2,
  },
  linkPreviewUrl: {
    color: "#8ea0d0",
    fontSize: 12,
  },
  gifContainer: {
    marginBottom: 12,
    overflow: "hidden",
    marginHorizontal: 16,
  },
  postGif: {
    width: "100%",
    height: 250,
    backgroundColor: "#0e1320",
  },
  carouselContainer: {
    marginBottom: 12,
    position: "relative",
  },
  carouselImage: {
    width: SCREEN_WIDTH,
    backgroundColor: "#0e1320",
    // No borderRadius → sharp corners
  },
  imageCountBadge: {
    position: "absolute",
    top: 16,
    right: 16,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  imageCountText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "bold",
  },
  dotsContainer: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 12,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#8ea0d0",
    marginHorizontal: 5,
    opacity: 0.6,
  },
  activeDot: {
    backgroundColor: "#ff5c93",
    opacity: 1,
  },
  filesContainer: {
    gap: 8,
    marginBottom: 12,
    paddingHorizontal: 16,
  },
  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#243054",
    padding: 12,
    borderRadius: 10,
    gap: 10,
    borderWidth: 1,
    borderColor: "#2a3548",
  },
  fileName: {
    flex: 1,
    color: "#dbe1ff",
    fontSize: 14,
  },
  postActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: "#243054",
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 4,
  },
  actionText: {
    color: "#dbe1ff",
    fontSize: 13,
    fontWeight: "500",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalContent: {
    backgroundColor: "#1b2235",
    borderRadius: 16,
    width: "85%",
    maxHeight: "70%",
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#243054",
  },
  modalTitle: {
    color: "#e9edff",
    fontSize: 18,
    fontWeight: "600",
  },
  emptyContainer: {
    padding: 40,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyText: {
    color: "#8ea0d0",
    fontSize: 14,
    marginTop: 12,
  },
  userReactionItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#243054",
  },
  userAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
  },
  userAvatarText: {
    fontSize: 18,
    fontWeight: "bold",
  },
  userReactionInfo: {
    flex: 1,
  },
  userFullName: {
    color: "#e9edff",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 4,
  },
  userRoleChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  userRoleText: {
    fontSize: 10,
    fontWeight: "600",
  },
});

export default PostCard;
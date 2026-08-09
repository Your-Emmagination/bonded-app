// components/PostCard.tsx

import { resolveAvatarUri } from "@/utils/avatar";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import {
  canDeleteContent,
  canViewAnonymousIdentity,
  getRoleColor,
  getRoleDisplayName,
  getUserData,
  parseUserRole,
  UserData,
  UserRole,
} from "@/utils/rbac";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Linking,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import AiReplyCard from "./AiReplyCard";
import CommentModal from "./CommentModal";
import ExpandableText from "./ExpandableText";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const AVATAR_COLUMN_WIDTH = 40;
const AVATAR_COLUMN_GAP = 12;
const FEED_HORIZONTAL_PADDING = 16;
const IMAGE_WIDTH =
  SCREEN_WIDTH - FEED_HORIZONTAL_PADDING * 2 - AVATAR_COLUMN_WIDTH - AVATAR_COLUMN_GAP;

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
  aiReply?: {
    text?: string;
    model?: string | null;
    generatedAtMs?: number;
    status?: string | null;
  };
  pinnedAt?: any;
};

interface PostCardProps {
  post: Post;
  isLiked: boolean;
  isHighlighted?: boolean;
  currentUserRole?: UserRole;
  currentUserId?: string;
  onLike: (postId: string, likedBy: string[]) => void;
  onProfileClick: (userId?: string) => void;
  onTagClick: (taggedUserId: string) => void;
  onImagePress?: (images: string[], startIndex: number, postId?: string) => void;
  onFilePress: (url: string, mimeType: string) => void;
  getTimeAgo: (timestamp: any) => string;
  onCommentCountUpdate?: (postId: string, newCount: number) => void;
  canPin?: boolean;
  onTogglePin?: (postId: string, shouldPin: boolean) => void;
  onDelete?: (postId: string) => void | Promise<void>;
}

const PostCard: React.FC<PostCardProps> = ({
  post,
  isLiked,
  isHighlighted = false,
  currentUserRole,
  currentUserId,
  onLike,
  onProfileClick,
  onTagClick,
  onImagePress,
  onFilePress,
  getTimeAgo,
  onCommentCountUpdate,
  canPin = false,
  onTogglePin,
  onDelete,
}) => {
  const [showCommentsModal, setShowCommentsModal] = useState(false);
  const [showLikesModal, setShowLikesModal] = useState(false);
  const [authorData, setAuthorData] = useState<UserData | null>(null);
  const [authorLoading, setAuthorLoading] = useState(true);
  const [activeImageIndex, setActiveImageIndex] = useState(0);

  useEffect(() => {
    let isActive = true;

    const fetchAuthor = async () => {
      const userIdToFetch = post.realUserId || post.userId;
      if (!userIdToFetch || userIdToFetch === "anonymous") {
        if (isActive) {
          setAuthorData(null);
          setAuthorLoading(false);
        }
        return;
      }

      try {
        const data = await getUserData(userIdToFetch);
        if (isActive) setAuthorData(data);
      } catch {
        if (isActive) setAuthorData(null);
      } finally {
        if (isActive) setAuthorLoading(false);
      }
    };

    setAuthorLoading(true);
    fetchAuthor();

    return () => {
      isActive = false;
    };
  }, [post.realUserId, post.userId]);

  const imageFiles = (post.files || []).filter(
    (f) => f.mimeType.startsWith("image/") && !f.mimeType.includes("gif"),
  );
  const gifFiles = (post.files || []).filter((f) => f.mimeType.includes("gif"));
  const nonImageFiles = (post.files || []).filter(
    (f) => !f.mimeType.startsWith("image/"),
  );

  if (post.imageUrl && !imageFiles.find((f) => f.url === post.imageUrl)) {
    imageFiles.unshift({ url: post.imageUrl, mimeType: "image/jpeg" });
  }

  const handleCommentAdded = () => {
    if (onCommentCountUpdate) {
      onCommentCountUpdate(post.id, (post.commentCount || 0) + 1);
    }
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const slide = Math.round(
      event.nativeEvent.contentOffset.x / IMAGE_WIDTH
    );
    if (slide !== activeImageIndex && slide >= 0 && slide < imageFiles.length) {
      setActiveImageIndex(slide);
    }
  };

  const taggedUsers = post.taggedUsers ?? [];

  return (
    <View style={[styles.postCard, isHighlighted && styles.highlightedPostCard]}>
      <View style={styles.hangingLayout}>
        <View style={styles.avatarColumn}>
          <PostAvatar
            post={post}
            authorData={authorData}
            authorLoading={authorLoading}
            currentUserId={currentUserId}
            onProfileClick={onProfileClick}
          />
        </View>

        <View style={styles.contentColumn}>
          <PostHeader
            post={post}
            authorData={authorData}
            currentUserRole={currentUserRole}
            currentUserId={currentUserId}
            onProfileClick={onProfileClick}
            getTimeAgo={getTimeAgo}
            canPin={canPin}
            onTogglePin={onTogglePin}
            onDelete={onDelete}
          />

          {post.content && (
            <View style={styles.postContentContainer}>
              <ExpandableText
                text={post.content}
                textStyle={styles.postContent}
                collapsedLines={5}
                minLengthToToggle={180}
                buttonStyle={styles.toggleContainer}
                buttonTextStyle={styles.toggleText}
              />
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
              <Image
                source={{ uri: gifFiles[0].url }}
                style={styles.gif}
                resizeMode="cover"
              />
            </View>
          )}

          {imageFiles.length > 0 && (
            <View style={styles.carouselContainer}>
              <ScrollView
                horizontal
                pagingEnabled
                decelerationRate="normal"
                showsHorizontalScrollIndicator={false}
                bounces={false}
                overScrollMode="never"
                onScroll={handleScroll}
                scrollEventThrottle={16}
                // Optional: Snap alignment optimizations
                snapToAlignment="center"
                disableIntervalMomentum={true}
              >
                {imageFiles.map((item, index) => (
                  <TouchableOpacity
                    key={`${item.url}-${index}`}
                    activeOpacity={0.95}
                    onPress={() => {
                      if (onImagePress) {
                        const urls = imageFiles.map((f) => f.url);
                        onImagePress(urls, index, post.id);
                      }
                    }}
                  >
                    <Image
                      source={{ uri: item.url }}
                      style={styles.carouselImage}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {/* Dynamic Dot Indicators */}
              {imageFiles.length > 1 && (
                <View style={styles.paginationDotsContainer}>
                  {imageFiles.map((_, index) => (
                    <View
                      key={index}
                      style={[
                        styles.dot,
                        activeImageIndex === index ? styles.activeDot : styles.inactiveDot,
                      ]}
                    />
                  ))}
                </View>
              )}
            </View>
          )}

          {nonImageFiles.length > 0 && (
            <FilesList files={nonImageFiles} onFilePress={onFilePress} />
          )}
          {post.link && <LinkPreview link={post.link} />}

          <AiReplyCard reply={post.aiReply} />

          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => onLike(post.id, post.likedBy || [])}
            >
              <Ionicons
                name={isLiked ? "heart" : "heart-outline"}
                size={20}
                color={isLiked ? "#a61f1f" : "#956a5f"}
              />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => setShowCommentsModal(true)}
            >
              <Ionicons name="chatbubble-outline" size={19} color="#956a5f" />
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionButton}>
              <MaterialIcons
                name="bookmark-outline"
                size={21}
                color="#956a5f"
              />
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
                {post.commentCount}{" "}
                {post.commentCount === 1 ? "comment" : "comments"}
              </Text>
            )}
          </View>
        </View>
      </View>

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
                <Ionicons
                  name="close-circle-outline"
                  size={28}
                  color="#a61f1f"
                />
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
                <Text style={styles.noLikesText}>
                  No one has liked this post yet.
                </Text>
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

// eslint-disable-next-line react/display-name
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
          {user?.profileImage ? (
            <Image source={{ uri: user.profileImage }} style={styles.likeAvatarImage} />
          ) : (
            <Text style={styles.likeAvatarText}>
              {(user?.firstname?.[0] || "U").toUpperCase()}
            </Text>
          )}
        </View>
        <Text style={styles.likeName}>
          {displayName}
          {isYou && <Text style={styles.youBadge}> • you</Text>}
        </Text>
      </TouchableOpacity>
    );
  },
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
  const visibleUsers = expanded
    ? taggedUsers
    : taggedUsers.slice(0, MAX_VISIBLE);
  const remainingCount = taggedUsers.length - MAX_VISIBLE;

  const hasMore = remainingCount > 0 && !expanded;

  return (
    <View style={styles.taggedBox}>
      <View style={styles.taggedContent}>
        <Ionicons name="people-outline" size={14} color="#c28724" />
        <Text style={styles.taggedLabel}> Tagged: </Text>

        {visibleUsers.map((tag, index) => (
          <React.Fragment key={tag.id}>
            <TouchableOpacity onPress={() => onTagClick(tag.id)}>
              <Text style={styles.taggedName}>{tag.name}</Text>
            </TouchableOpacity>
            {(index < visibleUsers.length - 1 ||
              (hasMore && index === visibleUsers.length - 1)) && (
              <Text style={styles.taggedSeparator}>, </Text>
            )}
          </React.Fragment>
        ))}

        {hasMore && (
          <TouchableOpacity
            onPress={() => setExpanded(true)}
            activeOpacity={0.7}
          >
            <Text style={styles.moreCount}>+{remainingCount} more</Text>
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
  authorData: UserData | null;
  authorLoading: boolean;
  currentUserId?: string;
  onProfileClick: (userId?: string) => void;
}> = ({ post, authorData, authorLoading, currentUserId, onProfileClick }) => {
  const authorRole = parseUserRole(authorData?.role) ?? parseUserRole(post.role);
  const roleColor = getRoleColor(authorRole || "student");
  const isIdentityVisible = !post.isAnonymous;

  const canClickProfile =
    isIdentityVisible &&
    !!authorData?.userId &&
    authorData.userId !== "anonymous";

  const handleProfileClick = () => {
    if (!canClickProfile) return;
    if (authorData?.userId === currentUserId) {
      onProfileClick("self");
    } else {
      onProfileClick(
        buildUserProfileHref({
          userId: authorData.userId,
          profileDocId: authorData.studentID,
        }),
      );
    }
  };

  return (
    <TouchableOpacity onPress={handleProfileClick} disabled={!canClickProfile}>
      <View style={styles.avatar}>
        {authorLoading ? (
          <ActivityIndicator size="small" color="#956a5f" />
        ) : isIdentityVisible && resolveAvatarUri(authorData) ? (
          <Image source={{ uri: resolveAvatarUri(authorData)! }} style={styles.avatarImage} />
        ) : isIdentityVisible ? (
          <Text style={[styles.avatarText, { color: roleColor }]}>
            {(
              authorData?.firstname?.[0] ||
              post.username?.[0] ||
              "A"
            ).toUpperCase()}
          </Text>
        ) : (
          <Ionicons name="person" size={18} color="#956a5f" />
        )}
      </View>
    </TouchableOpacity>
  );
};

/* ==================== POST HEADER ==================== */
const PostHeader: React.FC<{
  post: Post;
  authorData: UserData | null;
  currentUserRole?: UserRole;
  currentUserId?: string;
  onProfileClick: (userId?: string) => void;
  getTimeAgo: (timestamp: any) => string;
  canPin?: boolean;
  onTogglePin?: (postId: string, shouldPin: boolean) => void;
  onDelete?: (postId: string) => void | Promise<void>;
}> = ({
  post,
  authorData,
  currentUserRole,
  currentUserId,
  onProfileClick,
  getTimeAgo,
  canPin = false,
  onTogglePin,
  onDelete,
}) => {
  const [revealed, setRevealed] = useState(false);
  const authorUserId = post.realUserId || post.userId;
  const authorRole = parseUserRole(authorData?.role) ?? parseUserRole(post.role);
  const roleColor = getRoleColor(authorRole || "student");

  const canSeeIdentity = canViewAnonymousIdentity(
    currentUserRole,
    authorRole,
    post.isAnonymous ?? false,
  );

  const canShowEyeIcon = (post.isAnonymous ?? true) && canSeeIdentity;
  const isIdentityVisible = !post.isAnonymous || (revealed && canSeeIdentity);
  const canDelete = canDeleteContent({
    viewerRole: currentUserRole,
    viewerUserId: currentUserId,
    authorUserId,
    authorRole,
  });

  const displayName = isIdentityVisible
    ? authorData
      ? `${authorData.firstname} ${authorData.lastname}`
      : post.username || "User"
    : "Anonymous";

  const canClickProfile =
    isIdentityVisible &&
    !!authorData?.userId &&
    authorData.userId !== "anonymous";
  const isPinned = !!post.pinnedAt;
  const canOpenOptions = canPin || canDelete;

  const handleProfileClick = () => {
    if (!canClickProfile) return;
    if (authorData?.userId === currentUserId) {
      onProfileClick("self");
    } else {
      onProfileClick(
        buildUserProfileHref({
          userId: authorData.userId,
          profileDocId: authorData.studentID,
        }),
      );
    }
  };

  const handleMorePress = () => {
    if (!canOpenOptions) return;

    const options: {
      text: string;
      style?: "cancel" | "default" | "destructive";
      onPress?: () => void;
    }[] = [];

    if (canPin && onTogglePin) {
      options.push({
        text: isPinned ? "Unpin Post" : "Pin Post",
        onPress: () => onTogglePin(post.id, !isPinned),
      });
    }

    if (canDelete && onDelete) {
      options.push({
        text: "Delete",
        style: "destructive",
        onPress: () => onDelete(post.id),
      });
    }

    Alert.alert("Post Options", undefined, [
      ...options,
      { text: "Cancel", style: "cancel" },
    ]);
  };

  return (
    <View style={styles.header}>
      <View style={styles.headerTopRow}>
        <View style={styles.usernameRow}>
          <TouchableOpacity
            onPress={handleProfileClick}
            disabled={!canClickProfile}
          >
            <Text style={styles.username}>{displayName}</Text>
          </TouchableOpacity>

          {isIdentityVisible && authorRole && authorRole !== "student" && (
            <View
              style={[
                styles.roleChip,
                { backgroundColor: roleColor + "20", borderColor: roleColor },
              ]}
            >
              <Text style={[styles.roleChipText, { color: roleColor }]}>
                {getRoleDisplayName(authorRole)}
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
                color={revealed ? "#a61f1f" : "#956a5f"}
              />
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.headerRight}>
          {isPinned && (
            <View style={styles.pinnedBadge}>
              <Ionicons name="pin" size={11} color="#fffaf7" />
              <Text style={styles.pinnedBadgeText}>Pinned</Text>
            </View>
          )}
          {canOpenOptions && (
            <TouchableOpacity
              style={styles.moreButton}
              activeOpacity={0.7}
              onPress={handleMorePress}
            >
              <Ionicons name="ellipsis-horizontal" size={18} color="#8f6a60" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <Text style={styles.timestamp}>{getTimeAgo(post.createdAt)}</Text>
    </View>
  );
};

/* ==================== FILES LIST ==================== */
const FilesList: React.FC<{
  files: FileAttachment[];
  onFilePress: (url: string, mimeType: string) => void;
}> = ({ files, onFilePress }) => {
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
    if (mimeType.includes("word") || mimeType.includes("document"))
      return "document";
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
          <Ionicons
            name={getFileIcon(file.mimeType)}
            size={18}
            color="#c28724"
          />
          <Text style={styles.fileName} numberOfLines={1}>
            {file.name || getFileNameFromUrl(file.url)}
          </Text>
          <Ionicons name="download-outline" size={14} color="#956a5f" />
        </TouchableOpacity>
      ))}
    </View>
  );
};

/* ==================== LINK PREVIEW ==================== */
const LinkPreview: React.FC<{ link: { url: string; title: string } }> = ({
  link,
}) => (
  <TouchableOpacity
    style={styles.linkPreview}
    onPress={() =>
      Linking.openURL(link.url).catch(() =>
        Alert.alert("Error", "Cannot open link"),
      )
    }
    activeOpacity={0.7}
  >
    <Ionicons name="link" size={14} color="#c28724" />
    <View style={{ flex: 1, marginLeft: 6 }}>
      <Text style={styles.linkTitle} numberOfLines={1}>
        {link.title}
      </Text>
      <Text style={styles.linkUrl} numberOfLines={1}>
        {link.url}
      </Text>
    </View>
    <Ionicons name="open-outline" size={13} color="#956a5f" />
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  postCard: {
    backgroundColor: "#fffaf7",
    paddingVertical: 14,
    paddingHorizontal: FEED_HORIZONTAL_PADDING,
    borderBottomWidth: 1,
    borderBottomColor: "#ead8cf",
    overflow: "visible",
  },
  highlightedPostCard: {
    borderLeftWidth: 4,
    borderLeftColor: "#a61f1f",
    backgroundColor: "#fff4ee",
  },
  hangingLayout: { flexDirection: "row", overflow: "visible" },
  avatarColumn: { width: AVATAR_COLUMN_WIDTH, marginRight: AVATAR_COLUMN_GAP },
  contentColumn: { flex: 1, overflow: "visible" },

  postContentContainer: { marginTop: 4, marginBottom: 8 },
  postContent: { color: "#4f1c17", fontSize: 15, lineHeight: 21 },
  toggleContainer: { alignSelf: "flex-start", marginTop: 4 },
  toggleText: { color: "#a61f1f", fontSize: 14, fontWeight: "600" },

  taggedBox: {
    backgroundColor: "#f8eee8",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: "#ecd2b0",
  },
  taggedContent: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
  },
  taggedLabel: {
    color: "#8f6a60",
    fontSize: 13,
  },
  taggedName: {
    color: "#a61f1f",
    fontWeight: "600",
    fontSize: 13.5,
  },
  taggedSeparator: {
    color: "#8f6a60",
    fontSize: 13,
  },
  moreCount: {
    color: "#c28724",
    fontWeight: "600",
    fontSize: 13.5,
  },
  showLessText: {
    color: "#8f6a60",
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
  statText: { color: "#8f6a60", fontSize: 13, fontWeight: "500" },
  statLink: { color: "#a61f1f", fontSize: 13, fontWeight: "600" },

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
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ead8cf",
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#ead8cf",
  },
  modalTitle: { color: "#4f1c17", fontSize: 17, fontWeight: "700" },
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
    backgroundColor: "#f2dfd4",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  likeAvatarImage: { width: "100%", height: "100%" },
  likeAvatarText: { color: "#a61f1f", fontSize: 16, fontWeight: "bold" },
  likeName: { color: "#4f1c17", fontSize: 15 },
  youBadge: { color: "#8f6a60", fontSize: 13, fontStyle: "italic" },
  noLikesText: {
    color: "#8f6a60",
    fontSize: 15,
    textAlign: "center",
    paddingVertical: 40,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#f2dfd4",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#e3c3b8",
    overflow: "hidden",
  },
  avatarImage: { width: "100%", height: "100%" },
  avatarText: {
    fontSize: 17,
    fontWeight: "700",
  },

  // Header with name + date below
  header: {
    marginBottom: 8,
  },
  headerTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  usernameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    flex: 1,
  },
  username: {
    color: "#4f1c17",
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
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  moreButton: {
    paddingHorizontal: 2,
    paddingTop: 2,
    paddingBottom: 4,
    alignSelf: "flex-start",
  },
  pinnedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#8f3a2b",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  pinnedBadgeText: {
    color: "#fffaf7",
    fontSize: 10.5,
    fontWeight: "700",
  },
  timestamp: {
    color: "#8f6a60",
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
    color: "#a61f1f",
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
    color: "#8f6a60",
    fontSize: 13,
  },
  carouselContainer: {
    marginVertical: 10,
    overflow: "visible",
    position: "relative",
  },
  carouselImage: {
    width: IMAGE_WIDTH,
    height: IMAGE_WIDTH * 1.25,
    backgroundColor: "#efe1d6",
    borderRadius: 18,
  },
  paginationDotsContainer: {
    position: "absolute",
    bottom: 12,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  activeDot: {
    backgroundColor: "#ffffff",
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  inactiveDot: {
    backgroundColor: "rgba(255, 255, 255, 0.5)",
  },

  mediaContainer: {
    marginVertical: 10,
  },
  gif: {
    width: IMAGE_WIDTH,
    height: 220,
    borderRadius: 12,
    backgroundColor: "#efe1d6",
  },

  filesContainer: {
    gap: 6,
    marginVertical: 10,
  },
  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f8eee8",
    padding: 10,
    borderRadius: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: "#ecd2b0",
  },
  fileName: {
    flex: 1,
    color: "#4f1c17",
    fontSize: 13,
  },

  linkPreview: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f8eee8",
    borderRadius: 10,
    padding: 10,
    marginVertical: 10,
    borderWidth: 1,
    borderColor: "#ecd2b0",
  },
  linkTitle: {
    color: "#4f1c17",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 2,
  },
  linkUrl: {
    color: "#8f6a60",
    fontSize: 12,
  },
});

export default PostCard;
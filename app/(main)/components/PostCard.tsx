// components/PostCard.tsx

import { resolveAvatarUri } from "@/utils/avatar";
import ConfirmDialog from "./ConfirmDialog";
import { AVATAR_SIZE_SMALL, FEED_IMAGE_WIDTH, avatarThumb, feedImage } from "@/utils/cloudinaryImages";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import {
  canDeleteContent,
  canViewAnonymousIdentity,
  getRoleColor,
  getRoleDisplayName,
  getStudentDocIdFromAuthUser,
  getUserData,
  parseUserRole,
  UserData,
  UserRole,
} from "@/utils/rbac";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import { useIsFocused } from "@react-navigation/native";
import {
  ActivityIndicator,
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
import AiReplyCard from "../components/AiReplyCard";
import CommentModal from "../components/CommentModal";
import ExpandableText from "../components/ExpandableText";
import VideoPostMedia from "../components/VideoPostMedia";
import { doc, updateDoc, arrayUnion, arrayRemove } from "firebase/firestore";
import { db, auth } from "@/Firebase_configure";

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
  authorName?: string;
  displayName?: string;
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
  aiReply?: {
    text?: string;
    model?: string | null;
    generatedAtMs?: number;
    status?: string | null;
  };
  pinnedAt?: any;
};
interface VideoPlayerProps {
  videoUrl: string;
  isPlaying: boolean;
}
interface PostCardProps {
  post: Post;
  isLiked: boolean;
  isHighlighted?: boolean;
  currentUserRole?: UserRole;
  currentUserId?: string;
  onCommentPress?: (postId: string) => void;
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
  onEdit?: (postId: string) => void;
}

/* Helper Component for Video Playback Focus Handling */
const VideoMediaItem = ({ url, width }: { url: string; width: number }) => {
  const isFocused = useIsFocused();

  return (
    <VideoPostMedia
      uri={url}
      width={width}
      isPlaying={isFocused}
    />
  );
};

const PostCard = React.memo<PostCardProps>(({
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
  onEdit,
}) => {
  const [showCommentsModal, setShowCommentsModal] = useState(false);
  const [showLikesModal, setShowLikesModal] = useState(false);
  const [authorData, setAuthorData] = useState<UserData | null>(null);
  const [authorLoading, setAuthorLoading] = useState(true);
  const [activeImageIndex, setActiveImageIndex] = useState(0);

  // Bookmark State
  const activeUserId = currentUserId || auth.currentUser?.uid;
  const [isBookmarked, setIsBookmarked] = useState<boolean>(
    activeUserId ? post.bookmarkedBy?.includes(activeUserId) ?? false : false
  );
  // Guards against rapid double-taps firing two toggle requests before the
  // first one resolves (which could desync isBookmarked from Firestore).
  const isBookmarkingRef = useRef(false);

  // Keep isBookmarked in sync when the post data refreshes (pull-to-refresh,
  // remount, bookmarking the same post from elsewhere, etc). Previously this
  // only ran once on mount, so bookmarkedBy changes after that were ignored.
  useEffect(() => {
    setIsBookmarked(
      activeUserId ? post.bookmarkedBy?.includes(activeUserId) ?? false : false
    );
  }, [activeUserId, post.bookmarkedBy]);

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
  const videoFiles = (post.files || []).filter((f) => f.mimeType.startsWith("video/"));
  const nonImageFiles = (post.files || []).filter(
    (f) => !f.mimeType.startsWith("image/") && !f.mimeType.startsWith("video/"),
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

  const handleToggleBookmark = async () => {
    if (!activeUserId) return;
    // Ignore taps while a previous toggle is still in flight — otherwise a
    // fast double-tap fires two requests before the first resolves, which
    // can leave isBookmarked out of sync with what actually got saved.
    if (isBookmarkingRef.current) return;
    isBookmarkingRef.current = true;

    // This app keys profile documents by "students/{studentId}" (uid or
    // email-prefix) — there is no "users" collection, so writing there was
    // always rejected by security rules. Resolve the same doc id every
    // other screen already uses for the signed-in user's own profile.
    const studentDocId = getStudentDocIdFromAuthUser(auth.currentUser) || activeUserId;

    const previousState = isBookmarked;
    setIsBookmarked(!previousState);

    try {
      const studentRef = doc(db, "students", studentDocId);
      const postRef = doc(db, "posts", post.id);

      // Write to BOTH sides: the owner's own bookmarkedPostIds (in case
      // other screens, like "Saved Posts", read from there) and the post's
      // own bookmarkedBy (which is what this component reads to decide the
      // icon state). Previously only one side was written, so the field
      // this component actually reads never updated.
      await Promise.all([
        updateDoc(studentRef, {
          bookmarkedPostIds: previousState
            ? arrayRemove(post.id)
            : arrayUnion(post.id),
        }),
        updateDoc(postRef, {
          bookmarkedBy: previousState
            ? arrayRemove(activeUserId)
            : arrayUnion(activeUserId),
        }),
      ]);
    } catch (error) {
      console.error("Error updating bookmark:", error);
      setIsBookmarked(previousState);
    } finally {
      isBookmarkingRef.current = false;
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
            onEdit={onEdit}
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
                source={{ uri: feedImage(gifFiles[0].url, FEED_IMAGE_WIDTH) }}
                style={styles.gif}
                resizeMode="cover"
              />
            </View>
          )}

          {videoFiles.length > 0 && (
            <View style={styles.mediaContainer}>
              {videoFiles.map((video, index) => (
                <VideoMediaItem
                  key={`${video.url}-${index}`}
                  url={video.url}
                  width={IMAGE_WIDTH}
                />
              ))}
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
                      source={{ uri: feedImage(item.url, FEED_IMAGE_WIDTH) }}
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

            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleToggleBookmark}
            >
              <MaterialIcons
                name={isBookmarked ? "bookmark" : "bookmark-outline"}
                size={21}
                color={isBookmarked ? "#a61f1f" : "#956a5f"}
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
});
PostCard.displayName = "PostCard";

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
            <Image source={{ uri: avatarThumb(user.profileImage, AVATAR_SIZE_SMALL) }} style={styles.likeAvatarImage} />
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
LikeUserRow.displayName = "LikeUserRow";

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
          <Image source={{ uri: avatarThumb(resolveAvatarUri(authorData), AVATAR_SIZE_SMALL) }} style={styles.avatarImage} />
        ) : isIdentityVisible ? (
          <Text style={[styles.avatarText, { color: roleColor }]}>
            {(
              authorData?.firstname?.[0] ||
              post.authorName?.[0] ||
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
  onEdit?: (postId: string) => void;
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
  onEdit,
}) => {
  const [revealed, setRevealed] = useState(false);
  const [showPostActions, setShowPostActions] = useState(false);

  const authorUserId = post.realUserId || post.userId;

  const authorRole =
    parseUserRole(authorData?.role) ?? parseUserRole(post.role);

  const roleColor = getRoleColor(authorRole || "student");

  const canSeeIdentity = canViewAnonymousIdentity(
    currentUserRole,
    authorRole,
    post.isAnonymous ?? false,
  );

  const canShowEyeIcon =
    (post.isAnonymous ?? true) && canSeeIdentity;

  const isIdentityVisible =
    !post.isAnonymous || (revealed && canSeeIdentity);

  const canDelete = canDeleteContent({
    viewerRole: currentUserRole,
    viewerUserId: currentUserId,
    authorUserId,
    authorRole,
  });

  const getAuthorDisplayName = () => {
    if (!isIdentityVisible) {
      return "Anonymous";
    }

    const firstName = authorData?.firstname?.trim() || "";
    const lastName = authorData?.lastname?.trim() || "";

    const fullName = `${firstName} ${lastName}`.trim();

    return (
      fullName ||
      post.authorName?.trim() ||
      post.username?.trim() ||
      "User"
    );
  };

  const displayName = getAuthorDisplayName();

  const canClickProfile =
    isIdentityVisible &&
    !!authorData?.userId &&
    authorData.userId !== "anonymous";

  const isPinned = !!post.pinnedAt;

  const canEdit = authorUserId === currentUserId && !!onEdit;
  const canOpenOptions = canPin || canDelete || canEdit;

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
    setShowPostActions(true);
  };

  const closePostActions = () => {
    setShowPostActions(false);
  };

  const handleEditPost = () => {
    closePostActions();
    onEdit?.(post.id);
  };

  const handleTogglePin = () => {
    closePostActions();
    onTogglePin?.(post.id, !isPinned);
  };

  const handleDeletePost = () => {
    closePostActions();
    onDelete?.(post.id);
  };

  return (
    <View style={styles.header}>
      <View style={styles.headerTopRow}>
        <View style={styles.usernameRow}>
          <TouchableOpacity
            onPress={handleProfileClick}
            disabled={!canClickProfile}
          >
            <Text style={styles.username}>
              {displayName}
            </Text>
          </TouchableOpacity>

          {isIdentityVisible &&
            authorRole &&
            authorRole !== "student" && (
              <View
                style={[
                  styles.roleChip,
                  {
                    backgroundColor: roleColor + "20",
                    borderColor: roleColor,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.roleChipText,
                    { color: roleColor },
                  ]}
                >
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
                name={
                  revealed
                    ? "eye-off-outline"
                    : "eye-outline"
                }
                size={14}
                color={
                  revealed
                    ? "#a61f1f"
                    : "#956a5f"
                }
              />
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.headerRight}>
          {isPinned && (
            <View style={styles.pinnedBadge}>
              <Ionicons
                name="pin"
                size={11}
                color="#fffaf7"
              />
              <Text style={styles.pinnedBadgeText}>
                Pinned
              </Text>
            </View>
          )}

          {canOpenOptions && (
            <TouchableOpacity
              style={styles.moreButton}
              activeOpacity={0.7}
              onPress={handleMorePress}
            >
              <Ionicons
                name="ellipsis-horizontal"
                size={18}
                color="#8f6a60"
              />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <Text style={styles.timestamp}>
        {getTimeAgo(post.createdAt)}
      </Text>

      <Modal
        visible={showPostActions}
        transparent
        animationType="fade"
        onRequestClose={closePostActions}
      >
        <TouchableOpacity
          style={styles.actionMenuOverlay}
          activeOpacity={1}
          onPress={closePostActions}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={styles.actionMenuContainer}
            onPress={(event) => event.stopPropagation()}
          >
            <View style={styles.actionMenuHeader}>
              <Text style={styles.actionMenuTitle}>Post Actions</Text>
              <TouchableOpacity
                style={styles.actionMenuCloseButton}
                onPress={closePostActions}
                accessibilityLabel="Close post actions"
              >
                <Ionicons name="close" size={20} color="#8f6a60" />
              </TouchableOpacity>
            </View>

            <View style={styles.actionMenuDivider} />

            {canEdit && (
              <TouchableOpacity
                style={styles.actionMenuItem}
                activeOpacity={0.75}
                onPress={handleEditPost}
              >
                <View style={styles.actionMenuItemIcon}>
                  <Ionicons name="create-outline" size={20} color="#8f6a60" />
                </View>
                <Text style={styles.actionMenuItemText}>Edit Post</Text>
              </TouchableOpacity>
            )}

            {canPin && onTogglePin && (
              <TouchableOpacity
                style={styles.actionMenuItem}
                activeOpacity={0.75}
                onPress={handleTogglePin}
              >
                <View style={styles.actionMenuItemIcon}>
                  <Ionicons
                    name={isPinned ? "pin" : "pin-outline"}
                    size={20}
                    color="#8f6a60"
                  />
                </View>
                <Text style={styles.actionMenuItemText}>
                  {isPinned ? "Unpin Post" : "Pin Post"}
                </Text>
              </TouchableOpacity>
            )}

            {canDelete && onDelete && (
              <TouchableOpacity
                style={styles.actionMenuItem}
                activeOpacity={0.75}
                onPress={handleDeletePost}
              >
                <View style={[styles.actionMenuItemIcon, styles.deleteActionIcon]}>
                  <Ionicons name="trash-outline" size={20} color="#a61f1f" />
                </View>
                <Text style={[styles.actionMenuItemText, styles.deleteActionText]}>
                  Delete Post
                </Text>
              </TouchableOpacity>
            )}

            <View style={styles.actionMenuDivider} />

            <TouchableOpacity
              style={[styles.actionMenuItem, styles.cancelActionItem]}
              activeOpacity={0.75}
              onPress={closePostActions}
            >
              <View style={styles.actionMenuItemIcon}>
                <Ionicons name="close-outline" size={20} color="#8f6a60" />
              </View>
              <Text style={styles.actionMenuItemText}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
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
}) => {
  const [linkError, setLinkError] = useState(false);

  return (
    <>
      <TouchableOpacity
        style={styles.linkPreview}
        onPress={() =>
          Linking.openURL(link.url).catch(() => setLinkError(true))
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
      <ConfirmDialog
        visible={linkError}
        title="Error"
        description="Cannot open link"
        confirmText="OK"
        singleAction
        destructive
        onConfirm={() => setLinkError(false)}
        onCancel={() => setLinkError(false)}
      />
    </>
  );
};

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
  actionMenuOverlay: {
    flex: 1,
    backgroundColor: "rgba(35, 18, 14, 0.42)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  actionMenuContainer: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fffaf7",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#ead8cf",
    overflow: "hidden",
    shadowColor: "#4f1c17",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 8,
  },
  actionMenuHeader: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
  },
  actionMenuTitle: {
    color: "#4f1c17",
    fontSize: 17,
    fontWeight: "700",
  },
  actionMenuCloseButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#f8eee8",
    alignItems: "center",
    justifyContent: "center",
  },
  actionMenuDivider: {
    height: 1,
    backgroundColor: "#ead8cf",
  },
  actionMenuItem: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
  },
  actionMenuItemIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "#f8eee8",
    alignItems: "center",
    justifyContent: "center",
  },
  actionMenuItemText: {
    flex: 1,
    color: "#4f1c17",
    fontSize: 15,
    fontWeight: "600",
  },
  deleteActionIcon: {
    backgroundColor: "#fbe9e5",
  },
  deleteActionText: {
    color: "#a61f1f",
  },
  cancelActionItem: {
    paddingBottom: 12,
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
  },
  linkUrl: {
    color: "#8f6a60",
    fontSize: 11.5,
    marginTop: 1,
  },
});

export default PostCard;
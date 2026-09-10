// components/PostCard.tsx

import { auth, db } from "@/Firebase_configure";
import { resolveAvatarUri } from "@/utils/avatar";
import { AVATAR_SIZE_SMALL, avatarThumb, FEED_IMAGE_WIDTH, feedImage } from "@/utils/cloudinaryImages";
import { getFileIconDetails } from "@/utils/fileTypeHelper";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import {
    canDeleteContent,
    canReportContent,
    canViewAnonymousIdentity,
    getRoleColor,
    getRoleDisplayName,
    getStudentDocIdFromAuthUser,
    getUserData,
    isStaff,
    parseUserRole,
    subscribeToUserDataUpdates,
    UserData,
    UserRole,
} from "@/utils/rbac";
import { showAppToast } from "@/utils/toastEvents";
import {
    normalizeCaptions,
    type CaptionSegment,
    type CaptionStatus,
} from "@/utils/videoCaptions";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useIsFocused } from "expo-router";
import { addDoc, arrayRemove, arrayUnion, collection, doc, getDoc, serverTimestamp, updateDoc, writeBatch } from "firebase/firestore";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Dimensions,
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
import ReanimatedAnimated, {
    useAnimatedStyle,
    useSharedValue,
    withSequence,
    withSpring,
    withTiming,
} from "react-native-reanimated";
import AiReplyCard from "../components/AiReplyCard";
import CommentModal from "../components/CommentModal";
import ExpandableText from "../components/ExpandableText";
import VideoPostMedia from "../components/VideoPostMedia";
import ConfirmDialog from "./ConfirmDialog";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const AVATAR_COLUMN_WIDTH = 40;
const AVATAR_COLUMN_GAP = 12;
const FEED_HORIZONTAL_PADDING = 16;
const DEFAULT_MEDIA_WIDTH =
  SCREEN_WIDTH - FEED_HORIZONTAL_PADDING * 2 - AVATAR_COLUMN_WIDTH - AVATAR_COLUMN_GAP;

type TaggedUser = {
  id: string;
  name: string;
  studentID: string;
};

import { getPostFlair } from "@/utils/postFlairs";

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
  pinnedBy?: string | null;
  pinExpiresAt?: any;
  targetDate?: any;
  targetDateLabel?: string | null;
  flair?: string;
  // Auto-generated video captions (written server-side after upload).
  captionStatus?: CaptionStatus;
  captions?: CaptionSegment[];
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
  // "Trending this week" renders this same card inside a narrow horizontal
  // scroller. `compact` only trims height (tighter text clamp, shorter media,
  // no AI-reply block, no bottom divider) — every real behaviour
  // (like / comment / bookmark / profile / menu / modals) is untouched, so
  // this is not a second card implementation.
  compact?: boolean;
  // Main-feed scroll visibility for X-style muted autoplay. `undefined` (the
  // default, and what every non-feed screen passes) keeps the old
  // tap-to-play behavior; a boolean opts this card's video into
  // autoplay-when-(focused && scrolled-into-view).
  videoCardVisible?: boolean;
}

/* Feed video: autoplays muted only when the Home screen has focus AND this
   specific card is scrolled into view — both, so leaving Home still pauses
   everything. Without `cardVisible` it falls back to the old manual player. */
const VideoMediaItem = ({
  url,
  width,
  cardVisible,
  captionStatus,
  captions,
}: {
  url: string;
  width: number;
  cardVisible?: boolean;
  captionStatus?: CaptionStatus;
  captions?: unknown;
}) => {
  const isFocused = useIsFocused();
  const feedAutoplay = cardVisible !== undefined;
  // Firestore data is untrusted: coerce to clean, start-sorted segments once
  // per doc update rather than on every render.
  const safeCaptions = useMemo(() => normalizeCaptions(captions), [captions]);

  return (
    <VideoPostMedia
      uri={url}
      width={width}
      feedAutoplay={feedAutoplay}
      isPlaying={feedAutoplay ? isFocused && !!cardVisible : isFocused}
      captionStatus={captionStatus}
      captions={safeCaptions}
    />
  );
};

/**
 * Animated like / bookmark toggle. The tap runs a spring-overshoot scale
 * "burst" and cross-fades an outline icon into a solid one, instead of the
 * old instant glyph swap. The underlying toggle fires immediately from the
 * press handler — the animation never gates it. `withHaptic` adds one light
 * pulse, and only on the positive (activating) tap.
 */
type ActionToggleIconProps = {
  active: boolean;
  onToggle: () => void;
  family: "ionicons" | "material";
  activeName: string;
  inactiveName: string;
  size: number;
  activeColor: string;
  inactiveColor: string;
  withHaptic?: boolean;
};

const ActionToggleIcon = React.memo(function ActionToggleIcon({
  active,
  onToggle,
  family,
  activeName,
  inactiveName,
  size,
  activeColor,
  inactiveColor,
  withHaptic = false,
}: ActionToggleIconProps) {
  const scale = useSharedValue(1);
  const fill = useSharedValue(active ? 1 : 0);
  const IconSet = family === "ionicons" ? Ionicons : MaterialIcons;

  // Cross-fade the solid glyph in/out whenever the toggle state changes
  // (driven by the parent's data, so it also covers changes made elsewhere).
  useEffect(() => {
    fill.value = withTiming(active ? 1 : 0, { duration: 90 });
  }, [active, fill]);

  const handlePress = () => {
    // Fire the real action first — never wait on the animation.
    onToggle();
    if (withHaptic && !active) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    scale.value = withSequence(
      withTiming(1.25, { duration: 120 }),
      withSpring(1, { damping: 6, stiffness: 220, mass: 0.6 }),
    );
  };

  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const fillStyle = useAnimatedStyle(() => ({
    opacity: fill.value,
    transform: [{ scale: 0.6 + fill.value * 0.4 }],
  }));

  return (
    <TouchableOpacity
      style={styles.actionButton}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      <ReanimatedAnimated.View
        style={[
          { width: size, height: size, alignItems: "center", justifyContent: "center" },
          scaleStyle,
        ]}
      >
        <IconSet name={inactiveName as any} size={size} color={inactiveColor} />
        <ReanimatedAnimated.View
          style={[
            StyleSheet.absoluteFill,
            { alignItems: "center", justifyContent: "center" },
            fillStyle,
          ]}
        >
          <IconSet name={activeName as any} size={size} color={activeColor} />
        </ReanimatedAnimated.View>
      </ReanimatedAnimated.View>
    </TouchableOpacity>
  );
});

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
  compact = false,
  videoCardVisible,
}) => {
  const [showCommentsModal, setShowCommentsModal] = useState(false);
  const [showLikesModal, setShowLikesModal] = useState(false);
  const [authorData, setAuthorData] = useState<UserData | null>(null);
  const [authorLoading, setAuthorLoading] = useState(true);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  // PostCard can be rendered full-width in Home or inside a narrower parent
  // (for example Profile -> My Posts). Measure the real content column so
  // media never assumes the full device width and spills past its card.
  const [mediaWidth, setMediaWidth] = useState(DEFAULT_MEDIA_WIDTH);

  // Bookmark State
  const activeUserId = currentUserId || auth.currentUser?.uid;
  const [isBookmarked, setIsBookmarked] = useState<boolean>(
    activeUserId ? post.bookmarkedBy?.includes(activeUserId) ?? false : false
  );
  // True while saveBookmark is running.
  const isBookmarkingRef = useRef(false);
  // The bookmark state the reader tapped last; saveBookmark keeps saving until
  // Firestore matches it.
  const wantedBookmarkRef = useRef<boolean | null>(null);

  // Keep isBookmarked in sync when the post data refreshes (pull-to-refresh,
  // remount, bookmarking the same post from elsewhere, etc). Previously this
  // only ran once on mount, so bookmarkedBy changes after that were ignored.
  useEffect(() => {
    // While a save is running the icon shows the reader's last tap; the post
    // data catches up once the save lands.
    if (isBookmarkingRef.current) return;
    setIsBookmarked(
      activeUserId ? post.bookmarkedBy?.includes(activeUserId) ?? false : false
    );
  }, [activeUserId, post.bookmarkedBy]);

  useEffect(() => {
    let isActive = true;
    const userIdToFetch = post.realUserId || post.userId;

    const fetchAuthor = async () => {
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

    const unsubscribe = subscribeToUserDataUpdates((updatedId, updatedData) => {
      if (
        isActive &&
        userIdToFetch &&
        (updatedId === userIdToFetch || updatedId === authorData?.studentID)
      ) {
        setAuthorData((prev) => (prev ? { ...prev, ...updatedData } : null));
      }
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [authorData?.studentID, post.realUserId, post.userId]);

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
      event.nativeEvent.contentOffset.x / mediaWidth
    );
    if (slide !== activeImageIndex && slide >= 0 && slide < imageFiles.length) {
      setActiveImageIndex(slide);
    }
  };

  const saveBookmark = async (uid: string, stateBeforeTaps: boolean) => {
    isBookmarkingRef.current = true;
    // Profiles live at "students/{studentId}" (uid or email prefix), the same
    // doc id every other screen uses for the signed-in user's own profile.
    // Saved Posts reads bookmarkedPostIds there; this card reads the post's own
    // bookmarkedBy, so both sides are written together.
    const studentRef = doc(db, "students", getStudentDocIdFromAuthUser(auth.currentUser) || uid);
    const postRef = doc(db, "posts", post.id);
    let savedState = stateBeforeTaps;

    try {
      while (wantedBookmarkRef.current !== savedState) {
        const want = wantedBookmarkRef.current === true;
        const savedPostIds = {
          bookmarkedPostIds: want ? arrayUnion(post.id) : arrayRemove(post.id),
        };
        try {
          const batch = writeBatch(db);
          batch.update(postRef, {
            bookmarkedBy: want ? arrayUnion(uid) : arrayRemove(uid),
          });
          batch.update(studentRef, savedPostIds);
          await batch.commit();
        } catch (error) {
          // The rules reject adding an id that's already in bookmarkedBy (or
          // removing one that isn't), which is what an out-of-date icon sends.
          // If the post already matches, only the Saved Posts list is left.
          const postSnapshot = await getDoc(postRef);
          const bookmarkedBy: string[] = postSnapshot.data()?.bookmarkedBy ?? [];
          if (bookmarkedBy.includes(uid) !== want) throw error;
          await updateDoc(studentRef, savedPostIds);
        }
        savedState = want;
      }
    } catch (error) {
      console.error("Error updating bookmark:", error);
      wantedBookmarkRef.current = savedState;
      setIsBookmarked(savedState);
      showAppToast({ message: "Couldn't update Saved Posts. Try again." });
    } finally {
      isBookmarkingRef.current = false;
    }
  };

  const handleToggleBookmark = () => {
    if (!activeUserId) return;
    // Taps are never ignored: each one flips the icon now, and saveBookmark
    // keeps saving until Firestore matches the last tap.
    const shownState =
      isBookmarkingRef.current && wantedBookmarkRef.current !== null
        ? wantedBookmarkRef.current
        : isBookmarked;
    const nextState = !shownState;
    wantedBookmarkRef.current = nextState;
    setIsBookmarked(nextState);
    showAppToast(
      nextState
        ? { message: "Post saved", actionLabel: "View", actionHref: "/(main)/BookmarksScreen" }
        : { message: "Removed from Saved Posts" },
    );
    if (!isBookmarkingRef.current) {
      void saveBookmark(activeUserId, shownState);
    }
  };

  const taggedUsers = post.taggedUsers ?? [];
  const postFlair = getPostFlair(post.flair);

  return (
    <View
      style={[
        styles.postCard,
        isHighlighted && styles.highlightedPostCard,
        compact && styles.postCardCompact,
      ]}
    >
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

        <View
          style={styles.contentColumn}
          onLayout={(event) => {
            const measuredWidth = Math.round(event.nativeEvent.layout.width);
            if (measuredWidth > 0 && measuredWidth !== mediaWidth) {
              setMediaWidth(measuredWidth);
            }
          }}
        >
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

          <View style={[styles.postFlairBadge, postFlair.staffOnly && styles.postFlairBadgeOfficial]}>
            <Text style={styles.postFlairEmoji}>{postFlair.emoji}</Text>
            <Text style={[styles.postFlairText, postFlair.staffOnly && styles.postFlairTextOfficial]}>
              {postFlair.label}
            </Text>
          </View>

          {post.content && (
            <View style={styles.postContentContainer}>
              <ExpandableText
                text={post.content}
                textStyle={styles.postContent}
                collapsedLines={compact ? 3 : 5}
                // In the trending scroller the card can't grow, so never offer
                // an inline "show more" — the tap target is the card itself.
                minLengthToToggle={compact ? Number.MAX_SAFE_INTEGER : 180}
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
                style={[
                  styles.gif,
                  { width: mediaWidth },
                  compact && styles.compactMedia,
                ]}
                contentFit="cover"
              />
            </View>
          )}

          {videoFiles.length > 0 && (
            <View style={styles.mediaContainer}>
              {videoFiles.map((video, index) => (
                <VideoMediaItem
                  key={`${video.url}-${index}`}
                  url={video.url}
                  width={mediaWidth}
                  cardVisible={videoCardVisible}
                  captionStatus={post.captionStatus}
                  captions={post.captions}
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
                      style={[
                        styles.carouselImage,
                        {
                          width: mediaWidth,
                          height: compact ? mediaWidth * 0.62 : mediaWidth * 1.25,
                        },
                      ]}
                      contentFit="cover"
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

          {/* AI-reply block can be tall; omit it from the compact trending card. */}
          {!compact && <AiReplyCard reply={post.aiReply} />}

          <View style={styles.actions}>
            <ActionToggleIcon
              active={isLiked}
              onToggle={() => onLike(post.id, post.likedBy || [])}
              family="ionicons"
              activeName="heart"
              inactiveName="heart-outline"
              size={20}
              activeColor="#a61f1f"
              inactiveColor="#956a5f"
              withHaptic
            />

            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => setShowCommentsModal(true)}
            >
              <Ionicons name="chatbubble-outline" size={19} color="#956a5f" />
            </TouchableOpacity>

            <ActionToggleIcon
              active={isBookmarked}
              onToggle={handleToggleBookmark}
              family="material"
              activeName="bookmark"
              inactiveName="bookmark-outline"
              size={21}
              activeColor="#a61f1f"
              inactiveColor="#956a5f"
              withHaptic
            />
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
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [pendingReportReason, setPendingReportReason] = useState<string | null>(null);
  const [reportFeedback, setReportFeedback] = useState<{
    title: string;
    description: string;
    destructive: boolean;
  } | null>(null);

  const authorUserId = post.realUserId || post.userId;
  const reporterId = currentUserId || auth.currentUser?.uid;
  const isOwnPost = !!reporterId && authorUserId === reporterId;

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

  const isStaffViewer = isStaff(currentUserRole);

  const getAuthorDisplayName = () => {
    if (!isIdentityVisible) {
      if (post.isAnonymous && isOwnPost && isStaffViewer) {
        return "Anonymous (You)";
      }
      return "Anonymous";
    }

    const firstName = authorData?.firstname?.trim() || "";
    const lastName = authorData?.lastname?.trim() || "";

    const fullName = `${firstName} ${lastName}`.trim();

    if (fullName) return fullName;

    const fallback = post.authorName?.trim() || post.username?.trim() || "User";
    if (post.isAnonymous && /^Anonymous\d*$/i.test(fallback)) {
      return isOwnPost && isStaffViewer ? "Anonymous (You)" : "Anonymous";
    }

    return fallback;
  };

  const displayName = getAuthorDisplayName();

  const canClickProfile =
    isIdentityVisible &&
    !!authorData?.userId &&
    authorData.userId !== "anonymous";

  const isPinned = useMemo(() => {
    if (!post.pinnedAt) return false;
    if (!post.pinExpiresAt) return true;
    const expiresVal = post.pinExpiresAt;
    const expiresMs =
      typeof expiresVal?.toMillis === "function"
        ? expiresVal.toMillis()
        : typeof expiresVal?.seconds === "number"
          ? expiresVal.seconds * 1000
          : new Date(expiresVal).getTime();
    return expiresMs > 0 ? Date.now() < expiresMs : true;
  }, [post.pinnedAt, post.pinExpiresAt]);

  const canEdit = authorUserId === currentUserId && !!onEdit;
  const canReport =
    canReportContent(currentUserRole, authorRole, post.isAnonymous === true) &&
    !isOwnPost;
  const canOpenOptions =
    (canPin && !!onTogglePin) ||
    (canDelete && !!onDelete) ||
    canEdit ||
    canReport;

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


  const openReportModal = () => {
    closePostActions();
    setShowReportModal(true);
  };

  const submitReport = async (reason: string) => {
    if (!reporterId) {
      setPendingReportReason(null);
      return;
    }

    if (!canReport) {
      setPendingReportReason(null);
      setReportFeedback({
        title: "Report unavailable",
        description: "This post cannot be reported.",
        destructive: true,
      });
      return;
    }

    setReportSubmitting(true);
    try {
      await addDoc(collection(db, "reports"), {
        reportedBy: reporterId,
        contentType: "post",
        contentId: post.id,
        reason,
        status: "pending",
        createdAt: serverTimestamp(),
      });

      setPendingReportReason(null);
      setReportFeedback({
        title: "Report sent",
        description: "Thank you. Your report has been sent to the moderation team for review.",
        destructive: false,
      });
    } catch (error) {
      console.error("Failed to report post:", error);
      setPendingReportReason(null);
      setReportFeedback({
        title: "Couldn't send report",
        description: "Please try again.",
        destructive: true,
      });
    } finally {
      setReportSubmitting(false);
    }
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

            {canReport && (
              <TouchableOpacity
                style={styles.actionMenuItem}
                activeOpacity={0.75}
                onPress={openReportModal}
              >
                <View style={styles.actionMenuItemIcon}>
                  <Ionicons name="flag-outline" size={20} color="#a61f1f" />
                </View>
                <Text style={[styles.actionMenuItemText, styles.reportActionText]}>
                  Report Post
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

      <Modal
        visible={showReportModal}
        transparent
        animationType="fade"
        onRequestClose={() => !reportSubmitting && setShowReportModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.reportModalContainer}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Report Post</Text>
                <Text style={styles.reportModalSubtitle}>
                  Why are you reporting this post?
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => !reportSubmitting && setShowReportModal(false)}
                disabled={reportSubmitting}
              >
                <Ionicons name="close-circle-outline" size={28} color="#a61f1f" />
              </TouchableOpacity>
            </View>

            {[
              ["harassment_or_bullying", "Harassment or bullying", "person-remove-outline"],
              ["hate_or_discrimination", "Hate or discrimination", "ban-outline"],
              ["sexual_or_explicit_content", "Sexual or explicit content", "warning-outline"],
              ["violence_or_threats", "Violence or threats", "alert-circle-outline"],
              ["spam_or_scam", "Spam or scam", "megaphone-outline"],
              ["other", "Other", "ellipsis-horizontal-circle-outline"],
            ].map(([value, label, icon]) => (
              <TouchableOpacity
                key={value}
                style={styles.reportReasonButton}
                onPress={() => {
                  setShowReportModal(false);
                  setPendingReportReason(value);
                }}
                disabled={reportSubmitting}
                activeOpacity={0.75}
              >
                <View style={styles.reportReasonIcon}>
                  <Ionicons
                    name={icon as keyof typeof Ionicons.glyphMap}
                    size={19}
                    color="#a61f1f"
                  />
                </View>
                <Text style={styles.reportReasonText}>{label}</Text>
                <Ionicons name="chevron-forward" size={18} color="#9b766c" />
              </TouchableOpacity>
            ))}

            {reportSubmitting && (
              <View style={styles.reportSubmitting}>
                <ActivityIndicator color="#e0a53d" />
                <Text style={styles.reportSubmittingText}>Submitting report...</Text>
              </View>
            )}
          </View>
        </View>
      </Modal>

      <ConfirmDialog
        visible={!!pendingReportReason}
        title="Send report?"
        description="This report will be sent to the moderation team for review."
        confirmText="Send report"
        destructive={true}
        loading={reportSubmitting}
        onConfirm={() => {
          if (pendingReportReason) {
            submitReport(pendingReportReason);
          }
        }}
        onCancel={() => setPendingReportReason(null)}
      />

      <ConfirmDialog
        visible={!!reportFeedback}
        title={reportFeedback?.title ?? ""}
        description={reportFeedback?.description}
        confirmText="Done"
        singleAction
        destructive={reportFeedback?.destructive ?? false}
        icon={reportFeedback?.destructive ? "alert-circle-outline" : "checkmark-circle-outline"}
        onConfirm={() => setReportFeedback(null)}
        onCancel={() => setReportFeedback(null)}
      />
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

  return (
    <View style={styles.filesContainer}>
      {files.map((file, idx) => {
        const displayName = file.name || getFileNameFromUrl(file.url);
        const details = getFileIconDetails(file.mimeType, displayName);
        return (
          <TouchableOpacity
            key={idx}
            style={styles.fileCard}
            onPress={() => onFilePress(file.url, file.mimeType)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={details.icon}
              size={18}
              color={details.color}
            />
            <Text style={styles.fileName} numberOfLines={1}>
              {displayName}
            </Text>
            <Ionicons name="download-outline" size={14} color="#956a5f" />
          </TouchableOpacity>
        );
      })}
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
  // Trailing divider only makes sense in the vertical feed; the trending
  // scroller wraps each card in its own bordered container.
  postCardCompact: {
    borderBottomWidth: 0,
    paddingVertical: 12,
  },
  compactMedia: {
    height: 150,
  },
  hangingLayout: { flexDirection: "row", overflow: "visible" },
  avatarColumn: { width: AVATAR_COLUMN_WIDTH, marginRight: AVATAR_COLUMN_GAP },
  contentColumn: { flex: 1, overflow: "visible" },

  postFlairBadge: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5, marginBottom: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 12, backgroundColor: "#f3ece8", borderWidth: 1, borderColor: "#e5d5cd" },
  postFlairBadgeOfficial: { backgroundColor: "#fff1cf", borderColor: "#e6c36f" },
  postFlairEmoji: { fontSize: 12 },
  postFlairText: { color: "#6d463c", fontSize: 11, fontWeight: "800" },
  postFlairTextOfficial: { color: "#7a5411" },
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
  reportActionText: { color: "#a61f1f" },
  reportModalContainer: {
    width: "88%",
    maxHeight: "80%",
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ead8cf",
    overflow: "hidden",
    paddingBottom: 8,
  },
  reportModalSubtitle: {
    color: "#8f6a60",
    fontSize: 13,
    marginTop: 3,
  },
  reportReasonButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderTopWidth: 1,
    borderTopColor: "#f0e3dc",
    gap: 12,
  },
  reportReasonIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#fff0ec",
    alignItems: "center",
    justifyContent: "center",
  },
  reportReasonText: {
    flex: 1,
    color: "#4f1c17",
    fontSize: 14,
    fontWeight: "600",
  },
  reportSubmitting: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
  },
  reportSubmittingText: {
    color: "#8f6a60",
    fontSize: 13,
  },

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
    width: DEFAULT_MEDIA_WIDTH,
    height: DEFAULT_MEDIA_WIDTH * 1.25,
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
    width: DEFAULT_MEDIA_WIDTH,
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

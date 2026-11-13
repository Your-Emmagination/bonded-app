import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { doc, getDoc } from "firebase/firestore";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import { showAppToast } from "@/utils/toastEvents";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import { canNavigateToTaggedUser } from "@/utils/taggedUsers";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { likePost } from "@/utils/likePost";
import { withViewerLike } from "@/utils/postLikes";
import ImageZoomViewer from "./components/ImageZoomViewer";
import CommentModal from "./components/CommentModal";
import PostCard from "./components/PostCard";
import { FeedSkeleton } from "./components/Skeleton";

type TargetParams = {
  notificationId?: string | string[];
  entityType?: string | string[];
  entityId?: string | string[];
  parentId?: string | string[];
  /** Opened from somewhere other than a notification, e.g. a live's replay. */
  origin?: string | string[];
};

type ResolvedTarget = {
  post: any;
  commentId?: string;
  replyId?: string;
};

const single = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const timeAgo = (timestamp: any) => {
  const createdAt = timestamp?.toDate?.();
  if (!createdAt) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return createdAt.toLocaleDateString();
};

export default function NotificationTargetScreen() {
  const { styles, theme } = useStyles();
  const params = useLocalSearchParams<TargetParams>();
  const router = useRouter();
  const currentUserRole = useCurrentUserRole();
  const [target, setTarget] = useState<ResolvedTarget | null>(null);
  // The comment/reply modal is rendered inline on this screen rather than as
  // its own route, so closing it must only hide it locally — it must NOT
  // call router.back(), which would pop this whole screen off the stack and
  // dump the user back on the Notifications list instead of leaving them
  // here on the underlying post. See commentModalVisible below.
  const [commentModalVisible, setCommentModalVisible] = useState(false);
  // Photos (and, in a post with several, videos) open fullscreen here too.
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null);
  // The post's video plays muted while this screen is showing, like on Home;
  // a tap opens it fullscreen with sound.
  const screenFocused = useIsFocused();

  // The post here was read once, so a like updates this copy straight away
  // and is put back if saving fails. Saved the way Home saves likes.
  const handleLike = useCallback(() => {
    const user = auth.currentUser;
    const post = target?.post;
    if (!user || !post) return;
    const liked = !(post.likedBy || []).includes(user.uid);
    setTarget((current) =>
      current ? { ...current, post: withViewerLike(current.post, user.uid, liked) } : current,
    );
    likePost(post, user, liked, (savedLiked) => {
      setTarget((current) =>
        current ? { ...current, post: withViewerLike(current.post, user.uid, savedLiked) } : current,
      );
      showAppToast({ message: "Couldn't save your like. Try again." });
    });
  }, [target?.post]);

  const entityType = single(params.entityType);
  const entityId = single(params.entityId);
  const parentId = single(params.parentId);
  const fromLiveReplay = single(params.origin) === "live-replay";

  const openProfile = useCallback(
    (userId?: string) => {
      if (!userId) return;
      // PostCard already resolves anonymous/profile-document identities into
      // a complete profile href. Do not wrap that href as though it were a uid.
      if (userId === "/UserProfileScreen" || userId.startsWith("/UserProfileScreen?") || userId.startsWith("/(main)/UserProfileScreen?")) {
        router.push(userId as any);
        return;
      }
      if (userId === "self" || userId === auth.currentUser?.uid) {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo: "/(main)/NotificationTargetScreen" },
        });
        return;
      }
      router.push(
        buildUserProfileHref({
          userId,
          returnTo: "/(main)/NotificationTargetScreen",
        }) as any,
      );
    },
    [router],
  );
  const openTagProfile = useCallback(
    (userId: string) => {
      if (canNavigateToTaggedUser(userId)) openProfile(userId);
    },
    [openProfile],
  );

  useEffect(() => {
    let cancelled = false;

    const resolveTarget = async () => {
      if (!entityType || !entityId) {
        router.replace({
          pathname: "/(main)/(tabs)/NotificationsScreen",
          params: { unavailable: String(Date.now()) },
        });
        return;
      }

      try {
        let postId: string | undefined;
        let commentId: string | undefined;
        let replyId: string | undefined;

        if (entityType === "direct_message" && parentId) {
          router.replace({ pathname: "/(main)/DirectChatScreen", params: { conversationId: parentId } });
          return;
        } else if (entityType === "post") {
          postId = entityId;
        } else if (entityType === "comment") {
          const commentSnap = await getDoc(doc(db, "comments", entityId));
          if (commentSnap.exists()) {
            commentId = entityId;
            postId = String(commentSnap.data()?.postId || parentId || "") || undefined;
          } else {
            const messageSnap = await getDoc(doc(db, "communityThreadMessages", entityId));
            if (messageSnap.exists()) {
              const message = messageSnap.data();
              if (message.serverId && message.channelId) {
                router.replace({
                  pathname: "/ServerChannelScreen",
                  params: {
                    serverId: String(message.serverId),
                    channelId: String(message.channelId),
                    messageId: entityId,
                  },
                });
                return;
              }
            }
          }
        } else if (entityType === "reply") {
          const replySnap = await getDoc(doc(db, "replies", entityId));
          if (replySnap.exists()) {
            replyId = entityId;
            commentId =
              String(replySnap.data()?.commentId || parentId || "") || undefined;
            if (commentId) {
              const commentSnap = await getDoc(doc(db, "comments", commentId));
              if (commentSnap.exists()) {
                postId = String(commentSnap.data()?.postId || "") || undefined;
              }
            }
          }
        }

        if (!postId) throw new Error("missing-post");
        const postSnap = await getDoc(doc(db, "posts", postId));
        if (!postSnap.exists()) throw new Error("missing-post");
        if (cancelled) return;

        setTarget({
          post: {
            id: postSnap.id,
            likeCount: 0,
            commentCount: 0,
            likedBy: [],
            ...postSnap.data(),
          },
          commentId,
          replyId,
        });
        if (commentId) setCommentModalVisible(true);
      } catch (resolveError) {
        if (
          !(resolveError instanceof Error) ||
          resolveError.message !== "missing-post"
        ) {
          console.warn("Unable to resolve notification destination:", resolveError);
        }
        if (!cancelled) {
          if (fromLiveReplay) {
            // A replay that was removed: back to the live it came from.
            showAppToast({ message: "This replay is no longer available." });
            router.back();
            return;
          }
          router.replace({
            pathname: "/(main)/(tabs)/NotificationsScreen",
            params: { unavailable: String(Date.now()) },
          });
        }
      }
    };

    void resolveTarget();
    return () => {
      cancelled = true;
    };
  }, [entityId, entityType, fromLiveReplay, parentId, router]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} hitSlop={8}>
          <Ionicons name="arrow-back" size={23} color={theme.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{fromLiveReplay ? "Live replay" : "Notification"}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {!target ? (
        // The post's own shape, where the post will appear.
        <FeedSkeleton count={1} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          // The comment sheet opens from inside this post; left at "never",
          // the first tap on Send only closed the keyboard.
          keyboardShouldPersistTaps="handled"
        >
          <PostCard
            post={target.post}
            isLiked={target.post.likedBy?.includes(auth.currentUser?.uid || "") || false}
            isHighlighted
            currentUserId={auth.currentUser?.uid}
            currentUserRole={currentUserRole}
            onLike={handleLike}
            onProfileClick={openProfile}
            onTagClick={openTagProfile}
            onImagePress={(images, index) => setViewer({ images, index })}
            onFilePress={(url) => void Linking.openURL(url)}
            getTimeAgo={timeAgo}
            videoCardVisible={screenFocused && !viewer}
          />
        </ScrollView>
      )}

      {target?.commentId ? (
        <CommentModal
          visible={commentModalVisible}
          onClose={() => setCommentModalVisible(false)}
          postId={target.post.id}
          currentUserId={auth.currentUser?.uid}
          initialCommentId={target.commentId}
          initialReplyId={target.replyId || null}
          autoOpenReplyThread={Boolean(target.replyId)}
        />
      ) : null}
      <ImageZoomViewer
        images={viewer?.images ?? []}
        startIndex={viewer?.index ?? 0}
        visible={!!viewer}
        onClose={() => setViewer(null)}
        showActions={false}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceSunken },
  header: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5cfc5",
    paddingHorizontal: 12,
    backgroundColor: c.surface,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  backButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 18, fontWeight: "700", color: c.primary },
  headerSpacer: { width: 42 },
  content: { padding: 12, paddingBottom: 32 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  loadingCard: {
    alignItems: "center",
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.borderStrong,
    paddingVertical: 32,
    paddingHorizontal: 20,
    width: "100%",
    maxWidth: 320,
  },
  loadingText: { marginTop: 12, color: "#805e56", fontSize: 15, fontWeight: "600" },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

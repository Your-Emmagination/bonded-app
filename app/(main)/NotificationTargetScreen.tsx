import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { doc, getDoc } from "firebase/firestore";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import CommentModal from "./components/CommentModal";
import PostCard from "./components/PostCard";

type TargetParams = {
  notificationId?: string | string[];
  entityType?: string | string[];
  entityId?: string | string[];
  parentId?: string | string[];
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
  const [target, setTarget] = useState<ResolvedTarget | null>(null);
  // The comment/reply modal is rendered inline on this screen rather than as
  // its own route, so closing it must only hide it locally — it must NOT
  // call router.back(), which would pop this whole screen off the stack and
  // dump the user back on the Notifications list instead of leaving them
  // here on the underlying post. See commentModalVisible below.
  const [commentModalVisible, setCommentModalVisible] = useState(false);

  const entityType = single(params.entityType);
  const entityId = single(params.entityId);
  const parentId = single(params.parentId);

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
  }, [entityId, entityType, parentId, router]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} hitSlop={8}>
          <Ionicons name="arrow-back" size={23} color={theme.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notification</Text>
        <View style={styles.headerSpacer} />
      </View>

      {!target ? (
        <View style={styles.center}>
          <View style={styles.loadingCard}>
            <ActivityIndicator size="large" color={theme.textSecondary} />
            <Text style={styles.loadingText}>Opening content…</Text>
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.contextBanner}>
            <View style={styles.contextIconCircle}>
              <Ionicons
                name={target.replyId ? "return-up-back-outline" : target.commentId ? "chatbubble-outline" : "document-text-outline"}
                size={16}
                color={theme.textSecondary}
              />
            </View>
            <Text style={styles.contextBannerText}>
              {target.replyId
                ? "Jumped here from a reply notification"
                : target.commentId
                  ? "Jumped here from a comment notification"
                  : "Jumped here from a notification"}
            </Text>
          </View>

          <PostCard
            post={target.post}
            isLiked={target.post.likedBy?.includes(auth.currentUser?.uid || "") || false}
            isHighlighted
            currentUserId={auth.currentUser?.uid}
            onLike={() => undefined}
            onProfileClick={() => undefined}
            onTagClick={() => undefined}
            onImagePress={() => undefined}
            onFilePress={(url) => void Linking.openURL(url)}
            getTimeAgo={timeAgo}
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
  contextBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  contextIconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#fce3d6",
    alignItems: "center",
    justifyContent: "center",
  },
  contextBannerText: { flex: 1, color: c.textSecondary, fontSize: 13, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  loadingCard: {
    alignItems: "center",
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.borderStrong,
    paddingVertical: 32,
    paddingHorizontal: 28,
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

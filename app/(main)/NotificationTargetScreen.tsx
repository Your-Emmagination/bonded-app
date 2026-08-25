import { Ionicons } from "@expo/vector-icons";
import { doc, getDoc } from "firebase/firestore";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
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
  const params = useLocalSearchParams<TargetParams>();
  const router = useRouter();
  const [target, setTarget] = useState<ResolvedTarget | null>(null);

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

        if (entityType === "post") {
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
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={23} color="#5f0909" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notification</Text>
        <View style={styles.headerSpacer} />
      </View>

      {!target ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#8f3a2b" />
          <Text style={styles.loadingText}>Opening content…</Text>
        </View>
      ) : target ? (
        <ScrollView contentContainerStyle={styles.content}>
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
      ) : null}

      {target?.commentId ? (
        <CommentModal
          visible
          onClose={() => router.back()}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f6f1ed" },
  header: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5cfc5",
    paddingHorizontal: 12,
    backgroundColor: "#fffaf7",
  },
  backButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 18, fontWeight: "700", color: "#5f0909" },
  headerSpacer: { width: 42 },
  content: { padding: 12, paddingBottom: 32 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  loadingText: { marginTop: 12, color: "#805e56", fontSize: 15 },
});

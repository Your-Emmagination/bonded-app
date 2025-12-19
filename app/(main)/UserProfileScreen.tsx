// UserProfileScreen.tsx - FIXED ALL TS ERRORS + Tappable Profile Pic + Accurate Online Status
import { Ionicons } from "@expo/vector-icons";
import {
  doc,
  collection,
  query,
  where,
  onSnapshot,
  orderBy,
} from "firebase/firestore";
import React, { useEffect, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Image,
  ActivityIndicator,
  Modal,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { db } from "../../Firebase_configure";
import { useRouter, useLocalSearchParams } from "expo-router";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

type Student = {
  firstname?: string;
  lastname?: string;
  course?: string;
  yearlvl?: string;
  studentID?: string;
  email?: string;
  profileImage?: string;
  isOnline?: boolean;
  role?: string;
};

type Post = {
  id: string;
  content?: string;
  imageUrl?: string;
  username?: string;
  userId?: string;
  createdAt?: any;
  likeCount?: number;
  commentCount?: number;
};

type Poll = {
  id: string;
  question: string;
  options: { text: string; votes: number }[];
  totalVotes: number;
  userId: string;
  username: string;
  createdAt: any;
};

const UserProfileScreen = () => {
  const { userId } = useLocalSearchParams();
  const [student, setStudent] = useState<Student | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [polls, setPolls] = useState<Poll[]>([]);
  const [loading, setLoading] = useState(true);

  // Image viewer modal
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [currentImage, setCurrentImage] = useState<string>("");

  const router = useRouter();

  useEffect(() => {
    if (userId === undefined) return;
    if (typeof userId !== "string" || !userId) {
      router.back();
      return;
    }

    const unsubscribeProfile = onSnapshot(
      doc(db, "students", userId),
      (docSnapshot) => {
        if (docSnapshot.exists()) {
          const data = docSnapshot.data() as Student;
          setStudent(data);
        } else {
          setStudent(null);
        }
        setLoading(false);
      },
      (error) => {
        console.error("Error listening to user profile:", error);
        setLoading(false);
      }
    );

    const unsubscribePosts = fetchUserPosts(userId);
    const unsubscribePolls = fetchUserPolls(userId);

    return () => {
      unsubscribeProfile();
      unsubscribePosts?.();
      unsubscribePolls?.();
    };
  }, [userId, router]);

  const fetchUserPosts = (uid: string) => {
    const q = query(
      collection(db, "posts"),
      where("userId", "==", uid),
      orderBy("createdAt", "desc")
    );
    return onSnapshot(
      q,
      (snapshot) => {
        const userPosts = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Post[];
        setPosts(userPosts);
      },
      (error) => console.error("Error listening to user posts:", error)
    );
  };

  const fetchUserPolls = (uid: string) => {
    const q = query(
      collection(db, "polls"),
      where("userId", "==", uid),
      orderBy("createdAt", "desc")
    );
    return onSnapshot(
      q,
      (snapshot) => {
        const userPolls = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Poll[];
        setPolls(userPolls);
      },
      (error) => console.error("Error listening to user polls:", error)
    );
  };

  const getTimeAgo = (timestamp: any) => {
    if (!timestamp || !timestamp.toDate) return "";
    const now = new Date();
    const postDate = timestamp.toDate();
    const diffMs = now.getTime() - postDate.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;

    return postDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: postDate.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  };

  const openImageViewer = (imageUrl: string) => {
    setCurrentImage(imageUrl);
    setImageViewerVisible(true);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator size="large" color="#ff5c93" style={{ marginTop: 50 }} />
      </SafeAreaView>
    );
  }

  if (!student) {
    return (
      <SafeAreaView style={styles.container}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#ff5c93" />
        </TouchableOpacity>
        <Text style={styles.errorText}>User not found</Text>
      </SafeAreaView>
    );
  }

  const fullName = `${student.firstname || ""} ${student.lastname || ""}`.trim() || "Anonymous";

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#ff5c93" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{fullName}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.profileCard}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => student.profileImage && openImageViewer(student.profileImage)}
          >
            <View style={styles.profileImageContainer}>
              {student.profileImage ? (
                <Image source={{ uri: student.profileImage }} style={styles.profileImage} />
              ) : (
                <View style={styles.placeholder}>
                  <Ionicons name="person" size={50} color="#ff5c93" />
                </View>
              )}
              {/* Online Status Badge */}
              <View
                style={[
                  styles.statusBadge,
                  { backgroundColor: student.isOnline ? "#2ecc71" : "#888" },
                ]}
              />
            </View>
          </TouchableOpacity>

          <Text style={styles.name}>{fullName}</Text>

          <View style={styles.statusContainer}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: student.isOnline ? "#2ecc71" : "#888" },
              ]}
            />
            <Text style={[styles.status, { color: student.isOnline ? "#2ecc71" : "#888" }]}>
              {student.isOnline ? "Online" : "Offline"}
            </Text>
          </View>
        </View>

        {student.role !== "admin" && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Information</Text>

            <View style={styles.infoCard}>
              <Ionicons name="school-outline" size={20} color="#ff5c93" />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={styles.infoLabel}>Course</Text>
                <Text style={styles.infoValue}>{student.course || "—"}</Text>
              </View>
            </View>

            <View style={styles.infoCard}>
              <Ionicons name="trending-up-outline" size={20} color="#ff5c93" />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={styles.infoLabel}>Year Level</Text>
                <Text style={styles.infoValue}>{student.yearlvl || "—"}</Text>
              </View>
            </View>

            <View style={styles.infoCard}>
              <Ionicons name="card-outline" size={20} color="#ff5c93" />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={styles.infoLabel}>Student ID</Text>
                <Text style={styles.infoValue}>{student.studentID || "—"}</Text>
              </View>
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Posts ({posts.length})</Text>
          {posts.length === 0 ? (
            <Text style={styles.emptyText}>No posts yet</Text>
          ) : (
            posts.map((post) => (
              <View key={post.id} style={styles.postCard}>
                <Text style={styles.postContent}>{post.content || ""}</Text>
                {post.imageUrl && (
                  <TouchableOpacity onPress={() => openImageViewer(post.imageUrl!)}>
                    <Image source={{ uri: post.imageUrl }} style={styles.postImage} resizeMode="cover" />
                  </TouchableOpacity>
                )}
                <View style={styles.postFooter}>
                  <Text style={styles.postTime}>{getTimeAgo(post.createdAt)}</Text>
                  <View style={styles.postStats}>
                    <View style={styles.statItem}>
                      <Ionicons name="heart" size={14} color="#ff5c93" />
                      <Text style={styles.statText}>{post.likeCount || 0}</Text>
                    </View>
                    <View style={styles.statItem}>
                      <Ionicons name="chatbubble" size={14} color="#888" />
                      <Text style={styles.statText}>{post.commentCount || 0}</Text>
                    </View>
                  </View>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Polls ({polls.length})</Text>
          {polls.length === 0 ? (
            <Text style={styles.emptyText}>No polls yet</Text>
          ) : (
            polls.map((poll) => (
              <View key={poll.id} style={styles.pollCard}>
                <Text style={styles.pollQuestion}>{poll.question}</Text>
                {poll.options.slice(0, 3).map((opt, idx) => (
                  <Text key={idx} style={styles.pollOption}>
                    • {opt.text} ({opt.votes} votes)
                  </Text>
                ))}
                {poll.options.length > 3 && (
                  <Text style={styles.moreOptions}>+{poll.options.length - 3} more options</Text>
                )}
                <Text style={styles.pollTime}>{getTimeAgo(poll.createdAt)}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {/* Fullscreen Image Viewer Modal */}
      <Modal
        visible={imageViewerVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setImageViewerVisible(false)}
      >
        <View style={styles.imageViewerOverlay}>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => setImageViewerVisible(false)}
          >
            <Ionicons name="close" size={32} color="#fff" />
          </TouchableOpacity>
          <Image
            source={{ uri: currentImage }}
            style={styles.fullscreenImage}
            resizeMode="contain"
          />
        </View>
      </Modal>
    </SafeAreaView>
  );
};

export default UserProfileScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0e1320",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#1b2235",
  },
  headerTitle: {
    color: "#b8c7ff",
    fontSize: 18,
    fontWeight: "bold",
  },
  backButton: {
    padding: 8,
  },
  errorText: {
    color: "#888",
    textAlign: "center",
    marginTop: 50,
    fontSize: 16,
  },
  profileCard: {
    alignItems: "center",
    backgroundColor: "#1b2235",
    margin: 16,
    padding: 24,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,92,147,0.15)",
  },
  profileImageContainer: {
    position: "relative",
    marginBottom: 16,
  },
  profileImage: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 4,
    borderColor: "#ff5c93",
  },
  placeholder: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: "#ff5c93",
  },
  statusBadge: {
    position: "absolute",
    bottom: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 3,
    borderColor: "#1b2235",
  },
  name: {
    color: "#fff",
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 8,
  },
  statusContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  status: {
    fontSize: 15,
    fontWeight: "600",
  },
  section: {
    marginHorizontal: 16,
    marginBottom: 24,
  },
  sectionTitle: {
    color: "#ff5c93",
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 12,
  },
  infoCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    backgroundColor: "#1b2235",
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(255,92,147,0.1)",
  },
  infoLabel: {
    color: "#888",
    fontSize: 13,
  },
  infoValue: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "500",
    marginTop: 4,
  },
  postCard: {
    backgroundColor: "#1b2235",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255,92,147,0.08)",
  },
  postContent: {
    color: "#e4e6eb",
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
  },
  postImage: {
    width: "100%",
    height: 220,
    borderRadius: 12,
    marginBottom: 12,
  },
  postFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#243054",
  },
  postTime: {
    color: "#888",
    fontSize: 13,
  },
  postStats: {
    flexDirection: "row",
    gap: 16,
  },
  statItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statText: {
    color: "#888",
    fontSize: 13,
  },
  emptyText: {
    color: "#888",
    textAlign: "center",
    marginTop: 30,
    fontSize: 15,
  },
  pollCard: {
    backgroundColor: "#1b2235",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255,92,147,0.15)",
  },
  pollQuestion: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 10,
  },
  pollOption: {
    color: "#ccc",
    fontSize: 14,
    marginVertical: 3,
    marginLeft: 4,
  },
  moreOptions: {
    color: "#ff5c93",
    fontSize: 13,
    marginTop: 6,
    fontStyle: "italic",
  },
  pollTime: {
    color: "#888",
    fontSize: 12,
    marginTop: 10,
    textAlign: "right",
  },
  imageViewerOverlay: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  closeButton: {
    position: "absolute",
    top: 50,
    right: 20,
    zIndex: 10,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 20,
    padding: 8,
  },
  fullscreenImage: {
    width: SCREEN_WIDTH,
    maxWidth: "100%",
    maxHeight: "90%",
  },
});
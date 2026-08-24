// UserProfileScreen.tsx 
import { Ionicons } from "@expo/vector-icons";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query as firestoreQuery,
  query,
  where,
  onSnapshot,
  orderBy,
  startAfter,
  or,
} from "firebase/firestore";
import React, { useEffect, useState } from "react";
import { AVATAR_SIZE_LARGE, FEED_IMAGE_WIDTH, avatarThumb, feedImage } from "@/utils/cloudinaryImages";
import {
  BackHandler,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Image,
  ActivityIndicator,
} from "react-native";
import { Image as ExpoImage } from "expo-image";
import { useNavigation } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { db } from "../../Firebase_configure";
import { useRouter, useLocalSearchParams } from "expo-router";
import { resolveAvatarUri } from "@/utils/avatar";
import { getProfileIdLabel } from "@/utils/profileLabels";
import { peekUserData, type UserData } from "@/utils/rbac";
import ImageZoomViewer from "./components/ImageZoomViewer";
import { useRelativeTimeNow } from "@/utils/relativeTime";

type Student = {
  id?: string;
  userId?: string;
  firstname?: string;
  lastname?: string;
  course?: string;
  yearlvl?: string;
  studentID?: string;
  email?: string;
  profileImage?: string;
  profilePic?: string | null;
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

const buildStudentPreview = (
  profile: UserData | null | undefined,
): Student | null => {
  if (!profile) return null;

  return {
    userId: profile.userId,
    firstname: profile.firstname,
    lastname: profile.lastname,
    course: profile.course,
    yearlvl: profile.yearlvl,
    studentID: profile.studentID,
    email: profile.email,
    profileImage: profile.profileImage || undefined,
    isOnline: profile.isOnline,
    role: profile.role,
  };
};

const UserProfileScreen = () => {
  const { userId, profileDocId, returnTo } = useLocalSearchParams();
  const relativeTimeNow = useRelativeTimeNow();
  const navigation = useNavigation();
  const initialStudentPreview =
    buildStudentPreview(
      peekUserData(
        typeof profileDocId === "string"
          ? profileDocId
          : typeof userId === "string"
            ? userId
            : null,
      ),
    ) ||
    buildStudentPreview(
      peekUserData(
        typeof userId === "string"
          ? userId
          : typeof profileDocId === "string"
            ? profileDocId
            : null,
      ),
    );
  const [student, setStudent] = useState<Student | null>(initialStudentPreview);
  const [posts, setPosts] = useState<Post[]>([]);
  const [polls, setPolls] = useState<Poll[]>([]);
  const [loading, setLoading] = useState(!initialStudentPreview);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);
  const [loadingMorePolls, setLoadingMorePolls] = useState(false);
  const [hasMorePosts, setHasMorePosts] = useState(true);
  const [hasMorePolls, setHasMorePolls] = useState(true);
  const lastPostDocRef = React.useRef<any>(null);
  const lastPollDocRef = React.useRef<any>(null);
  const loadedPostIdsRef = React.useRef<Set<string>>(new Set());
  const loadedPollIdsRef = React.useRef<Set<string>>(new Set());

  // Image viewer modal
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [currentImage, setCurrentImage] = useState<string>("");

  const router = useRouter();
  const navigateBack = React.useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }

    const nextReturnTo = typeof returnTo === "string" ? returnTo : null;
    if (nextReturnTo) {
      router.replace(nextReturnTo as any);
      return;
    }
    router.back();
  }, [navigation, returnTo, router]);

  const getStudentScore = (candidate: Student & { id: string }) => {
    let score = 0;
    if (resolveAvatarUri(candidate)) score += 8;
    if (candidate.firstname) score += 2;
    if (candidate.lastname) score += 2;
    if (candidate.course) score += 1;
    if (candidate.yearlvl) score += 1;
    if (candidate.studentID && candidate.studentID === candidate.id) score += 4;
    if (candidate.userId && typeof userId === "string" && candidate.userId === userId) score += 3;
    return score;
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (imageViewerVisible) {
        setImageViewerVisible(false);
        return true;
      }

      navigateBack();
      return true;
    });

    return () => subscription.remove();
  }, [imageViewerVisible, navigateBack]);

  useEffect(() => {
    const resolvedUserId = typeof userId === "string" ? userId : null;
    const resolvedProfileDocId = typeof profileDocId === "string" ? profileDocId : null;
    const cachedPreview =
      buildStudentPreview(peekUserData(resolvedProfileDocId || resolvedUserId)) ||
      buildStudentPreview(peekUserData(resolvedUserId || resolvedProfileDocId));

    if (userId === undefined && profileDocId === undefined) return;
    if (!resolvedUserId && !resolvedProfileDocId) {
      navigateBack();
      return;
    }

    if (cachedPreview) {
      setStudent(cachedPreview);
      setLoading(false);
    } else {
      setLoading(true);
    }

    let active = true;
    let unsubscribeProfile: (() => void) | null = null;
    const identityKey = resolvedUserId || resolvedProfileDocId || "";
    lastPostDocRef.current = null;
    lastPollDocRef.current = null;
    loadedPostIdsRef.current.clear();
    loadedPollIdsRef.current.clear();
    setHasMorePosts(true);
    setHasMorePolls(true);
    void fetchUserPosts(identityKey);
    void fetchUserPolls(identityKey);

    const resolveProfileDocId = async () => {
      const candidates: Array<Student & { id: string }> = [];
      const seen = new Set<string>();

      const addCandidate = (docId: string, data: Student) => {
        if (seen.has(docId)) return;
        seen.add(docId);
        candidates.push({ id: docId, ...data });
      };

      const loadCandidateDoc = async (docId?: string | null) => {
        if (!docId || seen.has(docId)) return;
        const candidateDoc = await getDoc(doc(db, "students", docId));
        if (candidateDoc.exists()) {
          addCandidate(candidateDoc.id, candidateDoc.data() as Student);
        }
      };

      if (resolvedProfileDocId) {
        await loadCandidateDoc(resolvedProfileDocId);
      }

      if (resolvedUserId) {
        const directDoc = await getDoc(doc(db, "students", resolvedUserId));
        if (directDoc.exists()) {
          addCandidate(directDoc.id, directDoc.data() as Student);
        }
      }

      const fallbackQueries = [];
      if (resolvedUserId) {
        fallbackQueries.push(
          firestoreQuery(
            collection(db, "students"),
            where("userId", "==", resolvedUserId),
            limit(5),
          ),
        );
        fallbackQueries.push(
          firestoreQuery(
            collection(db, "students"),
            where("studentID", "==", resolvedUserId),
            limit(5),
          ),
        );
      }
      if (resolvedProfileDocId && resolvedProfileDocId !== resolvedUserId) {
        fallbackQueries.push(
          firestoreQuery(
            collection(db, "students"),
            where("studentID", "==", resolvedProfileDocId),
            limit(5),
          ),
        );
      }

      for (const profileQuery of fallbackQueries) {
        const snapshot = await getDocs(profileQuery);
        snapshot.docs.forEach((studentDoc) => {
          addCandidate(studentDoc.id, studentDoc.data() as Student);
        });
      }

      for (const candidate of [...candidates]) {
        if (candidate.studentID && candidate.studentID !== candidate.id) {
          await loadCandidateDoc(candidate.studentID);
        }

        const emailPrefix = candidate.email?.split("@")[0]?.trim();
        if (emailPrefix && emailPrefix !== candidate.id) {
          await loadCandidateDoc(emailPrefix);
        }
      }

      if (candidates.length === 0) {
        return null;
      }

      candidates.sort((first, second) => getStudentScore(second) - getStudentScore(first));
      return candidates[0].id;
    };

    void resolveProfileDocId()
      .then((resolvedProfileId) => {
        if (!active) return;

        if (!resolvedProfileId) {
          setStudent(null);
          setLoading(false);
          return;
        }

        unsubscribeProfile = onSnapshot(
          doc(db, "students", resolvedProfileId),
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
          },
        );
      })
      .catch((error) => {
        console.error("Error resolving user profile:", error);
        if (active) {
          setStudent(null);
          setLoading(false);
        }
      });

    return () => {
      active = false;
      unsubscribeProfile?.();
    };
  }, [navigateBack, profileDocId, userId]);

  const fetchUserPosts = async (uid: string) => {
    try {
      const q = query(
        collection(db, "posts"),
        or(where("realUserId", "==", uid), where("userId", "==", uid)),
        orderBy("createdAt", "desc"),
        limit(20),
      );
      const snapshot = await getDocs(q);
      const userPosts = snapshot.docs.map((item) => ({
        id: item.id,
        ...item.data(),
      })) as Post[];
      loadedPostIdsRef.current = new Set(snapshot.docs.map((item) => item.id));
      lastPostDocRef.current = snapshot.docs[snapshot.docs.length - 1] ?? null;
      setHasMorePosts(snapshot.size === 20);
      setPosts(userPosts);
    } catch (error) {
      console.error("Error fetching user posts:", error);
      setPosts([]);
      setHasMorePosts(false);
    }
  };

  const fetchUserPolls = async (uid: string) => {
    try {
      const q = query(
        collection(db, "polls"),
        or(where("realUserId", "==", uid), where("userId", "==", uid)),
        orderBy("createdAt", "desc"),
        limit(20),
      );
      const snapshot = await getDocs(q);
      const userPolls = snapshot.docs.map((item) => ({
        id: item.id,
        ...item.data(),
      })) as Poll[];
      loadedPollIdsRef.current = new Set(snapshot.docs.map((item) => item.id));
      lastPollDocRef.current = snapshot.docs[snapshot.docs.length - 1] ?? null;
      setHasMorePolls(snapshot.size === 20);
      setPolls(userPolls);
    } catch (error) {
      console.error("Error fetching user polls:", error);
      setPolls([]);
      setHasMorePolls(false);
    }
  };

  const loadMorePosts = async (uid: string) => {
    if (loadingMorePosts || !hasMorePosts || !lastPostDocRef.current) return;
    setLoadingMorePosts(true);
    try {
      const q = query(
        collection(db, "posts"),
        or(where("realUserId", "==", uid), where("userId", "==", uid)),
        orderBy("createdAt", "desc"),
        startAfter(lastPostDocRef.current),
        limit(20),
      );
      const snapshot = await getDocs(q);
      const morePosts = snapshot.docs
        .filter((item) => !loadedPostIdsRef.current.has(item.id))
        .map((item) => ({ id: item.id, ...item.data() })) as Post[];
      snapshot.docs.forEach((item) => loadedPostIdsRef.current.add(item.id));
      lastPostDocRef.current = snapshot.docs[snapshot.docs.length - 1] ?? lastPostDocRef.current;
      setHasMorePosts(snapshot.size === 20);
      if (morePosts.length) setPosts((prev) => [...prev, ...morePosts]);
    } catch (error) {
      console.error("Error loading more user posts:", error);
    } finally {
      setLoadingMorePosts(false);
    }
  };

  const loadMorePolls = async (uid: string) => {
    if (loadingMorePolls || !hasMorePolls || !lastPollDocRef.current) return;
    setLoadingMorePolls(true);
    try {
      const q = query(
        collection(db, "polls"),
        or(where("realUserId", "==", uid), where("userId", "==", uid)),
        orderBy("createdAt", "desc"),
        startAfter(lastPollDocRef.current),
        limit(20),
      );
      const snapshot = await getDocs(q);
      const morePolls = snapshot.docs
        .filter((item) => !loadedPollIdsRef.current.has(item.id))
        .map((item) => ({ id: item.id, ...item.data() })) as Poll[];
      snapshot.docs.forEach((item) => loadedPollIdsRef.current.add(item.id));
      lastPollDocRef.current = snapshot.docs[snapshot.docs.length - 1] ?? lastPollDocRef.current;
      setHasMorePolls(snapshot.size === 20);
      if (morePolls.length) setPolls((prev) => [...prev, ...morePolls]);
    } catch (error) {
      console.error("Error loading more user polls:", error);
    } finally {
      setLoadingMorePolls(false);
    }
  };

  const getTimeAgo = (timestamp: any) => {
    if (!timestamp || !timestamp.toDate) return "";
    const now = new Date(relativeTimeNow);
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

  if (loading && !student) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.contentShell}>
          <View style={styles.header}>
            <TouchableOpacity onPress={navigateBack}>
              <Ionicons name="arrow-back" size={24} color="#e0a53d" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Profile</Text>
            <View style={{ width: 24 }} />
          </View>
          <View style={styles.loadingState}>
            <ActivityIndicator size="large" color="#e0a53d" />
            <Text style={styles.loadingText}>Loading profile...</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!student) {
    return (
      <SafeAreaView style={styles.container}>
        <TouchableOpacity onPress={navigateBack} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#e0a53d" />
        </TouchableOpacity>
        <Text style={styles.errorText}>User not found</Text>
      </SafeAreaView>
    );
  }

  const profileImageUri = resolveAvatarUri(student) || "";
  const fullName = `${student.firstname || ""} ${student.lastname || ""}`.trim() || "Anonymous";
  const profileIdLabel = getProfileIdLabel(student.role);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
      <View style={styles.header}>
        <TouchableOpacity onPress={navigateBack}>
          <Ionicons name="arrow-back" size={24} color="#e0a53d" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{fullName}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.profileCard}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => profileImageUri && openImageViewer(profileImageUri)}
          >
            <View style={styles.profileImageContainer}>
              {profileImageUri ? (
                <ExpoImage source={{ uri: avatarThumb(profileImageUri, AVATAR_SIZE_LARGE) }} style={styles.profileImage} contentFit="cover" />
              ) : (
                <View style={styles.placeholder}>
                  <Ionicons name="person" size={50} color="#e0a53d" />
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

        <View style={styles.section}>
            <Text style={styles.sectionTitle}>Information</Text>

            <View style={styles.infoCard}>
              <Ionicons name="school-outline" size={20} color="#e0a53d" />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={styles.infoLabel}>Course</Text>
                <Text style={styles.infoValue}>{student.course || "—"}</Text>
              </View>
            </View>

            <View style={styles.infoCard}>
              <Ionicons name="trending-up-outline" size={20} color="#e0a53d" />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={styles.infoLabel}>Year Level</Text>
                <Text style={styles.infoValue}>{student.yearlvl || "—"}</Text>
              </View>
            </View>

            <View style={styles.infoCard}>
              <Ionicons name="card-outline" size={20} color="#e0a53d" />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={styles.infoLabel}>{profileIdLabel}</Text>
                <Text style={styles.infoValue}>{student.studentID || "—"}</Text>
              </View>
            </View>
          </View>

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
                    <Image source={{ uri: feedImage(post.imageUrl, FEED_IMAGE_WIDTH) }} style={styles.postImage} resizeMode="cover" />
                  </TouchableOpacity>
                )}
                <View style={styles.postFooter}>
                  <Text style={styles.postTime}>{getTimeAgo(post.createdAt)}</Text>
                  <View style={styles.postStats}>
                    <View style={styles.statItem}>
                      <Ionicons name="heart" size={14} color="#e0a53d" />
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
          {hasMorePosts && posts.length > 0 && (
            <TouchableOpacity
              style={styles.loadMoreButton}
              onPress={() => {
                const uid = typeof userId === "string" ? userId : typeof profileDocId === "string" ? profileDocId : "";
                if (uid) void loadMorePosts(uid);
              }}
              disabled={loadingMorePosts}
            >
              {loadingMorePosts ? <ActivityIndicator size="small" /> : <Text style={styles.loadMoreText}>Load more posts</Text>}
            </TouchableOpacity>
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
          {hasMorePolls && polls.length > 0 && (
            <TouchableOpacity
              style={styles.loadMoreButton}
              onPress={() => {
                const uid = typeof userId === "string" ? userId : typeof profileDocId === "string" ? profileDocId : "";
                if (uid) void loadMorePolls(uid);
              }}
              disabled={loadingMorePolls}
            >
              {loadingMorePolls ? <ActivityIndicator size="small" /> : <Text style={styles.loadMoreText}>Load more polls</Text>}
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {/* Fullscreen Image Viewer Modal */}
      <ImageZoomViewer
        images={currentImage ? [currentImage] : []}
        startIndex={0}
        visible={imageViewerVisible}
        onClose={() => setImageViewerVisible(false)}
        showActions={false}
      />
      </View>
    </SafeAreaView>
  );
};

export default UserProfileScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f6f1ed",
  },
  contentShell: {
    flex: 1,
    backgroundColor: "#f6f1ed",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#fffaf7",
  },
  headerTitle: {
    color: "#7a3b2e",
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
  loadingState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: {
    color: "#8f6a60",
    fontSize: 14,
    fontWeight: "600",
  },
  profileCard: {
    alignItems: "center",
    backgroundColor: "#fffaf7",
    margin: 16,
    padding: 24,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.18)",
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
    borderColor: "#e0a53d",
  },
  placeholder: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "#f0e7e2",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: "#e0a53d",
  },
  statusBadge: {
    position: "absolute",
    bottom: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 3,
    borderColor: "#fffaf7",
  },
  name: {
    color: "#5f0909",
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
    color: "#e0a53d",
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 12,
  },
  infoCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    backgroundColor: "#fffaf7",
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.14)",
  },
  infoLabel: {
    color: "#888",
    fontSize: 13,
  },
  infoValue: {
    color: "#4d1b17",
    fontSize: 16,
    fontWeight: "500",
    marginTop: 4,
  },
  postCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.12)",
  },
  postContent: {
    color: "#4d1b17",
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
    borderTopColor: "#f0e7e2",
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
    backgroundColor: "#fffaf7",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(224,165,61,0.18)",
  },
  pollQuestion: {
    color: "#4d1b17",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 10,
  },
  pollOption: {
    color: "#7a3b2e",
    fontSize: 14,
    marginVertical: 3,
    marginLeft: 4,
  },
  moreOptions: {
    color: "#e0a53d",
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
  loadMoreButton: {
    marginTop: 12,
    paddingVertical: 12,
    alignItems: "center",
    borderRadius: 10,
    backgroundColor: "#f3f3f3",
  },
  loadMoreText: {
    fontWeight: "600",
    color: "#c88d2b",
  },

});
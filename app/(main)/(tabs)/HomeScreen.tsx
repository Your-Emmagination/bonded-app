//HomeScreen.tsx - OPTIMIZED VERSION (No Flickering)
import { getUserData, UserRole } from "@/utils/rbac";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";
import { useNetworkStatus } from "../../../utils/networkUtils";
import PollCard from "../components/PollCard";
import PostCard from "../components/PostCard";
export const tabBarTranslateY = new Animated.Value(0);

const { width: SCREEN_WIDTH } = Dimensions.get("window");

type TaggedUser = {
  id: string;
  name: string;
  studentID: string;
};

type FileAttachment = {
  url: string;
  mimeType: string;
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
};

type PollOption = {
  text: string;
  votes: number;
  voters: string[];
};

type Poll = {
  id: string;
  question: string;
  options: PollOption[];
  userId?: string;
  username?: string;
  isAnonymous?: boolean;
  allowMultiple: boolean;
  maxSelections: number;
  allowUsersToAddOption?: boolean;
  totalVotes: number;
  durationMs: number;
  createdAt?: any;
  expiresAt?: any;
  userVotes?: number[];
};

type FeedItem = (Post | Poll) & { type: "post" | "poll" };

const HomeScreen = () => {
  const [user, setUser] = useState<User | null>(null);
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [fabMenuVisible, setFabMenuVisible] = useState(false);
  const [currentUserRole, setCurrentUserRole] = useState<UserRole | undefined>(
    undefined,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [userRoles, setUserRoles] = useState<{ [key: string]: string }>({});
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [currentImages, setCurrentImages] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [addOptionModalVisible, setAddOptionModalVisible] = useState(false);
  const [addingPollId, setAddingPollId] = useState<string | null>(null);
  const [newOptionText, setNewOptionText] = useState("");
  const [onlineUsersCount, setOnlineUsersCount] = useState(0);
  const [upcomingEventsCount, setUpcomingEventsCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const fabTranslateY = useRef(new Animated.Value(0)).current;
  const fabRotation = useRef(new Animated.Value(0)).current;
  const menuScale = useRef(new Animated.Value(0)).current;
  const scrollY = useRef(0);
  const menuOpacity = useRef(new Animated.Value(0)).current;
  const menuTranslateY = useRef(new Animated.Value(0)).current;
  const router = useRouter();

  // âœ… Track if listeners are already set up
  const listenersSetup = useRef(false);
  const unsubscribePostsRef = useRef<(() => void) | null>(null);
  const unsubscribePollsRef = useRef<(() => void) | null>(null);

  const { isOffline } = useNetworkStatus();

  // âœ… Only set up auth listener once
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return unsubscribe;
  }, []);

  // âœ… Update online status without re-rendering
  useEffect(() => {
    if (!user?.uid || !user?.email || isOffline) return;

    const email = user.email;
    const studentID = email.split("@")[0] || user.uid;
    const userStatusRef = doc(db, "students", studentID);

    const setOnline = async () => {
      try {
        if (!auth.currentUser) return;
        await setDoc(
          userStatusRef,
          {
            // ✅ setDoc with merge
            isOnline: true,
            lastSeen: serverTimestamp(),
          },
          { merge: true },
        );
      } catch (error) {
        console.error("Error setting online status:", error);
      }
    };

    const setOffline = async () => {
      try {
        if (!auth.currentUser) return;
        await setDoc(
          userStatusRef,
          {
            // ✅ setDoc with merge
            isOnline: false,
            lastSeen: serverTimestamp(),
          },
          { merge: true },
        );
      } catch (error) {
        console.error("Error setting offline status:", error);
      }
    };

    setOnline();
    const intervalId = setInterval(() => setOnline(), 30000);

    return () => {
      clearInterval(intervalId);
      setOffline();
    };
  }, [user?.uid, user?.email, isOffline]);

  // âœ… Online users count
  useEffect(() => {
    if (!user || isOffline) {
      setOnlineUsersCount(0);
      return;
    }

    const q = query(collection(db, "students"), where("isOnline", "==", true));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setOnlineUsersCount(snapshot.size);
    });

    return unsubscribe;
  }, [user, isOffline]);

  // âœ… Upcoming events count
  useEffect(() => {
    if (!user || isOffline) {
      setUpcomingEventsCount(0);
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const q = query(
      collection(db, "events"),
      where("date", ">=", today),
      orderBy("date", "asc"),
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      setUpcomingEventsCount(snapshot.size);
    });

    return unsubscribe;
  }, [user, isOffline]);

  // âœ… Fetch user role once
  useEffect(() => {
    const fetchCurrentUserRole = async () => {
      if (user?.uid && !isOffline && !currentUserRole) {
        try {
          const userData = await getUserData(user.uid);
          setCurrentUserRole(userData?.role);
        } catch (error) {
          console.error("Error fetching role:", error);
        }
      }
    };
    fetchCurrentUserRole();
  }, [user, isOffline, currentUserRole]);

  const fetchUserRole = useCallback(
    async (userId: string) => {
      if (!auth.currentUser || userRoles[userId] || isOffline) return;

      try {
        const userDoc = await getDoc(doc(db, "students", userId));
        if (userDoc.exists()) {
          const role = userDoc.data()?.role || "student";
          setUserRoles((prev) => ({ ...prev, [userId]: role }));
        }
      } catch (error: any) {
        if (auth.currentUser) {
          console.error("Error fetching user role:", error);
        }
      }
    },
    [userRoles, isOffline],
  );

  // âœ… Set up feed listeners ONCE
  useEffect(() => {
    if (!user || !auth.currentUser || isOffline || listenersSetup.current) {
      if (isOffline) return;
      if (!user && feedItems.length > 0) {
        setFeedItems([]);
      }
      return;
    }

    console.log("ðŸ”¥ Setting up feed listeners");
    listenersSetup.current = true;
    setIsLoading(true);

    const qPosts = query(collection(db, "posts"), orderBy("createdAt", "desc"));
    unsubscribePostsRef.current = onSnapshot(
      qPosts,
      (snapshot) => {
        if (!auth.currentUser) return;

        const fetchedPosts: FeedItem[] = snapshot.docs.map((d) => ({
          type: "post" as const,
          id: d.id,
          likeCount: 0,
          commentCount: 0,
          likedBy: [],
          ...d.data(),
        })) as FeedItem[];

        fetchedPosts.forEach((post) => {
          if (post.type === "post" && !post.isAnonymous && post.userId) {
            fetchUserRole(post.userId);
          }
        });

        setFeedItems((prev) => {
          const polls = prev.filter((item) => item.type === "poll");
          return [...fetchedPosts, ...polls].sort((a, b) => {
            const timeA = a.createdAt?.toMillis?.() || 0;
            const timeB = b.createdAt?.toMillis?.() || 0;
            return timeB - timeA;
          });
        });

        setIsLoading(false);
      },
      (error) => {
        if (auth.currentUser) console.error("Error fetching posts:", error);
        setIsLoading(false);
      },
    );

    const qPolls = query(collection(db, "polls"), orderBy("createdAt", "desc"));
    unsubscribePollsRef.current = onSnapshot(
      qPolls,
      (snapshot) => {
        if (!auth.currentUser) return;

        const fetchedPolls: FeedItem[] = snapshot.docs.map((d) => ({
          type: "poll" as const,
          id: d.id,
          ...d.data(),
        })) as FeedItem[];

        fetchedPolls.forEach((poll) => {
          if (poll.type === "poll" && !poll.isAnonymous && poll.userId) {
            fetchUserRole(poll.userId);
          }
        });

        setFeedItems((prev) => {
          const posts = prev.filter((item) => item.type === "post");
          return [...posts, ...fetchedPolls].sort((a, b) => {
            const timeA = a.createdAt?.toMillis?.() || 0;
            const timeB = b.createdAt?.toMillis?.() || 0;
            return timeB - timeA;
          });
        });
      },
      (error) => {
        if (auth.currentUser) console.error("Error fetching polls:", error);
      },
    );

    // Don't cleanup listeners on unmount - keep them active
    return undefined;
  }, [user, isOffline, fetchUserRole, feedItems.length]);

  // âœ… Cleanup only when user logs out
  useEffect(() => {
    if (!user && listenersSetup.current) {
      console.log("ðŸ§¹ Cleaning up feed listeners");
      if (unsubscribePostsRef.current) unsubscribePostsRef.current();
      if (unsubscribePollsRef.current) unsubscribePollsRef.current();
      listenersSetup.current = false;
      setFeedItems([]);
    }
  }, [user]);

  const onRefresh = useCallback(async () => {
    if (isOffline) {
      Alert.alert(
        "No Connection",
        "Please check your internet connection and try again.",
      );
      return;
    }
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 800);
  }, [isOffline]);

  const handleLike = async (postId: string, currentLikedBy: string[] = []) => {
    if (!user) return;

    if (isOffline) {
      Alert.alert("No Connection", "Cannot like posts while offline.");
      return;
    }

    const postRef = doc(db, "posts", postId);
    const hasLiked = currentLikedBy.includes(user.uid);

    try {
      await updateDoc(postRef, {
        likedBy: hasLiked
          ? currentLikedBy.filter((id) => id !== user.uid)
          : [...currentLikedBy, user.uid],
        likeCount: increment(hasLiked ? -1 : 1),
      });
    } catch (error) {
      console.error("Error updating like:", error);
      Alert.alert("Error", "Failed to like post. Please try again.");
    }
  };

  const handlePollVote = async (pollId: string, optionIndex: number) => {
    if (!user) return;

    if (isOffline) {
      Alert.alert("No Connection", "Cannot vote while offline.");
      return;
    }

    const pollRef = doc(db, "polls", pollId);
    const feedItem = feedItems.find(
      (it) => it.id === pollId && it.type === "poll",
    ) as Poll | undefined;
    if (!feedItem) return;

    const poll = feedItem as Poll;

    const userVotes = poll.options
      .map((opt, idx) => (opt.voters?.includes(user.uid) ? idx : -1))
      .filter((idx) => idx !== -1);

    const expired = isPollExpired(poll.expiresAt);
    if (expired) return;

    if (!poll.allowMultiple && userVotes.length > 0) return;
    if (userVotes.includes(optionIndex)) return;
    if (poll.allowMultiple && userVotes.length >= poll.maxSelections) {
      return;
    }

    try {
      const updatedOptions: PollOption[] = poll.options.map((opt, idx) => {
        const voters = Array.isArray(opt.voters) ? [...opt.voters] : [];
        if (idx === optionIndex && !voters.includes(user.uid)) {
          voters.push(user.uid);
        }
        return { ...opt, voters, votes: voters.length };
      });

      const totalVotes = updatedOptions.reduce((s, o) => s + (o.votes || 0), 0);

      await updateDoc(pollRef, {
        options: updatedOptions,
        totalVotes,
      });
    } catch (error) {
      console.error("Error voting on poll:", error);
      Alert.alert("Error", "Failed to vote. Please try again.");
    }
  };

  const promptOpenAddOption = (pollId: string) => {
    if (isOffline) {
      Alert.alert("No Connection", "Cannot add options while offline.");
      return;
    }
    setAddingPollId(pollId);
    setNewOptionText("");
    setAddOptionModalVisible(true);
  };

  const addOptionToPoll = async (pollId: string, text: string) => {
    try {
      if (!text.trim()) {
        Alert.alert("Error", "Option cannot be empty.");
        return;
      }

      const pollRef = doc(db, "polls", pollId);
      const pollSnap = await getDoc(pollRef);

      if (!pollSnap.exists()) {
        Alert.alert("Error", "Poll not found.");
        return;
      }

      const poll = pollSnap.data();
      const pollExpired = isPollExpired(poll.expiresAt);
      if (pollExpired) {
        Alert.alert("Error", "This poll has already expired.");
        return;
      }

      const newOption: PollOption = {
        text: text.trim(),
        votes: 0,
        voters: [],
      };
      const updatedOptions = [...poll.options, newOption];
      const totalVotes = updatedOptions.reduce(
        (sum, opt) => sum + (opt.votes || 0),
        0,
      );

      await updateDoc(pollRef, { options: updatedOptions, totalVotes });
      Alert.alert("Success", "Option added! You can vote for it manually.");
    } catch (error) {
      console.error("Error adding option:", error);
      Alert.alert("Error", "Failed to add option. Please try again.");
    }
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
    const diffWeek = Math.floor(diffDay / 7);

    if (diffSec < 60) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    if (diffWeek < 4) return `${diffWeek}w ago`;

    return postDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year:
        postDate.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  };

  const isPollExpired = (expiresAt: any) => {
    if (!expiresAt || !expiresAt.toDate) return false;
    return new Date() > expiresAt.toDate();
  };

  const toggleFabMenu = () => {
    if (fabMenuVisible) {
      Animated.parallel([
        Animated.timing(menuScale, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(menuOpacity, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(fabRotation, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start(() => setFabMenuVisible(false));
    } else {
      setFabMenuVisible(true);
      menuScale.setValue(0.3);
      menuOpacity.setValue(0);
      Animated.parallel([
        Animated.timing(menuScale, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(menuOpacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(fabRotation, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
    }
  };

  const handleScroll = (event: any) => {
    const currentOffsetY = event.nativeEvent.contentOffset.y;
    const delta = currentOffsetY - scrollY.current;

    if (delta > 5) {
      Animated.parallel([
        Animated.timing(fabTranslateY, {
          toValue: 150,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(menuTranslateY, {
          toValue: 150,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(menuOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(tabBarTranslateY, {
          toValue: 100,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }

    if (delta < -5) {
      Animated.parallel([
        Animated.timing(fabTranslateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(menuTranslateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(menuOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(tabBarTranslateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }

    scrollY.current = currentOffsetY;
  };

  const handleMenuAction = (action: string) => {
    if (isOffline) {
      Alert.alert("No Connection", "Cannot create posts while offline.");
      return;
    }
    toggleFabMenu();
    if (action === "create") {
      router.push("/CreatePostScreen");
    } else if (action === "polls") {
      router.push("/CreatePollScreen");
    }
  };

  const handleProfileClick = (userId?: string, isAnonymous?: boolean) => {
    if (isAnonymous || !userId || userId === "anonymous") return;

    if (user && userId === user.uid) {
      router.push("./(tabs)/ProfileScreen");
    } else {
      router.push(`/UserProfileScreen?userId=${userId}`);
    }
  };

  const openImageViewer = (images: string[], startIndex: number) => {
    setCurrentImages(images);
    setCurrentImageIndex(startIndex);
    setImageViewerVisible(true);
  };

  const handleFilePress = (url: string, mimeType: string) => {
    if (mimeType.startsWith("image/")) {
      openImageViewer([url], 0);
    } else {
      let fileUrl = url;
      if (mimeType.includes("pdf") && url.includes("cloudinary.com")) {
        fileUrl = url.replace("/upload/", "/upload/fl_attachment/");
      }

      Linking.canOpenURL(fileUrl)
        .then((supported) => {
          if (supported) {
            Linking.openURL(fileUrl);
          } else {
            Alert.alert(
              "Cannot Open File",
              "Unable to open this file type on your device.",
            );
          }
        })
        .catch((err) => {
          console.error("Error opening URL:", err);
          Alert.alert("Error", "Failed to open file. Please try again.");
        });
    }
  };

  const rotation = fabRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "135deg"],
  });

  const renderFeedItem = ({ item }: { item: FeedItem }) => {
    if (item.type === "post") {
      const post = item as Post;
      const isLiked = post.likedBy?.includes(user?.uid || "") || false;

      return (
        <PostCard
          post={post}
          isLiked={isLiked}
          currentUserRole={currentUserRole}
          currentUserId={user?.uid}
          onLike={handleLike}
          onProfileClick={(targetId) => {
            if (targetId === "self") {
              router.push("../(tabs)/ProfileScreen");
            } else {
              router.push(`../UserProfileScreen?userId=${targetId}`);
            }
          }}
          onTagClick={(taggedUserId) => {
            if (taggedUserId === user?.uid) {
              router.push("../(tabs)/ProfileScreen");
            } else {
              router.push(`../UserProfileScreen?userId=${taggedUserId}`);
            }
          }}
          onImagePress={openImageViewer}
          onFilePress={handleFilePress}
          getTimeAgo={getTimeAgo}
        />
      );
    } else {
      const poll = item as Poll;
      const userRole = userRoles[poll.userId || ""];

      return (
        <PollCard
          poll={poll}
          onImagePress={openImageViewer}
          currentUserRole={currentUserRole}
          userRole={userRole}
          currentUserId={user?.uid}
          onVote={handlePollVote}
          onAddOption={promptOpenAddOption}
          onProfileClick={handleProfileClick}
          getTimeAgo={getTimeAgo}
          isPollExpired={isPollExpired}
        />
      );
    }
  };

  const renderEmptyState = () => {
    if (isLoading) {
      return (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#ff5c93" />
          <Text style={styles.loadingText}>Loading feed...</Text>
        </View>
      );
    }

    if (isOffline && feedItems.length === 0) {
      return (
        <View style={styles.emptyStateContainer}>
          <Ionicons name="cloud-offline" size={64} color="#5a6380" />
          <Text style={styles.emptyStateTitle}>No Connection</Text>
          <Text style={styles.emptyStateText}>
            Connect to the internet to load your feed
          </Text>
        </View>
      );
    }

    return null;
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity>
          <Ionicons name="menu" size={24} color="#b8c7ff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>HOME</Text>
        <View style={styles.headerIcons}>
          <View style={styles.onlineUsersContainer}>
            <View style={styles.onlineDot} />
            <Text style={styles.onlineUsersText}>{onlineUsersCount}</Text>
          </View>

          <TouchableOpacity
            style={styles.calendarButton}
            onPress={() => router.push("/EventCalendarScreen")}
          >
            <Ionicons name="calendar-outline" size={22} color="#b8c7ff" />
            {upcomingEventsCount > 0 && (
              <View style={styles.eventBadge}>
                <Text style={styles.eventBadgeText}>
                  {upcomingEventsCount > 99 ? "99+" : upcomingEventsCount}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={feedItems}
        renderItem={renderFeedItem}
        keyExtractor={(item) => item.id}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        contentContainerStyle={
          feedItems.length === 0
            ? styles.emptyListContent
            : styles.flatListContent
        }
        ListEmptyComponent={renderEmptyState}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={["#4f9cff"]}
            tintColor="#4f9cff"
            title={isOffline ? "Offline" : "Refreshing feed..."}
            titleColor="#4f9cff"
          />
        }
      />

      {/* All modals... (same as before) */}
      <Modal
        visible={imageViewerVisible}
        animationType="fade"
        transparent={false}
        onRequestClose={() => setImageViewerVisible(false)}
      >
        <View style={styles.imageViewerContainer}>
          <View style={styles.imageViewerHeader}>
            <Text style={styles.imageViewerCounter}>
              {currentImageIndex + 1} / {currentImages.length}
            </Text>
            <TouchableOpacity onPress={() => setImageViewerVisible(false)}>
              <Ionicons name="close" size={32} color="#fff" />
            </TouchableOpacity>
          </View>

          <FlatList
            data={currentImages}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(_, idx) => idx.toString()}
            initialScrollIndex={currentImageIndex}
            getItemLayout={(_, index) => ({
              length: SCREEN_WIDTH,
              offset: SCREEN_WIDTH * index,
              index,
            })}
            onMomentumScrollEnd={(e) => {
              const index = Math.round(
                e.nativeEvent.contentOffset.x / SCREEN_WIDTH,
              );
              setCurrentImageIndex(index);
            }}
            renderItem={({ item }) => (
              <View style={styles.imageViewerSlide}>
                <Image
                  source={{ uri: item }}
                  style={styles.fullscreenImage}
                  resizeMode="contain"
                />
              </View>
            )}
          />
        </View>
      </Modal>

      <Modal
        visible={addOptionModalVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setAddOptionModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalContainer}
        >
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Add new option</Text>

            <TextInput
              placeholder="Enter option text"
              placeholderTextColor="rgba(255,255,255,0.5)"
              value={newOptionText}
              onChangeText={setNewOptionText}
              style={styles.modalInput}
              maxLength={60}
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, { backgroundColor: "#1b2235" }]}
                onPress={() => {
                  setAddOptionModalVisible(false);
                  setNewOptionText("");
                }}
              >
                <Text style={[styles.modalButtonText, { color: "#b8c7ff" }]}>
                  Cancel
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalButtonPrimary}
                onPress={async () => {
                  if (addingPollId && newOptionText.trim()) {
                    await addOptionToPoll(addingPollId, newOptionText.trim());
                    setAddOptionModalVisible(false);
                    setNewOptionText("");
                  }
                }}
              >
                <Text style={styles.modalButtonText}>Add Option</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {fabMenuVisible && (
        <Animated.View
          style={[
            styles.fabMenuContainer,
            {
              transform: [{ translateY: menuTranslateY }],
              opacity: menuOpacity,
            },
          ]}
          pointerEvents="box-none"
        >
          {[
            {
              label: "Create",
              icon: "create-outline" as const,
              action: "create",
            },
            {
              label: "Polls",
              icon: "bar-chart-outline" as const,
              action: "polls",
            },
          ].map((item, index) => (
            <Animated.View
              key={item.action}
              style={[
                styles.menuItemContainer,
                {
                  transform: [
                    {
                      scale: menuScale.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.7, 1],
                      }),
                    },
                    {
                      translateY: menuScale.interpolate({
                        inputRange: [0, 1],
                        outputRange: [20 + index * 15, 0],
                      }),
                    },
                  ],
                  opacity: menuScale.interpolate({
                    inputRange: [0, 0.5, 1],
                    outputRange: [0, 0.6, 1],
                  }),
                },
              ]}
            >
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => handleMenuAction(item.action)}
                activeOpacity={0.7}
              >
                <Ionicons name={item.icon} size={20} color="#fff" />
                <Text style={styles.menuText}>{item.label}</Text>
              </TouchableOpacity>
            </Animated.View>
          ))}
        </Animated.View>
      )}

      {/* FAB Button */}
      <Animated.View
        style={[
          styles.fabContainer,
          { transform: [{ translateY: fabTranslateY }] },
        ]}
      >
        <TouchableOpacity
          style={styles.fab}
          onPress={toggleFabMenu}
          activeOpacity={0.8}
        >
          <Animated.View
            style={{
              transform: [{ rotate: rotation }],
              width: 28,
              height: 28,
            }}
          >
            <Ionicons name="add" size={28} color="#fff" />
          </Animated.View>
        </TouchableOpacity>
      </Animated.View>
    </SafeAreaView>
  );
};

export default HomeScreen;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#070c15" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#111827",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#b8c7ff",
    letterSpacing: 1,
  },
  headerIcons: {
    flexDirection: "row",
    gap: 16,
    alignItems: "center",
  },
  onlineUsersContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0e1320",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
    borderWidth: 1,
    borderColor: "#2ecc71",
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#2ecc71",
  },
  onlineUsersText: {
    color: "#2ecc71",
    fontSize: 13,
    fontWeight: "600",
  },
  calendarButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#0e1320",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#b8c7ff",
    position: "relative",
  },
  eventBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    backgroundColor: "#ff5c93",
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#070c15",
  },
  eventBadgeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "bold",
  },

  flatListContent: {
    paddingVertical: 12,
    paddingBottom: 100,
  },
  emptyListContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 100,
  },
  loadingText: {
    color: "#b8c7ff",
    fontSize: 16,
    marginTop: 16,
    fontWeight: "500",
    letterSpacing: 0.5,
  },
  emptyStateContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 100,
    paddingHorizontal: 40,
  },
  emptyStateTitle: {
    color: "#b8c7ff",
    fontSize: 20,
    fontWeight: "700",
    marginTop: 20,
    letterSpacing: 0.5,
  },
  emptyStateText: {
    color: "#8ea0d0",
    fontSize: 15,
    marginTop: 12,
    textAlign: "center",
    lineHeight: 22,
  },

  imageViewerContainer: {
    flex: 1,
    backgroundColor: "#000",
  },
  imageViewerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    paddingTop: 50,
    backgroundColor: "rgba(0, 0, 0, 0.85)",
  },
  imageViewerCounter: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  imageViewerSlide: {
    width: SCREEN_WIDTH,
    justifyContent: "center",
    alignItems: "center",
  },
  fullscreenImage: {
    width: SCREEN_WIDTH,
    height: "100%",
  },
  modalContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.85)",
  },
  modalContent: {
    width: "85%",
    backgroundColor: "#0e1320",
    borderRadius: 16,
    padding: 20,
    shadowColor: "#ff5c93",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 92, 147, 0.15)",
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#ff5c93",
    marginBottom: 14,
    textAlign: "center",
  },
  modalInput: {
    backgroundColor: "#1b2235",
    color: "#e9edff",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 15,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: "rgba(255,92,147,0.2)",
  },
  modalButtons: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  modalButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    marginHorizontal: 4,
    backgroundColor: "#0e1320",
    borderWidth: 1,
    borderColor: "#1b2235",
  },
  modalButtonPrimary: {
    flex: 1,
    backgroundColor: "#ff5c93",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    marginHorizontal: 4,
    shadowColor: "#ff5c93",
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 3,
  },
  modalButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#fff",
  },
  fabContainer: {
    position: "absolute",
    bottom: 80,
    right: 20,
    zIndex: 100,
  },
  fab: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#ff5c93",
    justifyContent: "center",
    alignItems: "center",
    elevation: 12,
    shadowColor: "#ff5c93",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    borderWidth: 0,
  },
  fabMenuContainer: {
    position: "absolute",
    bottom: 155,
    right: 20,
    gap: 12,
    zIndex: 99,
    pointerEvents: "none",
  },
  menuItemContainer: {
    alignItems: "flex-end",
    marginBottom: 8,
  },
  menuItem: {
    backgroundColor: "#0e1320",
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1.5,
    borderColor: "#ff5c93",
    minWidth: 130,
    elevation: 8,
    shadowColor: "#ff5c93",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  menuText: {
    color: "#e9edff",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
});

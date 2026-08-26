// app/(main)/(tabs)/DashboardScreen.tsx
const YEAR_LEVEL_OPTIONS = ["1st Year", "2nd Year", "3rd Year", "4th Year", "Graduated"];
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { 
  View, 
  Text, 
  StyleSheet, 
  ScrollView, 
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
  Alert,
  TextInput,
  Image,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { avatarThumb, feedImage } from "@/utils/cloudinaryImages";
import ImageZoomViewer from "../components/ImageZoomViewer";
import { createModerationNotification } from "@/utils/notifications";
import { SafeAreaView } from "react-native-safe-area-context";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  query,
  onSnapshot,
  where,
  doc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db, auth } from "../../../Firebase_configure";
import { useRouter } from "expo-router";
import {
  canManageUsers,
  canManageAiMemory,
  getPermissionsForRole,
  getRoleDisplayName,
  getRoleHierarchyLevel,
  isStaff,
  parseUserRole,
  resolveUserRoleForAuthUser,
  type UserRole,
} from "@/utils/rbac";
import { buildUserProfileHref } from "@/utils/profileNavigation";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

type ManagedUserFilter = "all" | "online" | "admin" | "teacher" | "moderator" | "student";

type ManagedUserRecord = {
  id: string;
  userId?: string | null;
  firstname?: string;
  lastname?: string;
  email?: string;
  studentID?: string;
  course?: string;
  yearlvl?: string;
  role?: string;
  isOnline?: boolean;
  profileImage?: string | null;
};

const MANAGED_USER_FILTERS: {
  value: ManagedUserFilter;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { value: "all", label: "All", icon: "apps-outline" },
  { value: "online", label: "Online", icon: "ellipse-outline" },
  { value: "admin", label: "Admins", icon: "shield-checkmark-outline" },
  { value: "teacher", label: "Teachers", icon: "school-outline" },
  { value: "moderator", label: "Moderators", icon: "shield-outline" },
  { value: "student", label: "Students", icon: "people-outline" },
];

const MANAGED_ROLE_OPTIONS: {
  value: UserRole;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { value: "student", label: "Student", icon: "people-outline" },
  { value: "moderator", label: "Moderator", icon: "shield-outline" },
  { value: "teacher", label: "Teacher", icon: "school-outline" },
  { value: "admin", label: "Admin", icon: "shield-checkmark-outline" },
];

export default function DashboardScreen() {
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalPosts: 0,
    totalPolls: 0,
    totalUsers: 0,
    onlineUsers: 0,
    totalComments: 0,
    totalEvents: 0,
  });
  const [moderationItems, setModerationItems] = useState<
    {
      id: string;
      type: "post" | "poll" | "comment" | "reply" | "message";
      text: string;
      author: string;
      realUserId?: string | null;
      userId?: string | null;
      isAnonymous?: boolean;
      reasons: string[];
      createdAt?: any;
      imageUrl?: string | null;
    }[]
  >([]);
  const [moderationImageViewerUrl, setModerationImageViewerUrl] = useState<string | null>(null);
  const [moderationBusyId, setModerationBusyId] = useState<string | null>(null);
  const [managedUsers, setManagedUsers] = useState<ManagedUserRecord[]>([]);
  const [managedUserSearch, setManagedUserSearch] = useState("");
  const [managedUserFilter, setManagedUserFilter] =
    useState<ManagedUserFilter>("all");
  const [managedUserBusyId, setManagedUserBusyId] = useState<string | null>(null);
  const [expandedManagedUserId, setExpandedManagedUserId] = useState<string | null>(
    null,
  );
  const scrollViewRef = useRef<ScrollView>(null);
  const manageUsersSectionYRef = useRef(0);
  const router = useRouter();
  const normalizedUserRole = parseUserRole(userRole);
  const canManageModeration = isStaff(normalizedUserRole);
  const canOpenAiMemory = canManageAiMemory(normalizedUserRole);
  const canOpenManageUsers = canManageUsers(normalizedUserRole);
  const currentStudentDocId = auth.currentUser?.email?.split("@")[0] || null;
  const managedUserRoleCounts = useMemo(
    () => ({
      admin: managedUsers.filter((item) => parseUserRole(item.role) === "admin").length,
      teacher: managedUsers.filter((item) => parseUserRole(item.role) === "teacher").length,
      moderator: managedUsers.filter((item) => parseUserRole(item.role) === "moderator").length,
      student: managedUsers.filter((item) => parseUserRole(item.role) !== "admin" &&
        parseUserRole(item.role) !== "teacher" &&
        parseUserRole(item.role) !== "moderator").length,
      online: managedUsers.filter((item) => item.isOnline === true).length,
    }),
    [managedUsers],
  );
  const filteredManagedUsers = useMemo(() => {
    const queryValue = managedUserSearch.trim().toLowerCase();

    return [...managedUsers]
      .filter((item) => {
        const normalizedRole = parseUserRole(item.role) || "student";
        const matchesFilter =
          managedUserFilter === "all" ||
          (managedUserFilter === "online" && item.isOnline === true) ||
          normalizedRole === managedUserFilter;

        if (!matchesFilter) return false;
        if (!queryValue) return true;

        const haystack = [
          getManagedUserName(item),
          item.email,
          item.studentID,
          item.course,
          item.yearlvl,
          normalizedRole,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(queryValue);
      })
      .sort((first, second) => {
        if ((first.isOnline === true) !== (second.isOnline === true)) {
          return first.isOnline ? -1 : 1;
        }

        const roleDiff =
          getRoleHierarchyLevel(parseUserRole(second.role)) -
          getRoleHierarchyLevel(parseUserRole(first.role));
        if (roleDiff !== 0) return roleDiff;

        return getManagedUserName(first).localeCompare(getManagedUserName(second));
      });
  }, [managedUserFilter, managedUserSearch, managedUsers]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      try {
        if (!user) {
          setUserRole("student");
          setLoading(false);
          return;
        }

        const role = await resolveUserRoleForAuthUser(user);
        console.log("📊 Dashboard - User Role:", role);
        setUserRole(role);
      } catch (error) {
        console.error("Error loading role:", error);
        setUserRole("student");
      } finally {
        setLoading(false);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (loading) return;
    if (userRole && !["admin", "teacher", "moderator"].includes(userRole)) {
      router.replace("/(main)/(tabs)/HomeScreen");
    }
  }, [loading, router, userRole]);

  useEffect(() => {
    if (!canOpenManageUsers) {
      setManagedUsers([]);
      setExpandedManagedUserId(null);
    }
  }, [canOpenManageUsers]);

  

  // Real-time stats listeners
  useEffect(() => {
    if (!auth.currentUser) return;

  const extractPreviewImageUrl = (
    item: any,
    type: "post" | "poll" | "comment" | "reply" | "message",
  ): string | null => {
    if (type === "poll") {
      return typeof item.imageUrl === "string" ? item.imageUrl : null;
    }

    const files = Array.isArray(item.files) ? item.files : [];
    const firstImage = files.find(
      (f: any) =>
        typeof f?.mimeType === "string" &&
        f.mimeType.startsWith("image/") &&
        !f.mimeType.includes("gif"),
    );
    if (firstImage?.url) return firstImage.url;

    // Legacy single-image field still used by some older posts.
    return typeof item.imageUrl === "string" ? item.imageUrl : null;
  };

  const unsubscribers: (() => void)[] = [];
    const subscribePending = (
      collectionName: string,
      type: "post" | "poll" | "comment" | "reply" | "message",
      textSelector: (data: any) => string,
    ) =>
      onSnapshot(collection(db, collectionName), (snapshot) => {
        setModerationItems((prev) => {
          const remaining = prev.filter((item) => item.type !== type);
          const pendingItems = snapshot.docs
            .map((item) => ({ id: item.id, ...item.data() }))
            .filter((item: any) => item.moderationStatus === "pending")
            .map((item: any) => ({
              id: item.id,
              type,
              text: textSelector(item),
              author: item.username || "Unknown",
              realUserId: item.realUserId ?? null,
              userId: item.userId ?? null,
              isAnonymous: item.isAnonymous === true,
              reasons: Array.isArray(item.moderationReasons)
                ? item.moderationReasons
                : [],
              createdAt: item.createdAt,
              imageUrl: extractPreviewImageUrl(item, type),
            }));
          return [...remaining, ...pendingItems].sort((a, b) => {
            const first = a.createdAt?.toMillis?.() || 0;
            const second = b.createdAt?.toMillis?.() || 0;
            return second - first;
          });
        });
      });

    // Posts count
    const postsQuery = query(collection(db, "posts"));
    const unsubPosts = onSnapshot(postsQuery, (snapshot) => {
      setStats(prev => ({ ...prev, totalPosts: snapshot.size }));
    });
    unsubscribers.push(unsubPosts);

    // Polls count
    const pollsQuery = query(collection(db, "polls"));
    const unsubPolls = onSnapshot(pollsQuery, (snapshot) => {
      setStats(prev => ({ ...prev, totalPolls: snapshot.size }));
    });
    unsubscribers.push(unsubPolls);

    // Users count
    const usersQuery = query(collection(db, "students"));
    const unsubUsers = onSnapshot(usersQuery, (snapshot) => {
      setStats(prev => ({ ...prev, totalUsers: snapshot.size }));

      if (!canOpenManageUsers) return;

      const nextUsers = snapshot.docs.map((item) => {
        const data = item.data() as ManagedUserRecord;
        return {
          id: item.id,
          userId: data.userId ?? null,
          firstname: data.firstname || "",
          lastname: data.lastname || "",
          email: data.email || "",
          studentID: data.studentID || item.id,
          course: data.course || "",
          yearlvl: data.yearlvl || "",
          role: data.role || "student",
          isOnline: data.isOnline === true,
          profileImage: data.profileImage || null,
        } satisfies ManagedUserRecord;
      });

      setManagedUsers(nextUsers);
    });
    unsubscribers.push(unsubUsers);

    // Online users count
    const onlineQuery = query(collection(db, "students"), where("isOnline", "==", true));
    const unsubOnline = onSnapshot(onlineQuery, (snapshot) => {
      setStats(prev => ({ ...prev, onlineUsers: snapshot.size }));
    });
    unsubscribers.push(unsubOnline);

    // Comments count
    const commentsQuery = query(collection(db, "comments"));
    const unsubComments = onSnapshot(commentsQuery, (snapshot) => {
      setStats(prev => ({ ...prev, totalComments: snapshot.size }));
    });
    unsubscribers.push(unsubComments);

    // Events count
    const eventsQuery = query(collection(db, "events"));
    const unsubEvents = onSnapshot(eventsQuery, (snapshot) => {
      setStats(prev => ({ ...prev, totalEvents: snapshot.size }));
    });
    unsubscribers.push(unsubEvents);

    if (canManageModeration) {
      unsubscribers.push(
        subscribePending("posts", "post", (item) => item.content || "[empty post]"),
      );
      unsubscribers.push(
        subscribePending("polls", "poll", (item) => item.question || "[empty poll]"),
      );
      unsubscribers.push(
        subscribePending("comments", "comment", (item) => item.text || "[empty comment]"),
      );
      unsubscribers.push(
        subscribePending("replies", "reply", (item) => item.text || "[empty reply]"),
      );
      unsubscribers.push(
        subscribePending(
          "communityThreadMessages",
          "message",
          (item) => item.text || "[empty message]",
        ),
      );
    }

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [canManageModeration, canOpenManageUsers]);

  const getCollectionNameForType = (
    type: "post" | "poll" | "comment" | "reply" | "message",
  ) => {
    if (type === "message") return "communityThreadMessages";
    if (type === "reply") return "replies";
    if (type === "comment") return "comments";
    return `${type}s`;
  };

  const handleApproveModeration = async (
    itemId: string,
    type: "post" | "poll" | "comment" | "reply" | "message",
  ) => {
    try {
      setModerationBusyId(itemId);
      await updateDoc(doc(db, getCollectionNameForType(type), itemId), {
        moderationStatus: "approved",
        moderationReviewedAt: serverTimestamp(),
        moderationReviewedBy: auth.currentUser?.uid || null,
      });
    } catch (error) {
      console.error("Error approving content:", error);
      Alert.alert("Error", "Failed to approve content.");
    } finally {
      setModerationBusyId(null);
    }
  };

  const handleDeleteModeration = async (item: {
    id: string;
    type: "post" | "poll" | "comment" | "reply" | "message";
    text: string;
    realUserId?: string | null;
    userId?: string | null;
    reasons: string[];
  }) => {
    Alert.alert("Delete Content", "This will permanently remove the restricted content.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            setModerationBusyId(item.id);
            await deleteDoc(doc(db, getCollectionNameForType(item.type), item.id));

            const recipientId = item.realUserId || item.userId;
            if (
              recipientId &&
              recipientId !== "anonymous" &&
              (item.type === "post" || item.type === "comment" || item.type === "reply")
            ) {
              await createModerationNotification({
                recipientId,
                moderator: {
                  id: auth.currentUser?.uid || "moderation-system",
                  name: auth.currentUser?.displayName || "A moderator",
                },
                entityType: item.type,
                entityId: item.id,
                reasons: item.reasons,
                preview: item.text,
              }).catch((error) => {
                // Don't let a notification failure look like the delete itself failed.
                console.error("Error sending moderation notification:", error);
              });
            }
          } catch (error) {
            console.error("Error deleting content:", error);
            Alert.alert("Error", "Failed to delete content.");
          } finally {
            setModerationBusyId(null);
          }
        },
      },
    ]);
  };

  const handleOpenModeratedUser = (item: {
    realUserId?: string | null;
    userId?: string | null;
  }) => {
    const targetUserId = item.realUserId || item.userId;
    if (!targetUserId || targetUserId === "anonymous") {
      Alert.alert("Unavailable", "No linked user profile was found for this content.");
      return;
    }

    if (auth.currentUser?.uid === targetUserId) {
      router.push({
        pathname: "/(main)/(tabs)/ProfileScreen",
        params: { returnTo: "/(main)/(tabs)/DashboardScreen" },
      });
      return;
    }

    router.push(
      buildUserProfileHref({
        userId: targetUserId,
        returnTo: "/(main)/(tabs)/DashboardScreen",
      }) as any,
    );
  };

  const scrollToManageUsers = useCallback(() => {
    scrollViewRef.current?.scrollTo({
      y: Math.max(0, manageUsersSectionYRef.current - 16),
      animated: true,
    });
  }, []);

  const handleOpenManagedUser = useCallback(
    (managedUser: ManagedUserRecord) => {
      const targetUserId = managedUser.userId || managedUser.studentID || managedUser.id;
      if (!targetUserId) {
        Alert.alert("Unavailable", "This user does not have a linked profile yet.");
        return;
      }

      if (auth.currentUser?.uid === targetUserId) {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo: "/(main)/(tabs)/DashboardScreen" },
        });
        return;
      }

      router.push(
        buildUserProfileHref({
          userId: targetUserId,
          profileDocId: managedUser.id,
          returnTo: "/(main)/(tabs)/DashboardScreen",
        }) as any,
      );
    },
    [router],
  );
const handleYearLevelChange = useCallback(
  (managedUser: ManagedUserRecord, nextYearLvl: string) => {
    if (!canOpenManageUsers) return;
    if (managedUser.yearlvl === nextYearLvl) return;

    Alert.alert(
      "Update Year Level",
      `Change ${getManagedUserName(managedUser)}'s year level to ${nextYearLvl}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Update",
          onPress: async () => {
            try {
              setManagedUserBusyId(managedUser.id);
              await updateDoc(doc(db, "students", managedUser.id), {
                yearlvl: nextYearLvl,
                updatedAt: serverTimestamp(),
              });
            } catch (error) {
              console.error("Error updating year level:", error);
              Alert.alert("Error", "Failed to update year level.");
            } finally {
              setManagedUserBusyId(null);
            }
          },
        },
      ]
    );
  },
  [canOpenManageUsers]
);
  const handleRoleChange = useCallback(
    (managedUser: ManagedUserRecord, nextRole: UserRole) => {
      if (!canOpenManageUsers) return;

      const currentRole = parseUserRole(managedUser.role) || "student";
      if (currentRole === nextRole) return;

      if (
        (managedUser.userId && managedUser.userId === auth.currentUser?.uid) ||
        managedUser.id === currentStudentDocId
      ) {
        Alert.alert(
          "Action Blocked",
          "For safety, you cannot change your own role from the dashboard.",
        );
        return;
      }

      Alert.alert(
        "Update Role",
        `Change ${getManagedUserName(managedUser)} to ${getRoleDisplayName(nextRole)}?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Update",
            onPress: async () => {
              try {
                setManagedUserBusyId(managedUser.id);
                await updateDoc(doc(db, "students", managedUser.id), {
                  role: nextRole,
                  permissions: getPermissionsForRole(nextRole),
                  updatedAt: serverTimestamp(),
                  roleUpdatedAt: serverTimestamp(),
                  roleUpdatedBy: auth.currentUser?.uid || null,
                });
              } catch (error) {
                console.error("Error updating user role:", error);
                Alert.alert("Error", "Failed to update user role.");
              } finally {
                setManagedUserBusyId(null);
              }
            },
          },
        ],
      );
    },
    [canOpenManageUsers, currentStudentDocId],
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color="#e0a53d" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentShell}>
        <ScrollView ref={scrollViewRef} contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Dashboard</Text>
            <Text style={styles.subtitle}>Welcome back, {userRole?.toUpperCase()}</Text>
          </View>
          <View style={[styles.roleBadge, { backgroundColor: getRoleColor(userRole) }]}>
            <Ionicons name={getRoleIcon(userRole)} size={20} color="#fff" />
          </View>
        </View>

        {/* Stats Grid */}
        <View style={styles.statsGrid}>
          <StatCard
            icon="newspaper"
            iconColor="#4f9cff"
            label="Total Posts"
            value={stats.totalPosts}
          />
          <StatCard
            icon="bar-chart"
            iconColor="#a86fff"
            label="Total Polls"
            value={stats.totalPolls}
          />
          <StatCard
            icon="people"
            iconColor="#ff9f43"
            label="Total Users"
            value={stats.totalUsers}
          />
          <StatCard
            icon="ellipse"
            iconColor="#2ecc71"
            label="Online Now"
            value={stats.onlineUsers}
          />
          <StatCard
            icon="chatbubbles"
            iconColor="#ff5c93"
            label="Comments"
            value={stats.totalComments}
          />
          <StatCard
            icon="calendar"
            iconColor="#00d4ff"
            label="Events"
            value={stats.totalEvents}
          />
        </View>

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          
          {(userRole === "admin" || userRole === "teacher" || userRole === "moderator") && (
            <>
              <ActionButton
                icon="calendar-outline"
                label="Manage Events"
                color="#00d4ff"
                onPress={() => router.push("/EventCalendarScreen")}
              />
              
              {userRole === "admin" && (
                <>
                  <ActionButton
                    icon="people-outline"
                    label="Manage Users"
                    color="#ff9f43"
                    onPress={scrollToManageUsers}
                  />
                  <ActionButton
                    icon="school-outline"
                    label="Manage Programs"
                    color="#e0a53d"
                    onPress={() => router.push("/AdminManageProgramsScreen" as any)}
                  />
                </>
              )}
              
              <ActionButton
                icon="flag-outline"
                label="View Reports"
                color="#ff5c93"
                onPress={() => router.push("/ReportManagementScreen" as any)}
              />
              {canOpenAiMemory && (
                <ActionButton
                  icon="library-outline"
                  label="Manage AI Memory"
                  color="#e0a53d"
                  onPress={() => router.push("/AiMemoryScreen")}
                />
              )}
              {canManageModeration && (
                <ActionButton
                  icon="help-circle-outline"
                  label="Unanswered Questions"
                  color="#a86fff"
                  onPress={() => router.push("/UnansweredQuestionsScreen" as any)}
                />
              )}
            </>
          )}
        </View>

        {canOpenManageUsers && (
          <View
            style={styles.section}
            onLayout={(event) => {
              manageUsersSectionYRef.current = event.nativeEvent.layout.y;
            }}
          >
            <View style={styles.manageUsersHero}>
              <View style={styles.manageUsersHeroIcon}>
                <Ionicons name="people-circle-outline" size={24} color="#ff9f43" />
              </View>
              <View style={styles.manageUsersHeroContent}>
                <Text style={styles.manageUsersHeroTitle}>Manage Users</Text>
                <Text style={styles.manageUsersHeroText}>
                  Search the roster, check who is online, open profiles, and update roles
                  from one admin workspace.
                </Text>
              </View>
            </View>

            {userRole === "admin" && (
              <TouchableOpacity
                style={styles.registerUsersButton}
                onPress={() => router.push("/AdminRegisterUserScreen")}
                activeOpacity={0.84}
              >
                <View style={styles.registerUsersButtonIcon}>
                  <Ionicons name="person-add-outline" size={18} color="#7a0020" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.registerUsersButtonTitle}>Register Users</Text>
                  <Text style={styles.registerUsersButtonText}>Add one account or import your campus CSV</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#a0786e" />
              </TouchableOpacity>
            )}

            <View style={styles.manageUsersInsightRow}>
              <InsightPill
                label="Online"
                value={managedUserRoleCounts.online}
                color="#2ecc71"
              />
              <InsightPill
                label="Admins"
                value={managedUserRoleCounts.admin}
                color="#ff3b7f"
              />
              <InsightPill
                label="Teachers"
                value={managedUserRoleCounts.teacher}
                color="#ff9f43"
              />
              <InsightPill
                label="Moderators"
                value={managedUserRoleCounts.moderator}
                color="#a86fff"
              />
            </View>

            <View style={styles.manageUsersControls}>
              <View style={styles.searchInputShell}>
                <Ionicons name="search" size={18} color="#9b766c" />
                <TextInput
                  value={managedUserSearch}
                  onChangeText={setManagedUserSearch}
                  placeholder="Search by name, ID, email, course, or role"
                  placeholderTextColor="#b88f87"
                  style={styles.searchInput}
                />
                {!!managedUserSearch.trim() && (
                  <TouchableOpacity
                    onPress={() => setManagedUserSearch("")}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons name="close-circle" size={18} color="#b88f87" />
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.filterChipRow}>
                {MANAGED_USER_FILTERS.map((filter) => {
                  const selected = managedUserFilter === filter.value;
                  return (
                    <TouchableOpacity
                      key={filter.value}
                      style={[
                        styles.filterChip,
                        selected && styles.filterChipActive,
                      ]}
                      onPress={() => setManagedUserFilter(filter.value)}
                      activeOpacity={0.82}
                    >
                      <Ionicons
                        name={filter.icon}
                        size={14}
                        color={selected ? "#fffaf7" : "#8f3a2b"}
                      />
                      <Text
                        style={[
                          styles.filterChipText,
                          selected && styles.filterChipTextActive,
                        ]}
                      >
                        {filter.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <Text style={styles.manageUsersCountText}>
              Showing {filteredManagedUsers.length} of {managedUsers.length} users
            </Text>

            {filteredManagedUsers.length === 0 ? (
              <View style={styles.manageUsersEmptyCard}>
                <Ionicons name="search-outline" size={42} color="#b88f87" />
                <Text style={styles.manageUsersEmptyTitle}>No users matched</Text>
                <Text style={styles.manageUsersEmptyText}>
                  Try a different search term or switch the filter above.
                </Text>
              </View>
            ) : (
              filteredManagedUsers.map((managedUser) => {
                const normalizedManagedRole = parseUserRole(managedUser.role) || "student";
                const isExpanded = expandedManagedUserId === managedUser.id;
                const isBusy = managedUserBusyId === managedUser.id;
                const isSelf =
                  (!!managedUser.userId && managedUser.userId === auth.currentUser?.uid) ||
                  managedUser.id === currentStudentDocId;

                return (
                  <View
                    key={managedUser.id}
                    style={[
                      styles.manageUserCard,
                      isExpanded && styles.manageUserCardExpanded,
                    ]}
                  >
                    <TouchableOpacity
                      style={styles.manageUserHeader}
                      activeOpacity={0.85}
                      onPress={() =>
                        setExpandedManagedUserId((current) =>
                          current === managedUser.id ? null : managedUser.id,
                        )
                      }
                    >
                      <View style={styles.manageUserIdentityRow}>
                        <View style={styles.manageUserAvatar}>
                          {managedUser.profileImage ? (
                            <Image
                              source={{ uri: avatarThumb(managedUser.profileImage, 50) }}
                              style={styles.manageUserAvatarImage}
                            />
                          ) : (
                            <Text style={styles.manageUserAvatarText}>
                              {getManagedUserInitials(managedUser)}
                            </Text>
                          )}
                        </View>
                        <View style={styles.manageUserIdentityCopy}>
                          <View style={styles.manageUserTitleRow}>
                            <Text style={styles.manageUserName}>
                              {getManagedUserName(managedUser)}
                            </Text>
                            {isSelf && (
                              <View style={styles.selfBadge}>
                                <Text style={styles.selfBadgeText}>You</Text>
                              </View>
                            )}
                          </View>
                          <Text style={styles.manageUserMeta}>
                            {getManagedUserMeta(managedUser)}
                          </Text>
                          <View style={styles.manageUserBadgeRow}>
                            <View
                              style={[
                                styles.manageUserRoleBadge,
                                {
                                  backgroundColor:
                                    getRoleColor(normalizedManagedRole) + "18",
                                },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.manageUserRoleBadgeText,
                                  { color: getRoleColor(normalizedManagedRole) },
                                ]}
                              >
                                {getRoleDisplayName(normalizedManagedRole)}
                              </Text>
                            </View>
                            <View style={styles.manageUserStatusRow}>
                              <View
                                style={[
                                  styles.manageUserStatusDot,
                                  {
                                    backgroundColor: managedUser.isOnline
                                      ? "#2ecc71"
                                      : "#b88f87",
                                  },
                                ]}
                              />
                              <Text style={styles.manageUserStatusText}>
                                {managedUser.isOnline ? "Online" : "Offline"}
                              </Text>
                            </View>
                          </View>
                        </View>
                      </View>
                      <Ionicons
                        name={isExpanded ? "chevron-up" : "chevron-down"}
                        size={18}
                        color="#8f3a2b"
                      />
                    </TouchableOpacity>

                    <View style={styles.manageUserActionRow}>
                      <TouchableOpacity
                        style={styles.manageUserActionButton}
                        onPress={() => handleOpenManagedUser(managedUser)}
                        activeOpacity={0.82}
                      >
                        <Ionicons name="person-circle-outline" size={16} color="#8a5a10" />
                        <Text style={styles.manageUserActionText}>Open profile</Text>
                      </TouchableOpacity>
                    </View>

                    {isExpanded && (
                      <View style={styles.manageUserExpandedPanel}>
                        <Text style={[styles.manageUserExpandedTitle, { marginTop: 16 }]}>Set Year Level</Text>
<View style={styles.roleOptionGrid}>
  {YEAR_LEVEL_OPTIONS.map((yearOption) => {
    const isSelected = managedUser.yearlvl === yearOption;
    return (
      <TouchableOpacity
        key={`${managedUser.id}-${yearOption}`}
        style={[
          styles.roleOptionButton,
          isSelected && styles.roleOptionButtonSelected,
        ]}
        onPress={() => handleYearLevelChange(managedUser, yearOption)}
        disabled={isBusy}
        activeOpacity={0.82}
      >
        <Ionicons
          name="school-outline"
          size={16}
          color={isSelected ? "#fffaf7" : "#5f0909"}
        />
        <Text
          style={[
            styles.roleOptionText,
            isSelected && styles.roleOptionTextSelected,
          ]}
        >
          {yearOption}
        </Text>
      </TouchableOpacity>
    );
  })}
</View>
                        <Text style={styles.manageUserExpandedTitle}>Set role</Text>
                        <Text style={styles.manageUserExpandedText}>
                          Choose the access level that best matches this account.
                        </Text>
                        <View style={styles.roleOptionGrid}>
                          {MANAGED_ROLE_OPTIONS.map((roleOption) => {
                            const selected = normalizedManagedRole === roleOption.value;
                            return (
                              <TouchableOpacity
                                key={`${managedUser.id}-${roleOption.value}`}
                                style={[
                                  styles.roleOptionButton,
                                  selected && styles.roleOptionButtonSelected,
                                ]}
                                onPress={() => handleRoleChange(managedUser, roleOption.value)}
                                disabled={isBusy || isSelf || selected}
                                activeOpacity={0.82}
                              >
                                <Ionicons
                                  name={roleOption.icon}
                                  size={16}
                                  color={selected ? "#fffaf7" : getRoleColor(roleOption.value)}
                                />
                                <Text
                                  style={[
                                    styles.roleOptionText,
                                    selected && styles.roleOptionTextSelected,
                                  ]}
                                >
                                  {roleOption.label}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                        {isBusy ? (
                          <View style={styles.manageUserBusyRow}>
                            <ActivityIndicator size="small" color="#8f3a2b" />
                            <Text style={styles.manageUserBusyText}>
                              Updating role...
                            </Text>
                          </View>
                        ) : (
                          <Text style={styles.manageUserHintText}>
                            Role changes update the student record immediately. The user may
                            need to refresh their session to pick up new access everywhere.
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                );
              })
            )}
          </View>
        )}

        {canManageModeration && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Moderation Queue</Text>
            {moderationItems.length === 0 ? (
              <View style={styles.comingSoonCard}>
                <Ionicons name="shield-checkmark-outline" size={48} color="#b88f87" />
                <Text style={styles.comingSoonText}>No restricted content waiting for review</Text>
              </View>
            ) : (
              moderationItems.map((item) => (
                <View key={`${item.type}:${item.id}`} style={styles.reviewCard}>
                  <View style={styles.reviewHeader}>
                    <View style={styles.reviewTypePill}>
                      <Text style={styles.reviewTypeText}>{item.type.toUpperCase()}</Text>
                    </View>
                    <Text style={styles.reviewAuthor}>by {item.author}</Text>
                  </View>
                  <Text style={styles.reviewBody} numberOfLines={4}>
                    {item.text}
                  </Text>
                  {!!item.imageUrl && (
                    <TouchableOpacity
                      activeOpacity={0.9}
                      onPress={() => setModerationImageViewerUrl(item.imageUrl!)}
                    >
                      <Image
                        source={{ uri: feedImage(item.imageUrl, 240) }}
                        style={styles.reviewImage}
                        resizeMode="cover"
                      />
                    </TouchableOpacity>
                  )}
                  {!!item.reasons.length && (
                    <Text style={styles.reviewReason}>{item.reasons.join(" • ")}</Text>
                  )}
                  <View style={styles.reviewActions}>
                    <TouchableOpacity
                      style={[styles.reviewButton, styles.reviewProfile]}
                      onPress={() => handleOpenModeratedUser(item)}
                    >
                      <Text style={styles.reviewProfileText}>
                        {item.isAnonymous ? "Open Real User" : "Open Profile"}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.reviewButton, styles.reviewApprove]}
                      onPress={() => handleApproveModeration(item.id, item.type)}
                      disabled={moderationBusyId === item.id}
                    >
                      <Text style={styles.reviewApproveText}>Approve</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.reviewButton, styles.reviewDelete]}
                      onPress={() => handleDeleteModeration(item)}
                      disabled={moderationBusyId === item.id}
                    >
                      <Text style={styles.reviewDeleteText}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </View>
        )}

        {/* Info Card */}
        <View style={styles.infoCard}>
          <Ionicons name="information-circle" size={24} color="#e0a53d" />
          <View style={styles.infoContent}>
            <Text style={styles.infoTitle}>Role Permissions</Text>
            <Text style={styles.infoText}>
              {getRoleDescription(userRole)}
            </Text>
          </View>
        </View>

        {/* Recent Activity Placeholder */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent Activity</Text>
          <View style={styles.comingSoonCard}>
            <Ionicons name="time-outline" size={48} color="#b88f87" />
            <Text style={styles.comingSoonText}>Activity Feed Coming Soon</Text>
          </View>
        </View>
        </ScrollView>
      </View>
      <ImageZoomViewer
        images={moderationImageViewerUrl ? [moderationImageViewerUrl] : []}
        startIndex={0}
        visible={!!moderationImageViewerUrl}
        onClose={() => setModerationImageViewerUrl(null)}
        showActions={false}
      />
    </SafeAreaView>
  );
}

// Stat Card Component
interface StatCardProps {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  label: string;
  value: number;
}

const StatCard: React.FC<StatCardProps> = ({ icon, iconColor, label, value }) => (
  <View style={styles.statCard}>
    <View style={[styles.statIconContainer, { backgroundColor: iconColor + "20" }]}>
      <Ionicons name={icon} size={24} color={iconColor} />
    </View>
    <Text style={styles.statValue}>{value.toLocaleString()}</Text>
    <Text style={styles.statLabel}>{label}</Text>
  </View>
);

// Action Button Component
interface ActionButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  onPress: () => void;
}

const ActionButton: React.FC<ActionButtonProps> = ({ icon, label, color, onPress }) => (
  <TouchableOpacity 
    style={[styles.actionButton, { borderLeftColor: color }]}
    onPress={onPress}
    activeOpacity={0.7}
  >
    <View style={[styles.actionIconContainer, { backgroundColor: color + "20" }]}>
      <Ionicons name={icon} size={20} color={color} />
    </View>
    <Text style={styles.actionLabel}>{label}</Text>
    <Ionicons name="chevron-forward" size={20} color="#9b766c" />
  </TouchableOpacity>
);

interface InsightPillProps {
  label: string;
  value: number;
  color: string;
}

const InsightPill: React.FC<InsightPillProps> = ({ label, value, color }) => (
  <View style={[styles.insightPill, { borderColor: color + "44" }]}>
    <Text style={[styles.insightPillValue, { color }]}>{value}</Text>
    <Text style={styles.insightPillLabel}>{label}</Text>
  </View>
);

function getManagedUserName(user: ManagedUserRecord) {
  return `${user.firstname || ""} ${user.lastname || ""}`.trim() || user.email || "Unknown user";
}

function getManagedUserInitials(user: ManagedUserRecord) {
  const seed = `${user.firstname?.[0] || ""}${user.lastname?.[0] || ""}`.trim();
  if (seed) return seed.toUpperCase();
  return (user.email?.[0] || user.studentID?.[0] || "U").toUpperCase();
}

function getManagedUserMeta(user: ManagedUserRecord) {
  return [user.studentID, user.course, user.yearlvl].filter(Boolean).join(" • ") || "No profile details yet";
}

function getRoleColor(role: string | null) {
  const colors: Record<string, string> = {
    admin: "#ff3b7f",
    teacher: "#ff9f43",
    moderator: "#a86fff",
  };
  return colors[role || ""] || "#ff3b7f";
}

function getRoleIcon(role: string | null) {
  const iconMap: Record<string, keyof typeof Ionicons.glyphMap> = {
    admin: "shield-checkmark",
    teacher: "school",
    moderator: "shield-half",
  };
  return iconMap[role || ""] || "person";
}

function getRoleDescription(role: string | null) {
  const descriptions: Record<string, string> = {
    admin: "Full system access. Manage users, roles, and all content. View analytics and reports.",
    teacher: "Manage content and events. Delete posts/comments. View and handle reports.",
    moderator: "Monitor and moderate content. Delete inappropriate posts/comments. Handle user reports.",
  };
  return descriptions[role || ""] || "Limited access.";
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#5f0909",
  },
  contentShell: {
    flex: 1,
    backgroundColor: "#f6f1ed",
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 100,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 24,
    backgroundColor: "#5f0909",
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingVertical: 18,
    borderWidth: 1,
    borderColor: "#8f3a2b",
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    color: "#fffaf7",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: "#f0d2c2",
    fontWeight: "500",
  },
  roleBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 24,
  },
  statCard: {
    width: (SCREEN_WIDTH - 44) / 2,
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  statIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  statValue: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#4d1b17",
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 13,
    color: "#9b766c",
    textAlign: "center",
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#5f0909",
    marginBottom: 12,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fffaf7",
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  actionIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  actionLabel: {
    flex: 1,
    color: "#4d1b17",
    fontSize: 15,
    fontWeight: "600",
  },
  registerUsersButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#eadbd4",
    borderRadius: 16,
    padding: 14,
    marginTop: 12,
    marginBottom: 14,
  },
  registerUsersButtonIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#f6e8e7",
    alignItems: "center",
    justifyContent: "center",
  },
  registerUsersButtonTitle: {
    color: "#5f0909",
    fontWeight: "800",
    fontSize: 14,
  },
  registerUsersButtonText: {
    color: "#9b766c",
    fontSize: 11.5,
    marginTop: 2,
  },
  manageUsersHero: {
    backgroundColor: "#5f0909",
    borderRadius: 18,
    padding: 18,
    flexDirection: "row",
    gap: 14,
    borderWidth: 1,
    borderColor: "#8f3a2b",
    marginBottom: 14,
  },
  manageUsersHeroIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255, 159, 67, 0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  manageUsersHeroContent: {
    flex: 1,
  },
  manageUsersHeroTitle: {
    color: "#fffaf7",
    fontSize: 19,
    fontWeight: "800",
    marginBottom: 4,
  },
  manageUsersHeroText: {
    color: "#f0d2c2",
    fontSize: 13,
    lineHeight: 20,
  },
  manageUsersInsightRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 14,
  },
  insightPill: {
    minWidth: (SCREEN_WIDTH - 64) / 2,
    flex: 1,
    backgroundColor: "#fffaf7",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
  },
  insightPillValue: {
    fontSize: 20,
    fontWeight: "800",
    marginBottom: 4,
  },
  insightPillLabel: {
    color: "#9b766c",
    fontSize: 12,
    fontWeight: "600",
  },
  manageUsersControls: {
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#f0e7e2",
    padding: 14,
    marginBottom: 10,
    gap: 12,
  },
  searchInputShell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#f8f1ec",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#edd6cc",
    paddingHorizontal: 12,
    minHeight: 46,
  },
  searchInput: {
    flex: 1,
    color: "#4d1b17",
    fontSize: 14,
    paddingVertical: 10,
  },
  filterChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fff4ee",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#edd6cc",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  filterChipActive: {
    backgroundColor: "#8f3a2b",
    borderColor: "#8f3a2b",
  },
  filterChipText: {
    color: "#8f3a2b",
    fontSize: 12,
    fontWeight: "700",
  },
  filterChipTextActive: {
    color: "#fffaf7",
  },
  manageUsersCountText: {
    color: "#8f6a60",
    fontSize: 12.5,
    fontWeight: "600",
    marginBottom: 10,
  },
  manageUsersEmptyCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  manageUsersEmptyTitle: {
    color: "#5f0909",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 10,
  },
  manageUsersEmptyText: {
    color: "#9b766c",
    fontSize: 13,
    marginTop: 6,
    textAlign: "center",
    lineHeight: 19,
  },
  manageUserCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#f0e7e2",
    marginBottom: 12,
  },
  manageUserCardExpanded: {
    borderColor: "#ddb977",
    shadowColor: "#5f0909",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  manageUserHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  manageUserIdentityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  manageUserAvatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "#5f0909",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  manageUserAvatarImage: {
    width: "100%",
    height: "100%",
  },
  manageUserAvatarText: {
    color: "#fffaf7",
    fontSize: 18,
    fontWeight: "800",
  },
  manageUserIdentityCopy: {
    flex: 1,
  },
  manageUserTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
    flexWrap: "wrap",
  },
  manageUserName: {
    color: "#4d1b17",
    fontSize: 15,
    fontWeight: "800",
  },
  selfBadge: {
    backgroundColor: "#fff1d6",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  selfBadgeText: {
    color: "#8a5a10",
    fontSize: 11,
    fontWeight: "800",
  },
  manageUserMeta: {
    color: "#9b766c",
    fontSize: 12.5,
    lineHeight: 18,
  },
  manageUserBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  manageUserRoleBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  manageUserRoleBadgeText: {
    fontSize: 11.5,
    fontWeight: "800",
  },
  manageUserStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  manageUserStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  manageUserStatusText: {
    color: "#8f6a60",
    fontSize: 12,
    fontWeight: "700",
  },
  manageUserActionRow: {
    marginTop: 12,
    flexDirection: "row",
  },
  manageUserActionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f8f1e5",
    borderWidth: 1,
    borderColor: "#ddb977",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  manageUserActionText: {
    color: "#8a5a10",
    fontSize: 12.5,
    fontWeight: "700",
  },
  manageUserExpandedPanel: {
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#f0e7e2",
  },
  manageUserExpandedTitle: {
    color: "#5f0909",
    fontSize: 14,
    fontWeight: "800",
  },
  manageUserExpandedText: {
    color: "#9b766c",
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 4,
    marginBottom: 12,
  },
  roleOptionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  roleOptionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fff4ee",
    borderWidth: 1,
    borderColor: "#edd6cc",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  roleOptionButtonSelected: {
    backgroundColor: "#5f0909",
    borderColor: "#5f0909",
  },
  roleOptionText: {
    color: "#5f0909",
    fontSize: 12.5,
    fontWeight: "800",
  },
  roleOptionTextSelected: {
    color: "#fffaf7",
  },
  manageUserBusyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
  },
  manageUserBusyText: {
    color: "#8f3a2b",
    fontSize: 12.5,
    fontWeight: "700",
  },
  manageUserHintText: {
    color: "#9b766c",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
  },
  infoCard: {
    backgroundColor: "#fffaf7",
    borderLeftWidth: 4,
    borderLeftColor: "#e0a53d",
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    flexDirection: "row",
    gap: 12,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  infoContent: {
    flex: 1,
  },
  infoTitle: {
    color: "#e0a53d",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 6,
  },
  infoText: {
    color: "#7a3b2e",
    fontSize: 13,
    lineHeight: 20,
  },
  comingSoonCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 12,
    padding: 40,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  comingSoonText: {
    color: "#9b766c",
    fontSize: 14,
    marginTop: 12,
    fontWeight: "500",
  },
  reviewCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#f0e7e2",
  },
  reviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  reviewTypePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "#5f0909",
  },
  reviewTypeText: {
    color: "#fffaf7",
    fontSize: 11,
    fontWeight: "800",
  },
  reviewAuthor: {
    color: "#9b766c",
    fontSize: 12,
    fontWeight: "600",
  },
  reviewBody: {
    color: "#4d1b17",
    fontSize: 14,
    lineHeight: 21,
  },
  reviewImage: {
    width: "100%",
    height: 160,
    borderRadius: 10,
    marginTop: 8,
    backgroundColor: "#f2dfd4",
  },
  reviewReason: {
    color: "#a61f1f",
    fontSize: 12,
    marginTop: 8,
    lineHeight: 18,
  },
  reviewActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
  },
  reviewButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
    borderWidth: 1,
  },
  reviewApprove: {
    backgroundColor: "#e7f8ec",
    borderColor: "#8fd1a4",
  },
  reviewProfile: {
    backgroundColor: "#f8f1e5",
    borderColor: "#ddb977",
  },
  reviewDelete: {
    backgroundColor: "#fff0ef",
    borderColor: "#e6a2a0",
  },
  reviewApproveText: {
    color: "#17663a",
    fontWeight: "700",
  },
  reviewProfileText: {
    color: "#8a5a10",
    fontWeight: "700",
  },
  reviewDeleteText: {
    color: "#9b1f1c",
    fontWeight: "700",
  },
});
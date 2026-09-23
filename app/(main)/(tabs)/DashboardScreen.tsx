// app/(main)/(tabs)/DashboardScreen.tsx
import { useThemeColors } from "@/contexts/ThemeContext";
import { onSurface, type ThemeTokens } from "@/utils/theme";
import { subscribeTabScrollToTop } from "@/utils/tabScrollEvents";
import { friendlyModerationReasons, moderationMediaSummary } from "@/utils/moderationReasons";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { YEAR_LEVELS } from "@/utils/yearLevels";
import { subscribeToStaffTicketBadge } from "@/utils/supportTickets";
import { getPresenceState, PRESENCE_TIMEOUT_MS, type PresenceData } from "@/utils/messengerState";
import { useAppActive } from "@/utils/presence";
import { useRelativeTimeNow } from "@/utils/relativeTime";
const YEAR_LEVEL_OPTIONS = YEAR_LEVELS;
import { avatarThumb, feedImage } from "@/utils/cloudinaryImages";
import { useNetworkStatus } from "@/utils/networkUtils";
import {
    createModerationApprovalNotification,
    createModerationNotification,
    createServerDeletionOutcomeNotification,
} from "@/utils/notifications";
import {
    getCachedDashboardData,
    saveCachedDashboardData,
} from "@/utils/offlineStorage";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import {
    canManageAiMemory,
    canManageUsers,
    getPermissionsForRole,
    getRoleDisplayName,
    getStudentDocIdFromAuthUser,
    getRoleHierarchyLevel,
    isStaff,
    parseUserRole,
    type UserRole,
} from "@/utils/rbac";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useFocusEffect, useIsFocused, useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
    collection,
    deleteDoc,
    doc,
    getCountFromServer,
    getDocs,
    onSnapshot,
    query,
    serverTimestamp,
    setDoc,
    Timestamp,
    updateDoc,
    where,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Dimensions,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../../Firebase_configure";
import ConfirmDialog from "../components/ConfirmDialog";
import ImageZoomViewer from "../components/ImageZoomViewer";
import { SkeletonBlock, SkeletonCard, SkeletonCircle, SkeletonGroup } from "../components/Skeleton";

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
  const { styles, theme } = useStyles();
  const { isOffline } = useNetworkStatus();
  // Live, so a demotion trips the non-staff redirect below straight away
  // instead of leaving the dashboard open until it is reopened.
  const liveUserRole = useCurrentUserRole();
  const userRole = liveUserRole ?? null;
  const [loading, setLoading] = useState(true);

  // Single dialog state used to render every alert on this screen through
  // the app's branded ConfirmDialog instead of the bare native Alert.alert.
  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    singleAction?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const showInfo = (title: string, description?: string, onConfirm?: () => void) => {
    setDialog({
      title,
      description,
      confirmText: "OK",
      singleAction: true,
      onConfirm: () => {
        setDialog(null);
        onConfirm?.();
      },
    });
  };
  const showConfirm = (options: {
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    onConfirm: () => void;
  }) => {
    setDialog({
      ...options,
      onConfirm: () => {
        setDialog(null);
        options.onConfirm();
      },
    });
  };

  const [stats, setStats] = useState({
    totalPosts: 0,
    totalPolls: 0,
    totalUsers: 0,
    totalComments: 0,
    totalEvents: 0,
  });

  // "Online Now" by the same rule as Home's Campus Presence and Messenger:
  // heard from in the last 90 seconds, not hiding Active Status, not locked,
  // and not you — so the two numbers agree. Checked once a minute while the
  // Dashboard is on screen, the way Home does it. It used to listen live to
  // every profile marked online, which re-downloaded one each time a phone
  // checked in, and kept going on other tabs. Asking by "last seen" also
  // skips phones that closed without signing off and stayed marked online.
  const presenceNow = useRelativeTimeNow();
  const dashboardFocused = useIsFocused();
  const dashboardAppActive = useAppActive();
  const [onlineCandidates, setOnlineCandidates] = useState<
    (PresenceData & { id: string; userId?: string; accountLocked?: boolean })[]
  >([]);
  useEffect(() => {
    if (!userRole || isOffline || !dashboardFocused || !dashboardAppActive) return;
    let cancelled = false;
    const check = () => {
      getDocs(
        query(
          collection(db, "students"),
          where("lastSeen", ">=", Timestamp.fromMillis(Date.now() - PRESENCE_TIMEOUT_MS)),
        ),
      )
        .then((snapshot) => {
          if (cancelled) return;
          setOnlineCandidates(
            snapshot.docs.map((studentDoc) => ({ id: studentDoc.id, ...(studentDoc.data() as PresenceData) })),
          );
        })
        .catch((error) => console.warn("Online-now check failed:", error));
    };
    check();
    const timer = setInterval(check, 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [dashboardAppActive, dashboardFocused, isOffline, userRole]);
  const onlineNow = useMemo(() => {
    const me = new Set(
      [auth.currentUser?.uid, getStudentDocIdFromAuthUser(auth.currentUser)].filter(Boolean) as string[],
    );
    return onlineCandidates.filter(
      (student) =>
        !me.has(student.id) &&
        !me.has(student.userId || "") &&
        student.accountLocked !== true &&
        getPresenceState(student, presenceNow).active,
    ).length;
  }, [onlineCandidates, presenceNow]);
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
      categories?: string[];
      priority?: "normal" | "critical";
      safetyType?: string | null;
      createdAt?: any;
      imageUrl?: string | null;
    }[]
  >([]);
  const [moderationImageViewerUrl, setModerationImageViewerUrl] = useState<string | null>(null);
  const [moderationBusyId, setModerationBusyId] = useState<string | null>(null);
  // Task 6: pending server-deletion requests (admin review queue).
  const [deletionRequests, setDeletionRequests] = useState<
    {
      id: string;
      serverId: string;
      serverName: string;
      requestedBy: string;
      requesterName: string;
      reason: string;
      createdAt?: any;
    }[]
  >([]);
  const [deletionBusyId, setDeletionBusyId] = useState<string | null>(null);
  const [managedUsers, setManagedUsers] = useState<ManagedUserRecord[]>([]);
  const [managedUserSearch, setManagedUserSearch] = useState("");
  const [managedUserFilter, setManagedUserFilter] =
    useState<ManagedUserFilter>("all");
  const [managedUserBusyId, setManagedUserBusyId] = useState<string | null>(null);
  const [expandedManagedUserId, setExpandedManagedUserId] = useState<string | null>(
    null,
  );
  const scrollViewRef = useRef<ScrollView>(null);

  // Tapping the Dashboard tab while it's already open scrolls back to the top.
  useEffect(() => {
    const subscription = subscribeTabScrollToTop("DashboardScreen", () => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    });
    return () => subscription.remove();
  }, []);
  const manageUsersSectionYRef = useRef(0);
  const router = useRouter();
  const normalizedUserRole = parseUserRole(userRole);
  const canManageModeration = isStaff(normalizedUserRole);
  const canOpenAiMemory = canManageAiMemory(normalizedUserRole);
  const canOpenManageUsers = canManageUsers(normalizedUserRole);
  // Count on the card rather than a separate metric: a support queue nobody
  // notices is the failure mode that makes tickets worse than no tickets.
  //
  // Gated on admin, not staff, so a moderator's device never opens a listener
  // over a collection the rules would refuse anyway.
  const [supportWaiting, setSupportWaiting] = useState(0);

  useEffect(() => {
    if (normalizedUserRole !== "admin") return;
    return subscribeToStaffTicketBadge(setSupportWaiting);
  }, [normalizedUserRole]);
  // User and moderation management live on dedicated screens now — the "Manage
  // Users" quick action links to ManageUsersScreen, which owns the paginated,
  // virtualized roster. This flag keeps the old inline sections (and their
  // handlers) parked but unrendered; there is no separate students listener
  // feeding them any more (dashboard stats use getCountFromServer), so the
  // inline roster is not a second live copy of that data to keep correct.
  const showInlineManagementSections = false;
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
    // The role itself comes from useCurrentUserRole above; this only waits for
    // Firebase to report whether anyone is signed in.
    const unsubscribe = onAuthStateChanged(auth, () => {
      setLoading(false);
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

  

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    getCachedDashboardData<typeof stats>(uid).then((cached) => {
      if (cached) {
        setStats(cached);
      }
    });
  }, [userRole]);

  // Stat-card counts. Previously six live onSnapshot listeners on whole
  // collections (posts / polls / students x2 / comments / events) just to read
  // snapshot.size — every one downloaded and held every document, live,
  // forever. getCountFromServer returns just the number, server-side, no docs.
  // One-shot, so we refresh it when the tab regains focus.
  const refreshStats = useCallback(async () => {
    if (!auth.currentUser) return;
    try {
      const [posts, polls, users, comments, events] = await Promise.all([
        getCountFromServer(collection(db, "posts")),
        getCountFromServer(collection(db, "polls")),
        getCountFromServer(collection(db, "students")),
        getCountFromServer(collection(db, "comments")),
        getCountFromServer(collection(db, "events")),
      ]);
      const nextStats = {
        totalPosts: posts.data().count,
        totalPolls: polls.data().count,
        totalUsers: users.data().count,
        totalComments: comments.data().count,
        totalEvents: events.data().count,
      };
      setStats((prev) => ({
        ...prev,
        ...nextStats,
      }));
      if (auth.currentUser?.uid) {
        saveCachedDashboardData(auth.currentUser.uid, nextStats);
      }
    } catch (error) {
      console.error("Error loading dashboard stats:", error);
    }
  }, []);

  // Refresh on focus, and again once the role (and therefore auth) has
  // resolved on the first visit.
  useFocusEffect(
    useCallback(() => {
      if (userRole) void refreshStats();
    }, [refreshStats, userRole]),
  );

  // Moderation queue listeners — currently dormant behind
  // showInlineManagementSections (see the note on that flag). Only wired up
  // when the inline management sections are actually shown, so this stays a
  // no-op today.
  useEffect(() => {
    if (!auth.currentUser) return;
    if (!(canManageModeration && showInlineManagementSections)) return;

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
      onSnapshot(
        query(collection(db, collectionName), where("moderationStatus", "==", "pending")),
        (snapshot) => {
        setModerationItems((prev) => {
          const remaining = prev.filter((item) => item.type !== type);
          const pendingItems = snapshot.docs
            .map((item) => ({ id: item.id, ...item.data() }))
            .map((item: any) => ({
              id: item.id,
              type,
              text: textSelector(item),
              author: item.username || "Unknown",
              realUserId: item.realUserId ?? null,
              userId: item.userId ?? null,
              isAnonymous: item.isAnonymous === true,
              // Plain words rather than raw provider output — the same
              // cleanup the full moderation queue does.
              reasons: friendlyModerationReasons(item.moderationReasons),
              categories: Array.isArray(item.moderationCategories)
                ? item.moderationCategories
                : [],
              priority:
                item.moderationPriority === "critical"
                  ? ("critical" as const)
                  : ("normal" as const),
              safetyType: item.moderationSafetyType ?? null,
              createdAt: item.createdAt,
              imageUrl: extractPreviewImageUrl(item, type),
            }));
          return [...remaining, ...pendingItems].sort((a, b) => {
            if ((a.priority === "critical") !== (b.priority === "critical")) {
              return a.priority === "critical" ? -1 : 1;
            }
            const first = a.createdAt?.toMillis?.() || 0;
            const second = b.createdAt?.toMillis?.() || 0;
            return second - first;
          });
        });
      },
      );

    unsubscribers.push(
      subscribePending("posts", "post", (item) => item.content || moderationMediaSummary(item) || "[empty post]"),
    );
    unsubscribers.push(
      subscribePending("polls", "poll", (item) => item.question || "[empty poll]"),
    );
    unsubscribers.push(
      subscribePending("comments", "comment", (item) => item.text || moderationMediaSummary(item) || "[empty comment]"),
    );
    unsubscribers.push(
      subscribePending("replies", "reply", (item) => item.text || moderationMediaSummary(item) || "[empty reply]"),
    );
    unsubscribers.push(
      subscribePending(
        "communityThreadMessages",
        "message",
        (item) => item.text || moderationMediaSummary(item) || "[empty message]",
      ),
    );

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [canManageModeration]);

  const getCollectionNameForType = (
    type: "post" | "poll" | "comment" | "reply" | "message",
  ) => {
    if (type === "message") return "communityThreadMessages";
    if (type === "reply") return "replies";
    if (type === "comment") return "comments";
    return `${type}s`;
  };

  const handleApproveModeration = async (item: (typeof moderationItems)[number]) => {
    if (isOffline) {
      showInfo("Offline", "Approving content is unavailable while offline.");
      return;
    }
    const reviewerUid = auth.currentUser?.uid || null;
    const authorUid = item.realUserId || item.userId || null;

    if (!reviewerUid) {
      showInfo("Sign In Required", "You must be signed in to review content.");
      return;
    }

    if (authorUid && reviewerUid === authorUid) {
      showInfo(
        "Self-Approval Not Allowed",
        "You cannot approve content that you authored. Another Teacher, Moderator, or Admin must review it.",
      );
      return;
    }

    try {
      setModerationBusyId(item.id);
      await updateDoc(doc(db, getCollectionNameForType(item.type), item.id), {
        moderationStatus: "approved",
        moderationReviewedAt: serverTimestamp(),
        moderationReviewedBy: reviewerUid,
      });

      if (
        authorUid &&
        authorUid !== "anonymous" &&
        (item.type === "post" || item.type === "poll")
      ) {
        await createModerationApprovalNotification({
          recipientId: authorUid,
          moderator: {
            id: reviewerUid,
            name: auth.currentUser?.displayName || "A moderator",
          },
          entityType: item.type,
          entityId: item.id,
          preview: item.text,
        }).catch((error) => {
          console.error("Error sending approval notification:", error);
        });
      }
    } catch (error) {
      console.error("Error approving content:", error);
      showInfo("Error", "Failed to approve content.");
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
    if (isOffline) {
      showInfo("Offline", "Deleting content is unavailable while offline.");
      return;
    }
    showConfirm({
      title: "Delete Content",
      description: "This will permanently remove the flagged content.",
      confirmText: "Delete",
      cancelText: "Cancel",
      destructive: true,
      onConfirm: async () => {
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
          showInfo("Error", "Failed to delete content.");
        } finally {
          setModerationBusyId(null);
        }
      },
    });
  };

  // Task 6: admins watch the pending server-deletion queue. Non-admins never
  // see or resolve these (the Firestore rule enforces the same).
  useEffect(() => {
    if (normalizedUserRole !== "admin") {
      setDeletionRequests([]);
      return;
    }
    const unsubscribe = onSnapshot(
      query(
        collection(db, "communityServerDeletionRequests"),
        where("status", "==", "pending"),
      ),
      (snapshot) => {
        setDeletionRequests(
          snapshot.docs
            .map((entry) => {
              const data = entry.data() as any;
              return {
                id: entry.id,
                serverId: String(data.serverId || ""),
                serverName: String(data.serverName || "Unknown server"),
                requestedBy: String(data.requestedBy || ""),
                requesterName: String(data.requesterName || "A teacher"),
                reason: data.reason ? String(data.reason) : "",
                createdAt: data.createdAt,
              };
            })
            .sort(
              (a, b) =>
                (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0),
            ),
        );
      },
      (error) =>
        console.error("Error loading server deletion requests:", error),
    );
    return unsubscribe;
  }, [normalizedUserRole]);

  // Task 6: approving is the deletion — the admin's one action both soft-deletes
  // the server (same isDeleted flip HomeScreen uses) and resolves the request,
  // then notifies the requesting teacher.
  const handleApproveServerDeletion = (
    request: (typeof deletionRequests)[number],
  ) => {
    if (isOffline) {
      showInfo("Offline", "Approving server deletions is unavailable while offline.");
      return;
    }
    showConfirm({
      title: "Approve & delete server?",
      description: `"${request.serverName}" will be removed for every member. This can't be undone.`,
      confirmText: "Approve & Delete",
      cancelText: "Cancel",
      destructive: true,
      onConfirm: async () => {
        setDeletionBusyId(request.id);
        try {
          await setDoc(
            doc(db, "communityServers", request.serverId),
            {
              isDeleted: true,
              deletedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
          await setDoc(
            doc(db, "communityServerDeletionRequests", request.id),
            {
              status: "approved",
              reviewedBy: auth.currentUser?.uid || null,
              reviewedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
          await createServerDeletionOutcomeNotification({
            recipientId: request.requestedBy,
            admin: {
              id: auth.currentUser?.uid || "",
              name: auth.currentUser?.displayName || "An admin",
            },
            serverId: request.serverId,
            serverName: request.serverName,
            approved: true,
          }).catch((error) => {
            console.error("Error notifying deletion requester:", error);
          });
        } catch (error) {
          console.error("Error approving server deletion:", error);
          showInfo("Error", "Couldn't complete the deletion. Please try again.");
        } finally {
          setDeletionBusyId(null);
        }
      },
    });
  };

  const handleRejectServerDeletion = async (
    request: (typeof deletionRequests)[number],
  ) => {
    if (isOffline) {
      showInfo("Offline", "Rejecting server deletions is unavailable while offline.");
      return;
    }
    setDeletionBusyId(request.id);
    try {
      await setDoc(
        doc(db, "communityServerDeletionRequests", request.id),
        {
          status: "rejected",
          reviewedBy: auth.currentUser?.uid || null,
          reviewedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      await createServerDeletionOutcomeNotification({
        recipientId: request.requestedBy,
        admin: {
          id: auth.currentUser?.uid || "",
          name: auth.currentUser?.displayName || "An admin",
        },
        serverId: request.serverId,
        serverName: request.serverName,
        approved: false,
      }).catch((error) => {
        console.error("Error notifying deletion requester:", error);
      });
    } catch (error) {
      console.error("Error rejecting server deletion:", error);
      showInfo("Error", "Couldn't reject the request. Please try again.");
    } finally {
      setDeletionBusyId(null);
    }
  };

  const handleOpenModeratedUser = (item: {
    realUserId?: string | null;
    userId?: string | null;
  }) => {
    const targetUserId = item.realUserId || item.userId;
    if (!targetUserId || targetUserId === "anonymous") {
      showInfo("Unavailable", "No linked user profile was found for this content.");
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
        showInfo("Unavailable", "This user does not have a linked profile yet.");
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

    showConfirm({
      title: "Update Year Level",
      description: `Change ${getManagedUserName(managedUser)}'s year level to ${nextYearLvl}?`,
      confirmText: "Update",
      cancelText: "Cancel",
      destructive: false,
      onConfirm: async () => {
        try {
          setManagedUserBusyId(managedUser.id);
          await updateDoc(doc(db, "students", managedUser.id), {
            yearlvl: nextYearLvl,
            updatedAt: serverTimestamp(),
          });
        } catch (error) {
          console.error("Error updating year level:", error);
          showInfo("Error", "Failed to update year level.");
        } finally {
          setManagedUserBusyId(null);
        }
      },
    });
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
        showInfo(
          "Action Blocked",
          "For safety, you cannot change your own role from the dashboard.",
        );
        return;
      }

      showConfirm({
        title: "Update Role",
        description: `Change ${getManagedUserName(managedUser)} to ${getRoleDisplayName(nextRole)}?`,
        confirmText: "Update",
        cancelText: "Cancel",
        destructive: false,
        onConfirm: async () => {
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
            showInfo("Error", "Failed to update user role.");
          } finally {
            setManagedUserBusyId(null);
          }
        },
      });
    },
    [canOpenManageUsers, currentStudentDocId],
  );

  if (loading) {
    // Drawn with the dashboard's own header, stat cards and action rows, so
    // everything sits where it will be once it loads.
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.contentShell}>
          <SkeletonGroup style={styles.scrollContent}>
            <View style={styles.header}>
              <View>
                <Text style={styles.title}>Dashboard</Text>
                <SkeletonBlock width={150} height={14} style={{ marginTop: 2 }} />
              </View>
              <SkeletonCircle size={40} />
            </View>
            <View style={styles.statsGrid}>
              {Array.from({ length: 6 }).map((_, index) => (
                <View key={index} style={styles.statCard}>
                  <SkeletonCircle size={40} style={{ marginBottom: 12 }} />
                  <SkeletonBlock width={54} height={26} style={{ marginBottom: 6 }} />
                  <SkeletonBlock width={78} height={12} />
                </View>
              ))}
            </View>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Quick Actions</Text>
              {Array.from({ length: 4 }).map((_, index) => (
                <SkeletonCard
                  key={index}
                  style={styles.actionButton}
                  avatar={{ size: 40 }}
                  lines={[{ width: "55%", height: 14 }]}
                />
              ))}
            </View>
          </SkeletonGroup>
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
            <Ionicons name={getRoleIcon(userRole)} size={20} color={theme.onPrimary} />
          </View>
        </View>

        {isOffline && (
          <View style={styles.offlineStatusBar}>
            <Ionicons name="cloud-offline-outline" size={14} color={theme.warning} />
            <Text style={styles.offlineStatusText}>
              Offline mode
            </Text>
          </View>
        )}

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
            value={onlineNow}
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
                icon="stats-chart-outline"
                label="Analytics"
                color="#356a59"
                onPress={() => router.push("/AnalyticsScreen" as any)}
              />

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
                    onPress={() => router.push("/ManageUsersScreen" as any)}
                  />
                  <ActionButton
                    icon="school-outline"
                    label="Manage Programs"
                    color={theme.accent}
                    onPress={() => router.push("/AdminManageProgramsScreen" as any)}
                  />
                  {/* Administrators only, like Manage Users beside it. Not the
                      same thing as View Reports: that is content somebody
                      objected to, this is problems with the app or an account,
                      and it carries account and records details. */}
                  <ActionButton
                    icon="help-buoy-outline"
                    label={
                      supportWaiting > 0
                        ? `Support Requests (${supportWaiting})`
                        : "Support Requests"
                    }
                    color="#1d7a8c"
                    onPress={() => router.push("/ManageSupportScreen" as any)}
                  />
                </>
              )}
              
              <ActionButton
                icon="flag-outline"
                label="View Reports"
                color="#ff5c93"
                onPress={() => router.push("/ReportManagementScreen" as any)}
              />
              {canManageModeration && (
                <ActionButton
                  icon="shield-checkmark-outline"
                  label="Manage Moderation"
                  color={theme.primary}
                  onPress={() => router.push("/ManageModerationScreen" as any)}
                />
              )}
              {canOpenAiMemory && (
                <ActionButton
                  icon="library-outline"
                  label="Manage B.E.A. Memory"
                  color={theme.accent}
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
              {userRole === "admin" && (
                <ActionButton
                  icon="book-outline"
                  label="Manage Campus FAQ"
                  color={theme.primary}
                  onPress={() => router.push("/ManageCampusFaqScreen" as any)}
                />
              )}
            </>
          )}
        </View>

        {showInlineManagementSections && canOpenManageUsers && (
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
                  <Ionicons name="person-add-outline" size={18} color={theme.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.registerUsersButtonTitle}>Register Users</Text>
                  <Text style={styles.registerUsersButtonText}>Add one account or import your campus CSV</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
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
                <Ionicons name="search" size={18} color={theme.textMuted} />
                <TextInput
                  value={managedUserSearch}
                  onChangeText={setManagedUserSearch}
                  placeholder="Search by name, ID, email, course, or role"
                  placeholderTextColor={theme.textMuted}
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
                        color={selected ? theme.onPrimary : theme.textSecondary}
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
                        color={theme.textSecondary}
                      />
                    </TouchableOpacity>

                    <View style={styles.manageUserActionRow}>
                      <TouchableOpacity
                        style={styles.manageUserActionButton}
                        onPress={() => handleOpenManagedUser(managedUser)}
                        activeOpacity={0.82}
                      >
                        <Ionicons name="person-circle-outline" size={16} color={theme.accent} />
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
          color={isSelected ? theme.onPrimary : theme.primary}
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
                                  color={selected ? theme.onPrimary : getRoleColor(roleOption.value)}
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
                            <ActivityIndicator size="small" color={theme.textSecondary} />
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

        {showInlineManagementSections && canManageModeration && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Moderation Queue</Text>
            {moderationItems.length === 0 ? (
              <View style={styles.comingSoonCard}>
                <Ionicons name="shield-checkmark-outline" size={48} color="#b88f87" />
                <Text style={styles.comingSoonText}>No flagged content waiting for review</Text>
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
                  {item.priority === "critical" && (
                    <View style={styles.reviewCriticalBadge}>
                      <Ionicons name="warning" size={15} color={theme.danger} />
                      <Text style={styles.reviewCriticalText}>
                        PRIORITY SAFETY REVIEW · SELF-HARM / INTENT
                      </Text>
                    </View>
                  )}
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
                        contentFit="cover"
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
                      style={[
                        styles.reviewButton,
                        styles.reviewApprove,
                        (item.realUserId || item.userId) === auth.currentUser?.uid &&
                          styles.reviewButtonDisabled,
                      ]}
                      onPress={() => handleApproveModeration(item)}
                      disabled={
                        moderationBusyId === item.id ||
                        (item.realUserId || item.userId) === auth.currentUser?.uid
                      }
                    >
                      <Text style={styles.reviewApproveText}>
                        {(item.realUserId || item.userId) === auth.currentUser?.uid
                          ? "Own Content"
                          : "Approve"}
                      </Text>
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

        {/* Task 6: Server deletion requests — admin-only review queue. */}
        {userRole === "admin" && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Server Deletion Requests</Text>
            {deletionRequests.length === 0 ? (
              <View style={styles.comingSoonCard}>
                <Ionicons name="trash-outline" size={48} color="#b88f87" />
                <Text style={styles.comingSoonText}>
                  No server deletion requests waiting
                </Text>
              </View>
            ) : (
              deletionRequests.map((request) => (
                <View key={request.id} style={styles.reviewCard}>
                  <View style={styles.reviewHeader}>
                    <View style={styles.reviewTypePill}>
                      <Text style={styles.reviewTypeText}>SERVER</Text>
                    </View>
                    <Text style={styles.reviewAuthor}>by {request.requesterName}</Text>
                  </View>
                  <Text style={styles.reviewBody} numberOfLines={2}>
                    {request.serverName}
                  </Text>
                  {!!request.reason && (
                    <Text style={styles.reviewReason}>{request.reason}</Text>
                  )}
                  <View style={styles.reviewActions}>
                    <TouchableOpacity
                      style={[
                        styles.reviewButton,
                        styles.reviewApprove,
                        deletionBusyId === request.id && styles.reviewButtonDisabled,
                      ]}
                      onPress={() => handleApproveServerDeletion(request)}
                      disabled={deletionBusyId === request.id}
                    >
                      <Text style={styles.reviewApproveText}>Approve &amp; Delete</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.reviewButton,
                        styles.reviewDelete,
                        deletionBusyId === request.id && styles.reviewButtonDisabled,
                      ]}
                      onPress={() => handleRejectServerDeletion(request)}
                      disabled={deletionBusyId === request.id}
                    >
                      <Text style={styles.reviewDeleteText}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </View>
        )}

        {/* Info Card */}
        <View style={styles.infoCard}>
          <Ionicons name="information-circle" size={24} color={theme.accent} />
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
      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmText={dialog?.confirmText ?? "Confirm"}
        cancelText={dialog?.cancelText}
        destructive={dialog?.destructive ?? true}
        singleAction={dialog?.singleAction ?? false}
        onConfirm={() => dialog?.onConfirm()}
        onCancel={() => setDialog(null)}
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

const StatCard: React.FC<StatCardProps> = ({ icon, iconColor, label, value }) => {
  const { styles, theme } = useStyles();
  const tint = onSurface(iconColor, theme);

  return (
    <View style={styles.statCard}>
      <View style={[styles.statIconContainer, { backgroundColor: tint + "20" }]}>
        <Ionicons name={icon} size={24} color={tint} />
      </View>
      <Text style={styles.statValue}>{value.toLocaleString()}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
};

// Action Button Component
interface ActionButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  onPress: () => void;
}

const ActionButton: React.FC<ActionButtonProps> = ({ icon, label, color, onPress }) => {
  const { styles, theme } = useStyles();
  const tint = onSurface(color, theme);

  return (
    <TouchableOpacity 
      style={[styles.actionButton, { borderLeftColor: tint }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.actionIconContainer, { backgroundColor: tint + "20" }]}>
        <Ionicons name={icon} size={20} color={tint} />
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
      <Ionicons name="chevron-forward" size={20} color={theme.textMuted} />
    </TouchableOpacity>
  );
};

interface InsightPillProps {
  label: string;
  value: number;
  color: string;
}

const InsightPill: React.FC<InsightPillProps> = ({ label, value, color }) => {
  const { styles, theme } = useStyles();
  const tint = onSurface(color, theme);

  return (
    <View style={[styles.insightPill, { borderColor: tint + "44" }]}>
      <Text style={[styles.insightPillValue, { color: tint }]}>{value}</Text>
      <Text style={styles.insightPillLabel}>{label}</Text>
    </View>
  );
};

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

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.chrome,
  },
  contentShell: {
    flex: 1,
    backgroundColor: c.surfaceSunken,
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
    backgroundColor: c.chrome,
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderWidth: 1,
    borderColor: c.textSecondary,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    color: c.onChrome,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: c.onChromeMuted,
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
    backgroundColor: c.surface,
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: c.border,
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
    fontSize: 24,
    fontWeight: "bold",
    color: c.textPrimary,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 13,
    color: c.textMuted,
    textAlign: "center",
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: c.primary,
    marginBottom: 12,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderWidth: 1,
    borderColor: c.border,
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
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "600",
  },
  registerUsersButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 16,
    padding: 16,
    marginTop: 12,
    marginBottom: 16,
  },
  registerUsersButtonIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: c.dangerSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  registerUsersButtonTitle: {
    color: c.primary,
    fontWeight: "800",
    fontSize: 14,
  },
  registerUsersButtonText: {
    color: c.textMuted,
    fontSize: 11.5,
    marginTop: 2,
  },
  manageUsersHero: {
    backgroundColor: c.chrome,
    borderRadius: 18,
    padding: 16,
    flexDirection: "row",
    gap: 16,
    borderWidth: 1,
    borderColor: c.textSecondary,
    marginBottom: 16,
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
    color: c.onChrome,
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 4,
  },
  manageUsersHeroText: {
    color: c.onChromeMuted,
    fontSize: 13,
    lineHeight: 20,
  },
  manageUsersInsightRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 16,
  },
  insightPill: {
    minWidth: (SCREEN_WIDTH - 64) / 2,
    flex: 1,
    backgroundColor: c.surface,
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
    color: c.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  manageUsersControls: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
    marginBottom: 10,
    gap: 12,
  },
  searchInputShell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: c.surfaceSunken,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 12,
    minHeight: 46,
  },
  searchInput: {
    flex: 1,
    color: c.textPrimary,
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
    backgroundColor: c.surface,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  filterChipActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  filterChipText: {
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  filterChipTextActive: {
    color: c.onPrimary,
  },
  manageUsersCountText: {
    color: c.textMuted,
    fontSize: 12.5,
    fontWeight: "600",
    marginBottom: 10,
  },
  manageUsersEmptyCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: c.border,
  },
  manageUsersEmptyTitle: {
    color: c.primary,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 10,
  },
  manageUsersEmptyText: {
    color: c.textMuted,
    fontSize: 13,
    marginTop: 6,
    textAlign: "center",
    lineHeight: 20,
  },
  manageUserCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 12,
  },
  manageUserCardExpanded: {
    borderColor: c.accent,
    shadowColor: c.primary,
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
    backgroundColor: c.primary,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  manageUserAvatarImage: {
    width: "100%",
    height: "100%",
  },
  manageUserAvatarText: {
    color: c.onPrimary,
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
    color: c.textPrimary,
    fontSize: 15,
    fontWeight: "800",
  },
  selfBadge: {
    backgroundColor: c.accentSoft,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  selfBadgeText: {
    color: c.accent,
    fontSize: 11,
    fontWeight: "800",
  },
  manageUserMeta: {
    color: c.textMuted,
    fontSize: 12.5,
    lineHeight: 16,
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
    color: c.textMuted,
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
    backgroundColor: c.accentSoft,
    borderWidth: 1,
    borderColor: c.accent,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  manageUserActionText: {
    color: c.accent,
    fontSize: 12.5,
    fontWeight: "700",
  },
  manageUserExpandedPanel: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  manageUserExpandedTitle: {
    color: c.primary,
    fontSize: 14,
    fontWeight: "800",
  },
  manageUserExpandedText: {
    color: c.textMuted,
    fontSize: 12.5,
    lineHeight: 16,
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
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  roleOptionButtonSelected: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  roleOptionText: {
    color: c.primary,
    fontSize: 12.5,
    fontWeight: "800",
  },
  roleOptionTextSelected: {
    color: c.onPrimary,
  },
  manageUserBusyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
  },
  manageUserBusyText: {
    color: c.textSecondary,
    fontSize: 12.5,
    fontWeight: "700",
  },
  manageUserHintText: {
    color: c.textMuted,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 12,
  },
  infoCard: {
    backgroundColor: c.surface,
    borderLeftWidth: 4,
    borderLeftColor: c.accent,
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    flexDirection: "row",
    gap: 12,
    borderWidth: 1,
    borderColor: c.border,
  },
  infoContent: {
    flex: 1,
  },
  infoTitle: {
    color: c.accent,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 6,
  },
  infoText: {
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  comingSoonCard: {
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 32,
    alignItems: "center",
    borderWidth: 1,
    borderColor: c.border,
  },
  comingSoonText: {
    color: c.textMuted,
    fontSize: 14,
    marginTop: 12,
    fontWeight: "500",
  },
  reviewCard: {
    backgroundColor: c.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: c.border,
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
    backgroundColor: c.primary,
  },
  reviewTypeText: {
    color: c.onPrimary,
    fontSize: 11,
    fontWeight: "800",
  },
  reviewAuthor: {
    color: c.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  reviewCriticalBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: c.dangerSoft,
    borderWidth: 1,
    borderColor: c.danger,
  },
  reviewCriticalText: {
    color: c.danger,
    fontSize: 11,
    fontWeight: "800",
  },
  reviewButtonDisabled: {
    opacity: 0.45,
  },
  reviewBody: {
    color: c.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  reviewImage: {
    width: "100%",
    height: 160,
    borderRadius: 10,
    marginTop: 8,
    backgroundColor: c.border,
  },
  reviewReason: {
    color: c.danger,
    fontSize: 12,
    marginTop: 8,
    lineHeight: 16,
  },
  reviewActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
  },
  reviewButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
    borderWidth: 1,
  },
  reviewApprove: {
    backgroundColor: c.successSoft,
    borderColor: c.success,
  },
  reviewProfile: {
    backgroundColor: c.accentSoft,
    borderColor: c.accent,
  },
  reviewDelete: {
    backgroundColor: c.dangerSoft,
    borderColor: c.danger,
  },
  reviewApproveText: {
    color: c.success,
    fontWeight: "700",
  },
  reviewProfileText: {
    color: c.accent,
    fontWeight: "700",
  },
  reviewDeleteText: {
    color: c.danger,
    fontWeight: "700",
  },
  offlineStatusBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.accentSoft,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: c.borderStrong,
  },
  offlineStatusText: {
    fontSize: 12,
    color: c.warning,
    fontWeight: "600",
  },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

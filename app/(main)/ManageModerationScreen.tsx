// app/(main)/ManageModerationScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth, db } from "../../Firebase_configure";
import { feedImage, videoThumb } from "@/utils/cloudinaryImages";
import ImageZoomViewer from "./components/ImageZoomViewer";
import VideoPostMedia from "./components/VideoPostMedia";
import ConfirmDialog from "./components/ConfirmDialog";
import { friendlyModerationReasons } from "@/utils/moderationReasons";
import { ListSkeleton } from "./components/Skeleton";
import { createModerationNotification } from "@/utils/notifications";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import {
  isStaff,
  resolveUserRoleForAuthUser,
  type UserRole,
} from "@/utils/rbac";

type ModerationType = "post" | "poll" | "comment" | "reply" | "message";
type MediaFilter = "all" | "image" | "video" | "url" | "text";

type ModerationItem = {
  id: string;
  type: ModerationType;
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
  videoUrl?: string | null;
  linkUrl?: string | null;
  linkTitle?: string | null;
};

type DialogState = {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  singleAction?: boolean;
  loading?: boolean;
  onConfirm: () => void;
} | null;

const TYPE_META: Record<
  ModerationType,
  { label: string; icon: keyof typeof Ionicons.glyphMap; color: string }
> = {
  post: { label: "Posts", icon: "document-text-outline", color: "#7a3b2e" },
  poll: { label: "Polls", icon: "bar-chart-outline", color: "#6e4aa3" },
  comment: { label: "Comments", icon: "chatbubble-outline", color: "#356a59" },
  reply: { label: "Replies", icon: "return-down-forward-outline", color: "#b86b1d" },
  message: { label: "Messages", icon: "chatbubbles-outline", color: "#8f1d2c" },
};

const MEDIA_FILTER_META: Record<
  MediaFilter,
  { label: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  all: { label: "All media", icon: "grid-outline" },
  image: { label: "Image", icon: "image-outline" },
  video: { label: "Video", icon: "videocam-outline" },
  url: { label: "URL", icon: "link-outline" },
  text: { label: "Text only", icon: "text-outline" },
};

const MODERATION_TYPES = Object.keys(TYPE_META) as ModerationType[];

// Default page size per content type for the "everything else" (non-critical)
// query, and how much each "Load more" tap adds. Critical/safety items are
// never paginated — see the two-query design in the data-fetching effects
// below.
const PAGE_SIZE = 40;

const emptyTypeRecord = <T,>(value: T): Record<ModerationType, T> => ({
  post: value,
  poll: value,
  comment: value,
  reply: value,
  message: value,
});

const getCollectionName = (type: ModerationType) => {
  if (type === "message") return "communityThreadMessages";
  if (type === "reply") return "replies";
  if (type === "comment") return "comments";
  return `${type}s`;
};

const getTextSelector = (type: ModerationType, data: any): string => {
  if (type === "post") return data.content || "[empty post]";
  if (type === "poll") return data.question || "[empty poll]";
  if (type === "comment") return data.text || "[empty comment]";
  if (type === "reply") return data.text || "[empty reply]";
  return data.text || "[empty message]";
};

// Pulls out whatever preview media exists on a pending item — an image, a
// video, or an attached link — so the queue can show a real preview (and so
// the new Image/Video/URL/Text filter chips have something accurate to
// filter on) instead of guessing from moderation categories.
const extractMediaPreview = (
  data: any,
  type: ModerationType,
): Pick<ModerationItem, "imageUrl" | "videoUrl" | "linkUrl" | "linkTitle"> => {
  if (type === "poll") {
    return {
      imageUrl: typeof data.imageUrl === "string" ? data.imageUrl : null,
      videoUrl: null,
      linkUrl: null,
      linkTitle: null,
    };
  }

  const files = Array.isArray(data.files) ? data.files : [];
  const firstImage = files.find(
    (file: any) =>
      typeof file?.mimeType === "string" &&
      file.mimeType.startsWith("image/") &&
      !file.mimeType.includes("gif"),
  );
  const firstVideo = files.find(
    (file: any) => typeof file?.mimeType === "string" && file.mimeType.startsWith("video/"),
  );
  const link = data.link && typeof data.link === "object" ? data.link : null;

  return {
    imageUrl: firstImage?.url || (typeof data.imageUrl === "string" ? data.imageUrl : null),
    videoUrl: firstVideo?.url || null,
    linkUrl: typeof link?.url === "string" ? link.url : null,
    linkTitle: typeof link?.title === "string" ? link.title : null,
  };
};

const mapDocToItem = (
  id: string,
  data: any,
  type: ModerationType,
): ModerationItem => ({
  id,
  type,
  text: getTextSelector(type, data),
  author: data.username || "Unknown",
  realUserId: data.realUserId ?? null,
  userId: data.userId ?? null,
  isAnonymous: data.isAnonymous === true,
  // Cleaned once here so every reader (the queue card and the notification
  // sent to the student) gets plain words instead of raw provider output.
  reasons: friendlyModerationReasons(data.moderationReasons),
  categories: Array.isArray(data.moderationCategories) ? data.moderationCategories : [],
  priority: data.moderationPriority === "critical" ? "critical" : "normal",
  safetyType: data.moderationSafetyType ?? null,
  createdAt: data.createdAt,
  ...extractMediaPreview(data, type),
});

const matchesMediaFilter = (item: ModerationItem, filter: MediaFilter): boolean => {
  if (filter === "all") return true;
  if (filter === "image") return !!item.imageUrl;
  if (filter === "video") return !!item.videoUrl;
  if (filter === "url") return !!item.linkUrl;
  return !item.imageUrl && !item.videoUrl && !item.linkUrl;
};

const selectionKey = (item: Pick<ModerationItem, "type" | "id">) => `${item.type}:${item.id}`;

export default function ManageModerationScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<UserRole | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"all" | ModerationType>("all");
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [dialog, setDialog] = useState<DialogState>(null);

  // Two Firestore listeners per content type: one for critical (self-harm /
  // priority safety) items — always fully loaded, never paginated, so a
  // safety item can never end up hidden behind a "Load more" tap — and one
  // paginated, newest-first listener for everything else, bounded by
  // pageLimit[type]. The two are merged and deduped below.
  const [criticalItems, setCriticalItems] = useState<Record<ModerationType, ModerationItem[]>>(
    emptyTypeRecord([]),
  );
  const [pagedItems, setPagedItems] = useState<Record<ModerationType, ModerationItem[]>>(
    emptyTypeRecord([]),
  );
  const [hasMore, setHasMore] = useState<Record<ModerationType, boolean>>(
    emptyTypeRecord(false),
  );
  const [pageLimit, setPageLimit] = useState<Record<ModerationType, number>>(
    emptyTypeRecord(PAGE_SIZE),
  );
  const [loadingMore, setLoadingMore] = useState(false);

  // Bulk selection
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);

  const canManage = isStaff(role);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setLoading(false);
        router.replace("/(main)/(tabs)/HomeScreen");
        return;
      }

      try {
        const nextRole = await resolveUserRoleForAuthUser(user);
        setRole(nextRole);
        if (!isStaff(nextRole)) {
          router.replace("/(main)/(tabs)/HomeScreen");
        }
      } catch (error) {
        console.error("Error loading moderation role:", error);
        router.replace("/(main)/(tabs)/DashboardScreen");
      } finally {
        setLoading(false);
      }
    });

    return unsubscribe;
  }, [router]);

  // Critical items — unlimited, always fully loaded.
  useEffect(() => {
    if (!canManage || !auth.currentUser) {
      setCriticalItems(emptyTypeRecord([]));
      return;
    }

    const unsubscribers = MODERATION_TYPES.map((type) =>
      onSnapshot(
        query(
          collection(db, getCollectionName(type)),
          where("moderationStatus", "==", "pending"),
          where("moderationPriority", "==", "critical"),
        ),
        (snapshot) => {
          const mapped = snapshot.docs.map((docSnap) =>
            mapDocToItem(docSnap.id, docSnap.data(), type),
          );
          setCriticalItems((previous) => ({ ...previous, [type]: mapped }));
        },
        (error) => {
          console.error(`Error loading critical ${type} queue:`, error);
        },
      ),
    );

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [canManage]);

  // Everything else — paginated, newest first, bounded by pageLimit[type].
  useEffect(() => {
    if (!canManage || !auth.currentUser) {
      setPagedItems(emptyTypeRecord([]));
      setHasMore(emptyTypeRecord(false));
      return;
    }

    const unsubscribers = MODERATION_TYPES.map((type) =>
      onSnapshot(
        query(
          collection(db, getCollectionName(type)),
          where("moderationStatus", "==", "pending"),
          orderBy("createdAt", "desc"),
          limit(pageLimit[type]),
        ),
        (snapshot) => {
          const mapped = snapshot.docs.map((docSnap) =>
            mapDocToItem(docSnap.id, docSnap.data(), type),
          );
          setPagedItems((previous) => ({ ...previous, [type]: mapped }));
          setHasMore((previous) => ({
            ...previous,
            [type]: snapshot.docs.length >= pageLimit[type],
          }));
          setLoadingMore(false);
        },
        (error) => {
          console.error(`Error loading pending ${type} queue:`, error);
          setLoadingMore(false);
        },
      ),
    );

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, pageLimit.post, pageLimit.poll, pageLimit.comment, pageLimit.reply, pageLimit.message]);

  const items = useMemo(() => {
    const merged: ModerationItem[] = [];
    MODERATION_TYPES.forEach((type) => {
      const byId = new Map<string, ModerationItem>();
      criticalItems[type].forEach((item) => byId.set(item.id, item));
      pagedItems[type].forEach((item) => byId.set(item.id, item));
      merged.push(...byId.values());
    });

    return merged.sort((first, second) => {
      if ((first.priority === "critical") !== (second.priority === "critical")) {
        return first.priority === "critical" ? -1 : 1;
      }
      const firstTime = first.createdAt?.toMillis?.() || 0;
      const secondTime = second.createdAt?.toMillis?.() || 0;
      return secondTime - firstTime;
    });
  }, [criticalItems, pagedItems]);

  const counts = useMemo(() => {
    const result: Record<"all" | ModerationType, number> = {
      all: items.length,
      post: 0,
      poll: 0,
      comment: 0,
      reply: 0,
      message: 0,
    };

    items.forEach((item) => {
      result[item.type] += 1;
    });

    return result;
  }, [items]);

  const criticalCount = useMemo(
    () => items.filter((item) => item.priority === "critical").length,
    [items],
  );

  const visibleItems = useMemo(
    () =>
      items
        .filter((item) => activeType === "all" || item.type === activeType)
        .filter((item) => matchesMediaFilter(item, mediaFilter)),
    [activeType, mediaFilter, items],
  );

  const canLoadMore =
    activeType === "all"
      ? MODERATION_TYPES.some((type) => hasMore[type])
      : hasMore[activeType];

  const handleLoadMore = useCallback(() => {
    const typesToExpand = activeType === "all" ? MODERATION_TYPES : [activeType];
    const anyExpandable = typesToExpand.some((type) => hasMore[type]);
    if (!anyExpandable) return;

    setLoadingMore(true);
    setPageLimit((previous) => {
      const next = { ...previous };
      typesToExpand.forEach((type) => {
        if (hasMore[type]) next[type] = previous[type] + PAGE_SIZE;
      });
      return next;
    });
  }, [activeType, hasMore]);

  const showInfo = (title: string, description: string) =>
    setDialog({ title, description, confirmText: "OK", singleAction: true, onConfirm: () => setDialog(null) });

  const approveItem = async (item: ModerationItem) => {
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
      setBusyId(item.id);
      await updateDoc(doc(db, getCollectionName(item.type), item.id), {
        moderationStatus: "approved",
        moderationReviewedAt: serverTimestamp(),
        moderationReviewedBy: reviewerUid,
      });
    } catch (error) {
      console.error("Error approving content:", error);
      showInfo("Error", "Failed to approve content.");
    } finally {
      setBusyId(null);
    }
  };

  const performDelete = async (item: ModerationItem) => {
    try {
      setBusyId(item.id);
      await deleteDoc(doc(db, getCollectionName(item.type), item.id));

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
          console.error("Error sending moderation notification:", error);
        });
      }
    } catch (error) {
      console.error("Error deleting content:", error);
      showInfo("Error", "Failed to delete content.");
    } finally {
      setBusyId(null);
    }
  };

  const deleteItem = (item: ModerationItem) => {
    setDialog({
      title: "Delete Content",
      description: "This will permanently remove the flagged content.",
      confirmText: "Delete",
      cancelText: "Cancel",
      destructive: true,
      onConfirm: async () => {
        setDialogBusy(true);
        await performDelete(item);
        setDialogBusy(false);
        setDialog(null);
      },
    });
  };

  const openUser = (item: ModerationItem) => {
    const targetUserId = item.realUserId || item.userId;

    if (!targetUserId || targetUserId === "anonymous") {
      showInfo("Unavailable", "No linked user profile was found for this content.");
      return;
    }

    if (auth.currentUser?.uid === targetUserId) {
      router.push({
        pathname: "/(main)/(tabs)/ProfileScreen",
        params: { returnTo: "/ManageModerationScreen" },
      });
      return;
    }

    router.push(
      buildUserProfileHref({
        userId: targetUserId,
        returnTo: "/ManageModerationScreen",
      }) as any,
    );
  };

  // ─── Bulk selection ───────────────────────────────────────────────────
  const toggleSelectMode = () => {
    setSelectMode((current) => !current);
    setSelectedKeys(new Set());
  };

  const toggleSelected = (item: ModerationItem) => {
    const key = selectionKey(item);
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedItems = useMemo(
    () => visibleItems.filter((item) => selectedKeys.has(selectionKey(item))),
    [visibleItems, selectedKeys],
  );

  const bulkApprove = () => {
    const reviewerUid = auth.currentUser?.uid;
    if (!reviewerUid || selectedItems.length === 0) return;

    const ownItems = selectedItems.filter(
      (item) => (item.realUserId || item.userId) === reviewerUid,
    );
    const approvable = selectedItems.filter(
      (item) => (item.realUserId || item.userId) !== reviewerUid,
    );

    if (approvable.length === 0) {
      showInfo(
        "Nothing To Approve",
        "Every selected item is your own content — another Teacher, Moderator, or Admin must review it.",
      );
      return;
    }

    setDialog({
      title: `Approve ${approvable.length} item${approvable.length === 1 ? "" : "s"}?`,
      description:
        ownItems.length > 0
          ? `${ownItems.length} selected item${ownItems.length === 1 ? "" : "s"} will be skipped (your own content can't be self-approved).`
          : undefined,
      confirmText: "Approve",
      cancelText: "Cancel",
      destructive: false,
      onConfirm: async () => {
        setBulkBusy(true);
        try {
          const batch = writeBatch(db);
          approvable.forEach((item) => {
            batch.update(doc(db, getCollectionName(item.type), item.id), {
              moderationStatus: "approved",
              moderationReviewedAt: serverTimestamp(),
              moderationReviewedBy: reviewerUid,
            });
          });
          await batch.commit();
          toggleSelectMode();
          setDialog(null);
        } catch (error) {
          console.error("Error bulk-approving content:", error);
          setDialog(null);
          showInfo("Error", "Failed to approve the selected items.");
        } finally {
          setBulkBusy(false);
        }
      },
    });
  };

  const bulkDelete = () => {
    if (selectedItems.length === 0) return;

    setDialog({
      title: `Delete ${selectedItems.length} item${selectedItems.length === 1 ? "" : "s"}?`,
      description: "This will permanently remove all selected flagged content.",
      confirmText: "Delete",
      cancelText: "Cancel",
      destructive: true,
      onConfirm: async () => {
        setBulkBusy(true);
        try {
          const batch = writeBatch(db);
          selectedItems.forEach((item) => {
            batch.delete(doc(db, getCollectionName(item.type), item.id));
          });
          await batch.commit();

          // Best-effort notifications, same as the single-item delete flow —
          // fired individually after the batch so one failure can't block
          // the others or the delete itself.
          selectedItems.forEach((item) => {
            const recipientId = item.realUserId || item.userId;
            if (
              recipientId &&
              recipientId !== "anonymous" &&
              (item.type === "post" || item.type === "comment" || item.type === "reply")
            ) {
              createModerationNotification({
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
                console.error("Error sending moderation notification:", error);
              });
            }
          });

          toggleSelectMode();
          setDialog(null);
        } catch (error) {
          console.error("Error bulk-deleting content:", error);
          setDialog(null);
          showInfo("Error", "Failed to delete the selected items.");
        } finally {
          setBulkBusy(false);
        }
      },
    });
  };

  const renderCard = useCallback(
    ({ item }: { item: ModerationItem }) => (
      <ModerationCard
        item={item}
        meta={TYPE_META[item.type]}
        isOwnContent={(item.realUserId || item.userId) === auth.currentUser?.uid}
        isBusy={busyId === item.id}
        selectMode={selectMode}
        isSelected={selectedKeys.has(selectionKey(item))}
        onToggleSelect={() => toggleSelected(item)}
        onApprove={() => approveItem(item)}
        onDelete={() => deleteItem(item)}
        onOpenUser={() => openUser(item)}
        onPreviewImage={() => item.imageUrl && setViewerUrl(item.imageUrl)}
        onPreviewVideo={() => item.videoUrl && setPreviewVideoUrl(item.videoUrl)}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId, selectMode, selectedKeys],
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <ListSkeleton
          count={5}
          showAvatar={false}
          contentStyle={styles.skeletonContent}
          rowStyle={styles.skeletonCard}
        />
      </SafeAreaView>
    );
  }

  if (!canManage) return null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.topBar}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          activeOpacity={0.8}
        >
          <Ionicons name="arrow-back" size={21} color="#fffaf6" />
        </TouchableOpacity>
        <View style={styles.topBarCopy}>
          <Text style={styles.topBarEyebrow}>STAFF WORKSPACE</Text>
          <Text style={styles.topBarTitle}>Manage Moderation</Text>
        </View>
        <TouchableOpacity
          style={[styles.selectModeButton, selectMode && styles.selectModeButtonActive]}
          onPress={toggleSelectMode}
          activeOpacity={0.8}
        >
          <Ionicons
            name={selectMode ? "close" : "checkmark-done-outline"}
            size={19}
            color={selectMode ? "#5f0909" : "#fffaf6"}
          />
        </TouchableOpacity>
        <View style={styles.queueBadge}>
          <Text style={styles.queueBadgeText}>{items.length}</Text>
        </View>
      </View>

      <FlatList
        style={styles.body}
        contentContainerStyle={styles.content}
        data={visibleItems}
        keyExtractor={(item) => selectionKey(item)}
        renderItem={renderCard}
        showsVerticalScrollIndicator={false}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews={Platform.OS === "android"}
        ListHeaderComponent={
          <>
            <View style={styles.heroCard}>
              <View style={styles.heroIcon}>
                <Ionicons name="shield-checkmark-outline" size={29} color="#d39a32" />
              </View>
              <View style={styles.heroCopy}>
                <Text style={styles.heroTitle}>Review queue</Text>
                <Text style={styles.heroText}>
                  Review pending campus content in one focused space. Priority safety
                  items stay at the top and are never hidden behind pagination —
                  existing approval and deletion rules are preserved.
                </Text>
              </View>
            </View>

            <View style={styles.metricRow}>
              <View style={styles.metricCard}>
                <View style={[styles.metricIcon, { backgroundColor: "#f3e5df" }]}>
                  <Ionicons name="hourglass-outline" size={18} color="#7a3b2e" />
                </View>
                <Text style={styles.metricValue}>{items.length}</Text>
                <Text style={styles.metricLabel}>Loaded</Text>
              </View>
              <View style={styles.metricCard}>
                <View style={[styles.metricIcon, { backgroundColor: "#fde6e3" }]}>
                  <Ionicons name="warning-outline" size={18} color="#a63b32" />
                </View>
                <Text style={styles.metricValue}>{criticalCount}</Text>
                <Text style={styles.metricLabel}>Priority</Text>
              </View>
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterRow}
            >
              <FilterChip
                label="All"
                count={counts.all}
                active={activeType === "all"}
                onPress={() => setActiveType("all")}
                icon="apps-outline"
                color="#5f0909"
              />
              {MODERATION_TYPES.map((type) => (
                <FilterChip
                  key={type}
                  label={TYPE_META[type].label}
                  count={counts[type]}
                  active={activeType === type}
                  onPress={() => setActiveType(type)}
                  icon={TYPE_META[type].icon}
                  color={TYPE_META[type].color}
                />
              ))}
            </ScrollView>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterRow}
            >
              {(Object.keys(MEDIA_FILTER_META) as MediaFilter[]).map((filter) => (
                <FilterChip
                  key={filter}
                  label={MEDIA_FILTER_META[filter].label}
                  active={mediaFilter === filter}
                  onPress={() => setMediaFilter(filter)}
                  icon={MEDIA_FILTER_META[filter].icon}
                  color="#5f0909"
                />
              ))}
            </ScrollView>

            <View style={styles.sectionHeading}>
              <View>
                <Text style={styles.sectionTitle}>
                  {activeType === "all" ? "Pending content" : TYPE_META[activeType].label}
                </Text>
                <Text style={styles.sectionSubtitle}>
                  {visibleItems.length} item{visibleItems.length === 1 ? "" : "s"} loaded
                  {selectMode ? " · tap a card to select" : ""}
                </Text>
              </View>
              <Ionicons name="funnel-outline" size={19} color="#8f6a60" />
            </View>
          </>
        }
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <Ionicons name="shield-checkmark-outline" size={31} color="#6f8d79" />
            </View>
            <Text style={styles.emptyTitle}>Queue is clear</Text>
            <Text style={styles.emptyText}>
              No content in this filter is waiting for moderation.
            </Text>
          </View>
        }
        ListFooterComponent={
          canLoadMore ? (
            <TouchableOpacity
              style={styles.loadMoreButton}
              onPress={handleLoadMore}
              disabled={loadingMore}
              activeOpacity={0.85}
            >
              {loadingMore ? (
                <ActivityIndicator size="small" color="#5f0909" />
              ) : (
                <>
                  <Ionicons name="chevron-down-circle-outline" size={17} color="#5f0909" />
                  <Text style={styles.loadMoreText}>Load more</Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <View style={{ height: 20 }} />
          )
        }
      />

      {selectMode && selectedKeys.size > 0 && (
        <View style={styles.bulkBar}>
          <Text style={styles.bulkBarText}>
            {selectedKeys.size} selected
          </Text>
          <View style={styles.bulkBarActions}>
            <TouchableOpacity
              style={[styles.bulkActionButton, styles.bulkDeleteButton]}
              onPress={bulkDelete}
              disabled={bulkBusy}
              activeOpacity={0.85}
            >
              <Ionicons name="trash-outline" size={16} color="#9b2f2f" />
              <Text style={styles.bulkDeleteText}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.bulkActionButton, styles.bulkApproveButton]}
              onPress={bulkApprove}
              disabled={bulkBusy}
              activeOpacity={0.85}
            >
              {bulkBusy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
              )}
              <Text style={styles.bulkApproveText}>Approve</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <ImageZoomViewer
        images={viewerUrl ? [viewerUrl] : []}
        startIndex={0}
        visible={!!viewerUrl}
        onClose={() => setViewerUrl(null)}
        showActions={false}
      />

      {previewVideoUrl && (
        <View style={styles.videoPreviewOverlay}>
          <TouchableOpacity
            style={styles.videoPreviewClose}
            onPress={() => setPreviewVideoUrl(null)}
            hitSlop={10}
          >
            <Ionicons name="close-circle" size={32} color="#fffaf6" />
          </TouchableOpacity>
          {/* Reviewing flagged content — start with audio so the moderator
              hears it immediately (not the feed's muted-autoplay default). */}
          <VideoPostMedia uri={previewVideoUrl} width={340} startMuted={false} />
        </View>
      )}

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmText={dialog?.confirmText ?? "Confirm"}
        cancelText={dialog?.cancelText}
        destructive={dialog?.destructive ?? true}
        singleAction={dialog?.singleAction ?? false}
        loading={!!dialog?.loading || bulkBusy || dialogBusy}
        onConfirm={() => dialog?.onConfirm()}
        onCancel={() => setDialog(null)}
      />
    </SafeAreaView>
  );
}

// Extracted to a top-level component (rather than an inline closure inside
// .map()) so React.memo actually has a stable reference to memoize against —
// this plus FlatList virtualization is what keeps scrolling smooth once the
// queue has a lot of items.
const ModerationCard = React.memo(function ModerationCard({
  item,
  meta,
  isOwnContent,
  isBusy,
  selectMode,
  isSelected,
  onToggleSelect,
  onApprove,
  onDelete,
  onOpenUser,
  onPreviewImage,
  onPreviewVideo,
}: {
  item: ModerationItem;
  meta: { label: string; icon: keyof typeof Ionicons.glyphMap; color: string };
  isOwnContent: boolean;
  isBusy: boolean;
  selectMode: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onApprove: () => void;
  onDelete: () => void;
  onOpenUser: () => void;
  onPreviewImage: () => void;
  onPreviewVideo: () => void;
}) {
  const [videoThumbFailed, setVideoThumbFailed] = useState(false);
  const videoThumbUrl = !videoThumbFailed ? videoThumb(item.videoUrl, 260) : undefined;

  return (
    <TouchableOpacity
      style={[
        styles.reviewCard,
        item.priority === "critical" && styles.reviewCardCritical,
        isSelected && styles.reviewCardSelected,
      ]}
      activeOpacity={selectMode ? 0.75 : 1}
      onPress={selectMode ? onToggleSelect : undefined}
    >
      <View style={styles.reviewHeader}>
        {selectMode && (
          <View style={[styles.selectCircle, isSelected && styles.selectCircleActive]}>
            {isSelected && <Ionicons name="checkmark" size={13} color="#fffaf6" />}
          </View>
        )}
        <View style={[styles.typePill, { backgroundColor: meta.color + "12" }]}>
          <Ionicons name={meta.icon} size={14} color={meta.color} />
          <Text style={[styles.typeText, { color: meta.color }]}>
            {meta.label.slice(0, -1).toUpperCase()}
          </Text>
        </View>
        <Text style={styles.authorText} numberOfLines={1}>
          by {item.author}
        </Text>
      </View>

      {item.priority === "critical" && (
        <View style={styles.criticalBanner}>
          <Ionicons name="warning" size={15} color="#8d2d28" />
          <Text style={styles.criticalText}>
            PRIORITY SAFETY REVIEW ·{" "}
            {item.safetyType === "weapon"
              ? "WEAPON-RELATED TERM"
              : item.safetyType === "self-harm"
                ? "SELF-HARM / INTENT"
                : "FLAGGED FOR REVIEW"}
          </Text>
        </View>
      )}

      <Text style={styles.reviewBody} numberOfLines={5}>
        {item.text}
      </Text>

      {!!item.imageUrl && (
        <TouchableOpacity
          activeOpacity={0.9}
          disabled={selectMode}
          onPress={onPreviewImage}
        >
          <Image
            source={{ uri: feedImage(item.imageUrl, 260) }}
            style={styles.reviewImage}
            contentFit="cover"
          />
          <View style={styles.imageHint}>
            <Ionicons name="expand-outline" size={14} color="#fff" />
            <Text style={styles.imageHintText}>Preview</Text>
          </View>
        </TouchableOpacity>
      )}

      {!!item.videoUrl && (
        <TouchableOpacity
          activeOpacity={0.9}
          disabled={selectMode}
          onPress={onPreviewVideo}
        >
          {videoThumbUrl ? (
            <Image
              source={{ uri: videoThumbUrl }}
              style={styles.reviewImage}
              contentFit="cover"
              onError={() => setVideoThumbFailed(true)}
            />
          ) : (
            <View style={[styles.reviewImage, styles.videoPlaceholder]} />
          )}
          <View style={styles.videoPlayBadge}>
            <Ionicons name="play-circle" size={40} color="#fffaf6" />
          </View>
          <View style={styles.imageHint}>
            <Ionicons name="videocam-outline" size={14} color="#fff" />
            <Text style={styles.imageHintText}>Video</Text>
          </View>
        </TouchableOpacity>
      )}

      {!!item.linkUrl && (
        <View style={styles.linkPreview}>
          <Ionicons name="link-outline" size={15} color="#5f0909" />
          <Text style={styles.linkPreviewText} numberOfLines={1}>
            {item.linkTitle || item.linkUrl}
          </Text>
        </View>
      )}

      {!!item.reasons.length && (
        <View style={styles.reasonBox}>
          <Ionicons name="alert-circle-outline" size={15} color="#9a473c" />
          <View style={styles.reasonChips}>
            {item.reasons.map((reason) => (
              <View key={reason} style={styles.reasonChip}>
                <Text style={styles.reasonText}>{reason}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {!selectMode && (
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.actionButton, styles.profileButton]}
            onPress={onOpenUser}
            activeOpacity={0.82}
          >
            <Ionicons name="person-circle-outline" size={16} color="#79521c" />
            <Text style={styles.profileButtonText}>
              {item.isAnonymous ? "Real user" : "Profile"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.actionButton,
              styles.approveButton,
              isOwnContent && styles.disabledButton,
            ]}
            onPress={onApprove}
            disabled={isBusy || isOwnContent}
            activeOpacity={0.82}
          >
            {isBusy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
            )}
            <Text style={styles.approveButtonText}>
              {isOwnContent ? "Own content" : "Approve"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, styles.deleteButton]}
            onPress={onDelete}
            disabled={isBusy}
            activeOpacity={0.82}
          >
            <Ionicons name="trash-outline" size={16} color="#9b2f2f" />
          </TouchableOpacity>
        </View>
      )}
    </TouchableOpacity>
  );
});

function FilterChip({
  label,
  count,
  active,
  onPress,
  icon,
  color,
}: {
  label: string;
  count?: number;
  active: boolean;
  onPress: () => void;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.filterChip, active && styles.filterChipActive]}
      onPress={onPress}
      activeOpacity={0.82}
    >
      <Ionicons name={icon} size={14} color={active ? "#fffaf6" : color} />
      <Text style={[styles.filterText, active && styles.filterTextActive]}>
        {label}
      </Text>
      {typeof count === "number" && (
        <View style={[styles.filterCount, active && styles.filterCountActive]}>
          <Text
            style={[
              styles.filterCountText,
              active && styles.filterCountTextActive,
            ]}
          >
            {count}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#5f0909" },
  topBar: {
    minHeight: 66,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#5f0909",
    borderBottomWidth: 1,
    borderBottomColor: "#7e2724",
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  topBarCopy: { flex: 1 },
  topBarEyebrow: {
    color: "#d9b27a",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.1,
  },
  topBarTitle: {
    color: "#fffaf6",
    fontSize: 22,
    fontWeight: "900",
    marginTop: 2,
  },
  selectModeButton: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  selectModeButtonActive: {
    backgroundColor: "#e2aa45",
  },
  queueBadge: {
    minWidth: 40,
    height: 40,
    paddingHorizontal: 10,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#e2aa45",
  },
  queueBadgeText: { color: "#5f0909", fontSize: 14, fontWeight: "900" },
  body: { flex: 1, backgroundColor: "#f8f3ef" },
  content: { padding: 16, paddingBottom: 100 },
  heroCard: {
    flexDirection: "row",
    gap: 14,
    padding: 18,
    borderRadius: 22,
    backgroundColor: "#fffaf6",
    borderWidth: 1,
    borderColor: "#ead8ce",
    marginBottom: 14,
  },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    backgroundColor: "#f7ead4",
    alignItems: "center",
    justifyContent: "center",
  },
  heroCopy: { flex: 1 },
  heroTitle: { color: "#4c1b14", fontSize: 18, fontWeight: "900" },
  heroText: {
    color: "#87685f",
    fontSize: 12.5,
    lineHeight: 19,
    marginTop: 5,
  },
  metricRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
  metricCard: {
    flex: 1,
    backgroundColor: "#fffaf6",
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#eee1da",
    padding: 14,
  },
  metricIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  metricValue: { color: "#4c1b14", fontSize: 22, fontWeight: "900" },
  metricLabel: {
    color: "#92736a",
    fontSize: 11.5,
    fontWeight: "700",
    marginTop: 2,
  },
  filterRow: { gap: 8, paddingBottom: 12, paddingRight: 12 },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#e7d5cc",
    backgroundColor: "#fffaf6",
    paddingLeft: 11,
    paddingRight: 8,
    paddingVertical: 8,
  },
  filterChipActive: { backgroundColor: "#6e1717", borderColor: "#6e1717" },
  filterText: { color: "#70483e", fontSize: 11.5, fontWeight: "800" },
  filterTextActive: { color: "#fffaf6" },
  filterCount: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f0e3dc",
  },
  filterCountActive: { backgroundColor: "rgba(255,255,255,0.18)" },
  filterCountText: { color: "#7a3b2e", fontSize: 10.5, fontWeight: "900" },
  filterCountTextActive: { color: "#fffaf6" },
  sectionHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    marginTop: 6,
  },
  sectionTitle: { color: "#4c1b14", fontSize: 17, fontWeight: "900" },
  sectionSubtitle: { color: "#98766d", fontSize: 11.5, marginTop: 3 },
  reviewCard: {
    backgroundColor: "#fffaf6",
    borderRadius: 19,
    borderWidth: 1,
    borderColor: "#eadfd9",
    padding: 14,
    marginBottom: 11,
  },
  skeletonContent: { padding: 16 },
  skeletonCard: {
    backgroundColor: "#fffaf6",
    borderRadius: 19,
    borderWidth: 1,
    borderColor: "#eadfd9",
    padding: 16,
    marginBottom: 11,
  },
  reviewCardCritical: { borderColor: "#dfa8a2", backgroundColor: "#fff9f7" },
  reviewCardSelected: { borderColor: "#e2aa45", borderWidth: 2, backgroundColor: "#fffaf0" },
  reviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  selectCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#d7bdae",
    alignItems: "center",
    justifyContent: "center",
  },
  selectCircleActive: { backgroundColor: "#e2aa45", borderColor: "#e2aa45" },
  typePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  typeText: { fontSize: 10.5, fontWeight: "900" },
  authorText: {
    flex: 1,
    textAlign: "right",
    color: "#95766d",
    fontSize: 11.5,
    fontWeight: "700",
  },
  criticalBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#fde6e3",
    borderWidth: 1,
    borderColor: "#e7b4ae",
    borderRadius: 11,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  criticalText: { flex: 1, color: "#8d2d28", fontSize: 10.5, fontWeight: "900" },
  reviewBody: { color: "#4c1b14", fontSize: 13.5, lineHeight: 20 },
  reviewImage: {
    width: "100%",
    height: 172,
    borderRadius: 14,
    marginTop: 12,
    backgroundColor: "#f0e2da",
  },
  videoPlaceholder: { backgroundColor: "#2c2320" },
  videoPlayBadge: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    marginTop: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  imageHint: {
    position: "absolute",
    right: 9,
    bottom: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 6,
    backgroundColor: "rgba(45,18,14,0.72)",
  },
  imageHintText: { color: "#fff", fontSize: 10.5, fontWeight: "800" },
  linkPreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f7ead4",
    borderRadius: 11,
    padding: 10,
    marginTop: 12,
  },
  linkPreviewText: { flex: 1, color: "#5f0909", fontSize: 12, fontWeight: "700" },
  reasonBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    backgroundColor: "#fbf1ed",
    borderRadius: 11,
    padding: 10,
    marginTop: 11,
  },
  reasonChips: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 },
  reasonChip: {
    backgroundColor: "#f6e2db",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  reasonText: { color: "#9a473c", fontSize: 11, lineHeight: 16 },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 13,
  },
  actionButton: {
    minHeight: 39,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 11,
  },
  profileButton: {
    backgroundColor: "#faf0de",
    borderWidth: 1,
    borderColor: "#e0bf80",
  },
  profileButtonText: { color: "#79521c", fontSize: 11.5, fontWeight: "800" },
  approveButton: { flex: 1, backgroundColor: "#356a59" },
  approveButtonText: { color: "#fff", fontSize: 11.5, fontWeight: "900" },
  deleteButton: {
    width: 42,
    backgroundColor: "#fff0ee",
    borderWidth: 1,
    borderColor: "#efc4bf",
  },
  disabledButton: { opacity: 0.45 },
  loadMoreButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: "#fffaf6",
    borderWidth: 1,
    borderColor: "#e7d5cc",
    borderRadius: 14,
    paddingVertical: 13,
    marginTop: 4,
  },
  loadMoreText: { color: "#5f0909", fontSize: 13, fontWeight: "800" },
  bulkBar: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#2c1410",
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  bulkBarText: { color: "#fffaf6", fontSize: 13.5, fontWeight: "800" },
  bulkBarActions: { flexDirection: "row", gap: 8 },
  bulkActionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 11,
    paddingHorizontal: 13,
    height: 38,
  },
  bulkDeleteButton: { backgroundColor: "rgba(255,255,255,0.12)" },
  bulkDeleteText: { color: "#ffb3ab", fontSize: 12, fontWeight: "800" },
  bulkApproveButton: { backgroundColor: "#356a59" },
  bulkApproveText: { color: "#fff", fontSize: 12, fontWeight: "900" },
  videoPreviewOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(10,4,3,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  videoPreviewClose: {
    position: "absolute",
    top: 54,
    right: 20,
    zIndex: 2,
  },
  emptyCard: {
    alignItems: "center",
    padding: 30,
    borderRadius: 19,
    backgroundColor: "#fffaf6",
    borderWidth: 1,
    borderColor: "#eadfd9",
  },
  emptyIcon: {
    width: 58,
    height: 58,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#eaf1ec",
  },
  emptyTitle: { color: "#4c1b14", fontSize: 15, fontWeight: "900", marginTop: 12 },
  emptyText: { color: "#98766d", fontSize: 11.5, lineHeight: 17, textAlign: "center", marginTop: 5 },
  loadingState: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { color: "#f2d7c8", fontSize: 12.5, fontWeight: "700", marginTop: 12 },
});

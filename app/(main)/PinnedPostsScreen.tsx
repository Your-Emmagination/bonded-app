// app/(main)/PinnedPostsScreen.tsx
//
// Pinned — Important Announcements. Everything staff have pinned, as full
// cards you can like, comment on and vote in: "Ending soon" (pins with an end,
// the one ending first on top) and "Always pinned" (no end, newest first).
// Opened from the bar at the top of Home. Built like Saved Posts.
import { useThemeColors } from "@/contexts/ThemeContext";
import {
  markPinsSeen,
  pinUrgency,
  unpinContent,
  usePinnedContent,
  type PinnedItem,
  type PinUrgency,
} from "@/utils/pinnedPosts";
import { likePost } from "@/utils/likePost";
import { addPollOption, isPollClosed, submitPollVote } from "@/utils/pollVoting";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import { getTimeAgo as formatTimeAgo, useRelativeTimeNow } from "@/utils/relativeTime";
import type { ThemeTokens } from "@/utils/theme";
import { showAppToast } from "@/utils/toastEvents";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useIsFocused, useRouter } from "expo-router";
import { onAuthStateChanged, type User } from "firebase/auth";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, SectionList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth } from "../../Firebase_configure";
import ImageZoomViewer from "./components/ImageZoomViewer";
import PollCard from "./components/PollCard";
import PostCard from "./components/PostCard";
import { FeedSkeleton } from "./components/Skeleton";

const PINNED_RETURN_ROUTE = "/(main)/PinnedPostsScreen";
const STAFF_ROLES = ["admin", "teacher", "moderator"];

type PostCardPost = React.ComponentProps<typeof PostCard>["post"];
type PollCardPoll = React.ComponentProps<typeof PollCard>["poll"];

type Section = { key: "soon" | "always"; title: string; data: PinnedItem[] };

export default function PinnedPostsScreen() {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const relativeTimeNow = useRelativeTimeNow();
  const currentUserRole = useCurrentUserRole();
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const { items, loading } = usePinnedContent(!!user);
  const isStaff = STAFF_ROLES.includes(currentUserRole || "");
  // Videos play (muted) only while their card is on screen and this page is
  // showing, as on Home; a tap opens them fullscreen with sound.
  const screenFocused = useIsFocused();
  const [visibleKeys, setVisibleKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [viewabilityConfig] = useState(() => ({ itemVisiblePercentThreshold: 50, minimumViewTime: 50 }));
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: { key: string }[] }) => {
    setVisibleKeys(new Set(viewableItems.map((entry) => entry.key)));
  }, []);

  const [viewerImages, setViewerImages] = useState<string[]>([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerVisible, setViewerVisible] = useState(false);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  const sections = useMemo<Section[]>(() => {
    const soon = items.filter((item) => item.endsAtMs !== null);
    const always = items.filter((item) => item.endsAtMs === null);
    return [
      { key: "soon" as const, title: "Ending soon", data: soon },
      { key: "always" as const, title: "Always pinned", data: always },
    ].filter((section) => section.data.length > 0);
  }, [items]);

  // Opening the page clears the red dot on Home's bar until something new is pinned.
  const pinIds = useMemo(() => items.map((item) => `${item.kind}:${item.id}`), [items]);
  const uid = user?.uid;
  useFocusEffect(
    useCallback(() => {
      if (uid && !loading) void markPinsSeen(uid, pinIds);
    }, [loading, pinIds, uid]),
  );

  const getTimeAgo = useCallback(
    (timestamp: any) => formatTimeAgo(timestamp, relativeTimeNow),
    [relativeTimeNow],
  );

  // Saved the way Home saves likes; the live list shows it at once.
  const handleLike = useCallback(
    (postId: string, currentLikedBy: string[] = []) => {
      const post = items.find((item) => item.kind === "post" && item.id === postId)?.data;
      if (!user || !post) return;
      likePost(post, user, !currentLikedBy.includes(user.uid), () =>
        showAppToast({ message: "Couldn't save your like. Try again." }),
      );
    },
    [items, user],
  );

  const handleVote = useCallback(
    async (pollId: string, optionIndex: number) => {
      if (!user) return;
      const poll = items.find((item) => item.kind === "poll" && item.id === pollId)?.data;
      if (!poll?.options) return;
      try {
        await submitPollVote(
          pollId,
          {
            options: poll.options as { voters?: string[] }[],
            allowMultiple: poll.allowMultiple,
            maxSelections: poll.maxSelections,
            expiresAt: poll.expiresAt,
          },
          user.uid,
          optionIndex,
        );
      } catch (error) {
        console.error("[pinned] vote failed:", error);
        showAppToast({ message: "Couldn't save your vote. Try again." });
      }
    },
    [items, user],
  );

  const handleAddOption = useCallback(async (pollId: string, text: string) => {
    try {
      const result = await addPollOption(pollId, text);
      if (result === "added") showAppToast({ message: "Option added. You can vote for it now." });
      else if (result === "closed") showAppToast({ message: "This poll has already closed." });
      else if (result === "empty") showAppToast({ message: "Type an option first." });
    } catch (error) {
      console.error("[pinned] add option failed:", error);
      showAppToast({ message: "Couldn't add the option. Try again." });
    }
  }, []);

  // Everything here is already pinned, so the card's pin action unpins.
  const handleUnpin = useCallback(
    async (kind: "post" | "poll", id: string, shouldPin: boolean) => {
      if (shouldPin || !isStaff) return;
      try {
        await unpinContent(kind, id);
        showAppToast({ message: "Unpinned. It stays in the feed." });
      } catch (error) {
        console.error("[pinned] unpin failed:", error);
        showAppToast({ message: "Couldn't unpin it. Try again." });
      }
    },
    [isStaff],
  );
  const unpinPost = useCallback((id: string, shouldPin: boolean) => handleUnpin("post", id, shouldPin), [handleUnpin]);
  const unpinPoll = useCallback((id: string, shouldPin: boolean) => handleUnpin("poll", id, shouldPin), [handleUnpin]);

  const openImages = useCallback((images: string[], startIndex: number) => {
    setViewerImages(images);
    setViewerIndex(startIndex);
    setViewerVisible(true);
  }, []);

  const handleFilePress = useCallback(
    (url: string, mimeType: string) => {
      if (mimeType.startsWith("image/")) {
        openImages([url], 0);
        return;
      }
      const fileUrl =
        mimeType.includes("pdf") && url.includes("cloudinary.com")
          ? url.replace("/upload/", "/upload/fl_attachment/")
          : url;
      Linking.openURL(fileUrl).catch((error) => console.error("[pinned] open file failed:", error));
    },
    [openImages],
  );

  const openProfile = useCallback(
    (targetId?: string) => {
      if (!targetId) return;
      if (targetId === "self" || targetId === user?.uid) {
        router.push({ pathname: "/(main)/(tabs)/ProfileScreen", params: { returnTo: PINNED_RETURN_ROUTE } });
        return;
      }
      router.push(
        targetId.startsWith("/UserProfileScreen?")
          ? `${targetId}&returnTo=${encodeURIComponent(PINNED_RETURN_ROUTE)}`
          : (buildUserProfileHref({ userId: targetId, returnTo: PINNED_RETURN_ROUTE }) as any),
      );
    },
    [router, user?.uid],
  );
  const openPollAuthor = useCallback(
    (userId?: string, isAnonymous?: boolean) => {
      if (!isAnonymous) openProfile(userId);
    },
    [openProfile],
  );

  const renderItem = useCallback(
    ({ item }: { item: PinnedItem }) => {
      const urgency = pinUrgency(item.endsAtMs, relativeTimeNow);
      return (
        <View style={styles.item}>
          <View style={styles.itemTop}>
            <UrgencyChip urgency={urgency} styles={styles} theme={theme} />
          </View>
          {item.kind === "post" ? (
            <PostCard
              post={item.data as unknown as PostCardPost}
              isLiked={!!user && (item.data.likedBy as string[] | undefined)?.includes(user.uid) === true}
              currentUserRole={currentUserRole}
              currentUserId={user?.uid}
              onLike={handleLike}
              onProfileClick={openProfile}
              onTagClick={openProfile}
              onImagePress={openImages}
              onFilePress={handleFilePress}
              getTimeAgo={getTimeAgo}
              canPin={isStaff}
              onTogglePin={unpinPost}
              videoCardVisible={screenFocused && !viewerVisible && visibleKeys.has(`post:${item.id}`)}
            />
          ) : (
            <PollCard
              poll={item.data as unknown as PollCardPoll}
              currentUserId={user?.uid}
              currentUserRole={currentUserRole}
              userRole={String(item.data.userRole || item.data.role || "student")}
              onVote={handleVote}
              onAddOption={handleAddOption}
              onProfileClick={openPollAuthor}
              onImagePress={openImages}
              getTimeAgo={getTimeAgo}
              isPollExpired={isPollClosed}
              onTogglePin={isStaff ? unpinPoll : undefined}
            />
          )}
        </View>
      );
    },
    [
      currentUserRole,
      getTimeAgo,
      handleAddOption,
      handleFilePress,
      handleLike,
      handleVote,
      isStaff,
      openImages,
      openPollAuthor,
      openProfile,
      relativeTimeNow,
      screenFocused,
      styles,
      theme,
      unpinPoll,
      unpinPost,
      user,
      viewerVisible,
      visibleKeys,
    ],
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>
            Pinned{items.length > 0 ? <Text style={styles.headerCount}> · {items.length}</Text> : null}
          </Text>
          <Text style={styles.headerSubtitle}>Important Announcements</Text>
        </View>
      </View>

      {loading ? (
        <FeedSkeleton count={3} />
      ) : sections.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="pin-outline" size={40} color={theme.textMuted} />
          <Text style={styles.emptyTitle}>Nothing is pinned right now</Text>
          <Text style={styles.emptyText}>
            {isStaff
              ? "Pin a post or poll from its ⋯ menu and it shows up here."
              : "Important announcements from your school will show up here."}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => `${item.kind}:${item.id}`}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Ionicons
                name={section.key === "soon" ? "time-outline" : "pin-outline"}
                size={14}
                color={section.key === "soon" ? theme.danger : theme.textMuted}
              />
              <Text style={[styles.sectionTitle, section.key === "soon" && { color: theme.danger }]}>
                {section.title} · {section.data.length}
              </Text>
            </View>
          )}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.listContent}
          // Comments open from inside these cards; "handled" keeps the first
          // tap on Send from only closing the keyboard.
          keyboardShouldPersistTaps="handled"
          initialNumToRender={4}
          windowSize={7}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
        />
      )}

      <ImageZoomViewer
        images={viewerImages}
        startIndex={viewerIndex}
        visible={viewerVisible}
        onClose={() => setViewerVisible(false)}
        showActions={false}
      />
    </SafeAreaView>
  );
}

function UrgencyChip({
  urgency,
  styles,
  theme,
}: {
  urgency: PinUrgency;
  styles: ReturnType<typeof makeStyles>;
  theme: ThemeTokens;
}) {
  const tone = {
    red: { background: theme.dangerSoft, color: theme.danger, icon: "alert-circle" as const },
    amber: { background: theme.accentSoft, color: theme.warning, icon: "time" as const },
    date: { background: theme.surfaceSunken, color: theme.textSecondary, icon: "calendar" as const },
    none: { background: theme.accentSoft, color: theme.primary, icon: "pin" as const },
  }[urgency.tone];
  return (
    <View style={[styles.chip, { backgroundColor: tone.background }]}>
      <Ionicons name={tone.icon} size={12} color={tone.color} />
      <Text style={[styles.chipText, { color: tone.color }]}>{urgency.label}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    backButton: { padding: 8 },
    headerText: { flex: 1 },
    headerTitle: { color: c.textPrimary, fontSize: 19, fontWeight: "800" },
    headerCount: { color: c.textMuted, fontWeight: "600" },
    headerSubtitle: { color: c.primary, fontSize: 12.5, fontWeight: "700", marginTop: 1 },
    listContent: { paddingBottom: 32 },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 16,
      paddingTop: 18,
      paddingBottom: 6,
    },
    sectionTitle: {
      color: c.textMuted,
      fontSize: 12,
      fontWeight: "800",
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },
    item: { marginBottom: 4 },
    itemTop: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, marginBottom: 4 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 9,
      paddingVertical: 3,
      borderRadius: 10,
    },
    chipText: { fontSize: 11.5, fontWeight: "700" },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 8 },
    emptyTitle: { color: c.textPrimary, fontSize: 16, fontWeight: "800", textAlign: "center" },
    emptyText: { color: c.textMuted, fontSize: 13.5, textAlign: "center", lineHeight: 19 },
  });

// app/(main)/components/AnnouncementCarousel.tsx
import { Ionicons } from "@expo/vector-icons";
import {
    Dimensions,
    FlatList,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const CARD_WIDTH = Math.min(320, SCREEN_WIDTH - 48);

export type AnnouncementItem = {
  id: string;
  content?: string;
  username?: string;
  userId?: string;
  flair?: string;
  createdAt?: any;
  pinnedAt?: any;
  pinExpiresAt?: any;
  targetDate?: any;
  targetDateLabel?: string | null;
  files?: Array<{ url: string; mimeType: string }>;
  imageUrl?: string;
};

type AnnouncementCarouselProps = {
  announcements: AnnouncementItem[];
  onPressAnnouncement: (item: AnnouncementItem) => void;
};

const getTimestampMillis = (val: any): number => {
  if (!val) return 0;
  if (typeof val.toMillis === "function") return val.toMillis();
  if (typeof val.seconds === "number") return val.seconds * 1000;
  if (val instanceof Date) return val.getTime();
  const parsed = new Date(val).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const getUrgencyDetails = (
  expiresAtVal: any,
  targetDateLabel?: string | null,
): { label: string; bg: string; color: string; icon: keyof typeof Ionicons.glyphMap } => {
  const expiresMs = getTimestampMillis(expiresAtVal);
  if (!expiresMs) {
    return {
      label: targetDateLabel || "Pinned Notice",
      bg: "#fdf4e8",
      color: "#8a5800",
      icon: "pin",
    };
  }

  const now = Date.now();
  const diffMs = expiresMs - now;

  if (diffMs <= 0) {
    return {
      label: "Completed",
      bg: "#f3f4f6",
      color: "#6b7280",
      icon: "checkmark-circle",
    };
  }

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffHours < 24) {
    return {
      label: diffHours <= 1 ? "Ends in < 1h" : `Ends in ${diffHours}h`,
      bg: "#fee2e2",
      color: "#991b1b",
      icon: "alert-circle",
    };
  }

  if (diffDays <= 3) {
    return {
      label: diffDays === 1 ? "Ends tomorrow" : `${diffDays} days left`,
      bg: "#fef3c7",
      color: "#92400e",
      icon: "time",
    };
  }

  if (targetDateLabel) {
    return {
      label: `Until ${targetDateLabel}`,
      bg: "#fdf2f0",
      color: "#7f2220",
      icon: "calendar",
    };
  }

  const d = new Date(expiresMs);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return {
    label: `Until ${months[d.getMonth()]} ${d.getDate()}`,
    bg: "#fdf2f0",
    color: "#7f2220",
    icon: "calendar",
  };
};

export default function AnnouncementCarousel({
  announcements,
  onPressAnnouncement,
}: AnnouncementCarouselProps) {
  if (!announcements || announcements.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.titleRow}>
          <View style={styles.iconCircle}>
            <Ionicons name="megaphone" size={15} color="#5f0909" />
          </View>
          <Text style={styles.sectionTitle}>Active Announcements</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{announcements.length}</Text>
          </View>
        </View>
        <Text style={styles.swipeHint}>Swipe to browse</Text>
      </View>

      <FlatList
        horizontal
        data={announcements}
        keyExtractor={(item) => `announcement-banner-${item.id}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        snapToInterval={CARD_WIDTH + 12}
        decelerationRate="fast"
        renderItem={({ item }) => {
          const urgency = getUrgencyDetails(item.pinExpiresAt || item.targetDate, item.targetDateLabel);
          const hasImage = !!item.imageUrl || (item.files && item.files.some((f) => f.mimeType?.startsWith("image/")));

          return (
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.88}
              onPress={() => onPressAnnouncement(item)}
            >
              <View style={styles.cardTopRow}>
                <View style={[styles.urgencyBadge, { backgroundColor: urgency.bg }]}>
                  <Ionicons name={urgency.icon} size={11} color={urgency.color} />
                  <Text style={[styles.urgencyText, { color: urgency.color }]} numberOfLines={1}>
                    {urgency.label}
                  </Text>
                </View>

                {hasImage && (
                  <View style={styles.mediaPill}>
                    <Ionicons name="image-outline" size={12} color="#70483e" />
                  </View>
                )}
              </View>

              <Text style={styles.cardContent} numberOfLines={2} ellipsizeMode="tail">
                {item.content || "Important announcement"}
              </Text>

              <View style={styles.cardFooter}>
                <View style={styles.authorRow}>
                  <Ionicons name="person-circle-outline" size={13} color="#8a5a4c" />
                  <Text style={styles.authorText} numberOfLines={1}>
                    {item.username || "Staff Notice"}
                  </Text>
                </View>
                <View style={styles.viewLinkRow}>
                  <Text style={styles.viewLinkText}>View</Text>
                  <Ionicons name="chevron-forward" size={12} color="#5f0909" />
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  iconCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#ffeedf",
    alignItems: "center",
    justifyContent: "center",
  },
  sectionTitle: {
    fontSize: 13.5,
    fontWeight: "800",
    color: "#5f0909",
    letterSpacing: -0.2,
  },
  countBadge: {
    backgroundColor: "#5f0909",
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1.5,
  },
  countText: {
    fontSize: 10.5,
    fontWeight: "800",
    color: "#ffffff",
  },
  swipeHint: {
    fontSize: 11,
    color: "#a88177",
    fontWeight: "600",
  },
  listContent: {
    paddingHorizontal: 16,
    gap: 12,
  },
  card: {
    width: CARD_WIDTH,
    backgroundColor: "#fffdfa",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#f0dfd5",
    padding: 12,
    justifyContent: "space-between",
    shadowColor: "#5f0909",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 5,
    elevation: 2,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  urgencyBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 10,
    maxWidth: "80%",
  },
  urgencyText: {
    fontSize: 10.5,
    fontWeight: "800",
  },
  mediaPill: {
    backgroundColor: "#f5ece6",
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 8,
  },
  cardContent: {
    fontSize: 13,
    lineHeight: 18,
    color: "#3c1815",
    fontWeight: "600",
    marginBottom: 8,
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#f3e6de",
    paddingTop: 6,
  },
  authorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flex: 1,
    marginRight: 8,
  },
  authorText: {
    fontSize: 11,
    color: "#8a5a4c",
    fontWeight: "700",
  },
  viewLinkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  viewLinkText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#5f0909",
  },
});


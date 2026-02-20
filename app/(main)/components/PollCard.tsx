// PollCard.tsx - Threads Style with Hanging Indentation
import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  getRoleColor,
  getRoleDisplayName,
  getUserData,
  UserData,
} from "@/utils/rbac";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const IMAGE_WIDTH = SCREEN_WIDTH - 68;

type PollOption = {
  text: string;
  votes: number;
  voters: string[];
};

type UserRole = "student" | "moderator" | "teacher" | "admin";

type Poll = {
  id: string;
  question: string;
  options: PollOption[];
  imageUrl?: string;
  userId?: string;
  username?: string;
  userRole?: UserRole;
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

interface PollCardProps {
  poll: Poll;
  currentUserId?: string;
  userRole: UserRole | string;
  currentUserRole?: UserRole;
  onVote: (pollId: string, optionIndex: number) => void;
  onAddOption: (pollId: string) => void;
  onProfileClick: (userId?: string, isAnonymous?: boolean) => void;
  onImagePress: (images: string[], startIndex: number) => void;
  getTimeAgo: (timestamp: any) => string;
  isPollExpired: (expiresAt: any) => boolean;
}

const PollCard = ({
  poll,
  currentUserId,
  userRole,
  currentUserRole,
  onVote,
  onAddOption,
  onProfileClick,
  onImagePress,
  getTimeAgo,
  isPollExpired,
}: PollCardProps) => {
  const expired = isPollExpired(poll.expiresAt);
  const [authorData, setAuthorData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const fetchAuthor = async () => {
      if (poll.userId && poll.userId !== "anonymous") {
        try {
          const data = await getUserData(poll.userId);
          setAuthorData(data);
        } catch (err) {
          console.log("Error fetching poll author:", err);
          setAuthorData(null);
        }
      }
      setLoading(false);
    };
    fetchAuthor();
  }, [poll.userId]);

  const userVotes = useMemo(() => {
    if (!currentUserId) return [];
    return poll.options
      .map((opt, idx) => (opt.voters?.includes(currentUserId) ? idx : -1))
      .filter((idx) => idx !== -1);
  }, [poll.options, currentUserId]);

  const authorRole = authorData?.role || "student";
  const roleColor = getRoleColor(authorRole);
  const roleDisplayName = getRoleDisplayName(authorRole);

  const canSeeIdentity =
    currentUserRole === "admin" ||
    ((currentUserRole === "teacher" || currentUserRole === "moderator") &&
      authorRole === "student");

  const canShowEyeIcon = (poll.isAnonymous ?? true) && canSeeIdentity;
  const isIdentityVisible = !poll.isAnonymous || (revealed && canSeeIdentity);

  const displayName = isIdentityVisible
    ? authorData
      ? `${authorData.firstname} ${authorData.lastname}`
      : poll.username || "Anonymous"
    : "Anonymous";

  const canClickProfile =
    isIdentityVisible &&
    !!authorData?.userId &&
    authorData.userId !== "anonymous";

  const handleProfileClick = () => {
    if (!canClickProfile) return;
    if (authorData?.userId === currentUserId) {
      onProfileClick("self");
    } else {
      onProfileClick(authorData.userId);
    }
  };

  return (
    <View style={styles.pollCard}>
      {/* Hanging Indentation Layout */}
      <View style={styles.hangingLayout}>
        {/* Left: Avatar Column */}
        <View style={styles.avatarColumn}>
          <TouchableOpacity
            onPress={handleProfileClick}
            disabled={!canClickProfile}
          >
            <View style={styles.avatar}>
              {loading ? (
                <ActivityIndicator size="small" color="#8ea0d0" />
              ) : isIdentityVisible ? (
                <Text style={[styles.avatarText, { color: roleColor }]}>
                  {(
                    authorData?.firstname?.[0] ||
                    poll.username?.[0] ||
                    "A"
                  ).toUpperCase()}
                </Text>
              ) : (
                <Ionicons name="person" size={16} color="#8ea0d0" />
              )}
            </View>
          </TouchableOpacity>
        </View>

        {/* Right: Content Column */}
        <View style={styles.contentColumn}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <TouchableOpacity
                onPress={handleProfileClick}
                disabled={!canClickProfile}
              >
                <Text style={styles.username}>{displayName}</Text>
              </TouchableOpacity>

              {isIdentityVisible && authorRole !== "student" && (
                <View
                  style={[
                    styles.roleChip,
                    {
                      backgroundColor: roleColor + "20",
                      borderColor: roleColor,
                    },
                  ]}
                >
                  <Text style={[styles.roleChipText, { color: roleColor }]}>
                    {roleDisplayName}
                  </Text>
                </View>
              )}

              {canShowEyeIcon && (
                <TouchableOpacity
                  onPress={() => setRevealed(!revealed)}
                  style={styles.eyeButton}
                >
                  <Ionicons
                    name={revealed ? "eye-off-outline" : "eye-outline"}
                    size={13}
                    color={revealed ? "#ff5c93" : "#8ea0d0"}
                  />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.headerRight}>
              <Text style={styles.timestamp}>{getTimeAgo(poll.createdAt)}</Text>
              <TouchableOpacity style={styles.moreButton}>
                <Ionicons
                  name="ellipsis-horizontal"
                  size={18}
                  color="#8ea0d0"
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Poll Question */}
          <Text style={styles.pollQuestion}>{poll.question}</Text>

          {/* Poll Image - Clickable */}
          {poll.imageUrl && (
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() => onImagePress([poll.imageUrl!], 0)}
              style={styles.imageContainer}
            >
              <Image
                source={{ uri: poll.imageUrl }}
                style={styles.pollImage}
                resizeMode="cover"
              />
            </TouchableOpacity>
          )}

          {/* Poll Options */}
          <View style={styles.pollOptions}>
            {poll.options.map((option, idx) => {
              const isVoted = userVotes.includes(idx);
              const percentage =
                poll.totalVotes > 0
                  ? (option.votes / poll.totalVotes) * 100
                  : 0;
              const singleChoiceLocked =
                !poll.allowMultiple && userVotes.length > 0;
              const multiChoiceReachedMax =
                poll.allowMultiple && userVotes.length >= poll.maxSelections;
              const disableForUser =
                expired ||
                singleChoiceLocked ||
                (poll.allowMultiple && !isVoted && multiChoiceReachedMax);

              return (
                <TouchableOpacity
                  key={`${poll.id}-opt-${idx}`}
                  style={[
                    styles.pollOption,
                    isVoted && styles.pollOptionVoted,
                    disableForUser && { opacity: 0.6 },
                  ]}
                  onPress={() => !disableForUser && onVote(poll.id, idx)}
                  disabled={disableForUser}
                  activeOpacity={disableForUser ? 1 : 0.7}
                >
                  <View style={styles.pollOptionContent}>
                    {poll.allowMultiple ? (
                      <View
                        style={[
                          styles.checkbox,
                          isVoted && styles.checkboxActive,
                        ]}
                      >
                        {isVoted && (
                          <Ionicons name="checkmark" size={11} color="#fff" />
                        )}
                      </View>
                    ) : (
                      <View
                        style={[styles.radio, isVoted && styles.radioActive]}
                      >
                        {isVoted && <View style={styles.radioDot} />}
                      </View>
                    )}
                    <Text style={styles.pollOptionText}>{option.text}</Text>
                  </View>
                  <View style={styles.pollVoteInfo}>
                    <View
                      style={[
                        styles.pollProgressBar,
                        { width: `${percentage}%` },
                      ]}
                    />
                    <Text style={styles.pollVoteCount}>{option.votes}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Add Option Button */}
          {poll.allowUsersToAddOption && !expired && (
            <View style={{ marginBottom: 8 }}>
              <TouchableOpacity
                style={styles.addOptionButton}
                onPress={() => onAddOption(poll.id)}
              >
                <Ionicons name="add" size={15} color="#ff5c93" />
                <Text style={styles.addOptionButtonText}>
                  Add your own option
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Poll Footer */}
          <View style={styles.pollFooter}>
            <Text style={styles.pollTotalVotes}>
              {poll.totalVotes} {poll.totalVotes === 1 ? "vote" : "votes"}
            </Text>
            {expired && (
              <View style={styles.pollExpiredBadge}>
                <Ionicons name="time-outline" size={11} color="#ff6b6b" />
                <Text style={styles.pollExpired}>Poll ended</Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </View>
  );
};

export default PollCard;

const styles = StyleSheet.create({
  pollCard: {
    backgroundColor: "#1b2235",
    marginBottom: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  hangingLayout: {
    flexDirection: "row",
  },
  avatarColumn: {
    width: 36,
    marginRight: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#243054",
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    fontSize: 16,
    fontWeight: "bold",
  },
  contentColumn: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  username: {
    color: "#e9edff",
    fontSize: 15,
    fontWeight: "600",
  },
  roleChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    borderWidth: 1,
  },
  roleChipText: {
    fontSize: 9,
    fontWeight: "600",
  },
  eyeButton: {
    padding: 2,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  timestamp: {
    color: "#8ea0d0",
    fontSize: 13,
  },
  moreButton: {
    padding: 2,
  },
  pollQuestion: {
    color: "#dbe1ff",
    fontSize: 15,
    lineHeight: 20,
    marginBottom: 8,
  },
  imageContainer: {
    marginTop: 8,
    marginBottom: 8,
  },
  pollImage: {
    width: IMAGE_WIDTH,
    height: 160,
    borderRadius: 8,
    backgroundColor: "#243054",
  },
  pollOptions: {
    gap: 6,
    marginTop: 8,
    marginBottom: 8,
  },
  pollOption: {
    backgroundColor: "#243054",
    borderRadius: 6,
    padding: 8,
    borderWidth: 1,
    borderColor: "#243054",
    overflow: "hidden",
  },
  pollOptionVoted: {
    borderColor: "#ff5c93",
  },
  pollOptionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    zIndex: 2,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 3,
    borderWidth: 2,
    borderColor: "#8ea0d0",
    justifyContent: "center",
    alignItems: "center",
  },
  checkboxActive: {
    backgroundColor: "#ff5c93",
    borderColor: "#ff5c93",
  },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#8ea0d0",
    justifyContent: "center",
    alignItems: "center",
  },
  radioActive: {
    borderColor: "#ff5c93",
  },
  radioDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#ff5c93",
  },
  pollOptionText: {
    color: "#e9edff",
    fontSize: 13,
    flex: 1,
  },
  pollVoteInfo: {
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  pollProgressBar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "#ff5c93",
    opacity: 0.15,
    zIndex: 1,
  },
  pollVoteCount: {
    color: "#8ea0d0",
    fontSize: 11,
    marginLeft: "auto",
    zIndex: 2,
  },
  pollFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 6,
  },
  pollTotalVotes: {
    color: "#8ea0d0",
    fontSize: 13,
  },
  pollExpiredBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  pollExpired: {
    color: "#ff6b6b",
    fontSize: 12,
    fontWeight: "600",
  },
  addOptionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#ff5c93",
    alignSelf: "flex-start",
    backgroundColor: "#1b2235",
  },
  addOptionButtonText: {
    color: "#ff5c93",
    fontWeight: "600",
    fontSize: 12,
  },
});

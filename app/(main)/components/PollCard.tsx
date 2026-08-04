// PollCard.tsx 
import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  ActivityIndicator,
  Dimensions,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  canDeleteContent,
  canViewAnonymousIdentity,
  getRoleColor,
  getRoleDisplayName,
  getUserData,
  parseUserRole,
  UserData,
} from "@/utils/rbac";
import { resolveAvatarUri } from "@/utils/avatar";
import CommentModal from "./CommentModal";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const FEED_HORIZONTAL_PADDING = 16;
const AVATAR_COLUMN_WIDTH = 40;
const AVATAR_COLUMN_GAP = 12;
const IMAGE_WIDTH =
  SCREEN_WIDTH - FEED_HORIZONTAL_PADDING * 2 - AVATAR_COLUMN_WIDTH - AVATAR_COLUMN_GAP;

type PollOption = {
  text: string;
  votes: number;
  voters: string[];
  isUserAdded?: boolean;
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
  commentCount?: number;
};

interface PollCardProps {
  poll: Poll;
  isHighlighted?: boolean;
  currentUserId?: string;
  userRole: UserRole | string;
  currentUserRole?: UserRole;
  onVote: (pollId: string, optionIndex: number) => void;
  onAddOption?: (pollId: string, optionText: string) => void;
  onProfileClick: (userId?: string, isAnonymous?: boolean) => void;
  onImagePress: (images: string[], startIndex: number) => void;
  getTimeAgo: (timestamp: any) => string;
  isPollExpired: (expiresAt: any) => boolean;
  onCommentCountUpdate?: (pollId: string, newCount: number) => void;
  onDelete?: (pollId: string) => void | Promise<void>;
}

const PollCard = ({
  poll,
  isHighlighted = false,
  currentUserId,
  userRole,
  currentUserRole,
  onVote,
  onAddOption,
  onProfileClick,
  onImagePress,
  getTimeAgo,
  isPollExpired,
  onCommentCountUpdate,
  onDelete,
}: PollCardProps) => {
  const expired = isPollExpired(poll.expiresAt);
  const [authorData, setAuthorData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [showAddOptionForm, setShowAddOptionForm] = useState(false);
  const [newOptionText, setNewOptionText] = useState("");
  const [addingOption, setAddingOption] = useState(false);
  const [showCommentsModal, setShowCommentsModal] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [voterDirectory, setVoterDirectory] = useState<Record<string, UserData | null>>({});
  const [showVoters, setShowVoters] = useState(false);
  const normalizedCurrentUserRole = parseUserRole(currentUserRole);

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

  useEffect(() => {
    const canSeeVoteIdentities =
      (!!currentUserId && poll.userId === currentUserId) ||
      normalizedCurrentUserRole === "admin";
    if (!canSeeVoteIdentities) {
      setVoterDirectory({});
      setShowVoters(false);
      return;
    }

    const voterIds = Array.from(
      new Set(poll.options.flatMap((option) => option.voters || []).filter(Boolean)),
    );

    if (voterIds.length === 0) {
      setVoterDirectory({});
      return;
    }

    let isActive = true;

    Promise.all(
      voterIds.map(async (voterId) => {
        try {
          const data = await getUserData(voterId);
          return [voterId, data] as const;
        } catch (error) {
          console.log("Error fetching poll voter:", error);
          return [voterId, null] as const;
        }
      }),
    ).then((entries) => {
      if (!isActive) return;
      setVoterDirectory(Object.fromEntries(entries));
    });

    return () => {
      isActive = false;
    };
  }, [currentUserId, normalizedCurrentUserRole, poll.options, poll.userId]);

  const userVotes = useMemo(() => {
    if (!currentUserId) return [];
    return poll.options
      .map((opt, idx) => (opt.voters?.includes(currentUserId) ? idx : -1))
      .filter((idx) => idx !== -1);
  }, [poll.options, currentUserId]);

  const authorRole = parseUserRole(authorData?.role) ?? parseUserRole(poll.userRole);
  const roleColor = getRoleColor(authorRole || "student");
  const roleDisplayName = getRoleDisplayName(authorRole || "student");

  const canSeeIdentity = canViewAnonymousIdentity(
    parseUserRole(currentUserRole),
    authorRole,
    poll.isAnonymous ?? false,
  );

  const canShowEyeIcon = (poll.isAnonymous ?? true) && canSeeIdentity;
  const isIdentityVisible = !poll.isAnonymous || (revealed && canSeeIdentity);
  const canDelete = canDeleteContent({
    viewerRole: normalizedCurrentUserRole,
    viewerUserId: currentUserId,
    authorUserId: poll.userId,
    authorRole,
  });

  const displayName = isIdentityVisible
    ? authorData
      ? `${authorData.firstname} ${authorData.lastname}`
      : poll.username || "Anonymous"
    : "Anonymous";

  const canClickProfile =
    isIdentityVisible &&
    !!authorData?.userId &&
    authorData.userId !== "anonymous";
  const canSeeVoteIdentities =
    (!!currentUserId && poll.userId === currentUserId) ||
    normalizedCurrentUserRole === "admin";
  const authorAvatarUri = resolveAvatarUri(authorData || {});
  const visibleVoterGroups = useMemo(
    () =>
      poll.options
        .map((option, idx) => {
          const voters = (option.voters || [])
            .map((voterId) => {
              const voter = voterDirectory[voterId];
              const voterName = voter
                ? `${voter.firstname} ${voter.lastname}`.trim()
                : "";

              if (!voter || !voterName) {
                return null;
              }

              return {
                id: voterId,
                userId: voter.userId || null,
                name: voterName,
              };
            })
            .filter(Boolean) as { id: string; userId: string | null; name: string }[];

          if (voters.length === 0) {
            return null;
          }

          return {
            key: `${poll.id}-voters-${idx}`,
            optionText: option.text,
            voters,
          };
        })
        .filter(Boolean) as {
        key: string;
        optionText: string;
        voters: { id: string; userId: string | null; name: string }[];
      }[],
    [poll.id, poll.options, voterDirectory],
  );

  const handleProfileClick = () => {
    if (!canClickProfile) return;
    if (authorData?.userId === currentUserId) {
      onProfileClick(currentUserId);
    } else {
      onProfileClick(authorData.userId);
    }
  };

  const handleCommentAdded = () => {
    if (onCommentCountUpdate) {
      onCommentCountUpdate(poll.id, (poll.commentCount || 0) + 1);
    }
  };

const handleAddOption = async () => {
  const trimmedText = newOptionText.trim();
  setAddError(null); 

  if (!trimmedText) {
    setAddError("Please enter an option");
    return;
  }

  if (trimmedText.length > 25) {
    setAddError("Option must be 25 characters or less");
    return;
  }

  setAddingOption(true);

  try {
    if (onAddOption) {
      await onAddOption(poll.id, trimmedText);
      setNewOptionText("");
      setShowAddOptionForm(false);
      setAddError(null);
    }
  } catch (error) {
    console.error("Failed to add option:", error);
    setAddError("Failed to add option. Please try again.");
  } finally {
    setAddingOption(false);
  }
};

  const handleMorePress = () => {
    if (!canDelete || !onDelete) return;
    Alert.alert("Poll Options", undefined, [
      {
        text: "Delete",
        style: "destructive",
        onPress: () => onDelete(poll.id),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  return (
    <View style={[styles.pollCard, isHighlighted && styles.highlightedPollCard]}>
      <View style={styles.hangingLayout}>
        <View style={styles.avatarColumn}>
          <TouchableOpacity
            onPress={handleProfileClick}
            disabled={!canClickProfile}
          >
            <View style={styles.avatar}>
              {loading ? (
                <ActivityIndicator size="small" color="#956a5f" />
              ) : isIdentityVisible ? (
                authorAvatarUri ? (
                  <Image source={{ uri: authorAvatarUri }} style={styles.avatarImage} />
                ) : (
                  <Text style={[styles.avatarText, { color: roleColor }]}>
                    {(
                      authorData?.firstname?.[0] ||
                      poll.username?.[0] ||
                      "A"
                    ).toUpperCase()}
                  </Text>
                )
              ) : (
                <Ionicons name="person" size={18} color="#956a5f" />
              )}
            </View>
          </TouchableOpacity>
        </View>

        <View style={styles.contentColumn}>
          <View style={styles.usernameRow}>
            <TouchableOpacity
              onPress={handleProfileClick}
              disabled={!canClickProfile}
            >
              <Text style={styles.username}>{displayName}</Text>
            </TouchableOpacity>

            {isIdentityVisible && authorRole && authorRole !== "student" && (
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
                  size={14}
                  color={revealed ? "#a61f1f" : "#956a5f"}
                />
              </TouchableOpacity>
            )}

            {canDelete && (
              <TouchableOpacity
                onPress={handleMorePress}
                style={styles.eyeButton}
              >
                <Ionicons
                  name="ellipsis-horizontal"
                  size={16}
                  color="#956a5f"
                />
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.timestamp}>{getTimeAgo(poll.createdAt)}</Text>

          <Text style={styles.pollQuestion}>{poll.question}</Text>

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
                    disableForUser && { opacity: 0.5 },
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
                    {option.isUserAdded && (
                      <View style={styles.userAddedBadge}>
                        <Text style={styles.userAddedText}>User added</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.pollVoteInfo}>
                    <View
                      style={[
                        styles.pollProgressBar,
                        { width: `${percentage}%` },
                      ]}
                    />
                    <Text style={styles.pollVoteCount}>
                      {Math.round(percentage)}% • {option.votes}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {canSeeVoteIdentities && (
            <View style={styles.voterSection}>
              <TouchableOpacity
                style={styles.voterToggleButton}
                onPress={() => setShowVoters((current) => !current)}
                activeOpacity={0.8}
              >
                <Text style={styles.voterToggleButtonText}>
                  {showVoters ? "Hide voters" : "View voters"}
                </Text>
                <Ionicons
                  name={showVoters ? "chevron-up" : "chevron-down"}
                  size={16}
                  color="#8f3a2b"
                />
              </TouchableOpacity>
              {showVoters && (
                <ScrollView
                  style={styles.voterScrollArea}
                  contentContainerStyle={styles.voterScrollContent}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                >
                  {visibleVoterGroups.length === 0 ? (
                    <View style={styles.voterEmptyState}>
                      <Ionicons name="people-outline" size={16} color="#9b766c" />
                      <Text style={styles.voterEmptyStateText}>
                        No voter names available yet.
                      </Text>
                    </View>
                  ) : (
                    visibleVoterGroups.map((group) => (
                      <View key={group.key} style={styles.voterOptionBlock}>
                        <Text style={styles.voterOptionTitle}>{group.optionText}</Text>
                        <View style={styles.voterChipWrap}>
                          {group.voters.map((voter) => (
                            <TouchableOpacity
                              key={`${group.key}-${voter.id}`}
                              style={styles.voterChip}
                              onPress={() => voter.userId && onProfileClick(voter.userId, false)}
                              disabled={!voter.userId}
                              activeOpacity={0.78}
                            >
                              <Text style={styles.voterChipText}>{voter.name}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </View>
                    ))
                  )}
                </ScrollView>
              )}
            </View>
          )}

{poll.allowUsersToAddOption && !expired && showAddOptionForm && (
  <View style={styles.addOptionFormContainer}>
    <Text style={styles.addOptionLabel}>New option (max 25 characters)</Text>

    <View style={styles.addOptionInputWrapper}>
      <TextInput
        style={styles.addOptionInput}
        placeholder="Type your option here..."
        placeholderTextColor="#a07b70"
        value={newOptionText}
        onChangeText={setNewOptionText}
        maxLength={25}
        editable={!addingOption}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={handleAddOption} 
      />

      <View style={styles.charCounter}>
        <Text style={styles.charCountText}>
          {newOptionText.length} / 25
        </Text>
      </View>
    </View>

    {addError && (
  <Text style={styles.addOptionErrorText}>
    {addError}
  </Text>
)}

    <View style={styles.addOptionActions}>
      <TouchableOpacity
        style={[
          styles.addOptionCancelBtn,
          addingOption && styles.btnDisabled,
        ]}
        onPress={() => {
          setShowAddOptionForm(false);
          setNewOptionText("");
        }}
        disabled={addingOption}
      >
        <Text style={styles.cancelText}>Cancel</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.addOptionSubmitBtn,
          (!newOptionText.trim() || addingOption) && styles.btnDisabled,
        ]}
        onPress={handleAddOption}
        disabled={!newOptionText.trim() || addingOption}
      >
        {addingOption ? (
          <ActivityIndicator size="small" color="#5f0909" />
        ) : (
          <Text style={styles.submitText}>Add</Text>
        )}
      </TouchableOpacity>
    </View>
  </View>
)}

{poll.allowUsersToAddOption && !expired && !showAddOptionForm && (
  <TouchableOpacity
    style={[
      styles.addOptionButton,
      poll.options.length >= 6 && { opacity: 0.85 },
    ]}
    onPress={() => {
      setShowAddOptionForm(true);
      setNewOptionText("");
    }}
    activeOpacity={0.75}
  >
    <Ionicons name="add-circle-outline" size={18} color="#a61f1f" />
    <Text style={styles.addOptionButtonText}>Add your own option</Text>
  </TouchableOpacity>
)}

{poll.allowUsersToAddOption && expired && (
  <View style={styles.addOptionDisabledNotice}>
    <Text style={styles.disabledText}>
      Cannot add options — poll has ended
    </Text>
  </View>
)}
          <View style={styles.pollFooter}>
            <View style={styles.statsRow}>
              {(poll.totalVotes ?? 0) > 0 && (
                <Text style={styles.statText}>
                  {poll.totalVotes} {poll.totalVotes === 1 ? "vote" : "votes"}
                </Text>
              )}

              {(poll.commentCount ?? 0) > 0 && (
                <Text style={styles.statText}>
                  {poll.commentCount}{" "}
                  {poll.commentCount === 1 ? "comment" : "comments"}
                </Text>
              )}

              {expired && (
                <View style={styles.pollExpiredBadge}>
                  <Ionicons name="time-outline" size={11} color="#a61f1f" />
                  <Text style={styles.pollExpired}>Poll ended</Text>
                </View>
              )}
            </View>
          </View>
        </View>
      </View>

      {showCommentsModal && currentUserId && (
        <CommentModal
          visible={showCommentsModal}
          onClose={() => setShowCommentsModal(false)}
          postId={poll.id}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          onCommentAdded={handleCommentAdded}
        />
      )}
    </View>
  );
};

export default PollCard;

const styles = StyleSheet.create({
  pollCard: {
    backgroundColor: "#fffaf7",
    paddingVertical: 14,
    paddingHorizontal: FEED_HORIZONTAL_PADDING,
    borderBottomWidth: 1,
    borderBottomColor: "#ead8cf",
    overflow: "visible",
  },
  highlightedPollCard: {
    borderLeftWidth: 4,
    borderLeftColor: "#a61f1f",
    backgroundColor: "#fff4ee",
  },
  hangingLayout: {
    flexDirection: "row",
    overflow: "visible",
  },
  avatarColumn: {
    width: AVATAR_COLUMN_WIDTH,
    marginRight: AVATAR_COLUMN_GAP,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#f2dfd4",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#e3c3b8",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarText: {
    fontSize: 17,
    fontWeight: "700",
  },
  contentColumn: {
    flex: 1,
    overflow: "visible",
  },
  usernameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 3,
  },
  username: {
    color: "#4f1c17",
    fontSize: 15,
    fontWeight: "700",
  },
  roleChip: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
  },
  roleChipText: {
    fontSize: 10,
    fontWeight: "700",
  },
  eyeButton: {
    padding: 3,
  },
  timestamp: {
    color: "#8f6a60",
    fontSize: 12.5,
    marginBottom: 4,
    letterSpacing: -0.1,
  },
  pollQuestion: {
    color: "#4f1c17",
    fontSize: 15,
    lineHeight: 21,
    marginTop: 4,
    marginBottom: 8,
  },
  imageContainer: {
    marginVertical: 10,
    borderRadius: 18,
    overflow: "hidden",
  },
  pollImage: {
    width: IMAGE_WIDTH,
    height: IMAGE_WIDTH * 1.1,
    backgroundColor: "#efe1d6",
    borderRadius: 18,
  },
  pollOptions: {
    gap: 6,
    marginTop: 8,
    marginBottom: 8,
  },
  pollOption: {
    backgroundColor: "#fcf0ec",
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#f2c4b9",
    overflow: "hidden",
  },
  pollOptionVoted: {
    borderColor: "#a61f1f",
    backgroundColor: "#fff4f1",
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
    borderColor: "#b88f87",
    justifyContent: "center",
    alignItems: "center",
  },
  checkboxActive: {
    backgroundColor: "#a61f1f",
    borderColor: "#a61f1f",
  },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#b88f87",
    justifyContent: "center",
    alignItems: "center",
  },
  radioActive: {
    borderColor: "#a61f1f",
  },
  radioDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#a61f1f",
  },
  pollOptionText: {
    color: "#4f1c17",
    fontSize: 13,
    flex: 1,
  },
  userAddedBadge: {
    backgroundColor: "#f4e7df",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 0.5,
    borderColor: "#d8b36b",
  },
  userAddedText: {
    color: "#8f6a60",
    fontSize: 9,
    fontWeight: "600",
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
    backgroundColor: "#c72d1f",
    opacity: 0.24,
    zIndex: 1,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
  },
  pollVoteCount: {
    color: "#6b1c16",
    fontSize: 11,
    fontWeight: "700",
    marginLeft: "auto",
    zIndex: 2,
  },
  addOptionButtonText: {
    color: "#a61f1f",
    fontWeight: "600",
    fontSize: 12,
  },
  addOptionForm: {
    backgroundColor: "#f8eee8",
    borderRadius: 8,
    padding: 10,
    marginVertical: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#ecd2b0",
  },

  addOptionBtnDisabled: {
    opacity: 0.6,
  },
  addOptionCharCount: {
    color: "#8f6a60",
    fontSize: 11,
    marginTop: 6,
    textAlign: "right",
  },
  pollFooter: {
    marginTop: 8,
  },
  voterSection: {
    backgroundColor: "#fff4ee",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#f2d4ca",
    padding: 12,
    marginBottom: 10,
  },
  voterToggleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  voterToggleButtonText: {
    color: "#8f3a2b",
    fontSize: 12.5,
    fontWeight: "700",
  },
  voterOptionBlock: {
    marginTop: 8,
  },
  voterEmptyState: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fffaf7",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#edd6cc",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  voterEmptyStateText: {
    color: "#9b766c",
    fontSize: 12,
    fontWeight: "500",
  },
  voterScrollArea: {
    maxHeight: 220,
    marginTop: 10,
  },
  voterScrollContent: {
    paddingBottom: 2,
  },
  voterOptionTitle: {
    color: "#5f0909",
    fontSize: 12.5,
    fontWeight: "700",
    marginBottom: 8,
  },
  voterChipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  voterChip: {
    backgroundColor: "#fffaf7",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#e6c6b9",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  voterChipText: {
    color: "#5f0909",
    fontSize: 12,
    fontWeight: "600",
  },
  statsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
  },
  statText: {
    color: "#8f6a60",
    fontSize: 13,
    fontWeight: "500",
  },
  pollExpiredBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  pollExpired: {
    color: "#a61f1f",
    fontSize: 12,
    fontWeight: "600",
  },
  actions: {
    flexDirection: "row",
    gap: 28,
    marginTop: 12,
    marginBottom: 6,
  },
  actionButton: {
    padding: 4,
  },
  addOptionFormContainer: {
  backgroundColor: "#f8eee8",
  borderRadius: 10,
  padding: 12,
  marginVertical: 10,
  borderWidth: 1,
  borderColor: "#ecd2b0",
},

addOptionLabel: {
  color: "#8f6a60",
  fontSize: 13,
  fontWeight: "500",
  marginBottom: 8,
},

addOptionInputWrapper: {
  position: "relative",
  marginBottom: 12,
},

addOptionInput: {
  backgroundColor: "#fffaf8",
  borderRadius: 8,
  paddingHorizontal: 12,
  paddingVertical: 11,
  color: "#4f1c17",
  fontSize: 14,
  borderWidth: 1,
  borderColor: "#ddc6bb",
},

charCounter: {
  position: "absolute",
  right: 10,
  bottom: 8,
},

charCountText: {
  color: "#a07b70",
  fontSize: 11,
  fontWeight: "500",
},

addOptionActions: {
  flexDirection: "row",
  justifyContent: "flex-end",
  gap: 12,
},

addOptionSubmitBtn: {
  backgroundColor: "#e0a53d",
  paddingHorizontal: 16,
  paddingVertical: 10,
  borderRadius: 8,
  minWidth: 80,
  alignItems: "center",
},

addOptionCancelBtn: {
  backgroundColor: "transparent",
  paddingHorizontal: 16,
  paddingVertical: 10,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: "#d8b36b",
  minWidth: 80,
  alignItems: "center",
},

submitText: {
  color: "#5f0909",
  fontWeight: "600",
  fontSize: 13,
},

cancelText: {
  color: "#8f6a60",
  fontWeight: "500",
  fontSize: 13,
},

btnDisabled: {
  opacity: 0.5,
},
addOptionErrorText: {
  color: "#a61f1f",
  fontSize: 12,
  marginTop: 6,
  marginBottom: 4,
},

addOptionDisabledNotice: {
  paddingVertical: 10,
  alignItems: "center",
},

disabledText: {
  color: "#8f6a60",
  fontSize: 13,
  fontStyle: "italic",
},

addOptionButton: {
  flexDirection: "row",
  alignItems: "center",
  gap: 6,
  paddingVertical: 8,
  paddingHorizontal: 12,
  borderRadius: 8,
  borderWidth: 1.5,
  borderColor: "#d8b36b",
  backgroundColor: "#f8eee8",
  alignSelf: "flex-start",
  marginTop: 6,
  marginBottom: 10,
},
});

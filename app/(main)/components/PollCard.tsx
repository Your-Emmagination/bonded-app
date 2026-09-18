// PollCard.tsx 

import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";

import { AVATAR_SIZE_SMALL, FEED_IMAGE_WIDTH, avatarThumb, feedImage } from "@/utils/cloudinaryImages";

import React, { useEffect, useMemo, useRef, useState } from "react";

import {

  ActivityIndicator,

  Dimensions,

  Modal,

  ScrollView,

  StyleSheet,

  Text,

  TextInput,

  TouchableOpacity,

  View,

} from "react-native";

import { Image } from "expo-image";

import ReanimatedAnimated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { addDoc, collection, serverTimestamp } from "firebase/firestore";

import { auth, db } from "@/Firebase_configure";

import ConfirmDialog from "./ConfirmDialog";
import ContentActionMenu from "./ContentActionMenu";

import {

  canDeleteContent,

  canReportContent,

  canViewAnonymousIdentity,

  getRoleColor,

  getRoleDisplayName,

  getUserData,

  parseUserRole,

  UserData,

} from "@/utils/rbac";

import { resolveAvatarUri } from "@/utils/avatar";

import CommentModal from "./CommentModal";

import { getPostFlair } from "@/utils/postFlairs";



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

  flair?: string;

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

  onEdit?: (pollId: string) => void;

}



/**
 * Poll result bar whose width eases to its new percentage when a vote lands,
 * instead of snapping. Starts at the current value on mount (no intro
 * animation), then animates on every subsequent change.
 */
const PollProgressBar = React.memo(function PollProgressBar({
  percentage,
}: {
  percentage: number;
}) {
  const { styles, theme } = useStyles();
  const width = useSharedValue(percentage);

  useEffect(() => {
    width.value = withTiming(percentage, { duration: 280 });
  }, [percentage, width]);

  const animatedStyle = useAnimatedStyle(() => ({
    width: `${width.value}%`,
  }));

  return (
    <ReanimatedAnimated.View style={[styles.pollProgressBar, animatedStyle]} />
  );
});



const PollCard = React.memo<PollCardProps>(({

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

  onEdit,

}: PollCardProps) => {
  const { styles, theme } = useStyles();

  const expired = isPollExpired(poll.expiresAt);

  const [authorData, setAuthorData] = useState<UserData | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<{

    title: string;

    description?: string;

    confirmText?: string;

    cancelText?: string;

    destructive?: boolean;

    singleAction?: boolean;

    onConfirm: () => void;

  } | null>(null);

  const [loading, setLoading] = useState(true);

  const [revealed, setRevealed] = useState(false);

  const [showAddOptionForm, setShowAddOptionForm] = useState(false);

  const [newOptionText, setNewOptionText] = useState("");

  const [addingOption, setAddingOption] = useState(false);

  const [showCommentsModal, setShowCommentsModal] = useState(false);

  const [addError, setAddError] = useState<string | null>(null);

  const [voterDirectory, setVoterDirectory] = useState<Record<string, UserData | null>>({});

  const [showVoters, setShowVoters] = useState(false);

  const [showPollActions, setShowPollActions] = useState(false);

  const [deleting, setDeleting] = useState(false);

  const [showReportModal, setShowReportModal] = useState(false);

  const [reportSubmitting, setReportSubmitting] = useState(false);

  const [pendingReportReason, setPendingReportReason] = useState<string | null>(null);

  const [reportFeedback, setReportFeedback] = useState<{

    title: string;

    description: string;

    destructive: boolean;

  } | null>(null);

  const deleteInFlightRef = useRef(false);

  const normalizedCurrentUserRole = parseUserRole(currentUserRole);



  useEffect(() => {

    const fetchAuthor = async () => {

      if (poll.userId && poll.userId !== "anonymous") {

        try {

          const data = await getUserData(poll.userId);

          setAuthorData(data);

        } catch (err) {

          console.error("Error fetching poll author:", err);

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

          console.error("Error fetching poll voter:", error);

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



  const authorRole =

    parseUserRole(authorData?.role) ??

    parseUserRole(poll.userRole) ??

    parseUserRole(userRole);

  const roleColor = getRoleColor(authorRole || "student");

  const roleDisplayName = getRoleDisplayName(authorRole || "student");

  const pollFlair = getPostFlair(poll.flair);



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

  const canEdit = !!currentUserId && poll.userId === currentUserId && !!onEdit;

  const reporterId = currentUserId || auth.currentUser?.uid;

  const isOwnPoll = !!reporterId && poll.userId === reporterId;

  const canReport =

    canReportContent(

      normalizedCurrentUserRole,

      authorRole,

      poll.isAnonymous === true,

    ) && !isOwnPoll;

  const canOpenOptions = canEdit || (canDelete && !!onDelete) || canReport;



  const resolvedAuthorName = authorData

    ? `${authorData.firstname || ""} ${authorData.lastname || ""}`.trim()

    : "";

  const displayName = isIdentityVisible

    ? authorRole === "student"

      ? resolvedAuthorName || poll.username || "Anonymous"

      : authorData

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



  const handleEditPoll = () => {

    setShowPollActions(false);

    onEdit?.(poll.id);

  };



  const handleDeletePoll = () => {

    if (!canDelete || !onDelete) return;

    setShowPollActions(false);

    setConfirmDialog({

      title: "Delete Poll",

      description: "This will permanently remove the poll, comments, and replies.",

      confirmText: "Delete",

      cancelText: "Cancel",

      destructive: true,

      onConfirm: async () => {

        if (deleteInFlightRef.current) return;

        deleteInFlightRef.current = true;

        setDeleting(true);

        try {

          await onDelete(poll.id);

        } finally {

          deleteInFlightRef.current = false;

          setDeleting(false);

          setConfirmDialog(null);

        }

      },

    });

  };



  const openReportModal = () => {

    setShowPollActions(false);

    setShowReportModal(true);

  };



  const submitReport = async (reason: string) => {

    if (!reporterId || !canReport || reportSubmitting) {

      setPendingReportReason(null);

      return;

    }



    setReportSubmitting(true);

    try {

      await addDoc(collection(db, "reports"), {

        reportedBy: reporterId,

        contentType: "poll",

        contentId: poll.id,

        reason,

        status: "pending",

        createdAt: serverTimestamp(),

      });



      setPendingReportReason(null);

      setReportFeedback({

        title: "Report sent",

        description: "Thank you. Your report has been sent to the moderation team for review.",

        destructive: false,

      });

    } catch (error) {

      console.error("Failed to report poll:", error);

      setPendingReportReason(null);

      setReportFeedback({

        title: "Couldn't send report",

        description: "Please try again.",

        destructive: true,

      });

    } finally {

      setReportSubmitting(false);

    }

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

                  <Image source={{ uri: avatarThumb(authorAvatarUri, AVATAR_SIZE_SMALL) }} style={styles.avatarImage} />

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

          <View style={styles.pollHeader}>

            <View style={styles.headerTopRow}>

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



              </View>

              <View style={styles.headerRight}>

                {canOpenOptions && (

                  <TouchableOpacity

                    onPress={() => setShowPollActions(true)}

                    style={styles.moreButton}

                    activeOpacity={0.7}

                  >

                    <Ionicons

                      name="ellipsis-horizontal"

                      size={18}

                      color="#8f6a60"

                    />

                  </TouchableOpacity>

                )}

              </View>

            </View>

            <Text style={styles.timestamp}>{getTimeAgo(poll.createdAt)}</Text>

          </View>



          <View style={styles.flairBadge}>

            <Text style={styles.flairBadgeEmoji}>{pollFlair.emoji}</Text>

            <Text style={styles.flairBadgeText}>{pollFlair.label}</Text>

          </View>



          <Text style={styles.pollQuestion}>{poll.question}</Text>



          {poll.imageUrl && (

            <TouchableOpacity

              activeOpacity={0.9}

              onPress={() => onImagePress([poll.imageUrl!], 0)}

              style={styles.imageContainer}

            >

              <Image

                source={{ uri: feedImage(poll.imageUrl, FEED_IMAGE_WIDTH) }}

                style={styles.pollImage}

                contentFit="cover"

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

                    <PollProgressBar percentage={percentage} />

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

                  color={theme.textSecondary}

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

                      <Ionicons name="people-outline" size={16} color={theme.textMuted} />

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

          <ActivityIndicator size="small" color={theme.primary} />

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

      <ContentActionMenu

        visible={showPollActions}

        title="Poll Actions"

        actions={[

          ...(canEdit

            ? [{ label: "Edit Poll", icon: "create-outline" as const, onPress: handleEditPoll }]

            : []),

          ...(canDelete && onDelete

            ? [{ label: "Delete Poll", icon: "trash-outline" as const, onPress: handleDeletePoll, destructive: true }]

            : []),

          ...(canReport

            ? [{ label: "Report Poll", icon: "flag-outline" as const, onPress: openReportModal, destructive: true }]

            : []),

        ]}

        onClose={() => setShowPollActions(false)}

      />

      <Modal

        visible={showReportModal}

        transparent

        animationType="fade"

        onRequestClose={() => !reportSubmitting && setShowReportModal(false)}

      >

        <View style={styles.reportModalOverlay}>

          <View style={styles.reportModalContainer}>

            <View style={styles.reportModalHeader}>

              <View>

                <Text style={styles.reportModalTitle}>Report Poll</Text>

                <Text style={styles.reportModalSubtitle}>

                  Why are you reporting this poll?

                </Text>

              </View>

              <TouchableOpacity

                onPress={() => !reportSubmitting && setShowReportModal(false)}

                disabled={reportSubmitting}

              >

                <Ionicons name="close-circle-outline" size={28} color="#a61f1f" />

              </TouchableOpacity>

            </View>



            {[

              ["harassment_or_bullying", "Harassment or bullying", "person-remove-outline"],

              ["hate_or_discrimination", "Hate or discrimination", "ban-outline"],

              ["sexual_or_explicit_content", "Sexual or explicit content", "warning-outline"],

              ["violence_or_threats", "Violence or threats", "alert-circle-outline"],

              ["spam_or_scam", "Spam or scam", "megaphone-outline"],

              ["other", "Other", "ellipsis-horizontal-circle-outline"],

            ].map(([value, label, icon]) => (

              <TouchableOpacity

                key={value}

                style={styles.reportReasonButton}

                onPress={() => {

                  setShowReportModal(false);

                  setPendingReportReason(value);

                }}

                disabled={reportSubmitting}

                activeOpacity={0.75}

              >

                <View style={styles.reportReasonIcon}>

                  <Ionicons

                    name={icon as keyof typeof Ionicons.glyphMap}

                    size={19}

                    color="#a61f1f"

                  />

                </View>

                <Text style={styles.reportReasonText}>{label}</Text>

                <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />

              </TouchableOpacity>

            ))}



            {reportSubmitting && (

              <View style={styles.reportSubmitting}>

                <ActivityIndicator color={theme.accent} />

                <Text style={styles.reportSubmittingText}>Submitting report...</Text>

              </View>

            )}

          </View>

        </View>

      </Modal>

      <ConfirmDialog

        visible={!!pendingReportReason}

        title="Send report?"

        description="This report will be sent to the moderation team for review."

        confirmText="Send report"

        destructive

        loading={reportSubmitting}

        onConfirm={() => {

          if (pendingReportReason) {

            void submitReport(pendingReportReason);

          }

        }}

        onCancel={() => setPendingReportReason(null)}

      />

      <ConfirmDialog

        visible={!!reportFeedback}

        title={reportFeedback?.title ?? ""}

        description={reportFeedback?.description}

        confirmText="Done"

        singleAction

        destructive={reportFeedback?.destructive ?? false}

        icon={reportFeedback?.destructive ? "alert-circle-outline" : "checkmark-circle-outline"}

        onConfirm={() => setReportFeedback(null)}

        onCancel={() => setReportFeedback(null)}

      />

      <ConfirmDialog

        visible={!!confirmDialog}

        title={confirmDialog?.title ?? ""}

        description={confirmDialog?.description}

        confirmText={confirmDialog?.confirmText}

        cancelText={confirmDialog?.cancelText}

        destructive={confirmDialog?.destructive ?? false}

        singleAction={confirmDialog?.singleAction ?? false}

        loading={deleting}

        onConfirm={() => confirmDialog?.onConfirm()}

        onCancel={() => setConfirmDialog(null)}

      />

    </View>

  );

});

PollCard.displayName = "PollCard";



export default PollCard;



/**
 * The themed stylesheet for this component.
 *
 * Declared once because several memoised sub-components here render chrome,
 * and each must read the palette itself — handing them a styles object as a
 * prop would change its identity every render and defeat the memo.
 */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({

  pollCard: {

    backgroundColor: c.surface,

    paddingVertical: 14,

    paddingHorizontal: FEED_HORIZONTAL_PADDING,

    borderBottomWidth: 1,

    borderBottomColor: c.border,

    overflow: "visible",

  },

  highlightedPollCard: {

    borderLeftWidth: 4,

    borderLeftColor: c.danger,

    backgroundColor: c.surface,

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

    backgroundColor: c.border,

    justifyContent: "center",

    alignItems: "center",

    borderWidth: 1.5,

    borderColor: c.borderStrong,

    overflow: "hidden",

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

  pollHeader: {

    marginBottom: 8,

  },

  headerTopRow: {

    flexDirection: "row",

    alignItems: "flex-start",

    justifyContent: "space-between",

    gap: 8,

  },

  usernameRow: {

    flexDirection: "row",

    alignItems: "center",

    flexWrap: "wrap",

    gap: 8,

    flex: 1,

  },

  username: {

    color: c.textPrimary,

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

  headerRight: {

    flexDirection: "row",

    alignItems: "center",

    gap: 8,

  },

  moreButton: {

    paddingHorizontal: 2,

    paddingTop: 2,

    paddingBottom: 4,

    alignSelf: "flex-start",

  },

  timestamp: {

    color: c.textMuted,

    fontSize: 12.5,

    marginBottom: 4,

    letterSpacing: -0.1,

  },

  flairBadge: {

    alignSelf: "flex-start",

    flexDirection: "row",

    alignItems: "center",

    gap: 5,

    marginTop: 5,

    marginBottom: 5,

    paddingHorizontal: 9,

    paddingVertical: 5,

    borderRadius: 12,

    backgroundColor: c.surfaceSunken,

    borderWidth: 1,

    borderColor: c.border,

  },

  flairBadgeEmoji: {

    fontSize: 12,

  },

  flairBadgeText: {

    color: c.textSecondary,

    fontSize: 11.5,

    fontWeight: "800",

  },

  pollQuestion: {

    color: c.textPrimary,

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

    backgroundColor: c.surfaceSunken,

    borderRadius: 8,

    padding: 10,

    borderWidth: 1,

    borderColor: c.dangerSoft,

    overflow: "hidden",

  },

  pollOptionVoted: {

    borderColor: c.danger,

    backgroundColor: c.surface,

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

    borderColor: c.textMuted,

    justifyContent: "center",

    alignItems: "center",

  },

  checkboxActive: {

    backgroundColor: c.danger,

    borderColor: c.danger,

  },

  radio: {

    width: 16,

    height: 16,

    borderRadius: 8,

    borderWidth: 2,

    borderColor: c.textMuted,

    justifyContent: "center",

    alignItems: "center",

  },

  radioActive: {

    borderColor: c.danger,

  },

  radioDot: {

    width: 7,

    height: 7,

    borderRadius: 4,

    backgroundColor: c.danger,

  },

  pollOptionText: {

    color: c.textPrimary,

    fontSize: 13,

    flex: 1,

  },

  userAddedBadge: {

    backgroundColor: c.surfaceSunken,

    paddingHorizontal: 6,

    paddingVertical: 2,

    borderRadius: 4,

    borderWidth: 0.5,

    borderColor: c.accentSoft,

  },

  userAddedText: {

    color: c.textMuted,

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

    backgroundColor: c.danger,

    opacity: 0.24,

    zIndex: 1,

    borderTopRightRadius: 10,

    borderBottomRightRadius: 10,

  },

  pollVoteCount: {

    color: c.textPrimary,

    fontSize: 11,

    fontWeight: "700",

    marginLeft: "auto",

    zIndex: 2,

  },

  addOptionButtonText: {

    color: c.danger,

    fontWeight: "600",

    fontSize: 12,

  },

  addOptionForm: {

    backgroundColor: c.surfaceSunken,

    borderRadius: 8,

    padding: 10,

    marginVertical: 8,

    marginBottom: 12,

    borderWidth: 1,

    borderColor: c.accentSoft,

  },



  addOptionBtnDisabled: {

    opacity: 0.6,

  },

  addOptionCharCount: {

    color: c.textMuted,

    fontSize: 11,

    marginTop: 6,

    textAlign: "right",

  },

  pollFooter: {

    marginTop: 8,

  },

  voterSection: {

    backgroundColor: c.surface,

    borderRadius: 12,

    borderWidth: 1,

    borderColor: c.border,

    padding: 12,

    marginBottom: 10,

  },

  voterToggleButton: {

    flexDirection: "row",

    alignItems: "center",

    justifyContent: "space-between",

  },

  voterToggleButtonText: {

    color: c.textSecondary,

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

    backgroundColor: c.surface,

    borderRadius: 10,

    borderWidth: 1,

    borderColor: c.border,

    paddingHorizontal: 12,

    paddingVertical: 10,

  },

  voterEmptyStateText: {

    color: c.textMuted,

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

    color: c.primary,

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

    backgroundColor: c.surface,

    borderRadius: 999,

    borderWidth: 1,

    borderColor: c.border,

    paddingHorizontal: 10,

    paddingVertical: 7,

  },

  voterChipText: {

    color: c.primary,

    fontSize: 12,

    fontWeight: "600",

  },

  statsRow: {

    flexDirection: "row",

    flexWrap: "wrap",

    gap: 14,

  },

  statText: {

    color: c.textMuted,

    fontSize: 13,

    fontWeight: "500",

  },

  pollExpiredBadge: {

    flexDirection: "row",

    alignItems: "center",

    gap: 4,

  },

  pollExpired: {

    color: c.danger,

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

  backgroundColor: c.surfaceSunken,

  borderRadius: 10,

  padding: 12,

  marginVertical: 10,

  borderWidth: 1,

  borderColor: c.accentSoft,

},



addOptionLabel: {

  color: c.textMuted,

  fontSize: 13,

  fontWeight: "500",

  marginBottom: 8,

},



addOptionInputWrapper: {

  position: "relative",

  marginBottom: 12,

},



addOptionInput: {

  backgroundColor: c.surface,

  borderRadius: 8,

  paddingHorizontal: 12,

  paddingVertical: 11,

  color: c.textPrimary,

  fontSize: 14,

  borderWidth: 1,

  borderColor: c.border,

},



charCounter: {

  position: "absolute",

  right: 10,

  bottom: 8,

},



charCountText: {

  color: c.textMuted,

  fontSize: 11,

  fontWeight: "500",

},



addOptionActions: {

  flexDirection: "row",

  justifyContent: "flex-end",

  gap: 12,

},



addOptionSubmitBtn: {

  backgroundColor: c.accent,

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

  borderColor: c.accentSoft,

  minWidth: 80,

  alignItems: "center",

},



submitText: {

  color: c.primary,

  fontWeight: "600",

  fontSize: 13,

},



cancelText: {

  color: c.textMuted,

  fontWeight: "500",

  fontSize: 13,

},



btnDisabled: {

  opacity: 0.5,

},

addOptionErrorText: {

  color: c.danger,

  fontSize: 12,

  marginTop: 6,

  marginBottom: 4,

},



addOptionDisabledNotice: {

  paddingVertical: 10,

  alignItems: "center",

},



disabledText: {

  color: c.textMuted,

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

  borderColor: c.accentSoft,

  backgroundColor: c.surfaceSunken,

  alignSelf: "flex-start",

  marginTop: 6,

  marginBottom: 10,

},

reportModalOverlay: {

  flex: 1,

  backgroundColor: "rgba(0,0,0,0.82)",

  justifyContent: "center",

  alignItems: "center",

},

reportModalContainer: {

  width: "88%",

  maxHeight: "80%",

  backgroundColor: c.surface,

  borderRadius: 16,

  borderWidth: 1,

  borderColor: c.border,

  overflow: "hidden",

  paddingBottom: 8,

},

reportModalHeader: {

  minHeight: 68,

  paddingHorizontal: 18,

  paddingVertical: 12,

  flexDirection: "row",

  alignItems: "center",

  justifyContent: "space-between",

},

reportModalTitle: {

  color: c.textPrimary,

  fontSize: 17,

  fontWeight: "700",

},

reportModalSubtitle: {

  color: c.textMuted,

  fontSize: 13,

  marginTop: 3,

},

reportReasonButton: {

  flexDirection: "row",

  alignItems: "center",

  paddingHorizontal: 18,

  paddingVertical: 13,

  borderTopWidth: 1,

  borderTopColor: c.border,

  gap: 12,

},

reportReasonIcon: {

  width: 34,

  height: 34,

  borderRadius: 17,

  backgroundColor: c.surface,

  alignItems: "center",

  justifyContent: "center",

},

reportReasonText: {

  flex: 1,

  color: c.textPrimary,

  fontSize: 14,

  fontWeight: "600",

},

reportSubmitting: {

  flexDirection: "row",

  alignItems: "center",

  justifyContent: "center",

  gap: 8,

  paddingVertical: 12,

},

reportSubmittingText: {

  color: c.textMuted,

  fontSize: 13,

},

});

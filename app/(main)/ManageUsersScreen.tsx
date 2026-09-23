// app/(main)/ManageUsersScreen.tsx
import { useThemeColors } from "@/contexts/ThemeContext";
import { onSurface, type ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  doc,
  getCountFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
// The keyboard library's own view. It follows the keyboard frame by frame;
// React Native's built-in one stopped lifting anything on Android once
// KeyboardProvider (app/_layout.tsx) took over the keyboard.
import {
  KeyboardAvoidingView,
  KeyboardAwareScrollView,
} from "react-native-keyboard-controller";
import { Image } from "expo-image";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import AlumniBadge from "./components/AlumniBadge";
import ConfirmDialog from "./components/ConfirmDialog";
import { CardListSkeleton, SkeletonBlock } from "./components/Skeleton";
import { auth, db } from "../../Firebase_configure";
import {
  ACCOUNT_RECOVERY_LABELS,
  fetchAccountRecoveryLog,
  movePersonalEmailsToPrivate,
  runAccountRecovery,
  type AccountRecoveryAction,
  type AccountRecoveryLogEntry,
} from "@/utils/accountRecovery";
import { formatChatTimeLabel } from "@/utils/chatTime";
import { validPersonalEmail } from "@/utils/profileSetup";
import { showAppToast } from "@/utils/toastEvents";
import { avatarThumb } from "@/utils/cloudinaryImages";
import { buildUserProfileHref } from "@/utils/profileNavigation";
import {
  canManageUsers,
  getPermissionsForRole,
  getRoleDisplayName,
  getRoleHierarchyLevel,
  parseUserRole,
  type UserRole,
} from "@/utils/rbac";
import { useCurrentUserRole } from "@/utils/useCurrentUserRole";
import { isAlumni, isPromotableRole, YEAR_LEVELS } from "@/utils/yearLevels";

const YEAR_LEVEL_OPTIONS = YEAR_LEVELS;

// Fix 2: the students listener is bounded to this many rows and grown by
// "Load more" (same single-tier limit pattern as ManageModerationScreen's
// PAGE_SIZE), instead of streaming the whole collection into an unvirtualized
// list.
const PAGE_SIZE = 40;

type ManagedUserFilter =
  | "all"
  | "online"
  | "admin"
  | "teacher"
  | "moderator"
  | "student"
  | "alumni";

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
  /**
   * Excludes this account from the scheduled year level promotion — for a
   * student repeating a year while everyone else moves up. See
   * YearPromotionScreen and runYearLevelPromotions in functions/index.js.
   */
  promotionHold?: boolean;
  /** Where password reset codes go. Shown so an admin can check it's theirs. */
  recoveryEmail?: string;
  recoveryEmailVerified?: boolean;
  /** Set by Account recovery → Lock: nobody can sign in until unlocked. */
  accountLocked?: boolean;
  /**
   * The public profile, which everyone signed in can read, still carries a
   * personal email or recovery details from before private records.
   */
  publicPersonalData?: boolean;
};

/** A person's private record: personal email and recovery details. */
type PrivateProfileRecord = {
  email?: string;
  recoveryEmail?: string;
  recoveryEmailVerified?: boolean;
};

// Mirrors the `programs` collection shape used by the registration program
// picker (AdminRegisterUserScreen / AdminManageProgramsScreen). A student's
// `course` field stores the program *name*, so that is what we validate against.
type Program = {
  id: string;
  name: string;
  code: string;
  description?: string;
};

// Roles for which a program is mandatory (matches AdminRegisterUserScreen's
// registration rules). Teachers/admins may have a blank program.
const PROGRAM_REQUIRED_ROLES: UserRole[] = ["student", "moderator"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FILTERS: {
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
  // Graduates are still students by role, so without their own chip the
  // Students filter and the Students metric would disagree about who counts.
  { value: "alumni", label: "Alumni", icon: "ribbon-outline" },
];

const ROLE_OPTIONS: {
  value: UserRole;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { value: "student", label: "Student", icon: "people-outline" },
  { value: "moderator", label: "Moderator", icon: "shield-outline" },
  { value: "teacher", label: "Teacher", icon: "school-outline" },
  { value: "admin", label: "Admin", icon: "shield-checkmark-outline" },
];

function getName(user: ManagedUserRecord) {
  return (
    `${user.firstname || ""} ${user.lastname || ""}`.trim() ||
    user.email ||
    "Unknown user"
  );
}

function getInitials(user: ManagedUserRecord) {
  const seed = `${user.firstname?.[0] || ""}${user.lastname?.[0] || ""}`.trim();
  if (seed) return seed.toUpperCase();
  return (user.email?.[0] || user.studentID?.[0] || "U").toUpperCase();
}

function getMeta(user: ManagedUserRecord) {
  return (
    [user.studentID, user.course, user.yearlvl].filter(Boolean).join(" • ") ||
    "No profile details yet"
  );
}

function getRoleColor(role: string | null, tokens?: ThemeTokens) {
  const colors: Record<string, string> = {
    admin: "#8f1d2c",
    teacher: "#b86b1d",
    moderator: "#6e4aa3",
    student: "#356a59",
  };
  const picked = colors[role || ""] || "#356a59";
  return tokens ? onSurface(picked, tokens) : picked;
}

// Fix 2: extracted from the inline .map() and memoized so a students-collection
// change (or an unrelated screen re-render) only re-renders the rows whose
// props actually changed, not every visible card. Callbacks come in as stable
// references from the screen; per-row flags (expanded / busy / isSelf) are
// primitives so React.memo's shallow compare does the right thing.
type UserRowProps = {
  user: ManagedUserRecord;
  expanded: boolean;
  busy: boolean;
  isSelf: boolean;
  isRecentlyUpdated?: boolean;
  onToggleExpand: (id: string) => void;
  onOpenProfile: (user: ManagedUserRecord) => void;
  onOpenEdit: (user: ManagedUserRecord) => void;
  onChangeYear: (user: ManagedUserRecord, year: string) => void;
  onChangeRole: (user: ManagedUserRecord, role: UserRole) => void;
  onTogglePromotionHold: (user: ManagedUserRecord) => void;
  /** The recovery action running on this row, if any. */
  recoveryBusy: AccountRecoveryAction | null;
  /** Changes after each recovery action, so the history reloads. */
  historyKey: number;
  onRecoveryAction: (user: ManagedUserRecord, action: AccountRecoveryAction) => void;
};

function UserRowComponent({
  user,
  expanded,
  busy,
  isSelf,
  isRecentlyUpdated,
  onToggleExpand,
  onOpenProfile,
  onOpenEdit,
  onChangeYear,
  onChangeRole,
  onTogglePromotionHold,
  recoveryBusy,
  historyKey,
  onRecoveryAction,
}: UserRowProps) {
  const { styles, theme } = useStyles();
  const normalizedRole = parseUserRole(user.role) || "student";
  const recoveryButtons: {
    action: AccountRecoveryAction;
    label: string;
    help: string;
    icon: keyof typeof Ionicons.glyphMap;
    danger?: boolean;
    unavailable?: boolean;
  }[] = [
    {
      action: "reset-password",
      icon: "key-outline",
      label: "Reset to temporary password",
      help: "Shown to you once. They choose their own when they sign in.",
    },
    {
      action: "remove-recovery-email",
      icon: "mail-unread-outline",
      label: "Remove recovery email",
      help: "Stops reset codes going to it, and signs them out everywhere.",
      unavailable: !user.recoveryEmail,
    },
    {
      action: "sign-out-all",
      icon: "log-out-outline",
      label: "Sign out all devices",
      help: "Ends every session. Their password stays the same.",
    },
    user.accountLocked
      ? {
          action: "unlock",
          icon: "lock-open-outline",
          label: "Unlock account",
          help: "Lets them sign in again.",
        }
      : {
          action: "lock",
          icon: "lock-closed-outline",
          label: "Lock account",
          help: "Blocks every sign-in until you unlock it.",
          danger: true,
        },
  ];

  return (
    <View
      style={[
        styles.userCard,
        expanded && styles.userCardExpanded,
        isRecentlyUpdated && styles.userCardRecentlyUpdated,
      ]}
    >
      <TouchableOpacity
        style={styles.userHeader}
        onPress={() => onToggleExpand(user.id)}
        activeOpacity={0.86}
      >
        <View style={styles.identityRow}>
          <View style={styles.avatar}>
            {user.profileImage ? (
              <Image
                source={{ uri: avatarThumb(user.profileImage, 52) }}
                style={styles.avatarImage}
              />
            ) : (
              <Text style={styles.avatarText}>{getInitials(user)}</Text>
            )}
            <View
              style={[
                styles.presenceDot,
                { backgroundColor: user.isOnline ? "#2e8b68" : theme.textMuted },
              ]}
            />
          </View>

          <View style={styles.identityCopy}>
            <View style={styles.nameRow}>
              <Text style={styles.userName} numberOfLines={1}>
                {getName(user)}
              </Text>
              {isSelf && (
                <View style={styles.youBadge}>
                  <Text style={styles.youBadgeText}>You</Text>
                </View>
              )}
              {isRecentlyUpdated && (
                <View style={styles.updatedBadge}>
                  <Ionicons name="checkmark-circle" size={11} color={theme.accent} />
                  <Text style={styles.updatedBadgeText}>Updated</Text>
                </View>
              )}
            </View>
            <Text style={styles.userMeta} numberOfLines={2}>
              {getMeta(user)}
            </Text>
            <View style={styles.badgeRow}>
              <View
                style={[
                  styles.roleBadge,
                  { backgroundColor: getRoleColor(normalizedRole, theme) + "14" },
                ]}
              >
                <Text
                  style={[
                    styles.roleBadgeText,
                    { color: getRoleColor(normalizedRole, theme) },
                  ]}
                >
                  {getRoleDisplayName(normalizedRole)}
                </Text>
              </View>
              <AlumniBadge yearlvl={user.yearlvl} />
              {user.accountLocked && (
                <View style={styles.lockedBadge}>
                  <Ionicons name="lock-closed" size={10} color={theme.danger} />
                  <Text style={styles.lockedBadgeText}>Locked</Text>
                </View>
              )}
              <Text style={styles.statusText}>
                {user.isOnline ? "Online now" : "Offline"}
              </Text>
            </View>
          </View>
        </View>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={18}
          color={theme.textSecondary}
        />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.openProfileButton}
        onPress={() => onOpenProfile(user)}
        activeOpacity={0.82}
      >
        <Ionicons name="person-circle-outline" size={17} color={theme.accent} />
        <Text style={styles.openProfileText}>Open profile</Text>
        <Ionicons name="arrow-forward" size={15} color={theme.accent} />
      </TouchableOpacity>

      {expanded && (
        <View style={styles.expandedPanel}>
          <Text style={styles.controlTitle}>Profile details</Text>
          <Text style={styles.controlHelp}>
            Correct this account&apos;s name, email, or program.
          </Text>
          <TouchableOpacity
            style={styles.editDetailsButton}
            onPress={() => onOpenEdit(user)}
            disabled={busy}
            activeOpacity={0.82}
          >
            <Ionicons name="create-outline" size={15} color={theme.accent} />
            <Text style={styles.editDetailsText}>Edit name, email &amp; program</Text>
          </TouchableOpacity>

          <View style={styles.divider} />

          <Text style={styles.controlTitle}>Year level</Text>
          <Text style={styles.controlHelp}>
            Keep the student&apos;s academic level current.
          </Text>
          <View style={styles.optionGrid}>
            {YEAR_LEVEL_OPTIONS.map((yearOption) => {
              const selected = user.yearlvl === yearOption;
              return (
                <TouchableOpacity
                  key={`${user.id}-${yearOption}`}
                  style={[
                    styles.optionButton,
                    selected && styles.optionButtonSelected,
                  ]}
                  onPress={() => onChangeYear(user, yearOption)}
                  disabled={busy}
                  activeOpacity={0.82}
                >
                  <Ionicons
                    name="school-outline"
                    size={15}
                    color={selected ? theme.onPrimary : theme.primary}
                  />
                  <Text
                    style={[
                      styles.optionText,
                      selected && styles.optionTextSelected,
                    ]}
                  >
                    {yearOption}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Only students climb the ladder, so the hold is meaningless on a
              staff account and would just be a switch that does nothing. */}
          {isPromotableRole(user.role) && (
            <TouchableOpacity
              style={[
                styles.holdRow,
                user.promotionHold && styles.holdRowActive,
              ]}
              onPress={() => onTogglePromotionHold(user)}
              disabled={busy}
              activeOpacity={0.84}
            >
              <Ionicons
                name={user.promotionHold ? "pause-circle" : "pause-circle-outline"}
                size={19}
                color={user.promotionHold ? theme.danger : theme.textMuted}
              />
              <View style={styles.holdCopy}>
                <Text
                  style={[
                    styles.holdTitle,
                    user.promotionHold && styles.holdTitleActive,
                  ]}
                >
                  {user.promotionHold
                    ? "Held back from promotion"
                    : "Hold back from promotion"}
                </Text>
                <Text style={styles.holdHelp}>
                  {user.promotionHold
                    ? "Scheduled promotions skip this student. You can still change the year level by hand."
                    : "Use this for a student repeating the year."}
                </Text>
              </View>
              <View
                style={[
                  styles.holdSwitch,
                  user.promotionHold && styles.holdSwitchOn,
                ]}
              >
                <View
                  style={[
                    styles.holdKnob,
                    user.promotionHold && styles.holdKnobOn,
                  ]}
                />
              </View>
            </TouchableOpacity>
          )}

          <View style={styles.divider} />

          <Text style={styles.controlTitle}>Role access</Text>
          <Text style={styles.controlHelp}>
            Choose the access level that matches this account.
          </Text>
          <View style={styles.optionGrid}>
            {ROLE_OPTIONS.map((roleOption) => {
              const selected = normalizedRole === roleOption.value;
              return (
                <TouchableOpacity
                  key={`${user.id}-${roleOption.value}`}
                  style={[
                    styles.optionButton,
                    selected && styles.optionButtonSelected,
                  ]}
                  onPress={() => onChangeRole(user, roleOption.value)}
                  disabled={busy || isSelf || selected}
                  activeOpacity={0.82}
                >
                  <Ionicons
                    name={roleOption.icon}
                    size={15}
                    color={selected ? theme.onPrimary : getRoleColor(roleOption.value, theme)}
                  />
                  <Text
                    style={[
                      styles.optionText,
                      selected && styles.optionTextSelected,
                    ]}
                  >
                    {roleOption.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator size="small" color={theme.textSecondary} />
              <Text style={styles.busyText}>Updating account…</Text>
            </View>
          ) : (
            <Text style={styles.hintText}>
              Role changes update the student record immediately. The user may
              need to refresh their session to receive the new access
              everywhere.
            </Text>
          )}

          <View style={styles.divider} />

          <Text style={styles.controlTitle}>Account recovery</Text>
          <Text style={styles.controlHelp}>
            For someone locked out of their account, or whose email someone
            else has. Confirm who they are first — in person or from school
            records.
          </Text>
          <View style={styles.recoveryStatusRow}>
            <Ionicons
              name={user.recoveryEmail ? "mail-outline" : "mail-unread-outline"}
              size={15}
              color={theme.textSecondary}
            />
            <Text style={styles.recoveryStatusText} numberOfLines={2}>
              {user.recoveryEmail
                ? `Recovery email: ${user.recoveryEmail}${
                    user.recoveryEmailVerified ? "" : " (not verified)"
                  }`
                : "No recovery email"}
            </Text>
          </View>
          {user.accountLocked && (
            <View style={styles.lockedNotice}>
              <Ionicons name="lock-closed" size={15} color={theme.danger} />
              <Text style={styles.lockedNoticeText}>
                Locked — nobody can sign in to this account until it&apos;s unlocked.
              </Text>
            </View>
          )}
          {isSelf ? (
            <Text style={styles.hintText}>
              These can&apos;t be used on your own account. Another admin can
              do it for you.
            </Text>
          ) : (
            <>
              <View style={styles.recoveryActions}>
                {recoveryButtons.map((item) => {
                  const running = recoveryBusy === item.action;
                  return (
                    <TouchableOpacity
                      key={item.action}
                      style={[
                        styles.recoveryAction,
                        item.danger && styles.recoveryActionDanger,
                        item.unavailable && styles.recoveryActionUnavailable,
                      ]}
                      onPress={() => onRecoveryAction(user, item.action)}
                      disabled={!!recoveryBusy || item.unavailable}
                      activeOpacity={0.84}
                      accessibilityRole="button"
                      accessibilityLabel={item.label}
                      accessibilityState={{
                        disabled: !!recoveryBusy || !!item.unavailable,
                        busy: running,
                      }}
                    >
                      <View
                        style={[
                          styles.recoveryIcon,
                          item.danger && styles.recoveryIconDanger,
                        ]}
                      >
                        <Ionicons
                          name={item.icon}
                          size={16}
                          color={item.danger ? theme.danger : theme.primary}
                        />
                      </View>
                      <View style={styles.recoveryCopy}>
                        <Text
                          style={[
                            styles.recoveryLabel,
                            item.danger && styles.recoveryLabelDanger,
                          ]}
                        >
                          {item.label}
                        </Text>
                        <Text style={styles.recoveryHelp}>{item.help}</Text>
                      </View>
                      {running ? (
                        <ActivityIndicator size="small" color={theme.textSecondary} />
                      ) : (
                        <Ionicons name="chevron-forward" size={15} color={theme.textMuted} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
              <RecoveryHistory studentID={user.id} refreshKey={historyKey} />
            </>
          )}
        </View>
      )}
    </View>
  );
}
const UserRow = React.memo(UserRowComponent);

/**
 * The latest account recovery actions on one account: what was done, by
 * which admin, and when. Loaded when the card opens and again after each
 * action (refreshKey).
 */
function RecoveryHistory({
  studentID,
  refreshKey,
}: {
  studentID: string;
  refreshKey: number;
}) {
  const { styles } = useStyles();
  const requestKey = `${studentID}:${refreshKey}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    entries: (AccountRecoveryLogEntry & { when: string })[];
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAccountRecoveryLog(studentID)
      .then((entries) => {
        if (cancelled) return;
        const nowMs = Date.now();
        setLoaded({
          key: requestKey,
          entries: entries.map((entry) => ({
            ...entry,
            when: entry.atMs ? formatChatTimeLabel(entry.atMs, nowMs) : "",
          })),
          failed: false,
        });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: requestKey, entries: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, studentID]);

  const current = loaded?.key === requestKey ? loaded : null;

  return (
    <View style={styles.recoveryHistory}>
      <Text style={styles.recoveryHistoryTitle}>Recovery history</Text>
      {!current ? (
        <SkeletonBlock width="72%" height={11} />
      ) : current.failed ? (
        <Text style={styles.recoveryHistoryEmpty}>
          History isn&apos;t available right now.
        </Text>
      ) : current.entries.length === 0 ? (
        <Text style={styles.recoveryHistoryEmpty}>No recovery actions yet.</Text>
      ) : (
        current.entries.map((entry) => (
          <View key={entry.id} style={styles.recoveryHistoryRow}>
            <View style={styles.recoveryHistoryDot} />
            <Text style={styles.recoveryHistoryText}>
              <Text style={styles.recoveryHistoryStrong}>
                {ACCOUNT_RECOVERY_LABELS[entry.action]}
              </Text>
              {` by ${entry.byName}${entry.when ? ` · ${entry.when}` : ""}`}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

export default function ManageUsersScreen() {
  const { styles, theme } = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList<ManagedUserRecord>>(null);
  const [loading, setLoading] = useState(true);
  // Live, so an account that loses user-management access is turned out of
  // this screen rather than keeping it open.
  const role = useCurrentUserRole();
  const [rawUsers, setRawUsers] = useState<ManagedUserRecord[]>([]);
  // Personal emails live in private records only admins (and their owners)
  // can read; merged over the public profiles below.
  const [privateById, setPrivateById] = useState<Record<string, PrivateProfileRecord>>({});
  const [movingEmails, setMovingEmails] = useState(false);
  const users = useMemo(
    () =>
      rawUsers.map((user) => {
        const secret = privateById[user.id];
        if (!secret) return user;
        return {
          ...user,
          email: secret.email || user.email,
          recoveryEmail: secret.recoveryEmail ?? user.recoveryEmail,
          recoveryEmailVerified: secret.recoveryEmailVerified ?? user.recoveryEmailVerified,
        };
      }),
    [privateById, rawUsers],
  );
  const [usersLoading, setUsersLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ManagedUserFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [recentlyUpdatedId, setRecentlyUpdatedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Account recovery: the action running, the history reload counter, and a
  // temporary password waiting to be read out (shown once, never stored).
  const [recoveryBusy, setRecoveryBusy] = useState<{
    id: string;
    action: AccountRecoveryAction;
  } | null>(null);
  const [recoveryHistoryKey, setRecoveryHistoryKey] = useState(0);
  const [issuedPassword, setIssuedPassword] = useState<{
    name: string;
    studentID: string;
    password: string;
  } | null>(null);
  const [issuedCopied, setIssuedCopied] = useState(false);
  // Fix 2: bounded page that "Load more" grows.
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Fix 2: chip / metric counts come from server-side aggregation so they stay
  // accurate no matter how many pages are loaded (no docs downloaded).
  const [roleCounts, setRoleCounts] = useState({
    all: 0,
    online: 0,
    admin: 0,
    teacher: 0,
    moderator: 0,
    student: 0,
    alumni: 0,
  });

  // Managed program catalog — the same `programs` collection the registration
  // screen reads. Used to validate the program field in the profile editor so
  // an admin can't set a `course` value that isn't a real program.
  const [programs, setPrograms] = useState<Program[]>([]);
  const [programsLoading, setProgramsLoading] = useState(true);

  // Profile editor (name / email / program). Student ID is deliberately NOT
  // editable here — see the comment on `openEditProfile` below.
  const [editUser, setEditUser] = useState<ManagedUserRecord | null>(null);
  const [editFirstname, setEditFirstname] = useState("");
  const [editLastname, setEditLastname] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editCourse, setEditCourse] = useState("");
  const [editProgramSearch, setEditProgramSearch] = useState("");
  const [editProgramPickerOpen, setEditProgramPickerOpen] = useState(false);
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardVisible(false),
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

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

  const canManage = canManageUsers(role);
  const currentStudentDocId = auth.currentUser?.email?.split("@")[0] || null;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setLoading(false);
      if (!user) {
        router.replace("/(main)/(tabs)/HomeScreen");
      }
    });

    return unsubscribe;
  }, [router]);

  // The role is tracked live above, so losing access closes this screen
  // straight away. undefined means it has not resolved yet, which must not
  // trigger a redirect.
  useEffect(() => {
    if (role !== undefined && !canManageUsers(role)) {
      router.replace("/(main)/(tabs)/DashboardScreen");
    }
  }, [role, router]);

  useEffect(() => {
    if (!canManage || !auth.currentUser) {
      setRawUsers([]);
      setUsersLoading(false);
      return;
    }

    setUsersLoading(true);
    // Bounded live listener: at most `pageLimit` student docs, grown by
    // "Load more". Ordered implicitly by document id, which every doc has, so
    // no user is ever excluded for missing a sort field. Display order is
    // still the client-side online/role/name sort in filteredUsers below.
    return onSnapshot(
      query(collection(db, "students"), limit(pageLimit)),
      (snapshot) => {
        setRawUsers(
          snapshot.docs.map((item) => {
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
              promotionHold: data.promotionHold === true,
              recoveryEmail: data.recoveryEmail || "",
              recoveryEmailVerified: data.recoveryEmailVerified === true,
              accountLocked: data.accountLocked === true,
              publicPersonalData:
                data.recoveryEmail !== undefined ||
                data.recoveryEmailVerified !== undefined ||
                validPersonalEmail(data.email),
            };
          }),
        );
        setHasMore(snapshot.size === pageLimit);
        setUsersLoading(false);
        setLoadingMore(false);
      },
      (error) => {
        console.error("Error loading managed users:", error);
        showInfo("Unable to load users", "Please try again in a moment.");
        setUsersLoading(false);
        setLoadingMore(false);
      },
    );
  }, [canManage, pageLimit]);

  // Everyone's private record. Admin only; if the rules don't allow it yet,
  // the public profiles are all there is.
  useEffect(() => {
    if (!canManage || !auth.currentUser) return;
    return onSnapshot(
      collection(db, "studentPrivate"),
      (snapshot) => {
        const next: Record<string, PrivateProfileRecord> = {};
        snapshot.docs.forEach((item) => {
          const data = item.data();
          next[item.id] = {
            email: typeof data.email === "string" ? data.email : undefined,
            recoveryEmail: typeof data.recoveryEmail === "string" ? data.recoveryEmail : undefined,
            recoveryEmailVerified:
              typeof data.recoveryEmailVerified === "boolean" ? data.recoveryEmailVerified : undefined,
          };
        });
        setPrivateById(next);
      },
      (error) => console.warn("[privacy] Private records unavailable:", error?.message || error),
    );
  }, [canManage]);

  // Profiles saved before private records still show a personal email to
  // everyone signed in. One tap moves them all.
  const publicEmailCount = useMemo(
    () => rawUsers.filter((user) => user.publicPersonalData).length,
    [rawUsers],
  );
  const handleMoveEmails = () => {
    showConfirm({
      title: "Make personal emails private?",
      description:
        "Personal emails move from public profiles, which any signed-in user can read, to private records only the owner and admins can see. Do this after everyone has the latest app version: an older version will ask people to verify their email again.",
      confirmText: "Make private",
      onConfirm: () => {
        setMovingEmails(true);
        movePersonalEmailsToPrivate()
          .then((moved) =>
            showAppToast({
              message: moved
                ? `${moved} ${moved === 1 ? "email is" : "emails are"} now private`
                : "Every email is already private",
            }),
          )
          .catch((error) =>
            showInfo("Couldn't move the emails", error?.message || "Please try again."),
          )
          .finally(() => setMovingEmails(false));
      },
    });
  };

  // Live program catalog for the profile editor's program picker/validation.
  useEffect(() => {
    if (!canManage || !auth.currentUser) {
      setPrograms([]);
      setProgramsLoading(false);
      return;
    }
    return onSnapshot(
      query(collection(db, "programs"), orderBy("name", "asc")),
      (snapshot) => {
        setPrograms(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<Program, "id">),
          })),
        );
        setProgramsLoading(false);
      },
      (error) => {
        console.error("Error loading programs:", error);
        setProgramsLoading(false);
      },
    );
  }, [canManage]);

  const refreshCounts = useCallback(async () => {
    if (!canManage || !auth.currentUser) return;
    try {
      const students = collection(db, "students");
      const [all, online, admin, teacher, moderator, alumni] = await Promise.all([
        getCountFromServer(students),
        getCountFromServer(query(students, where("isOnline", "==", true))),
        getCountFromServer(query(students, where("role", "==", "admin"))),
        getCountFromServer(query(students, where("role", "==", "teacher"))),
        getCountFromServer(query(students, where("role", "==", "moderator"))),
        // Filtered on yearlvl alone so it stays a single-field query needing
        // no deployed composite index. Only students and student-moderators
        // are ever promoted to Graduated, so staff cannot land in this count
        // unless an administrator sets a teacher's year level by hand.
        getCountFromServer(query(students, where("yearlvl", "==", "Graduated"))),
      ]);
      const allCount = all.data().count;
      const staffCount =
        admin.data().count + teacher.data().count + moderator.data().count;
      const alumniCount = alumni.data().count;
      setRoleCounts({
        all: allCount,
        online: online.data().count,
        admin: admin.data().count,
        teacher: teacher.data().count,
        moderator: moderator.data().count,
        // Anyone who isn't admin/teacher/moderator (covers "student" plus any
        // legacy role value), minus those who have already graduated — so the
        // student body does not quietly grow by a class every June.
        student: Math.max(0, allCount - staffCount - alumniCount),
        alumni: alumniCount,
      });
    } catch (error) {
      console.error("Error loading user counts:", error);
    }
  }, [canManage]);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setPageLimit((current) => current + PAGE_SIZE);
  }, [hasMore, loadingMore]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  const counts = roleCounts;

  const filteredUsers = useMemo(() => {
    const queryValue = search.trim().toLowerCase();

    return [...users]
      .filter((item) => {
        const normalizedRole = parseUserRole(item.role) || "student";
        const alumni = isAlumni(item.yearlvl);
        const isCurrentlyActive =
          item.id === expandedId || item.id === recentlyUpdatedId;
        // Alumni are matched by year level rather than role, and are held out
        // of Students, so the chip counts agree with the metric cards above.
        const matchesFilter =
          filter === "all" ||
          (filter === "online" && item.isOnline === true) ||
          (filter === "alumni" && alumni) ||
          (filter === "student" && normalizedRole === "student" && !alumni) ||
          (filter !== "student" &&
            filter !== "alumni" &&
            normalizedRole === filter) ||
          isCurrentlyActive;

        if (!matchesFilter) return false;
        if (!queryValue) return true;

        return [
          getName(item),
          item.email,
          item.studentID,
          item.course,
          item.yearlvl,
          normalizedRole,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(queryValue);
      })
      .sort((first, second) => {
        if ((first.isOnline === true) !== (second.isOnline === true)) {
          return first.isOnline ? -1 : 1;
        }

        const roleDiff =
          getRoleHierarchyLevel(parseUserRole(second.role)) -
          getRoleHierarchyLevel(parseUserRole(first.role));
        if (roleDiff !== 0) return roleDiff;
        return getName(first).localeCompare(getName(second));
      });
  }, [expandedId, filter, recentlyUpdatedId, search, users]);

  // Keep recently updated user in view by smoothly scrolling to their position
  useEffect(() => {
    if (!recentlyUpdatedId) return;

    const targetIndex = filteredUsers.findIndex((u) => u.id === recentlyUpdatedId);
    if (targetIndex >= 0 && flatListRef.current) {
      const scrollTimer = setTimeout(() => {
        try {
          flatListRef.current?.scrollToIndex({
            index: targetIndex,
            animated: true,
            viewPosition: 0.3,
          });
        } catch {
          // Handled by onScrollToIndexFailed fallback
        }
      }, 150);

      const clearTimer = setTimeout(() => {
        setRecentlyUpdatedId((current) =>
          current === recentlyUpdatedId ? null : current,
        );
      }, 4000);

      return () => {
        clearTimeout(scrollTimer);
        clearTimeout(clearTimer);
      };
    }
  }, [filteredUsers, recentlyUpdatedId]);

  const openProfile = useCallback(
    (managedUser: ManagedUserRecord) => {
      const targetUserId =
        managedUser.userId || managedUser.studentID || managedUser.id;

      if (!targetUserId) {
        showInfo("Unavailable", "This user does not have a linked profile yet.");
        return;
      }

      if (auth.currentUser?.uid === targetUserId) {
        router.push({
          pathname: "/(main)/(tabs)/ProfileScreen",
          params: { returnTo: "/ManageUsersScreen" },
        });
        return;
      }

      router.push(
        buildUserProfileHref({
          userId: targetUserId,
          profileDocId: managedUser.id,
          returnTo: "/ManageUsersScreen",
        }) as any,
      );
    },
    [router],
  );

  const changeYearLevel = useCallback(
    (managedUser: ManagedUserRecord, nextYearLvl: string) => {
      if (!canManage || managedUser.yearlvl === nextYearLvl) return;

      showConfirm({
        title: "Update Year Level",
        description: `Change ${getName(managedUser)}'s year level to ${nextYearLvl}?`,
        confirmText: "Update",
        cancelText: "Cancel",
        destructive: false,
        onConfirm: async () => {
          try {
            setBusyId(managedUser.id);
            await updateDoc(doc(db, "students", managedUser.id), {
              yearlvl: nextYearLvl,
              updatedAt: serverTimestamp(),
            });
            setRecentlyUpdatedId(managedUser.id);
            setExpandedId(managedUser.id);
          } catch (error) {
            console.error("Error updating year level:", error);
            showInfo("Error", "Failed to update year level.");
          } finally {
            setBusyId(null);
          }
        },
      });
    },
    [canManage],
  );

  const togglePromotionHold = useCallback(
    (managedUser: ManagedUserRecord) => {
      if (!canManage) return;

      const nextHold = managedUser.promotionHold !== true;

      showConfirm({
        title: nextHold ? "Hold back this student?" : "Remove the hold?",
        description: nextHold
          ? `${getName(managedUser)} will be skipped by scheduled year level promotions until you remove the hold.`
          : `${getName(managedUser)} will be included in scheduled year level promotions again.`,
        confirmText: nextHold ? "Hold back" : "Remove hold",
        cancelText: "Cancel",
        destructive: false,
        onConfirm: async () => {
          try {
            setBusyId(managedUser.id);
            await updateDoc(doc(db, "students", managedUser.id), {
              promotionHold: nextHold,
              updatedAt: serverTimestamp(),
            });
            setRecentlyUpdatedId(managedUser.id);
            setExpandedId(managedUser.id);
          } catch (error) {
            console.error("Error updating promotion hold:", error);
            showInfo("Error", "Failed to update the promotion hold.");
          } finally {
            setBusyId(null);
          }
        },
      });
    },
    [canManage],
  );

  const changeRole = useCallback(
    (managedUser: ManagedUserRecord, nextRole: UserRole) => {
      if (!canManage) return;

      const currentRole = parseUserRole(managedUser.role) || "student";
      if (currentRole === nextRole) return;

      const isSelf =
        (!!managedUser.userId &&
          managedUser.userId === auth.currentUser?.uid) ||
        managedUser.id === currentStudentDocId;

      if (isSelf) {
        showInfo(
          "Action Blocked",
          "For safety, you cannot change your own role from the dashboard.",
        );
        return;
      }

      showConfirm({
        title: "Update Role",
        description: `Change ${getName(managedUser)} to ${getRoleDisplayName(nextRole)}?`,
        confirmText: "Update",
        cancelText: "Cancel",
        destructive: false,
        onConfirm: async () => {
          try {
            setBusyId(managedUser.id);
            await updateDoc(doc(db, "students", managedUser.id), {
              role: nextRole,
              permissions: getPermissionsForRole(nextRole),
              updatedAt: serverTimestamp(),
              roleUpdatedAt: serverTimestamp(),
              roleUpdatedBy: auth.currentUser?.uid || null,
            });
            setRecentlyUpdatedId(managedUser.id);
            setExpandedId(managedUser.id);
          } catch (error) {
            console.error("Error updating user role:", error);
            showInfo("Error", "Failed to update user role.");
          } finally {
            setBusyId(null);
          }
        },
      });
    },
    [canManage, currentStudentDocId],
  );

  // Account recovery. Each one is confirmed first, then run by the Worker,
  // which checks this is an admin and logs who did it and when.
  const recoverAccount = useCallback(
    (managedUser: ManagedUserRecord, action: AccountRecoveryAction) => {
      if (!canManage) return;
      const name = getName(managedUser);
      const first = managedUser.firstname?.trim() || name;
      const steps: Record<
        AccountRecoveryAction,
        {
          title: string;
          description: string;
          confirmText: string;
          destructive: boolean;
          doneTitle?: string;
          done?: string;
        }
      > = {
        "reset-password": {
          title: "Reset to a temporary password?",
          description: `${name}'s current password stops working and they're signed out everywhere. You'll see a temporary password once — give it to them yourself, in person or by phone. They'll choose their own when they sign in.`,
          confirmText: "Reset password",
          destructive: true,
        },
        "remove-recovery-email": {
          title: "Remove the recovery email?",
          description: `${managedUser.recoveryEmail || "The email"} will stop receiving password reset codes for ${name}, and they're signed out everywhere so nobody signed in can add it back. They'll add and verify a new email the next time they sign in.`,
          confirmText: "Remove email",
          destructive: true,
          doneTitle: "Recovery email removed",
          done: `${first} is signed out everywhere and will add a new one the next time they sign in.`,
        },
        "sign-out-all": {
          title: "Sign out of all devices?",
          description: `${name} is signed out on every phone and browser, including any someone else is using. Their password stays the same.`,
          confirmText: "Sign out all",
          destructive: true,
          doneTitle: "Signed out everywhere",
          done: `${first} will need to sign in again on every device.`,
        },
        lock: {
          title: "Lock this account?",
          description: `Nobody can sign in to ${name}'s account until you unlock it, and anyone signed in now is signed out. Use this while you confirm who owns it.`,
          confirmText: "Lock account",
          destructive: true,
          doneTitle: "Account locked",
          done: `Unlock it once ${first}'s password and email are safe again.`,
        },
        unlock: {
          title: "Unlock this account?",
          description: `${name} can sign in again. If someone else may know their password or email, reset those first.`,
          confirmText: "Unlock",
          destructive: false,
          doneTitle: "Account unlocked",
          done: `${first} can sign in again.`,
        },
      };
      const step = steps[action];

      showConfirm({
        title: step.title,
        description: step.description,
        confirmText: step.confirmText,
        cancelText: "Cancel",
        destructive: step.destructive,
        onConfirm: async () => {
          setRecoveryBusy({ id: managedUser.id, action });
          try {
            const result = await runAccountRecovery(managedUser.id, action);
            setRecentlyUpdatedId(managedUser.id);
            setExpandedId(managedUser.id);
            setRecoveryHistoryKey((key) => key + 1);
            if (result.temporaryPassword) {
              setIssuedCopied(false);
              setIssuedPassword({
                name,
                studentID: managedUser.studentID || managedUser.id,
                password: result.temporaryPassword,
              });
            } else if (step.doneTitle) {
              showInfo(step.doneTitle, step.done);
            }
          } catch (error) {
            showInfo(
              "Couldn't update the account",
              error instanceof Error ? error.message : "Please try again.",
            );
          } finally {
            setRecoveryBusy(null);
          }
        },
      });
    },
    [canManage],
  );

  const copyIssuedPassword = useCallback(async () => {
    if (!issuedPassword) return;
    try {
      await Clipboard.setStringAsync(issuedPassword.password);
      setIssuedCopied(true);
    } catch {
      // It's still on screen to read out.
    }
  }, [issuedPassword]);

  // Open the name / email / program editor for a user.
  //
  // Student ID is intentionally NOT editable here. It is the Firestore
  // document ID of the `students/{studentID}` record and the value the user
  // types on the login screen, so "changing" it is not a field update — it
  // would require migrating the document to a new ID, re-pointing every
  // reference to it, and keeping the login credential in sync. That belongs
  // in a deliberate re-registration/support flow, not an inline edit next to
  // name and email. See the task notes / docs/registration-and-programs.md.
  const openEditProfile = useCallback(
    (managedUser: ManagedUserRecord) => {
      if (!canManage) return;
      setEditUser(managedUser);
      setEditFirstname(managedUser.firstname || "");
      setEditLastname(managedUser.lastname || "");
      setEditEmail(managedUser.email || "");
      setEditCourse(managedUser.course || "");
      setEditProgramSearch("");
      setEditProgramPickerOpen(false);
      setEditError("");
    },
    [canManage],
  );

  const closeEditProfile = useCallback(() => {
    if (savingEdit) return;
    Keyboard.dismiss();
    setEditUser(null);
    setEditProgramSearch("");
    setEditProgramPickerOpen(false);
    setEditError("");
  }, [savingEdit]);

  const filteredEditPrograms = useMemo(() => {
    const query = editProgramSearch.trim().toLowerCase();
    if (!query) return programs;

    // Split into individual word tokens so order doesn't matter and every word is matched
    const searchTokens = query.split(/\s+/).filter(Boolean);

    return programs.filter((program) => {
      const targetText =
        `${program.name} ${program.code} ${program.description || ""}`.toLowerCase();
      return searchTokens.every((token) => targetText.includes(token));
    });
  }, [editProgramSearch, programs]);

  const selectEditProgram = useCallback((program: Program) => {
    setEditCourse(program.name);
    setEditProgramSearch("");
    setEditProgramPickerOpen(false);
    setEditError("");
  }, []);

  const submitEditProfile = useCallback(() => {
    if (!editUser) return;

    if (programsLoading) {
      setEditError("Programs are still loading — try again in a moment.");
      return;
    }

    const target = editUser;
    const firstname = editFirstname.trim();
    const lastname = editLastname.trim();
    const email = editEmail.trim();
    const courseText = editCourse.trim();

    if (!firstname || !lastname) {
      setEditError("First and last name are both required.");
      return;
    }
    // Email is optional. Only validate format when provided:
    if (email && !EMAIL_PATTERN.test(email)) {
      setEditError("Enter a valid email address.");
      return;
    }

    // Program must resolve to a real entry in the `programs` collection.
    const roleNeedsProgram = PROGRAM_REQUIRED_ROLES.includes(
      parseUserRole(target.role) || "student",
    );
    let normalizedCourse = "";
    if (courseText) {
      const matched = programs.find(
        (program) => program.name.trim().toLowerCase() === courseText.toLowerCase(),
      );
      if (!matched) {
        setEditError(
          "Pick a program from the list — that value isn't a managed program.",
        );
        return;
      }
      normalizedCourse = matched.name;
    } else if (roleNeedsProgram) {
      setEditError("Students and moderators must have a program.");
      return;
    }

    setEditError("");

    showConfirm({
      title: "Save profile changes",
      description: `Update ${getName(target)}'s details?`,
      confirmText: "Save",
      cancelText: "Cancel",
      destructive: false,
      onConfirm: async () => {
        try {
          setSavingEdit(true);
          setBusyId(target.id);
          await updateDoc(doc(db, "students", target.id), {
            firstname,
            lastname,
            // App-wide search keys the lowercased name fields — keep them in
            // step with the edit (same as ProfileScreen / registration).
            firstnameLower: firstname.toLowerCase(),
            lastnameLower: lastname.toLowerCase(),
            // NOTE: this updates the profile/display email on the student
            // document only. It does not change the Firebase Auth email the
            // user signs in with — a full email-change flow is out of scope
            // for this screen.
            email,
            course: normalizedCourse,
            updatedAt: serverTimestamp(),
          });
          setRecentlyUpdatedId(target.id);
          setExpandedId(target.id);
          setEditUser(null);
          setEditProgramPickerOpen(false);
        } catch (error) {
          console.error("Error updating user profile:", error);
          showInfo("Error", "Failed to update the profile. Please try again.");
        } finally {
          setSavingEdit(false);
          setBusyId(null);
        }
      },
    });
  }, [
    editUser,
    editFirstname,
    editLastname,
    editEmail,
    editCourse,
    programs,
    programsLoading,
  ]);

  const renderUserItem = useCallback(
    ({ item }: { item: ManagedUserRecord }) => {
      const isSelf =
        (!!item.userId && item.userId === auth.currentUser?.uid) ||
        item.id === currentStudentDocId;
      return (
        <UserRow
          user={item}
          expanded={expandedId === item.id}
          busy={busyId === item.id}
          isSelf={isSelf}
          isRecentlyUpdated={recentlyUpdatedId === item.id}
          onToggleExpand={toggleExpand}
          onOpenProfile={openProfile}
          onOpenEdit={openEditProfile}
          onChangeYear={changeYearLevel}
          onChangeRole={changeRole}
          onTogglePromotionHold={togglePromotionHold}
          recoveryBusy={recoveryBusy?.id === item.id ? recoveryBusy.action : null}
          historyKey={expandedId === item.id ? recoveryHistoryKey : 0}
          onRecoveryAction={recoverAccount}
        />
      );
    },
    [
      busyId,
      changeRole,
      changeYearLevel,
      currentStudentDocId,
      expandedId,
      openEditProfile,
      openProfile,
      recoverAccount,
      recoveryBusy,
      recoveryHistoryKey,
      togglePromotionHold,
      recentlyUpdatedId,
      toggleExpand,
    ],
  );

  // While sign-in resolves, the screen is drawn as it will be — header,
  // workspace cards, user rows — with placeholders only where data goes, so
  // nothing moves when it arrives.
  if (!loading && !canManage) return null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.topBar}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          activeOpacity={0.8}
        >
          <Ionicons name="arrow-back" size={21} color={theme.onPrimary} />
        </TouchableOpacity>
        <View style={styles.topBarCopy}>
          <Text style={styles.topBarEyebrow}>ADMIN WORKSPACE</Text>
          <Text style={styles.topBarTitle}>Manage Users</Text>
        </View>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => router.push("/AdminRegisterUserScreen")}
          activeOpacity={0.82}
        >
          <Ionicons name="person-add" size={20} color={theme.primary} />
        </TouchableOpacity>
      </View>

      <FlatList
        ref={flatListRef}
        onScrollToIndexFailed={(info) => {
          flatListRef.current?.scrollToOffset({
            offset: Math.max(0, info.highestMeasuredFrameIndex * 80),
            animated: true,
          });
        }}
        style={styles.body}
        contentContainerStyle={styles.content}
        data={filteredUsers}
        keyExtractor={(item) => item.id}
        renderItem={renderUserItem}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={9}
        removeClippedSubviews={Platform.OS === "android"}
        ListHeaderComponent={
          <ManageUsersListHeader
            counts={counts}
            search={search}
            onSearchChange={setSearch}
            filter={filter}
            onFilterChange={setFilter}
            shownCount={filteredUsers.length}
            loadedCount={users.length}
            onRegister={() => router.push("/AdminRegisterUserScreen")}
            onOpenPromotion={() => router.push("/YearPromotionScreen")}
            canPromote={role === "admin"}
            privacyNotice={
              publicEmailCount > 0
                ? { count: publicEmailCount, busy: movingEmails, onPress: handleMoveEmails }
                : null
            }
            loading={loading || usersLoading}
          />
        }
        ListEmptyComponent={
          loading || usersLoading ? (
            <CardListSkeleton
              count={5}
              cardStyle={styles.userCard}
              avatar={{ size: 52, radius: 17 }}
              lines={[
                { width: "52%", height: 14 },
                { width: "80%", height: 11, gap: 8 },
              ]}
              chips={[64, 86]}
            />
          ) : (
            <View style={styles.emptyCard}>
              <View style={styles.emptyIcon}>
                <Ionicons name="search-outline" size={28} color={theme.textSecondary} />
              </View>
              <Text style={styles.emptyTitle}>No users matched</Text>
              <Text style={styles.emptyText}>
                Try a different search term or choose another filter.
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          hasMore && filteredUsers.length > 0 ? (
            <TouchableOpacity
              style={styles.loadMoreButton}
              onPress={loadMore}
              disabled={loadingMore}
              activeOpacity={0.85}
            >
              {loadingMore ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <>
                  <Ionicons
                    name="chevron-down-circle-outline"
                    size={17}
                    color={theme.primary}
                  />
                  <Text style={styles.loadMoreButtonText}>Load more</Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <View style={{ height: 24 }} />
          )
        }
      />

      <Modal
        visible={!!editUser}
        transparent
        animationType="slide"
        onRequestClose={closeEditProfile}
      >
        <KeyboardAvoidingView automaticOffset
          behavior="padding"
          keyboardVerticalOffset={Platform.OS === "ios" ? 10 : 0}
          style={styles.editModalOverlay}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => {
              Keyboard.dismiss();
              closeEditProfile();
            }}
            disabled={savingEdit}
          />
          <View
            style={[
              styles.editModalCard,
              {
                paddingBottom: keyboardVisible
                  ? 14
                  : Math.max(insets.bottom + 16, 24),
              },
            ]}
          >
            <View style={styles.sheetHandleContainer}>
              <View style={styles.sheetHandle} />
            </View>

            <View style={styles.editModalHeader}>
              <View style={styles.editModalIcon}>
                <Ionicons name="person-outline" size={20} color={theme.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.editModalTitle}>Edit profile details</Text>
                <Text style={styles.editModalSubtitle} numberOfLines={1}>
                  {editUser ? getName(editUser) : ""}
                  {editUser?.studentID ? ` • ${editUser.studentID}` : ""}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={closeEditProfile}
                disabled={savingEdit}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={20} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <KeyboardAwareScrollView
              bottomOffset={24}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.editModalScrollContent}
            >
              <View style={styles.editGuidanceCard}>
                <Ionicons name="information-circle-outline" size={18} color={theme.accent} />
                <Text style={styles.editGuidanceText}>
                  Update the user&apos;s public profile details. Their ID and sign-in
                  credentials stay unchanged.
                </Text>
              </View>

              <View style={styles.editSectionHeading}>
                <Ionicons name="person-circle-outline" size={16} color={theme.textSecondary} />
                <Text style={styles.editSectionTitle}>Personal information</Text>
              </View>
              <View style={styles.editFieldRow}>
                <View style={styles.editFieldHalf}>
                  <Text style={styles.editLabel}>First name</Text>
                  <TextInput
                    value={editFirstname}
                    onChangeText={(value) => {
                      setEditFirstname(value);
                      setEditError("");
                    }}
                    placeholder="Juan"
                    placeholderTextColor={theme.textMuted}
                    style={styles.editInput}
                    autoCapitalize="words"
                    textContentType="givenName"
                  />
                </View>
                <View style={styles.editFieldHalf}>
                  <Text style={styles.editLabel}>Last name</Text>
                  <TextInput
                    value={editLastname}
                    onChangeText={(value) => {
                      setEditLastname(value);
                      setEditError("");
                    }}
                    placeholder="Dela Cruz"
                    placeholderTextColor={theme.textMuted}
                    style={styles.editInput}
                    autoCapitalize="words"
                    textContentType="familyName"
                  />
                </View>
              </View>

              <Text style={styles.editLabel}>
                Email <Text style={styles.editLabelOptional}>(optional)</Text>
              </Text>
              <TextInput
                value={editEmail}
                onChangeText={(value) => {
                  setEditEmail(value);
                  setEditError("");
                }}
                placeholder="Optional email (e.g. name@student.csap)"
                placeholderTextColor={theme.textMuted}
                style={styles.editInput}
                autoCapitalize="none"
                keyboardType="email-address"
                returnKeyType="done"
                onSubmitEditing={Keyboard.dismiss}
              />
              <Text style={styles.editHelp}>
                Optional contact email shown in the app. It does not change
                the account&apos;s login credential.
              </Text>

              <View style={styles.editSectionHeading}>
                <Ionicons name="school-outline" size={16} color={theme.textSecondary} />
                <Text style={styles.editSectionTitle}>Academic information</Text>
              </View>
              <Text style={[styles.editLabel, styles.editFirstLabel]}>Program</Text>
              <TouchableOpacity
                style={styles.editSearchShell}
                onPress={() => setEditProgramPickerOpen((open) => !open)}
                activeOpacity={0.82}
                accessibilityRole="button"
                accessibilityLabel="Choose program"
              >
                <Ionicons name="school-outline" size={18} color={theme.textSecondary} />
                <Text
                  style={
                    editCourse
                      ? styles.editCourseValueText
                      : styles.editCoursePlaceholderText
                  }
                  numberOfLines={1}
                >
                  {programsLoading
                    ? "Loading programs…"
                    : editCourse || "Select a program"}
                </Text>
                {!!editCourse && (
                  <TouchableOpacity
                    onPress={() => {
                      setEditCourse("");
                      setEditError("");
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close-circle" size={17} color={theme.textMuted} />
                  </TouchableOpacity>
                )}
                <Ionicons
                  name={editProgramPickerOpen ? "chevron-up" : "chevron-down"}
                  size={19}
                  color={theme.textSecondary}
                />
              </TouchableOpacity>

              {editProgramPickerOpen && (
                <View style={styles.editDropdown}>
                  <View style={styles.dropdownSearchShell}>
                    <Ionicons name="search-outline" size={15} color={theme.textSecondary} />
                    <TextInput
                      value={editProgramSearch}
                      onChangeText={setEditProgramSearch}
                      placeholder="Search by program name or code…"
                      placeholderTextColor={theme.textMuted}
                      style={styles.dropdownSearchInput}
                      autoCapitalize="none"
                    />
                    {!!editProgramSearch && (
                      <TouchableOpacity
                        onPress={() => setEditProgramSearch("")}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="close-circle" size={15} color={theme.textMuted} />
                      </TouchableOpacity>
                    )}
                  </View>

                  {filteredEditPrograms.length === 0 ? (
                    <Text style={styles.editDropdownEmpty}>
                      No matching programs.
                    </Text>
                  ) : (
                    <ScrollView
                      style={styles.editDropdownScroll}
                      nestedScrollEnabled={true}
                      keyboardShouldPersistTaps="handled"
                      showsVerticalScrollIndicator={true}
                    >
                      {filteredEditPrograms.map((program) => {
                        const isSelected = program.name === editCourse;
                        return (
                          <TouchableOpacity
                            key={program.id}
                            style={[
                              styles.editDropdownItem,
                              isSelected && styles.editDropdownItemSelected,
                            ]}
                            onPress={() => selectEditProgram(program)}
                            activeOpacity={0.82}
                          >
                            <View
                              style={[
                                styles.editProgramBadge,
                                isSelected && styles.editProgramBadgeSelected,
                              ]}
                            >
                              <Text
                                style={[
                                  styles.editProgramBadgeText,
                                  isSelected && styles.editProgramBadgeTextSelected,
                                ]}
                              >
                                {program.code.slice(0, 5)}
                              </Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text
                                style={[
                                  styles.editDropdownName,
                                  isSelected && styles.editDropdownNameSelected,
                                ]}
                              >
                                {program.name}
                              </Text>
                              <Text style={styles.editDropdownCode}>{program.code}</Text>
                            </View>
                            {isSelected && (
                              <Ionicons
                                name="checkmark-circle"
                                size={19}
                                color={theme.accent}
                              />
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  )}
                </View>
              )}

              {!!editError && <Text style={styles.editErrorText}>{editError}</Text>}

              <View style={styles.editButtonRow}>
                <TouchableOpacity
                  style={[styles.editButton, styles.editCancelButton]}
                  onPress={closeEditProfile}
                  disabled={savingEdit}
                  activeOpacity={0.8}
                >
                  <Text style={styles.editCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.editButton, styles.editSaveButton, savingEdit && { opacity: 0.6 }]}
                  onPress={submitEditProfile}
                  disabled={savingEdit}
                  activeOpacity={0.85}
                >
                  {savingEdit ? (
                    <ActivityIndicator size="small" color={theme.onPrimary} />
                  ) : (
                    <Text style={styles.editSaveText}>Review &amp; save</Text>
                  )}
                </TouchableOpacity>
              </View>
            </KeyboardAwareScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* A temporary password from Account recovery. Shown this once: the
          Worker keeps only a hash, so closing it means resetting again. */}
      <Modal
        visible={!!issuedPassword}
        transparent
        animationType="fade"
        onRequestClose={() => setIssuedPassword(null)}
      >
        <View style={styles.issuedOverlay}>
          <View style={styles.issuedCard}>
            <View style={styles.issuedIcon}>
              <Ionicons name="key" size={24} color={theme.primary} />
            </View>
            <Text style={styles.issuedTitle}>Temporary password</Text>
            <Text style={styles.issuedSubtitle} numberOfLines={1}>
              {issuedPassword ? `${issuedPassword.name} • ${issuedPassword.studentID}` : ""}
            </Text>
            <View style={styles.issuedPasswordBox}>
              <Text selectable style={styles.issuedPassword}>
                {issuedPassword?.password ?? ""}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.issuedCopy}
              onPress={copyIssuedPassword}
              activeOpacity={0.84}
              accessibilityRole="button"
              accessibilityLabel="Copy the temporary password"
            >
              <Ionicons
                name={issuedCopied ? "checkmark" : "copy-outline"}
                size={15}
                color={theme.accent}
              />
              <Text style={styles.issuedCopyText}>{issuedCopied ? "Copied" : "Copy"}</Text>
            </TouchableOpacity>
            <Text style={styles.issuedNote}>
              This is the only time it&apos;s shown. Give it to them in person or
              by phone — capital letters matter. They&apos;ll choose their own
              password as soon as they sign in.
            </Text>
            <TouchableOpacity
              style={styles.issuedDone}
              onPress={() => setIssuedPassword(null)}
              activeOpacity={0.86}
              accessibilityRole="button"
            >
              <Text style={styles.issuedDoneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

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

function MetricCard({
  label,
  value,
  icon,
  color,
  sublabel,
  loading = false,
}: {
  label: string;
  value: number;
  /** Shimmer where the number goes, so the card keeps its size. */
  loading?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  /** Secondary count shown under the label, e.g. "+ 87 alumni". */
  sublabel?: string;
}) {
  const { styles } = useStyles();
  return (
    <View style={styles.metricCard}>
      <View style={[styles.metricIcon, { backgroundColor: color + "12" }]}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      {loading ? (
        <SkeletonBlock width={38} height={22} style={{ marginVertical: 3 }} />
      ) : (
        <Text style={styles.metricValue}>{value}</Text>
      )}
      <Text style={styles.metricLabel}>{label}</Text>
      {!!sublabel && <Text style={styles.metricSublabel}>{sublabel}</Text>}
    </View>
  );
}

// Fix 2: the scroll chrome (hero / metrics / register / search / filters /
// section heading) as the FlatList's ListHeaderComponent. Kept as a stable
// component and passed as an element so the search TextInput isn't remounted
// (and doesn't lose focus) every time the list data changes.
type ManageUsersListHeaderProps = {
  counts: Record<ManagedUserFilter, number>;
  search: string;
  onSearchChange: (value: string) => void;
  filter: ManagedUserFilter;
  onFilterChange: (value: ManagedUserFilter) => void;
  shownCount: number;
  loadedCount: number;
  onRegister: () => void;
  onOpenPromotion: () => void;
  canPromote: boolean;
  /** Profiles whose personal email is still public, and the fix for it. */
  privacyNotice?: { count: number; busy: boolean; onPress: () => void } | null;
  /** Counts still loading: the numbers shimmer in place. */
  loading?: boolean;
};

function ManageUsersListHeader({
  counts,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  shownCount,
  loadedCount,
  onRegister,
  onOpenPromotion,
  canPromote,
  privacyNotice,
  loading = false,
}: ManageUsersListHeaderProps) {
  const { styles, theme } = useStyles();
  return (
    <View>
      <View style={styles.heroCard}>
        <View style={styles.heroIcon}>
          <Ionicons name="people-circle-outline" size={30} color={theme.accent} />
        </View>
        <View style={styles.heroCopy}>
          <Text style={styles.heroTitle}>Campus user control</Text>
          <Text style={styles.heroText}>
            Search accounts, check availability, open profiles, and manage
            academic year or role access from one focused workspace.
          </Text>
        </View>
      </View>

      <View style={styles.metricGrid}>
        <MetricCard label="Total" value={counts.all} loading={loading} icon="people" color={theme.primary} />
        <MetricCard label="Online" value={counts.online} loading={loading} icon="ellipse" color={theme.success} />
        <MetricCard
          label="Staff"
          value={counts.admin + counts.teacher + counts.moderator}
          loading={loading}
          icon="shield-checkmark"
          color={theme.accent}
        />
        <MetricCard
          label="Students"
          value={counts.student}
          loading={loading}
          icon="school"
          color="#6e4aa3"
          sublabel={counts.alumni ? `+ ${counts.alumni} alumni` : undefined}
        />
      </View>

      <TouchableOpacity
        style={styles.registerCard}
        onPress={onRegister}
        activeOpacity={0.84}
      >
        <View style={styles.registerIcon}>
          <Ionicons name="person-add-outline" size={19} color={theme.accent} />
        </View>
        <View style={styles.registerCopy}>
          <Text style={styles.registerTitle}>Register users</Text>
          <Text style={styles.registerText}>
            Add one account or import your campus CSV.
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={19} color={theme.textSecondary} />
      </TouchableOpacity>

      {canPromote && (
        <TouchableOpacity
          style={styles.registerCard}
          onPress={onOpenPromotion}
          activeOpacity={0.84}
        >
          <View style={styles.registerIcon}>
            <Ionicons name="school-outline" size={19} color={theme.accent} />
          </View>
          <View style={styles.registerCopy}>
            <Text style={styles.registerTitle}>Year level promotion</Text>
            <Text style={styles.registerText}>
              Move every student up a year on a date you choose.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={19} color={theme.textSecondary} />
        </TouchableOpacity>
      )}

      {privacyNotice && (
        <TouchableOpacity
          style={styles.registerCard}
          onPress={privacyNotice.onPress}
          disabled={privacyNotice.busy}
          activeOpacity={0.84}
          accessibilityRole="button"
        >
          <View style={styles.registerIcon}>
            <Ionicons name="shield-half-outline" size={19} color={theme.accent} />
          </View>
          <View style={styles.registerCopy}>
            <Text style={styles.registerTitle}>Make personal emails private</Text>
            <Text style={styles.registerText}>
              {privacyNotice.count} {privacyNotice.count === 1 ? "profile still shows" : "profiles still show"}{" "}
              a personal email to anyone signed in.
            </Text>
          </View>
          {privacyNotice.busy ? (
            <ActivityIndicator color={theme.accent} />
          ) : (
            <Ionicons name="chevron-forward" size={19} color={theme.textSecondary} />
          )}
        </TouchableOpacity>
      )}

      <View style={styles.controlsCard}>
        <View style={styles.searchShell}>
          <Ionicons name="search" size={18} color={theme.textSecondary} />
          <TextInput
            value={search}
            onChangeText={onSearchChange}
            placeholder="Search name, ID, email, course, or role"
            placeholderTextColor={theme.textMuted}
            style={styles.searchInput}
            autoCapitalize="none"
          />
          {!!search.trim() && (
            <TouchableOpacity
              onPress={() => onSearchChange("")}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="close-circle" size={19} color={theme.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {FILTERS.map((item) => {
            const selected = filter === item.value;
            const count = counts[item.value];
            return (
              <TouchableOpacity
                key={item.value}
                style={[styles.filterChip, selected && styles.filterChipSelected]}
                onPress={() => onFilterChange(item.value)}
                activeOpacity={0.82}
              >
                <Ionicons
                  name={item.icon}
                  size={14}
                  color={selected ? theme.onPrimary : theme.textSecondary}
                />
                <Text
                  style={[styles.filterText, selected && styles.filterTextSelected]}
                >
                  {item.label}
                </Text>
                <View
                  style={[
                    styles.filterCount,
                    selected && styles.filterCountSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.filterCountText,
                      selected && styles.filterCountTextSelected,
                    ]}
                  >
                    {count}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.sectionHeading}>
        <View>
          <Text style={styles.sectionTitle}>Campus accounts</Text>
          <Text style={styles.sectionSubtitle}>
            Showing {shownCount} of {loadedCount}
          </Text>
        </View>
        <Ionicons name="options-outline" size={20} color={theme.textSecondary} />
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: c.primary },
  topBar: {
    minHeight: 66,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: c.primary,
    borderBottomWidth: 1,
    borderBottomColor: c.primary,
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
    color: c.accent,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.1,
  },
  topBarTitle: {
    color: c.background,
    fontSize: 24,
    fontWeight: "900",
    marginTop: 2,
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.accent,
  },
  body: { flex: 1, backgroundColor: c.surfaceSunken },
  content: { padding: 16, paddingBottom: 80 },
  heroCard: {
    flexDirection: "row",
    gap: 16,
    padding: 16,
    borderRadius: 22,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.borderStrong,
    marginBottom: 16,
  },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  heroCopy: { flex: 1 },
  heroTitle: { color: c.textPrimary, fontSize: 18, fontWeight: "900" },
  heroText: {
    color: c.textMuted,
    fontSize: 12.5,
    lineHeight: 19,
    marginTop: 5,
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 16,
  },
  metricCard: {
    width: "48%",
    flexGrow: 1,
    backgroundColor: c.background,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
  },
  metricIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  metricValue: { color: c.textPrimary, fontSize: 22, fontWeight: "900" },
  metricSublabel: {
    color: "#6e4aa3",
    fontSize: 10.5,
    fontWeight: "800",
    marginTop: 2,
  },
  metricLabel: {
    color: c.textSecondary,
    fontSize: 11.5,
    fontWeight: "700",
    marginTop: 2,
  },
  registerCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: c.background,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 16,
    marginBottom: 16,
  },
  registerIcon: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: c.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  registerCopy: { flex: 1 },
  registerTitle: { color: c.primary, fontSize: 14, fontWeight: "900" },
  registerText: { color: c.textSecondary, fontSize: 11.5, marginTop: 3 },
  controlsCard: {
    backgroundColor: c.background,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: c.border,
    padding: 13,
    marginBottom: 20,
  },
  searchShell: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: c.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.borderStrong,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    color: c.textPrimary,
    fontSize: 13.5,
    paddingVertical: 10,
  },
  filterRow: { gap: 8, paddingTop: 12, paddingRight: 4 },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.surfaceRaised,
    paddingLeft: 11,
    paddingRight: 8,
    paddingVertical: 8,
  },
  filterChipSelected: { backgroundColor: c.primary, borderColor: c.primary },
  filterText: { color: c.textSecondary, fontSize: 11.5, fontWeight: "800" },
  filterTextSelected: { color: c.background },
  filterCount: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.border,
  },
  filterCountSelected: { backgroundColor: "rgba(255,255,255,0.18)" },
  filterCountText: { color: c.textSecondary, fontSize: 10.5, fontWeight: "900" },
  filterCountTextSelected: { color: c.background },
  sectionHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  sectionTitle: { color: c.textPrimary, fontSize: 17, fontWeight: "900" },
  sectionSubtitle: { color: c.textMuted, fontSize: 11.5, marginTop: 3 },
  userCard: {
    backgroundColor: c.background,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
    marginBottom: 11,
  },
  skeletonContent: { flex: 1, backgroundColor: c.surfaceSunken, padding: 16 },
  skeletonCard: {
    backgroundColor: c.background,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
    marginBottom: 11,
  },
  userCardExpanded: {
    borderColor: c.accent,
    shadowColor: c.primary,
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  userHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  identityRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 17,
    backgroundColor: c.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImage: { width: "100%", height: "100%", borderRadius: 17 },
  avatarText: { color: c.background, fontSize: 17, fontWeight: "900" },
  presenceDot: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: c.background,
  },
  identityCopy: { flex: 1 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  userName: { flexShrink: 1, color: c.textPrimary, fontSize: 14.5, fontWeight: "900" },
  youBadge: {
    backgroundColor: c.accentSoft,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  youBadgeText: { color: c.accent, fontSize: 9.5, fontWeight: "900" },
  userMeta: { color: c.textSecondary, fontSize: 11.5, lineHeight: 17, marginTop: 3 },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 },
  roleBadge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  roleBadgeText: { fontSize: 10.5, fontWeight: "900" },
  statusText: { color: c.textSecondary, fontSize: 10.5, fontWeight: "700" },
  openProfileButton: {
    marginTop: 12,
    flexDirection: "row",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: 7,
    backgroundColor: c.accentSoft,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: c.accent,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  openProfileText: { color: c.accent, fontSize: 11.5, fontWeight: "800" },
  expandedPanel: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  controlTitle: { color: c.primary, fontSize: 13, fontWeight: "900" },
  controlHelp: { color: c.textMuted, fontSize: 11.5, lineHeight: 17, marginTop: 3, marginBottom: 10 },
  optionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  optionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceRaised,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  optionButtonSelected: { backgroundColor: c.primary, borderColor: c.primary },
  optionText: { color: c.primary, fontSize: 11.5, fontWeight: "800" },
  optionTextSelected: { color: c.background },
  divider: { height: 1, backgroundColor: c.border, marginVertical: 15 },

  holdRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    padding: 12,
    marginTop: 12,
  },
  holdRowActive: { backgroundColor: c.dangerSoft, borderColor: c.danger },
  holdCopy: { flex: 1 },
  holdTitle: { color: c.primary, fontSize: 12.5, fontWeight: "900" },
  holdTitleActive: { color: c.danger },
  holdHelp: { color: c.textMuted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  holdSwitch: {
    width: 40,
    height: 23,
    borderRadius: 999,
    backgroundColor: c.borderStrong,
    padding: 3,
    justifyContent: "center",
  },
  holdSwitchOn: { backgroundColor: c.primary },
  holdKnob: {
    width: 17,
    height: 17,
    borderRadius: 999,
    backgroundColor: c.background,
  },
  holdKnobOn: { alignSelf: "flex-end" },
  busyRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  busyText: { color: c.textSecondary, fontSize: 11.5, fontWeight: "800" },
  hintText: { color: c.textMuted, fontSize: 10.75, lineHeight: 16, marginTop: 12 },

  // Account recovery (expanded card) and the one-time password sheet.
  lockedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: c.dangerSoft,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  lockedBadgeText: { color: c.danger, fontSize: 10.5, fontWeight: "900" },
  recoveryStatusRow: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 10 },
  recoveryStatusText: { flex: 1, color: c.textSecondary, fontSize: 11.5, fontWeight: "700" },
  lockedNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: c.dangerSoft,
    borderWidth: 1,
    borderColor: c.danger,
    borderRadius: 12,
    paddingHorizontal: 11,
    paddingVertical: 9,
    marginBottom: 10,
  },
  lockedNoticeText: { flex: 1, color: c.danger, fontSize: 11.5, lineHeight: 16, fontWeight: "800" },
  recoveryActions: { gap: 8 },
  recoveryAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 13,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  recoveryActionDanger: { borderColor: c.danger },
  recoveryActionUnavailable: { opacity: 0.5 },
  recoveryIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.background,
  },
  recoveryIconDanger: { backgroundColor: c.dangerSoft },
  recoveryCopy: { flex: 1 },
  recoveryLabel: { color: c.primary, fontSize: 12.5, fontWeight: "900" },
  recoveryLabelDanger: { color: c.danger },
  recoveryHelp: { color: c.textMuted, fontSize: 11, lineHeight: 15, marginTop: 2 },
  recoveryHistory: {
    marginTop: 12,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: c.border,
    gap: 6,
  },
  recoveryHistoryTitle: {
    color: c.textSecondary,
    fontSize: 10.5,
    fontWeight: "900",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  recoveryHistoryRow: { flexDirection: "row", alignItems: "flex-start", gap: 7 },
  recoveryHistoryDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.borderStrong,
    marginTop: 5,
  },
  recoveryHistoryText: { flex: 1, color: c.textSecondary, fontSize: 11.5, lineHeight: 16 },
  recoveryHistoryStrong: { color: c.textPrimary, fontWeight: "800" },
  recoveryHistoryEmpty: { color: c.textMuted, fontSize: 11.5 },
  issuedOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.58)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  issuedCard: {
    width: "100%",
    maxWidth: 380,
    alignItems: "center",
    backgroundColor: c.background,
    borderRadius: 22,
    padding: 24,
  },
  issuedIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.accentSoft,
  },
  issuedTitle: { color: c.primary, fontSize: 16, fontWeight: "900", marginTop: 12 },
  issuedSubtitle: { color: c.textSecondary, fontSize: 12, fontWeight: "700", marginTop: 3 },
  issuedPasswordBox: {
    alignSelf: "stretch",
    alignItems: "center",
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.surfaceSunken,
  },
  issuedPassword: {
    color: c.textPrimary,
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: 1.5,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
  issuedCopy: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: c.accent,
    backgroundColor: c.accentSoft,
  },
  issuedCopyText: { color: c.accent, fontSize: 12.5, fontWeight: "800" },
  issuedNote: {
    color: c.textMuted,
    fontSize: 11.5,
    lineHeight: 19,
    textAlign: "center",
    marginTop: 16,
  },
  issuedDone: {
    alignSelf: "stretch",
    alignItems: "center",
    marginTop: 16,
    paddingVertical: 16,
    borderRadius: 13,
    backgroundColor: c.primary,
  },
  issuedDoneText: { color: c.onPrimary, fontSize: 14, fontWeight: "900" },
  loadMoreButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 14,
    paddingVertical: 16,
    marginTop: 12,
  },
  loadMoreButtonText: { color: c.primary, fontSize: 13, fontWeight: "800" },
  emptyCard: {
    alignItems: "center",
    padding: 24,
    borderRadius: 19,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
  },
  emptyIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSunken,
  },
  emptyTitle: { color: c.primary, fontSize: 15, fontWeight: "900", marginTop: 12 },
  emptyText: { color: c.textMuted, fontSize: 11.5, lineHeight: 17, textAlign: "center", marginTop: 5 },
  loadingState: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { color: c.onPrimary, fontSize: 12.5, fontWeight: "700", marginTop: 12 },

  // Profile-details editor (expanded-panel trigger + bottom-sheet form).
  editDetailsButton: {
    flexDirection: "row",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: 7,
    backgroundColor: c.accentSoft,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: c.accent,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  editDetailsText: { color: c.accent, fontSize: 11.5, fontWeight: "800" },
  userCardRecentlyUpdated: {
    borderColor: c.accent,
    borderWidth: 1.5,
    backgroundColor: c.surfaceRaised,
  },
  updatedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: c.accentSoft,
    borderColor: c.accent,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 6,
  },
  updatedBadgeText: {
    color: c.accent,
    fontSize: 10,
    fontWeight: "900",
  },
  editModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.58)",
    justifyContent: "flex-end",
  },
  editModalKeyboardShell: {
    width: "100%",
    justifyContent: "flex-end",
  },
  editModalCard: {
    backgroundColor: c.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    paddingHorizontal: 20,
    paddingTop: 10,
    maxHeight: "90%",
    width: "100%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 20,
  },
  sheetHandleContainer: {
    alignItems: "center",
    paddingVertical: 8,
    marginBottom: 4,
  },
  sheetHandle: {
    width: 42,
    height: 4.5,
    borderRadius: 999,
    backgroundColor: c.borderStrong,
  },
  modalCloseButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
  },
  editModalScrollContent: {
    paddingBottom: 16,
  },
  editModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  editModalIcon: {
    width: 42,
    height: 42,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.accentSoft,
  },
  editModalTitle: { color: c.textPrimary, fontSize: 19, fontWeight: "900" },
  editModalSubtitle: { color: c.textMuted, fontSize: 12, marginTop: 3 },
  editGuidanceCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: c.accent,
    backgroundColor: c.accentSoft,
  },
  editGuidanceText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 11.5,
    lineHeight: 19,
    fontWeight: "600",
  },
  editSectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 20,
    marginBottom: 2,
  },
  editSectionTitle: {
    color: c.textSecondary,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  editFieldRow: { gap: 2 },
  editFieldHalf: { width: "100%" },
  editLabel: {
    color: c.textSecondary,
    fontSize: 12.5,
    fontWeight: "800",
    marginBottom: 6,
    marginTop: 12,
  },
  editFirstLabel: { marginTop: 8 },
  editLabelOptional: {
    color: c.textMuted,
    fontSize: 11.5,
    fontWeight: "600",
  },
  editInput: {
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: c.textPrimary,
    fontSize: 14,
  },
  editHelp: { color: c.textMuted, fontSize: 10.75, lineHeight: 16, marginTop: 6 },
  editSearchShell: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: c.surfaceRaised,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  editCourseValueText: {
    flex: 1,
    color: c.textPrimary,
    fontSize: 13.5,
    fontWeight: "700",
  },
  editCoursePlaceholderText: {
    flex: 1,
    color: c.textMuted,
    fontSize: 13.5,
    fontWeight: "500",
  },
  dropdownSearchShell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: c.surfaceRaised,
    borderBottomWidth: 1,
    borderBottomColor: c.borderStrong,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  dropdownSearchInput: {
    flex: 1,
    color: c.textPrimary,
    fontSize: 13,
    paddingVertical: 2,
  },
  editDropdown: {
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.surfaceRaised,
    borderRadius: 12,
    overflow: "hidden",
    marginTop: 8,
  },
  editDropdownScroll: {
    maxHeight: 240,
  },
  editDropdownItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  editDropdownItemSelected: {
    backgroundColor: c.surfaceRaised,
  },
  editDropdownEmpty: { padding: 14, color: c.textSecondary, fontSize: 12 },
  editDropdownName: { fontWeight: "800", color: c.textPrimary, fontSize: 13 },
  editDropdownNameSelected: { color: c.primary, fontWeight: "900" },
  editDropdownCode: { marginTop: 2, color: c.textMuted, fontSize: 11.5 },
  editProgramBadge: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: c.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
  },
  editProgramBadgeSelected: {
    backgroundColor: c.accentSoft,
  },
  editProgramBadgeText: { color: c.textSecondary, fontWeight: "900", fontSize: 10.5 },
  editProgramBadgeTextSelected: { color: c.primary },
  editErrorText: {
    color: c.danger,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 16,
  },
  editButtonRow: { flexDirection: "row", gap: 10, marginTop: 18 },
  editButton: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  editCancelButton: {
    backgroundColor: c.surfaceSunken,
    borderWidth: 1,
    borderColor: c.border,
  },
  editCancelText: { color: c.primary, fontSize: 14, fontWeight: "700" },
  editSaveButton: { backgroundColor: c.primary },
  editSaveText: { color: c.background, fontSize: 14, fontWeight: "800" },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};

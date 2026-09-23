import type { User } from "firebase/auth";
import { collection, doc, getDoc, getDocs, limit, onSnapshot, query, where } from "firebase/firestore";
import { auth, db } from "../Firebase_configure";
import { getCachedMyProfile, saveCachedMyProfile } from "./offlineStorage";

export type UserRole = "student" | "moderator" | "teacher" | "admin";

export interface UserPermissions {
  canPost: boolean;
  canComment: boolean;
  canLike: boolean;
  canReport: boolean;
  canDeleteOwnPost: boolean;
  canEditOwnPost: boolean;
  canVotePoll: boolean;
  canCreatePoll: boolean;
  canDeleteAnyPost?: boolean;
  canDeleteAnyComment?: boolean;
  canBanUser?: boolean;
  canViewReports?: boolean;
  canManageReports?: boolean;
  canManageUsers?: boolean;
  canManageRoles?: boolean;
  canViewAnalytics?: boolean;
}

export interface UserData {
  studentID: string;
  firstname: string;
  lastname: string;
  email: string;
  course?: string;
  yearlvl?: string;
  role: UserRole;
  permissions: UserPermissions;
  profileImage?: string | null;
  bio?: string;
  isOnline?: boolean;
  userId: string;
}

type StudentRecord = {
  userId?: string;
  studentID?: string;
  firstname?: string;
  lastname?: string;
  email?: string;
  course?: string;
  yearlvl?: string;
  role?: unknown;
  permissions?: UserPermissions;
  profileImage?: string | null;
  bio?: string;
  isOnline?: boolean;
};

const userDataCache = new Map<string, UserData | null>();
const pendingUserDataRequests = new Map<string, Promise<UserData | null>>();

export function parseUserRole(value: unknown): UserRole | undefined {
  const roleMap: Record<number, UserRole> = {
    1: "student",
    2: "teacher",
    3: "moderator",
    4: "admin",
  };

  if (typeof value === "number") {
    return roleMap[value];
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (
      normalized === "student" ||
      normalized === "teacher" ||
      normalized === "moderator" ||
      normalized === "admin"
    ) {
      return normalized;
    }
  }

  return undefined;
}

export function normalizeUserRole(value: unknown): UserRole {
  const normalizedRole = parseUserRole(value);
  if (normalizedRole) {
    return normalizedRole;
  }

  return "student";
}

export function getStudentDocIdFromAuthUser(user: User | null | undefined): string | null {
  if (!user) return null;
  const emailPrefix = user.email?.split("@")[0]?.trim();
  return emailPrefix || user.uid || null;
}

export async function getUserDataByAuthUser(user: User | null | undefined): Promise<UserData | null> {
  if (!user) return null;

  // Fast-path: check offline storage cache first so profile is available immediately on cold start
  try {
    const cached = await getCachedMyProfile<StudentRecord>(user.uid);
    if (cached && (cached.profileImage || cached.firstname)) {
      const roleValue = normalizeUserRole(cached.role);
      const normalizedCached: UserData = {
        studentID: cached.studentID || user.uid,
        firstname: cached.firstname || "",
        lastname: cached.lastname || "",
        email: cached.email || user.email || "",
        course: cached.course,
        yearlvl: cached.yearlvl,
        role: roleValue,
        permissions: cached.permissions || getDefaultPermissions(),
        profileImage: cached.profileImage || (user as any).photoURL || null,
        bio: cached.bio,
        isOnline: cached.isOnline,
        userId: user.uid,
      };
      cacheUserDataForKeys(normalizedCached, [
        user.uid,
        normalizedCached.studentID,
        user.email?.split("@")[0]?.trim(),
      ]);
    }
  } catch {}

  const emailPrefix = getStudentDocIdFromAuthUser(user);
  const docIds = Array.from(
    new Set([emailPrefix, user.uid].filter(Boolean) as string[]),
  );

  for (const docId of docIds) {
    const data = await getUserData(docId);
    if (data) {
      cacheUserDataForKeys(data, [user.uid]);
      return {
        ...data,
        userId: user.uid,
      };
    }
  }

  return userDataCache.get(user.uid) ?? null;
}

export async function resolveUserRoleForAuthUser(user: User | null | undefined): Promise<UserRole> {
  if (!user) return "student";

  // The profile is the source of truth: Manage Users changes the role there.
  // The token's role claim is stamped once at registration and never
  // updated, so a demoted teacher kept "Pin to Top of Feed" and other staff
  // controls while this trusted the claim first. It now only answers for an
  // account that has no profile.
  const profile = await getUserDataByAuthUser(user);
  if (profile) return profile.role || "student";

  try {
    const idTokenResult = await user.getIdTokenResult(true);
    return normalizeUserRole(idTokenResult.claims.role);
  } catch (error) {
    console.error("Error fetching role from auth token:", error);
    return "student";
  }
}

const getDefaultPermissions = (): UserPermissions => {
  return {
    canPost: true,
    canComment: true,
    canLike: true,
    canReport: true,
    canDeleteOwnPost: true,
    canEditOwnPost: true,
    canVotePoll: true,
    canCreatePoll: true,
  };
};

export function getPermissionsForRole(role: UserRole): UserPermissions {
  const base = getDefaultPermissions();

  if (role === "moderator") {
    return {
      ...base,
      canDeleteAnyPost: true,
      canDeleteAnyComment: true,
      canViewReports: true,
      canManageReports: true,
      canViewAnalytics: true,
    };
  }

  if (role === "teacher") {
    return {
      ...base,
      canDeleteAnyPost: true,
      canDeleteAnyComment: true,
      canViewReports: true,
      canManageReports: true,
      canViewAnalytics: true,
    };
  }

  if (role === "admin") {
    return {
      ...base,
      canDeleteAnyPost: true,
      canDeleteAnyComment: true,
      canBanUser: true,
      canViewReports: true,
      canManageReports: true,
      canManageUsers: true,
      canManageRoles: true,
      canViewAnalytics: true,
    };
  }

  return base;
}

const scoreCandidate = (candidate: StudentRecord & { id: string }, requestedId: string) => {
  let score = 0;
  if (candidate.profileImage) score += 8;
  if (candidate.firstname) score += 2;
  if (candidate.lastname) score += 2;
  if (candidate.course) score += 1;
  if (candidate.yearlvl) score += 1;
  if (candidate.studentID && candidate.studentID === candidate.id) score += 4;
  if (candidate.userId && candidate.userId === requestedId) score += 3;
  if ((candidate as any).uid && (candidate as any).uid === requestedId) score += 3;
  return score;
};

const cacheUserDataForKeys = (
  userData: UserData | null,
  keys: (string | null | undefined)[],
) => {
  if (!userData) return;

  const normalizedKeys = Array.from(
    new Set(keys.map((key) => key?.trim()).filter(Boolean) as string[]),
  );

  normalizedKeys.forEach((key) => {
    userDataCache.set(key, userData);
  });
};

export type UserDataListener = (userId: string, data: Partial<UserData>) => void;
const userDataListeners = new Set<UserDataListener>();

export function subscribeToUserDataUpdates(listener: UserDataListener): () => void {
  userDataListeners.add(listener);
  return () => {
    userDataListeners.delete(listener);
  };
}

/**
 * Watches somebody else's profile document.
 *
 * Conversations store a copy of each participant's name, role and picture in
 * `participantDetails`, written once when the conversation is created. It was
 * never refreshed, so changing your profile picture updated it everywhere in
 * the app except the chats you were already in — the person you were talking
 * to kept seeing the picture you had on the day you first messaged.
 *
 * The snapshot is still the starting value, because it renders instantly and
 * works offline. This corrects it a moment later.
 *
 * `documentId` is the students document id — the same thing stored as
 * `studentID`, which is not always the auth uid.
 */
export function subscribeToStudentProfile(
  documentId: string | null | undefined,
  onProfile: (data: UserData | null) => void,
): () => void {
  if (!documentId) {
    onProfile(null);
    return () => {};
  }

  return onSnapshot(
    doc(db, "students", documentId),
    (snapshot) => {
      if (!snapshot.exists()) {
        onProfile(null);
        return;
      }
      // Built field by field, the same way subscribeToCurrentUserProfile does,
      // rather than spreading the raw document — a students record carries
      // fields UserData does not describe.
      const record = snapshot.data() as StudentRecord;
      const userData: UserData = {
        studentID: record.studentID || documentId,
        firstname: record.firstname || "",
        lastname: record.lastname || "",
        email: record.email || "",
        course: record.course,
        yearlvl: record.yearlvl,
        role: normalizeUserRole(record.role),
        permissions: record.permissions || getDefaultPermissions(),
        profileImage: record.profileImage || null,
        bio: record.bio,
        isOnline: record.isOnline,
        userId: record.userId || documentId,
      };

      // Feed the shared cache too, so other screens reading this person by id
      // get the corrected picture without their own listener.
      updateUserDataCache([documentId], userData);
      onProfile(userData);
    },
    (error) => {
      // A profile that cannot be read is not worth breaking a chat over; the
      // stored snapshot stays on screen.
      console.warn("Profile subscription failed:", error);
    },
  );
}

/**
 * Watches the signed-in user's own profile document and keeps every copy of it
 * honest.
 *
 * An admin changing someone's role writes to that student document, and
 * nothing told the affected device about it. The in-memory cache never
 * expired, and the saved profile re-seeded that cache on the next cold start,
 * so a promoted or demoted account could hold its old role indefinitely —
 * Firestore rules granting or refusing access the interface disagreed with.
 *
 * Refreshing the memory cache, the saved copy, and the reported role together
 * means a role change lands within a moment, with no restart and no reinstall.
 */
export function subscribeToCurrentUserProfile(
  user: User | null | undefined,
  onProfile: (data: UserData | null) => void,
): () => void {
  const docId = getStudentDocIdFromAuthUser(user);
  if (!user || !docId) {
    onProfile(null);
    return () => {};
  }

  return onSnapshot(
    doc(db, "students", docId),
    (snapshot) => {
      if (!snapshot.exists()) {
        onProfile(null);
        return;
      }

      const record = snapshot.data() as StudentRecord;
      const userData: UserData = {
        studentID: record.studentID || docId,
        firstname: record.firstname || "",
        lastname: record.lastname || "",
        email: record.email || user.email || "",
        course: record.course,
        yearlvl: record.yearlvl,
        role: normalizeUserRole(record.role),
        permissions: record.permissions || getDefaultPermissions(),
        profileImage: record.profileImage || (user as any).photoURL || null,
        bio: record.bio,
        isOnline: record.isOnline,
        userId: user.uid,
      };

      // Overwrite every key this profile is cached under, so no screen can go
      // on reading the previous role from a different key.
      cacheUserDataForKeys(userData, [
        user.uid,
        docId,
        userData.studentID,
        user.email?.split("@")[0]?.trim(),
      ]);
      // The saved copy seeds the cache on the next cold start, so it has to
      // move too — otherwise the old role returns after a restart.
      void saveCachedMyProfile(user.uid, record);
      // Merges nothing new, but notifies subscribeToUserDataUpdates listeners
      // so screens holding their own copy refresh as well.
      updateUserDataCache([user.uid, docId], userData);

      onProfile(userData);
    },
    (error) => {
      console.warn("[rbac] Own-profile subscription failed:", error);
    },
  );
}

export function invalidateUserDataCache(userId?: string | null): void {
  if (userId) {
    userDataCache.delete(userId);
  } else {
    userDataCache.clear();
  }
}

export function updateUserDataCache(
  keys: (string | null | undefined)[],
  partial: Partial<UserData>,
): void {
  const normalizedKeys = Array.from(
    new Set(keys.map((key) => key?.trim()).filter(Boolean) as string[]),
  );

  normalizedKeys.forEach((key) => {
    const existing = userDataCache.get(key);
    if (existing) {
      userDataCache.set(key, { ...existing, ...partial });
    }
  });

  normalizedKeys.forEach((key) => {
    userDataListeners.forEach((listener) => {
      try {
        listener(key, partial);
      } catch (err) {
        console.warn("[rbac] Error notifying user data listener:", err);
      }
    });
  });
}

export function peekUserData(userId: string | null | undefined): UserData | null | undefined {
  if (!userId) return undefined;
  return userDataCache.get(userId);
}

// Firestore caps an "in" filter at 30 values, so lookups are chunked.
const USER_LOOKUP_CHUNK = 30;

/**
 * Loads any of these people who are not in the cache yet, in as few reads as
 * possible, and tells every listener about them.
 *
 * Screens that show other people store a copy of their name and picture at
 * write time — a notification keeps the avatar its actor had when it was
 * created, and never learns about a new one. The cache is what the live-
 * rendering screens read through, but only three things ever filled it: your
 * own profile, a profile you opened, and the chat partner in an open DM.
 * Anybody else stayed unknown, so their stored copy was all a screen had.
 *
 * `ids` are auth uids. The students collection is keyed by studentID with the
 * uid in a `userId` field, so this matches on that field rather than the
 * document id — looking them up by document id silently returns nothing.
 *
 * Safe to call on every render pass: ids already cached cost nothing, and a
 * screen with twenty distinct actors costs one query.
 */
export async function ensureUserData(
  ids: (string | null | undefined)[],
): Promise<void> {
  const missing = Array.from(
    new Set(
      ids
        .map((id) => id?.trim())
        .filter((id): id is string => !!id && !userDataCache.has(id)),
    ),
  );
  if (missing.length === 0) return;

  for (let index = 0; index < missing.length; index += USER_LOOKUP_CHUNK) {
    const chunk = missing.slice(index, index + USER_LOOKUP_CHUNK);
    try {
      const snapshot = await getDocs(
        query(collection(db, "students"), where("userId", "in", chunk)),
      );

      const found = new Set<string>();
      snapshot.forEach((docSnap) => {
        const record = docSnap.data() as StudentRecord;
        const uid = String(record.userId || "");
        if (!uid) return;
        found.add(uid);

        const userData: UserData = {
          studentID: record.studentID || docSnap.id,
          firstname: record.firstname || "",
          lastname: record.lastname || "",
          email: record.email || "",
          course: record.course,
          yearlvl: record.yearlvl,
          role: normalizeUserRole(record.role),
          permissions: record.permissions || getDefaultPermissions(),
          profileImage: record.profileImage || null,
          bio: record.bio,
          isOnline: record.isOnline,
          userId: uid,
        };

        // Cached under both keys, because callers hold whichever they have.
        cacheUserDataForKeys(userData, [uid, docSnap.id, record.studentID]);
        updateUserDataCache([uid, docSnap.id], userData);
      });

      // Remember the misses too. Without this an id with no student document
      // — a deleted account, the AI assistant — is looked up again on every
      // single render.
      chunk.forEach((id) => {
        if (!found.has(id)) userDataCache.set(id, null);
      });
    } catch (error) {
      // A failed lookup just means the stored copy keeps showing.
      console.warn("[rbac] ensureUserData lookup failed:", error);
      return;
    }
  }
}

export async function getUserData(userId: string): Promise<UserData | null> {
  if (!userId) return null;

  if (userDataCache.has(userId)) {
    return userDataCache.get(userId) ?? null;
  }

  const pendingRequest = pendingUserDataRequests.get(userId);
  if (pendingRequest) {
    return pendingRequest;
  }

  const request = (async () => {
  try {
    const candidates: (StudentRecord & { id: string })[] = [];
    const seen = new Set<string>();

    const addCandidate = (docId: string, data: StudentRecord) => {
      if (!docId || seen.has(docId)) return;
      seen.add(docId);
      candidates.push({ id: docId, ...data });
    };

    const loadCandidateDoc = async (docId?: string | null) => {
      if (!docId || seen.has(docId)) return;
      const studentDoc = await getDoc(doc(db, "students", docId));
      if (studentDoc.exists()) {
        addCandidate(studentDoc.id, studentDoc.data() as StudentRecord);
      }
    };

    await loadCandidateDoc(userId);

    // If userId matches current user, also load emailPrefix and offline cache immediately
    if (auth.currentUser?.uid === userId) {
      const authEmailPrefix = auth.currentUser.email?.split("@")[0]?.trim();
      if (authEmailPrefix) await loadCandidateDoc(authEmailPrefix);
      try {
        const cached = await getCachedMyProfile<StudentRecord>(userId);
        if (cached && (cached.profileImage || cached.firstname)) {
          addCandidate(cached.studentID || userId, {
            ...cached,
            userId,
            profileImage: cached.profileImage || auth.currentUser.photoURL || null,
          });
        }
      } catch {}
    }

    const lookupQueries = [
      query(collection(db, "students"), where("userId", "==", userId), limit(5)),
      query(collection(db, "students"), where("uid", "==", userId), limit(5)),
      query(collection(db, "students"), where("studentID", "==", userId), limit(5)),
    ];

    for (const lookupQuery of lookupQueries) {
      const snapshot = await getDocs(lookupQuery);
      snapshot.docs.forEach((item) => {
        addCandidate(item.id, item.data() as StudentRecord);
      });
    }

    for (const candidate of [...candidates]) {
      if (candidate.studentID && candidate.studentID !== candidate.id) {
        await loadCandidateDoc(candidate.studentID);
      }

      const emailPrefix = candidate.email?.split("@")[0]?.trim();
      if (emailPrefix && emailPrefix !== candidate.id) {
        await loadCandidateDoc(emailPrefix);
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((first, second) => scoreCandidate(second, userId) - scoreCandidate(first, userId));
    const bestCandidate = candidates[0];
    const roleValue = normalizeUserRole(bestCandidate.role);
    const normalizedUserData = {
      studentID: bestCandidate.studentID || bestCandidate.id || userId,
      firstname: bestCandidate.firstname || "",
      lastname: bestCandidate.lastname || "",
      email: bestCandidate.email || (auth.currentUser?.uid === userId ? auth.currentUser.email || "" : ""),
      course: bestCandidate.course,
      yearlvl: bestCandidate.yearlvl,
      role: roleValue,
      permissions: bestCandidate.permissions || getDefaultPermissions(),
      profileImage: bestCandidate.profileImage || (auth.currentUser?.uid === userId ? auth.currentUser.photoURL : null) || null,
      bio: bestCandidate.bio,
      isOnline: bestCandidate.isOnline,
      userId: bestCandidate.userId || (bestCandidate as any).uid || userId,
    };

    cacheUserDataForKeys(normalizedUserData, [
      userId,
      bestCandidate.id,
      bestCandidate.studentID,
      bestCandidate.userId,
      (bestCandidate as any).uid,
      bestCandidate.email?.split("@")[0]?.trim(),
      ...candidates.flatMap((candidate) => [
        candidate.id,
        candidate.studentID,
        candidate.userId,
        (candidate as any).uid,
        candidate.email?.split("@")[0]?.trim(),
      ]),
    ]);

    return normalizedUserData;
  } catch (error) {
    console.error("Error fetching user data:", error);
    return null;
  } finally {
    pendingUserDataRequests.delete(userId);
  }
  })();

  pendingUserDataRequests.set(userId, request);
  return request;
}

export function hasPermission(
  permissions: UserPermissions | undefined,
  permission: keyof UserPermissions,
): boolean {
  if (!permissions) return false;
  return permissions[permission] === true;
}

export function hasRole(
  userRole: UserRole | undefined,
  ...roles: UserRole[]
): boolean {
  if (!userRole) return false;
  return roles.includes(userRole);
}

export function isStaff(role: UserRole | undefined): boolean {
  return hasRole(role, "moderator", "teacher", "admin");
}

export function canReportContent(
  viewerRole: unknown,
  authorRole: unknown,
  isAnonymous = false,
): boolean {
  return (
    parseUserRole(viewerRole) === "student" &&
    (isAnonymous || parseUserRole(authorRole) === "student")
  );
}

export function isAdmin(role: UserRole | undefined): boolean {
  return hasRole(role, "admin");
}

export function canManageAiMemory(role: UserRole | undefined): boolean {
  return hasRole(role, "moderator", "teacher", "admin");
}

export function canManageUsers(role: UserRole | undefined): boolean {
  return hasRole(role, "admin");
}

export function canDeletePost(
  userRole: UserRole | undefined,
  permissions: UserPermissions | undefined,
  postUserId: string,
  currentUserId: string,
): boolean {
  if (
    postUserId === currentUserId &&
    hasPermission(permissions, "canDeleteOwnPost")
  ) {
    return true;
  }
  if (hasPermission(permissions, "canDeleteAnyPost")) {
    return true;
  }
  return false;
}

export function canEditPost(
  permissions: UserPermissions | undefined,
  postUserId: string,
  currentUserId: string,
): boolean {
  return (
    postUserId === currentUserId && hasPermission(permissions, "canEditOwnPost")
  );
}

export function getRoleDisplayName(role: UserRole): string {
  const displayNames = {
    student: "Student",
    moderator: "Moderator",
    teacher: "Teacher",
    admin: "Administrator",
  };
  return displayNames[role] || "User";
}

export function getRoleColor(role: UserRole): string {
  const colors = {
    student: "#4f9cff",
    moderator: "#a86fff",
    teacher: "#ff9f43",
    admin: "#ff3b7f",
  };
  return colors[role] || "#666";
}

export function canViewAnonymousIdentity(
  viewerRole: UserRole | undefined,
  _postAuthorRole: UserRole | undefined,
  isAnonymous: boolean,
): boolean {
  if (!isAnonymous) return true;
  return isStaff(viewerRole);
}

type DeleteContentAccessArgs = {
  viewerRole: UserRole | undefined;
  viewerUserId: string | null | undefined;
  authorUserId: string | null | undefined;
  authorRole: UserRole | undefined;
};

export function canDeleteContent({
  viewerRole,
  viewerUserId,
  authorUserId,
  authorRole,
}: DeleteContentAccessArgs): boolean {
  if (!viewerUserId || !authorUserId) return false;
  if (viewerUserId === authorUserId) return true;
  if (viewerRole === "admin") return true;

  if (
    (viewerRole === "teacher" || viewerRole === "moderator") &&
    authorRole === "student"
  ) {
    return true;
  }

  return false;
}

export function getRoleHierarchyLevel(role: UserRole | undefined): number {
  if (!role) return 0;
  const hierarchy: Record<UserRole, number> = {
    student: 1,
    moderator: 2,
    teacher: 2,
    admin: 3,
  };
  return hierarchy[role] ?? 0;
}

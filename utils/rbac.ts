import type { User } from "firebase/auth";
import { collection, doc, getDoc, getDocs, limit, query, where } from "firebase/firestore";
import { db } from "../Firebase_configure";

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

  const emailPrefix = getStudentDocIdFromAuthUser(user);
  const docIds = Array.from(
    new Set([emailPrefix, user.uid].filter(Boolean) as string[]),
  );

  for (const docId of docIds) {
    const data = await getUserData(docId);
    if (data) {
      return {
        ...data,
        userId: user.uid,
      };
    }
  }

  return null;
}

export async function resolveUserRoleForAuthUser(user: User | null | undefined): Promise<UserRole> {
  if (!user) return "student";

  try {
    const idTokenResult = await user.getIdTokenResult(true);
    const tokenRole = normalizeUserRole(idTokenResult.claims.role);
    if (tokenRole !== "student" || idTokenResult.claims.role !== undefined) {
      return tokenRole;
    }
  } catch (error) {
    console.error("Error fetching role from auth token:", error);
  }

  const profile = await getUserDataByAuthUser(user);
  return profile?.role || "student";
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

export function peekUserData(userId: string | null | undefined): UserData | null | undefined {
  if (!userId) return undefined;
  return userDataCache.get(userId);
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

    const lookupQueries = [
      query(collection(db, "students"), where("userId", "==", userId), limit(5)),
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
      email: bestCandidate.email || "",
      course: bestCandidate.course,
      yearlvl: bestCandidate.yearlvl,
      role: roleValue,
      permissions: bestCandidate.permissions || getDefaultPermissions(),
      profileImage: bestCandidate.profileImage,
      bio: bestCandidate.bio,
      isOnline: bestCandidate.isOnline,
      userId: bestCandidate.userId || userId,
    };

    cacheUserDataForKeys(normalizedUserData, [
      userId,
      bestCandidate.id,
      bestCandidate.studentID,
      bestCandidate.userId,
      bestCandidate.email?.split("@")[0]?.trim(),
      ...candidates.flatMap((candidate) => [
        candidate.id,
        candidate.studentID,
        candidate.userId,
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
  postAuthorRole: UserRole | undefined,
  isAnonymous: boolean,
): boolean {
  if (!isAnonymous) return true;
  if (!viewerRole) return false;

  if (viewerRole === "admin") return true;

  if (
    (viewerRole === "teacher" || viewerRole === "moderator") &&
    postAuthorRole === "student"
  ) {
    return true;
  }

  return false;
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

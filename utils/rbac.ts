// utils/rbac.ts
import { doc, getDoc } from "firebase/firestore";
import { db } from "../Firebase_configure";

// Define all possible user roles
export type UserRole = "student" | "moderator" | "teacher" | "admin";

// Define permission structure for each user
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

// Define the structure for a user record
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

/**
 * Fetches user data from Firestore and ensures the role is normalized to a string type
 */
export async function getUserData(userId: string): Promise<UserData | null> {
  try {
    if (!userId) return null;

    const userDoc = await getDoc(doc(db, "students", userId));
    if (!userDoc.exists()) return null;

    const data = userDoc.data();

    // Map numeric roles to string roles
    const roleMap: Record<number, UserRole> = {
      1: "student",
      2: "teacher",
      3: "moderator",
      4: "admin",
    };

    // Normalize role type
    const roleValue: UserRole =
      typeof data.role === "number"
        ? roleMap[data.role] || "student"
        : (data.role as UserRole);

    return {
      studentID: data.studentID || userId,
      firstname: data.firstname || "",
      lastname: data.lastname || "",
      email: data.email || "",
      course: data.course,
      yearlvl: data.yearlvl,
      role: roleValue, // ✅ always string
      permissions: data.permissions || getDefaultPermissions(),
      profileImage: data.profileImage,
      bio: data.bio,
      isOnline: data.isOnline,
      userId,
    };
  } catch (error) {
    console.error("Error fetching user data:", error);
    return null;
  }
}

/**
 * Default permissions for new users (students)
 */
function getDefaultPermissions(): UserPermissions {
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
}

/**
 * Checks if user has a specific permission
 */
export function hasPermission(
  permissions: UserPermissions | undefined,
  permission: keyof UserPermissions
): boolean {
  if (!permissions) return false;
  return permissions[permission] === true;
}

/**
 * Checks if a user has one of several roles
 */
export function hasRole(
  userRole: UserRole | undefined,
  ...roles: UserRole[]
): boolean {
  if (!userRole) return false;
  return roles.includes(userRole);
}

/**
 * Utility: checks if user is moderator/teacher/admin
 */
export function isStaff(role: UserRole | undefined): boolean {
  return hasRole(role, "moderator", "teacher", "admin");
}

/**
 * Utility: checks if user is admin
 */
export function isAdmin(role: UserRole | undefined): boolean {
  return hasRole(role, "admin");
}

/**
 * Determines if a user can delete a post
 */
export function canDeletePost(
  userRole: UserRole | undefined,
  permissions: UserPermissions | undefined,
  postUserId: string,
  currentUserId: string
): boolean {
  // Can delete own post
  if (postUserId === currentUserId && hasPermission(permissions, "canDeleteOwnPost")) {
    return true;
  }
  // Can delete any post if they have the permission
  if (hasPermission(permissions, "canDeleteAnyPost")) {
    return true;
  }
  return false;
}

/**
 * Determines if a user can edit a post
 */
export function canEditPost(
  permissions: UserPermissions | undefined,
  postUserId: string,
  currentUserId: string
): boolean {
  // Can only edit own post
  return postUserId === currentUserId && hasPermission(permissions, "canEditOwnPost");
}

/**
 * Returns a readable version of the role name
 */
export function getRoleDisplayName(role: UserRole): string {
  const displayNames = {
    student: "Student",
    moderator: "Moderator",
    teacher: "Teacher",
    admin: "Administrator",
  };
  return displayNames[role] || "User";
}

/**
 * Returns a color associated with a role
 */
export function getRoleColor(role: UserRole): string {
  const colors = {
    student: "#4f9cff",
    moderator: "#a86fff",
    teacher: "#ff9f43",
    admin: "#ff3b7f",
  };
  return colors[role] || "#666";
}

/**
 * Determines if a user can view the identity of an anonymous post
 */
export function canViewAnonymousIdentity(
  viewerRole: UserRole | undefined,
  postAuthorRole: UserRole | undefined,
  isAnonymous: boolean
): boolean {
  if (!isAnonymous) return true; // everyone can see if not anonymous
  if (!viewerRole) return false;

  // Admins can see all anonymous posts
  if (viewerRole === "admin") return true;

  // Teachers and Moderators can see anonymous student posts
  if ((viewerRole === "teacher" || viewerRole === "moderator") && postAuthorRole === "student") {
    return true;
  }

  // Students cannot see any anonymous identities
  return false;
}

/**
 * Assigns a numeric level to each role (for comparison or hierarchy logic)
 */
export function getRoleHierarchyLevel(role: UserRole | undefined): number {
  const hierarchy = {
    student: 1,
    moderator: 2,
    teacher: 2,
    admin: 3,
  };
  return hierarchy[role || "student"] || 0;
}
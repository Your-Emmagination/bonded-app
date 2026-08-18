const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const {
  getAuth,
} = require("firebase-admin/auth");
const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

initializeApp();

const auth = getAuth();
const db = getFirestore();

function getUserConfig(userType) {
  const type = String(userType || "student")
    .trim()
    .toLowerCase();

  const configs = {
    student: {
      domain: "@student.csap",
      role: "student",
    },

    moderator: {
      domain: "@student.csap",
      role: "moderator",
    },

    teacher: {
      domain: "@teacher.csap",
      role: "teacher",
    },

    admin: {
      domain: "@admin.csap",
      role: "admin",
    },
  };

  return configs[type] || configs.student;
}

function getRolePermissions(role) {
  const permissions = {
    student: {
      canPost: true,
      canComment: true,
      canLike: true,
      canReport: true,
      canDeleteOwnPost: true,
      canEditOwnPost: true,
      canVotePoll: true,
      canCreatePoll: true,
    },

    moderator: {
      canPost: true,
      canComment: true,
      canLike: true,
      canReport: true,
      canDeleteOwnPost: true,
      canEditOwnPost: true,
      canVotePoll: true,
      canCreatePoll: true,
      canDeleteAnyPost: true,
      canDeleteAnyComment: true,
      canBanUser: false,
      canViewReports: true,
      canManageReports: true,
    },

    teacher: {
      canPost: true,
      canComment: true,
      canLike: true,
      canReport: true,
      canDeleteOwnPost: true,
      canEditOwnPost: true,
      canVotePoll: true,
      canCreatePoll: true,
      canDeleteAnyPost: true,
      canDeleteAnyComment: true,
      canBanUser: false,
      canViewReports: true,
      canManageReports: true,
    },

    admin: {
      canPost: true,
      canComment: true,
      canLike: true,
      canReport: true,
      canDeleteOwnPost: true,
      canEditOwnPost: true,
      canVotePoll: true,
      canCreatePoll: true,
      canDeleteAnyPost: true,
      canDeleteAnyComment: true,
      canBanUser: true,
      canViewReports: true,
      canManageReports: true,
      canManageUsers: true,
      canManageRoles: true,
      canViewAnalytics: true,
    },
  };

  return permissions[role] || permissions.student;
}

function clean(value) {
  return String(value || "").trim();
}

function generatePassword(lastname) {
  return `${clean(lastname)}12345`;
}

function buildEmail(studentID, userType) {
  const config = getUserConfig(userType);

  return `${clean(studentID)}${config.domain}`.toLowerCase();
}

function validateUser(data) {
  const studentID = clean(data.studentID);
  const firstname = clean(data.firstname);
  const lastname = clean(data.lastname);
  const course = clean(data.course);
  const yearlvl = clean(data.yearlvl);
  const userType = clean(data.userType) || "student";

  if (!studentID) {
    throw new HttpsError(
      "invalid-argument",
      "Student/Staff ID is required."
    );
  }

  if (!firstname) {
    throw new HttpsError(
      "invalid-argument",
      "First name is required."
    );
  }

  if (!lastname) {
    throw new HttpsError(
      "invalid-argument",
      "Last name is required."
    );
  }

  return {
    studentID,
    firstname,
    lastname,
    course: course || "N/A",
    yearlvl: yearlvl || "N/A",
    userType,
  };
}

async function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "You must be signed in."
    );
  }

  const role = request.auth.token?.role;

  if (role !== "admin") {
    throw new HttpsError(
      "permission-denied",
      "Only administrators can register users."
    );
  }
}

exports.registerUser = onCall(
  async (request) => {
    await requireAdmin(request);

    const user = validateUser(request.data || {});

    const config = getUserConfig(user.userType);

    const email = buildEmail(
      user.studentID,
      user.userType
    );

    const password = generatePassword(
      user.lastname
    );

    let authUser;

    try {
      authUser = await auth.createUser({
        uid: user.studentID,
        email,
        password,
        displayName:
          `${user.firstname} ${user.lastname}`.trim(),
      });
    } catch (error) {
      if (error.code === "auth/uid-already-exists") {
        throw new HttpsError(
          "already-exists",
          `User ${user.studentID} already exists.`
        );
      }

      if (error.code === "auth/email-already-exists") {
        throw new HttpsError(
          "already-exists",
          `Email ${email} is already registered.`
        );
      }

      console.error(
        "Firebase Auth registration error:",
        error
      );

      throw new HttpsError(
        "internal",
        "Unable to create the authentication account."
      );
    }

    try {
      await auth.setCustomUserClaims(
        authUser.uid,
        {
          role: config.role,
        }
      );

      await db
        .collection("students")
        .doc(user.studentID)
        .set(
          {
            studentID: user.studentID,
            firstname: user.firstname,
            lastname: user.lastname,
            course: user.course,
            yearlvl: user.yearlvl,

            role: config.role,

            permissions:
              getRolePermissions(config.role),

            userId: authUser.uid,

            email,

            bio: "",
            isOnline: false,

            mustChangePassword: true,

            createdAt:
              FieldValue.serverTimestamp(),

            updatedAt:
              FieldValue.serverTimestamp(),
          },
          {
            merge: true,
          }
        );
    } catch (error) {
      console.error(
        "Registration database error:",
        error
      );

      // Roll back Auth account if Firestore fails.
      try {
        await auth.deleteUser(authUser.uid);
      } catch (deleteError) {
        console.error(
          "Rollback failed:",
          deleteError
        );
      }

      throw new HttpsError(
        "internal",
        "User creation could not be completed."
      );
    }

    return {
      success: true,

      uid: authUser.uid,

      studentID: user.studentID,

      email,

      temporaryPassword: password,

      role: config.role,
    };
  }
);
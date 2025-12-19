//importStudentsandAuth.js
const admin = require("firebase-admin");
const fs = require("fs");
const csv = require("csv-parser");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const csvFilePath = "./firestore-student-import/students.csv";
const students = [];

// Helper function to determine email domain and role based on user type
function getUserConfig(userType) {
  const type = userType?.toLowerCase().trim() || "student";
  
  const configs = {
    student: { domain: "@student.csap", role: "student" },
    moderator: { domain: "@student.csap", role: "moderator" }, // Uses student domain but has moderator role
    teacher: { domain: "@teacher.csap", role: "teacher" },
    admin: { domain: "@admin.csap", role: "admin" },
  };

  return configs[type] || configs.student;
}

fs.createReadStream(csvFilePath)
  .pipe(csv())
  .on("data", (row) => {
    students.push(row);
  })
  .on("end", async () => {
    console.log(`📚 Loaded ${students.length} users from CSV...`);

    for (const student of students) {
      const studentID = student.studentID?.trim();
      const firstname = student.firstname?.trim();
      const lastname = student.lastname?.trim();
      const course = student.course?.trim();
      const yearlvl = student.yearlvl?.trim();
      const userType = student.userType?.trim() || "student"; // Default to student if not specified

      if (!studentID || !lastname) {
        console.log(`⚠️ Skipped record with missing studentID or lastname.`);
        continue;
      }

      const defaultPassword = `${lastname}12345`;
      const userConfig = getUserConfig(userType);
      const fakeEmail = `${studentID}${userConfig.domain}`.toLowerCase();

      try {
        // 🔹 Create Auth user with custom claims for role
            await admin.auth().createUser({
            uid: studentID,
            email: fakeEmail,
            password: defaultPassword,
            displayName: `${firstname} ${lastname}`,
          });


        // 🔹 Set custom claims for RBAC
        await admin.auth().setCustomUserClaims(studentID, {
          role: userConfig.role,
        });

        console.log(`✅ Created Auth user: ${studentID} (${userConfig.role})`);
      } catch (error) {
        if (error.code === "auth/uid-already-exists" || error.code === "auth/email-already-exists") {
          console.log(`⚠️ Updating existing user: ${studentID}`);
          
          // Update custom claims for existing user
          try {
            await admin.auth().setCustomUserClaims(studentID, {
              role: userConfig.role,
            });
            console.log(`✅ Updated role for: ${studentID} to ${userConfig.role}`);
          } catch (claimError) {
            console.error(`❌ Error updating claims for ${studentID}:`, claimError.message);
          }
        } else {
          console.error(`❌ Error adding ${studentID}:`, error.message);
          continue;
        }
      }

      try {
        // 🔹 Create/update Firestore document
        await db.collection("students").doc(studentID).set(
          {
            // Basic Info
            studentID,
            firstname: firstname || "N/A",
            lastname: lastname || "N/A",
            course: course || "N/A",
            yearlvl: yearlvl || "N/A",

            // Role & Permissions
            role: userConfig.role,
            permissions: getRolePermissions(userConfig.role),

            // Auth reference
            userId: studentID,

            // Profile
            profileImage: null,
            bio: "",
            isOnline: false,

            // Metadata
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        console.log(`✅ Synced Firestore for: ${studentID} (${userConfig.role})`);
      } catch (firestoreError) {
        console.error(`❌ Firestore error for ${studentID}:`, firestoreError.message);
      }
    }

    console.log("🎉 Import completed successfully!");
    console.log("\n📊 Summary:");
    console.log("- Students use: @student.csap");
    console.log("- Moderators use: @student.csap (but have moderator role)");
    console.log("- Teachers use: @teachers.csap");
    console.log("- Admins use: @admin.csap");
    process.exit(0);
  })
  .on("error", (error) => {
    console.error("❌ CSV parsing error:", error.message);
    process.exit(1);
  });

// Define permissions for each role
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
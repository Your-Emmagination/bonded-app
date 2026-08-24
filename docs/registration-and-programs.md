# BondED registration + program management

## What changed

- Admin registration uses the existing Firebase Authentication project.
- Firebase Auth UID remains the student/staff ID.
- Email is generated automatically:
  - student -> `studentID@student.csap`
  - moderator -> `studentID@student.csap`
  - teacher -> `studentID@teacher.csap`
  - admin -> `studentID@admin.csap`
- Temporary password is `lastname12345`.
- Firestore profile is created at `students/{studentID}`.
- `Manage Programs` is an admin-only CRUD screen backed by the `programs` collection.
- Register User uses the managed program catalog as a searchable dropdown and uses a fixed year-level dropdown.
- CSV import continues to use exactly: `studentID,firstname,lastname,course,yearlvl,userType`.

## Firebase setup

Registration and Manage Programs use the Firebase Web SDK directly from the Expo app. No Firebase Admin service-account key is required for these features.

If another BondED feature still uses the local signaling server, you may keep `EXPO_PUBLIC_BONDED_API_URL` pointed at your PC LAN IP while testing with Expo Go. Registration itself does not call that API.

Restart Expo after changing `.env`:
`npx expo start -c`

## Program setup

Open `Dashboard -> Manage Programs` as an administrator. Add each program with a unique code and name. Those programs immediately appear in `Dashboard -> Manage Users -> Register Users`.

Students and moderators must select a managed program and a valid year level before registration. Teachers and admins may leave program/year level blank.

## Security

The mobile app never receives Firebase Admin credentials. The app keeps the administrator signed in while creating the new account through a secondary Firebase Auth app instance. New users store their role in `students/{studentID}`; Firestore rules accept either the existing custom claim or the protected profile role.

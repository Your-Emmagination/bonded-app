# Profile setup rollout

The app now protects its main routes until the signed-in account has a verified personal
email, an uploaded profile image, acceptance of community rules version
`2026-09-12`, and `mustChangePassword: false`. Back navigation and notification
links cannot open a main screen before the gate passes. Profile reads that fail
show Retry and Sign out; cached or pending writes do not unlock Home.

New accounts created by the in-app registration form and the existing Firebase
registration function are marked as using a temporary password. For older
accounts without a flag, login verifies the entered password through the Worker
once. The Worker checks the current school-issued password format against the
authenticated credential and writes the password state. An existing personal
password is retained. A restored, unclassified session asks for its current
password once on setup. Passwords are never stored in Firestore or local storage.

Setup uses the same six-digit email verification flow as Edit Profile. It first
saves the photo, contact email, and accepted rules, then sends a code. Verify &
Continue confirms that code through the existing Worker. Only the Worker sets
`recoveryEmail` and `recoveryEmailVerified`; the gate requires the profile email
to match that verified inbox. An existing verification of a different email does
not qualify. Incorrect/expired codes keep setup locked, and resending has a
60-second cooldown. Changing the draft email clears its pending code.

The Firebase Auth school email remains unchanged, so ID login still works.
The verified personal email can also receive password-reset codes. Previously
completed but unverified accounts return to setup with their saved photo and
details prefilled. The same verified email does not require another code.
Change Password is also accessible from Settings.

The September 13 email-verification update reuses the deployed recovery-email
endpoints and protected verification fields. If the initial setup Worker/rules
deployment below is already complete, only the app needs updating for this step.

## Deploy before releasing this app update

Run from the project root using the existing authorized Firebase/Cloudflare accounts:

```powershell
npx.cmd wrangler deploy --config cloudflare/ai-worker/wrangler.toml
firebase deploy --only firestore:rules --project bonded-app-c8483
```

Deploy the Worker first, then the rules, then distribute the app update. The new
`account-password-check` mode uses the existing `FIREBASE_WEB_API_KEY` and Firebase
service-account secrets already used by the password-reset Worker. No new secrets
or Cloud Functions deployment are required for this change.

Until that Worker is deployed, temporary/legacy accounts remain on setup with a
retryable password-check error. These source changes alone do not deploy it.

The student rules now protect roles, identity, verified recovery information,
and password state from self-service changes. Older app versions that add `uid`
while editing a profile may need this app update to save profile edits.

## Validation

```powershell
npx.cmd tsc --noEmit
npx.cmd tsx scripts/test-profile-setup.ts
# With a localhost Firestore emulator running the updated firestore.rules:
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'
npx.cmd tsx scripts/test-profile-setup-emulator.ts
```

On a phone, check new and existing accounts, photo permission denial/cancellation,
failed upload and retry, invalid email, incorrect/expired codes, resend cooldown,
changing an email after requesting a code, unchecked rules, password mismatch, sign
out/reopen while incomplete, completed-profile login, deep links during setup,
and Settings → Change Password. Verify the keyboard and safe areas in Expo Go
and the next APK build. No production account was modified by the local tests.

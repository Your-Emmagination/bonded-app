# BondED Node.js Notification Backend

This replaces the push-notification part of the Cloudflare Worker. It does not replace the AI/moderation Worker.

## Local setup

1. Open PowerShell in this `backend` folder.
2. Install dependencies:

   npm install

3. For local testing, either set `GOOGLE_APPLICATION_CREDENTIALS` to your Firebase service-account JSON file, or set:
   - FIREBASE_PROJECT_ID
   - FIREBASE_CLIENT_EMAIL
   - FIREBASE_PRIVATE_KEY

Do NOT put the service-account JSON inside the Expo app.

Example PowerShell:

$env:GOOGLE_APPLICATION_CREDENTIALS="C:\Users\lexma\Downloads\bonded-app-c8483-firebase-adminsdk-fbsvc-964f5fcc98.json"

4. Start:

npm start

5. Test:

Invoke-RestMethod http://localhost:5000/health

Expected: ok=true.

## API

POST /notifications/push

Header:
Authorization: Bearer <Firebase ID token>

Body:
{"notificationId":"<Firestore notification document id>"}

The backend verifies the Firebase ID token, checks that the caller is the notification actor, reads the recipient's Expo push tokens from Firestore, reads the sound preference, and sends through Expo Push API.

## Hosting

This server is designed for any Node.js host that provides:
- Node 20
- HTTPS
- environment variables/secrets

For production, set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY as hosting-provider secrets.

Do not commit the service-account JSON, private key, or .env file to GitHub.

# 📱 Expo Mobile App

This project is built with [Expo](https://expo.dev) using `create-expo-app`.

---

# Prerequisites

Make sure you have the following installed:

- Node.js (LTS version recommended)
- npm
- Git
- Expo CLI (optional, `npx expo` works without installing globally)

Verify installation:

```bash
node -v
npm -v
git --version
```

---

# Installation

Clone the repository:

```bash
git clone <YOUR_GIT_REPOSITORY_URL>
```

Navigate into the project:

```bash
cd <PROJECT_NAME>
```

Install dependencies:

```bash
npm install
```

---

# Running the App

## Start Expo (Recommended)

Use tunnel mode so physical devices on different networks can connect easily.

```bash
npx expo start --tunnel
```

If tunnel mode is unnecessary (same Wi-Fi):

```bash
npx expo start
```

Or use LAN:

```bash
npx expo start --lan
```

---

## Open the App

After Expo starts, you can:

- Press **a** → Android Emulator
- Press **i** → iOS Simulator (Mac only)
- Press **w** → Web Browser
- Scan the QR code using **Expo Go**

---

# Building an APK

## Option 1: Using EAS Build (Recommended)

Install EAS CLI:

```bash
npm install -g eas-cli
```

Login:

```bash
eas login
```

Configure the project (first time only):

```bash
eas build:configure
```

Build an Android APK:

```bash
eas build --platform android --profile preview
```

Or, if your `eas.json` is configured for APK output:

```bash
eas build -p android
```

Once the build finishes, Expo provides a download link for the APK.

---

## Local Android Build (Optional)

Generate the Android project:

```bash
npx expo prebuild
```

Then build using Android Studio or Gradle.

---

# Git Workflow

## Check Current Status

```bash
git status
```

---

## Pull Latest Changes

Before starting work:

```bash
git pull origin main
```

Replace `main` with your branch if needed.

---

## Create a New Branch

```bash
git checkout -b feature/my-feature
```

---

## Stage Changes

```bash
git add .
```

Or add a specific file:

```bash
git add filename
```

---

## Commit Changes

```bash
git commit -m "Describe your changes"
```

---

## Push Changes

First push:

```bash
git push -u origin feature/my-feature
```

Later pushes:

```bash
git push
```

---

## Switch Branches

```bash
git checkout main
```

or

```bash
git checkout feature/my-feature
```

---

# Updating Dependencies

```bash
npm install
```

If new packages were added:

```bash
npm update
```

---

# Reset Metro Cache

If Expo behaves unexpectedly:

```bash
npx expo start --clear
```

---

# Project Structure

```
app/
assets/
components/
constants/
hooks/
```

The app uses **Expo Router** with file-based routing.

---

# Useful Commands

Install dependencies:

```bash
npm install
```

Start Expo:

```bash
npx expo start --tunnel
```

Start with cleared cache:

```bash
npx expo start --clear
```

Run Android:

```bash
npx expo run:android
```

Run iOS (Mac only):

```bash
npx expo run:ios
```

Check Git status:

```bash
git status
```

Pull latest changes:

```bash
git pull origin main
```

Commit changes:

```bash
git add .
git commit -m "Your message"
git push
```

Build Android:

```bash
eas build -p android
```

---

# Troubleshooting

## Dependencies not installing

```bash
rm -rf node_modules
npm install
```

---

## Metro Bundler Issues

```bash
npx expo start --clear
```

---

## App won't connect on phone

Start Expo using tunnel mode:

```bash
npx expo start --tunnel
```

---

# Resources

- Expo Documentation: https://docs.expo.dev/
- Expo Router: https://docs.expo.dev/router/introduction/
- EAS Build: https://docs.expo.dev/build/introduction/
- Expo Go: https://expo.dev/go
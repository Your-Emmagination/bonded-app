const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Force Metro to use browser/RN builds instead of Node.js builds for Firebase
config.resolver.resolverMainFields = [
  "react-native",
  "browser",
  "main",
];

// Ensure Firebase packages resolve correctly
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
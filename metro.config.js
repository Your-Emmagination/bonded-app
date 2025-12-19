const { getDefaultConfig } = require('expo/metro-config');

const defaultConfig = getDefaultConfig(__dirname);

// Ensure proper resolution for Firebase on web
defaultConfig.resolver.sourceExts = [...defaultConfig.resolver.sourceExts, 'cjs'];
defaultConfig.resolver.assetExts = defaultConfig.resolver.assetExts.filter(ext => ext !== 'cjs');

module.exports = defaultConfig;
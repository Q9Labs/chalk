const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const appNodeModules = path.resolve(__dirname, "node_modules");

config.watchFolders = [path.resolve(__dirname, "../..")];
config.resolver.nodeModulesPaths = [
  appNodeModules,
  path.resolve(__dirname, "../../node_modules"),
];
config.resolver.extraNodeModules = {
  "@hugeicons/core-free-icons": path.resolve(appNodeModules, "@hugeicons/core-free-icons"),
  "@hugeicons/react-native": path.resolve(appNodeModules, "@hugeicons/react-native"),
  "react-native-svg": path.resolve(appNodeModules, "react-native-svg"),
};

module.exports = config;

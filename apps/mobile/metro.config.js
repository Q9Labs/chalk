const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const appNodeModules = path.resolve(__dirname, "node_modules");
const bunNodeModules = path.resolve(__dirname, "../../node_modules/.bun/node_modules");
const bunStoreNodeModules = path.resolve(__dirname, "../../node_modules/.bun");
const sdkNodeModules = path.resolve(__dirname, "../../packages/sdk-react-native/node_modules");
const escapePathForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

config.watchFolders = [path.resolve(__dirname, "../..")];
config.resolver.nodeModulesPaths = [
  appNodeModules,
  path.resolve(__dirname, "../../node_modules"),
  bunNodeModules,
];
config.resolver.extraNodeModules = {
  "@hugeicons/core-free-icons": path.resolve(appNodeModules, "@hugeicons/core-free-icons"),
  "@hugeicons/react-native": path.resolve(appNodeModules, "@hugeicons/react-native"),
  "react-native-svg": path.resolve(appNodeModules, "react-native-svg"),
};
config.resolver.blockList = [
  ...(config.resolver.blockList ?? []),
  new RegExp(`^${escapePathForRegex(path.join(sdkNodeModules, "react-native-svg"))}\\/.*$`),
  new RegExp(`^${escapePathForRegex(path.join(sdkNodeModules, "@hugeicons"))}\\/.*$`),
  new RegExp(`^${escapePathForRegex(bunStoreNodeModules)}\\/@hugeicons\\+react-native@[^/]+\\/node_modules\\/react-native-svg\\/.*$`),
];

module.exports = config;

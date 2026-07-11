const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const appNodeModules = path.resolve(__dirname, "node_modules");
const workspaceNodeModules = path.resolve(__dirname, "../../node_modules");
const sdkReactNativeRoot = path.resolve(__dirname, "../../sdks/typescript/react-native");
const facehashRoot = path.resolve(__dirname, "../../packages/facehash");
const sdkNodeModules = path.resolve(__dirname, "../../sdks/typescript/react-native/node_modules");
const escapePathForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Keep Metro focused on the app and the workspace packages it imports.
// Watching the entire monorepo makes cold iOS dev bundles slow enough to
// time out inside the Expo dev client splash screen.
config.watchFolders = [workspaceNodeModules, sdkReactNativeRoot, facehashRoot];
config.resolver.nodeModulesPaths = [appNodeModules, workspaceNodeModules];
config.resolver.extraNodeModules = {
  "@hugeicons/core-free-icons": path.resolve(appNodeModules, "@hugeicons/core-free-icons"),
  "@hugeicons/react-native": path.resolve(appNodeModules, "@hugeicons/react-native"),
  "react-native-svg": path.resolve(appNodeModules, "react-native-svg"),
};
config.resolver.blockList = [...(config.resolver.blockList ?? []), new RegExp(`^${escapePathForRegex(path.join(sdkNodeModules, "react-native-svg"))}\\/.*$`), new RegExp(`^${escapePathForRegex(path.join(sdkNodeModules, "@hugeicons"))}\\/.*$`)];
config.transformer = {
  ...config.transformer,
  getTransformOptions: async () => ({
    transform: {
      experimentalImportSupport: false,
      inlineRequires: true,
    },
  }),
};

module.exports = config;

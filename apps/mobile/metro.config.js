const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const appNodeModules = path.resolve(__dirname, "node_modules");
const workspaceNodeModules = path.resolve(__dirname, "../../node_modules");
const chalkClientRoot = path.resolve(__dirname, "../../sdks/typescript/client");
const sdkReactNativeRoot = path.resolve(__dirname, "../../sdks/typescript/react-native");
const facehashRoot = path.resolve(__dirname, "../../packages/facehash");
const whiteboardRoot = path.resolve(__dirname, "../../packages/whiteboard");
const sdkNodeModules = path.resolve(__dirname, "../../sdks/typescript/react-native/node_modules");
const escapePathForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Keep Metro focused on the app and the workspace packages it imports.
// Watching the entire monorepo makes cold iOS development bundles unnecessarily slow.
config.watchFolders = [workspaceNodeModules, chalkClientRoot, sdkReactNativeRoot, facehashRoot, whiteboardRoot];
config.resolver.nodeModulesPaths = [appNodeModules, workspaceNodeModules];
// Native modules must load once. pnpm links the SDK its own copies of its peers, so Metro skips
// those and resolves every one from the app.
const appOwnedPeers = ["expo-audio", "expo-haptics", "react-native-gesture-handler", "react-native-reanimated", "react-native-safe-area-context", "react-native-svg", "react-native-worklets"];
config.resolver.extraNodeModules = {
  "@q9labsai/chalk-whiteboard": whiteboardRoot,
  ...Object.fromEntries(appOwnedPeers.map((name) => [name, path.resolve(appNodeModules, name)])),
};
config.resolver.blockList = [...(config.resolver.blockList ?? []), ...appOwnedPeers.map((name) => new RegExp(`^${escapePathForRegex(path.join(sdkNodeModules, name))}\\/.*$`))];
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

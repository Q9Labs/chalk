const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const appNodeModules = path.resolve(__dirname, "node_modules");
const workspaceNodeModules = path.resolve(__dirname, "../../node_modules");
const chalkClientRoot = path.resolve(__dirname, "../../sdks/typescript/client");
const sdkReactNativeRoot = path.resolve(__dirname, "../../sdks/typescript/react-native");
const facehashRoot = path.resolve(__dirname, "../../packages/facehash");
const diagnosticsContractsRoot = path.resolve(__dirname, "../../packages/diagnostics-contracts");
const whiteboardRoot = path.resolve(__dirname, "../../packages/whiteboard");
const sdkNodeModules = path.resolve(__dirname, "../../sdks/typescript/react-native/node_modules");
const devPreviewEntry = path.resolve(__dirname, "src/dev-preview");
const devPreviewProductionStub = path.resolve(__dirname, "src/dev-preview/production-stub.tsx");
const escapePathForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function resolveMobileBuildProfile({ appVariant, easBuildProfile } = {}) {
  return easBuildProfile?.trim() || appVariant?.trim() || "development";
}

function isProductionMobileBuild({ appVariant, easBuildProfile, nodeEnv } = {}) {
  if (resolveMobileBuildProfile({ appVariant, easBuildProfile }) === "production") return true;
  return !appVariant?.trim() && !easBuildProfile?.trim() && nodeEnv?.trim() === "production";
}

function isDevPreviewEntry(originModulePath, moduleName) {
  if (!originModulePath || !moduleName) return false;
  const requestedPath = path.resolve(path.dirname(originModulePath), moduleName);
  return requestedPath === devPreviewEntry || requestedPath === path.join(devPreviewEntry, "index");
}

// Keep Metro focused on the app and the workspace packages it imports.
// Watching the entire monorepo makes cold iOS development bundles unnecessarily slow.
config.watchFolders = [workspaceNodeModules, chalkClientRoot, sdkReactNativeRoot, diagnosticsContractsRoot, facehashRoot, whiteboardRoot];
config.resolver.nodeModulesPaths = [appNodeModules, workspaceNodeModules];
config.resolver.extraNodeModules = {
  "@hugeicons/core-free-icons": path.resolve(appNodeModules, "@hugeicons/core-free-icons"),
  "@hugeicons/react-native": path.resolve(appNodeModules, "@hugeicons/react-native"),
  "@q9labsai/diagnostics-contracts": diagnosticsContractsRoot,
  "@q9labsai/chalk-whiteboard": whiteboardRoot,
  "react-native-svg": path.resolve(appNodeModules, "react-native-svg"),
};
if (isProductionMobileBuild({ appVariant: process.env.CHALK_APP_VARIANT, easBuildProfile: process.env.EAS_BUILD_PROFILE, nodeEnv: process.env.NODE_ENV })) {
  const defaultResolveRequest = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (isDevPreviewEntry(context.originModulePath, moduleName)) {
      return { type: "sourceFile", filePath: devPreviewProductionStub };
    }

    const resolveRequest = context.resolveRequest ?? defaultResolveRequest;
    if (!resolveRequest) throw new Error("Metro did not provide a default resolver for the production mobile bundle");
    return resolveRequest(context, moduleName, platform);
  };
}
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

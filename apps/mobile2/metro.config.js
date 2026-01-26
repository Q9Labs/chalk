const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch monorepo packages for development
config.watchFolders = [
	path.resolve(monorepoRoot, "packages"),
	path.resolve(monorepoRoot, "node_modules"),
];

// Resolve modules from both project and monorepo node_modules
config.resolver.nodeModulesPaths = [
	path.resolve(projectRoot, "node_modules"),
	path.resolve(monorepoRoot, "node_modules"),
];

// Enable symlink resolution (bun uses symlinks for hoisted packages)
config.resolver.unstable_enableSymlinks = true;

// Force single React instance from project's node_modules
config.resolver.extraNodeModules = {
	react: path.resolve(projectRoot, "node_modules/react"),
	"react-native": path.resolve(projectRoot, "node_modules/react-native"),
};

// Custom resolver for workspace packages and node: protocol blocking
config.resolver.resolveRequest = (context, moduleName, platform) => {
	// Block node: imports (not available in RN runtime)
	if (moduleName.startsWith("node:")) {
		return { type: "empty" };
	}

	// Force single React instance - return direct path to project's react
	if (moduleName === "react") {
		return {
			filePath: path.resolve(projectRoot, "node_modules/react/index.js"),
			type: "sourceFile",
		};
	}

	// Force single React Native instance
	if (moduleName === "react-native") {
		return {
			filePath: path.resolve(projectRoot, "node_modules/react-native/index.js"),
			type: "sourceFile",
		};
	}

	return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

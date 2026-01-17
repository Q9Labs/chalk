const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

// Source directories - use TypeScript source directly
const chalkReactNativeSrc = path.resolve(monorepoRoot, 'packages/sdk-react-native/src');
const chalkCoreSrc = path.resolve(monorepoRoot, 'packages/sdk-core/src');

// Force single copies of React packages from this project's node_modules
const reactPackages = ['react', 'react-native'];
const extraNodeModules = {};
for (const pkg of reactPackages) {
  extraNodeModules[pkg] = path.resolve(projectRoot, 'node_modules', pkg);
}

const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

config.resolver.extraNodeModules = extraNodeModules;

// Block node: protocol imports (Node.js only, not available in RN)
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('node:')) {
    return { type: 'empty' };
  }

  // Force single React instance - always resolve from project's node_modules
  if (moduleName === 'react' || moduleName.startsWith('react/')) {
    const newContext = { ...context, originModulePath: projectRoot + '/index.js' };
    return newContext.resolveRequest(newContext, moduleName, platform);
  }
  if (moduleName === 'react-native' || moduleName.startsWith('react-native/')) {
    const newContext = { ...context, originModulePath: projectRoot + '/index.js' };
    return newContext.resolveRequest(newContext, moduleName, platform);
  }

  // Redirect @q9labs/chalk-react-native to src/
  if (moduleName === '@q9labs/chalk-react-native') {
    return context.resolveRequest(context, chalkReactNativeSrc + '/index.ts', platform);
  }
  if (moduleName.startsWith('@q9labs/chalk-react-native/')) {
    const subpath = moduleName.replace('@q9labs/chalk-react-native/', '');
    return context.resolveRequest(context, chalkReactNativeSrc + '/' + subpath, platform);
  }

  // Redirect @q9labs/chalk-core to src/
  if (moduleName === '@q9labs/chalk-core') {
    return context.resolveRequest(context, chalkCoreSrc + '/index.ts', platform);
  }
  if (moduleName.startsWith('@q9labs/chalk-core/')) {
    const subpath = moduleName.replace('@q9labs/chalk-core/', '');
    return context.resolveRequest(context, chalkCoreSrc + '/' + subpath, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

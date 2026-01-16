const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../../..');

// Source directories - use TypeScript source directly, not built dist
const chalkReactNativeSrc = path.resolve(projectRoot, '../src');
const chalkCoreSrc = path.resolve(monorepoRoot, 'packages/sdk-core/src');

// Force single copies of React packages from example's node_modules
const reactPackages = ['react', 'react-native', 'react-native-webrtc'];
const extraNodeModules = {};
for (const pkg of reactPackages) {
  extraNodeModules[pkg] = path.resolve(projectRoot, 'node_modules', pkg);
}

const config = {
  watchFolders: [monorepoRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],
    // Force single React instance across all packages
    extraNodeModules,
    // Block react-native 0.83 from .bun cache (we use 0.76)
    blockList: [
      /node_modules\/\.bun\/react-native@0\.83/,
      /node_modules\/\.bun\/@react-native.*@0\.83/,
    ],
    // Custom resolver to intercept workspace packages and node: imports
    resolveRequest: (context, moduleName, platform) => {
      // Block node: protocol imports (Node.js only, not available in RN)
      if (moduleName.startsWith('node:')) {
        return {type: 'empty'};
      }

      // Force single React instance - always resolve from example's node_modules
      if (moduleName === 'react' || moduleName.startsWith('react/')) {
        const newContext = {...context, originModulePath: projectRoot + '/index.js'};
        return newContext.resolveRequest(newContext, moduleName, platform);
      }
      if (moduleName === 'react-native' || moduleName.startsWith('react-native/')) {
        const newContext = {...context, originModulePath: projectRoot + '/index.js'};
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
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);

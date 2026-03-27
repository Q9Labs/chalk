import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const mobileAppRoot = join(process.cwd(), "apps", "mobile");

if (!existsSync(join(mobileAppRoot, "package.json"))) {
  console.log("[patch-realtimekit-react-native] skipped: apps/mobile not present");
  process.exit(0);
}

const packageJsonPath = [
  join(mobileAppRoot, "node_modules", "@cloudflare", "realtimekit-react-native", "package.json"),
  join(process.cwd(), "node_modules", "@cloudflare", "realtimekit-react-native", "package.json"),
].find((candidate) => existsSync(candidate));

if (!packageJsonPath) {
  console.log("[patch-realtimekit-react-native] skipped: @cloudflare/realtimekit-react-native not installed");
  process.exit(0);
}
const packageRoot = dirname(packageJsonPath);
const stringsXmlPath = join(packageRoot, "android", "src", "main", "res", "values", "strings.xml");
const blobAuthorityName = "blob_provider_authority";
const blobAuthorityValue = "com.cloudflare.realtimekit.expo.blobs";
const nativeEventEmitterTargets = [
  join(packageRoot, "lib", "commonjs", "BackgroundHandler.js"),
  join(packageRoot, "lib", "module", "BackgroundHandler.js"),
  join(packageRoot, "lib", "commonjs", "LocalMediaHandler.js"),
  join(packageRoot, "lib", "module", "LocalMediaHandler.js"),
  join(packageRoot, "lib", "commonjs", "AudioSampleHandler.js"),
  join(packageRoot, "lib", "module", "AudioSampleHandler.js"),
  join(packageRoot, "lib", "commonjs", "LocalMediaUtils.js"),
  join(packageRoot, "lib", "module", "LocalMediaUtils.js"),
];

const nativeEventEmitterHelperDeclaration =
  `const ensureNativeEventEmitterContract = module => module && typeof module.addListener === "function" && typeof module.removeListeners === "function" ? module : module ? {\n  ...module,\n  addListener() {},\n  removeListeners() {},\n} : null;\n`;

const nativeEventEmitterReplacements: Array<[string, string]> = [
  [
    "const Emitter = new NativeEventEmitter(RTKRNBackgroundTimer);",
    `${nativeEventEmitterHelperDeclaration}const Emitter = new NativeEventEmitter(ensureNativeEventEmitterContract(RTKRNBackgroundTimer));`,
  ],
  [
    "const Emitter = new _reactNative.NativeEventEmitter(RTKRNBackgroundTimer);",
    `${nativeEventEmitterHelperDeclaration}const Emitter = new _reactNative.NativeEventEmitter(ensureNativeEventEmitterContract(RTKRNBackgroundTimer));`,
  ],
  [
    "const broadcastEmitter = new NativeEventEmitter(BroadcastEventEmitter);",
    `${nativeEventEmitterHelperDeclaration}const broadcastEmitter = new NativeEventEmitter(ensureNativeEventEmitterContract(BroadcastEventEmitter));`,
  ],
  [
    "const broadcastEmitter = new _reactNative.NativeEventEmitter(BroadcastEventEmitter);",
    `${nativeEventEmitterHelperDeclaration}const broadcastEmitter = new _reactNative.NativeEventEmitter(ensureNativeEventEmitterContract(BroadcastEventEmitter));`,
  ],
  [
    "this.webRTCModuleEmitter = new NativeEventEmitter(WebRTCModule);",
    `${nativeEventEmitterHelperDeclaration}    this.webRTCModuleEmitter = new NativeEventEmitter(ensureNativeEventEmitterContract(WebRTCModule));`,
  ],
  [
    "this.webRTCModuleEmitter = new _reactNative.NativeEventEmitter(WebRTCModule);",
    `${nativeEventEmitterHelperDeclaration}    this.webRTCModuleEmitter = new _reactNative.NativeEventEmitter(ensureNativeEventEmitterContract(WebRTCModule));`,
  ],
  [
    "_classPrivateFieldSet(_nativeEventEmitter, this, new NativeEventEmitter(NativeModules.InCallManager));",
    `${nativeEventEmitterHelperDeclaration}    _classPrivateFieldSet(_nativeEventEmitter, this, new NativeEventEmitter(ensureNativeEventEmitterContract(NativeModules.InCallManager)));`,
  ],
  [
    "_classPrivateFieldSet(_nativeEventEmitter, this, new _reactNative.NativeEventEmitter(_reactNative.NativeModules.InCallManager));",
    `${nativeEventEmitterHelperDeclaration}    _classPrivateFieldSet(_nativeEventEmitter, this, new _reactNative.NativeEventEmitter(ensureNativeEventEmitterContract(_reactNative.NativeModules.InCallManager)));`,
  ],
];

const nextContents = `<resources>
  <string name="${blobAuthorityName}">${blobAuthorityValue}</string>
</resources>
`;

mkdirSync(dirname(stringsXmlPath), { recursive: true });

let currentContents = "";

try {
  currentContents = readFileSync(stringsXmlPath, "utf8");
} catch {
  currentContents = "";
}

if (currentContents.includes(`name="${blobAuthorityName}"`)) {
} else {
  writeFileSync(stringsXmlPath, nextContents, "utf8");
  console.log(`[patch-realtimekit-react-native] wrote ${stringsXmlPath}`);
}

for (const targetPath of nativeEventEmitterTargets) {
  if (!existsSync(targetPath)) {
    continue;
  }

  let targetContents = readFileSync(targetPath, "utf8");
  let didPatch = false;

  for (const [searchValue, replaceValue] of nativeEventEmitterReplacements) {
    if (!targetContents.includes(searchValue)) {
      continue;
    }

    targetContents = targetContents.replace(searchValue, replaceValue);
    didPatch = true;
  }

  if (!didPatch) {
    continue;
  }

  writeFileSync(targetPath, targetContents, "utf8");
  console.log(`[patch-realtimekit-react-native] patched ${targetPath}`);
}

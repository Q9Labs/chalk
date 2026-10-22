const fs = require("node:fs");
const path = require("node:path");
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const BEGIN = "// @generated begin chalk-scene-lifecycle";
const END = "// @generated end chalk-scene-lifecycle";
const LAUNCH_OPTIONS = "  var reactNativeLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?";
const CAPTURE_LAUNCH_OPTIONS = "    reactNativeLaunchOptions = launchOptions";
const APP_START = `    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)`;

// SDK 55 has no ExpoAppSceneDelegate. Remove this adapter when upgrading to an SDK that does.
module.exports = (config) => {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneClassName: "UIWindowScene",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return mod;
  });

  return withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== "swift") throw new Error("Chalk's scene lifecycle requires a Swift AppDelegate");
    let contents = mod.modResults.contents;
    if (contents.includes(APP_START)) {
      contents = contents.replace(APP_START, CAPTURE_LAUNCH_OPTIONS);
    } else if (!contents.includes(CAPTURE_LAUNCH_OPTIONS)) {
      throw new Error("Chalk's SDK 55 AppDelegate startup changed; update the scene lifecycle plugin before prebuilding");
    }
    if (!contents.includes(LAUNCH_OPTIONS)) {
      const factory = "  var reactNativeFactory: RCTReactNativeFactory?";
      if (!contents.includes(factory)) throw new Error("Chalk's AppDelegate no longer exposes its React Native factory");
      contents = contents.replace(factory, `${factory}\n${LAUNCH_OPTIONS}`);
    }

    const begin = contents.indexOf(BEGIN);
    if (begin !== -1) {
      const end = contents.indexOf(END, begin);
      if (end === -1) throw new Error("Chalk's generated scene lifecycle block has no end marker");
      contents = contents.slice(0, begin) + contents.slice(end + END.length);
    }
    const scene = fs.readFileSync(path.join(__dirname, "SceneDelegate.swift"), "utf8").trim();
    // The same compilation unit needs no Xcode file references, including after prebuild.
    mod.modResults.contents = `${contents.trimEnd()}\n\n${BEGIN}\n${scene}\n${END}\n`;
    return mod;
  });
};

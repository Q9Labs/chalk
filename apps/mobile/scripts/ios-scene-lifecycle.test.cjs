const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { createRequire } = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const expoRequire = createRequire(require.resolve("expo/config-plugins"));
const plist = expoRequire("@expo/plist").default;

test("prebuild adopts the scene lifecycle required to launch on iOS 27", { timeout: 180_000 }, () => {
  const mobile = path.resolve(__dirname, "..");
  const fixture = mkdtempSync(path.join(tmpdir(), "chalk-ios-scene-"));
  try {
    for (const file of ["app.config.ts", "package.json", "assets", "plugins"]) {
      cpSync(path.join(mobile, file), path.join(fixture, file), { recursive: true });
    }
    symlinkSync(path.join(mobile, "node_modules"), path.join(fixture, "node_modules"), "dir");
    // Start from Expo's installed template, not committed ios/, which already contains the fix.
    execFileSync(process.execPath, [require.resolve("expo/bin/cli"), "prebuild", "--platform", "ios", "--no-install", "--template", require.resolve("expo/template.tgz")], {
      cwd: fixture,
      env: { ...process.env, CI: "1", CHALK_APP_VARIANT: "production", EXPO_NO_TELEMETRY: "1" },
      timeout: 150_000,
      stdio: "pipe",
    });

    const info = plist.parse(readFileSync(path.join(fixture, "ios/Chalk/Info.plist"), "utf8"));
    // Missing this manifest produced SIGTRAP in UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption.
    assert.ok(info.UIApplicationSceneManifest, "Generated Info.plist must adopt the scene lifecycle or iOS 27 aborts before JS");
    const manifest = info.UIApplicationSceneManifest;
    assert.equal(manifest.UIApplicationSupportsMultipleScenes, false);
    assert.equal(manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName, "$(PRODUCT_MODULE_NAME).SceneDelegate");

    const swift = readFileSync(path.join(fixture, "ios/Chalk/AppDelegate.swift"), "utf8");
    const appDelegate = swift.split("class ReactNativeDelegate")[0];
    assert.doesNotMatch(appDelegate, /UIWindow\(frame:|startReactNative\(/, "AppDelegate must leave window creation and React Native startup to its scene");
    assert.match(swift, /class SceneDelegate\s*:\s*UIResponder,\s*UIWindowSceneDelegate/);
    assert.match(swift, /willConnectTo session: UISceneSession/);
    assert.match(swift, /UIWindow\(windowScene: windowScene\)/);
    assert.match(swift, /factory\.startReactNative\(withModuleName: "main", in: window,/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

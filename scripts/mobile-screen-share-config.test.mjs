import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.CHALK_MOBILE_CONFIG_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
const sdkRequire = createRequire(new URL("../sdks/typescript/react-native/package.json", import.meta.url));
const vendor = path.dirname(sdkRequire.resolve("@cloudflare/react-native-webrtc/package.json"));
const { createExpoConfig } = await import(pathToFileURL(path.join(root, "apps/mobile/app.config.ts")));
const config = createExpoConfig("production").expo.ios;
const plist = (file) => JSON.parse(execFileSync("python3", ["-c", "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", path.join(root, file)], { encoding: "utf8" }));
const app = plist("apps/mobile/ios/Chalk/Info.plist");
const hostGroups = plist("apps/mobile/ios/Chalk/Chalk.entitlements")["com.apple.security.application-groups"];
const extensionGroups = plist("apps/mobile/ios/ChalkScreenShare/ChalkScreenShare.entitlements")["com.apple.security.application-groups"];

function vendorKey(file, constant) {
  const source = readFileSync(path.join(vendor, "ios/RCTWebRTC", file), "utf8");
  const match = source.match(new RegExp(`${constant} = @"([^"]+)"`));
  assert.ok(match, `${file} must declare ${constant}`);
  return match[1];
}

test("the shipped app and Expo prebuild select the installed native broadcast extension", () => {
  const key = vendorKey("ScreenCapturePickerViewManager.m", "kRTCScreenSharingExtension");
  const expected = `${config.bundleIdentifier}.screenshare`;
  assert.equal(app[key], expected, "the native picker must select Chalk, not an unrelated broadcast extension");
  assert.equal(config.infoPlist[key], expected, "Expo prebuild must preserve the picker configuration");
});

test("the installed capturer opens the app group's extension socket", () => {
  const key = vendorKey("ScreenCaptureController.m", "kRTCAppGroupIdentifier");
  assert.equal(hostGroups.length, 1);
  assert.deepEqual(hostGroups, extensionGroups);
  assert.equal(app[key], hostGroups[0], "without this key the native capturer returns before opening its socket");
  assert.equal(config.infoPlist[key], hostGroups[0], "Expo prebuild must preserve the capture app group");
});

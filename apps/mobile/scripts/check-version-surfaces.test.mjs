import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findMismatches, readSurfaces } from "./check-version-surfaces.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const files = ["apps/mobile/app.config.ts", "apps/mobile/android/gradle.properties", "apps/mobile/android/app/build.gradle", "apps/mobile/ios/Chalk.xcodeproj/project.pbxproj", "apps/mobile/ios/Chalk/Info.plist", "release/manifest.json"];

// Copies the six version files into a temporary repo, then edits one of them.
function withEdit(file, change) {
  const root = mkdtempSync(path.join(tmpdir(), "chalk-version-surfaces-"));
  try {
    for (const name of files) cpSync(path.join(repo, name), path.join(root, name), { recursive: true });
    const target = path.join(root, file);
    writeFileSync(target, change(readFileSync(target, "utf8")));
    return findMismatches(readSurfaces(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the committed surfaces agree", () => {
  assert.deepEqual(findMismatches(readSurfaces(repo)), []);
});

test("a one-surface mismatch fails and names the field", () => {
  const cases = [
    ["Android code in release/manifest.json", "release/manifest.json", (text) => text.replace(/"version_code": \d+/, '"version_code": 1'), "androidVersionCode"],
    ["Android code in gradle.properties", "apps/mobile/android/gradle.properties", (text) => text.replace(/chalk\.versionCode=\d+/, "chalk.versionCode=1"), "androidVersionCode"],
    ["Android code fallback in build.gradle", "apps/mobile/android/app/build.gradle", (text) => text.replace(/(chalk\.versionCode'\) \?: ')\d+/, "$11"), "androidVersionCode"],
    ["version name in app.config.ts", "apps/mobile/app.config.ts", (text) => text.replace(/^(\s+version: ")[^"]+/m, "$10.0.1"), "versionName"],
    ["one MARKETING_VERSION in the project", "apps/mobile/ios/Chalk.xcodeproj/project.pbxproj", (text) => text.replace(/MARKETING_VERSION = [^;]+;/, "MARKETING_VERSION = 0.0.1;"), "versionName"],
    ["iOS build in Info.plist", "apps/mobile/ios/Chalk/Info.plist", (text) => text.replace(/(CFBundleVersion<\/key>\s*<string>)\d+/, "$11"), "iosBuildNumber"],
    ["one CURRENT_PROJECT_VERSION in the project", "apps/mobile/ios/Chalk.xcodeproj/project.pbxproj", (text) => text.replace(/CURRENT_PROJECT_VERSION = \d+;/, "CURRENT_PROJECT_VERSION = 1;"), "iosBuildNumber"],
  ];
  for (const [label, file, change, field] of cases) {
    const mismatches = withEdit(file, change);
    assert.equal(mismatches.length, 1, `${label} should fail exactly one field`);
    assert.match(mismatches[0], new RegExp(`^${field} disagrees`), label);
  }
});

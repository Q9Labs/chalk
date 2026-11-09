import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The app version lives in several files that no tool keeps in sync. One disagreement burned
// Play version codes, so this check fails when any of them differ.

const pattern = (text, regex, file) => {
  const matches = [...text.matchAll(regex)].map((match) => match[1]);
  if (matches.length === 0) throw new Error(`No version found in ${file} for ${regex}`);
  return matches;
};

export function readSurfaces(root) {
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  const appConfig = read("apps/mobile/app.config.ts");
  const gradleProperties = read("apps/mobile/android/gradle.properties");
  const buildGradle = read("apps/mobile/android/app/build.gradle");
  const manifest = JSON.parse(read("release/manifest.json"));
  const pbxproj = read("apps/mobile/ios/Chalk.xcodeproj/project.pbxproj");
  const plist = read("apps/mobile/ios/Chalk/Info.plist");
  const plistValue = (key) => pattern(plist, new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, "g"), "Info.plist");

  return {
    versionName: {
      "app.config.ts": pattern(appConfig, /^\s+version: "([^"]+)"/gm, "app.config.ts"),
      "gradle.properties": pattern(gradleProperties, /^chalk\.versionName=(.+)$/gm, "gradle.properties"),
      "build.gradle fallback": pattern(buildGradle, /findProperty\('chalk\.versionName'\) \?: '([^']+)'/g, "build.gradle"),
      "release/manifest.json": [manifest.android.version_name],
      "project.pbxproj MARKETING_VERSION": pattern(pbxproj, /MARKETING_VERSION = ([^;]+);/g, "project.pbxproj"),
      "Info.plist": plistValue("CFBundleShortVersionString"),
    },
    androidVersionCode: {
      "app.config.ts": pattern(appConfig, /versionCode: (\d+)/g, "app.config.ts"),
      "gradle.properties": pattern(gradleProperties, /^chalk\.versionCode=(\d+)$/gm, "gradle.properties"),
      "build.gradle fallback": pattern(buildGradle, /findProperty\('chalk\.versionCode'\) \?: '(\d+)'/g, "build.gradle"),
      "release/manifest.json": [String(manifest.android.version_code)],
    },
    iosBuildNumber: {
      "app.config.ts": pattern(appConfig, /buildNumber: "(\d+)"/g, "app.config.ts"),
      "project.pbxproj CURRENT_PROJECT_VERSION": pattern(pbxproj, /CURRENT_PROJECT_VERSION = (\d+);/g, "project.pbxproj"),
      "Info.plist": plistValue("CFBundleVersion"),
    },
  };
}

export function findMismatches(surfaces) {
  return Object.entries(surfaces).flatMap(([field, files]) => {
    const values = new Set(Object.values(files).flat());
    if (values.size <= 1) return [];
    const detail = Object.entries(files).map(([file, found]) => `  ${file}: ${[...new Set(found)].join(", ")}`);
    return [`${field} disagrees:\n${detail.join("\n")}`];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const mismatches = findMismatches(readSurfaces(root));
  if (mismatches.length > 0) {
    console.error(mismatches.join("\n"));
    process.exit(1);
  }
  console.log("Mobile version surfaces agree.");
}

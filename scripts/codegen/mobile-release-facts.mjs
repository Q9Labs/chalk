import { readFile, writeFile } from "node:fs/promises";

// release/manifest.json holds the mobile version name and iOS build number. app.config.ts and the
// Android build read it directly; Xcode reads these committed files, so this writes them from it.
const { version_name: versionName, apple } = JSON.parse(await readFile("release/manifest.json", "utf8"));
const buildNumber = apple.build_number;

const targets = [
  [
    "apps/mobile/ios/Chalk.xcodeproj/project.pbxproj",
    [
      [/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${versionName};`],
      [/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`],
    ],
  ],
  [
    "apps/mobile/ios/Chalk/Info.plist",
    [
      [/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+/, `$1${versionName}`],
      [/(<key>CFBundleVersion<\/key>\s*<string>)[^<]+/, `$1${buildNumber}`],
    ],
  ],
  ["apps/mobile/package.json", [[/("version": ")[^"]+/, `$1${versionName}`]]],
];

const write = process.argv.includes("--write");
for (const [file, replacements] of targets) {
  const current = await readFile(file, "utf8");
  const next = replacements.reduce((text, [pattern, replacement]) => {
    if (!pattern.test(text)) throw new Error(`${file} has no ${pattern}`);
    return text.replace(pattern, replacement);
  }, current);
  if (next === current) continue;
  if (write) await writeFile(file, next);
  else throw new Error(`Stale mobile release facts: ${file}`);
}

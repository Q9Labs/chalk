import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// tsup renames imports when it bundles (useAnimatedStyle3), so the worklets Babel plugin in the
// app can't recognise these callbacks by name. Each one must declare "worklet" itself, or it runs
// as plain JavaScript on the UI thread and throws.
const sourceRoot = join(process.cwd(), "src");
const callbackPattern = /\b(useAnimatedStyle|useDerivedValue|useAnimatedReaction|useAnimatedProps|onBegin|onStart|onUpdate|onChange|onEnd|onFinalize)\(\s*\([^()]*\)\s*=>\s*(\{\s*"worklet"|.)/gu;

const violations = [];
for (const filePath of await sourceFiles(sourceRoot)) {
  const source = await readFile(filePath, "utf8");
  if (!source.includes("react-native-reanimated") && !source.includes("react-native-gesture-handler")) continue;
  for (const match of source.matchAll(callbackPattern)) {
    if (match[2].startsWith("{") && match[2].includes('"worklet"')) continue;
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${relative(sourceRoot, filePath)}:${line}: ${match[1]} callback without "worklet"`);
  }
}

if (violations.length > 0) {
  console.error('UI-thread callbacks must start with a "worklet" directive:\n');
  console.error(violations.join("\n"));
  process.exitCode = 1;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(filePath)));
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(filePath);
  }
  return files;
}

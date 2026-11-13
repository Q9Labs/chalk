import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// tsup renames imports when it bundles (useAnimatedStyle3), so the worklets Babel plugin in the
// app can't recognise these callbacks by name. Each one must declare "worklet" itself, or it runs
// as plain JavaScript on the UI thread and throws.
const sourceRoot = join(process.cwd(), "src");
const callbackPattern = /\b(useAnimatedStyle|useDerivedValue|useAnimatedReaction|useAnimatedProps|onBegin|onStart|onUpdate|onChange|onEnd|onFinalize)\(\s*\([^()]*\)\s*=>\s*(\{\s*"worklet"|.)/gu;

const violations = [];
for (const relativePath of await readdir(sourceRoot, { recursive: true })) {
  if (!/\.tsx?$/u.test(relativePath) || relativePath.endsWith(".test.ts")) continue;
  const source = await readFile(join(sourceRoot, relativePath), "utf8");
  if (!source.includes("react-native-reanimated") && !source.includes("react-native-gesture-handler")) continue;
  for (const match of source.matchAll(callbackPattern)) {
    if (match[2].startsWith("{") && match[2].includes('"worklet"')) continue;
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${relativePath}:${line}: ${match[1]} callback without "worklet"`);
  }
}

if (violations.length > 0) {
  console.error('UI-thread callbacks must start with a "worklet" directive:\n');
  console.error(violations.join("\n"));
  process.exitCode = 1;
}

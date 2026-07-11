import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const errors = [];

const sourceRoots = ["apps/web/src", "apps/mobile/src", "infrastructure/uptime-worker/src", "packages/assets/src", "packages/facehash/src", "packages/ui/src", "packages/whiteboard/src", "sdks/typescript/client/src", "sdks/typescript/react-native/src", "sdks/typescript/react/src"];

const ignoredPathParts = new Set(["__tests__", "__mocks__", "generated", "assets"]);
const ignoredBasenames = new Set(["index.ts", "index.tsx", "routeTree.gen.ts", "vite-env.d.ts", "setup.ts"]);
const ignoredExtensions = new Set([".d.ts", ".css"]);
const ignoredPathMatchers = [
  (relativePath) => relativePath.includes(".test."),
  (relativePath) => relativePath.includes(".spec."),
  (relativePath) => relativePath.includes("/styles/"),
  (relativePath) => relativePath.endsWith("/styles.ts"),
  (relativePath) => relativePath.includes("/types/"),
  (relativePath) => relativePath.endsWith("/types.ts"),
  (relativePath) => relativePath.includes("/routes/"),
  (relativePath) => relativePath.includes("/scripts/"),
];

function walk(relativeDir) {
  const absoluteDir = path.join(repoRoot, relativeDir);
  if (!existsSync(absoluteDir)) return [];
  const result = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredPathParts.has(entry.name)) result.push(...walk(relativePath));
      continue;
    }
    result.push(relativePath);
  }
  return result;
}

function isMeaningfulSourceFile(relativePath) {
  const parsed = path.parse(relativePath);
  const hasSourceExtension = [".ts", ".tsx"].includes(parsed.ext);
  const hasIgnoredPathPart = parsed.dir.split(path.sep).some((part) => ignoredPathParts.has(part));
  const isIgnoredFile = ignoredBasenames.has(path.basename(relativePath)) || ignoredExtensions.has(parsed.ext) || relativePath.endsWith(".d.ts");

  return hasSourceExtension && !hasIgnoredPathPart && !isIgnoredFile && !ignoredPathMatchers.some((matches) => matches(relativePath));
}

function gitLines(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getExplicitFiles() {
  const raw = process.env.TEST_PRESENCE_FILES;
  if (!raw) return [];
  return raw
    .split(/[\r\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getAddedFiles() {
  const explicitFiles = getExplicitFiles();
  if (explicitFiles.length > 0) return explicitFiles;

  const addedFiles = new Set([...gitLines(["diff", "--cached", "--name-only", "--diff-filter=A"]), ...gitLines(["diff", "--name-only", "--diff-filter=A"]), ...gitLines(["ls-files", "--others", "--exclude-standard"])]);

  const baseRef = process.env.TEST_PRESENCE_BASE_REF ?? "origin/master";
  const mergeBase = gitLines(["merge-base", baseRef, "HEAD"])[0];
  if (mergeBase) {
    for (const relativePath of gitLines(["diff", "--name-only", "--diff-filter=A", `${mergeBase}..HEAD`])) {
      addedFiles.add(relativePath);
    }
    return [...addedFiles];
  }

  return sourceRoots.flatMap(walk);
}

function isInSourceRoot(relativePath) {
  return sourceRoots.some((sourceRoot) => relativePath.startsWith(`${sourceRoot}/`));
}

function candidateTestsFor(relativePath) {
  const parsed = path.parse(relativePath);
  const dir = parsed.dir;
  const base = parsed.name;
  const root = sourceRoots.find((sourceRoot) => relativePath.startsWith(`${sourceRoot}/`));
  return [
    path.join(dir, `${base}.test${parsed.ext}`),
    path.join(dir, `${base}.spec${parsed.ext}`),
    path.join(dir, "__tests__", `${base}.test${parsed.ext}`),
    path.join(dir, "__tests__", `${base}.spec${parsed.ext}`),
    root ? path.join(root, "__tests__", `${base}.test${parsed.ext}`) : null,
    root ? path.join(root, "__tests__", `${base}.spec${parsed.ext}`) : null,
    root ? path.join(root, "__tests__", `${base}.test.ts`) : null,
    root ? path.join(root, "__tests__", `${base}.test.tsx`) : null,
  ].filter(Boolean);
}

const meaningfulSourceFiles = getAddedFiles().filter(isInSourceRoot).filter(isMeaningfulSourceFile);

for (const relativePath of meaningfulSourceFiles) {
  if (!candidateTestsFor(relativePath).some((candidate) => existsSync(path.join(repoRoot, candidate)))) {
    errors.push(relativePath);
  }
}

if (errors.length > 0) {
  console.error("Source files without nearby tests:");
  for (const relativePath of errors) console.error(`- ${relativePath}`);
  process.exit(1);
}

console.log(`Test presence passed for ${meaningfulSourceFiles.length} newly added meaningful source files.`);

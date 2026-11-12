import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const errors = [];

const packageJsonPaths = execFileSync("git", ["ls-files", "*package.json"], { cwd: repoRoot, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);

const weakScriptPattern = /^(echo\b.*|true|exit\s+0)$/;
const placeholderPattern = /No (?:linter|tests?) configured yet|TODO: document/i;

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

for (const relativePath of packageJsonPaths) {
  const pkg = readJson(relativePath);
  if (pkg.private !== true && pkg.license !== "MIT") {
    errors.push(`${relativePath}: public package must declare an MIT license`);
  }
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    const trimmed = String(command).trim();
    if (weakScriptPattern.test(trimmed)) {
      errors.push(`${relativePath}: script "${name}" is a no-op placeholder: ${trimmed}`);
    }
    if (placeholderPattern.test(trimmed)) {
      errors.push(`${relativePath}: script "${name}" contains placeholder text: ${trimmed}`);
    }
    if (trimmed.includes("--passWithNoTests")) {
      errors.push(`${relativePath}: script "${name}" uses --passWithNoTests`);
    }
  }
}

// Each SDK package lists its entrypoints in the tsup build, in `exports` and in `typesVersions`; the three must agree.
for (const sdk of ["client", "react", "react-native"]) {
  const relativePath = `sdks/typescript/${sdk}/package.json`;
  const pkg = readJson(relativePath);
  const built = new Set([...String(pkg.scripts?.build).matchAll(/\.\/src\/([\w./-]+)\.tsx?/g)].map((match) => `./dist/${match[1]}.js`));
  const exported = new Set([...JSON.stringify(pkg.exports).matchAll(/"(\.\/dist\/[^"]+\.js)"/g)].map((match) => match[1]));
  for (const target of built) if (!exported.has(target)) errors.push(`${relativePath}: the build makes ${target} but \`exports\` does not list it`);
  for (const target of exported) if (!built.has(target)) errors.push(`${relativePath}: \`exports\` lists ${target} but the build does not make it`);
  const typed = pkg.typesVersions?.["*"] ?? {};
  for (const subpath of Object.keys(pkg.exports)) {
    if (subpath !== "." && !(subpath.slice(2) in typed)) errors.push(`${relativePath}: \`typesVersions\` has no entry for ${subpath}`);
  }
}

const rootPackage = readJson("package.json");
const commitScript = readFileSync(path.join(repoRoot, "scripts/gates/commit.sh"), "utf8");
const referencedScripts = [...commitScript.matchAll(/pnpm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]);
for (const scriptName of referencedScripts) {
  if (!rootPackage.scripts?.[scriptName]) {
    errors.push(`scripts/gates/commit.sh references missing root package script "${scriptName}"`);
  }
}

const turboConfig = readJson("turbo.json");
for (const [taskName, task] of Object.entries(turboConfig.tasks ?? {})) {
  const serialized = JSON.stringify(task);
  if (serialized.includes("<NONEXISTENT>")) {
    errors.push(`turbo.json task "${taskName}" resolves to <NONEXISTENT>`);
  }
}

if (errors.length > 0) {
  console.error("Gate hygiene failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Gate hygiene passed.");

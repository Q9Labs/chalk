import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const errors = [];

const packageJsonPaths = [
  "package.json",
  "apps/mobile/package.json",
  "apps/web/package.json",
  "infrastructure/cloudflare-ops-monitor/package.json",
  "packages/chalk-whiteboard/package.json",
  "packages/facehash/package.json",
  "packages/sdk-core/package.json",
  "packages/sdk-react-native/package.json",
  "packages/sdk-react/package.json",
  "packages/ui/package.json",
];

const weakScriptPattern = /^(echo\b.*|true|exit\s+0)$/;
const placeholderPattern = /No (?:linter|tests?) configured yet|TODO: document/i;

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

for (const relativePath of packageJsonPaths) {
  const pkg = readJson(relativePath);
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
